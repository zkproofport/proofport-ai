/**
 * Vitest global setup — loads .env.test into process.env.
 * No external dependencies (no dotenv).
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const envPath = resolve(__dirname, '..', '.env.test');

try {
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    // Only set if not already defined (real env takes precedence)
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
} catch {
  // .env.test is optional — tests can still run with real env vars
}
