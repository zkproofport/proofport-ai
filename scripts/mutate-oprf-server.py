#!/usr/bin/env python3
"""Mutation check for the server's OPRF input guards.

    python3 scripts/mutate-oprf-server.py          (from proofport-ai)

Each mutation removes one guard, confirms the file actually changed, runs the
tests that must catch it, and restores the file byte for byte (checked). A
mutation the tests do not catch -- or a substitution that matched nothing --
is a failure, and the script exits 1.
"""
import os
import subprocess
import sys

ROOT = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True, check=True).stdout.strip()
os.chdir(ROOT)

TESTS = ['tests/serverOprfInputs.test.ts', 'tests/serverOprfKeyHashes.test.ts', 'tests/proofRouteOprf.test.ts']

# The key-hash table and its production refusal are @zkproofport-app/core's
# (src/config/oprfKeyHashes.ts re-exports them since core 0.4.0-beta.9), so
# they are mutated in core's repository; serverOprfKeyHashes.test.ts still
# holds the installed core's rows and refusals.
MUTATIONS = [
    ('key-hash comparison removed', 'src/input/oprfInputs.ts',
     'if (out.oprf_key_hash !== pinned.toLowerCase()) {',
     'if (false && out.oprf_key_hash !== pinned.toLowerCase()) {'),
    ('below-modulus check made <=', 'src/input/oprfInputs.ts',
     '    if (v >= modulus) {',
     '    if (v > modulus) {'),
    ('beta-zero check removed', 'src/input/oprfInputs.ts',
     'if (BigInt(out.oprf_beta) === 0n) {',
     'if (false) {'),
    ('validation call removed from the proof route', 'src/proof/proofRoutes.ts',
     'oprf = readOprfInputs(config.oprfEnvironment, circuitId, body.inputs);',
     'oprf = body.inputs as never;'),
    ('environment check removed for encrypted payloads', 'src/proof/proofRoutes.ts',
     '            assertOprfAvailable(config.oprfEnvironment, circuitId);\n',
     '\n'),
]


def run_tests():
    r = subprocess.run(['npx', 'vitest', 'run', '--project', 'unit', *TESTS], capture_output=True, text=True)
    out = r.stdout + r.stderr
    summary = [l.strip() for l in out.splitlines() if l.strip().startswith('Tests ')]
    return r.returncode, (summary[-1] if summary else '(no summary: the file may not have loaded)')


failed = 0
code, summary = run_tests()
print(f'baseline: exit {code}, {summary}')
if code != 0:
    print('baseline is not green; mutations would prove nothing')
    sys.exit(1)

for name, path, old, new in MUTATIONS:
    with open(path, 'rb') as f:
        original = f.read()
    text = original.decode()
    count = text.count(old)
    if count != 1:
        print(f'  NOT APPLIED  {name}: pattern found {count} times in {path}')
        failed += 1
        continue
    with open(path, 'w') as f:
        f.write(text.replace(old, new))
    with open(path, 'rb') as f:
        changed = f.read() != original
    try:
        if not changed:
            print(f'  NOT APPLIED  {name}: file unchanged')
            failed += 1
            continue
        code, summary = run_tests()
        caught = code != 0 and 'failed' in summary
        print(f"  {'caught ' if caught else 'MISSED '}     {name}: {summary}")
        if not caught:
            failed += 1
    finally:
        with open(path, 'wb') as f:
            f.write(original)
        with open(path, 'rb') as f:
            if f.read() != original:
                print(f'  RESTORE FAILED for {path}')
                sys.exit(2)

print(f'{len(MUTATIONS) - failed}/{len(MUTATIONS)} caught; every file restored byte for byte')
sys.exit(1 if failed else 0)
