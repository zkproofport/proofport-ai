/**
 * TEE environment auto-detection
 */

import { existsSync } from 'fs';
import type { TeeMode, ResolvedTeeMode } from './types.js';

/**
 * Detect TEE hardware environment
 * - Checks for /dev/nsm (AWS Nitro Security Module)
 * - Returns 'nitro' if found, 'local' otherwise
 */
export function detectTeeEnvironment(): ResolvedTeeMode {
  if (existsSync('/dev/nsm')) {
    console.log('[TEE] Auto-detected: nitro (/dev/nsm found)');
    return 'nitro';
  }
  console.log('[TEE] Auto-detected: local (no TEE hardware)');
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
