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
 * Current value: circuits `main` at 9651df8 (after v2.2.0), the commit the
 * monorepo's `circuits` gitlink names and the one staging's image was baked
 * from (deploy-ai.yml run 42942802826, 2026-11-11). Toolchain: whatever that
 * commit's `toolchain.env` says (nargo 1.0.0-beta.19 / bb 4.2.0-aztecnr-rc.2);
 * the image's bb is read from the stamp, and boot refuses a mismatch.
 *
 * RELEASING NEW CIRCUITS (e.g. the Noir 1.0.0 / bb 6.0.0 set): set this to
 * the commit the new circuits release tag points at
 * (`git -C circuits rev-list -n1 <tag>`), name the tag here, and move the
 * monorepo's `circuits` gitlink to the same commit in the same parent commit.
 * Release tag: none yet for 9651df8.
 */
export const CIRCUITS_COMMIT = '9651df892c28fbeb9331ebc5358abfdf062c7c42';

export const CIRCUITS_REPOSITORY = 'zkproofport/circuits';

/** Raw file base URL for the pinned commit. The only circuits URL in src/. */
export function pinnedCircuitsRawBase(): string {
  if (!/^[0-9a-f]{40}$/.test(CIRCUITS_COMMIT)) {
    throw new Error(`CIRCUITS_COMMIT must be a full 40-hex commit SHA (got: ${CIRCUITS_COMMIT})`);
  }
  return `https://raw.githubusercontent.com/${CIRCUITS_REPOSITORY}/${CIRCUITS_COMMIT}`;
}
