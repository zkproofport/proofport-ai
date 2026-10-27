#!/usr/bin/env python3
"""Mutation check for the OIDC v2 input builders (server and client SDK).

Reintroduces each defect a guard exists for, runs tests/oidcInputsV2.test.ts,
and restores the file byte-for-byte. A mutation whose text is not found
exactly once is an error, not a pass; a mutation is "caught" only when the
tests fail AND the output names the expected test.

Usage: python3 scripts/mutate-oidc-builder.py [name ...]
Run from anywhere inside the repository with node_modules installed.
"""
import os
import subprocess
import sys

REPO = subprocess.run(['git', 'rev-parse', '--show-toplevel'],
                      capture_output=True, text=True, check=True).stdout.strip()

SERVER = 'src/prover/oidcProver.ts'
SDK = 'packages/sdk/src/oidc-inputs.ts'
FORMAT = 'src/prover/inputFormatter.ts'
TESTS = ['tests/oidcInputsV2.test.ts']

MUTATIONS = [
    ('server-any-audience', SERVER,
     "  if (jwtPayload.aud !== deviceClientId) {", "  if (false) {",
     'refuses our app web client'),
    ('sdk-any-audience', SDK,
     "  if (payload.aud !== deviceClientId) {", "  if (false) {",
     'checkDeviceFlowToken refuses the app web client before anything is fetched'),
    ('server-cut-past-the-dot', SERVER,
     "  const cut = Math.floor(dot / 64) * 64;", "  const cut = Math.floor((dot + 1) / 64) * 64;",
     'header of 63 characters'),
    ('server-offset-off-by-one', SERVER,
     "  const base64DecodeOffset = dot + 1 - cut;", "  const base64DecodeOffset = dot - cut;",
     'header of 50 characters'),
    ('sdk-offset-off-by-one', SDK,
     "  const base64DecodeOffset = dot + 1 - cut;", "  const base64DecodeOffset = dot - cut;",
     'builds the same inputs as the server for the same token and clock'),
    ('server-v1-cap', SERVER,
     "export const OIDC_MAX_PARTIAL_DATA_LENGTH = 2048;", "export const OIDC_MAX_PARTIAL_DATA_LENGTH = 768;",
     'accepts the largest signed data that fits 2048 bytes'),
    ('server-nonce-mode-1', SERVER,
     "    nonce_mode: OIDC_DEVICE_NONCE_MODE,", "    nonce_mode: 1,",
     'builds a Google device-flow token'),
    ('server-aud-hash-of-wrong-string', SERVER,
     "keccak256Bytes(new TextEncoder().encode(jwtPayload.aud as string))",
     "keccak256Bytes(new TextEncoder().encode(scope))",
     'builds a Google device-flow token'),
    ('server-proves-at-expiry', SERVER,
     "  if (now >= expiresAt) {", "  if (now > expiresAt) {",
     'refuses exp equal to the clock'),
    ('server-iat-skew-unbounded', SERVER,
     "    if (issuedAt - now > OIDC_IAT_CLOCK_SKEW_SECONDS) {", "    if (false) {",
     'refuses iat 61s ahead of the clock'),
    ('server-provider-disagreement-allowed', SERVER,
     "  if (named !== undefined && named !== fromIss) {", "  if (false) {",
     'refuses a named provider that disagrees with iss'),
    ('server-email-verified-truthy', SERVER,
     "    if (jwtPayload.email_verified !== true) {", "    if (!jwtPayload.email_verified) {",
     'refuses email_verified given as the string'),
    ('formatter-drops-now', FORMAT,
     "  result.now = inputs.now;\n", "",
     'names the four v2 public inputs as the circuit does'),
    ('sdk-sends-named-provider', SDK,
     "    provider: token.provider,\n  };", "    provider: params.provider as never,\n  };",
     'sends the provider the issuer names when none was given'),
]

ENV = {k: v for k, v in os.environ.items() if k != 'NODE_OPTIONS'}


def run(name, file, old, new, expect):
    path = os.path.join(REPO, file)
    with open(path, 'rb') as f:
        original = f.read()
    text = original.decode()
    count = text.count(old)
    if count != 1:
        return f'ERROR: expected the text once in {file}, found {count}'
    try:
        with open(path, 'wb') as f:
            f.write(text.replace(old, new).encode())
        with open(path, 'rb') as f:
            if f.read() == original:
                return 'ERROR: file unchanged after substitution'
        proc = subprocess.run(['npx', 'vitest', 'run', '--project', 'unit', *TESTS],
                              cwd=REPO, capture_output=True, text=True, env=ENV)
        out = proc.stdout + proc.stderr
        if proc.returncode == 0:
            return 'SURVIVED: tests passed with the defect in place'
        if expect not in out:
            return f"ERROR: tests failed, but not on '{expect}':\n{out}"
        return 'caught'
    finally:
        with open(path, 'wb') as f:
            f.write(original)
        with open(path, 'rb') as f:
            assert f.read() == original, f'{file} not restored'


def main():
    wanted = set(sys.argv[1:])
    failed = False
    for name, file, old, new, expect in MUTATIONS:
        if wanted and name not in wanted:
            continue
        result = run(name, file, old, new, expect)
        print(f'{name}: {result}', flush=True)
        failed |= result != 'caught'
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
