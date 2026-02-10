import { describe, it, expect } from 'vitest';
import {
  COINBASE_ATTESTER_CONTRACT,
  AUTHORIZED_SIGNERS,
  VERIFIER_ADDRESSES,
  ERC8004_ADDRESSES
} from '../src/config/contracts.js';

describe('Contract Addresses', () => {
  describe('COINBASE_ATTESTER_CONTRACT', () => {
    it('should be a valid checksummed Ethereum address', () => {
      expect(COINBASE_ATTESTER_CONTRACT).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(COINBASE_ATTESTER_CONTRACT).toBe('0x357458739F90461b99789350868CD7CF330Dd7EE');
    });
  });

  describe('AUTHORIZED_SIGNERS', () => {
    it('should contain 4 authorized signers', () => {
      expect(AUTHORIZED_SIGNERS).toHaveLength(4);
    });

    it('should all be valid checksummed Ethereum addresses', () => {
      AUTHORIZED_SIGNERS.forEach(signer => {
        expect(signer).toMatch(/^0x[a-fA-F0-9]{40}$/);
      });
    });

    it('should contain expected signer addresses', () => {
      expect(AUTHORIZED_SIGNERS).toContain('0x952f32128AF084422539C4Ff96df5C525322E564');
      expect(AUTHORIZED_SIGNERS).toContain('0x8844591D47F17bcA6F5dF8f6B64F4a739F1C0080');
      expect(AUTHORIZED_SIGNERS).toContain('0x88fe64ea2e121f49bb77abea6c0a45e93638c3c5');
      expect(AUTHORIZED_SIGNERS).toContain('0x44ace9abb148e8412ac4492e9a1ae6bd88226803');
    });
  });

  describe('VERIFIER_ADDRESSES', () => {
    it('should contain Base Sepolia (84532) verifiers', () => {
      expect(VERIFIER_ADDRESSES['84532']).toBeDefined();
      expect(VERIFIER_ADDRESSES['84532'].coinbase_attestation).toBe('0x0036B61dBFaB8f3CfEEF77dD5D45F7EFBFE2035c');
      expect(VERIFIER_ADDRESSES['84532'].coinbase_country_attestation).toBe('0xdEe363585926c3c28327Efd1eDd01cf4559738cf');
    });

    it('should have valid checksummed addresses for verifiers', () => {
      Object.values(VERIFIER_ADDRESSES).forEach(chainVerifiers => {
        Object.values(chainVerifiers).forEach(address => {
          expect(address).toMatch(/^0x[a-fA-F0-9]{40}$/);
        });
      });
    });
  });

  describe('ERC8004_ADDRESSES', () => {
    it('should contain mainnet addresses', () => {
      expect(ERC8004_ADDRESSES.mainnet).toBeDefined();
      expect(ERC8004_ADDRESSES.mainnet.identity).toBe('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432');
      expect(ERC8004_ADDRESSES.mainnet.reputation).toBe('0x8004BAa17C55a88189AE136b182e5fdA19dE9b63');
    });

    it('should contain sepolia addresses', () => {
      expect(ERC8004_ADDRESSES.sepolia).toBeDefined();
      expect(ERC8004_ADDRESSES.sepolia.identity).toBe('0x8004A818BFB912233c491871b3d84c89A494BD9e');
      expect(ERC8004_ADDRESSES.sepolia.reputation).toBe('0x8004B663056A597Dffe9eCcC1965A193B7388713');
    });

    it('should have valid checksummed addresses for ERC8004', () => {
      Object.values(ERC8004_ADDRESSES).forEach(network => {
        expect(network.identity).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(network.reputation).toMatch(/^0x[a-fA-F0-9]{40}$/);
      });
    });
  });
});
