import { describe, expect, it } from 'vitest';
import { freezeAction, actionFields, walletPayload, expirationTime } from '../src/model';
export const action = () => ({
    domain: { name: 'Example request', version: '1', chainId: 91337, verifyingContract: `0x${'1'.repeat(40)}` },
    primaryType: 'ArbitraryAction',
    types: {
        ArbitraryAction: [{ name: 'note', type: 'string' }, { name: 'count', type: 'uint256' }, { name: 'enabled', type: 'bool' }, { name: 'items', type: 'Item[]' }],
        Item: [{ name: 'value', type: 'uint256' }],
    },
    message: { note: '<img src=x onerror=alert(1)> 한글', count: '0', enabled: false, items: [{ value: '9007199254740993123456789' }] },
});
describe('review model', () => {
    it('keeps declared field order, nesting, zero, false, and precise integers', () => {
        const fields = actionFields(freezeAction(action()));
        expect(fields.map(f => f.name)).toEqual(['note', 'count', 'enabled', 'items']);
        expect(fields[0].value).toBe('<img src=x onerror=alert(1)> 한글');
        expect(fields[1].value).toBe('0');
        expect(fields[2].value).toBe('false');
        expect(fields[3].children?.[0].children?.[0].value).toBe('9007199254740993123456789');
    });
    it('freezes an independent exact snapshot and derives domain schema without changing chainId', () => {
        const input = action();
        const frozen = freezeAction(input);
        input.message.note = 'mutated';
        expect(frozen.message.note).toContain('<img');
        expect(Object.isFrozen(frozen.message)).toBe(true);
        const payload = JSON.parse(walletPayload(frozen));
        expect(payload.domain.chainId).toBe(91337);
        expect(payload.message).toEqual(frozen.message);
        expect(payload.types.EIP712Domain.map((f: {
            name: string;
        }) => f.name)).toEqual(['name', 'version', 'chainId', 'verifyingContract']);
    });
    it('renders bigint values exactly without rounding', () => {
        const input = action() as any;
        input.message.count = 123456789012345678901234567890n;
        const frozen = freezeAction(input);
        expect(actionFields(frozen)[1].value).toBe('123456789012345678901234567890');
        expect(JSON.parse(walletPayload(frozen)).message.count).toBe('123456789012345678901234567890');
    });
    it.each([undefined, null, '8453', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid or missing domain chain %s', chainId => {
        const input = action() as any;
        input.domain.chainId = chainId;
        expect(() => freezeAction(input)).toThrow(/chain/i);
    });
    it('rejects missing, extra, unsafe-number and unsupported typed values', () => {
        for (const edit of [(a: any) => delete a.message.note, (a: any) => a.message.hidden = 'not reviewed', (a: any) => a.message.count = Number.MAX_SAFE_INTEGER + 1, (a: any) => a.types.ArbitraryAction[0].type = 'mystery']) {
            const a = action();
            edit(a);
            expect(() => freezeAction(a)).toThrow();
        }
    });
    it('limits input length and validates expiry without extending it', () => {
        const a = action();
        a.message.note = 'x'.repeat(17000);
        expect(() => freezeAction(a)).toThrow();
        expect(expirationTime('2026-09-23T08:00:00.000Z')).toBe(Date.parse('2026-09-23T08:00:00Z'));
        expect(expirationTime('invalid')).toBe(0);
    });
});
