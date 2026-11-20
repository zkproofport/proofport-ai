/**
 * Which OPRF network a wallet credential proof is evaluated on, per
 * environment. The environment is the proving service's (GET /api/v1/oprf),
 * never customer configuration; an environment without a row is refused by
 * name, never given another environment's network.
 *
 * - staging, local: the public test network, three nodes, threshold 2, its
 *   `basic` module, which authorizes a request by the network's PUBLIC test
 *   API key (published in the network's own quickstart; rate-limited; not a
 *   secret) and accepts any query point.
 * - production: no row. No production network or key exists for this
 *   integration yet.
 *
 * The request-proof module (the wallet's EIP-712 OprfRequest signature plus a
 * request-auth proof; proofport-oprf/REQUEST-VERIFIER.md) is a separate auth
 * kind. No network row uses it yet, and this client cannot produce the
 * request-auth proof (the SDK never proves; see evaluateOprf).
 */
import type { OprfEnvironment } from './keyHashes.js';
import { OPRF_ENVIRONMENTS, isOprfEnvironment } from './keyHashes.js';

export type OprfNetworkAuth =
  | { kind: 'api-key'; apiKey: string }
  | { kind: 'request-proof'; version: string };

export interface OprfNetwork {
  /** Node base URLs (https://...). The WebSocket endpoint is wss://<host>/api/<module>/oprf. */
  nodes: readonly string[];
  /** Answers needed; the client combines exactly this many. */
  threshold: number;
  /** The node-side authorization module. */
  module: string;
  auth: OprfNetworkAuth;
}

const TEST_NETWORK: OprfNetwork = Object.freeze({
  nodes: Object.freeze([
    'https://node0.eu.test.oprf.taceo.network',
    'https://node1.eu.test.oprf.taceo.network',
    'https://node2.eu.test.oprf.taceo.network',
  ]),
  threshold: 2,
  module: 'basic',
  auth: Object.freeze({ kind: 'api-key' as const, apiKey: 'taceo_3ZfE55WkcNWRweh5rcfpUNpi' }),
});

export const OPRF_NETWORKS: Readonly<Record<OprfEnvironment, OprfNetwork | null>> = Object.freeze({
  production: null,
  staging: TEST_NETWORK,
  local: TEST_NETWORK,
});

/**
 * The network for `environment`.
 * @throws naming an unknown environment, or one with no OPRF network (production today).
 */
export function getOprfNetwork(environment: unknown): OprfNetwork {
  if (!isOprfEnvironment(environment)) {
    throw new Error(`Unknown OPRF environment '${String(environment)}'. Known: ${OPRF_ENVIRONMENTS.join(', ')}.`);
  }
  const row = OPRF_NETWORKS[environment];
  if (row === null) {
    throw new Error(
      `No OPRF network is registered for the '${environment}' environment, so no wallet credential proof can be made there yet.`,
    );
  }
  return row;
}
