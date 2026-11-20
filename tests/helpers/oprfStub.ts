/**
 * For SDK flow tests about something else (signing, approval, payment): the
 * OPRF step answers with the recorded real test-network values instead of
 * opening sockets. Use in a test file as
 *
 *   vi.mock('../packages/sdk/src/oprf/index.js', async orig => stubOprf(await orig()));
 *
 * prepareOprf still applies the real name rules (so a missing oprfDomain is
 * still refused) and records its arguments; checkPreparedOprf only checks
 * that the evaluation is for the circuit, wallet and scope asked, because the
 * recorded values belong to another wallet. The real checks are covered by
 * tests/oprfClient.test.ts, oprfTransport.test.ts and oprfFlow.test.ts.
 */
import { vi } from 'vitest';
import { createRequire } from 'node:module';

const REC = createRequire(import.meta.url)('../fixtures/oprf-exchange.json');

export const STUB_OPRF_INPUTS: Readonly<Record<string, string>> = Object.freeze({ ...REC.result });

type OprfModule = typeof import('../../packages/sdk/src/oprf/index.js');

export function stubOprf(real: OprfModule): OprfModule {
  return {
    ...real,
    prepareOprf: vi.fn(async (_config, args) => ({
      environment: 'staging' as const,
      circuitId: args.circuitId,
      address: args.address,
      oprfDomain: real.assertOprfName(args.oprfDomain, 'domain'),
      scope: real.assertOprfName(args.scope, 'scope'),
      inputs: { ...STUB_OPRF_INPUTS } as never,
    })),
    checkPreparedOprf: vi.fn((prepared, expect) => {
      const p = prepared as { circuitId?: string; address?: string; scope?: string; inputs?: unknown } | undefined;
      if (!p) throw new Error(`The OPRF values for ${expect.circuitId} are missing: call prepareOprf first.`);
      if (p.circuitId !== expect.circuitId || p.address?.toLowerCase() !== expect.address.toLowerCase() || p.scope !== expect.scope) {
        throw new Error('stubbed checkPreparedOprf: evaluation is for another circuit, wallet or scope');
      }
      return { ...(p.inputs as Record<string, string>) } as never;
    }),
  };
}
