# Test Documentation — proofport-ai

## Overview

The proofport-ai service uses **Vitest 3.x** for comprehensive unit, integration, and end-to-end testing. All external dependencies are mocked to ensure fast, reliable, isolated test execution.

**Test Summary:**
- **Framework**: Vitest 3.0.0
- **Test Files**: 42
- **Total Tests**: 615
- **Runtime**: ~1.6 seconds (all tests)
- **All Dependencies Mocked**: Redis, Blockchain, bb CLI, EAS GraphQL, TEE vsock, Privy API, x402 payment

## Quick Start

### Run All Tests
```bash
cd proofport-ai

# Run all tests once
npm run test

# Run tests in watch mode (re-run on file changes)
npm run test:watch

# Or use vitest directly
npx vitest run
npx vitest
```

### Run Specific Tests
```bash
# Run a specific test file
npx vitest run tests/config.test.ts

# Run tests matching a pattern (test name or file path)
npx vitest run -t "config"
npx vitest run -t "SSE"
npx vitest run -t "prove"

# Run tests in a specific directory
npx vitest run tests/tee/
npx vitest run tests/e2e/

# Run with verbose output
npx vitest run --reporter=verbose

# Generate coverage report
npx vitest run --coverage
```

## Test Structure

### Directory Layout

```
tests/
├── a2a/                              # Agent-to-Agent protocol tests
│   ├── agentCard.test.ts             (18 tests) Agent Card generation, env-aware URLs
│   ├── integration.test.ts           (8 tests)  A2A + MCP coexistence on same app
│   ├── streaming.test.ts             (17 tests) SSE streaming, task events
│   ├── taskHandler.test.ts           (16 tests) JSON-RPC task handler, task lifecycle
│   └── taskWorker.test.ts            (14 tests) Proof generation worker, TEE routing
├── e2e/                              # End-to-end HTTP endpoint tests
│   ├── mcp-endpoint.test.ts          (7 tests)  Full MCP StreamableHTTP protocol flow
│   └── a2a-endpoint.test.ts          (20 tests) Full A2A HTTP protocol flow
├── identity/                         # ERC-8004 agent identity tests
│   ├── autoRegister.test.ts          (11 tests) Auto-registration at startup
│   ├── identity-integration.test.ts  (10 tests) Full identity flow
│   ├── register.test.ts              (26 tests) Registration contract calls
│   ├── reputation-unit.test.ts       (9 tests)  Reputation scoring logic
│   └── types.test.ts                 (8 tests)  Type guards and validation
├── payment/                          # x402 payment integration tests
│   ├── facilitator.test.ts           (16 tests) Payment record tracking
│   ├── freeTier.test.ts              (17 tests) Free tier bypass logic
│   ├── integration.test.ts           (16 tests) Payment flow integration
│   ├── settlementWorker.test.ts      (17 tests) USDC settlement to wallet
│   └── x402Middleware.test.ts        (10 tests) x402 payment middleware
├── signing/                          # KYC wallet signing tests
│   ├── eip7702Signing.test.ts        (23 tests) EIP-7702 batch signatures
│   ├── integration.test.ts           (9 tests)  All 3 signing providers together
│   ├── privySigning.test.ts          (12 tests) Privy delegated actions
│   ├── types.test.ts                 (11 tests) Type guards and validation
│   └── webSigning.test.ts            (13 tests) Web signing with callback
├── tee/                              # TEE (Trusted Execution Environment) tests
│   ├── attestation.test.ts           (20 tests) COSE/CBOR parsing, sig verification
│   ├── encryption.test.ts            (14 tests) AES-256-GCM encryption/decryption
│   ├── enclaveBuilder.test.ts        (19 tests) Dockerfile generation for enclave
│   ├── enclaveClient.test.ts         (16 tests) Vsock communication with enclave
│   ├── integration.test.ts           (18 tests) TEE endpoint integration
│   ├── tee-http.test.ts              (7 tests)  TEE HTTP status endpoint
│   ├── tee-integration.test.ts       (9 tests)  TEE with full app integration
│   └── types.test.ts                 (15 tests) Type definitions
├── artifactManager.test.ts           (15 tests) Circuit artifact download
├── bbProver.test.ts                  (11 tests) bb CLI prover subprocess
├── circuits.test.ts                  (8 tests)  Circuit metadata and configuration
├── config.test.ts                    (24 tests) Environment variable parsing
├── contracts.test.ts                 (9 tests)  Contract addresses and ABIs
├── inputBuilder.test.ts              (66 tests) Circuit input construction (largest suite)
├── mcp.test.ts                       (21 tests) MCP tool handlers (zkproofport-prover)
├── proverClient.test.ts              (6 tests)  Prover HTTP client
├── redis.test.ts                     (15 tests) Rate limiting + proof caching
├── tomlBuilder.test.ts               (17 tests) Prover.toml generation
├── types.test.ts                     (4 tests)  Core type definitions
└── verifier.test.ts                  (7 tests)  On-chain verification
```

