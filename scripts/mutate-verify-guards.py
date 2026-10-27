#!/usr/bin/env python3
"""Mutation check for the verification guards.

Reintroduces each defect the guards exist for, runs the tests that should
catch it, and restores the file byte-for-byte. A mutation whose text is not
found exactly once is an error, not a pass: a substitution that matched
nothing would leave the code unchanged and the tests green.

Usage: python3 scripts/mutate-verify-guards.py [name ...]
Run from anywhere inside the repository. Needs node_modules installed and the
AI SDK built (npm run build --workspace @zkproofport-ai/sdk), because the MCP
test imports the SDK's dist.
"""
import os
import subprocess
import sys

REPO = subprocess.run(['git', 'rev-parse', '--show-toplevel'],
                      capture_output=True, text=True, check=True).stdout.strip()

VERIFY = 'packages/sdk/src/verify.ts'
SDK_TESTS = ['tests/sdkVerifyUsesPinnedVerifier.test.ts', 'tests/sdkVerifyCoreCall.test.ts']

MUTATIONS = [
    {
        'name': 'sdk-trusts-response-address',
        'file': VERIFY,
        'old': "    { chainId },\n    { verifierAddress: claim.verifierAddress, chainId },\n",
        'new': "    { address: claim.verifierAddress, chainId, abi: ['function verify(bytes,bytes32[]) view returns (bool)'] },\n",
        'tests': SDK_TESTS + ['tests/mcpVerifyProofUsesPinnedVerifier.test.ts'],
        'expect': 'refuses an address that is not the pinned verifier',
    },
    {
        'name': 'sdk-uses-response-rpc',
        'file': VERIFY,
        'old': "new ethers.JsonRpcProvider(rpcUrl, chainId,",
        'new': "new ethers.JsonRpcProvider((claim as { rpcUrl?: string }).rpcUrl || rpcUrl, chainId,",
        'tests': SDK_TESTS,
        'expect': "never builds the provider from the response's rpcUrl",
    },
    {
        'name': 'sdk-drops-chain-guard',
        'file': VERIFY,
        'old': "  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId <= 0) {",
        'new': "  if (false) {",
        'tests': SDK_TESTS,
        'expect': 'refuses chainId',
    },
    {
        'name': 'sdk-drops-missing-address-guard',
        'file': VERIFY,
        'old': "  if (typeof claim.verifierAddress !== 'string') {",
        'new': "  if (false) {",
        'tests': SDK_TESTS,
        'expect': 'refuses a response with no verifierAddress at all',
    },
    {
        'name': 'server-fallback-drifts-from-core',
        'file': 'src/config/contracts.ts',
        'old': "'0x7fc2059a73cEF2b572C8deEe911c72963dCB4A8a'",
        'new': "'0xCbC8E63fF92659E8B44cFF117D33005Bb669a018'",
        'tests': ['tests/fallbackVerifiersMatchCore.test.ts'],
        'expect': 'coinbase_attestation on chain 11155111',
    },
    {
        'name': 'server-never-reports-unpinned',
        'file': 'src/config/deployments.ts',
        'old': "  if (!sameAddress(pinned.address, address)) {",
        'new': "  if (false) {",
        'tests': ['tests/fallbackVerifiersMatchCore.test.ts'],
        'expect': 'names both addresses',
    },
]


def run(mutation):
    path = os.path.join(REPO, mutation['file'])
    with open(path, 'rb') as f:
        original = f.read()
    text = original.decode()
    count = text.count(mutation['old'])
    if count != 1:
        return f"ERROR: expected the text once in {mutation['file']}, found {count}"
    try:
        with open(path, 'wb') as f:
            f.write(text.replace(mutation['old'], mutation['new']).encode())
        with open(path, 'rb') as f:
            if f.read() == original:
                return 'ERROR: file unchanged after substitution'
        env = {k: v for k, v in os.environ.items() if k != 'NODE_OPTIONS'}
        proc = subprocess.run(['npx', 'vitest', 'run', '--project', 'unit', *mutation['tests']],
                              cwd=REPO, capture_output=True, text=True, env=env)
        out = proc.stdout + proc.stderr
        if proc.returncode == 0:
            return 'SURVIVED: tests passed with the defect in place'
        if mutation['expect'] not in out:
            return f"ERROR: tests failed, but not on '{mutation['expect']}':\n{out}"
        return 'caught'
    finally:
        with open(path, 'wb') as f:
            f.write(original)
        with open(path, 'rb') as f:
            assert f.read() == original, f"{mutation['file']} not restored"


def main():
    wanted = set(sys.argv[1:])
    failed = False
    for mutation in MUTATIONS:
        if wanted and mutation['name'] not in wanted:
            continue
        result = run(mutation)
        print(f"{mutation['name']}: {result}")
        failed |= result != 'caught'
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
