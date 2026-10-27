import { describe, it, expect } from 'vitest';
import { CIRCUIT_DIRS, PROVABLE_CIRCUIT_IDS, circuitDirsLines } from '../src/config/circuitIds.js';

/**
 * `scripts/print-circuit-dirs.ts` output, read by ai-dev.sh and by the parent's
 * deploy scripts. The third field is the circuit id: the pinned-artifact
 * manifest is keyed by it, and coinbase_attestation's artifact name
 * (coinbase_attestation_v2) is not its id. Keyed by artifact name the first v2
 * staging revision refused to start (2026-10-28).
 */
describe('circuitDirsLines', () => {
  const lines = circuitDirsLines().split('\n');

  it('lists every provable circuit as `<dir> <artifact> <id>`', () => {
    expect(lines.map(l => l.split(' ')[2]).sort()).toEqual([...PROVABLE_CIRCUIT_IDS].sort());
    for (const line of lines) expect(line).toMatch(/^[a-z0-9-]+ [a-z0-9_]+ [a-z0-9_]+$/);
  });

  it('names coinbase_attestation by its id while pointing at the v2 artifact', () => {
    expect(lines).toContain('coinbase-attestation-v2 coinbase_attestation_v2 coinbase_attestation');
    expect(CIRCUIT_DIRS.coinbase_attestation.packageName).toBe('coinbase_attestation_v2');
  });
});
