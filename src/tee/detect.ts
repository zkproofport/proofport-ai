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
 * Resolve TeeMode to ResolvedTeeMode.
 *
 * Every mode now names its own environment, so this is a pass-through. It is
 * kept as the single place a future mode would be resolved, and because
 * `detectTeeEnvironment` above is still worth having for diagnostics — asking
 * the machine what it actually is, rather than trusting the variable.
 */
export function resolveTeeMode(mode: TeeMode): ResolvedTeeMode {
  return mode;
}
