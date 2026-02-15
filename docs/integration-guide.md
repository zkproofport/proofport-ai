# ZKProofport AI Integration Guide

## 개요 (Overview)

ZKProofport는 다양한 프로토콜을 통해 영지식 증명(zero-knowledge proof) 생성 및 검증 기능을 제공합니다:

- **MCP (Model Context Protocol)** — Claude, Cursor, Windsurf 및 기타 MCP 호환 AI 도구용
- **REST API** — GPT Actions (OpenAI), 직접 HTTP 연동용
- **A2A (Agent-to-Agent)** — Google ADK (Gemini), 멀티 에이전트 시스템용
- **Chat API** — Telegram 봇, Discord 봇, 커스텀 챗봇용

Base URLs:
- Staging: `https://stg-ai.zkproofport.app`
- Production: `https://ai.zkproofport.app`

## 사용 가능한 도구/기능 (Available Tools/Skills)

모든 프로토콜에서 제공하는 3가지 핵심 기능:

1. `generate_proof` — ZK 증명 생성 (x402 결제 필요: $0.10 USDC)
2. `verify_proof` — 온체인 증명 검증 (x402 결제 필요: $0.10 USDC)
3. `get_supported_circuits` — 사용 가능한 회로 목록 조회 (무료)

## Discovery Endpoints

| Endpoint | 용도 |
|----------|------|
| `/.well-known/agent.json` | OASF Agent Discovery (ERC-8004) |
| `/.well-known/agent-card.json` | A2A Agent Card (v0.3) |
| `/.well-known/mcp.json` | MCP Server Discovery |
| `/openapi.json` | OpenAPI 3.0.3 Specification |

---

## 1. Claude MCP Integration

### 1.1 Claude Desktop / Claude Code 설정

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

설정만 추가하면 Claude가 MCP 프로토콜을 통해 자동으로 도구를 발견합니다.

### 1.2 MCP 프로토콜 상세 정보

**Transport:** StreamableHTTP (stateless mode)
**Endpoint:** `POST /mcp`
**필수 헤더:**
```
Content-Type: application/json
Accept: application/json, text/event-stream
```

**사용 가능한 메서드:**

| Method | 설명 |
|--------|------|
| `initialize` | MCP 세션 초기화 |
| `tools/list` | 사용 가능한 도구 목록 조회 |
| `tools/call` | 도구 호출 |

### 1.3 MCP Tool: get_supported_circuits

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "get_supported_circuits",
    "arguments": {}
  }
}
```

**응답 예시:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "사용 가능한 회로:\n1. coinbase_attestation (Coinbase KYC)\n2. coinbase_country_attestation (Coinbase Country)"
      }
    ]
  }
}
```

### 1.4 MCP Tool: generate_proof

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "generate_proof",
    "arguments": {
      "circuitId": "coinbase_attestation",
      "scope": "my-dapp-scope",
      "address": "0xD6C714247037E5201B7e3dEC97a3ab59a9d2F739",
      "signature": "0x..."
    }
  }
}
```

**참고:** `address`와 `signature`는 선택적 필드입니다. 제공하지 않으면 응답에 `signingUrl`이 포함되며, 사용자는 해당 URL에서 지갑 서명을 완료해야 합니다.

**응답 (input-required 상태):**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "증명 생성 요청이 생성되었습니다. 다음 URL에서 지갑 서명을 완료하세요:\n\nhttps://stg-ai.zkproofport.app/s/abc-123-def\n\nTask ID: abc-123-def"
      }
    ]
  }
}
```

**응답 (증명 완료 시):**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "증명이 성공적으로 생성되었습니다.\n\nProof: 0x...\nPublic Inputs: [\"0x...\"]\nCircuit: coinbase_attestation"
      }
    ]
  }
}
```

### 1.5 MCP Tool: verify_proof

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "verify_proof",
    "arguments": {
      "proof": "0x...",
      "publicInputs": ["0x..."],
      "circuitId": "coinbase_attestation"
    }
  }
}
```

**응답:**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "증명 검증 완료:\n\n유효성: true\nVerifier Contract: 0x1234567890abcdef...\nChain: Base Sepolia (84532)"
      }
    ]
  }
}
```

### 1.6 x402 결제 (Payment) 처리

모든 MCP `tools/call` 요청은 x402 결제가 필요합니다 (무료 도구 제외). MCP 클라이언트는 402 응답을 다음과 같이 처리해야 합니다:

1. **첫 번째 요청:** 402 응답 + `payment-required` 헤더 수신
2. **클라이언트:** EIP-3009 USDC authorization 서명 생성
3. **재시도:** `PAYMENT-SIGNATURE` 헤더 (base64 인코딩)와 함께 요청 재전송

**무료 도구 (결제 불필요):**
- `get_supported_circuits` — 회로 목록 조회는 항상 무료

**유료 도구 ($0.10 USDC):**
- `generate_proof` — 증명 생성
- `verify_proof` — 증명 검증

### 1.7 Cursor / Windsurf Integration

동일한 MCP 설정을 사용합니다. Cursor 설정 또는 Windsurf MCP 설정에 추가:

```json
{
  "mcpServers": {
    "zkproofport": {
      "url": "https://stg-ai.zkproofport.app/mcp"
    }
  }
}
```

### 1.8 프로그래밍 방식 MCP 클라이언트 (Node.js)

```javascript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(
  new URL('https://stg-ai.zkproofport.app/mcp')
);
const client = new Client({ name: 'my-app', version: '1.0.0' }, {});
await client.connect(transport);

// 도구 목록 조회
const { tools } = await client.listTools();
console.log('사용 가능한 도구:', tools.map(t => t.name));
// 출력: ['get_supported_circuits', 'generate_proof', 'verify_proof']

// 도구 호출
const result = await client.callTool({
  name: 'get_supported_circuits',
  arguments: {}
});
console.log(result);
```

**x402 결제 통합 예시:**

```javascript
import { ExactEvmScheme } from '@x402/evm';
import { x402Client, x402HTTPClient } from '@x402/fetch';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

// 지불자 지갑 설정
const account = privateKeyToAccount('0x_YOUR_PRIVATE_KEY');
const walletClient = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http()
});

// x402 signer 생성
const signer = {
  address: account.address,
  signTypedData: (args) => walletClient.signTypedData(args)
};

// x402 클라이언트 등록
const x402client = new x402Client();
x402client.register('eip155:84532', new ExactEvmScheme(signer));
const httpClient = new x402HTTPClient(x402client);

