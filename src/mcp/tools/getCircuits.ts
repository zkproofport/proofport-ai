/**
 * getCircuits.ts — MCP tool wrapper for listing supported circuits.
 *
 * Thin adapter over CIRCUITS config.
 * Used by MCP server and unit tests.
 */

import { CIRCUITS } from '../../config/circuits.js';

export interface CircuitMetadata {
  id: string;
  displayName: string;
  description: string;
  requiredInputs: readonly string[];
}

export interface GetSupportedCircuitsOutput {
  circuits: CircuitMetadata[];
}

/**
 * Return metadata for all supported ZK circuits.
 */
export function getSupportedCircuits(): GetSupportedCircuitsOutput {
  const circuits: CircuitMetadata[] = Object.values(CIRCUITS).map((circuit) => ({
    id: circuit.id,
    displayName: circuit.displayName,
    description: circuit.description,
    requiredInputs: circuit.requiredInputs,
  }));

  return { circuits };
}
