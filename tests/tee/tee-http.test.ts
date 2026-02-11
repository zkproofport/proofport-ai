/**
 * TEE HTTP Endpoint Tests
 * Tests the /tee/status endpoint without importing the full server
 */

import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { getTeeConfig, createTeeProvider } from '../../src/tee/index.js';

describe('TEE HTTP Endpoint', () => {
  let app: express.Express;

  beforeAll(() => {
    // Create minimal Express app with just the TEE status endpoint
    app = express();
    app.use(express.json());

    const teeConfig = getTeeConfig();
    const teeProvider = createTeeProvider(teeConfig);

    app.get('/tee/status', (_req, res) => {
      res.json({
        mode: teeConfig.mode,
        attestationEnabled: teeConfig.attestationEnabled,
        available: teeConfig.mode !== 'disabled',
      });
    });
  });

  describe('GET /tee/status', () => {
    it('should return TEE status', async () => {
      const response = await request(app).get('/tee/status');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('mode');
      expect(response.body).toHaveProperty('attestationEnabled');
      expect(response.body).toHaveProperty('available');
    });

    it('should return disabled mode by default', async () => {
      const response = await request(app).get('/tee/status');

      expect(response.status).toBe(200);
      expect(response.body.mode).toBe('disabled');
      expect(response.body.available).toBe(false);
    });

    it('should return attestationEnabled field as boolean', async () => {
      const response = await request(app).get('/tee/status');

      expect(response.status).toBe(200);
      expect(typeof response.body.attestationEnabled).toBe('boolean');
    });

    it('should return JSON response', async () => {
      const response = await request(app).get('/tee/status');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/json/);
    });

    it('should have all required fields', async () => {
      const response = await request(app).get('/tee/status');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('mode');
      expect(response.body).toHaveProperty('attestationEnabled');
      expect(response.body).toHaveProperty('available');
    });

    it('should validate mode is one of valid values', async () => {
      const response = await request(app).get('/tee/status');

      expect(response.status).toBe(200);
      expect(['disabled', 'local', 'nitro']).toContain(response.body.mode);
    });
  });

  describe('TEE mode variations', () => {
    it('should reflect TEE_MODE from environment', async () => {
      const originalMode = process.env.TEE_MODE;
      process.env.TEE_MODE = 'local';

      const config2 = getTeeConfig();

      const testApp = express();
      testApp.get('/tee/status', (_req, res) => {
        res.json({
          mode: config2.mode,
          attestationEnabled: config2.attestationEnabled,
          available: config2.mode !== 'disabled',
        });
      });

      const response = await request(testApp).get('/tee/status');

      expect(response.status).toBe(200);
      expect(response.body.mode).toBe('local');
      expect(response.body.available).toBe(true);

      process.env.TEE_MODE = originalMode;
    });
  });
});
