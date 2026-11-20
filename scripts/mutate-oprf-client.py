#!/usr/bin/env python3
"""Mutation check for the SDK's OPRF client (packages/sdk/src/oprf).

Each mutation removes or weakens one guard. For each: the file is changed
(the script refuses a pattern that matches zero or several times and checks the
bytes differ), the listed tests are run, and the mutation must make them FAIL
(non-zero exit with at least one failed test). The original bytes are put back
and compared by hash before the next mutation; any mismatch stops the run.

    python3 scripts/mutate-oprf-client.py

Run from anywhere in the repository. Exit 0 only when every mutation is caught.
"""
import hashlib
import os
import re
import subprocess
import sys

root = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True, check=True).stdout.strip()
os.chdir(root)

T_MIRROR = 'tests/oprfMirror.test.ts'
T_CLIENT = 'tests/oprfClient.test.ts'
T_TRANSPORT = 'tests/oprfTransport.test.ts'
T_FLOW = 'tests/oprfFlow.test.ts'
T_WIRE = 'tests/oprfWireFormat.test.ts'
T_NAMES = 'tests/oprfNamesAreTheCallers.test.ts'
T_MCP = 'tests/mcpOptionalActions.test.ts'
T_CLI = 'tests/mcpCli.test.ts'

# The OPRF client itself (finalizeOprf's pinned-hash comparison, the DLog
# check, the name rules) and the key-hash table are imported from
# @zkproofport-app/core since 0.4.0-beta.9, so their guards are mutated in
# core's repository, not here. Mutations of the two files still mirrored
# (packages/sdk/src/oprf/core) would NOT be judged by oprfMirror.test.ts: its
# drift check against core's source fails on any change, which says nothing
# about whether a behavioural test bites.
MUTATIONS = [
    ('key hash: evaluateOprf stops passing the pinned hash',
     'packages/sdk/src/oprf/index.ts',
     '    dlogS: toHex32(exchange.dlogS),\n    expectedKeyHash,\n',
     '    dlogS: toHex32(exchange.dlogS),\n', [T_FLOW]),
    ('key hash: checkPreparedOprf stops comparing re-derived values',
     'packages/sdk/src/oprf/index.ts',
     "    if (again[k] !== i[k]) throw new Error(`OPRF input ${k} does not match what the evaluation gives.`);",
     '    void again; void k;', [T_CLIENT]),
    ('DLog: Lagrange weights dropped from the combined answer',
     'packages/sdk/src/oprf/shamir.ts',
     '(acc, comm, i) => add(acc, scalarMul(comm.c, lagrangeAtZero(parties[i], parties))),',
     '(acc, comm) => add(acc, comm.c),', [T_TRANSPORT]),
    ('DLog: BLAKE3 nonce combiner reads 32 bytes instead of 64',
     'packages/sdk/src/oprf/shamir.ts',
     'blake3(input, 64)', 'blake3(input, 32)', [T_TRANSPORT]),
    ('names: generateProof stops checking oprfDomain',
     'packages/sdk/src/flow.ts',
     "  const oprfDomain = isOidc ? undefined : resolveOprfDomain(params.oprfDomain);",
     '  const oprfDomain = isOidc ? undefined : (params.oprfDomain as string);', [T_FLOW]),
    ('production: network row filled with the test network',
     'packages/sdk/src/oprf/networks.ts',
     '  production: null,\n  staging: TEST_NETWORK,', '  production: TEST_NETWORK,\n  staging: TEST_NETWORK,', [T_MIRROR, T_CLIENT, T_FLOW]),
    ('production: generateProof skips the OPRF step',
     'packages/sdk/src/flow.ts',
     '    const oprf = await prepareOprf(config, { circuitId, address: attestationAddress, oprfDomain, scope });',
     '    const oprf = undefined as never;', [T_FLOW]),
    ('oprfDomain: an IP hostname is filled in',
     'packages/sdk/src/oprf/index.ts',
     '  if (IP_HOST.test(host)) return null;\n', '', [T_NAMES]),
    ('oprfDomain: filled in without a real window (Node, workers, spoofed globals)',
     'packages/sdk/src/oprf/index.ts',
     "if (!scope || scope.window !== g || typeof scope.document !== 'object' || scope.document === null) return null;",
     'if (!scope) return null;', [T_NAMES]),
    ('oprfDomain: any page protocol accepted',
     'packages/sdk/src/oprf/index.ts',
     "if (!loc || (loc.protocol !== 'http:' && loc.protocol !== 'https:')) return null;",
     'if (!loc) return null;', [T_NAMES]),
    ('oprfDomain: hostname not lowercased',
     'packages/sdk/src/oprf/index.ts',
     'const host = loc.hostname.toLowerCase();', 'const host = loc.hostname;', [T_NAMES]),
    ('oprfDomain: omitted outside a browser filled with a constant',
     'packages/sdk/src/oprf/index.ts',
     '  const host = browserOprfDomain(g);\n  if (host === null) {',
     "  const host = browserOprfDomain(g) ?? 'localhost';\n  if (host === null) {", [T_NAMES, T_FLOW]),
    ('scope: the "proofport" default comes back in generateProof',
     'packages/sdk/src/flow.ts',
     "  if (params.scope === undefined) {\n    throw new Error('scope is required: name what the proof is for within the service. Nothing is filled in.');\n  }\n  const scope = params.scope;\n",
     "  const scope = params.scope ?? 'proofport';\n", [T_NAMES]),
    ('scope: generateProof stops requiring it',
     'packages/sdk/src/flow.ts',
     "  if (params.scope === undefined) {\n    throw new Error('scope is required: name what the proof is for within the service. Nothing is filled in.');\n  }\n",
     '', [T_NAMES]),
    ('MCP: generate_proof stops checking scope / oprf_domain',
     'packages/mcp/src/tools.ts',
     "        const missing = missingNameArgument(params, params.circuit === 'oidc_domain');\n        if (missing) return errorResult(missing);\n",
     '', [T_MCP]),
    ('MCP: oprf_domain no longer required for wallet circuits',
     'packages/mcp/src/tools.ts',
     "  if (!isOidc && (params.oprf_domain === undefined || params.oprf_domain === null)) {",
     "  if (false) {", [T_MCP]),
    ('CLI: --oprf-domain no longer required',
     'packages/mcp/src/prove.ts',
     "if (circuit !== 'oidc_domain' && oprfDomain === undefined) {", 'if (false) {', [T_CLI]),
    ('CLI: --scope no longer required',
     'packages/mcp/src/prove.ts',
     'if (scope === undefined) {\n', 'if (false) {\n', [T_CLI]),
    ('enclave: OPRF values passed through without the pinned key hash',
     'src/aws/enclave-server.ts',
     '      oprf: enclaveOprfInputs(process.env.OPRF_ENVIRONMENT, circuitId, inputs),',
     '      oprf: inputs,', [T_NAMES]),
    ('enclave: environment check skipped (staging assumed)',
     'src/aws/enclaveOprf.ts',
     '  return readOprfInputs(parseOprfEnvironment(environmentVariable), circuitId, inputs);',
     "  return readOprfInputs(parseOprfEnvironment(environmentVariable) ?? 'staging', circuitId, inputs);", [T_NAMES]),
    ('Node: a fallback transport instead of the named error',
     'packages/sdk/src/oprf/transport.ts',
     "  if (typeof WS !== 'function') {",
     "  if (typeof WS !== 'function') return (() => { throw new Error('no socket'); }) as never;\n  if (false) {", [T_NAMES]),
    ('points: subgroup check dropped on decompression',
     'packages/sdk/src/oprf/shamir.ts',
     "  if (!isInSubgroup(p)) throw new Error(`${what} is not in BabyJubJub's prime-order subgroup.`);\n", '', [T_WIRE]),
]


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def run_tests(files):
    r = subprocess.run(['npx', 'vitest', 'run', '--project', 'unit', *files], capture_output=True, text=True)
    out = r.stdout + r.stderr
    m = re.search(r'Tests\s+(?:(\d+) failed \| )?(\d+) passed', out)
    failed = int(m.group(1)) if m and m.group(1) else 0
    ran = re.search(r'Tests\s+.*\((\d+)\)', out)
    return r.returncode, failed, int(ran.group(1)) if ran else 0, out


caught = 0
for name, path, old, new, tests in MUTATIONS:
    original = open(path, 'rb').read()
    text = original.decode()
    n = text.count(old)
    if n != 1:
        print(f'BROKEN   {name}: pattern matches {n} times in {path}')
        sys.exit(2)
    mutated = text.replace(old, new).encode()
    open(path, 'wb').write(mutated)
    try:
        if sha(open(path, 'rb').read()) == sha(original):
            print(f'BROKEN   {name}: file unchanged after mutation')
            sys.exit(2)
        code, failed, ran, out = run_tests(tests)
    finally:
        open(path, 'wb').write(original)
    if sha(open(path, 'rb').read()) != sha(original):
        print(f'BROKEN   {name}: {path} not restored')
        sys.exit(2)
    if code != 0 and (failed > 0 or ran == 0 and 'Error' in out):
        caught += 1
        print(f'caught   {name}  ({failed} failed of {ran})')
    else:
        print(f'MISSED   {name}  (exit {code}, {failed} failed of {ran})')

print(f'\n{caught}/{len(MUTATIONS)} mutations caught; every file restored byte for byte.')
sys.exit(0 if caught == len(MUTATIONS) else 1)
