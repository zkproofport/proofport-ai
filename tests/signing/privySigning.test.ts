import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrivySigningProvider } from '../../src/signing/privySigning';
import type { SigningRequest } from '../../src/signing/types';

describe('PrivySigningProvider', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = mockFetch;
  });

  const config = {
    appId: 'test-app-id',
    apiSecret: 'test-api-secret',
    apiUrl: 'https://auth.privy.io',
  };

  describe('constructor', () => {
    it('sets method to privy', () => {
      const provider = new PrivySigningProvider(config);
      expect(provider.method).toBe('privy');
    });

    it('uses default apiUrl when not provided', () => {
      const provider = new PrivySigningProvider({
        appId: config.appId,
        apiSecret: config.apiSecret,
      });
      expect(provider.method).toBe('privy');
    });
  });

  describe('sign', () => {
    const walletId = '0x1234567890123456789012345678901234567890';
    const signRequest: SigningRequest = {
      address: walletId,
      signalHash: '0xabcdef',
      scope: 'test-scope',
      method: 'privy',
    };

    it('calls Privy API with correct URL and headers', async () => {
      const expectedSignature = '0xsignature';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            signature: expectedSignature,
            address: walletId,
          },
        }),
      });

      const provider = new PrivySigningProvider(config);
      await provider.sign(signRequest);

      expect(mockFetch).toHaveBeenCalledWith(
        `${config.apiUrl}/api/v1/wallets/${walletId}/rpc`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': `Basic ${Buffer.from(`${config.appId}:${config.apiSecret}`).toString('base64')}`,
            'privy-app-id': config.appId,
            'Content-Type': 'application/json',
          }),
        })
      );
    });

    it('sends correct JSON-RPC body with personal_sign', async () => {
      const expectedSignature = '0xsignature';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            signature: expectedSignature,
            address: walletId,
          },
        }),
      });

      const provider = new PrivySigningProvider(config);
      await provider.sign(signRequest);

      const callArgs = mockFetch.mock.calls[0][1];
      const body = JSON.parse(callArgs.body);

      expect(body).toEqual({
        method: 'personal_sign',
        params: {
          message: signRequest.signalHash,
        },
      });
    });

    it('returns valid SigningResult on success', async () => {
      const expectedSignature = '0xsignature';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            signature: expectedSignature,
            address: walletId,
          },
        }),
      });

      const provider = new PrivySigningProvider(config);
      const result = await provider.sign(signRequest);

      expect(result).toEqual({
        signature: expectedSignature,
        address: walletId,
        method: 'privy',
      });
    });

    it('throws if returned address does not match request address', async () => {
      const wrongAddress = '0x9999999999999999999999999999999999999999';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            signature: '0xsignature',
            address: wrongAddress,
          },
        }),
      });

      const provider = new PrivySigningProvider(config);

      await expect(
        provider.sign(signRequest)
      ).rejects.toThrow('Address mismatch');
    });

    it('throws if Privy API returns error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({
          error: 'Invalid wallet',
        }),
      });

      const provider = new PrivySigningProvider(config);

      await expect(
        provider.sign(signRequest)
      ).rejects.toThrow('Privy API error');
    });

    it('throws if fetch fails with network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const provider = new PrivySigningProvider(config);

      await expect(
        provider.sign(signRequest)
      ).rejects.toThrow('Network error');
    });
  });

  describe('isAvailable', () => {
    const testAddress = '0x1234567890123456789012345678901234567890';

    it('returns true when user has embedded wallet with delegated actions', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{
            id: 'user-123',
            linked_accounts: [{
              type: 'wallet',
              wallet_client: 'privy',
              delegated: true,
              address: testAddress,
            }],
          }],
        }),
      });

      const provider = new PrivySigningProvider(config);
      const result = await provider.isAvailable(testAddress);

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        `${config.apiUrl}/api/v1/users?wallet_address=${testAddress}`,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Authorization': `Basic ${Buffer.from(`${config.appId}:${config.apiSecret}`).toString('base64')}`,
            'privy-app-id': config.appId,
          }),
        })
      );
    });

    it('returns false when user not found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [],
        }),
      });

      const provider = new PrivySigningProvider(config);
      const result = await provider.isAvailable(testAddress);

      expect(result).toBe(false);
    });

    it('returns false when user has no embedded wallet', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{
            id: 'user-123',
            linked_accounts: [{
              type: 'wallet',
              wallet_client: 'metamask',
              address: testAddress,
            }],
          }],
        }),
      });

      const provider = new PrivySigningProvider(config);
      const result = await provider.isAvailable(testAddress);

      expect(result).toBe(false);
    });

    it('returns false when fetch fails', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const provider = new PrivySigningProvider(config);
      const result = await provider.isAvailable(testAddress);

      expect(result).toBe(false);
    });
  });
});
