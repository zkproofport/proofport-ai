/**
 * The circuit decides what the wallet signs. A mismatch is refused, not guessed.
 *
 * The prove flow used to choose the signature shape by whether the caller
 * passed an action, carrying the circuit id along beside it. That reads as two
 * paths and is really four, and two of them are silently wrong:
 *
 *   - `arc_eligibility` with no action signed `signal_hash` through
 *     personal_sign, so the domain separator and action hash — both public
 *     inputs of that circuit — were absent from what the prover received.
 *   - a Coinbase circuit with an action signed typed data, which that circuit
 *     cannot verify, because it expects a signature over `signal_hash`.
 *
 * The mobile app had the same defect in its KYC hook and it produced proofs
 * from the wrong circuit for a day before anyone noticed.
 */
import { describe, it, expect, vi } from 'vitest';
import { CIRCUIT_IDS } from '../packages/sdk/src/circuits.js';

/** A signer that records what it was asked to sign, and is never reached here. */
function watchfulSigner() {
  return {
    getAddress: vi.fn(async () => '0x1111111111111111111111111111111111111111'),
    signMessage: vi.fn(async () => '0x' + '11'.repeat(65)),
    signTypedData: vi.fn(async () => '0x' + '22'.repeat(65)),
  };
}

const ACTION = {
  domain: {
    name: 'MyVault',
    version: '1',
    chainId: 5042002,
    verifyingContract: '0x0000000000000000000000000000000000000000',
  },
  types: { Deposit: [{ name: 'amount', type: 'uint256' }] },
  primaryType: 'Deposit',
  message: { amount: '1000000' },
};

/**
 * The entry point takes the client-facing NAME (`coinbase_kyc`,
 * `arc_eligibility`), which it maps to the canonical id. The refusals below
 * happen before any network call, so nothing here needs a running service.
 */
async function runFlow(params: Record<string, unknown>, signer: ReturnType<typeof watchfulSigner>) {
  const { generateProof } = await import('../packages/sdk/src/flow.js');
  return generateProof(
    { baseUrl: 'http://localhost:4002' } as never,
    { attestation: signer } as never,
    params as never,
  );
}

describe('the circuit decides the signature', () => {
  it('refuses arc_eligibility with no action, and says what is missing', async () => {
    const signer = watchfulSigner();
    await expect(
      runFlow({ circuit: 'arc_eligibility', scope: 'test' }, signer),
    ).rejects.toThrow(/authorised ONE EIP-712 action, and no action was given/);
    // Nothing was signed, so nothing wrong could have been sent.
    expect(signer.signMessage).not.toHaveBeenCalled();
    expect(signer.signTypedData).not.toHaveBeenCalled();
  });

  it('refuses an action on a circuit that cannot carry one', async () => {
    const signer = watchfulSigner();
    await expect(
      runFlow({ circuit: 'coinbase_kyc', scope: 'test', action: ACTION }, signer),
    ).rejects.toThrow(/only arc_eligibility carries one|An action was given but/);
    expect(signer.signTypedData).not.toHaveBeenCalled();
  });

  it('names the alternative in both refusals, so a caller knows what to do', async () => {
    const signer = watchfulSigner();
    const missing = await runFlow({ circuit: 'arc_eligibility', scope: 'test' }, signer).catch(
      (e: Error) => e.message,
    );
    expect(missing).toContain(CIRCUIT_IDS.COINBASE_ATTESTATION);

    const extra = await runFlow(
      { circuit: 'coinbase_kyc', scope: 'test', action: ACTION },
      signer,
    ).catch((e: Error) => e.message);
    expect(extra).toContain(CIRCUIT_IDS.ARC_ELIGIBILITY);
  });
});
