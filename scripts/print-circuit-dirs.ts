/**
 * Print `<directory> <artifact-name>` for every circuit this server proves.
 *
 * Exists so a shell script can ask the code rather than keep its own list.
 * `scripts/ai-dev.sh` used to hold three circuit directories as literals,
 * which is how the local container crash-looped on 2026-09-09 when a fourth
 * circuit was added everywhere except there.
 *
 * A file rather than `tsx -e`: an inline eval resolves `./src/...` against a
 * synthetic module with no directory, and fails with MODULE_NOT_FOUND.
 */
import { circuitDirsLines } from '../src/config/circuitIds.js';

console.log(circuitDirsLines());