### Test Counts by Category

**Unit Tests** (isolated modules with mocks):
- `inputBuilder.test.ts` — 66 tests (largest)
- `config.test.ts` — 24 tests
- `a2a/agentCard.test.ts` — 18 tests
- `tee/attestation.test.ts` — 20 tests
- `identity/register.test.ts` — 26 tests

**Integration Tests** (multiple modules + app creation):
- `a2a/integration.test.ts` — 8 tests
- `payment/integration.test.ts` — 16 tests
- `signing/integration.test.ts` — 9 tests
- `tee/integration.test.ts` — 18 tests
- `identity/identity-integration.test.ts` — 10 tests

**End-to-End Tests** (full HTTP request/response):
- `e2e/a2a-endpoint.test.ts` — 20 tests
- `e2e/mcp-endpoint.test.ts` — 7 tests

## Mocking Strategy

All external dependencies are mocked to ensure tests run in isolation without requiring real services:

### Redis
**Mocked with:** In-memory `Map<string, string>`

```typescript
vi.mock('ioredis', () => {
  const store = new Map<string, string>();
  return {
    default: vi.fn(() => ({
      get: vi.fn((key) => Promise.resolve(store.get(key) || null)),
      set: vi.fn((key, value) => {
        store.set(key, value);
        return Promise.resolve('OK');
      }),
      del: vi.fn((key) => {
        store.delete(key);
        return Promise.resolve(1);
      }),
      // ... other methods mocked
    })),
  };
});
```

**Used By:**
- Rate limiting tests (`redis.test.ts`)
- Proof caching
- Session storage
- Task queues

### Blockchain (Ethers.js)
**Mocked with:** vi.mock for Contract and JsonRpcProvider

**Mocked Components:**
- `ethers.Contract` — contract calls return mocked responses
- `ethers.JsonRpcProvider` — JSON-RPC calls return mocked data
- `ethers.Wallet` — signing returns mocked signatures

**Used By:**
- Identity registration (`identity/register.test.ts`)
- ERC-8004 agent identity
- On-chain verification (`verifier.test.ts`)
- Contract interaction tests

### bb CLI (Barretenberg Prover)
**Mocked with:** `vi.mock('child_process.execFile')`

```typescript
vi.mock('child_process', () => ({
  execFile: vi.fn((cmd, args, callback) => {
    if (cmd.includes('bb')) {
      callback(null, mockProofOutput, '');
    }
  }),
}));
```

**Used By:**
- `bbProver.test.ts` — bb subprocess calls
- Proof generation flow
- Circuit artifacts

### EAS GraphQL
**Mocked with:** Mocked fetch responses

```typescript
global.fetch = vi.fn((url) => {
  if (url.includes('easscan')) {
    return Promise.resolve({
      json: () => Promise.resolve(mockAttestationData),
    });
  }
});
```

**Used By:**
- Attestation fetching (`inputBuilder.test.ts`)
- KYC data retrieval

### TEE Vsock Communication
**Mocked with:** Mocked `net.Socket`

```typescript
vi.mock('net', () => ({
  Socket: vi.fn(() => ({
    connect: vi.fn(),
    write: vi.fn(),
    on: vi.fn(),
    destroy: vi.fn(),
  })),
}));
```

**Used By:**
- `tee/enclaveClient.test.ts` — vsock communication
- TEE endpoint integration

### Privy API
**Mocked with:** Mocked HTTP responses

```typescript
global.fetch = vi.fn((url) => {
  if (url.includes('privy.com')) {
    return Promise.resolve({
      json: () => Promise.resolve(mockDelegationData),
    });
  }
});
```

**Used By:**
- `signing/privySigning.test.ts` — Privy delegated actions
- KYC wallet signing

### x402 Payment
**Mocked with:** `vi.mock('@x402/express')`

```typescript
vi.mock('@x402/express', () => ({
  paymentMiddleware: vi.fn(() => (_req, _res, next) => next()),
}));
```

**Used By:**
- E2E endpoint tests
- Payment integration tests

## Test Categories

### Unit Tests

**Definition:** Test individual modules in isolation with mocked dependencies.

**Characteristics:**
- Single module under test
- All external dependencies mocked
- Fast execution (no I/O)
- Focused assertions