// MCP 요청 시 x402 결제 자동 처리
// (MCP SDK에 x402 미들웨어 추가 필요 - 현재 표준 지원 없음)
```

---

## 2. GPT Actions (OpenAI) Integration

### 2.1 개요

GPT Actions는 OpenAPI 명세를 사용하여 사용 가능한 액션을 정의합니다. ZKProofport는 `/openapi.json` 엔드포인트를 제공합니다.

### 2.2 ZKProofport를 사용하는 Custom GPT 생성

**Step 1: ChatGPT → Explore GPTs → Create 이동**

**Step 2: Actions 설정**
1. "Create new action" 클릭
2. URL에서 스키마 가져오기: `https://stg-ai.zkproofport.app/openapi.json`
3. 모든 REST 엔드포인트 자동 임포트 완료

**Step 3: 인증(Authentication) 설정**
- Authentication type: None (x402 결제가 헤더를 통해 인증 처리)

**Step 4: GPT 시스템 프롬프트 설정**

```
당신은 ZKProofport로 구동되는 영지식 증명 어시스턴트입니다. 다음 기능을 제공합니다:

1. GET /api/v1/circuits를 사용하여 지원되는 ZK 회로 목록 조회
2. POST /api/v1/proofs를 사용하여 영지식 증명 생성
3. POST /api/v1/proofs/verify를 사용하여 온체인 증명 검증
4. GET /api/v1/proofs/{taskId}를 사용하여 증명 상태 확인

사용자가 증명 생성을 요청하면, 먼저 사용 가능한 회로를 나열한 후 필요한 입력값(circuitId, scope)을 요청하세요. 증명 생성은 signingUrl을 반환하며, 사용자는 해당 URL에서 지갑 서명을 완료해야 합니다.

사용 가능한 회로:
- coinbase_attestation: Coinbase KYC 증명 (신원 비공개)
- coinbase_country_attestation: Coinbase 거주 국가 증명
```

### 2.3 GPT Actions를 위한 REST API 엔드포인트

#### **GET /api/v1/circuits** — 회로 목록 조회 (인증 불필요)

```bash
curl https://stg-ai.zkproofport.app/api/v1/circuits
```

**응답:**
```json
{
  "circuits": [
    {
      "id": "coinbase_attestation",
      "displayName": "Coinbase KYC",
      "description": "신원을 공개하지 않고 KYC 인증 증명",
      "requiredInputs": ["address", "signature", "scope"]
    },
    {
      "id": "coinbase_country_attestation",
      "displayName": "Coinbase Country",
      "description": "Coinbase 인증에서 거주 국가 증명",
      "requiredInputs": ["address", "signature", "scope", "countryList", "isIncluded"]
    }
  ]
}
```

#### **POST /api/v1/proofs** — 증명 생성 (x402 결제 필요)

```bash
curl -X POST https://stg-ai.zkproofport.app/api/v1/proofs \
  -H "Content-Type: application/json" \
  -d '{
    "circuitId": "coinbase_attestation",
    "scope": "my-app",
    "address": "0xD6C714247037E5201B7e3dEC97a3ab59a9d2F739"
  }'
```

**결제 없이 요청 시 → 402 응답:**
```
HTTP/1.1 402 Payment Required
payment-required: eyJhY2NlcHRzIjpb...
```

**x402 결제 포함 요청 시 → 200 응답:**
```json
{
  "taskId": "abc-def-123",
  "state": "input-required",
  "signingUrl": "https://stg-ai.zkproofport.app/s/abc-def-123",
  "message": "서명 URL에서 지갑 서명을 완료하세요"
}
```

#### **GET /api/v1/proofs/{taskId}** — 증명 상태 확인

```bash
curl https://stg-ai.zkproofport.app/api/v1/proofs/abc-def-123
```

**응답 (입력 대기 중):**
```json
{
  "taskId": "abc-def-123",
  "state": "input-required",
  "signingUrl": "https://stg-ai.zkproofport.app/s/abc-def-123"
}
```

**응답 (증명 완료):**
```json
{
  "taskId": "abc-def-123",
  "state": "completed",
  "proof": "0x...",
  "publicInputs": ["0x..."],
  "circuitId": "coinbase_attestation"
}
```

**응답 (증명 실패):**
```json
{
  "taskId": "abc-def-123",
  "state": "failed",
  "error": "Attestation not found for address"
}
```

#### **POST /api/v1/proofs/verify** — 증명 검증 (x402 결제 필요)

```bash
curl -X POST https://stg-ai.zkproofport.app/api/v1/proofs/verify \
  -H "Content-Type: application/json" \
  -d '{
    "proof": "0x...",
    "publicInputs": ["0x..."],
    "circuitId": "coinbase_attestation"
  }'
```

**응답:**
```json
{
  "valid": true,
  "verifierAddress": "0x1234567890abcdef...",
  "chain": "Base Sepolia",
  "chainId": 84532
}
```

### 2.4 OpenAI Assistants API Integration

```python
import openai

client = openai.OpenAI()

# ZKProofport 기능 호출을 사용하는 어시스턴트 생성
assistant = client.beta.assistants.create(
    name="ZK Proof Assistant",
    instructions="사용자가 ZKProofport를 사용하여 영지식 증명을 생성하고 검증할 수 있도록 돕습니다.",
    model="gpt-4o",
    tools=[
        {
            "type": "function",
            "function": {
                "name": "list_circuits",
                "description": "사용 가능한 ZK 회로 목록 조회",
                "parameters": {"type": "object", "properties": {}}
            }
        },
        {
            "type": "function",
            "function": {
                "name": "generate_proof",
                "description": "Coinbase 인증을 위한 ZK 증명 생성",
                "parameters": {
                    "type": "object",
                    "required": ["circuitId", "scope"],
                    "properties": {
                        "circuitId": {
                            "type": "string",
                            "enum": ["coinbase_attestation", "coinbase_country_attestation"]
                        },
                        "scope": {"type": "string"},
                        "address": {"type": "string", "description": "지갑 주소"}
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "verify_proof",
                "description": "온체인 ZK 증명 검증",
                "parameters": {
                    "type": "object",
                    "required": ["proof", "publicInputs", "circuitId"],
                    "properties": {
                        "proof": {"type": "string"},
                        "publicInputs": {"type": "array", "items": {"type": "string"}},
                        "circuitId": {"type": "string"}
                    }
                }
            }
        }
    ]
)

# 함수 호출 시 ZKProofport에 HTTP 요청 실행
import requests

def handle_function_call(name, args):
    base = "https://stg-ai.zkproofport.app"
    if name == "list_circuits":
        return requests.get(f"{base}/api/v1/circuits").json()
    elif name == "generate_proof":
        return requests.post(f"{base}/api/v1/proofs", json=args).json()
    elif name == "verify_proof":
        return requests.post(f"{base}/api/v1/proofs/verify", json=args).json()
```

**사용 예시:**

