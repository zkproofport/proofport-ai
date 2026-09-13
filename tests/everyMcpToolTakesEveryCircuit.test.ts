import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CIRCUIT_NAME_MAP } from '../packages/sdk/src/types.js';

/**
 * Every tool an agent can call takes every circuit this server can prove.
 *
 * Four tools typed the circuit list out by hand, and two of them had fallen
 * behind: on 2026-09-12 `generate_proof`, `request_challenge` and `submit_proof`
 * did not list `arc_eligibility`, while `prepare_inputs` did — so an agent could
 * prepare an Arc proof and then had nowhere to send it. The list now comes from
 * the map the SDK owns, and this is what says so.
 */
const source = readFileSync(path.join(__dirname, '..', 'packages', 'mcp', 'src', 'tools.ts'), 'utf8');

describe('every MCP tool takes every circuit', () => {
  it('reads the circuit names from the SDK rather than typing them out', () => {
    expect(source).toContain('Object.keys(CIRCUIT_NAME_MAP)');
    // A hand-typed list is how the three drifted apart.
    expect(source).not.toMatch(/\.enum\(\[\s*'coinbase_kyc'/);
  });

  it('gives every tool the same circuit list', () => {
    const tools = source.match(/server\.tool\(\s*\n\s*'([a-z_]+)'/g) ?? [];
    const withCircuit = source.match(/circuit: circuitParam\(\)/g) ?? [];
    expect(tools.length).toBeGreaterThanOrEqual(4);
    // Every tool that names a circuit uses the shared one.
    expect(withCircuit.length).toBe(4);
  });

  it('knows Arc, and that Arc is the circuit carrying an action', () => {
    expect(Object.keys(CIRCUIT_NAME_MAP)).toContain('arc_eligibility');
    expect(source).toContain('arc_eligibility');
    expect(source).toContain('action: z');
    expect(source).toContain('primaryType: z.string()');
  });

  it('describes the action as something the agent supplies, not a default', () => {
    expect(source).toMatch(/Required for arc_eligibility and rejected for every other circuit/);
  });
});
