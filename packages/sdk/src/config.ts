import type { ClientConfig } from './types.js';

/**
 * Create a client configuration with sensible defaults.
 * Defaults to mainnet (production) settings.
 *
 * @param overrides - Optional overrides for any config field
 * @returns Complete ClientConfig
 *
 * @example
 * ```typescript
 * // Mainnet (default)
 * const config = createConfig();
 *
 * // Custom server URL
 * const config = createConfig({ baseUrl: 'https://custom-server.example.com' });
 * ```
 */
export function createConfig(overrides?: Partial<ClientConfig>): ClientConfig {
  return {
    baseUrl: 'https://ai.zkproofport.app',
    ...overrides,
  };
}