```python
# 스레드 생성
thread = client.beta.threads.create()

# 사용자 메시지 추가
message = client.beta.threads.messages.create(
    thread_id=thread.id,
    role="user",
    content="Coinbase KYC 증명을 생성해줘"
)

# 실행
run = client.beta.threads.runs.create(
    thread_id=thread.id,
    assistant_id=assistant.id
)

# 함수 호출 대기 및 처리
import time
while run.status in ['queued', 'in_progress', 'requires_action']:
    time.sleep(1)
    run = client.beta.threads.runs.retrieve(thread_id=thread.id, run_id=run.id)

    if run.status == 'requires_action':
        tool_calls = run.required_action.submit_tool_outputs.tool_calls
        tool_outputs = []

        for tool_call in tool_calls:
            result = handle_function_call(
                tool_call.function.name,
                eval(tool_call.function.arguments)
            )
            tool_outputs.append({
                "tool_call_id": tool_call.id,
                "output": str(result)
            })

        run = client.beta.threads.runs.submit_tool_outputs(
            thread_id=thread.id,
            run_id=run.id,
            tool_outputs=tool_outputs
        )

# 응답 조회
messages = client.beta.threads.messages.list(thread_id=thread.id)
print(messages.data[0].content[0].text.value)
```

---

## 3. Gemini / Google ADK Integration

### 3.1 개요

Google ADK (Agent Development Kit)는 에이전트 간 통신을 위한 A2A 프로토콜을 지원합니다. ZKProofport는 A2A v0.3 엔드포인트를 제공합니다.

### 3.2 A2A Agent Card Discovery

```bash
curl https://stg-ai.zkproofport.app/.well-known/agent-card.json
```

**응답:**
```json
{
  "version": "0.3",
  "agent": {
    "name": "ZKProofport Prover Agent",
    "description": "Zero-knowledge proof generation and verification service",
    "url": "https://stg-ai.zkproofport.app"
  },
  "skills": [
    {
      "id": "get_supported_circuits",
      "name": "Get Supported Circuits",
      "description": "사용 가능한 ZK 회로 목록 조회",
      "parameters": {}
    },
    {
      "id": "generate_proof",
      "name": "Generate Proof",
      "description": "영지식 증명 생성",
      "parameters": {
        "circuitId": "string",
        "scope": "string",
        "address": "string (optional)",
        "signature": "string (optional)"
      }
    },
    {
      "id": "verify_proof",
      "name": "Verify Proof",
      "description": "온체인 증명 검증",
      "parameters": {
        "proof": "string",
        "publicInputs": "array",
        "circuitId": "string"
      }
    }
  ],
  "endpoint": "https://stg-ai.zkproofport.app/a2a"
}
```

### 3.3 A2A 프로토콜 (JSON-RPC)

**Endpoint:** `POST /a2a`
**Content-Type:** `application/json`

#### **Method: message/send**

**무료 스킬 (get_supported_circuits):**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "parts": [
        {
          "kind": "data",
          "mimeType": "application/json",
          "data": {
            "skill": "get_supported_circuits"
          }
        }
      ]
    }
  }
}
```

**응답:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "role": "assistant",
    "parts": [
      {
        "kind": "data",
        "mimeType": "application/json",
        "data": {
          "circuits": [
            {
              "id": "coinbase_attestation",
              "displayName": "Coinbase KYC"
            }
          ]
        }
      }
    ]
  }
}
```

**유료 스킬 (generate_proof):**

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "parts": [
        {
          "kind": "data",
          "mimeType": "application/json",
          "data": {
            "skill": "generate_proof",
            "circuitId": "coinbase_attestation",
            "scope": "my-app",
            "address": "0xD6C714247037E5201B7e3dEC97a3ab59a9d2F739"
          }
        }
      ]
    }
  }
}
```

**402 응답 (결제 필요):**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "error": {
    "code": 402,
    "message": "Payment required",
    "data": {
      "paymentRequired": "eyJhY2NlcHRzIjpb..."
    }
  }
}
```

### 3.4 Google ADK Agent 구현 (Python)

```python
from google.adk import Agent, Tool
import requests
import json

A2A_URL = "https://stg-ai.zkproofport.app/a2a"

def call_zkproofport(skill: str, **kwargs):
    """A2A 프로토콜을 통해 ZKProofport 호출"""
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "message/send",
        "params": {
            "message": {
                "role": "user",
                "parts": [{
                    "kind": "data",
                    "mimeType": "application/json",
                    "data": {"skill": skill, **kwargs}
                }]
            }
        }
    }
    resp = requests.post(A2A_URL, json=payload)
    return resp.json()

# 도구 정의
list_circuits_tool = Tool(
    name="list_circuits",
    description="사용 가능한 ZK 증명 회로 목록 조회",
    function=lambda: call_zkproofport("get_supported_circuits")
)

generate_proof_tool = Tool(
    name="generate_proof",
    description="영지식 증명 생성",
    function=lambda circuitId, scope, address=None:
        call_zkproofport("generate_proof", circuitId=circuitId, scope=scope, address=address)
)

verify_proof_tool = Tool(
    name="verify_proof",
    description="온체인 증명 검증",
    function=lambda proof, publicInputs, circuitId:
        call_zkproofport("verify_proof", proof=proof, publicInputs=publicInputs, circuitId=circuitId)
)

# Gemini 에이전트 생성
agent = Agent(
    name="ZK Privacy Agent",
    model="gemini-2.0-flash",
    instruction="""당신은 사용자가 ZKProofport를 사용하여 영지식 증명을 생성하고
    검증할 수 있도록 돕는 프라이버시 에이전트입니다. 증명을 생성하기 전에
    항상 사용 가능한 회로를 먼저 나열하세요.""",
    tools=[list_circuits_tool, generate_proof_tool, verify_proof_tool]
)
```

**사용 예시:**

```python
# 대화 시작
response = agent.run("Coinbase KYC 증명을 생성해줘")
print(response)
```

### 3.5 Google ADK with A2A Client (TypeScript)

```typescript
import { A2AClient } from '@anthropic-ai/a2a-client';

const client = new A2AClient({
  agentCardUrl: 'https://stg-ai.zkproofport.app/.well-known/agent-card.json'
});

// 에이전트 발견
const card = await client.getAgentCard();
console.log('Skills:', card.skills.map(s => s.id));
// 출력: ['get_supported_circuits', 'generate_proof', 'verify_proof']

// 무료 스킬 실행
const circuitsResult = await client.sendMessage({
  role: 'user',
  parts: [{
    kind: 'data',
    mimeType: 'application/json',
    data: { skill: 'get_supported_circuits' }
  }]
});
console.log(circuitsResult);

// 유료 스킬 실행 (x402 결제 필요)
const proofResult = await client.sendMessage({
  role: 'user',
  parts: [{
    kind: 'data',
    mimeType: 'application/json',
    data: {
      skill: 'generate_proof',
      circuitId: 'coinbase_attestation',
      scope: 'my-dapp'
    }
  }]
});
console.log(proofResult);
```

### 3.6 A2A 결제 동작

- `get_supported_circuits` → **무료** (결제 불필요)
- `generate_proof` → **x402 필요** ($0.10 USDC)
- `verify_proof` → **x402 필요** ($0.10 USDC)

