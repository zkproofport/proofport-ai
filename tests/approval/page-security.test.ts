import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { approvalSecurityHeaders } from '../../src/approval/routes.js';

describe('approval page browser security policy', () => {
  it('allows only the WalletConnect verification frames while keeping scripts and embedding restricted', async () => {
    const app = express();
    app.get('/approve/:id', approvalSecurityHeaders, (_req, res) => res.type('html').send('<main>Review request</main>'));
    const response = await request(app).get('/approve/test-request');
    expect(response.status).toBe(200);
    const directives = new Map<string, string[]>((response.headers['content-security-policy'] ?? '').split(';')
      .map((directive: string) => directive.trim().split(/\s+/)).filter((parts: string[]) => parts[0])
      .map(([name, ...sources]: string[]) => [name, sources]));
    expect(new Set(directives.get('frame-src'))).toEqual(new Set([
      "'self'", 'https://verify.walletconnect.org', 'https://verify.walletconnect.com',
    ]));
    expect(directives.get('default-src')).toEqual(["'self'"]);
    expect(directives.get('script-src')).toEqual(["'self'"]);
    expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
    expect(directives.get('object-src')).toEqual(["'none'"]);
    expect(directives.get('base-uri')).toEqual(["'none'"]);
    expect(directives.get('form-action')).toEqual(["'none'"]);
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-frame-options']).toBe('DENY');
  });
});
