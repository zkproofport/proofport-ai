import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  generateProof,
  requestChallenge,
  prepareInputs,
  prepareOidcPayload,
  submitProof,
  verifyProof,
  computeSignalHash,
  CIRCUITS,
  AUTHORIZED_SIGNERS,
  CIRCUIT_NAME_MAP,
  type ProofportSigner,
  type ClientConfig,
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
): void {
  // ─── generate_proof ─────────────────────────────────────────────────
  server.tool(
    'generate_proof',
    `All-in-one ZK proof generation. Handles: prepare inputs, request challenge, and submit proof in a single call. Use this when you want the simplest path to a proof. For fine-grained control over each step, use prepare_inputs, request_challenge, and submit_proof individually.

CIRCUITS:
  - "coinbase_kyc": Proves the user passed Coinbase KYC verification.
  - "coinbase_country": Proves the user's country of residence is (or is not) in a given list. Requires country_list and is_included.
  - "oidc_domain": Proves the user authenticated via OIDC and their email belongs to a specific domain. Requires jwt and scope.

RETURNS: Full ProofResult with proof bytes, public inputs, and timing information. Use verify_proof separately to verify on-chain.`,
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
      provider: z
        .enum(['google', 'microsoft'])
        .optional()
        .describe('OIDC provider. "google" (default) for Google Workspace, "microsoft" for Microsoft 365.'),
    },
    async (params) => {
      try {
        const result = await generateProof(
          config,
          { attestation: signer },
          {
            circuit: params.circuit,
            scope: params.scope,
            countryList: params.country_list,
            isIncluded: params.is_included,
            ...(params.circuit === 'oidc_domain' && { jwt: params.jwt, provider: params.provider }),
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
    `Step 2 of the step-by-step flow (after prepare_inputs): Request a challenge from the server. Sends circuit + inputs to POST /api/v1/prove. Server returns nonce and TEE key information. You MUST call prepare_inputs first to get the inputs parameter.`,
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
      provider: z
        .enum(['google', 'microsoft'])
        .optional()
        .describe('OIDC provider. "google" (default) for Google Workspace, "microsoft" for Microsoft 365.'),
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
          const oidcPayload = await prepareOidcPayload({ jwt: params.jwt, scope, provider: params.provider });
          return jsonResult(oidcPayload);
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

  // ─── submit_proof ───────────────────────────────────────────────────
  server.tool(
    'submit_proof',
    `Step 3 of the step-by-step flow: Submit prepared inputs to generate the ZK proof. The TEE server runs the Noir circuit and returns the UltraHonk proof. This step may take 30-90 seconds. The TEE server builds Prover.toml from these inputs.`,
    {
      circuit: z
        .enum(['coinbase_kyc', 'coinbase_country', 'oidc_domain'])
        .describe('Which circuit to use'),
      inputs: z
        .union([z.string(), z.record(z.unknown())])
        .describe(
          'Full ProveInputs object from prepare_inputs. Accepts a JSON string or a structured object.',
        ),
    },
    async (params) => {
      try {
        const inputs =
          typeof params.inputs === 'string'
            ? JSON.parse(params.inputs)
            : params.inputs;

        const result = await submitProof(config, {
          circuit: params.circuit,
          inputs,
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
    `Step 4 (optional): Verify a ZK proof on-chain against the deployed verifier contract. Pass the full generate_proof result object directly — verification info (verifierAddress, chainId, rpcUrl) is extracted automatically. Returns { valid: true } if the proof is valid.`,
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
