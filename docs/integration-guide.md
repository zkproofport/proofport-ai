# ZKProofport AI Integration Guide

## 개요 (Overview)

ZKProofport AI는 Coinbase KYC 및 거주국 인증의 영지식 증명(zero-knowledge proof)을 생성하는 에이전트 서비스입니다. Noir 회로를 AWS Nitro Enclave(TEE)에서 실행하며, 모든 증명 입력은 X25519 ECDH + AES-256-GCM으로 E2E 암호화됩니다.

### 지원 프로토콜

| 프로토콜 | 용도 | Endpoint |
|----------|------|----------|
| **MCP (Remote)** | Claude Desktop, Claude Code, Cursor 등 MCP 호환 AI 도구 | `POST /mcp` (StreamableHTTP) |
| **MCP (Local)** | 로컬 실행 MCP 서버 (npm 패키지) | stdio |
| **REST API** | GPT Actions, 직접 HTTP 연동 | `/api/v1/*` |
| **A2A** | Google ADK, 멀티 에이전트 시스템 | `POST /a2a` (JSON-RPC v0.3) |

### Base URLs

| 환경 | URL |
|------|-----|
| Staging (Base Sepolia) | `https://stg-ai.zkproofport.app` |
| Production (Base Mainnet) | `https://ai.zkproofport.app` |

---

## 사용 가능한 도구 (Available Tools)

모든 프로토콜에서 제공하는 3가지 도구:

### 1. `get_supported_circuits`

사용 가능한 회로 목록을 조회합니다. **무료.**

- 반환값: 회로 ID, 표시 이름, 설명, 필수 입력, EAS schema ID, verifier 주소, guide URL
- 증명 생성 전 반드시 이 도구를 먼저 호출하세요.

**회로 목록:**

| Circuit Alias | Canonical ID | 설명 | EAS Schema ID |
|---------------|-------------|------|---------------|
| `coinbase_kyc` | `coinbase_attestation` | Coinbase KYC 인증 증명 | `0xf8b05c...0de9` |
| `coinbase_country` | `coinbase_country_attestation` | 거주국 증명 (포함/배제 리스트) | `0x180190...a065` |

### 2. `get_guide`

특정 회로의 입력 준비에 필요한 상세 가이드를 반환합니다. **무료.**

- 파라미터: `circuit` — `"coinbase_kyc"` 또는 `"coinbase_country"`
- 반환값: 상수, 공식, 입력 스키마, SDK 사용법, 코드 예제

**반드시 `prove` 호출 전에 가이드를 읽으세요.** 가이드에는 signal_hash, nullifier, scope_bytes, merkle_root 계산법, EAS GraphQL 쿼리, RLP 인코딩, secp256k1 공개키 복구, Merkle proof 구성법이 포함되어 있습니다.

### 3. `prove`

ZK 증명 생성을 요청합니다. **유료 ($0.10 USDC).**

MCP 도구 호출은 타임아웃 제한이 있어 30-90초 소요되는 증명 생성에 적합하지 않습니다. MCP `prove` 도구는 REST endpoint로의 리다이렉트 안내를 반환합니다. 실제 증명 생성은 REST API(`POST /api/v1/prove`)를 직접 사용하세요.

---

## MCP Integration

### Remote MCP Server (서버 호스팅)

Claude Desktop (`claude_desktop_config.json`) 또는 Claude Code (`.mcp.json`) 설정:

```json
{
  "mcpServers": {
    "zkproofport-prover": {
      "url": "https://stg-ai.zkproofport.app/mcp"
    }
  }
}
```

**프로토콜:** StreamableHTTP (stateless mode)
- `POST /mcp` — 도구 호출 (StreamableHTTP)
- `GET /mcp` — 405 (SSE 미지원, stateless 모드)
- `DELETE /mcp` — 405 (세션 관리 미지원)

설정만 추가하면 Claude가 MCP 프로토콜을 통해 자동으로 3개 도구(`prove`, `get_supported_circuits`, `get_guide`)를 발견합니다.

### Local MCP Server (npm 패키지)

`@zkproofport-ai/mcp` 패키지로 로컬에서 MCP 서버를 실행합니다. 로컬 MCP 서버는 입력 준비, 결제, 증명 제출을 모두 자동으로 처리합니다.