유료 스킬 호출 시 402 응답을 받으면, 클라이언트는 x402 결제 서명을 생성하여 재시도해야 합니다.

---

## 4. Chat API (Telegram, Discord, Custom Bots)

### 4.1 개요

ZKProofport는 자연어를 이해하고 내부적으로 적절한 ZK 도구로 라우팅하는 대화형 LLM 채팅 엔드포인트를 제공합니다.

**Endpoint:** `POST /api/v1/chat`
**Content-Type:** `application/json`
**결제:** x402 필요 ($0.10 USDC) — 다른 유료 엔드포인트와 동일

> **Note:** Chat API도 x402 결제가 필요합니다. Telegram/Discord 봇 서버는 자체 지불자 지갑을 보유하고 x402 결제를 자동 처리해야 합니다. x402 설정 방법은 [Section 5](#5-x402-payment-integration)를 참조하세요.

### 4.2 Chat API 상세 정보

#### **새 세션 시작:**

```json
POST /api/v1/chat
{
  "message": "어떤 회로를 지원하나요?"
}
```

**응답:**
```json
{
  "sessionId": "uuid-abc-123",
  "sessionSecret": "hex-string-keep-this-safe",
  "response": "ZKProofport는 2개의 회로를 지원합니다:\n1. Coinbase KYC (coinbase_attestation)\n2. Coinbase Country (coinbase_country_attestation)"
}
```

**중요:** `sessionSecret`은 **첫 번째 메시지 응답에서만** 반환됩니다. 이후 모든 메시지에서 이 값을 포함해야 합니다.

#### **세션 계속하기:**

```json
POST /api/v1/chat
{
  "message": "내 지갑으로 KYC 증명 생성해줘",
  "sessionId": "uuid-abc-123",
  "sessionSecret": "hex-string-from-above"
}
```

**응답:**
```json
{
  "response": "KYC 증명 생성을 위해 다음 정보가 필요합니다:\n\n1. 지갑 주소 (address)\n2. Scope (예: my-dapp)\n\n정보를 제공해주시겠어요?"
}
```

#### **세션 보안:**

| 조건 | HTTP 상태 | 설명 |
|------|-----------|------|
| `sessionSecret` 누락 | 401 Unauthorized | sessionSecret이 필요함 |
| `sessionSecret` 불일치 | 403 Forbidden | 잘못된 sessionSecret |
| 세션 만료/존재하지 않음 | 404 Not Found | 세션을 찾을 수 없음 |

### 4.3 Telegram Bot Integration (Node.js)

> **중요:** Chat API는 x402 결제가 필요합니다. 봇 서버에서 자체 지불자 지갑으로 결제를 자동 처리합니다.

```javascript
import TelegramBot from 'node-telegram-bot-api';
import { ExactEvmScheme } from '@x402/evm';
import { x402Client, x402HTTPClient } from '@x402/fetch';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const CHAT_URL = 'https://stg-ai.zkproofport.app/api/v1/chat';

// x402 결제 클라이언트 설정 (봇 서버의 지불자 지갑)
const account = privateKeyToAccount(process.env.PAYER_PRIVATE_KEY);
const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http() });
const signer = { address: account.address, signTypedData: (args) => walletClient.signTypedData(args) };
const x402client = new x402Client();
x402client.register('eip155:84532', new ExactEvmScheme(signer));
const httpClient = new x402HTTPClient(x402client);

// x402 결제 자동 처리 fetch 래퍼
async function payingFetch(url, options) {
  const resp = await fetch(url, options);
  if (resp.status !== 402) return resp;

  const getHeader = (name) => resp.headers.get(name);
  const paymentRequired = httpClient.getPaymentRequiredResponse(getHeader, {});
  const paymentPayload = await x402client.createPaymentPayload(paymentRequired);
  const headers = httpClient.encodePaymentSignatureHeader(paymentPayload);

  return fetch(url, { ...options, headers: { ...options.headers, ...headers } });
}

// Telegram 채팅 ID별 세션 저장
const sessions = new Map();

bot.onText(/(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userMessage = match[1];

  // 명령어 무시
  if (userMessage.startsWith('/')) return;

  try {
    const session = sessions.get(chatId);
    const body = { message: userMessage };

    if (session) {
      body.sessionId = session.sessionId;
      body.sessionSecret = session.sessionSecret;
    }

    const resp = await payingFetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (resp.status === 404 || resp.status === 401) {
      // 세션 만료, 새로 시작
      sessions.delete(chatId);
      const newResp = await payingFetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMessage })
      });
      const data = await newResp.json();
      sessions.set(chatId, {
        sessionId: data.sessionId,
        sessionSecret: data.sessionSecret
      });
      bot.sendMessage(chatId, data.response);
      return;
    }

    const data = await resp.json();

    // 첫 메시지에서 세션 저장
    if (data.sessionSecret) {
      sessions.set(chatId, {
        sessionId: data.sessionId,
        sessionSecret: data.sessionSecret
      });
    }

    bot.sendMessage(chatId, data.response);
  } catch (error) {
    bot.sendMessage(chatId, '오류: ' + error.message);
  }
});

// /start 명령어
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    'ZKProofport Bot에 오신 것을 환영합니다!\n\n' +
    '영지식 증명을 생성하고 검증할 수 있도록 도와드립니다.\n\n' +
    '다음과 같이 질문해보세요:\n' +
    '- "어떤 회로를 지원하나요?"\n' +
    '- "Coinbase KYC 증명 생성해줘"\n' +
    '- "내 증명 검증해줘"'
  );
});

// /reset 명령어
bot.onText(/\/reset/, (msg) => {
  sessions.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id, '세션이 초기화되었습니다. 새 메시지를 보내서 다시 시작하세요.');
});
```

**필수 환경변수:**
```bash
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
PAYER_PRIVATE_KEY=0x_your_private_key  # USDC 잔액 필요 (Base Sepolia)
```

**필수 패키지:**
```bash
npm install node-telegram-bot-api @x402/evm @x402/fetch viem
```

### 4.4 Discord Bot Integration (discord.js)

> **중요:** Chat API는 x402 결제가 필요합니다. Telegram 봇과 동일한 `payingFetch` 패턴을 사용합니다.

```javascript
import { Client, GatewayIntentBits } from 'discord.js';
import { ExactEvmScheme } from '@x402/evm';
import { x402Client, x402HTTPClient } from '@x402/fetch';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const CHAT_URL = 'https://stg-ai.zkproofport.app/api/v1/chat';
const sessions = new Map();

// x402 결제 클라이언트 (Section 4.3과 동일한 패턴)
const account = privateKeyToAccount(process.env.PAYER_PRIVATE_KEY);
const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http() });
const signer = { address: account.address, signTypedData: (args) => walletClient.signTypedData(args) };
const x402client = new x402Client();
x402client.register('eip155:84532', new ExactEvmScheme(signer));
const httpClient = new x402HTTPClient(x402client);

async function payingFetch(url, options) {
  const resp = await fetch(url, options);
  if (resp.status !== 402) return resp;
  const getHeader = (name) => resp.headers.get(name);
  const paymentRequired = httpClient.getPaymentRequiredResponse(getHeader, {});
  const paymentPayload = await x402client.createPaymentPayload(paymentRequired);
  const headers = httpClient.encodePaymentSignatureHeader(paymentPayload);
  return fetch(url, { ...options, headers: { ...options.headers, ...headers } });
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith('!zk ')) return;

  const userMessage = message.content.slice(4);
  const userId = message.author.id;

  try {
    const session = sessions.get(userId);
    const body = { message: userMessage };

    if (session) {
      body.sessionId = session.sessionId;
      body.sessionSecret = session.sessionSecret;
    }

    const resp = await payingFetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (resp.status === 404 || resp.status === 401) {
      // 세션 만료, 새로 시작
      sessions.delete(userId);
      const newResp = await payingFetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMessage })
      });
      const data = await newResp.json();
      sessions.set(userId, {
        sessionId: data.sessionId,
        sessionSecret: data.sessionSecret
      });
      message.reply(data.response);
      return;
    }

    const data = await resp.json();

    if (data.sessionSecret) {
      sessions.set(userId, {
        sessionId: data.sessionId,
        sessionSecret: data.sessionSecret
      });
    }

    // Discord는 2000자 제한
    const response = data.response || data.error || '응답 없음';
    if (response.length > 1900) {
      message.reply(response.substring(0, 1900) + '...');
    } else {
      message.reply(response);
    }
  } catch (error) {
    message.reply('오류: ' + error.message);
  }
});

client.on('ready', () => {
  console.log(`로그인: ${client.user.tag}`);
});

client.login(process.env.DISCORD_BOT_TOKEN);
```

**필수 환경변수:**
```bash
DISCORD_BOT_TOKEN=your-discord-bot-token
PAYER_PRIVATE_KEY=0x_your_private_key  # USDC 잔액 필요 (Base Sepolia)
```

**필수 패키지:**
```bash
npm install discord.js @x402/evm @x402/fetch viem
```

### 4.5 Custom Web Chatbot (React)

> **중요:** Chat API는 x402 결제가 필요합니다. 프론트엔드에서 직접 x402 결제를 처리하거나, 백엔드 프록시를 통해 처리해야 합니다. 아래 예제는 백엔드 프록시를 사용하는 방식입니다 (프론트엔드에서는 private key 노출 위험).

```tsx
import { useState, useRef } from 'react';

// 주의: 실제 서비스에서는 백엔드 프록시를 통해 x402 결제를 처리하세요
// 프론트엔드에서 직접 private key를 사용하면 안 됩니다
const CHAT_URL = '/api/chat-proxy'; // 백엔드 프록시 엔드포인트 (x402 결제 처리)

export function ZKChat() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const sessionRef = useRef(null);

  const sendMessage = async () => {
    if (!input.trim() || loading) return;

    const userMsg = input;
    setInput('');
    setMessages(prev => [...prev, { role: 'user', text: userMsg }]);
    setLoading(true);

    try {
      const body = { message: userMsg };
      if (sessionRef.current) {
        body.sessionId = sessionRef.current.sessionId;
        body.sessionSecret = sessionRef.current.sessionSecret;
      }

      const resp = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (resp.status === 404 || resp.status === 401) {
        // 세션 만료, 새로 시작
        sessionRef.current = null;
        const newResp = await fetch(CHAT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: userMsg })
        });
        const data = await newResp.json();
        sessionRef.current = {
          sessionId: data.sessionId,
          sessionSecret: data.sessionSecret
        };
        setMessages(prev => [...prev, { role: 'assistant', text: data.response }]);
        setLoading(false);
        return;
      }

      const data = await resp.json();

      if (data.sessionSecret) {
        sessionRef.current = {
          sessionId: data.sessionId,
          sessionSecret: data.sessionSecret
        };
      }

      setMessages(prev => [...prev, { role: 'assistant', text: data.response }]);
    } catch (error) {
      setMessages(prev => [...prev, { role: 'error', text: error.message }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="chat-container">
      <div className="messages">
        {messages.map((m, i) => (
          <div key={i} className={`message ${m.role}`}>
            <strong>{m.role === 'user' ? '사용자' : m.role === 'assistant' ? 'ZKProofport' : '오류'}:</strong>
            <p>{m.text}</p>
          </div>
        ))}
      </div>
      <div className="input-area">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && sendMessage()}
          placeholder="메시지를 입력하세요..."
          disabled={loading}
        />
        <button onClick={sendMessage} disabled={loading}>
          {loading ? '전송 중...' : '전송'}
        </button>
      </div>
    </div>
  );
}
```

---

## 5. x402 Payment Integration

### 5.1 개요

유료 엔드포인트는 x402 결제 프로토콜 (HTTP 402)을 사용합니다. 결제 금액은 Base Sepolia (테스트넷) 또는 Base Mainnet (프로덕션)에서 요청당 $0.10 USDC입니다.

**x402 결제가 필요한 엔드포인트:**

| 엔드포인트 | 프로토콜 | x402 결제 | 비고 |
|-----------|---------|-----------|------|
| `POST /a2a` (generate_proof) | A2A | 필요 | get_supported_circuits만 무료 |
| `POST /mcp` (tools/call) | MCP | 필요 | 모든 tool call에 적용 |
| `POST /api/v1/proofs` | REST | 필요 | 증명 생성 |
| `POST /api/v1/proofs/verify` | REST | 필요 | 증명 검증 |
| `POST /api/v1/chat` | Chat | 필요 | 대화형 인터페이스 |
| `GET /api/v1/circuits` | REST | 무료 | 회로 목록 조회 |
| `GET /health` | REST | 무료 | 상태 확인 |

### 5.2 x402 Client 설정 (Node.js)

```javascript
import { ExactEvmScheme } from '@x402/evm';
import { x402Client, x402HTTPClient, wrapFetchWithPayment } from '@x402/fetch';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

// 지불자 지갑 설정
const account = privateKeyToAccount('0x_YOUR_PRIVATE_KEY');
const walletClient = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http()
});

// Signer 생성 (ExactEvmScheme은 .address와 .signTypedData 필요)
const signer = {
  address: account.address,
  signTypedData: (args) => walletClient.signTypedData(args)
};

// x402 클라이언트 등록
const client = new x402Client();
client.register('eip155:84532', new ExactEvmScheme(signer));
const httpClient = new x402HTTPClient(client);

// 옵션 1: fetch를 전역으로 래핑
const payingFetch = wrapFetchWithPayment(fetch, httpClient);
const resp = await payingFetch('https://stg-ai.zkproofport.app/api/v1/proofs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    circuitId: 'coinbase_attestation',
    scope: 'test'
  })
});
console.log(await resp.json());

// 옵션 2: 수동 단계별 처리
async function x402Fetch(url, options) {
  const resp1 = await fetch(url, options);
  if (resp1.status !== 402) return resp1;

  const getHeader = (name) => resp1.headers.get(name);
  const paymentRequired = httpClient.getPaymentRequiredResponse(getHeader, {});
  const paymentPayload = await client.createPaymentPayload(paymentRequired);
  const headers = httpClient.encodePaymentSignatureHeader(paymentPayload);

  return fetch(url, {
    ...options,
    headers: { ...options.headers, ...headers }
  });
}

// 사용
const resp2 = await x402Fetch('https://stg-ai.zkproofport.app/api/v1/proofs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ circuitId: 'coinbase_attestation', scope: 'test' })
});
console.log(await resp2.json());
```

### 5.3 x402 Python Client

```python
# x402 Python 지원은 제한적이므로 수동 헤더 생성 사용
import requests
import json
import base64

def x402_request(url, method='POST', json_data=None):
    """x402 인식 HTTP 요청"""
    resp = requests.request(method, url, json=json_data)

    if resp.status_code != 402:
        return resp

    # 결제 요구사항 파싱
    payment_header = resp.headers.get('payment-required')
    payment_info = json.loads(base64.b64decode(payment_header))

    print(f"결제 필요: {payment_info['accepts'][0]['amount']} units")
    print(f"수신자: {payment_info['accepts'][0]['payTo']}")

    # web3.py 또는 viem 등가물을 사용하여 결제 서명 생성
    # ... (EIP-3009 receiveWithAuthorization 서명 구현)

    return resp

# 사용
resp = x402_request(
    'https://stg-ai.zkproofport.app/api/v1/proofs',
    json_data={'circuitId': 'coinbase_attestation', 'scope': 'test'}
)
```

**EIP-3009 서명 생성 (web3.py):**

```python
from web3 import Web3
from eth_account import Account
from eth_account.messages import encode_structured_data

w3 = Web3(Web3.HTTPProvider('https://sepolia.base.org'))
account = Account.from_key('0x_YOUR_PRIVATE_KEY')

# 결제 정보에서 가져온 값
pay_to = payment_info['accepts'][0]['payTo']
amount = payment_info['accepts'][0]['amount']
usdc_address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'  # Base Sepolia USDC

# EIP-712 메시지 구성
message = {
    "types": {
        "EIP712Domain": [
            {"name": "name", "type": "string"},
            {"name": "version", "type": "string"},
            {"name": "chainId", "type": "uint256"},
            {"name": "verifyingContract", "type": "address"}
        ],
        "ReceiveWithAuthorization": [
            {"name": "from", "type": "address"},
            {"name": "to", "type": "address"},
            {"name": "value", "type": "uint256"},
            {"name": "validAfter", "type": "uint256"},
            {"name": "validBefore", "type": "uint256"},
            {"name": "nonce", "type": "bytes32"}
        ]
    },
    "primaryType": "ReceiveWithAuthorization",
    "domain": {
        "name": "USD Coin",
        "version": "2",
        "chainId": 84532,
        "verifyingContract": usdc_address
    },
    "message": {
        "from": account.address,
        "to": pay_to,
        "value": amount,
        "validAfter": 0,
        "validBefore": int(time.time()) + 3600,  # 1시간 유효
        "nonce": w3.keccak(text=str(time.time()))
    }
}

# 서명
encoded_message = encode_structured_data(message)
signed = account.sign_message(encoded_message)

# 결제 서명 헤더 생성
payment_payload = {
    "from": account.address,
    "to": pay_to,
    "value": amount,
    "validAfter": message["message"]["validAfter"],
    "validBefore": message["message"]["validBefore"],
    "nonce": message["message"]["nonce"].hex(),
    "signature": signed.signature.hex()
}
payment_header = base64.b64encode(json.dumps(payment_payload).encode()).decode()

# 재시도
resp2 = requests.post(
    url,
    json=json_data,
    headers={'PAYMENT-SIGNATURE': payment_header}
)
```

### 5.4 필요한 USDC 잔액

| 환경 | USDC 주소 | 획득 방법 |
|------|-----------|----------|
| Testnet (Base Sepolia) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | [Circle Faucet](https://faucet.circle.com/) (무료) |
| Production (Base Mainnet) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 실제 USDC 구매 필요 |

**비용:** 증명 생성당 $0.10, 검증당 $0.10

---

## 6. Proof Generation Flow

### 6.1 전체 플로우 다이어그램

```
1. 클라이언트 → ZKProofport: 증명 생성 요청
2. ZKProofport → 클라이언트: signingUrl 반환 (state: input-required)
3. 사용자 → signingUrl: URL 열기, 지갑 연결, 메시지 서명
4. ZKProofport: 서명 수신, EAS 인증 조회, 회로 입력값 구성
5. ZKProofport → TEE/bb: ZK 증명 생성
6. ZKProofport → 온체인: nullifier 등록
7. ZKProofport → 클라이언트: 증명 + publicInputs 반환
```

### 6.2 지원되는 회로

| Circuit ID | 표시 이름 | 설명 | 필요한 인증 |
|-----------|----------|------|------------|
| `coinbase_attestation` | Coinbase KYC | Coinbase 신원 검증 증명 | Coinbase Verifications (EAS on Base) |
| `coinbase_country_attestation` | Coinbase Country | 거주 국가 증명 | Coinbase Verifications (EAS on Base) |

### 6.3 증명 검증

증명을 받은 후 온체인 검증:

```javascript
const result = await fetch('https://stg-ai.zkproofport.app/api/v1/proofs/verify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    proof: '0x...',
    publicInputs: ['0x...'],
    circuitId: 'coinbase_attestation'
  })
});
const data = await result.json();
console.log(data);
// { valid: true, verifierAddress: '0x...', chain: 'Base Sepolia', chainId: 84532 }
```

### 6.4 증명 생성 상태 머신

| State | 설명 | 다음 가능한 상태 |
|-------|------|-----------------|
| `input-required` | 사용자 서명 대기 | `processing`, `failed` |
| `processing` | 증명 생성 중 | `completed`, `failed` |
| `completed` | 증명 완료 | (종료 상태) |
| `failed` | 증명 실패 | (종료 상태) |

---

## 7. Environment Configuration Reference

### 7.1 Staging vs Production

| 항목 | Staging | Production |
|------|---------|------------|
| Base URL | `https://stg-ai.zkproofport.app` | `https://ai.zkproofport.app` |
| 체인 | Base Sepolia (84532) | Base Mainnet (8453) |
| USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| 결제 | Testnet (무료 USDC) | 실제 USDC |
| TEE | Local (시뮬레이션) | Nitro (하드웨어) |
| EAS GraphQL | `https://base-sepolia.easscan.org/graphql` | `https://base.easscan.org/graphql` |

### 7.2 Rate Limits

| 엔드포인트 | 제한 | 단위 |
|-----------|------|------|
| Chat | 30 요청 | IP당 분당 |
| Proof generation | 10 요청 | IP당 시간당 |
| Circuit compilation | 5 요청 | IP당 시간당 |

---

## 8. Troubleshooting

### 일반적인 문제

| 문제 | 원인 | 해결 방법 |
|------|------|---------|
| 402 Payment Required | x402 결제 미제공 | 지불자 지갑에 USDC 추가, x402 플로우 구현 |
| 401 Unauthorized | 채팅용 sessionSecret 누락 | 첫 응답의 sessionSecret 포함 |
| 403 Forbidden | 잘못된 sessionSecret | 세션 생성 시의 올바른 sessionSecret 사용 |
| 404 Not Found | 세션 만료 또는 잘못된 엔드포인트 | 새 세션 시작 또는 엔드포인트 URL 확인 |
| `insufficient_funds` | 지불자 지갑에 USDC 없음 | Circle Faucet으로 지갑 충전 (테스트넷) |
| `attestation_not_found` | 주소에 Coinbase 인증 없음 | Coinbase Verifications 앱에서 인증 완료 |
| `nullifier_already_used` | 동일 scope로 이미 증명 생성됨 | 다른 scope 사용 또는 기존 증명 재사용 |

### 테스트넷 USDC 받기

1. https://faucet.circle.com/ 이동
2. "Base Sepolia" 네트워크 선택
3. "USDC" 토큰 선택
4. 지갑 주소 입력
5. "Get Tokens" 클릭 (10 USDC 제공)

### 결제 없이 테스트하기

개발 시 무료 엔드포인트 사용:

- `GET /api/v1/circuits` — 항상 무료
- `GET /health` — 항상 무료
- A2A `get_supported_circuits` — 항상 무료 (결제 면제)

> **Note:** Chat API (`POST /api/v1/chat`)는 x402 결제가 필요합니다. REST, MCP, A2A의 증명 생성/검증과 동일한 결제 게이트가 적용됩니다.

### 디버깅 팁

**증명 생성 실패 시:**

1. `GET /api/v1/proofs/{taskId}`로 상태 확인
2. `state: "failed"` 시 `error` 필드 확인
3. 일반적인 오류:
   - `attestation_not_found`: Coinbase Verifications에서 인증 필요
   - `invalid_signature`: 서명이 address와 일치하지 않음
   - `nullifier_already_used`: 동일 scope로 이미 증명 생성됨

**x402 결제 실패 시:**

1. 지갑 USDC 잔액 확인 (최소 0.1 USDC 필요)
2. 올바른 체인 사용 확인 (Staging=Base Sepolia, Production=Base Mainnet)
3. EIP-3009 서명 구조 확인 (domain, types, message 필드)

---

## 9. Code Examples by Platform

### 9.1 Claude Desktop

**.mcp.json 설정:**
```json
{
  "mcpServers": {
    "zkproofport-prover": {
      "url": "https://stg-ai.zkproofport.app/mcp"
    }
  }
}
```

**사용 예시:**
```
사용자: 사용 가능한 ZK 회로 목록을 보여줘

Claude: [get_supported_circuits 도구 호출]

사용자: Coinbase KYC 증명을 생성해줘

Claude: [generate_proof 도구 호출]
증명 생성 요청이 생성되었습니다. 다음 URL에서 지갑 서명을 완료하세요:
https://stg-ai.zkproofport.app/s/abc-123-def
```

### 9.2 ChatGPT Custom GPT

**GPT 설정:**
- Actions: Import from `https://stg-ai.zkproofport.app/openapi.json`
- Authentication: None

**대화 예시:**
```
사용자: Coinbase KYC 증명 만들어줘

GPT: 먼저 사용 가능한 회로를 확인하겠습니다.
[GET /api/v1/circuits 호출]

coinbase_attestation 회로를 사용하여 증명을 생성하겠습니다.
다음 정보를 제공해주세요:
1. 지갑 주소 (address)
2. Scope (예: my-dapp)

사용자: 0xD6C714247037E5201B7e3dEC97a3ab59a9d2F739, my-app

GPT: [POST /api/v1/proofs 호출]
증명 생성 요청이 생성되었습니다. 다음 URL에서 서명을 완료하세요:
https://stg-ai.zkproofport.app/s/abc-123-def
```

### 9.3 Google ADK (Gemini)

**Python 구현:**
```python
from google.adk import Agent, Tool

def list_circuits():
    import requests
    return requests.post('https://stg-ai.zkproofport.app/a2a', json={
        "jsonrpc": "2.0",
        "id": 1,
        "method": "message/send",
        "params": {
            "message": {
                "role": "user",
                "parts": [{
                    "kind": "data",
                    "mimeType": "application/json",
                    "data": {"skill": "get_supported_circuits"}
                }]
            }
        }
    }).json()

agent = Agent(
    name="ZK Agent",
    model="gemini-2.0-flash",
    tools=[Tool(name="list_circuits", function=list_circuits)]
)

response = agent.run("어떤 회로를 지원하나요?")
print(response)
```

### 9.4 Telegram Bot

**사용 예시:**
```
사용자: /start

Bot: ZKProofport Bot에 오신 것을 환영합니다!
영지식 증명을 생성하고 검증할 수 있도록 도와드립니다.

사용자: 어떤 회로를 지원하나요?

Bot: ZKProofport는 2개의 회로를 지원합니다:
1. Coinbase KYC (coinbase_attestation)
2. Coinbase Country (coinbase_country_attestation)

사용자: Coinbase KYC 증명 생성해줘

Bot: KYC 증명 생성을 위해 다음 정보가 필요합니다:
1. 지갑 주소 (address)
2. Scope (예: my-dapp)

사용자: 0xD6C714247037E5201B7e3dEC97a3ab59a9d2F739, my-app

Bot: 증명 생성 요청이 생성되었습니다. 다음 URL에서 서명을 완료하세요:
https://stg-ai.zkproofport.app/s/abc-123-def
```

---

## 10. Advanced Topics

### 10.1 프로그래밍 방식 증명 생성 (서명 포함)

사용자가 서명 URL을 수동으로 방문하는 대신, 프로그래밍 방식으로 서명을 제공할 수 있습니다:

```javascript
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const account = privateKeyToAccount('0x_YOUR_PRIVATE_KEY');
const walletClient = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http()
});

// 서명 메시지 생성
const message = `I want to generate a ZK proof for circuitId: coinbase_attestation and scope: my-app`;

// 서명
const signature = await walletClient.signMessage({ message });

// 서명과 함께 증명 생성 요청
const resp = await fetch('https://stg-ai.zkproofport.app/api/v1/proofs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    circuitId: 'coinbase_attestation',
    scope: 'my-app',
    address: account.address,
    signature: signature
  })
});

const data = await resp.json();
console.log(data);
// { taskId: "abc-123", state: "processing", ... }
```

### 10.2 증명 상태 폴링

```javascript
async function waitForProof(taskId) {
  while (true) {
    const resp = await fetch(`https://stg-ai.zkproofport.app/api/v1/proofs/${taskId}`);
    const data = await resp.json();

    if (data.state === 'completed') {
      return { proof: data.proof, publicInputs: data.publicInputs };
    }

    if (data.state === 'failed') {
      throw new Error(data.error);
    }

    // 5초 대기 후 재시도
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

// 사용
const { proof, publicInputs } = await waitForProof('abc-123-def');
console.log('증명 완료:', proof);
```

### 10.3 WebSocket을 통한 실시간 상태 업데이트

**현재 지원하지 않음** — 향후 버전에서 Socket.IO 지원 예정.

### 10.4 배치 증명 생성

여러 증명을 동시에 생성:

```javascript
const tasks = [];

for (const scope of ['scope1', 'scope2', 'scope3']) {
  const resp = await fetch('https://stg-ai.zkproofport.app/api/v1/proofs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      circuitId: 'coinbase_attestation',
      scope: scope,
      address: account.address,
      signature: signature
    })
  });
  const data = await resp.json();
  tasks.push(data.taskId);
}

