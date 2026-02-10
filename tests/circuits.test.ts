import { describe, it, expect } from 'vitest';
import { CIRCUITS, type CircuitId } from '../src/config/circuits.js';

describe('Circuits Configuration', () => {
  describe('CIRCUITS registry', () => {
    it('should contain coinbase_attestation circuit', () => {
      expect(CIRCUITS.coinbase_attestation).toBeDefined();
      expect(CIRCUITS.coinbase_attestation.id).toBe('coinbase_attestation');
      expect(CIRCUITS.coinbase_attestation.displayName).toBe('Coinbase KYC');
    });

    it('should contain coinbase_country_attestation circuit', () => {
      expect(CIRCUITS.coinbase_country_attestation).toBeDefined();
      expect(CIRCUITS.coinbase_country_attestation.id).toBe('coinbase_country_attestation');
      expect(CIRCUITS.coinbase_country_attestation.displayName).toBe('Coinbase Country');
    });

    it('should have required inputs for coinbase_attestation', () => {
      const circuit = CIRCUITS.coinbase_attestation;
      expect(circuit.requiredInputs).toContain('address');
      expect(circuit.requiredInputs).toContain('signature');
      expect(circuit.requiredInputs).toContain('scope');
      expect(circuit.requiredInputs).toHaveLength(3);
    });

    it('should have required inputs for coinbase_country_attestation', () => {
      const circuit = CIRCUITS.coinbase_country_attestation;
      expect(circuit.requiredInputs).toContain('address');
      expect(circuit.requiredInputs).toContain('signature');
      expect(circuit.requiredInputs).toContain('scope');
      expect(circuit.requiredInputs).toContain('countryList');
      expect(circuit.requiredInputs).toContain('isIncluded');
      expect(circuit.requiredInputs).toHaveLength(5);
    });

    it('should have EAS schema IDs', () => {
      expect(CIRCUITS.coinbase_attestation.easSchemaId).toBe('0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9');
      expect(CIRCUITS.coinbase_country_attestation.easSchemaId).toBe('0x1801901fabd0e6189356b4fb52bb0ab855276d84f7ec140839fbd1f6801ca065');
    });

    it('should have function selectors', () => {
      expect(CIRCUITS.coinbase_attestation.functionSelector).toBe('0x56feed5e');
      expect(CIRCUITS.coinbase_country_attestation.functionSelector).toBe('0x0a225248');
    });
  });

  describe('CircuitId type', () => {
    it('should accept valid circuit IDs', () => {
      const id1: CircuitId = 'coinbase_attestation';
      const id2: CircuitId = 'coinbase_country_attestation';

      expect(id1).toBe('coinbase_attestation');
      expect(id2).toBe('coinbase_country_attestation');
    });

    it('should allow accessing circuits via CircuitId', () => {
      const circuitId: CircuitId = 'coinbase_attestation';
      const circuit = CIRCUITS[circuitId];

      expect(circuit.id).toBe('coinbase_attestation');
    });
  });
});
