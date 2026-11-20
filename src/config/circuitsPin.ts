/**
 * THE circuits commit this server proves with.
 *
 * It decides both halves of a proof's meaning, and nothing else may:
 *   - the circuit artifacts (compiled JSON + verification key) baked into the
 *     image -- the build context scripts refuse a circuits checkout that is
 *     not this commit, and the server refuses to start on an image whose
 *     stamp (`circuits/circuits-source.json`) names another one;
 *   - the verifier deployment records (Foundry broadcast JSON) synced at
 *     startup, read from this commit on every chain, staging and production.
 *
 * Until 2026-11-17 the server read circuits from moving targets:
 * the `CIRCUITS_REPO_URL` env var (default circuits `main`) for artifacts and staging's
 * verifier records, and the GitHub API's `releases/latest` for production's.
 * Merging the Noir 1.0.0 / bb 6.0.0 artifacts to circuits `main`, or marking
 * a release Latest, would have switched a running server's circuits or
 * verifiers with no deploy, or mixed bb 6 with beta.19 artifacts -- and every
 * proof would have failed somewhere else. proofport-app pins
 * `CIRCUITS_RELEASE_TAG` for the same reason.
 *
 * A full commit SHA, not a tag or a branch: a tag can be moved and a branch
 * moves by design, while a commit can be checked offline at boot against the
 * image's stamp. A release tag is recorded in the comment below for people.
 *
 * Current value: circuits `main` at 3c1e4c6, prerelease tag `v3.0.0-rc.1`
 * -- the Noir 1.0.0 / bb 6.0.0 rebuild with the OPRF nullifier circuits
 * (33be413), the zkTLS size tiers (0c8bd51), the request-auth circuit's
 * artifacts (9c877ee) and the bb 6.0.0 verifier records on Base Sepolia,
 * Ethereum Sepolia and GIWA Sepolia (5a1f906). Its bytecode and verification
 * keys equal 2181748's; the CI rebuild only dropped absolute paths from each
 * compiled JSON's `file_map`, so the `target/*.json` bytes and hashes differ.
 * The monorepo's `circuits` gitlink names the same commit.
 * Toolchain: that commit's `toolchain.env` (nargo 1.0.0 / bb 6.0.0); the
 * image's bb is read from the stamp, and boot refuses a mismatch. Its mainnet
 * broadcast records still hold the bb 4.2 verifiers. Previous pins: 2181748
 * and ddf11f0 (`toolchain-upgrade`, same circuits), 9651df8 (circuits `main`,
 * nargo 1.0.0-beta.19 / bb 4.2.0-aztecnr-rc.2).
 *
 * RELEASING NEW CIRCUITS (e.g. the Noir 1.0.0 / bb 6.0.0 set): set this to
 * the commit the new circuits release tag points at
 * (`git -C circuits rev-list -n1 <tag>`), name the tag here, and move the
 * monorepo's `circuits` gitlink to the same commit in the same parent commit.
 * Release tag: `v3.0.0-rc.1` (a prerelease, not marked Latest).
 */
export const CIRCUITS_COMMIT = '3c1e4c68564a096573997964d838dccbc5834252';

export const CIRCUITS_REPOSITORY = 'zkproofport/circuits';

/** Raw file base URL for the pinned commit. The only circuits URL in src/. */
export function pinnedCircuitsRawBase(): string {
  if (!/^[0-9a-f]{40}$/.test(CIRCUITS_COMMIT)) {
    throw new Error(`CIRCUITS_COMMIT must be a full 40-hex commit SHA (got: ${CIRCUITS_COMMIT})`);
  }
  return `https://raw.githubusercontent.com/${CIRCUITS_REPOSITORY}/${CIRCUITS_COMMIT}`;
}
