# Changelog

## [0.2.16](https://github.com/zkproofport/proofport-ai/compare/sdk-v0.2.15...sdk-v0.2.16) (2026-09-22)


### Bug Fixes

* separate payment owners and complete proof verification targets ([7ef4e18](https://github.com/zkproofport/proofport-ai/commit/7ef4e1863536ef30bebf2d923a975511d49f96ce))

## [0.2.15](https://github.com/zkproofport/proofport-ai/compare/sdk-v0.2.14...sdk-v0.2.15) (2026-09-22)


### Bug Fixes

* synchronize proving, payments and multichain discovery ([49c7f8e](https://github.com/zkproofport/proofport-ai/commit/49c7f8e5de1131818e4b3112511e5d14c6c9b5f0))

## [0.2.14](https://github.com/zkproofport/proofport-ai/compare/sdk-v0.2.13...sdk-v0.2.14) (2026-09-22)


### Bug Fixes

* **sdk:** ship the per-circuit attester and nullifier tables ([816fbb6](https://github.com/zkproofport/proofport-ai/commit/816fbb677a95a335c87ae45aa772710df8fbe892))

## [0.2.13](https://github.com/zkproofport/proofport-ai/compare/sdk-v0.2.12...sdk-v0.2.13) (2026-09-22)


### Features

* prove giwa_attestation, with an optional EIP-712 action ([0a21fb5](https://github.com/zkproofport/proofport-ai/commit/0a21fb5cc265ebfd6e95e01da2b30d4e7608a351))

## [0.2.12](https://github.com/zkproofport/proofport-ai/compare/sdk-v0.2.11...sdk-v0.2.12) (2026-09-13)


### Bug Fixes

* **sdk:** validate exact actions before both proof paths sign ([119779d](https://github.com/zkproofport/proofport-ai/commit/119779d513cf98e3540e73be6001642aeb781286))

## [0.2.11](https://github.com/zkproofport/proofport-ai/compare/sdk-v0.2.10...sdk-v0.2.11) (2026-09-13)


### Features

* **arc:** complete agent wallet staking and GCP prover discovery demo ([031afbf](https://github.com/zkproofport/proofport-ai/commit/031afbf13a670d48fc5d874aa061c0bdaa52388f))
* take circuit ids from the SDK, and fix two defects it surfaced ([3bcc063](https://github.com/zkproofport/proofport-ai/commit/3bcc0630a514c4d1a3bd146f6994f7f0314f9c92))


### Bug Fixes

* publish Arc SDK and MCP through synchronized releases ([51d0bc3](https://github.com/zkproofport/proofport-ai/commit/51d0bc38a7d65ed7684675b49fd1e039f9a3a738))
* **sdk/attestation:** retry tx-indexing race (public RPC 5-30s lag) ([57dde8d](https://github.com/zkproofport/proofport-ai/commit/57dde8d539aaf64cf496f29e775c042bade2b926))
* **sdk:** use base.drpc.org instead of mainnet.base.org (full history) ([bb02518](https://github.com/zkproofport/proofport-ai/commit/bb02518c7597f848168e52c381f30409d319e43f))
* use canonical workspace lock and independent npm package versions ([c2b62fd](https://github.com/zkproofport/proofport-ai/commit/c2b62fd0da1c5422216cd5ec57e1845083e1fae5))

## [0.2.5](https://github.com/zkproofport/proofport-ai/compare/sdk-v0.2.4...sdk-v0.2.5) (2026-03-24)


### Bug Fixes

* bump MCP dependency to @zkproofport-ai/sdk@0.2.4 ([c2ae9a7](https://github.com/zkproofport/proofport-ai/commit/c2ae9a729ca2d95a1368c03369945dd88b4b85be))
* **mcp:** update sdk dependency to 0.2.4 for multi-circuit extract ([34969fd](https://github.com/zkproofport/proofport-ai/commit/34969fd65705727b20608bc79ed67c021a4aa4a2))

## [0.2.4](https://github.com/zkproofport/proofport-ai/compare/sdk-v0.2.3...sdk-v0.2.4) (2026-03-24)


### Bug Fixes

* OIDC E2E test — remove provider for personal Gmail, add setup.ts symlink ([8245f7d](https://github.com/zkproofport/proofport-ai/commit/8245f7de75e4cb615809e70124b64265696cc1c9))

## [0.2.3](https://github.com/zkproofport/proofport-ai/compare/sdk-v0.2.2...sdk-v0.2.3) (2026-03-24)


### Features

* multi-circuit extract functions, remove debug logs, fix errorReason check ([e4202bc](https://github.com/zkproofport/proofport-ai/commit/e4202bc2719b4b24a60be6b25281d081212e1be6))


### Bug Fixes

* check errorReason before txHash in x402 settle response ([4d3f796](https://github.com/zkproofport/proofport-ai/commit/4d3f7962ccc4076981f972085a1868d516d94640))

## [0.2.2](https://github.com/zkproofport/proofport-ai/compare/sdk-v0.2.1...sdk-v0.2.2) (2026-03-24)


### Features

* add extractDomainFromPublicInputs, extractNullifierFromPublicInputs ([2243fd6](https://github.com/zkproofport/proofport-ai/commit/2243fd6ca7473cb1268fb5edb5b5205a6da04398))

## [0.1.5](https://github.com/zkproofport/proofport-ai/compare/sdk-v0.1.4...sdk-v0.1.5) (2026-03-16)


### Refactoring

* enforce TEE-only Prover.toml build, delete legacy code ([159bd1f](https://github.com/zkproofport/proofport-ai/commit/159bd1f0daef998802ece3a7089046619eaf06f9))
* remove easRpcUrl/easGraphqlUrl from SDK config ([15b01c5](https://github.com/zkproofport/proofport-ai/commit/15b01c5203945a67beebd1d119461fc613558d3f))

## [0.1.4](https://github.com/zkproofport/proofport-ai/compare/sdk-v0.1.3...sdk-v0.1.4) (2026-03-16)


### Refactoring

* move OIDC input preparation to SDK, server as blind relay ([1376007](https://github.com/zkproofport/proofport-ai/commit/1376007a4879e79443e6444c968ddd61ae1fe4d1))

## [0.1.3](https://github.com/zkproofport/proofport-ai/compare/sdk-v0.1.2...sdk-v0.1.3) (2026-03-16)


### Features

* add OIDC domain circuit support, simplify verify_proof API, add E2E tests ([33f7923](https://github.com/zkproofport/proofport-ai/commit/33f7923b78914eaab6354935ed45d5e94c9bc330))

## [0.1.2](https://github.com/zkproofport/proofport-ai/compare/sdk-v0.1.1...sdk-v0.1.2) (2026-03-10)


### Bug Fixes

* add payment verification retry logic and ensure Redis on deploy ([6b11c3a](https://github.com/zkproofport/proofport-ai/commit/6b11c3afa1d498a751b32e941a0828cc5806ff83))
* replace hardcoded Sepolia references with paymentMode-driven chain config ([94461be](https://github.com/zkproofport/proofport-ai/commit/94461be703f267375852555556031d09b3aaec28))
* use mainnet-capable x402 facilitator (x402.org is testnet-only) ([5eb1426](https://github.com/zkproofport/proofport-ai/commit/5eb1426b0ed2afb95b79831f3a9674e72fb9fdc7))

## [0.1.1](https://github.com/zkproofport/proofport-ai/compare/sdk-v0.1.0...sdk-v0.1.1) (2026-03-05)


### Features

* add E2E encryption for TEE blind relay proof generation ([f358ac4](https://github.com/zkproofport/proofport-ai/commit/f358ac4454ebe609146f76d6893fff3b859d49f2))
