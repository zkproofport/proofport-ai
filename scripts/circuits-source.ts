/**
 * Print the stamp (circuits/circuits-source.json) for a circuits checkout,
 * after checking it against the pin in src/config/circuitsPin.ts.
 *
 *   npx tsx scripts/circuits-source.ts --checkout <circuits dir> --mode pinned
 *   npx tsx scripts/circuits-source.ts --checkout <circuits dir> --mode local
 *
 * `pinned` (deploys: the build context scripts, the AWS workflow) exits 1
 * unless the checkout is exactly the pinned commit. `local` (scripts/ai-dev.sh)
 * stamps a working tree as `worktree: true` and says why on stderr. See
 * scripts/lib/circuitsCheckout.ts.
 */
import { CIRCUITS_COMMIT } from '../src/config/circuitsPin.js';
import { describeCheckout, parseCheckoutMode } from './lib/circuitsCheckout.js';

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

try {
  const checkout = option('--checkout');
  if (!checkout) throw new Error('--checkout <circuits dir> is required');
  const { stamp, reason } = describeCheckout(checkout, parseCheckoutMode(option('--mode')), CIRCUITS_COMMIT);
  if (reason) console.error(`[!] Stamping a circuits WORKING TREE (local runs only): ${reason}`);
  console.log(JSON.stringify(stamp, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
