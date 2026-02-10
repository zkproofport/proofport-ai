export interface SimplifiedProofRequest {
  circuit: string;
  address: string;
  signature: string;
  scope: string;
  countryList?: string[];
  isIncluded?: boolean;
}

export interface ProofResult {
  proof: string;
  publicInputs: string[];
  nullifier: string;
  circuit: string;
  verifierAddress: string;
  chainId: number;
}

export interface ProverResponse {
  proof: string;
  publicInputs: string;
  proofWithInputs: string;
}
