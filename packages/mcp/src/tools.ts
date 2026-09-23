import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  generateProof,
  requestChallenge,
  walletFor,
  walletFromEnv,
  prepareInputs,
  prepareOidcPayload,
  submitProof,
  verifyProof,
  computeSignalHash,
  hashTypedAction,
  CIRCUIT_IDS,
  CIRCUITS,
  AUTHORIZED_SIGNERS,
  CIRCUIT_NAME_MAP,
  ensureGatewayBalance,
  gatewayBalance,
  ActionApprovalRequiredError,
  getActionApprovalStatus,
  resolveActionApproval,
  type CircuitName,
  type ProofportSigner,
  type ClientConfig,
} from '@zkproofport-ai/sdk';
import { ApprovalStore } from './approvalStore.js';

/**
 * The circuit names every tool accepts, read from the map the SDK owns.
 *
 * Typed out four times until 2026-09-12, and two of the four had fallen behind:
 * `generate_proof`, `request_challenge` and `submit_proof` did not list
 * `arc_eligibility`, so the circuit could be prepared and then not proved. A
 * new circuit now reaches every tool by being added to `CIRCUIT_NAME_MAP`.
 */
const CIRCUIT_NAMES = Object.keys(CIRCUIT_NAME_MAP) as [CircuitName, ...CircuitName[]];
const circuitParam = () => z.enum(CIRCUIT_NAMES).describe('Which circuit to use');

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
    isError: true as const,
  };
}

function jsonResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

// Provider diagnostics and arbitrary extension fields are never model-facing
// when a response was produced with a privately stored human signature.
const publicProofSchema = z.object({
  circuit: z.string().optional(), proofType: z.string().optional(),
  proof: z.string(), publicInputs: z.string().optional(), proofWithInputs: z.string().optional(),
  attestation: z.object({
    document: z.string(), proof_hash: z.string(),
    verification: z.object({
      rootCaValid: z.boolean(), chainValid: z.boolean(), signatureValid: z.boolean(),
      pcrs: z.record(z.string().regex(/^\d+$/), z.string()),
    }),
  }).nullable().optional(),
  timing: z.object({ totalMs: z.number(), inputBuildMs: z.number().optional(),
    paymentVerifyMs: z.number().optional(), proveMs: z.number().optional() }).optional(),
  verification: z.object({ chainId: z.number(), verifierAddress: z.string(), rpcUrl: z.string() }).nullable().optional(),
});

