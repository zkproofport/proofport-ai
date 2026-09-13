/**
 * Authorizing an action by another wallet without transferring KYC or identity.
 *
 * ## The problem this solves
 *
 * A wallet holds a Coinbase KYC attestation — call it A. A service wants proof
 * of that KYC before it will let anyone stake. But A is the wallet whose
 * on-chain history is worth hiding: revealing it links the KYC to everything
 * else A has ever done.
 *
 * So A never appears. A signs a statement naming a second wallet, B, and the
 * proof carries the hash of that statement. The service checks the proof, reads
 * B out of the statement, and lets B act — while A stays behind the proof.
 *
 * ## Why this is an ordinary action and not a new mechanism
 *
 * `arc_eligibility` already proves "the wallet holding this KYC authorised ONE
 * EIP-712 action". A delegation IS such an action: its fields name who is being
 * delegated to, what they may do, and until when. Nothing in the circuit
 * changes — only the structure being signed.
 *
 * That also means the delegation is bound to the proof: a proof made for one
 * delegation verifies for no other, because the action's hash is a public
 * input. Lifting the proof onto a different B is not possible.
 *
 * ## What the verifier must do
 *
 * Reading B out of the action is not enough. The service MUST rebuild the
 * action's hash from the delegation it was shown and compare it with the
 * proof's public input — otherwise anyone could present a valid proof
 * alongside a delegation naming a wallet of their choosing.
 * `delegationMatchesProof` is that check.
 */

import { ethers } from 'ethers';
import type { TypedAction } from './types.js';

/** What a delegation says. Every field is signed and none may be inferred. */
export interface Delegation {
  /** The operational wallet authorized by this action; it does not acquire KYC. */
  delegate: string;
  /** What the delegate may do, e.g. 'stake'. Free text the service defines. */
  action: string;
  /** Unix seconds. A delegation without an end is not offered. */
  expiresAt: number;
  /** Makes this delegation single-use, so it cannot be replayed. */
  nonce: string;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The EIP-712 type of a delegation, and the name its wallet renders. */
export const DELEGATION_PRIMARY_TYPE = 'CredentialDelegation';
export const DELEGATION_TYPES = {
  [DELEGATION_PRIMARY_TYPE]: [
    { name: 'delegate', type: 'address' },
    { name: 'action', type: 'string' },
    { name: 'expiresAt', type: 'uint256' },
    { name: 'nonce', type: 'string' },
  ],
} as const;

/**
 * Build the legacy generic action that A signs to authorize B.
 *
 * This four-field wire schema has no amount and is not compatible with the
 * Ledger House staking Gate's five-field CredentialDelegation type. For that
 * Gate, supply its exact TypedAction including amount; do not change this
 * helper's established type hash or treat this as a transfer of identity.
 *
 * `domain` names the service the delegation is for, so a delegation issued to
 * one service cannot be presented at another: the domain separator is part of
 * what the proof binds.
 */
export function buildDelegationAction(params: {
  delegation: Delegation;
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
}): TypedAction {
  const { delegation, domain } = params;
  if (!ADDRESS.test(delegation.delegate)) {
    throw new Error(`delegate must be an address, got '${delegation.delegate}'.`);
  }
  if (!delegation.action.trim()) {
    throw new Error('A delegation must say what the delegate may do; `action` was empty.');
  }
  if (!Number.isInteger(delegation.expiresAt) || delegation.expiresAt <= 0) {
    throw new Error('expiresAt must be a Unix time in seconds. A delegation without an end is not offered.');
  }
  if (!delegation.nonce.trim()) {
    throw new Error('A delegation needs a nonce, or the same signature can be replayed.');
  }
  return {
    domain,
    types: DELEGATION_TYPES as unknown as TypedAction['types'],
    primaryType: DELEGATION_PRIMARY_TYPE,
    message: {
      delegate: delegation.delegate,
      action: delegation.action,
      expiresAt: delegation.expiresAt,
      nonce: delegation.nonce,
    },
  };
}

/** The 32 bytes a proof carries for this action: EIP-712's hashStruct. */
export function delegationActionHash(action: TypedAction): string {
  return ethers.TypedDataEncoder.hashStruct(action.primaryType, action.types, action.message);
}

/** The 32 bytes a proof carries for the service this delegation is for. */
export function delegationDomainSeparator(action: TypedAction): string {
  return ethers.TypedDataEncoder.hashDomain(action.domain);
}

/**
 * Whether a proof was made for exactly this delegation.
 *
 * The reason to call this rather than trust the delegation shown alongside the
 * proof: a proof is public once presented, and anything that reads the
 * delegate out of an unverified structure can be handed a proof plus a
 * delegation naming somebody else.
 */
export function delegationMatchesProof(params: {
  action: TypedAction;
  /** The proof's `domain_separator` public input. */
  domainSeparator: string;
  /** The proof's `action_hash` public input. */
  actionHash: string;
  /** Unix seconds. An expired delegation is refused even when the proof is sound. */
  now?: number;
}): string | null {
  const { action, domainSeparator, actionHash } = params;
  const now = params.now ?? Math.floor(Date.now() / 1000);

  if (action.primaryType !== DELEGATION_PRIMARY_TYPE) {
    return `This action is a '${action.primaryType}', not a ${DELEGATION_PRIMARY_TYPE}. It authorises something, but not a delegation.`;
  }
  if (delegationDomainSeparator(action).toLowerCase() !== domainSeparator.toLowerCase()) {
    return 'The proof was made for a different service: its domain separator does not match this delegation.';
  }
  if (delegationActionHash(action).toLowerCase() !== actionHash.toLowerCase()) {
    return 'The proof was made for a different delegation: its action hash does not match the one shown.';
  }
  const expiresAt = Number(action.message.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return `This delegation expired at ${expiresAt}, and it is now ${now}.`;
  }
  return null;
}

/** The wallet a checked delegation names. Throws rather than return a guess. */
export function delegateOf(action: TypedAction): string {
  const delegate = action.message.delegate;
  if (typeof delegate !== 'string' || !ADDRESS.test(delegate)) {
    return (() => { throw new Error(`This action names no delegate address: got '${String(delegate)}'.`); })();
  }
  return delegate;
}
