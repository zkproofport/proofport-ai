/**
 * TEE HTTP Endpoint Tests
 * Tests the /tee/status endpoint without importing the full server
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { type Server } from 'http';
import request from 'supertest';
import { getTeeConfig, createTeeProvider } from '../../src/tee/index.js';

describe('TEE HTTP Endpoint', () => {
  // One listening server for the file. Handing supertest a bare Express app
  // makes it create, listen(0) and close an ephemeral server per request, and
  // that churn is what intermittently produced `socket hang up` in this suite.
  let server: Server;
  let app: express.Express;

  beforeAll(async () => {
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

    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('GET /tee/status', () => {
    it('should return TEE status', async () => {
      const response = await request(server).get('/tee/status');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('mode');
      expect(response.body).toHaveProperty('attestationEnabled');
      expect(response.body).toHaveProperty('available');
    });

    it('should return disabled mode by default', async () => {
      const response = await request(server).get('/tee/status');

      expect(response.status).toBe(200);
      expect(response.body.mode).toBe('disabled');
      expect(response.body.available).toBe(false);
    });

    it('should return attestationEnabled field as boolean', async () => {
      const response = await request(server).get('/tee/status');

      expect(response.status).toBe(200);
      expect(typeof response.body.attestationEnabled).toBe('boolean');
    });

    it('should return JSON response', async () => {
      const response = await request(server).get('/tee/status');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/json/);
    });

    it('should have all required fields', async () => {
      const response = await request(server).get('/tee/status');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('mode');
      expect(response.body).toHaveProperty('attestationEnabled');
      expect(response.body).toHaveProperty('available');
    });

    it('should validate mode is one of valid values', async () => {
      const response = await request(server).get('/tee/status');

      expect(response.status).toBe(200);
      expect(['disabled', 'local', 'nitro']).toContain(response.body.mode);
    });
  });

  describe('TEE mode variations', () => {
    it('should reflect TEE_MODE from environment', () => {
      const originalMode = process.env.TEE_MODE;
      process.env.TEE_MODE = 'local';

      const config2 = getTeeConfig();

      expect(config2.mode).toBe('local');

      // Restore
      if (originalMode !== undefined) {
        process.env.TEE_MODE = originalMode;
      } else {
        delete process.env.TEE_MODE;
      }
    });
  });
});
