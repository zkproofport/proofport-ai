import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  generateProof,
  requestChallenge,
  prepareInputs,
  prepareOidcInputs,
  buildOidcProverToml,
  makePayment,
  submitProof,
  verifyProof,
  computeSignalHash,
  CIRCUITS,
  AUTHORIZED_SIGNERS,
  CIRCUIT_NAME_MAP,
  type ProofportSigner,
  type ClientConfig,
  type PaymentInfo,
} from '@zkproofport-ai/sdk';

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

export function registerTools(
  server: McpServer,
  config: ClientConfig,
  signer: ProofportSigner,
  paymentSigner?: ProofportSigner,
): void {
  // ─── generate_proof ─────────────────────────────────────────────────
  server.tool(
    'generate_proof',
    `All-in-one ZK proof generation using x402 payment flow. Handles: prepare inputs, request 402 challenge, make USDC payment via x402 facilitator, and submit proof in a single call. Use this when you want the simplest path to a proof. For fine-grained control over each step, use prepare_inputs, request_challenge, make_payment, and submit_proof individually.

CIRCUITS:
  - "coinbase_kyc": Proves the user passed Coinbase KYC verification.
  - "coinbase_country": Proves the user's country of residence is (or is not) in a given list. Requires country_list and is_included.
  - "oidc_domain": Proves the user authenticated via OIDC and their email belongs to a specific domain. Requires jwt and scope.

RETURNS: Full ProofResult with proof bytes, public inputs, payment tx hash, and timing information. Use verify_proof separately to verify on-chain.`,
    {
      circuit: z
        .enum(['coinbase_kyc', 'coinbase_country', 'oidc_domain'])
        .describe('Which circuit to use'),
      scope: z
        .string()
        .optional()
        .describe('Scope string for nullifier derivation. Defaults to "proofport" if omitted. For oidc_domain circuit, this is the domain scope string.'),
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
    },
    async (params) => {
      try {
        const result = await generateProof(
          config,
          { attestation: signer, payment: paymentSigner },
          {
            circuit: params.circuit,
            scope: params.scope,
            countryList: params.country_list,
            isIncluded: params.is_included,
            ...(params.circuit === 'oidc_domain' && { jwt: params.jwt }),
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
        return jsonResult(result);
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
    `Step 2 of the step-by-step flow (after prepare_inputs): Request a 402 payment challenge. Sends circuit + inputs to POST /api/v1/prove without payment headers. Server returns 402 with payment nonce and requirements. You MUST call prepare_inputs first to get the inputs parameter.`,
    {
      circuit: z
        .enum(['coinbase_kyc', 'coinbase_country', 'oidc_domain'])
        .describe('Which circuit to use'),
      inputs: z
        .union([z.string(), z.record(z.unknown())])
        .describe('Full ProveInputs object from prepare_inputs. Accepts a JSON string or a structured object.'),
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
    `Step 1 of the step-by-step flow: Prepare all circuit inputs. Computes signal hash, signs it with the attestation wallet, queries EAS for attestation data, builds Merkle proof, and returns all inputs needed for proof generation. Call this BEFORE request_challenge. For oidc_domain circuit, provide jwt and scope instead of Coinbase-specific parameters.`,
    {
      circuit: z
        .enum(['coinbase_kyc', 'coinbase_country', 'oidc_domain'])
        .describe('Which circuit to use'),
      scope: z
        .string()
        .optional()
        .describe('Scope string for nullifier derivation. Defaults to "proofport" if omitted. For oidc_domain circuit, this is the domain scope string.'),
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
    },
    async (params) => {
      try {
        const circuitId = CIRCUIT_NAME_MAP[params.circuit];
        const scope = params.scope || 'proofport';
        const isOidc = params.circuit === 'oidc_domain';

        if (isOidc) {
          // OIDC path: prepare inputs locally from JWT (no EAS attestation needed)
          if (!params.jwt) {
            return errorResult('jwt is required for oidc_domain circuit');
          }
          const oidcInputs = await prepareOidcInputs({ jwt: params.jwt, scope });
          const proverToml = buildOidcProverToml(oidcInputs);
          return jsonResult({ ...oidcInputs, prover_toml: proverToml });
        }

        // Coinbase path: EAS attestation
        const userAddress = await signer.getAddress();
        const signalHash = computeSignalHash(
          userAddress,
          scope,
          circuitId,
        );

        const userSignature = await signer.signMessage(signalHash);

        const inputs = await prepareInputs(config, {
          circuitId,
          userAddress,
          userSignature,
          scope,
          countryList: params.country_list,
          isIncluded: params.is_included,
        });

        return jsonResult(inputs);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // ─── make_payment ───────────────────────────────────────────────────
  server.tool(
    'make_payment',
    `Step 3 of the step-by-step flow: Send USDC payment via x402 facilitator. Uses the payment wallet (or attestation wallet as fallback) to sign EIP-3009 TransferWithAuthorization settled via the x402 facilitator. Returns the transaction hash. Use the nonce, payTo, and maxAmountRequired from the request_challenge response.`,
    {
      nonce: z.string().describe('Payment nonce from the session response'),
      recipient: z.string().describe('Payment recipient address from the session response'),
      amount: z.number().describe('Payment amount in USDC base units (e.g. 100000 = $0.10)'),
      asset: z.string().describe('USDC contract address for the target network'),
      network: z
        .enum(['base-sepolia', 'base'])
        .describe('Target network for payment'),
      instruction: z.string().describe('Human-readable payment instruction from the session response'),
    },
    async (params) => {
      try {
        const payer = paymentSigner || signer;

        const paymentInfo: PaymentInfo = {
          nonce: params.nonce,
          recipient: params.recipient,
          amount: params.amount,
          asset: params.asset,
          network: params.network,
          instruction: params.instruction,
        };

        const txHash = await makePayment(payer, paymentInfo);

        return jsonResult({ tx_hash: txHash });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // ─── submit_proof ───────────────────────────────────────────────────
  server.tool(
    'submit_proof',
    `Step 4 of the step-by-step flow: Submit prepared inputs with x402 payment headers to generate the ZK proof. The TEE server verifies payment on-chain, runs the Noir circuit, and returns the UltraHonk proof. This step may take 30-90 seconds. For oidc_domain circuit, pass the full result from prepare_inputs (which includes prover_toml).`,
    {
      circuit: z
        .enum(['coinbase_kyc', 'coinbase_country', 'oidc_domain'])
        .describe('Which circuit to use'),
      inputs: z
        .union([z.string(), z.record(z.unknown())])
        .describe(
          'Full ProveInputs object from prepare_inputs. Accepts a JSON string or a structured object. For oidc_domain, this should include the prover_toml field.',
        ),
      payment_tx_hash: z
        .string()
        .describe('0x-prefixed transaction hash of the USDC payment from make_payment'),
      payment_nonce: z
        .string()
        .describe('0x-prefixed nonce from the request_challenge response'),
    },
    async (params) => {
      try {
        const inputs =
          typeof params.inputs === 'string'
            ? JSON.parse(params.inputs)
            : params.inputs;

        // If inputs contain prover_toml (OIDC path), send it separately
        const proverToml = (inputs as Record<string, unknown>).prover_toml as string | undefined;

        const result = await submitProof(config, {
          circuit: params.circuit,
          ...(proverToml ? { proverToml } : { inputs }),
          paymentTxHash: params.payment_tx_hash,
          paymentNonce: params.payment_nonce,
        });

        return jsonResult(result);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // ─── verify_proof ──────────────────────────────────────────────────────
  server.tool(
    'verify_proof',
    `Step 5 (optional): Verify a ZK proof on-chain against the deployed verifier contract. Pass the full generate_proof result object directly — verification info (verifierAddress, chainId, rpcUrl) is extracted automatically. Returns { valid: true } if the proof is valid.`,
    {
      result: z
        .object({
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
    const paymentAddress = paymentSigner
      ? await paymentSigner.getAddress()
      : attestationAddress;

    const data = {
      baseUrl: config.baseUrl,
      easRpcUrl: config.easRpcUrl ?? null,
      easGraphqlUrl: config.easGraphqlUrl ?? null,
      attestationWalletAddress: attestationAddress,
      paymentWalletAddress: paymentAddress,
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
