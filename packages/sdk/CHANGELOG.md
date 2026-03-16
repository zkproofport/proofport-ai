# Changelog

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
