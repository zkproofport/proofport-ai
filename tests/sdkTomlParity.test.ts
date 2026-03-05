import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { toProverToml } from '../src/prover/tomlBuilder';
import type { CircuitParams } from '../src/prover/tomlBuilder';
import { buildProverToml } from '../packages/sdk/src/toml';
import type { ProveInputs, CircuitId } from '../packages/sdk/src/types';

// Helper: convert hex string to number array
function hexToBytes(hex: string): number[] {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return bytes;
}

describe('SDK buildProverToml parity with server toProverToml', () => {
  // Generate a deterministic signature for testing
  const wallet = new ethers.Wallet('0x' + 'ab'.repeat(32));
  const testSigMessage = new Uint8Array(32).fill(0x42);
  let testSignature: string;

  // Shared test data
  const signalHashHex = '0x' + '95'.repeat(32);
  const merkleRootHex = '0x' + 'b6'.repeat(32);
  const scopeBytesHex = '0x' + '89'.repeat(32);
  const nullifierHex = '0x' + 'c8'.repeat(32);
  const userAddressHex = '0x' + 'd6'.repeat(20);
  const pubkeyXHex = '0x' + '2c'.repeat(32);
  const pubkeyYHex = '0x' + '26'.repeat(32);
  const attesterPubkeyXHex = '0x' + '8b'.repeat(32);
  const attesterPubkeyYHex = '0x' + 'e7'.repeat(32);
  const rawTxHex = '0x' + '02ff'.repeat(50); // 100 bytes
  const txLength = 100;
  const merkleProof = ['0x' + '1f'.repeat(32), '0x' + 'b2'.repeat(32), '0x' + 'a3'.repeat(32)];
  const leafIndex = 2;
  const depth = 3;

  // Build server CircuitParams and SDK ProveInputs from same data
  function buildTestData(circuitId: CircuitId) {
    const serverParams: CircuitParams = {
      signalHash: ethers.getBytes(signalHashHex),
      merkleRoot: merkleRootHex,
      scopeBytes: ethers.getBytes(scopeBytesHex),
      nullifierBytes: ethers.getBytes(nullifierHex),
      userAddress: userAddressHex,
      userSignature: testSignature,
      userPubkeyX: pubkeyXHex,
      userPubkeyY: pubkeyYHex,
      rawTxBytes: hexToBytes(rawTxHex),
      txLength,
      attesterPubkeyX: attesterPubkeyXHex,
      attesterPubkeyY: attesterPubkeyYHex,
      merkleProof,
      merkleLeafIndex: leafIndex,
      merkleDepth: depth,
    };

    const sdkInputs: ProveInputs = {
      signal_hash: signalHashHex,
      merkle_root: merkleRootHex,
      scope_bytes: scopeBytesHex,
      nullifier: nullifierHex,
      user_address: userAddressHex,
      signature: testSignature,
      user_pubkey_x: pubkeyXHex,
      user_pubkey_y: pubkeyYHex,
      raw_transaction: rawTxHex,
      tx_length: txLength,
      coinbase_attester_pubkey_x: attesterPubkeyXHex,
      coinbase_attester_pubkey_y: attesterPubkeyYHex,
      merkle_proof: merkleProof,
      leaf_index: leafIndex,
      depth,
    };

    if (circuitId === 'coinbase_country_attestation') {
      (serverParams as any).countryList = ['US', 'KR'];
      (serverParams as any).countryListLength = 2;
      (serverParams as any).isIncluded = true;
      sdkInputs.country_list = ['US', 'KR'];
      sdkInputs.is_included = true;
    }

    return { serverParams, sdkInputs };
  }

  it('should sign test message (setup)', async () => {
    testSignature = await wallet.signMessage(testSigMessage);
    expect(testSignature).toBeTruthy();
  });

  it('should produce identical output for coinbase_attestation', async () => {
    if (!testSignature) testSignature = await wallet.signMessage(testSigMessage);

    const circuitId: CircuitId = 'coinbase_attestation';
    const { serverParams, sdkInputs } = buildTestData(circuitId);

    const serverToml = toProverToml(circuitId, serverParams);
    const sdkToml = buildProverToml(circuitId, sdkInputs);

    expect(sdkToml).toBe(serverToml);
  });

  it('should produce identical output for coinbase_country_attestation', async () => {
    if (!testSignature) testSignature = await wallet.signMessage(testSigMessage);

    const circuitId: CircuitId = 'coinbase_country_attestation';
    const { serverParams, sdkInputs } = buildTestData(circuitId);

    const serverToml = toProverToml(circuitId, serverParams);
    const sdkToml = buildProverToml(circuitId, sdkInputs);

    expect(sdkToml).toBe(serverToml);
  });

  it('should have identical field ordering', async () => {
    if (!testSignature) testSignature = await wallet.signMessage(testSigMessage);

    const circuitId: CircuitId = 'coinbase_attestation';
    const { serverParams, sdkInputs } = buildTestData(circuitId);

    const serverToml = toProverToml(circuitId, serverParams);
    const sdkToml = buildProverToml(circuitId, sdkInputs);

    const serverFields = serverToml.split('\n')
      .filter(l => l.includes(' = '))
      .map(l => l.split(' = ')[0].trim());

    const sdkFields = sdkToml.split('\n')
      .filter(l => l.includes(' = '))
      .map(l => l.split(' = ')[0].trim());

    expect(sdkFields).toEqual(serverFields);
  });
});
