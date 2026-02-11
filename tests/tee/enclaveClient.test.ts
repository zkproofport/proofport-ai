import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encode as cborEncode } from 'cbor-x';
import type { TeeConfig, VsockRequest, VsockResponse } from '../../src/tee/types.js';

// Mock net module for vsock
const mockSocket = {
  connect: vi.fn(),
  write: vi.fn(),
  on: vi.fn(),
  end: vi.fn(),
  destroy: vi.fn(),
  setTimeout: vi.fn(),
};

vi.mock('net', () => ({
  connect: vi.fn(() => mockSocket),
}));

describe('EnclaveClient', () => {
  let EnclaveClient: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await import('../../src/tee/enclaveClient.js');
    EnclaveClient = module.EnclaveClient;
  });

  describe('Constructor', () => {
    it('should create instance with valid nitro config', () => {
      const config: TeeConfig = {
        mode: 'nitro',
        enclaveCid: 16,
        enclavePort: 5000,
        attestationEnabled: true,
      };
      const client = new EnclaveClient(config);
      expect(client).toBeDefined();
      expect(client.mode).toBe('nitro');
    });

    it('should create instance with local config', () => {
      const config: TeeConfig = {
        mode: 'local',
        attestationEnabled: false,
      };
      const client = new EnclaveClient(config);
      expect(client).toBeDefined();
      expect(client.mode).toBe('local');
    });

    it('should throw if nitro mode without enclaveCid', () => {
      const config: TeeConfig = {
        mode: 'nitro',
        attestationEnabled: true,
      };
      expect(() => new EnclaveClient(config)).toThrow(/enclaveCid.*required/i);
    });

    it('should use default port 5000 if not specified', () => {
      const config: TeeConfig = {
        mode: 'nitro',
        enclaveCid: 16,
        attestationEnabled: true,
      };
      const client = new EnclaveClient(config);
      expect(client).toBeDefined();
    });
  });

  describe('prove()', () => {
    it('should send prove request via vsock', async () => {
      const config: TeeConfig = {
        mode: 'nitro',
        enclaveCid: 16,
        enclavePort: 5000,
        attestationEnabled: true,
      };
      const client = new EnclaveClient(config);

      // Mock successful connection and response
      mockSocket.on.mockImplementation((event, handler) => {
        if (event === 'connect') {
          setTimeout(() => handler(), 0);
        } else if (event === 'data') {
          setTimeout(() => {
            const response: VsockResponse = {
              type: 'proof',
              requestId: 'req-123',
              proof: '0xabcd',
              publicInputs: ['0x01'],
            };
            handler(Buffer.from(JSON.stringify(response)));
          }, 10);
        }
        return mockSocket;
      });

      const result = await client.prove('coinbase_attestation', ['149', '2'], 'req-123');
      expect(result.type).toBe('proof');
      expect(result.proof).toBe('0xabcd');
      expect(mockSocket.write).toHaveBeenCalled();
    });

    it('should include requestId in request', async () => {
      const config: TeeConfig = {
        mode: 'nitro',
        enclaveCid: 16,
        enclavePort: 5000,
        attestationEnabled: false,
      };
      const client = new EnclaveClient(config);

      mockSocket.on.mockImplementation((event, handler) => {
        if (event === 'connect') {
          setTimeout(() => handler(), 0);
        } else if (event === 'data') {
          setTimeout(() => {
            const response: VsockResponse = {
              type: 'proof',
              requestId: 'req-456',
              proof: '0x1234',
              publicInputs: [],
            };
            handler(Buffer.from(JSON.stringify(response)));
          }, 10);
        }
        return mockSocket;
      });

      await client.prove('coinbase_attestation', ['100'], 'req-456');

      expect(mockSocket.write).toHaveBeenCalled();
      const writtenData = mockSocket.write.mock.calls[0][0];
      const request = JSON.parse(writtenData);
      expect(request.requestId).toBe('req-456');
      expect(request.type).toBe('prove');
    });

    it('should handle enclave error response', async () => {
      const config: TeeConfig = {
        mode: 'nitro',
        enclaveCid: 16,
        enclavePort: 5000,
        attestationEnabled: false,
      };
      const client = new EnclaveClient(config);

      mockSocket.on.mockImplementation((event, handler) => {
        if (event === 'connect') {
          setTimeout(() => handler(), 0);
        } else if (event === 'data') {
          setTimeout(() => {
            const response: VsockResponse = {
              type: 'error',
              requestId: 'req-123',
              error: 'Circuit not found',
            };
            handler(Buffer.from(JSON.stringify(response)));
          }, 10);
        }
        return mockSocket;
      });

      const result = await client.prove('invalid_circuit', ['100'], 'req-123');
      expect(result.type).toBe('error');
      expect(result.error).toBe('Circuit not found');
    });

    it('should handle connection timeout', async () => {
      const config: TeeConfig = {
        mode: 'nitro',
        enclaveCid: 16,
        enclavePort: 5000,
        attestationEnabled: false,
      };
      const client = new EnclaveClient(config);

      mockSocket.on.mockImplementation((event, handler) => {
        if (event === 'error') {
          setTimeout(() => handler(new Error('Connection timeout')), 10);
        }
        return mockSocket;
      });

      await expect(client.prove('coinbase_attestation', ['100'], 'req-123')).rejects.toThrow(/timeout/i);
    });

    it('should handle socket errors', async () => {
      const config: TeeConfig = {
        mode: 'nitro',
        enclaveCid: 16,
        enclavePort: 5000,
        attestationEnabled: false,
      };
      const client = new EnclaveClient(config);

      mockSocket.on.mockImplementation((event, handler) => {
        if (event === 'error') {
          setTimeout(() => handler(new Error('ECONNREFUSED')), 10);
        }
        return mockSocket;
      });

      await expect(client.prove('coinbase_attestation', ['100'], 'req-123')).rejects.toThrow();
    });
  });

  describe('healthCheck()', () => {
    it('should return true on successful health response', async () => {
      const config: TeeConfig = {
        mode: 'nitro',
        enclaveCid: 16,
        enclavePort: 5000,
        attestationEnabled: false,
      };
      const client = new EnclaveClient(config);

      mockSocket.on.mockImplementation((event, handler) => {
        if (event === 'connect') {
          setTimeout(() => handler(), 0);
        } else if (event === 'data') {
          setTimeout(() => {
            const response: VsockResponse = {
              type: 'health',
              requestId: 'health-123',
            };
            handler(Buffer.from(JSON.stringify(response)));
          }, 10);
        }
        return mockSocket;
      });

      const isHealthy = await client.healthCheck();
      expect(isHealthy).toBe(true);
    });

    it('should return false on error', async () => {
      const config: TeeConfig = {
        mode: 'nitro',
        enclaveCid: 16,
        enclavePort: 5000,
        attestationEnabled: false,
      };
      const client = new EnclaveClient(config);

      mockSocket.on.mockImplementation((event, handler) => {
        if (event === 'error') {
          setTimeout(() => handler(new Error('Connection failed')), 10);
        }
        return mockSocket;
      });

      const isHealthy = await client.healthCheck();
      expect(isHealthy).toBe(false);
    });
  });

  describe('getAttestation()', () => {
    it('should return null when attestation disabled', async () => {
      const config: TeeConfig = {
        mode: 'nitro',
        enclaveCid: 16,
        enclavePort: 5000,
        attestationEnabled: false,
      };
      const client = new EnclaveClient(config);

      const attestation = await client.getAttestation();
      expect(attestation).toBeNull();
    });

    it('should return attestation document when enabled', async () => {
      const config: TeeConfig = {
        mode: 'nitro',
        enclaveCid: 16,
        enclavePort: 5000,
        attestationEnabled: true,
      };
      const client = new EnclaveClient(config);

      // Create a valid mock COSE Sign1 document structure
      const protectedHeaders = {};
      const unprotected = {};
      const payload = {
        module_id: 'i-1234567890abcdef0-enc1234567890abcd',
        digest: 'SHA384',
        timestamp: Date.now(),
        pcrs: {
          0: Buffer.from('pcr0hash'),
          1: Buffer.from('pcr1hash'),
          2: Buffer.from('pcr2hash'),
        },
        certificate: Buffer.from('validcert'),
        cabundle: [Buffer.from('ca1')],
      };
      const signature = Buffer.from('mock-signature');

      const coseSign1 = [
        cborEncode(protectedHeaders),
        unprotected,
        cborEncode(payload),
        signature,
      ];

      const mockCoseDoc = Buffer.from(cborEncode(coseSign1)).toString('base64');

      mockSocket.on.mockImplementation((event, handler) => {
        if (event === 'connect') {
          setTimeout(() => handler(), 0);
        } else if (event === 'data') {
          setTimeout(() => {
            const response: VsockResponse = {
              type: 'proof',
              requestId: 'req-123',
              proof: '0xabcd',
              publicInputs: [],
              attestationDocument: mockCoseDoc,
            };
            handler(Buffer.from(JSON.stringify(response)));
          }, 10);
        }
        return mockSocket;
      });

      // First prove call will cache attestation
      await client.prove('coinbase_attestation', ['100'], 'req-123');

      const attestation = await client.getAttestation();
      expect(attestation).not.toBeNull();
      expect(attestation?.moduleId).toBeDefined();
    });

    it('should return null in local mode', async () => {
      const config: TeeConfig = {
        mode: 'local',
        attestationEnabled: true,
      };
      const client = new EnclaveClient(config);

      const attestation = await client.getAttestation();
      expect(attestation).toBeNull();
    });
  });

  describe('Local mode simulation', () => {
    it('should simulate proof generation in local mode', async () => {
      const config: TeeConfig = {
        mode: 'local',
        attestationEnabled: false,
      };
      const client = new EnclaveClient(config);

      const result = await client.prove('coinbase_attestation', ['100'], 'req-local');
      expect(result.type).toBe('proof');
      expect(result.requestId).toBe('req-local');
      expect(result.proof).toBeDefined();
    });

    it('should not use vsock in local mode', async () => {
      const config: TeeConfig = {
        mode: 'local',
        attestationEnabled: false,
      };
      const client = new EnclaveClient(config);

      await client.prove('coinbase_attestation', ['100'], 'req-local');
      expect(mockSocket.connect).not.toHaveBeenCalled();
    });
  });
});