// 모든 증명 완료 대기
const proofs = await Promise.all(tasks.map(waitForProof));
console.log('모든 증명 완료:', proofs);
```

---

## 11. Security Best Practices

### 11.1 sessionSecret 보안

- **절대 로그에 기록하지 마세요** — sessionSecret은 세션 하이재킹에 사용될 수 있습니다
- **HTTPS만 사용** — HTTP를 통해 sessionSecret을 전송하지 마세요
- **메모리에만 저장** — 디스크에 sessionSecret을 저장하지 마세요 (Redis/DB 제외)

### 11.2 Private Key 보안

- **환경 변수 사용** — 코드에 private key를 하드코딩하지 마세요
- **Key Management Service** — 프로덕션에서는 AWS KMS, GCP KMS 등 사용
- **권한 최소화** — 지불자 지갑은 USDC 승인 권한만 가져야 함

### 11.3 Rate Limiting

클라이언트 측에서 자체 rate limiting 구현:

```javascript
class RateLimiter {
  constructor(maxRequests, windowMs) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.requests = [];
  }

  async wait() {
    const now = Date.now();
    this.requests = this.requests.filter(t => now - t < this.windowMs);

    if (this.requests.length >= this.maxRequests) {
      const oldestRequest = this.requests[0];
      const waitTime = this.windowMs - (now - oldestRequest);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return this.wait();
    }

    this.requests.push(now);
  }
}

