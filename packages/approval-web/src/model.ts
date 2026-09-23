export interface TypedAction {
    domain: {
        name: string;
        version: string;
        chainId: number;
        verifyingContract: string;
    };
    primaryType: string;
    types: Record<string, Array<{
        name: string;
        type: string;
    }>>;
    message: Record<string, unknown>;
}
export interface FieldNode {
    name: string;
    type: string;
    value?: string;
    children?: FieldNode[];
}
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'consumed' | 'expired';
export interface ApprovalSession {
    approvalId: string;
    status: ApprovalStatus;
    expiresAt: string;
    circuit: string;
    scope: string;
    action: TypedAction;
    expectedSigner?: string;
    address?: string;
}
const domainFields = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];
const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
export function validAddress(value: unknown): value is string { return typeof value === 'string' && addressPattern.test(value); }
function requireThat(condition: unknown, message: string): asserts condition { if (!condition)
    throw new Error(message); }
export function freezeAction(input: unknown): TypedAction {
    requireThat(record(input) && record(input.domain) && record(input.types) && record(input.message), 'The typed action is incomplete.');
    const domain = input.domain;
    requireThat(typeof domain.chainId === 'number' && Number.isSafeInteger(domain.chainId) && domain.chainId > 0, 'A valid numeric domain chain ID is required.');
    requireThat(typeof domain.name === 'string' && typeof domain.version === 'string' && validAddress(domain.verifyingContract), 'The signing domain is incomplete.');
    requireThat(Object.keys(domain).every(key => domainFields.some(field => field.name === key)), 'The signing domain contains unsupported fields.');
    requireThat(typeof input.primaryType === 'string' && identifier.test(input.primaryType) && input.primaryType !== 'EIP712Domain' && own(input.types, input.primaryType), 'The action type is missing.');
    requireThat(Object.keys(input).every(key => ['domain', 'types', 'primaryType', 'message'].includes(key)), 'The typed action contains unsupported fields.');
    const schemas = Object.entries(input.types);
    requireThat(schemas.length > 0 && schemas.length <= 64, 'The typed action has too many types.');
    let fieldCount = 0;
    for (const [name, fields] of schemas) {
        requireThat(identifier.test(name) && !['__proto__', 'constructor', 'prototype'].includes(name) && Array.isArray(fields), 'The action schema is invalid.');
        const seen = new Set();
        for (const field of fields) {
            requireThat(record(field) && typeof field.name === 'string' && identifier.test(field.name) && !['__proto__', 'constructor', 'prototype'].includes(field.name) && !seen.has(field.name) && typeof field.type === 'string' && field.type.length < 128 && Object.keys(field).every(k => k === 'name' || k === 'type'), 'The action schema is invalid.');
            seen.add(field.name);
            requireThat(++fieldCount <= 256, 'The action has too many fields.');
        }
    }
    if (own(input.types, 'EIP712Domain'))
        requireThat(JSON.stringify(input.types.EIP712Domain) === JSON.stringify(domainFields), 'The domain schema does not match the signing domain.');
    let nodes = 0;
    function clone(value: unknown, depth = 0): unknown {
        requireThat(++nodes <= 4096 && depth <= 20, 'The action is too large or deeply nested.');
        if (typeof value === 'string')
            requireThat(value.length <= 16384, 'An action value is too long.');
        if (typeof value === 'number')
            requireThat(Number.isSafeInteger(value), 'An action number loses precision.');
        if (Array.isArray(value))
            return Object.freeze(value.map(v => clone(v, depth + 1)));
        if (record(value))
            return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v, depth + 1)])));
        requireThat(['string', 'number', 'boolean', 'bigint'].includes(typeof value), 'The action has an unsupported value.');
        return value;
    }
    const action = clone(input) as TypedAction;
    actionFields(action);
    return action;
}
export function actionFields(action: TypedAction): FieldNode[] {
    let nodes = 0;
    function walk(name: string, type: string, value: unknown, depth: number): FieldNode {
        requireThat(++nodes <= 4096 && depth <= 20, 'The action is too large or deeply nested.');
        const array = /^(.*)\[(\d*)\]$/.exec(type);
        if (array) {
            requireThat(Array.isArray(value) && (!array[2] || value.length === Number(array[2])), 'An action array is invalid.');
            return { name, type, children: value.map((v, i) => walk(`[${i}]`, array[1], v, depth + 1)) };
        }
        if (own(action.types, type)) {
            requireThat(record(value), 'A nested action field is invalid.');
            const schema = action.types[type];
            requireThat(Object.keys(value).length === schema.length && schema.every(f => own(value, f.name)), 'Action fields do not match their schema.');
            return { name, type, children: schema.map(field => walk(field.name, field.type, value[field.name], depth + 1)) };
        }
        if (type === 'string')
            requireThat(typeof value === 'string', 'An action string is invalid.');
        else if (type === 'bool')
            requireThat(typeof value === 'boolean', 'An action boolean is invalid.');
        else if (type === 'address')
            requireThat(validAddress(value), 'An action address is invalid.');
        else if (/^(u?int)(\d+)$/.test(type)) {
            const [, sign, bitsString] = /^(u?int)(\d+)$/.exec(type)!;
            const bits = Number(bitsString);
            requireThat(bits >= 8 && bits <= 256 && bits % 8 === 0 && ['string', 'number', 'bigint'].includes(typeof value) && /^-?\d+$/.test(String(value)), 'An action integer is invalid.');
            requireThat(typeof value !== 'number' || Number.isSafeInteger(value), 'An action number loses precision.');
            const n = BigInt(String(value));
            const unsigned = sign === 'uint';
            requireThat(n >= (unsigned ? 0n : -(1n << BigInt(bits - 1))) && n < (1n << BigInt(unsigned ? bits : bits - 1)), 'An action integer is out of range.');
        }
        else if (/^bytes(\d*)$/.test(type)) {
            const size = type.slice(5);
            requireThat(typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value) && (!size || (Number(size) >= 1 && Number(size) <= 32 && value.length === 2 + Number(size) * 2)), 'An action byte field is invalid.');
        }
        else
            throw new Error('The action contains an unsupported field type.');
        return { name, type, value: value === '' ? '(empty string)' : String(value) };
    }
    return walk(action.primaryType, action.primaryType, action.message, 0).children!;
}
export function walletPayload(action: TypedAction): string {
    return JSON.stringify({ ...action, types: { ...action.types, EIP712Domain: domainFields } }, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
}
export function expirationTime(value: unknown): number {
    return typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) || 0 : 0;
}
