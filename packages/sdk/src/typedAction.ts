/**
 * Checking the EIP-712 action an `arc_eligibility` proof binds to.
 *
 * ## This is a mirror, and the mirror is deliberate
 *
 * `@zkproofport-app/sdk` owns this check (`src/typedAction.ts` there). The
 * same reasoning that keeps the circuit-id list mirrored in this package
 * applies: this one is published to npm and runs on every `npx
 * zkproofport-mcp`, and the customer SDK carries `qrcode` and
 * `socket.io-client` — 38 transitive packages, measured — which is a poor
 * trade for a shape check.
 *
 * Nothing here may be edited on its own judgement. Change the customer SDK
 * first, then bring the change over. `tests/typedAction.test.ts` runs both
 * against the same table of cases and fails when their answers differ, so a
 * drift is a red test rather than two validators quietly disagreeing about
 * what a dapp is allowed to send.
 */
import type { TypedAction } from './types.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The reason the value is not a usable action, or `null` when it is one. */
export function validateTypedAction(value: unknown): string | null {
  if (value === undefined || value === null) {
    return 'action is required for arc_eligibility. The circuit proves that a wallet authorised ONE EIP-712 action; there is nothing to prove without it.';
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return 'action must be an object.';
  }
  const a = value as Partial<TypedAction>;

  const d = a.domain;
  if (!d || typeof d !== 'object') {
    return 'action.domain is required.';
  }
  for (const k of ['name', 'version', 'verifyingContract'] as const) {
    if (typeof d[k] !== 'string' || !d[k]) {
      return `action.domain.${k} must be a non-empty string.`;
    }
  }
  if (typeof d.chainId !== 'number' || !Number.isInteger(d.chainId)) {
    return 'action.domain.chainId must be an integer.';
  }
  if (!ADDRESS.test(d.verifyingContract)) {
    return 'action.domain.verifyingContract must be a 20-byte hex address.';
  }

  if (!a.types || typeof a.types !== 'object' || Array.isArray(a.types)) {
    return 'action.types is required.';
  }
  if (typeof a.primaryType !== 'string' || !a.primaryType) {
    return 'action.primaryType is required.';
  }
  if (!(a.primaryType in a.types)) {
    return `action.primaryType '${a.primaryType}' is not one of the structs in action.types.`;
  }
  if (!a.message || typeof a.message !== 'object' || Array.isArray(a.message)) {
    return 'action.message is required.';
  }

  const fields = a.types[a.primaryType];
  if (!Array.isArray(fields) || fields.length === 0) {
    return `action.types.${a.primaryType} declares no fields.`;
  }
  const missing = fields
    .map(f => f?.name)
    .filter(n => typeof n === 'string' && !(n in (a.message as object)));
  if (missing.length) {
    return `action.message is missing: ${missing.join(', ')}`;
  }

  return null;
}
