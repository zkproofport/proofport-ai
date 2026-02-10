import { CIRCUITS } from '../../config/circuits.js';

export interface CircuitInfo {
  id: string;
  displayName: string;
  description: string;
  requiredInputs: readonly string[];
}

export interface GetCircuitsResult {
  circuits: CircuitInfo[];
}

/**
 * Return metadata for all supported circuits.
 * Used by the get_supported_circuits MCP tool.
 */
export function getSupportedCircuits(): GetCircuitsResult {
  const circuits: CircuitInfo[] = Object.values(CIRCUITS).map(circuit => ({
    id: circuit.id,
    displayName: circuit.displayName,
    description: circuit.description,
    requiredInputs: circuit.requiredInputs,
  }));

  return { circuits };
}