```bash
npm install @zkproofport-ai/mcp
```

Claude Desktop 설정:

```json
{
  "mcpServers": {
    "zkproofport": {
      "command": "npx",
      "args": ["@zkproofport-ai/mcp"],
      "env": {
        "ATTESTATION_KEY": "0x... (Coinbase EAS 인증이 있는 지갑의 개인키)",
        "PAYMENT_KEY": "0x... (USDC 잔고가 있는 지갑의 개인키, 선택사항)",
        "PROOFPORT_URL": "https://stg-ai.zkproofport.app"
      }
    }
  }
}
```

**Local MCP 도구 목록** (Remote MCP와 다릅니다):

| 도구 | 설명 |
|------|------|
| `generate_proof` | All-in-one: 입력 준비 → 402 챌린지 → 결제 → 증명 제출을 한 번에 수행 |
| `get_supported_circuits` | 지원 회로 목록 조회 |
| `prepare_inputs` | Step 1: 회로 입력 준비 (EAS 쿼리, 서명, Merkle proof 구성) |
| `request_challenge` | Step 2: 402 결제 챌린지 요청 |
| `make_payment` | Step 3: x402 facilitator를 통해 USDC 결제 |
| `submit_proof` | Step 4: 결제 헤더와 함께 증명 생성 요청 |
| `verify_proof` | (선택) 온체인 증명 검증 |

**환경 변수:**

| 변수 | 필수 | 설명 |
|------|------|------|
| `ATTESTATION_KEY` | Yes | Coinbase EAS 인증이 있는 지갑의 개인키 |
| `PAYMENT_KEY` | No | USDC 잔고가 있는 지갑의 개인키 (없으면 ATTESTATION_KEY 사용) |
| `PROOFPORT_URL` | No | 서버 URL (기본값: production) |
| `CDP_API_KEY_ID` | No | Coinbase Developer Platform API 키 ID (CDP MCP 지갑 사용 시) |
| `CDP_API_KEY_SECRET` | No | CDP API 키 시크릿 |
| `CDP_WALLET_SECRET` | No | CDP 지갑 암호화 시크릿 |
| `CDP_WALLET_ADDRESS` | No | 기존 CDP 지갑 주소 재사용 |

---

## REST API (GPT Actions)

### OpenAPI Spec

OpenAPI 3.1.0 스펙은 각 환경에서 제공됩니다:

- Staging: `https://stg-ai.zkproofport.app/openapi.json`
- Production: `https://ai.zkproofport.app/openapi.json`
- Swagger UI: `https://stg-ai.zkproofport.app/docs`

### ChatGPT Custom GPT 설정

