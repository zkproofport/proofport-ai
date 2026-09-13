import { concat, getBytes, hexlify, keccak256 } from 'ethers';

export const ARC_CIRCUIT = 'arc_eligibility';
export const AUDIT_LIMITATION =
  'This checks a supplied candidate address; it does not invert a hash, discover an unknown address, or verify the ZK proof. A match establishes the nullifier relation only; authenticate the proof separately.';

const FIELD_COUNT = 192;
const FIELD_HEX_LENGTH = 64;

/** Arc v1 has 192 public byte values, each encoded as a 32-byte field. */
export function normalizeArcPublicInputs(publicInputs: unknown): string[] {
  let fields: unknown[];
  if (typeof publicInputs === 'string') {
    if (publicInputs.length !== 2 + FIELD_COUNT * FIELD_HEX_LENGTH || !/^0x[0-9a-fA-F]+$/.test(publicInputs)) {
      throw new Error('Arc publicInputs must contain exactly 192 hexadecimal bytes32 fields.');
    }
    fields = Array.from({ length: FIELD_COUNT }, (_, i) =>
      '0x' + publicInputs.slice(2 + i * FIELD_HEX_LENGTH, 2 + (i + 1) * FIELD_HEX_LENGTH));
  } else if (Array.isArray(publicInputs) && publicInputs.length === FIELD_COUNT) {
    fields = Array.from(publicInputs);
  } else {
    throw new Error('Arc publicInputs must be a packed hex string or an array of 192 bytes32 fields.');
  }
  return fields.map((field, index) => {
    if (typeof field !== 'string' || !/^0x0{62}[0-9a-fA-F]{2}$/.test(field)) {
      throw new Error(`Arc public input at index ${index} must be a bytes32-encoded byte (0 through 255).`);
    }
    return field.toLowerCase();
  });
}

export function extractArcPublicMetadata(publicInputs: unknown) {
  const fields = normalizeArcPublicInputs(publicInputs);
  const bytes = Uint8Array.from(fields, (field) => Number.parseInt(field.slice(-2), 16));
  return {
    circuitId: ARC_CIRCUIT,
    publicInputCount: FIELD_COUNT,
    publicInputsFingerprint: keccak256(concat(fields)),
    signalHash: hexlify(bytes.slice(0, 32)),
    domainSeparator: hexlify(bytes.slice(32, 64)),
    actionHash: hexlify(bytes.slice(64, 96)),
    signerRoot: hexlify(bytes.slice(96, 128)),
    scope: hexlify(bytes.slice(128, 160)),
    nullifier: hexlify(bytes.slice(160, 192)),
  };
}

export function candidateMatchesProof(publicInputs: unknown, candidateAddress: unknown): boolean {
  if (typeof candidateAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(candidateAddress)) {
    throw new Error('Candidate address must be exactly 20 bytes of 0x-prefixed hexadecimal.');
  }
  const metadata = extractArcPublicMetadata(publicInputs);
  const secret = keccak256(concat([getBytes(candidateAddress), metadata.signalHash]));
  return keccak256(concat([secret, metadata.scope])) === metadata.nullifier;
}
