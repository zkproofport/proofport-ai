import { ethers } from 'ethers';
import type { TypedAction } from './types.js';
import { validateTypedAction } from './typedAction.js';

/**
 * Validate and hash a caller-owned EIP-712 action before asking a wallet to sign.
 * `types` must omit EIP712Domain and have one root matching `primaryType`.
 * Encoding here also rejects malformed field definitions and message values.
 */
export function hashTypedAction(action: TypedAction): {
  domainSeparator: string;
  actionHash: string;
} {
  const error = validateTypedAction(action);
  if (error) throw new Error(error);

  if ('EIP712Domain' in action.types) {
    throw new Error('action.types must omit EIP712Domain; the signing domain is derived from action.domain.');
  }

  // ethers permits coercion of declaration names; the caller must name fields
  // explicitly with strings, including on structs nested below the root.
  for (const [struct, fields] of Object.entries(action.types)) {
    if (!struct || !Array.isArray(fields)) {
      throw new Error('action.types must map non-empty struct names to field arrays.');
    }
    for (const [index, field] of fields.entries()) {
      if (!field || typeof field.name !== 'string' || !field.name) {
        throw new Error(`action.types.${struct} field ${index} name must be a non-empty string.`);
      }
      if (typeof field.type !== 'string' || !field.type) {
        throw new Error(`action.types.${struct} field ${index} type must be a non-empty string.`);
      }
    }
  }

  const encoder = ethers.TypedDataEncoder.from(action.types);
  if (encoder.primaryType !== action.primaryType) {
    throw new Error(
      `action.primaryType '${action.primaryType}' must match the EIP-712 encoder root '${encoder.primaryType}'.`,
    );
  }
  // ethers coerces bool values with truthiness (including missing nested
  // fields). Validate presence and actual booleans throughout structs/arrays
  // so the signature commits to what the caller explicitly supplied.
  function validateValue(type: string, value: unknown, path: string): void {
    const array = /^(.*)\[([0-9]*)\]$/.exec(type);
    if (array) {
      if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
      for (let index = 0; index < value.length; index++) {
        validateValue(array[1], value[index], `${path}[${index}]`);
      }
    } else if (Object.hasOwn(action.types, type)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${path} must be an object for ${type}.`);
      }
      for (const field of action.types[type]) {
        const fieldPath = `${path}.${field.name}`;
        if (!Object.hasOwn(value, field.name)) throw new Error(`${fieldPath} is required.`);
        validateValue(field.type, (value as Record<string, unknown>)[field.name], fieldPath);
      }
    } else if (type === 'bool' && typeof value !== 'boolean') {
      throw new Error(`${path} must be a boolean.`);
    }
  }
  validateValue(action.primaryType, action.message, 'action.message');

  return {
    domainSeparator: ethers.TypedDataEncoder.hashDomain(action.domain),
    actionHash: encoder.hash(action.message),
  };
}
