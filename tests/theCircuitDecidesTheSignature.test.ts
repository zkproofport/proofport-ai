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
import { ethers } from 'ethers';
import { CIRCUIT_IDS } from '../packages/sdk/src/circuits.js';

vi.mock('../packages/sdk/src/inputs.js', async (original) => ({
  ...await original<typeof import('../packages/sdk/src/inputs.js')>(),
  prepareInputs: vi.fn(async () => ({ signal_hash: '0xprepared' })),
}));
vi.mock('../packages/sdk/src/session.js', () => ({
  requestChallenge: vi.fn(async () => ({ nonce: 'test-nonce', requiresPayment: false })),
}));
vi.mock('../packages/sdk/src/prove.js', () => ({
  submitProof: vi.fn(async () => ({ proof: '0xproof' })),
  submitEncryptedProof: vi.fn(),
}));

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
  it('signs the signal hash for arc_eligibility when no action is given', async () => {
    /*
     * This asserted a refusal until 2026-09-22, when the circuit gained the
     * branch it had never had: with no action it personal_signs the signal
     * hash, exactly as coinbase_attestation does. What the circuit does is
     * what decides here, which is the point of the file's name.
     */
    const signer = watchfulSigner();
    await runFlow({ circuit: 'arc_eligibility', scope: 'test' }, signer);
    expect(signer.signMessage).toHaveBeenCalled();
    expect(signer.signTypedData).not.toHaveBeenCalled();
  });

  it('signs the typed data for arc_eligibility when an action is given', async () => {
    const signer = watchfulSigner();
    await runFlow({ circuit: 'arc_eligibility', scope: 'test', action: ACTION }, signer);
    expect(signer.signTypedData).toHaveBeenCalled();
    expect(signer.signMessage).not.toHaveBeenCalled();
  });

  it('refuses an action on a circuit that cannot carry one', async () => {
    const signer = watchfulSigner();
    await expect(
      runFlow({ circuit: 'coinbase_kyc', scope: 'test', action: ACTION }, signer),
    ).rejects.toThrow(/only arc_eligibility carries one|An action was given but/);
    expect(signer.signTypedData).not.toHaveBeenCalled();
  });

  it('names the circuits that do carry an action, so a caller knows where to go', async () => {
    const signer = watchfulSigner();
    const extra = await runFlow(
      { circuit: 'coinbase_kyc', scope: 'test', action: ACTION },
      signer,
    ).catch((e: Error) => e.message);
    expect(extra).toContain(CIRCUIT_IDS.ARC_ELIGIBILITY);
    expect(extra).toContain(CIRCUIT_IDS.GIWA_ATTESTATION);
  });
});

const NESTED_ACTION = {
  ...ACTION,
  types: {
    Instruction: [{ name: 'terms', type: 'Terms' }, { name: 'labels', type: 'string[]' }],
    Terms: [{ name: 'quantity', type: 'uint256' }, { name: 'memo', type: 'string' }],
  },
  primaryType: 'Instruction',
  message: { terms: { quantity: '10000000', memo: 'caller-owned names and values' }, labels: ['custom', 'nested'] },
};

const BOOLEAN_ACTION = {
  ...NESTED_ACTION,
  types: {
    Instruction: [{ name: 'terms', type: 'Terms' }, { name: 'batches', type: 'Terms[][]' }],
    Terms: [{ name: 'enabled', type: 'bool' }],
  },
  message: { terms: { enabled: true }, batches: [[{ enabled: false }], [{ enabled: true }]] },
};

const invalidActions = [
  ['missing nested bool', { ...BOOLEAN_ACTION, message: { ...BOOLEAN_ACTION.message, terms: {} } }, /action.message.terms.enabled.*required|missing/],
  ...['false', 0, {}].map(value => [
    `malformed nested bool ${JSON.stringify(value)}`,
    { ...BOOLEAN_ACTION, message: { ...BOOLEAN_ACTION.message, terms: { enabled: value } } },
    /action.message.terms.enabled.*boolean/,
  ] as const),
  ['missing field in nested struct array', { ...BOOLEAN_ACTION, message: { ...BOOLEAN_ACTION.message, batches: [[{}]] } }, /batches\[0\]\[0\].enabled.*required|missing/],
  ['malformed bool in nested struct array', { ...BOOLEAN_ACTION, message: { ...BOOLEAN_ACTION.message, batches: [[{ enabled: 'false' }]] } }, /batches\[0\]\[0\].enabled.*boolean/],
  ...[null, 7, ''].map(name => [
    `malformed declaration name ${JSON.stringify(name)}`,
    { ...ACTION, types: { Deposit: [{ name, type: 'uint256' }] }, message: { [String(name)]: '1' } },
    /field.*name.*non-empty string/,
  ] as const),
  ['malformed declaration type', { ...ACTION, types: { Deposit: [{ name: 'amount', type: null }] } }, /field.*type.*non-empty string/],
  ['missing domain', { ...ACTION, domain: undefined }, /action.domain/],
  ['missing message field', { ...ACTION, message: {} }, /missing.*amount/],
  ['malformed amount', { ...ACTION, message: { amount: 'not-an-integer' } }, /./],
  ['malformed field', { ...ACTION, types: { Deposit: [{ name: 'amount', type: 'unknownType' }] } }, /./],
  ['declared primaryType differs from encoder root', {
    ...NESTED_ACTION, primaryType: 'Terms', message: { quantity: '1', memo: 'wrong root' },
  }, /primaryType.*root|root.*primaryType/],
  ['reserved EIP712Domain referenced by the root', {
    ...ACTION,
    types: { Deposit: [...ACTION.types.Deposit, { name: 'context', type: 'EIP712Domain' }], EIP712Domain: [{ name: 'name', type: 'string' }] },
    message: { amount: '1', context: { name: 'reserved' } },
  }, /EIP712Domain/],
  ['explicit EIP712Domain', { ...ACTION, types: { ...ACTION.types, EIP712Domain: [{ name: 'name', type: 'string' }] } }, /./],
] as const;

