/**
 * TEE environment auto-detection
 */

import { existsSync } from 'fs';
import type { TeeMode, ResolvedTeeMode } from './types.js';
import { createLogger } from '../logger.js';

const log = createLogger('TEE');

/**
 * Detect TEE hardware environment
 * - Checks for /dev/nsm (AWS Nitro Security Module)
 * - Returns 'nitro' if found, 'local' otherwise
 */
export function detectTeeEnvironment(): ResolvedTeeMode {
  if (existsSync('/dev/nsm')) {
    log.info({ action: 'tee.detected.nitro' }, 'Auto-detected: nitro (/dev/nsm found)');
    return 'nitro';
  }
  log.info({ action: 'tee.detected.local' }, 'Auto-detected: local (no TEE hardware)');
  return 'local';
}

/**
 * Resolve TeeMode to ResolvedTeeMode
 * - 'auto' → detectTeeEnvironment()
 * - others → pass through
 */
export function resolveTeeMode(mode: TeeMode): ResolvedTeeMode {
  if (mode === 'auto') {
    return detectTeeEnvironment();
  }
  return mode;
}
