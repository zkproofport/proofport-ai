/** Wallet peers are optional for SDK consumers, but required by this E2E matrix.
 * Reuse the tested root lock pins for CDP/x402; Circle's developer SDK is a
 * test-only exact pin. Refuse an added optional peer until the harness covers it.
 */
export function publishedWalletDependencies(lock, sdkManifest) {
  const dependencies = { '@circle-fin/developer-controlled-wallets': '10.8.1' };
  const cdpPeers = Object.keys(lock.packages?.['node_modules/@coinbase/cdp-sdk']?.peerDependencies ?? {});
  // CDP's x402 entry eagerly exports SVM helpers even for EVM callers. Its
  // own optional peers must be installed too, otherwise importing the EVM
  // adapter fails before any wallet can be used.
  const paths = Object.fromEntries(['@coinbase/cdp-sdk', '@x402/extensions', ...cdpPeers].map(name => [name, `node_modules/${name}`]));
  paths['@solana/kit'] = 'node_modules/@x402/svm/node_modules/@solana/kit';
  for (const [name, path] of Object.entries(paths)) {
    const version = lock.packages?.[path]?.version;
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error(`Published E2E wallet dependency ${name} needs an exact tested package-lock.json version`);
    }
    dependencies[name] = version;
  }
  for (const [name, metadata] of Object.entries(sdkManifest.peerDependenciesMeta ?? {})) {
    if (metadata.optional && !dependencies[name]) {
      throw new Error(`Published E2E does not install SDK optional wallet peer ${name}; add its tested pin and import preflight`);
    }
  }
  return dependencies;
}

// Executed by Node with cwd set to the isolated installation. These imports
// must resolve there before any test starts paying for proofs.
export const walletImportPreflight = `
const cdp = await import('@coinbase/cdp-sdk');
const adapter = await import('@coinbase/cdp-sdk/x402');
const extensions = await import('@x402/extensions');
const circle = await import('@circle-fin/developer-controlled-wallets');
if (typeof cdp.CdpClient !== 'function') throw new Error('CDP client export missing');
if (typeof adapter.fromCdpEvmAccount !== 'function') throw new Error('CDP x402 adapter export missing');
if (Object.keys(extensions).length === 0) throw new Error('x402 extensions exports missing');
if (typeof circle.initiateDeveloperControlledWalletsClient !== 'function') throw new Error('Circle developer wallet client export missing');
console.log('[published E2E] optional CDP/x402/Circle wallet adapters imported successfully');
`;