describe('action validation before local signing', () => {
  it.each(invalidActions)('rejects %s before either signature', async (_name, action, error) => {
    const signer = watchfulSigner();
    await expect(runFlow({ circuit: 'arc_eligibility', action }, signer)).rejects.toThrow(error);
    expect(signer.getAddress).not.toHaveBeenCalled();
    expect(signer.signMessage).not.toHaveBeenCalled();
    expect(signer.signTypedData).not.toHaveBeenCalled();
  });

  it('rejects an action on OIDC before JWT processing or signing', async () => {
    const signer = watchfulSigner();
    await expect(runFlow({ circuit: 'oidc_domain', action: ACTION }, signer))
      .rejects.toThrow(/only arc_eligibility carries one|An action was given but/);
    expect(signer.getAddress).not.toHaveBeenCalled();
    expect(signer.signMessage).not.toHaveBeenCalled();
    expect(signer.signTypedData).not.toHaveBeenCalled();
  });

  it('signs caller-owned nested types and passes both hashes into recovery and proof submission', async () => {
    const signer = watchfulSigner();
    await runFlow({ circuit: 'arc_eligibility', action: NESTED_ACTION }, signer);
    expect(signer.signTypedData).toHaveBeenCalledWith(NESTED_ACTION.domain, NESTED_ACTION.types, NESTED_ACTION.message);
    expect(signer.signMessage).not.toHaveBeenCalled();
    const domainSeparator = ethers.TypedDataEncoder.hashDomain(NESTED_ACTION.domain);
    const actionHash = ethers.TypedDataEncoder.hashStruct('Instruction', NESTED_ACTION.types, NESTED_ACTION.message);
    const { prepareInputs } = await import('../packages/sdk/src/inputs.js');
    const { submitProof } = await import('../packages/sdk/src/prove.js');
    expect(prepareInputs).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ domainSeparator, actionHash }));
    expect(submitProof).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      inputs: expect.objectContaining({ domain_separator: domainSeparator, action_hash: actionHash }),
    }));
  });

  it('exports reusable hashing for SDK stepwise callers', async () => {
    const sdk = await import('../packages/sdk/src/index.js');
    expect(sdk).toHaveProperty('hashTypedAction', expect.any(Function));
    expect(sdk.hashTypedAction(NESTED_ACTION)).toEqual({
      domainSeparator: ethers.TypedDataEncoder.hashDomain(NESTED_ACTION.domain),
      actionHash: ethers.TypedDataEncoder.hashStruct('Instruction', NESTED_ACTION.types, NESTED_ACTION.message),
    });
    expect(() => sdk.hashTypedAction(undefined as never)).toThrow(/action is required/);
  });
});