**Examples:**
- `config.test.ts` (24 tests) — Configuration parsing and validation
- `inputBuilder.test.ts` (66 tests) — Circuit input construction, Merkle trees, nullifier computation
- `bbProver.test.ts` (11 tests) — bb CLI subprocess
- `circuits.test.ts` (8 tests) — Circuit metadata
- `types.test.ts` files — Type guards and validators

### Integration Tests

**Definition:** Test multiple modules working together. Typically creates the Express app with `createApp()` and verifies module interactions.

**Characteristics:**
- Multiple modules interact
- App-level integration
- Dependencies still mocked
- Verify module contracts

**Examples:**
- `a2a/integration.test.ts` (8 tests) — A2A protocol + MCP coexist on same app
- `payment/integration.test.ts` (16 tests) — x402 payment + free tier + facilitator
- `signing/integration.test.ts` (9 tests) — All 3 signing providers work together
- `tee/integration.test.ts` (18 tests) — TEE endpoint with full app flow
- `identity/identity-integration.test.ts` (10 tests) — ERC-8004 registration + reputation

### End-to-End Tests

**Definition:** Test full HTTP request/response flow through the Express app. Make actual HTTP requests and verify responses.

**Characteristics:**
- Full HTTP protocol testing
- Request → Middleware → Handler → Response
- Uses `supertest` for HTTP assertions
- Verify entire endpoint behavior

**Examples:**
- `e2e/mcp-endpoint.test.ts` (7 tests) — Test `POST /mcp` endpoint, SSE response format
- `e2e/a2a-endpoint.test.ts` (20 tests) — Test `POST /a2a` endpoint, Agent Card, JSON-RPC

## Key Testing Patterns

### MCP SSE Response Parsing

MCP StreamableHTTP returns `text/event-stream` (Server-Sent Events), not JSON. Tests parse SSE using:

```typescript
function parseSSEResponse(text: string): any {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      return JSON.parse(line.substring(6));
    }
  }
  return null;
}
```

**Usage in tests:**
```typescript
const response = await request(app).post('/mcp').send(mcpRequest);
const parsed = parseSSEResponse(response.text);
expect(parsed.jsonrpc).toBe('2.0');
```

### BigInt JSON Serialization

Agent Card contains `tokenId: bigint` which cannot be serialized with `JSON.stringify()`. Tests verify proper handling:

```typescript
const agentCard = generateAgentCard();
expect(() => JSON.stringify(agentCard)).toThrow(); // BigInt not allowed

// Instead, use custom serialization in handler
const serialized = serializeAgentCard(agentCard);
expect(JSON.parse(serialized).tokenId).toBe(agentCard.tokenId.toString());
```

### TEE Routing in TaskWorker

`TaskWorker` routes proofs through `TeeProvider` when `teeMode !== 'disabled'`, otherwise falls back to `BbProver`:

```typescript
describe('TaskWorker proof generation', () => {
  it('routes through TEE when enabled', async () => {
    const config = { ...mockConfig, teeMode: 'local' };
    const worker = new TaskWorker(config, teeProvider, bbProver);

    await worker.prove(task);

    expect(teeProvider.prove).toHaveBeenCalled();
    expect(bbProver.prove).not.toHaveBeenCalled();
  });

  it('falls back to BbProver when disabled', async () => {
    const config = { ...mockConfig, teeMode: 'disabled' };
    const worker = new TaskWorker(config, teeProvider, bbProver);

    await worker.prove(task);

    expect(teeProvider.prove).not.toHaveBeenCalled();
    expect(bbProver.prove).toHaveBeenCalled();
  });

  it('handles TEE errors gracefully', async () => {
    const config = { ...mockConfig, teeMode: 'local' };
    teeProvider.prove.mockRejectedValue(new Error('TEE unavailable'));
    const worker = new TaskWorker(config, teeProvider, bbProver);

    const result = await worker.prove(task);

    expect(result.error).toBe('TEE unavailable');
  });
});
```

### Environment Variable Mocking

Tests isolate environment variable state using `beforeEach`/`afterEach`:

```typescript
describe('Config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws if REDIS_URL is missing', () => {
    delete process.env.REDIS_URL;
    expect(() => loadConfig()).toThrow(/REDIS_URL/);
  });
});
```

### Crypto Operations in Tests

Real crypto is used for encryption tests, but signature verification is mocked:

