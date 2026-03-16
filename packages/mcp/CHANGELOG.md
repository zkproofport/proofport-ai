# Changelog

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