describe('action ownership across asynchronous signing', () => {
  it('snapshots the approved action before getAddress can mutate caller-owned values', async () => {
    const action = { ...ACTION, types: { Deposit: [
      { name: 'amount', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
    ] }, message: { amount: '10000000', nonce: '1' } };
    const approved = structuredClone(action);
    const wallet = ethers.Wallet.createRandom();
    const signer = {
      getAddress: vi.fn(async () => { action.message.nonce = '2'; return wallet.address; }),
      signMessage: vi.fn(wallet.signMessage.bind(wallet)),
      signTypedData: vi.fn(wallet.signTypedData.bind(wallet)),
    };
    await runFlow({ circuit: 'arc_eligibility', action }, signer);
    const { prepareInputs } = await import('../packages/sdk/src/inputs.js');
    const input = vi.mocked(prepareInputs).mock.calls.at(-1)![1];
    expect(ethers.verifyTypedData(approved.domain, approved.types, approved.message, input.userSignature) === wallet.address).toBe(true);
    expect(input.actionHash).toBe(ethers.TypedDataEncoder.hashStruct(approved.primaryType, approved.types, approved.message));
    expect(signer.signTypedData).toHaveBeenCalledWith(approved.domain, approved.types, approved.message);
  });
});


it('hashes and signs actual booleans in arbitrary nested structs and arrays', async () => {
  const signer = watchfulSigner();
  await runFlow({ circuit: 'arc_eligibility', action: BOOLEAN_ACTION }, signer);
  expect(signer.signTypedData).toHaveBeenCalledWith(BOOLEAN_ACTION.domain, BOOLEAN_ACTION.types, BOOLEAN_ACTION.message);
  const { hashTypedAction } = await import('../packages/sdk/src/index.js');
  expect(hashTypedAction(BOOLEAN_ACTION).actionHash).toBe(ethers.TypedDataEncoder.hashStruct('Instruction', BOOLEAN_ACTION.types, BOOLEAN_ACTION.message));
});

/**
 * The same rule, one layer down: what the server hands to noir_js.
 *
 * The flow above decides what the WALLET signs. This decides what the PROVER
 * receives, and the two were out of step: the formatter added the action pair
 * only when the circuit id was `arc_eligibility`, and required one there.
 * `giwa_attestation` takes the same two parameters, so every GIWA request died
 * inside noir_js with "Expected argument `action_hash`, but none was found" —
 * a message that names a circuit input and not the missing branch. Arc, for
 * its part, could no longer be proved WITHOUT an action, months after the
 * circuit made it optional.
 */
describe('what the prover hands to noir_js', () => {
  const ZERO_32 = Array(32).fill('0x00');

  /** Enough of a CircuitParams to format; the values are shapes, not real proofs. */
  function params(extra: Record<string, unknown> = {}) {
    return {
      signalHash: new Uint8Array(32).fill(0xab),
      merkleRoot: '0x' + 'cd'.repeat(32),
      scopeBytes: new Uint8Array(32).fill(0xef),
      nullifierBytes: new Uint8Array(32).fill(0x12),
      userAddress: '0x' + '34'.repeat(20),
      userSignature: '0x' + '56'.repeat(32) + '78'.repeat(32) + '1b',
      userPubkeyX: '0x' + '9a'.repeat(32),
      userPubkeyY: '0x' + 'bc'.repeat(32),
      rawTxBytes: Array(120).fill(7),
      txLength: 120,
      attesterPubkeyX: '0x' + 'de'.repeat(32),
      attesterPubkeyY: '0x' + 'f0'.repeat(32),
      merkleProof: ['0x' + '01'.repeat(32), '0x' + '02'.repeat(32)],
      merkleLeafIndex: 0,
      merkleDepth: 2,
      ...extra,
    } as never;
  }

  async function format(circuitId: string, extra: Record<string, unknown> = {}) {
    const { formatAttestationInputs } = await import('../src/prover/inputFormatter.js');
    return formatAttestationInputs(circuitId as never, params(extra));
  }

  const ACTION_PAIR = {
    domainSeparator: '0x' + 'aa'.repeat(32),
    actionHash: '0x' + 'bb'.repeat(32),
  };

  for (const circuitId of [CIRCUIT_IDS.ARC_ELIGIBILITY, CIRCUIT_IDS.GIWA_ATTESTATION]) {
    it(`sends ${circuitId} an empty action pair when no action was bound`, async () => {
      const inputs = await format(circuitId);
      expect(inputs.domain_separator).toEqual(ZERO_32);
      expect(inputs.action_hash).toEqual(ZERO_32);
      // The challenge is what was signed, so it must arrive filled.
      expect(inputs.signal_hash).not.toEqual(ZERO_32);
    });

    it(`empties ${circuitId}'s signal hash when an action was bound`, async () => {
      const inputs = await format(circuitId, ACTION_PAIR);
      expect(inputs.signal_hash).toEqual(ZERO_32);
      expect(inputs.domain_separator).toEqual(Array(32).fill('0xaa'));
      expect(inputs.action_hash).toEqual(Array(32).fill('0xbb'));
    });

    it(`refuses ${circuitId} half an action`, async () => {
      await expect(format(circuitId, { domainSeparator: ACTION_PAIR.domainSeparator }))
        .rejects.toThrow(/both domain_separator and action_hash/);
    });
  }

  for (const circuitId of [CIRCUIT_IDS.COINBASE_ATTESTATION, CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]) {
    it(`gives ${circuitId} no action parameters at all`, async () => {
      const extra = circuitId === CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION
        ? { countryList: ['US'], countryListLength: 1, isIncluded: true }
        : {};
      const inputs = await format(circuitId, extra);
      expect('domain_separator' in inputs).toBe(false);
      expect('action_hash' in inputs).toBe(false);
      expect(inputs.signal_hash).not.toEqual(ZERO_32);
    });

    it(`refuses an action on ${circuitId} instead of dropping it`, async () => {
      await expect(format(circuitId, ACTION_PAIR)).rejects.toThrow(/has no inputs for one/);
    });
  }
});