1. [ChatGPT GPT Editor](https://chatgpt.com/gpts/editor)에서 새 GPT 생성
2. "Actions" 탭에서 "Import from URL" 클릭
3. URL 입력: `https://stg-ai.zkproofport.app/openapi.json`
4. Authentication: None (x402 결제는 요청 내에서 처리)

### REST Endpoints

| Method | Path | 설명 |
|--------|------|------|
| `GET` | `/api/v1/circuits` | 지원 회로 목록 |
| `POST` | `/api/v1/prove` | x402 single-step 증명 생성 (아래 상세) |
| `GET` | `/api/v1/guide/:circuit` | 회로별 상세 가이드 |
| `POST` | `/api/v1/proofs` | Web signing flow (GPT Actions용, 아래 상세) |
| `GET` | `/api/v1/proofs/:taskId` | 증명 생성 상태 조회 |
| `POST` | `/api/v1/proofs/verify` | 온체인 증명 검증 |
| `GET` | `/health` | 서버 상태 확인 |

---

## A2A Integration

### Agent Card

A2A v0.3 Agent Card는 `/.well-known/agent-card.json`에서 제공됩니다:

```
GET https://stg-ai.zkproofport.app/.well-known/agent-card.json
```

Agent Card에는 3개 skill(`prove`, `get_supported_circuits`, `get_guide`), provider 정보, 가이드 URL, ERC-8004 identity, TEE 정보가 포함됩니다.

### Google ADK 연결

```python
from google.adk.tools.a2a_tool import A2ATool

agent_card_url = "https://stg-ai.zkproofport.app/.well-known/agent-card.json"
zkproofport_tool = A2ATool.from_agent_card_url(agent_card_url)
```

### A2A Endpoint

```
POST https://stg-ai.zkproofport.app/a2a
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "method": "tasks/send",
  "id": "1",
  "params": {
    "id": "task-uuid",
    "message": {
      "role": "user",
      "parts": [
        { "kind": "data", "data": { "skill": "get_supported_circuits" } }
      ]
    }
  }
}
```

**Data part로 skill을 직접 지정하거나**, 텍스트 메시지를 보내면 LLM이 자동으로 skill을 라우팅합니다:

```json
{
  "parts": [
    { "kind": "text", "text": "What circuits do you support?" }
  ]
}
```

---

## x402 Payment Flow (POST /api/v1/prove)

모든 입력을 클라이언트가 준비하고 직접 제출하는 프로그래매틱 플로우입니다. SDK나 로컬 MCP를 사용하면 이 과정이 자동으로 처리됩니다.

### Step 1: 402 챌린지 요청

결제 없이 circuit만 포함하여 요청합니다:

```http
POST /api/v1/prove
Content-Type: application/json

{
  "circuit": "coinbase_kyc"
}
```

서버가 402 응답을 반환합니다:

```json
{
  "error": "PAYMENT_REQUIRED",
  "message": "Send payment and retry with X-Payment-TX and X-Payment-Nonce headers",
  "nonce": "0x7f3a...(32 bytes)",
  "payment": {
    "scheme": "exact",
    "network": "base-sepolia",
    "maxAmountRequired": "100000",
    "resource": "https://stg-ai.zkproofport.app/api/v1/prove",
    "description": "ZK proof generation fee (0.10 USDC)",
    "payTo": "0x5A3E649208Ae15ec52496c1Ae23b2Ff89Ac02f0c",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "extra": {
      "name": "USDC",
      "version": "2",
      "nonce": "0x7f3a..."
    }
  },
  "teePublicKey": {
    "publicKey": "<X25519 hex>",
    "keyId": "...",
    "attestationDocument": "..."
  }
}
```

**참고:**
- `nonce`는 일회용이며 5분 내 만료됩니다.
- `nonce`는 circuit에 바인딩됩니다 (`coinbase_kyc`용 nonce를 `coinbase_country`에 사용 불가).
- `teePublicKey`는 TEE(nitro) 모드에서만 반환됩니다. E2E 암호화에 사용합니다.
- `PAYMENT-REQUIRED` 응답 헤더에도 base64 인코딩된 결제 요구사항이 포함됩니다.

### Step 2: USDC 결제

x402 facilitator를 통해 EIP-3009 `TransferWithAuthorization`으로 결제합니다. Facilitator가 가스비를 대납합니다.

**x402 Facilitator:** `https://www.x402.org/facilitator`
**Settle Endpoint:** `https://www.x402.org/facilitator/settle`

EIP-712 서명 domain:

```javascript
const domain = {
  name: "USDC",           // Base Sepolia. Base Mainnet은 "USD Coin"
  version: "2",
  chainId: 84532,         // Base Sepolia. Base Mainnet은 8453
  verifyingContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e"  // USDC 주소
};

const types = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" }
  ]
};

const message = {
  from: payerAddress,
  to: payment.payTo,              // "0x5A3E..."
  value: 100000,                   // $0.10 USDC (6 decimals)
  validAfter: 0,
  validBefore: Math.floor(Date.now() / 1000) + 3600,
  nonce: ethers.zeroPadValue(payment.nonce, 32)
};
```

Facilitator settle 호출:

```javascript
const settlePayload = {
  x402Version: 1,
  scheme: "exact",
  network: "base-sepolia",
  paymentPayload: {
    x402Version: 1,
    scheme: "exact",
    network: "base-sepolia",
    payload: {
      signature: eip712Signature,
      authorization: { from, to, value, validAfter, validBefore, nonce }
    }
  },
  paymentRequirements: {
    scheme: "exact",
    network: "base-sepolia",
    maxAmountRequired: "100000",
    asset: usdcAddress,
    payTo: payment.payTo,
    // ...
  }
};

const res = await fetch("https://www.x402.org/facilitator/settle", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(settlePayload)
});
const { txHash } = await res.json();
```

### Step 3: 증명 생성 요청

동일한 body에 `inputs`(또는 `encrypted_payload`)를 추가하고, 결제 헤더를 포함하여 재요청합니다:

```http
POST /api/v1/prove
Content-Type: application/json
X-Payment-TX: 0x<transaction_hash>
X-Payment-Nonce: 0x7f3a...(Step 1에서 받은 nonce)

{
  "circuit": "coinbase_kyc",
  "inputs": {
    "signal_hash": "0x...",
    "nullifier": "0x...",
    "scope_bytes": "0x...",
    "merkle_root": "0x...",
    "user_address": "0x...",
    "signature": "0x...",
    "user_pubkey_x": "0x...",
    "user_pubkey_y": "0x...",
    "raw_transaction": "0x...",
    "tx_length": 185,
    "coinbase_attester_pubkey_x": "0x...",
    "coinbase_attester_pubkey_y": "0x...",
    "merkle_proof": ["0x...", "0x..."],
    "leaf_index": 0,
    "depth": 2
  }
}
```

**TEE(nitro) 모드에서는 E2E 암호화 필수:** plaintext `inputs` 대신 `encrypted_payload`를 사용합니다.

```json
{
  "circuit": "coinbase_kyc",
  "encrypted_payload": {
    "ephemeralPublicKey": "...",
    "iv": "...",
    "ciphertext": "...",
    "authTag": "...",
    "keyId": "..."
  }
}
```

### 응답

```json
{
  "proof": "0x...",
  "publicInputs": "0x...",
  "proofWithInputs": "0x...",
  "attestation": {
    "document": "<base64 COSE Sign1>",
    "proof_hash": "0x...",
    "verification": {
      "rootCaValid": true,
      "chainValid": true,
      "signatureValid": true,
      "pcrs": { "0": "0x...", "1": "0x...", "2": "0x..." }
    }
  },
  "timing": {
    "totalMs": 45000,
    "paymentVerifyMs": 2000,
    "inputBuildMs": 100,
    "proveMs": 42000
  },
  "verification": {
    "chainId": 84532,
    "verifierAddress": "0x0036B61dBFaB8f3CfEEF77dD5D45F7EFBFE2035c",
    "rpcUrl": "https://..."
  }
}
```

### USDC 주소

| 네트워크 | Chain ID | USDC 주소 | EIP-712 Domain Name |
|----------|----------|-----------|---------------------|
| Base Sepolia (testnet) | 84532 | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `USDC` |
| Base Mainnet | 8453 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `USD Coin` |

### Verifier Contracts (Base Sepolia)

| Circuit | Verifier Address |
|---------|-----------------|
| `coinbase_attestation` (`coinbase_kyc`) | `0x0036B61dBFaB8f3CfEEF77dD5D45F7EFBFE2035c` |
| `coinbase_country_attestation` (`coinbase_country`) | `0xdEe363585926c3c28327Efd1eDd01cf4559738cf` |

온체인 검증: `verifier.verify(proof, publicInputs)` 호출. `publicInputs`는 hex blob을 32-byte chunks로 분할하여 `bytes32[]`로 전달합니다.

---

## Web Signing Flow (POST /api/v1/proofs)

프로그래매틱으로 지갑에 접근할 수 없는 최종 사용자를 위한 플로우입니다. GPT Actions(ChatGPT Custom GPT)에서 주로 사용합니다.

### Mode 1: Web Signing (서명 URL 생성)

```http
POST /api/v1/proofs
Content-Type: application/json

{
  "circuitId": "coinbase_attestation",
  "scope": "my-dapp.example.com"
}
```

응답:

```json
{
  "taskId": "task-uuid-123",
  "state": "input-required",
  "signingUrl": "https://stg-ai.zkproofport.app/s/22d302e0-...",
  "requestId": "22d302e0-...",
  "message": "Please sign at the signing URL to continue"
}
```

사용자가 `signingUrl`을 브라우저에서 열고, 지갑을 연결하여 서명합니다.

### Mode 2: 서명 후 증명 재개

사용자가 서명을 완료한 뒤, `requestId`를 포함하여 다시 요청합니다:

```http
POST /api/v1/proofs
Content-Type: application/json

{
  "circuitId": "coinbase_attestation",
  "scope": "my-dapp.example.com",
  "requestId": "22d302e0-..."
}
```

응답 (증명 생성 완료):

```json
{
  "taskId": "task-uuid-456",
  "state": "completed",
  "proof": "0x...",
  "publicInputs": "0x...",
  "nullifier": "0x...",
  "signalHash": "0x..."
}
```

### Mode 3: Direct Signing

클라이언트가 이미 `address`와 `signature`를 가지고 있으면 직접 제출 가능합니다:

```http
POST /api/v1/proofs
Content-Type: application/json

{
  "circuitId": "coinbase_attestation",
  "scope": "my-dapp.example.com",
  "address": "0xD6C714247037E5201B7e3dEC97a3ab59a9d2F739",
  "signature": "0x1234...abcd"
}
```

### 상태 조회

```http
GET /api/v1/proofs/{taskId}
```

Task states: `submitted`, `running`, `input-required`, `completed`, `failed`, `canceled`

### 온체인 검증

```http
POST /api/v1/proofs/verify
Content-Type: application/json

{
  "circuitId": "coinbase_attestation",
  "proof": "0x...",
  "publicInputs": ["0x000...001", "0x58ee..."]
}
```

---

## SDK 사용법

### 설치

```bash
npm install @zkproofport-ai/sdk ethers
```

또는 repository에서 직접:

```bash
git clone https://github.com/zkproofport/proofport-ai.git
cd proofport-ai && npm install && npx tsc -p packages/sdk
```

### Quick Start

```typescript
import { generateProof, fromPrivateKey } from '@zkproofport-ai/sdk';

// Coinbase EAS 인증이 있는 지갑
const attestationSigner = fromPrivateKey('0x...');

// USDC 잔고가 있는 지갑 (선택, 없으면 attestationSigner 사용)
const paymentSigner = fromPrivateKey('0x...');

const result = await generateProof(
  { baseUrl: 'https://stg-ai.zkproofport.app' },
  { attestation: attestationSigner, payment: paymentSigner },
  { circuit: 'coinbase_kyc', scope: 'proofport' },
);

console.log(result.proof);           // ZK proof hex
console.log(result.publicInputs);    // public inputs hex
console.log(result.proofWithInputs); // 온체인 검증용 결합 데이터
```

### CLI 실행

```bash
git clone https://github.com/zkproofport/proofport-ai.git
cd proofport-ai && npm install && npx tsc -p packages/sdk

ATTESTATION_KEY=0x... \
PAYMENT_KEY=0x... \
SERVER_URL=https://stg-ai.zkproofport.app \
npx tsx packages/sdk/examples/full-flow.ts
```

### Step-by-Step SDK 사용

```typescript
import {
  prepareInputs,
  requestChallenge,
  makePayment,
  submitProof,
  verifyProof,
  computeSignalHash,
  fromPrivateKey,
  CIRCUIT_NAME_MAP,
} from '@zkproofport-ai/sdk';

const config = { baseUrl: 'https://stg-ai.zkproofport.app' };
const signer = fromPrivateKey('0x...');
const paymentSigner = fromPrivateKey('0x...');

// Step 1: 입력 준비
const userAddress = await signer.getAddress();
const signalHash = computeSignalHash(userAddress, 'proofport', 'coinbase_attestation');
const userSignature = await signer.signMessage(signalHash);

const inputs = await prepareInputs(config, {
  circuitId: 'coinbase_attestation',
  userAddress,
  userSignature,
  scope: 'proofport',
});

// Step 2: 402 챌린지 요청
const challenge = await requestChallenge(config, 'coinbase_kyc', inputs);

// Step 3: x402 결제
const txHash = await makePayment(paymentSigner, challenge.payment);

// Step 4: 증명 생성
const result = await submitProof(config, {
  circuit: 'coinbase_kyc',
  inputs,
  paymentTxHash: txHash,
  paymentNonce: challenge.nonce,
});

// Step 5 (선택): 온체인 검증
const verification = await verifyProof(result);
console.log(verification); // { valid: true }
```

---

## Discovery Endpoints

| Endpoint | 용도 | Content-Type |
|----------|------|--------------|
| `/.well-known/agent.json` | OASF Agent Discovery (ERC-8004) | `application/json` |
| `/.well-known/agent-card.json` | A2A Agent Card (v0.3) | `application/json` |
| `/.well-known/oasf.json` | OASF Agent Discovery (alias) | `application/json` |
| `/.well-known/mcp.json` | MCP Server Discovery | `application/json` |
| `/.well-known/SKILL.md` | Base ecosystem SKILL.md | `text/markdown` |
| `/openapi.json` | OpenAPI 3.1.0 Specification | `application/json` |
| `/docs` | Swagger UI | `text/html` |

### MCP Discovery (`/.well-known/mcp.json`)

```json
{
  "protocolVersion": "2025-11-25",
  "serverInfo": {
    "name": "proveragent.base.eth",
    "version": "..."
  },
  "tools": [
    { "name": "prove", "description": "..." },
    { "name": "get_supported_circuits", "description": "..." },
    { "name": "get_guide", "description": "..." }
  ]
}
```

### A2A Agent Card (`/.well-known/agent-card.json`)

```json
{
  "name": "proveragent.base.eth",
  "url": "https://stg-ai.zkproofport.app/a2a",
  "version": "...",
  "protocolVersion": "0.3.0",
  "skills": [
    { "id": "prove", "name": "Generate ZK Proof" },
    { "id": "get_supported_circuits", "name": "Get Supported Circuits" },
    { "id": "get_guide", "name": "Get Circuit Guide" }
  ],
  "guides": {
    "coinbase_kyc": "https://stg-ai.zkproofport.app/api/v1/guide/coinbase_kyc",
    "coinbase_country": "https://stg-ai.zkproofport.app/api/v1/guide/coinbase_country"
  },
  "identity": {
    "erc8004": { "contractAddress": "0x8004A818...", "chainId": 84532 }
  }
}
```

---

## Authorized Coinbase Attesters

Merkle proof 구성에 필요한 인증된 Coinbase attester 주소 목록:

| Index | Address |
|-------|---------|
| 0 | `0x952f32128AF084422539C4Ff96df5C525322E564` |
| 1 | `0x8844591D47F17bcA6F5dF8f6B64F4a739F1C0080` |
| 2 | `0x88fe64ea2e121f49bb77abea6c0a45e93638c3c5` |
| 3 | `0x44ace9abb148e8412ac4492e9a1ae6bd88226803` |

---

## EAS (Ethereum Attestation Service)

EAS 인증은 **항상 Base Mainnet** (chain ID 8453)에 있습니다. 결제 네트워크와 무관합니다.

| 항목 | 값 |
|------|-----|
| EAS GraphQL (Base) | `https://base.easpcan.org/graphql` |
| EAS GraphQL (Base Sepolia) | `https://base-sepolia.easpcan.org/graphql` |
| KYC Schema ID | `0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9` |
| Country Schema ID | `0x1801901fabd0e6189356b4fb52bb0ab855276d84f7ec140839fbd1f6801ca065` |

---

## Error Codes

| HTTP Status | Error Code | 설명 |
|-------------|-----------|------|
| 400 | `INVALID_REQUEST` | 필수 필드 누락 |
| 400 | `INVALID_CIRCUIT` | 알 수 없는 circuit 이름 |
| 400 | `MISSING_NONCE` | `X-Payment-TX` 있으나 `X-Payment-Nonce` 누락 |
| 400 | `INVALID_NONCE` | nonce 만료 또는 미존재 |
| 400 | `NONCE_CIRCUIT_MISMATCH` | nonce가 다른 circuit용으로 발급됨 |
| 400 | `PLAINTEXT_REJECTED` | TEE(nitro) 모드에서 plaintext 입력 거부 |
| 400 | `E2E_REQUIRES_TEE` | E2E payload 제출했으나 TEE 미활성화 |
| 402 | `PAYMENT_REQUIRED` | 결제 필요 (nonce 반환) |
| 402 | `PAYMENT_INVALID` | 결제 검증 실패 (tx 미발견, 금액 부족 등) |
| 409 | `KEY_ROTATED` | TEE 키 갱신됨, 새 공개키 필요 |
| 500 | `PROVE_FAILED` | 증명 생성 실패 |