export function registerTools(
  server: McpServer,
  config: ClientConfig,
  signer: ProofportSigner,
): void {
  const approvals = new ApprovalStore();
  const approvalIdParam = () => z.string().optional().describe('Resume the SAME original action request using the approval_id returned with awaiting_approval. Keep all original parameters unchanged.');
  function originalRequest(params: Record<string, unknown>): Record<string, unknown> {
    const { approval_id: _approvalId, ...request } = params;
    return request;
  }
  async function operationError(error: unknown, operation: string, params: Record<string, unknown>) {
    if (error instanceof ActionApprovalRequiredError) {
      const id = await approvals.save(config, error.approval, operation, originalRequest(params));
      return jsonResult({
        status: 'awaiting_approval', approval_id: id,
        approval_url: error.approval.approvalUrl, expires_at: error.approval.expiresAt,
        next_step: 'Give this approval URL to the human. Query get_action_approval; once approved, repeat this tool with the SAME parameters plus approval_id. Do not sign or submit the approval on the human\'s behalf.',
      });
    }
    if (params.action) {
      const safeErrors: Record<string, string> = {
        ACTION_APPROVAL_REJECTED: 'The person rejected this action request.',
        ACTION_APPROVAL_EXPIRED: 'This action approval expired. A new human approval is required.',
        ACTION_APPROVAL_CONSUMED: 'This approval was already used. Check the existing proof request before retrying.',
        ACTION_APPROVAL_INVALID: 'This approval does not match the original action request.',
        ACTION_APPROVAL_UNAVAILABLE: 'Approval status is unavailable. Check its status before retrying.',
      };
      const code = (error as { code?: unknown })?.code;
      return errorResult(typeof code === 'string' && Object.hasOwn(safeErrors, code) ? safeErrors[code]
        : 'Action proof could not continue. The original request must match; check approval status before retrying.');
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }

  server.tool('get_action_approval', 'Read the status of a human wallet approval created by this MCP client. This operation never starts a proof or payment.', {
    approval_id: z.string().describe('The approval_id returned by generate_proof or prepare_inputs'),
  }, async ({ approval_id }) => {
    try {
      const approval = await approvals.get(config, approval_id);
      const status = await getActionApprovalStatus(config, approval);
      return jsonResult({ approval_id, status: status.status, expires_at: status.expiresAt });
    } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
  });
/**
 * Whether any payment wallet is configured at all.
 *
 * Checked before building one so a service running with payment disabled
 * needs no wallet and no flag: the flow only asks for a payer when the 402
 * says `requiresPayment`. Without this check, every free-tier call against a
 * machine with no credentials would fail before reaching the service.
 */
function hasAnyPaymentWalletConfigured(): boolean {
  return !!(process.env.PAYMENT_PRIVATE_KEY || process.env.CDP_API_KEY_ID || process.env.CIRCLE_API_KEY);
}

  // ─── generate_proof ─────────────────────────────────────────────────
  server.tool(
    'generate_proof',
    `All-in-one ZK proof generation. Handles: prepare inputs, request challenge, and submit proof in a single call. Use this when you want the simplest path to a proof. For fine-grained control over each step, use prepare_inputs, request_challenge, and submit_proof individually.

CIRCUITS:
  - "coinbase_kyc": Proves the user passed Coinbase KYC verification.
  - "coinbase_country": Proves the user's country of residence is (or is not) in a given list. Requires country_list and is_included.
  - "oidc_domain": Proves the user authenticated via OIDC and their email belongs to a specific domain. Requires jwt and scope.
  - "arc_eligibility": Coinbase KYC, optionally binding the wallet's signature to ONE EIP-712 action. Without action it signs the request signal hash. The proof carries that action's hash, so a contract can check WHICH instruction was authorised -- not merely that somebody eligible signed something. Verified on Arc Testnet (chain 5042002).
  - "giwa_attestation": GIWA attestation, optionally binding one EIP-712 action. Uses a GIWA-attested wallet; verified on GIWA Sepolia (chain 91342).

WITH ACTION: Returns awaiting_approval with an approval URL for the HUMAN to review and sign in their wallet. Keep the request parameters unchanged, query get_action_approval, then repeat with approval_id when approved. ATTESTATION_KEY cannot authorize an action on the human's behalf. Ordinary proofs without action retain automatic signing.

RETURNS: awaiting_approval or the full ProofResult with proof bytes, public inputs, and timing information. Use verify_proof separately to verify on-chain.`,
    {
      circuit: circuitParam(),
      approval_id: approvalIdParam(),
      scope: z
        .string()
        .optional()
        .describe('Scope string for nullifier derivation. Defaults to "proofport" if omitted. For oidc_domain circuit, this is the domain scope string.'),
      action: z
        .object({
          domain: z.object({
            name: z.string(),
            version: z.string(),
            chainId: z.number(),
            verifyingContract: z.string(),
          }),
          types: z.record(z.array(z.object({ name: z.string(), type: z.string() }))),
          primaryType: z.string(),
          message: z.record(z.unknown()),
        })
        .optional()
        .describe(
          'The EIP-712 action to authorise. Optional for arc_eligibility and giwa_attestation; rejected for other circuits. ' +
          'Any structure is provable: the circuit hashes it without reading it, so a deposit, a grant of authority ' +
          'or an agreement in prose all work. The wallet signs exactly these fields, and the proof carries their hash.',
        ),
      country_list: z
        .array(z.string())
        .optional()
        .describe('ISO 3166-1 alpha-2 country codes. Required for coinbase_country circuit.'),
      is_included: z
        .boolean()
        .optional()
        .describe('true = prove country IS in list, false = prove NOT in list. Required for coinbase_country circuit.'),
      jwt: z
        .string()
        .optional()
        .describe('OIDC JWT token (id_token) for oidc_domain circuit'),
      provider: z
        .enum(['google', 'microsoft'])
        .optional()
        .describe('OIDC provider. "google" (default) for Google Workspace, "microsoft" for Microsoft 365.'),
      pay_with: z
        .enum(['key', 'cdp', 'circle', 'arc'])
        .optional()
        .describe(
          'Which wallet pays, when the service charges. "arc" is an Arc agent wallet — Circle holds it, ' +
          'it carries spending policies the agent cannot ignore, and Circle CLI signs with it ' +
          '(install: npm i -g @circle-fin/cli, then circle wallet login <email> --testnet). ' +
          '"key" signs with PAYMENT_PRIVATE_KEY. ' +
          '"cdp" uses a Coinbase CDP server wallet (CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET). ' +
          '"circle" uses a Circle developer-controlled wallet (CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_ID) ' +
          'when that wallet supports the selected offer. Omit it and the single configured wallet is used; ' +
          'omit it with none configured against a paying service and the error names what to set. ' +
          'Wallet and chain are separate choices; both must support the actual offered signing domain.',
        ),
      pay_on: z
        .string()
        .optional()
        .describe(
          'Which chain to pay on: a CAIP-2 id ("eip155:5042002") or a plain name ' +
          '("arc-testnet", "arc-testnet-nano", "base-sepolia"). ' +
          'Call request_challenge to see what a service offers. Omitted takes the first chain offered. ' +
          'The payer signs an authorization and the service settles it, so no gas or native balance is needed ' +
          'on the paying chain -- only USDC. ' +
          '"arc-testnet-nano" is Arc nanopayments: the authorization goes to Circle Gateway, which verifies it ' +
          'off chain in under a second and settles it later in a batch with thousands of others, so the gas per ' +
          'payment approaches zero. It requires a Gateway balance -- deposit first with the deposit_to_gateway ' +
          'tool -- and is the right choice for an agent buying many proofs. "arc-testnet" settles each payment ' +
          'on chain immediately and costs gas every time.',
        ),
      max_payment:z.string().regex(/^\d+(\.\d{1,6})?$/).optional().describe('Maximum USDC proof fee allowed by the user.'),
      approved_payment:z.object({network:z.string(),scheme:z.string(),amount:z.string().regex(/^\d+$/),asset:z.string(),payTo:z.string(),extra:z.object({name:z.string(),version:z.string(),verifyingContract:z.string()})}).optional().describe('Exact user-approved terms. For direct EIP-3009 set extra.verifyingContract to the offer asset; for Gateway copy its required extra.verifyingContract. Changed fee, recipient, token, chain or signing domain is rejected before signing.'),
    },
    async (params) => {
      params = structuredClone(params);
      const request = originalRequest(params);
      try {
        const action = params.action ? structuredClone(params.action) : params.action;
        if (params.approval_id && !action) return errorResult('approval_id requires the original action');
        const actionApproval = params.approval_id
          ? await approvals.load(config, params.approval_id, 'generate_proof', request)
          : undefined;
        const payment = params.pay_with
          ? await walletFor(params.pay_with)
          : hasAnyPaymentWalletConfigured()
            ? await walletFromEnv()
            : undefined;
        const result = await generateProof(
          config,
          { attestation: signer, payment },
          {
            circuit: params.circuit,
            ...(action ? { action } : {}),
            ...(actionApproval ? { actionApproval } : {}),
            scope: params.scope,
            countryList: params.country_list,
            isIncluded: params.is_included,
            ...(params.circuit === 'oidc_domain' && { jwt: params.jwt, provider: params.provider }),
            payOn: params.pay_on,
            maxPayment:params.max_payment,
            approvedPayment:params.approved_payment,
          },
          {
            onStep: (step) => {
              // Steps are logged to stderr so they don't interfere with MCP protocol
              if (!process.env.ZKPROOFPORT_SILENT) {
                console.error(`[generate_proof] Step ${step.step}: ${step.name} (${step.durationMs}ms)`);
              }
            },
          },
        );
        return jsonResult(action ? publicProofSchema.parse(result) : result);
      } catch (error) {
        try { return await operationError(error, 'generate_proof', request); }
        catch (storageError) { return errorResult(storageError instanceof Error ? storageError.message : String(storageError)); }
      }
    },
  );

  // ─── Arc nanopayments: deposit and balance ──────────────────────────
  //
  // Nanopayments are not "small payments". The authorization goes to Circle
  // Gateway's off-chain ledger and is settled later in a batch with thousands
  // of others, so the gas per payment approaches zero -- which is what makes
  // a sub-cent price sensible at all. The money moves once, by depositing;
  // after that each payment is a signature.
  server.tool(
    'deposit_to_gateway',
    `Deposit USDC into Circle Gateway on Arc, so later proofs can be paid for with nanopayments (pay_on: "arc-testnet-nano").

Do this ONCE, not per proof. The deposit is the only on-chain step and it costs gas; every payment drawn against the balance costs almost none. Paying with "arc-testnet-nano" against an empty Gateway balance is refused.

Requires PAYMENT_PRIVATE_KEY -- the buyer signs authorizations with it and never sends a transaction per payment.

RETURNS: whether a deposit was made, its transaction hash, and the Gateway balance afterwards (in USDC's smallest units, so 1000000 is one USDC).`,
    {
      amount: z
        .string()
        .describe('How much USDC to deposit, in whole USDC as a decimal string, e.g. "5" or "0.5".'),
      at_least: z
        .string()
        .optional()
        .describe(
          'Skip the deposit if the Gateway balance already covers this, in USDC\'s smallest units ' +
          '(1000000 = 1 USDC). Omitted deposits unconditionally.',
        ),
      rpc_url: z
        .string()
        .optional()
        .describe('Arc RPC. Defaults to https://rpc.testnet.arc.io.'),
    },
    async (params) => {
      try {
        const key = process.env.PAYMENT_PRIVATE_KEY;
        if (!key) {
          return errorResult(
            'PAYMENT_PRIVATE_KEY is required to deposit: Gateway holds the balance for the wallet that deposits, ' +
            'and that wallet is the one signing the payments.',
          );
        }
        const wallet = {
          privateKey: (key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`,
          rpcUrl: params.rpc_url ?? 'https://rpc.testnet.arc.io',
        };
        const result = await ensureGatewayBalance(
          wallet,
          params.at_least !== undefined ? BigInt(params.at_least) : undefined,
          params.amount,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  deposited: result.deposited,
                  depositTxHash: result.depositTxHash ?? null,
                  available: result.balance.available.toString(),
                  withdrawing: result.balance.withdrawing.toString(),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.tool(
    'gateway_balance',
    `What the buyer currently holds inside Circle Gateway on Arc — the balance nanopayments are drawn against. Amounts are in USDC's smallest units (1000000 = 1 USDC). Requires PAYMENT_PRIVATE_KEY.`,
    {
      rpc_url: z.string().optional().describe('Arc RPC. Defaults to https://rpc.testnet.arc.io.'),
    },
    async (params) => {
      try {
        const key = process.env.PAYMENT_PRIVATE_KEY;
        if (!key) return errorResult('PAYMENT_PRIVATE_KEY is required to read a Gateway balance.');
        const balance = await gatewayBalance({
          privateKey: (key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`,
          rpcUrl: params.rpc_url ?? 'https://rpc.testnet.arc.io',
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                { available: balance.available.toString(), withdrawing: balance.withdrawing.toString() },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // ─── get_supported_circuits ─────────────────────────────────────────
  server.tool(
    'get_supported_circuits',
    `List all ZK circuits supported by ZKProofport, including verifier addresses and authorized signers. No parameters required. Call this first to discover available circuits before starting proof generation.`,
    async () => {
      try {
        return jsonResult({
          circuits: CIRCUITS,
          authorized_signers: AUTHORIZED_SIGNERS,
        });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // ─── request_challenge ──────────────────────────────────────────────
  server.tool(
    'request_challenge',
    `Step 2 of the step-by-step flow: Request a challenge from the server. Pass inputs: {} to discover the live payment offers, nonce and optional TEE key without transmitting private witness inputs. You MUST pass the returned "nonce" to submit_proof — without it the server just issues another challenge. MCP submit_proof does not sign payments or encrypt inputs; use generate_proof or the SDK for paid/encrypted orchestration.`,
    {
      circuit: circuitParam(),
      inputs: z
        .union([z.string(), z.record(z.unknown())])
        .describe('Use {} to discover the nonce, payment offers and optional TEE key without transmitting private witness inputs. Also accepts a JSON string or object from trusted local code; any supplied witness is sent to the selected prover and must stay out of model context, dApp/UI and logs.'),
    },
    async (params) => {
      try {
        const inputs =
          typeof params.inputs === 'string'
            ? JSON.parse(params.inputs)
            : params.inputs;

        const challenge = await requestChallenge(config, params.circuit, inputs);
        return jsonResult(challenge);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // ─── prepare_inputs ─────────────────────────────────────────────────
  server.tool(
    'prepare_inputs',
    `Step 1 of the step-by-step flow. WITH ACTION: human wallet approval is required; returns awaiting_approval until resumed with approval_id. Approved action witnesses stay in private local storage; pass the returned prepared_inputs_id to submit_proof. WITHOUT ACTION: retains the existing credential-key signature and private witness result. Handle private witness inputs only in trusted local code, never expose them to the dApp, model or logs. Call this BEFORE request_challenge. For oidc_domain provide jwt and scope.`,
    {
      circuit: circuitParam(),
      approval_id: approvalIdParam(),
      scope: z
        .string()
        .optional()
        .describe('Scope string for nullifier derivation. Defaults to "proofport" if omitted. For oidc_domain circuit, this is the domain scope string.'),
      action: z
        .object({
          domain: z.object({
            name: z.string(),
            version: z.string(),
            chainId: z.number(),
            verifyingContract: z.string(),
          }),
          types: z.record(z.array(z.object({ name: z.string(), type: z.string() }))),
          primaryType: z.string(),
          message: z.record(z.unknown()),
        })
        .optional()
        .describe(
          'The EIP-712 action to authorise. Optional for arc_eligibility and giwa_attestation; rejected for other circuits. ' +
          'Any structure is provable: the circuit hashes it without reading it, so a deposit, a grant of authority ' +
          'or an agreement in prose all work. The wallet signs exactly these fields, and the proof carries their hash.',
        ),
      country_list: z
        .array(z.string())
        .optional()
        .describe('ISO 3166-1 alpha-2 country codes. Required for coinbase_country circuit.'),
      is_included: z
        .boolean()
        .optional()
        .describe('true = prove country IS in list, false = prove NOT in list. Required for coinbase_country circuit.'),
      jwt: z
        .string()
        .optional()
        .describe('OIDC JWT token (id_token) for oidc_domain circuit'),
      provider: z
        .enum(['google', 'microsoft'])
        .optional()
        .describe('OIDC provider. "google" (default) for Google Workspace, "microsoft" for Microsoft 365.'),
    },
    async (params) => {
      params = structuredClone(params);
      const request = originalRequest(params);
      try {
        const action = params.action ? structuredClone(params.action) : params.action;
        const circuitId = CIRCUIT_NAME_MAP[params.circuit];
        const scope = params.scope || 'proofport';
        const isOidc = params.circuit === 'oidc_domain';

        const supportsAction = circuitId === CIRCUIT_IDS.ARC_ELIGIBILITY || circuitId === CIRCUIT_IDS.GIWA_ATTESTATION;
        if (action && !supportsAction) {
          return errorResult(`An action was given but '${circuitId}' was requested; only arc_eligibility and giwa_attestation carry one.`);
        }
        let actionHashes;
        try { actionHashes = action ? hashTypedAction(action) : undefined; }
        catch (validationError) { return errorResult(validationError instanceof Error ? validationError.message : 'Invalid action'); }
        if (params.approval_id && !action) return errorResult('approval_id requires the original action');

        if (isOidc) {
          // OIDC path: prepare inputs locally from JWT (no EAS attestation needed)
          if (!params.jwt) {
            return errorResult('jwt is required for oidc_domain circuit');
          }
          const oidcPayload = await prepareOidcPayload({ jwt: params.jwt, scope, provider: params.provider });
          return jsonResult(oidcPayload);
        }

        // EAS path: the circuit selects typed action or personal_sign.
        const actionApproval = params.approval_id
          ? await approvals.load(config, params.approval_id, 'prepare_inputs', request)
          : undefined;
        const authorization = action
          ? await resolveActionApproval(config, { circuit: params.circuit, scope, action }, actionApproval)
          : undefined;
        const userAddress = authorization ? authorization.address : await signer.getAddress();
        const signalHash = computeSignalHash(
          userAddress,
          scope,
          circuitId,
        );

        const userSignature = authorization
          ? authorization.signature
          : await signer.signMessage(signalHash);

        const inputs = await prepareInputs(config, {
          circuitId,
          userAddress,
          userSignature,
          scope,
          countryList: params.country_list,
          isIncluded: params.is_included,
          ...actionHashes,
        });

        if (actionHashes) {
          const id = await approvals.saveInputs(config, params.circuit, {
            ...inputs, domain_separator: actionHashes.domainSeparator, action_hash: actionHashes.actionHash,
          });
          return jsonResult({ prepared_inputs_id: id, circuit: params.circuit, domain_separator: actionHashes.domainSeparator, action_hash: actionHashes.actionHash });
        }
        return jsonResult(inputs);
      } catch (error) {
        try { return await operationError(error, 'prepare_inputs', request); }
        catch (storageError) { return errorResult(storageError instanceof Error ? storageError.message : String(storageError)); }
      }
    },
  );

  // ─── submit_proof ───────────────────────────────────────────────────
  server.tool(
    'submit_proof',
    `Step 3 of the step-by-step flow: Submit prepared inputs to generate the ZK proof. The TEE server runs the Noir circuit and returns the UltraHonk proof. This step may take 30-90 seconds. The TEE server builds Prover.toml from these inputs.

You MUST pass the nonce returned by request_challenge. POST /api/v1/prove answers every request that arrives without that nonce with a fresh 402 challenge, so a submission that omits it can never produce a proof.`,
    {
      circuit: circuitParam(),
      inputs: z
        .union([z.string(), z.record(z.unknown())])
        .optional()
        .describe(
          'Full ProveInputs object from prepare_inputs. Accepts a JSON string or a structured object.',
        ),
      prepared_inputs_id: z.string().optional().describe('Private local action witness handle returned by prepare_inputs. Use instead of inputs; consumed once.'),
      nonce: z
        .string()
        .describe(
          'The "nonce" field from the request_challenge response. Single-use and bound to the circuit it was issued for — request a new challenge for every submission and for every circuit.',
        ),
    },
    async (params) => {
      try {
        if ((params.inputs === undefined) === (params.prepared_inputs_id === undefined)) {
          return errorResult('Provide exactly one of inputs or prepared_inputs_id');
        }
        const inputs = params.prepared_inputs_id
          ? await approvals.consumeInputs(config, params.prepared_inputs_id, params.circuit)
          : typeof params.inputs === 'string'
            ? JSON.parse(params.inputs)
            : params.inputs;

        const result = await submitProof(config, {
          circuit: params.circuit,
          inputs,
          nonce: params.nonce,
        });

        return jsonResult(params.prepared_inputs_id ? publicProofSchema.parse(result) : result);
      } catch (error) {
        if (params.prepared_inputs_id) return errorResult('Private action proof submission could not complete. The handle may have been consumed; check the request before retrying.');
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // ─── verify_proof ──────────────────────────────────────────────────────
  server.tool(
    'verify_proof',
    `Step 4 (optional): Verify a ZK proof on-chain against the deployed verifier contract. Pass the full generate_proof result object directly — verification info (verifierAddress, chainId, rpcUrl) is extracted automatically. Returns { valid: true } if the proof is valid.`,
    {
      result: z
        .object({
          circuit: z.string().describe('Circuit name (e.g. coinbase_attestation)'),
          proofType: z.string().describe('Proof type identifier'),
          proof: z.string().describe('0x-prefixed proof hex bytes'),
          publicInputs: z.string().describe('0x-prefixed concatenated public inputs hex'),
          verification: z.object({
            verifierAddress: z.string().describe('Verifier contract address'),
            chainId: z.number().describe('Chain ID (e.g. 8453 for Base, 84532 for Base Sepolia)'),
            rpcUrl: z.string().describe('RPC URL for the chain'),
          }),
        })
        .passthrough()
        .describe('Full result object from generate_proof — pass it directly without extracting fields'),
    },
    async (params) => {
      try {
        const verification = await verifyProof({
          circuit: params.result.circuit,
          proofType: params.result.proofType,
          proof: params.result.proof,
          publicInputs: params.result.publicInputs,
          proofWithInputs: '',
          attestation: null,
          timing: { totalMs: 0 },
          verification: params.result.verification,
        });

        return jsonResult(verification);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // ─── proofport://config resource ────────────────────────────────────
  server.resource('config', 'proofport://config', async () => {
    const attestationAddress = await signer.getAddress();

    const data = {
      baseUrl: config.baseUrl,
      attestationWalletAddress: attestationAddress,
      supportedCircuits: CIRCUITS,
    };

    return {
      contents: [
        {
          uri: 'proofport://config',
          text: JSON.stringify(data, null, 2),
          mimeType: 'application/json',
        },
      ],
    };
  });
}
