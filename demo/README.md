# Ledger House recording demo

The user agent discovers the permitted GCP prover through Arc ERC-8004, pays
with the connected Circle Agent Wallet, and submits an action-bound
`arc_eligibility` proof to the deployed Ledger House contract. Staking transfers
real Arc Testnet USDC into contract custody. Positions come from contract state;
a successful HTTP response alone is not evidence of a stake.

## Start the recording page

From `proofport-ai` with Node 22.18 or newer:

```bash
bash demo/record.sh
```

Open http://localhost:4100. Prepare a preview on a separate port with:

```bash
RECORDING_PORT=4101 bash demo/record.sh
```

The launcher parses the existing `.env.development` and `.env.test`, with exported
variables taking precedence. It uses the existing `ATTESTATION_KEY`, Circle CLI
testnet login and built SDK/MCP packages. It does not create wallets or start a
local prover. Ctrl-C stops this recording server; GCP keeps running.

Wallet B is the connected Circle Agent Wallet
`0x06Ad6B4EEbcD486bE53d8a9dC760a67A5Bdf3F64`. At the completed integration check
on 2026-09-13 at 12:53:52 KST, it held 2 USDC with no open position. Use **1 USDC**
for the recording. If several wallets are connected, set `ARC_AGENT_WALLET` to
the intended existing wallet; ambiguous or unknown selections are refused.

## Run the agent

Keep the page visible and run this in a second terminal:

```bash
curl -s http://localhost:4100/demo/run -H 'Content-Type: application/json' -d '{"amount":"1"}'
```

Use port 4101 for the preview. The Run agent button invokes the same endpoint.
Concurrent runs are refused. The server launches the existing CLI agent with
`--pay-on arc-testnet-nano --pay-with arc` and relays sanitized progress.

1. Read the service manifest and require agreement with trusted local
   [`arc-testnet.json`](arc-testnet.json).
2. Search the Arc registry from block `61836881`, check current token ownership
   and active Arc proof metadata, and select only the permitted GCP endpoint:
   `https://stg-ai.zkproofport.app/api/v1/prove`.
3. Have wallet A sign `CredentialDelegation(delegate, action, amount, expiresAt,
   nonce)`. The domain names Ledger House Staking, version 1, chain `5042002`,
   and the **staking contract**, not the verifier. Amounts use six-decimal USDC units.
4. Buy the proof using wallet B's existing Arc Gateway balance.
5. Approve the requested amount if needed, execute `stakePacked` through Circle
   CLI, and await the real receipt and matching `Staked` event.
6. Retain the public proof and transaction evidence and show the on-chain position.

The contract pins the trusted Coinbase signer root, `ledger-house` scope,
caller, amount, domain and expiry. Reused actions or sender nonces are refused.
Deposits earn no yield. Only the depositing wallet can withdraw its balance.
Wallet A's key and raw credential diagnostics stay out of browser and terminal
output, but the current public nullifier remains candidate-checkable; see the
audit section before describing its privacy guarantees.

## Deployment and verification status

The source-verified staking contract is
[`0xD0F3eE648386B59B484157332E736388Fcc41F47`](https://testnet.arcscan.app/address/0xD0F3eE648386B59B484157332E736388Fcc41F47).
It uses verifier `0xCbC8E63fF92659E8B44cFF117D33005Bb669a018` and USDC
`0x3600000000000000000000000000000000000000` on Arc Testnet, chain `5042002`.

The **local-prover contract integration passed** on 2026-09-13 at 12:53:52 KST:

- [1 USDC approval](https://testnet.arcscan.app/tx/0x26a65f308af96a110b98f688479dce97e8e2b05cf4e89e242a9d2d5d8274dca4), block 61837882.
- [1 USDC stake](https://testnet.arcscan.app/tx/0xc7df4704cf3170a8f2971045972aae5a7faa53c4b65820caec4d2ddde38a65a7), block 61837899.
- [1 USDC withdrawal](https://testnet.arcscan.app/tx/0x9b82182646bb02dac0183089927eda7470904d1686f1bd8d9687f7a818e7a4ac), block 61837915.

The deployed verifier accepted the real proof. Wrong amount and caller reverted;
replay reverted before and after withdrawal. Position and custody returned to
zero and wallet B retained 2 USDC. Evidence is in
[`artifacts/onchain-verification.json`](artifacts/onchain-verification.json),
with public proof in
[`artifacts/onchain-verification-proof.json`](artifacts/onchain-verification-proof.json).

That run used `http://localhost:4002`; it is **not a completed GCP end-to-end run**.
At this documentation update, deployment of the current GCP staging implementation
and verification of its paid remote flow remain pending GCP authentication.
The recording launcher targets GCP and refuses a service that does not advertise
paid Arc Testnet nanopayments. It never falls back to the local prover.

From the parent workspace, prepare the deployment context with:

```bash
node scripts/deploy-ai-recording-gcp.mjs --prepare
```

Actual deployment uses the same script with `--deploy --nano-pay-to` and the
verified Circle receiving-wallet address. It requires working GCP credentials
for the existing staging service. Keep secrets in configured stores, never in
browser fields, arguments, documentation or build context. Mark the remote flow
verified only after a new GCP-paid proof and real staking receipt complete.

## Recheck and recover the integration deposit

With the existing paid local prover running on port 4002:

```bash
node demo/verify-onchain.ts
```

This performs a real paid run: stake 1 USDC from the existing wallet, verify
state and adversarial calls, then withdraw that run's 1 USDC to restore its
starting balance. It does not withdraw a separate recording's open position.
Run without another wallet transaction in flight. Evidence explicitly identifies
the local prover. Wallet A's address and credential errors are never printed.

## Audit the public proof

The public nullifier permits checking a known candidate KYC address. Hiding
wallet A in the interface does not prevent that cryptographic linkability.
This offline audit reports a match without printing the candidate; it does not
itself verify the ZK proof:

```bash
node demo/audit/compare-address.ts --proof demo/artifacts/onchain-verification-proof.json --from-env
node demo/audit/compare-address.ts --proof demo/artifacts/onchain-verification-proof.json --candidate 0x0000000000000000000000000000000000000001
```

`--from-env` reads only `E2E_ATTESTATION_WALLET_ADDRESS` from `.env.test`.
See [`audit/README.md`](audit/README.md) for candidate protection, required
circuit identifiers, limits and the difference between a match and verification.

## Existing payment setup and checks

Reuse the Circle wallet and Gateway balance. Payer and payee must be different.
A Gateway batch UUID is not an on-chain transaction hash. If funding is required,
`circle gateway deposit` is the existing command; do not fund automatically during
recording. Circle login uses `--testnet` separately from mainnet.

```bash
npm run test:unit -- tests/theStakingDemoHoldsTogether.test.ts tests/demoOnchainFlow.test.ts tests/demoStakeReceipt.test.ts tests/demoWallet.test.ts
npx tsc --noEmit -p demo/tsconfig.json
```

The Solidity adversarial suite runs from `circuits` with pinned Foundry 1.4.3:
`forge test --match-contract LedgerHouseStakingTest`.
