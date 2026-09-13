# Changelog

## [0.2.13](https://github.com/zkproofport/proofport-ai/compare/mcp-v0.2.12...mcp-v0.2.13) (2026-09-13)


### Features

* add circuit/proofType to SDK ProveResponse and ProofResult types ([ef8d551](https://github.com/zkproofport/proofport-ai/commit/ef8d551cbaa78b0183bf7fc727dbb176e77d4320))
* add device flow login to prove CLI (--login-google, --login-google-workspace, --login-microsoft-365) ([bf637e0](https://github.com/zkproofport/proofport-ai/commit/bf637e083550bee8709351bbf889eb67bf8ea2a9))
* add E2E encryption for TEE blind relay proof generation ([f358ac4](https://github.com/zkproofport/proofport-ai/commit/f358ac4454ebe609146f76d6893fff3b859d49f2))
* add Google Workspace & Microsoft 365 provider support ([e3e4985](https://github.com/zkproofport/proofport-ai/commit/e3e4985e227b261d1ab40ac5905fdaf6091cf5c5))
* add OIDC domain circuit support, simplify verify_proof API, add E2E tests ([33f7923](https://github.com/zkproofport/proofport-ai/commit/33f7923b78914eaab6354935ed45d5e94c9bc330))
* **arc:** complete agent wallet staking and GCP prover discovery demo ([031afbf](https://github.com/zkproofport/proofport-ai/commit/031afbf13a670d48fc5d874aa061c0bdaa52388f))
* **demo:** stream real CLI and MCP lifecycle beside staking steps ([d36d380](https://github.com/zkproofport/proofport-ai/commit/d36d38041ee27474c32990208786f862874f156a))
* **mcp:** add --silent flag to zkproofport-prove CLI ([7bd5df6](https://github.com/zkproofport/proofport-ai/commit/7bd5df6ff7b308c9c304e5bed727695bb9f3c054))
* **mcp:** add zkproofport-prove CLI for direct proof generation ([718adb7](https://github.com/zkproofport/proofport-ai/commit/718adb7031c164dfd31e985cd65307875e0443b7))
* support PAYMENT_MODE=disabled with requiresPayment flag in SDK and tests ([62706fb](https://github.com/zkproofport/proofport-ai/commit/62706fb8a244867fd94b937d3011c832b472ba94))
* take circuit ids from the SDK, and fix two defects it surfaced ([3bcc063](https://github.com/zkproofport/proofport-ai/commit/3bcc0630a514c4d1a3bd146f6994f7f0314f9c92))


### Bug Fixes

* add circuit and proofType fields to verify_proof tool params ([fdf2e93](https://github.com/zkproofport/proofport-ai/commit/fdf2e930552be8ec6a5bca80b7a4d88a92a424fb))
* bump MCP dependency to @zkproofport-ai/sdk@0.2.4 ([c2ae9a7](https://github.com/zkproofport/proofport-ai/commit/c2ae9a729ca2d95a1368c03369945dd88b4b85be))
* **mcp:** add repository field for npm OIDC provenance validation ([a8da8c3](https://github.com/zkproofport/proofport-ai/commit/a8da8c3f73dd49cdd01d9a79d9f7525ce0971e55))
* **mcp:** bump @zkproofport-ai/sdk dependency to 0.2.4 ([650008d](https://github.com/zkproofport/proofport-ai/commit/650008ddaa2ed641b99c7563afaa497456c69c2c))
* **mcp:** remove broken CdpWalletSigner.create() call ([132896a](https://github.com/zkproofport/proofport-ai/commit/132896a720ff86d97cf711efa17f1a7c40a757e7))
* **mcp:** rename to zkproofport-mcp, add PAYMENT_KEY support, fix default URL ([3da6d49](https://github.com/zkproofport/proofport-ai/commit/3da6d491ff96588f02675900f18ac9cd2998a83b))
* **mcp:** update sdk dependency to 0.2.4 for multi-circuit extract ([34969fd](https://github.com/zkproofport/proofport-ai/commit/34969fd65705727b20608bc79ed67c021a4aa4a2))
* publish Arc SDK and MCP through synchronized releases ([51d0bc3](https://github.com/zkproofport/proofport-ai/commit/51d0bc38a7d65ed7684675b49fd1e039f9a3a738))
* remove all payment/CDP code from SDK and MCP ([ee1c09d](https://github.com/zkproofport/proofport-ai/commit/ee1c09d23ac691f12f639ba5e9da9b44ebf52eb5))
* remove PAYMENT_KEY requirement from MCP CLI ([eeb5792](https://github.com/zkproofport/proofport-ai/commit/eeb57921e039757f77eb5f98a3195d4814e2bb14))
* **sdk:** validate exact actions before both proof paths sign ([119779d](https://github.com/zkproofport/proofport-ai/commit/119779d513cf98e3540e73be6001642aeb781286))
* use Artifact Registry image for bb binary (GitHub nightly release deleted) ([1ed4890](https://github.com/zkproofport/proofport-ai/commit/1ed4890c9fd5acfbaf53ce53aa9f286fa6aa2753))
* use canonical workspace lock and independent npm package versions ([c2b62fd](https://github.com/zkproofport/proofport-ai/commit/c2b62fd0da1c5422216cd5ec57e1845083e1fae5))


### Refactoring

* enforce TEE-only Prover.toml build, delete legacy code ([159bd1f](https://github.com/zkproofport/proofport-ai/commit/159bd1f0daef998802ece3a7089046619eaf06f9))
* move JWT validation to TEE, SDK sends raw JWT + JWKS payload ([5ce0e7b](https://github.com/zkproofport/proofport-ai/commit/5ce0e7b2a344a3a6517fe0e9e192d48527c86539))
* move OIDC input preparation to SDK, server as blind relay ([1376007](https://github.com/zkproofport/proofport-ai/commit/1376007a4879e79443e6444c968ddd61ae1fe4d1))
* remove easRpcUrl/easGraphqlUrl from SDK config ([15b01c5](https://github.com/zkproofport/proofport-ai/commit/15b01c5203945a67beebd1d119461fc613558d3f))
* rename packages/client to sdk, mcp-server to mcp ([fcf1e4b](https://github.com/zkproofport/proofport-ai/commit/fcf1e4b4834ee59e194416c7223dbc5ee7a92e4f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @zkproofport-ai/sdk bumped from ^0.2.12 to ^0.2.13

## [0.2.12](https://github.com/zkproofport/proofport-ai/compare/mcp-v0.2.11...mcp-v0.2.12) (2026-09-13)


### Bug Fixes

* **sdk:** validate exact actions before both proof paths sign ([119779d](https://github.com/zkproofport/proofport-ai/commit/119779d513cf98e3540e73be6001642aeb781286))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @zkproofport-ai/sdk bumped from ^0.2.11 to ^0.2.12

## [0.2.11](https://github.com/zkproofport/proofport-ai/compare/mcp-v0.2.10...mcp-v0.2.11) (2026-09-13)


### Features

* **arc:** complete agent wallet staking and GCP prover discovery demo ([031afbf](https://github.com/zkproofport/proofport-ai/commit/031afbf13a670d48fc5d874aa061c0bdaa52388f))
* **demo:** stream real CLI and MCP lifecycle beside staking steps ([d36d380](https://github.com/zkproofport/proofport-ai/commit/d36d38041ee27474c32990208786f862874f156a))
* take circuit ids from the SDK, and fix two defects it surfaced ([3bcc063](https://github.com/zkproofport/proofport-ai/commit/3bcc0630a514c4d1a3bd146f6994f7f0314f9c92))


### Bug Fixes

* publish Arc SDK and MCP through synchronized releases ([51d0bc3](https://github.com/zkproofport/proofport-ai/commit/51d0bc38a7d65ed7684675b49fd1e039f9a3a738))
* use canonical workspace lock and independent npm package versions ([c2b62fd](https://github.com/zkproofport/proofport-ai/commit/c2b62fd0da1c5422216cd5ec57e1845083e1fae5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @zkproofport-ai/sdk bumped from ^0.2.10 to ^0.2.11

## [0.2.3](https://github.com/zkproofport/proofport-ai/compare/mcp-v0.2.2...mcp-v0.2.3) (2026-03-24)


### Bug Fixes

* bump MCP dependency to @zkproofport-ai/sdk@0.2.4 ([c2ae9a7](https://github.com/zkproofport/proofport-ai/commit/c2ae9a729ca2d95a1368c03369945dd88b4b85be))
* **mcp:** bump @zkproofport-ai/sdk dependency to 0.2.4 ([650008d](https://github.com/zkproofport/proofport-ai/commit/650008ddaa2ed641b99c7563afaa497456c69c2c))
* **mcp:** update sdk dependency to 0.2.4 for multi-circuit extract ([34969fd](https://github.com/zkproofport/proofport-ai/commit/34969fd65705727b20608bc79ed67c021a4aa4a2))

## [0.1.7](https://github.com/zkproofport/proofport-ai/compare/mcp-v0.1.6...mcp-v0.1.7) (2026-03-16)


### Refactoring

* enforce TEE-only Prover.toml build, delete legacy code ([159bd1f](https://github.com/zkproofport/proofport-ai/commit/159bd1f0daef998802ece3a7089046619eaf06f9))
* remove easRpcUrl/easGraphqlUrl from SDK config ([15b01c5](https://github.com/zkproofport/proofport-ai/commit/15b01c5203945a67beebd1d119461fc613558d3f))

## [0.1.6](https://github.com/zkproofport/proofport-ai/compare/mcp-v0.1.5...mcp-v0.1.6) (2026-03-16)


### Refactoring

* move OIDC input preparation to SDK, server as blind relay ([1376007](https://github.com/zkproofport/proofport-ai/commit/1376007a4879e79443e6444c968ddd61ae1fe4d1))

## [0.1.5](https://github.com/zkproofport/proofport-ai/compare/mcp-v0.1.4...mcp-v0.1.5) (2026-03-16)


### Features

* add OIDC domain circuit support, simplify verify_proof API, add E2E tests ([33f7923](https://github.com/zkproofport/proofport-ai/commit/33f7923b78914eaab6354935ed45d5e94c9bc330))

## [0.1.4](https://github.com/zkproofport/proofport-ai/compare/mcp-v0.1.3...mcp-v0.1.4) (2026-03-12)


### Features

* **mcp:** add --silent flag to zkproofport-prove CLI ([7bd5df6](https://github.com/zkproofport/proofport-ai/commit/7bd5df6ff7b308c9c304e5bed727695bb9f3c054))

## [0.1.3](https://github.com/zkproofport/proofport-ai/compare/mcp-v0.1.2...mcp-v0.1.3) (2026-03-11)


### Bug Fixes

* **mcp:** remove broken CdpWalletSigner.create() call ([132896a](https://github.com/zkproofport/proofport-ai/commit/132896a720ff86d97cf711efa17f1a7c40a757e7))

## [0.1.2](https://github.com/zkproofport/proofport-ai/compare/mcp-v0.1.1...mcp-v0.1.2) (2026-03-11)


### Features

* **mcp:** add zkproofport-prove CLI for direct proof generation ([718adb7](https://github.com/zkproofport/proofport-ai/commit/718adb7031c164dfd31e985cd65307875e0443b7))

## [0.1.1](https://github.com/zkproofport/proofport-ai/compare/mcp-v0.1.0...mcp-v0.1.1) (2026-03-05)


### Features

* add E2E encryption for TEE blind relay proof generation ([f358ac4](https://github.com/zkproofport/proofport-ai/commit/f358ac4454ebe609146f76d6893fff3b859d49f2))


### Bug Fixes

* **mcp:** rename to zkproofport-mcp, add PAYMENT_KEY support, fix default URL ([3da6d49](https://github.com/zkproofport/proofport-ai/commit/3da6d491ff96588f02675900f18ac9cd2998a83b))