const limiter = new RateLimiter(10, 60 * 60 * 1000); // 10 요청/시간

async function generateProof(params) {
  await limiter.wait();
  return fetch('https://stg-ai.zkproofport.app/api/v1/proofs', {
    method: 'POST',
    body: JSON.stringify(params)
  });
}
```

---

## 12. FAQ

### Q1: MCP, A2A, REST API 중 무엇을 사용해야 하나요?

| 상황 | 추천 프로토콜 |
|------|-------------|
| Claude Desktop/Code 사용 | MCP |
| ChatGPT Custom GPT | REST API (GPT Actions) |
| Google Gemini/ADK | A2A |
| Telegram/Discord 봇 | Chat API |
| 직접 통합 (Node.js, Python 등) | REST API |

### Q2: 무료로 테스트할 수 있나요?

네, 다음 방법으로 가능합니다:
1. Circle Faucet에서 무료 USDC 받기 (Base Sepolia)
2. `GET /api/v1/circuits` 엔드포인트 사용 (무료)
3. A2A `get_supported_circuits` 스킬 사용 (무료)

### Q3: 증명 생성이 얼마나 걸리나요?

| 단계 | 소요 시간 |
|------|----------|
| 사용자 서명 | 수동 (사용자가 직접) |
| 인증 조회 | ~2초 |
| 증명 생성 (bb) | ~10-30초 |
| 온체인 등록 | ~5초 |
| **총 시간** | **~20-40초** |

### Q4: 동일 증명을 여러 번 생성할 수 있나요?

아니요. 각 (address, circuitId, scope) 조합은 **한 번만** 증명을 생성할 수 있습니다. nullifier가 온체인에 등록되어 재사용을 방지합니다.

동일 주소로 여러 증명이 필요하면 **다른 scope**를 사용하세요.

### Q5: 증명을 누구나 검증할 수 있나요?

네. 증명 검증은 퍼블릭 온체인 작업입니다. 누구나 `verify_proof` 엔드포인트를 호출하거나 Solidity verifier 컨트랙트를 직접 호출할 수 있습니다.

### Q6: Coinbase 인증이 없으면 어떻게 하나요?

Coinbase Verifications 앱에서 인증을 완료하세요:
1. https://www.coinbase.com/verifications 방문
2. Base 네트워크 선택 (Sepolia 또는 Mainnet)
3. 지갑 연결 및 신원 인증 완료
4. EAS 인증이 온체인에 기록됨

---

## 13. Support & Resources

### 13.1 도움 받기

| 채널 | 용도 |
|------|------|
| GitHub Issues | 버그 리포트, 기능 요청 |
| Discord | 커뮤니티 지원, 질문 |
| Email | 비즈니스 문의 |

### 13.2 관련 링크

| 리소스 | URL |
|--------|-----|
| OpenAPI Spec | `https://stg-ai.zkproofport.app/openapi.json` |
| OASF Agent Discovery | `https://stg-ai.zkproofport.app/.well-known/agent.json` |
| A2A Agent Card | `https://stg-ai.zkproofport.app/.well-known/agent-card.json` |
| MCP Discovery | `https://stg-ai.zkproofport.app/.well-known/mcp.json` |
| Health Check | `https://stg-ai.zkproofport.app/health` |

### 13.3 프로토콜 문서

- [MCP (Model Context Protocol)](https://modelcontextprotocol.io/)
- [A2A (Agent-to-Agent) v0.3](https://www.anthropic.com/news/agent-to-agent-protocol)
- [x402 Payment Protocol](https://www.x402.org/)
- [ERC-8004 (OASF Agent Discovery)](https://eips.ethereum.org/EIPS/eip-8004)
- [EIP-3009 (USDC Authorization)](https://eips.ethereum.org/EIPS/eip-3009)

---

이 문서는 ZKProofport AI 서비스를 다양한 AI 플랫폼과 통합하기 위한 완전한 가이드를 제공합니다. 추가 질문이나 지원이 필요하면 위의 채널을 통해 문의하세요.
