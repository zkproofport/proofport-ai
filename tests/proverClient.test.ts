import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('ProverClient', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('prove', () => {
    it('should send POST request to /prove with correct payload', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          proof: '0xabcdef',
          publicInputs: '0x123456',
          proofWithInputs: '0x123456abcdef',
        }),
      });

      global.fetch = mockFetch;

      const proverClient = {
        async prove(circuitId: string, inputs: string[]) {
          const response = await fetch('http://prover:4003/prove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ circuitId, inputs, onChain: true }),
          });
          return response.json();
        },
      };

      const result = await proverClient.prove('coinbase_attestation', ['149', '2', '100']);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://prover:4003/prove',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            circuitId: 'coinbase_attestation',
            inputs: ['149', '2', '100'],
            onChain: true,
          }),
        })
      );

      expect(result.proof).toBe('0xabcdef');
      expect(result.publicInputs).toBe('0x123456');
    });

    it('should throw on network error', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
      global.fetch = mockFetch;

      const proverClient = {
        async prove(circuitId: string, inputs: string[]) {
          const response = await fetch('http://prover:4003/prove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ circuitId, inputs, onChain: true }),
          });
          return response.json();
        },
      };

      await expect(
        proverClient.prove('coinbase_attestation', ['149', '2', '100'])
      ).rejects.toThrow('Network error');
    });

    it('should throw on HTTP error response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      global.fetch = mockFetch;

      const proverClient = {
        async prove(circuitId: string, inputs: string[]) {
          const response = await fetch('http://prover:4003/prove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ circuitId, inputs, onChain: true }),
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          return response.json();
        },
      };

      await expect(
        proverClient.prove('coinbase_attestation', ['149', '2', '100'])
      ).rejects.toThrow('HTTP 500: Internal Server Error');
    });
  });

  describe('verify', () => {
    it('should send POST request to /verify with correct payload', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ isValid: true }),
      });

      global.fetch = mockFetch;

      const proverClient = {
        async verify(circuitId: string, proof: number[]) {
          const response = await fetch('http://prover:4003/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ circuitId, proof, onChain: true }),
          });
          return response.json();
        },
      };

      const result = await proverClient.verify('coinbase_attestation', [1, 2, 3]);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://prover:4003/verify',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            circuitId: 'coinbase_attestation',
            proof: [1, 2, 3],
            onChain: true,
          }),
        })
      );

      expect(result.isValid).toBe(true);
    });
  });

  describe('getCircuits', () => {
    it('should send GET request to /circuits', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          circuits: ['coinbase_attestation', 'coinbase_country_attestation'],
        }),
      });

      global.fetch = mockFetch;

      const proverClient = {
        async getCircuits() {
          const response = await fetch('http://prover:4003/circuits');
          return response.json();
        },
      };

      const result = await proverClient.getCircuits();

      expect(mockFetch).toHaveBeenCalledWith('http://prover:4003/circuits');
      expect(result.circuits).toHaveLength(2);
    });
  });

  describe('health', () => {
    it('should send GET request to /health', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'healthy' }),
      });

      global.fetch = mockFetch;

      const proverClient = {
        async health() {
          const response = await fetch('http://prover:4003/health');
          return response.json();
        },
      };

      const result = await proverClient.health();

      expect(mockFetch).toHaveBeenCalledWith('http://prover:4003/health');
      expect(result.status).toBe('healthy');
    });
  });
});
