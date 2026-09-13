# Arc candidate address privacy audit

This offline tool checks whether a supplied Ethereum address satisfies the
current `arc_eligibility` public nullifier relation:

```text
nullifier = keccak256(keccak256(address[20] || signal_hash[32]) || scope[32])
```

The signal hash, scope, and nullifier are all public. Knowing a candidate
address is therefore enough to check it without a wallet signature, private
key, attestation request, or RPC request. This is candidate checking, not hash
inversion or discovery of an unknown address. A match alone does not establish
that the supplied ZK proof is valid or that anybody passed KYC: independently
authenticate the proof with the intended verifier and circuit version.

## Run

Run from the `proofport-ai` project root with installed dependencies. Native
TypeScript execution requires Node 22.18 or newer. For older supported Node
versions, use `node --import tsx` instead of `node`.

```bash
# Uses the already configured CANDIDATE_ADDRESS; the value is never printed.
node demo/audit/compare-address.ts --proof path/to/proof.json

# Explicitly opt into parsing the existing .env.test in the current directory.
node demo/audit/compare-address.ts --proof path/to/proof.json --from-env

# An explicit public candidate can also be supplied as a command argument.
node demo/audit/compare-address.ts --proof path/to/proof.json --candidate 0x0000000000000000000000000000000000000001
```

`--from-env` parses dotenv text with Node's `util.parseEnv`; it never sources
shell code. Only `E2E_ATTESTATION_WALLET_ADDRESS` is selected. Explicit candidate
flags override the process environment; combining `--from-env` with
`--candidate` is rejected. Avoid command arguments when shell history or process
inspection must not expose the candidate. No keys are needed.

The proof JSON must contain `circuitId: "arc_eligibility"` (or
`circuit: "arc_eligibility"`), a nonempty `0x`-prefixed `proof`, and
`publicInputs`. For an export without a circuit identifier, explicitly supply
`--circuit arc_eligibility` using trusted context from the original request.
Unknown, conflicting, or absent circuit identifiers are rejected; the flag
cannot override a conflicting identifier in the file.
The public inputs must be either a concatenated hex string of 192 bytes32
fields or an array of exactly 192 bytes32 hex strings. Each field must encode
a byte from 0 through 255; compact raw bytes and shortened fields are rejected.
Proof and environment files must be regular files no larger than 1 MiB.

Output includes `matches`, `proofVerified: false`, and the limitation statement.
`proofFingerprint` is Keccak-256 of the proof bytes followed by all canonical
public-input fields. `publicInputsFingerprint` hashes just those fields.
Neither output nor error messages include the candidate address or env values.
Exit status is 0 for both a match and a non-match, and 1 for invalid input.
Nothing is written, submitted, paid, or fetched.

## Pure API

`address-audit.ts` exports:

- `candidateMatchesProof(publicInputs, candidateAddress): boolean`
- `extractArcPublicMetadata(publicInputs)` for the six public hashes and a fingerprint
- `normalizeArcPublicInputs(publicInputs)` for canonical bytes32 fields

These functions explicitly use the current Arc circuit layout. They do not
infer a circuit from its length and must only receive inputs already identified
as that circuit. Offsets are signal 0, domain 32, action 64, signer root 96,
scope 128, and nullifier 160. Future circuit versions require a new explicit
layout and relation.

## Verification matrix

Run `npm run test:unit -- tests/demoAddressAudit.test.ts`.

| Case | Coverage |
| --- | --- |
| Correct and incorrect candidate | Matching and one-byte-different address |
| Relation integrity | Changed signal, scope, and nullifier boundary bytes |
| Authentication limitation | Unbound domain mutation still matches; fingerprint changes |
| Encodings | Packed hex/array equivalence, immutable arrays, hex case |
| Byte boundaries | 0, 1, 255 accepted; 256 and malformed fields rejected |
| Counts and size | 191/193 fields, compact bytes, truncated/extended hex, sparse arrays, over-1-MiB file |
| Hostile and absent values | Empty, whitespace, null, undefined, numbers, objects, Unicode, controls, HTML, wildcard/backslash text |
| Candidate protection | Malformed address/private-key-shaped input rejected without echoing |
| CLI contract | Missing, unknown, duplicate, conflicting options; nonmatch status; circuit mismatch/absence |
| File/env failures | Bad JSON, missing env file, explicit env opt-in, shell syntax never evaluated |
| Output integrity | Fingerprints, matches, proofVerified, limitations, candidate/key redaction |
| Authorization, races, DB/RPC, contracts, HTTP E2E | N/A: offline synchronous audit with no service, authentication, network, or transactions |

Fixtures establish the relation and encoding behavior. They are synthetic and
are not valid ZK proofs. A separately obtained real proof must be authenticated
independently before interpreting its candidate match as evidence about KYC.