```typescript
describe('TEE Encryption', () => {
  it('encrypts and decrypts data with AES-256-GCM', () => {
    const plaintext = 'sensitive data';
    const key = crypto.randomBytes(32);

    const encrypted = encryptAES256GCM(plaintext, key);
    const decrypted = decryptAES256GCM(encrypted, key);

    expect(decrypted).toBe(plaintext);
  });
});

describe('TEE Attestation', () => {
  it('parses COSE_Sign1 structure (real crypto)', () => {
    // Real CBOR/COSE parsing
    const cose = parseCOSE(attestationBytes);
    expect(cose.payload).toBeDefined();
  });

  it('verifies attestation signature (mocked)', () => {
    // Signature verification mocked to avoid real cryptography
    vi.mock('crypto', () => ({
      verify: vi.fn(() => true),
    }));
  });
});
```

## Running Tests in CI/CD

Tests are designed to run in CI without Docker, Redis, or blockchain nodes:

```bash
# Run all tests with JUnit XML output (for CI/CD integration)
npx vitest run --reporter=junit --outputFile=test-results.xml

# Run with coverage
npx vitest run --coverage

# Run with specific configuration
npx vitest run --config=vitest.config.ts
```

**CI Environment:**
- No Docker required
- No external services required
- All dependencies mocked
- Fast execution (1.6s total)
- Clean test isolation

## Troubleshooting

### "Cannot find module" Errors

**Problem:** Tests fail with "Cannot find module" when running.

**Solution:** Build TypeScript first, or use `npx vitest` which handles TypeScript natively:
```bash
npm run build        # Compile TypeScript
npm run test         # Run tests against compiled JS

# OR

npx vitest run       # Run tests with TypeScript transpilation
```

### Timeout on Attestation Tests

**Problem:** `attestation.test.ts` takes ~1.3 seconds.

**Expected:** Crypto operations (COSE/CBOR parsing, signature verification) are CPU-intensive. This is normal and acceptable.

**Not a timeout:** Vitest default timeout is 5 seconds, so this is fine.

### Mock Ordering Issues

**Problem:** Mock is not being used by a module.

**Solution:** Vitest hoists `vi.mock()` calls to the top of the file. Ensure mocks are declared BEFORE any imports:

```typescript
// CORRECT
vi.mock('ioredis', () => ({ /* mock */ }));
import { Redis } from 'ioredis'; // Uses mocked version

// WRONG
import { Redis } from 'ioredis'; // Uses real module
vi.mock('ioredis', () => ({ /* mock */ })); // Too late!
```

### SSE Parsing in E2E Tests

**Problem:** MCP responses come as `text/event-stream`, not JSON.

**Solution:** Use SSE parser before accessing response data:

```typescript
// WRONG
const data = response.body; // Returns stream buffer

// CORRECT
const parsed = parseSSEResponse(response.text);
expect(parsed.jsonrpc).toBe('2.0');
```

### BigInt Serialization Errors

**Problem:** `JSON.stringify()` fails on objects with `bigint` values.

**Solution:** Use custom serializer or convert to string first:

```typescript
// WRONG
const json = JSON.stringify(agentCard); // Error: bigint not serializable

// CORRECT
const serialized = {
  ...agentCard,
  tokenId: agentCard.tokenId.toString(),
};
const json = JSON.stringify(serialized);
```

## Coverage

To generate a coverage report:

```bash
npx vitest run --coverage
```

This generates:
- Terminal report showing line/branch/function coverage
- HTML report at `coverage/index.html`
- LCOV report for CI integration

## Test Maintenance

### Adding New Tests

1. Create test file in appropriate directory (match module structure)
2. Import unit under test and mocks needed
3. Mock external dependencies at file top (before imports)
4. Use descriptive test names (`it('should X when Y')`)
5. Keep each test focused on one behavior
6. Use `beforeEach`/`afterEach` for setup/teardown

### Updating Mocks

If a dependency changes:
1. Update the mock in the test file (`vi.mock(...)`)
2. Verify all tests still pass
3. Update related integration/E2E tests if needed

### Removing Obsolete Tests

If a feature is removed:
1. Remove test file or specific tests
2. Update this documentation
3. Run test suite to verify no breakage

## Performance

**Test Runtime Breakdown:**
- Unit tests: ~400ms (isolated, no I/O)
- Integration tests: ~600ms (app creation, module interaction)
- E2E tests: ~600ms (HTTP requests, full flow)
- **Total: ~1.6 seconds**

**Optimization strategies:**
- Mocks are in-memory (no network latency)
- Parallel test execution (Vitest default)
- No database operations
- No external service calls

## Resources

- **Vitest Documentation:** https://vitest.dev
- **Configuration:** `vitest.config.ts` in project root
- **Test Utilities:** `tests/helpers/` (if any custom utilities exist)
- **Agent Context:** `.claude/agents/ai-dev.md` for development guidelines
