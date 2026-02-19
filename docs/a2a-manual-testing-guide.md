# Manual Testing Guide

This guide documents how to manually test all proofport-ai interfaces: A2A protocol, MCP, OpenAI-compatible chat, REST API, ERC-8004 identity, x402 payment, and Phoenix tracing.

The a2a-ui is a community-built web UI ([a2a-community/a2a-ui](https://github.com/a2a-community/a2a-ui)) that speaks the A2A JSON-RPC protocol. It runs in Docker alongside proofport-ai and Phoenix as a self-contained test stack.

---

## Prerequisites

- Docker Desktop running
- `.env.development` file present in `proofport-ai/` (copy from `.env.example` and fill in required values)
- Ports `3001`, `4002`, `4317`, and `6006` free on the host

---

## 1. Start the Test Stack

Run the test stack startup script from the `proofport-ai/` directory:

```bash
./scripts/a2a-test.sh
```

This starts 5 containers: `ai`, `redis`, `a2a-ui`, `phoenix`, and `phoenix-proxy` (nginx CORS sidecar for Phoenix). Wait until all containers report healthy status.

Verify the agent is up:

```bash
curl http://localhost:4002/health
```

Expected response: `{"status":"ok"}` or similar health payload.

To confirm the agent card is accessible:

```bash
curl http://localhost:4002/a2a
```

Expected response: JSON agent card with `name`, `description`, `skills`, and `capabilities` fields.

---

## Part A: A2A Protocol Testing

### 2. Register Agent in a2a-ui

Open [http://localhost:3001](http://localhost:3001) in a browser.

**Steps:**

1. Click the **Agents** tab in the top navigation bar.
2. Click the **Add** button (top-right area of the Agents list).
3. In the dialog, enter the agent URL: `http://localhost:4002`
4. Click **Create Agent**.

**Expected result:** The agent `proveragent.eth` appears in the Agents list with status **Active** and **3 messages** (reflecting the 3 registered skills: `get_supported_circuits`, `generate_proof`, `verify_proof`).

If the agent fails to register, see the Troubleshooting section for CORS and connectivity issues.

#### Delete an Agent

On the agent row, the three icon buttons are (left to right): **delete**, **edit**, **open**.

1. Click the **first icon button** (trash icon) on the agent row.
2. Confirm in the "Delete Agent" dialog.
3. The agent is permanently removed from local storage.

> Note: Deleting an agent does not delete conversations associated with it, but those conversations will show `Agent: Unknown`.

---

### 3. Create a Conversation

1. Click the **Conversations** tab in the top navigation bar.
2. Click the **Add** button.
3. Conversation name: leave as default ("New conversation") or enter a custom name.
4. Agent selector: `proveragent.eth (http://localhost:4002/a2a)` should be auto-selected from the registered agents.
5. Click **Create Conversation**.

**Expected result:** The new conversation appears in the list, showing `Agent: proveragent.eth`.

#### Delete a Conversation

On the conversation row, the three icon buttons are (left to right): **delete**, **edit**, **open chat**.

1. Click the **first icon button** (trash icon) on the conversation row.
2. Confirm in the "Delete Conversation" dialog.
3. The conversation and all messages are permanently removed from local storage.

---

### 4. Open Chat and Send Messages

On the conversation row, click the **third icon button** (rightmost) to enter the chat view.

> Note on icon order: The first icon deletes the conversation, the second icon edits it, and the third (open/expand) icon opens the chat view.

**Chat view layout:**

- **Left panel:** Message area. An initial greeting is displayed: "Hello, I am your agent. How can I assist you today?"
- **Right panel:** Agent Details showing name, description, agent URL, capabilities, streaming toggle, and conversation context info.

**Send a test message:**

Type the following into the "Ask anything" text field and press Enter:

```
list supported circuits
```

**Expected response:** The agent returns an artifact containing circuit data JSON with the following entries:

- `coinbase_attestation` — Coinbase KYC circuit
  - `verifierAddress`: on-chain verifier contract address
  - `easSchemaId`: EAS schema UID
  - `functionSelector`: ABI function selector
  - `requiredInputs`: list of required proof inputs
- `coinbase_country_attestation` — Coinbase Country circuit
  - Same fields as above, with country-specific values

---

### 5. Multiple Messages and Skill Routing

Send multiple messages in the same conversation to verify stateless skill routing:

1. `list supported circuits` — returns circuit data artifact
2. `what circuits do you support?` — same `get_supported_circuits` result (tests alternative keyword routing)
3. `verify this proof` — routes to `verify_proof` (returns error artifact "Missing required parameters: circuitId, proof, publicInputs")
4. `generate a proof` — routes to `generate_proof` (returns error artifact "Missing required parameters: scope, circuitId")

Each message should produce a separate response with visible text. proofport-ai is stateless (no conversational context), so each message is processed independently. Failed tasks include error artifacts so a2a-ui can display the error message.

#### Context ID

In the **Agent Details** panel (right side of chat view), the **Conversation** section shows:

- **Context ID**: a UUID used to group traces in Phoenix. Click **Edit** to change it, or **Generate** to create a new one.
- Changing the Context ID mid-conversation starts a new trace group in Phoenix, which is useful for testing trace isolation.

> Note: `generate_proof` and `verify_proof` require structured parameters (wallet address, signature, proof bytes, etc.) that cannot be provided via free-form text chat. Use the `curl` DataPart method described in Section 8 for full parameter testing of these skills.

---

### 6. Streaming Mode

In the **Agent Details** panel (right side of chat view):

1. Toggle the **Streaming** switch to ON.
2. The mode label changes from "Standard Mode" to "Streaming Mode".
3. Send a message — the response now arrives via SSE (Server-Sent Events) streaming rather than a synchronous JSON-RPC response.

Both modes produce the same final content. Streaming is useful for observing incremental response delivery and testing the agent's streaming transport layer.

---

### 7. Error Testing (A2A)

Send edge-case inputs to verify error handling:

- **Empty message:** The a2a-ui prevents sending blank inputs (client-side validation). Via curl, an empty text message returns JSON-RPC error code `-32602` with message: "Could not determine skill from message."
- **Unrecognized text:** Send a message that does not match any skill keyword (e.g., `"what is the weather today?"`). The agent returns a JSON-RPC error: "Could not determine skill from message. Include a DataPart with { \"skill\": \"...\" } field."
- **Missing parameters:** Send `"verify this proof"` or `"generate a proof"` — the agent routes to the correct skill but returns an error artifact listing the missing required parameters.

All error cases return valid JSON-RPC error responses or error artifacts, not unhandled exceptions or silent failures.

---

### 8. curl DataPart Testing

For skills that require structured input parameters, use the A2A `DataPart` message format. This bypasses the text-based routing and directly addresses a skill with its required fields.

#### get_supported_circuits

```bash
curl -s -X POST http://localhost:4002/a2a \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "message/send",
    "params": {
      "message": {
        "role": "user",
        "parts": [{
          "kind": "data",
          "mimeType": "application/json",
          "data": {
            "skill": "get_supported_circuits",
            "chainId": "84532"
          }
        }]
      }
    }
  }'
```

#### verify_proof

```bash
curl -s -X POST http://localhost:4002/a2a \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "message/send",
    "params": {
      "message": {
        "role": "user",
        "parts": [{
          "kind": "data",
          "mimeType": "application/json",
          "data": {
            "skill": "verify_proof",
            "proof": "0x...",
            "publicInputs": ["0x..."],
            "circuitId": "coinbase_attestation",
            "chainId": "84532"
          }
        }]
      }
    }
  }'
```

#### generate_proof

```bash
curl -s -X POST http://localhost:4002/a2a \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "message/send",
    "params": {
      "message": {
        "role": "user",
        "parts": [{
          "kind": "data",
          "mimeType": "application/json",
          "data": {
            "skill": "generate_proof",
            "address": "0xYourKYCWallet",
            "signature": "0xYourSignature",
            "scope": "my-dapp.com",
            "circuitId": "coinbase_attestation"
          }
        }]
      }
    }
  }'
```

> For `generate_proof`, use a wallet address that holds a valid Coinbase KYC attestation on the target chain. For Base Sepolia testing, the attested wallet is `0xD6C714247037E5201B7e3dEC97a3ab59a9d2F739`.

---

### 8a. Korean / Multilingual Text Inference

proofport-ai is LLM-free. Skill routing uses deterministic keyword matching — not LLM inference. Both English and Korean keywords are supported. Priority order: `verify_proof` > `generate_proof` > `get_supported_circuits`. If no keyword matches, a JSON-RPC error is returned asking the sender to include a DataPart with a `skill` field.

| Input Text | Expected Skill | Expected Params |
|------------|---------------|-----------------|
| `증명 생성해줘` | generate_proof | (no params — missing params error artifact) |
| `coinbase_attestation 증명 생성해줘` | generate_proof | circuitId=coinbase_attestation |
| `coinbase_country_attestation KR 포함되게 증명 생성해줘` | generate_proof | circuitId=coinbase_country_attestation, countryList=[KR], isIncluded=true |
| `myapp.com 으로 coinbase_attestation 프루프 만들어줘` | generate_proof | circuitId=coinbase_attestation, scope=myapp.com |
| `증명 검증해줘` | verify_proof | - (missing params error artifact) |
| `지원하는 회로 목록 보여줘` | get_supported_circuits | - |
| `hello world` | ERROR: Could not determine skill | - |

To test these via curl:

```bash
# Korean generate_proof with circuit and scope
curl -s -X POST http://localhost:4002/a2a \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"role":"user","parts":[{"kind":"text","text":"coinbase_attestation 증명 생성해줘 myapp.com"}]}}}'

# Korean verify_proof
curl -s -X POST http://localhost:4002/a2a \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"message/send","params":{"message":{"role":"user","parts":[{"kind":"text","text":"증명 검증해줘"}]}}}'

# Korean list circuits
curl -s -X POST http://localhost:4002/a2a \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"message/send","params":{"message":{"role":"user","parts":[{"kind":"text","text":"지원하는 회로 목록 보여줘"}]}}}'

# Unrecognized text — expect -32602 error
curl -s -X POST http://localhost:4002/a2a \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":4,"method":"message/send","params":{"message":{"role":"user","parts":[{"kind":"text","text":"hello world"}]}}}'
```

> Note: `generate_proof` and `verify_proof` still require structured parameters (wallet address, signature, proof bytes, etc.) for actual execution. Text inference only routes to the correct skill; missing parameters result in an error artifact, not successful execution. Use DataPart (Section 8) to supply full parameters.

---

## Part B: MCP Testing

### 9. MCP via curl

The MCP endpoint uses StreamableHTTP transport on `POST /mcp`. All requests must include `Accept: application/json, text/event-stream`. Responses are SSE-formatted with `data: {...}` lines.

#### Initialize

```bash
curl -s -X POST http://localhost:4002/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

Expected: SSE response containing server name, version, and protocol capabilities.

#### List Tools

```bash
curl -s -X POST http://localhost:4002/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

Expected: SSE response listing 3 tools: `get_supported_circuits`, `generate_proof`, `verify_proof`.

#### Call get_supported_circuits

```bash
curl -s -X POST http://localhost:4002/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_supported_circuits","arguments":{}}}'
```

Expected: SSE response with `data: {...}` containing the circuit registry JSON (both `coinbase_attestation` and `coinbase_country_attestation` entries).

#### Call verify_proof (with fake proof — tests error path)

```bash
curl -s -X POST http://localhost:4002/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"verify_proof","arguments":{"circuitId":"coinbase_attestation","proof":"0xfake","publicInputs":["0x0000000000000000000000000000000000000000000000000000000000000000"],"chainId":"84532"}}}'
```

Expected: SSE response with `data: {...}` containing a result object with `valid: false` and an `error` field (on-chain call reverted due to invalid proof).

#### Verify GET is rejected

```bash
curl -s -X GET http://localhost:4002/mcp
```

Expected: HTTP 405 Method Not Allowed (MCP StreamableHTTP only accepts POST).

---

### 10. MCP via Claude Code

Add the MCP server to your Claude Code settings:

```json
{
  "mcpServers": {
    "zkproofport-prover": {
      "url": "http://localhost:4002/mcp"
    }
  }
}
```

After restarting Claude Code, the 3 tools appear in the tool picker. Test by asking:

- "list supported circuits" → invokes `get_supported_circuits` tool
- "verify proof 0x... for coinbase_attestation on chain 84532" → invokes `verify_proof` tool

---

### 11. MCP via stdio (local development)

```bash
cd /Users/nhn/Workspace/proofport-app-dev/proofport-ai && npm run mcp:stdio
```

This starts the MCP server in stdio mode for local development. Useful for testing with MCP Inspector or any stdio-based MCP client.

---

## Part C: OpenAI Chat Interface Testing

### 12. GET /v1/models

```bash
curl -s http://localhost:4002/v1/models | jq
```

Expected:

```json
{
  "object": "list",
  "data": [{ "id": "zkproofport", "object": "model", "owned_by": "zkproofport" }]
}
```

---

### 13. POST /v1/chat/completions (non-streaming)

```bash
curl -s -X POST http://localhost:4002/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"what circuits do you support?"}]}'
```

Expected: OpenAI-compatible response object with `choices[0].message.content` containing circuit information.

---

### 14. POST /v1/chat/completions (streaming)

```bash
curl -N -X POST http://localhost:4002/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"stream":true,"messages":[{"role":"user","content":"what circuits do you support?"}]}'
```

Expected: SSE stream with `data: {...}` delta chunks, ending with `data: [DONE]`. Each chunk contains `choices[0].delta.content` with a fragment of the response.

---

### 15. Session Management

The chat interface supports multi-turn conversations via session headers.

```bash
# First request — auto-creates session, response headers include X-Session-Id and X-Session-Secret
RESP=$(curl -si -X POST http://localhost:4002/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hello"}]}')

echo "$RESP" | grep -i "x-session"
```

Extract `X-Session-Id` and `X-Session-Secret` from the response headers. Pass them in subsequent requests to continue the same session:

```bash
curl -s -X POST http://localhost:4002/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: <session-id>" \
  -H "X-Session-Secret: <session-secret>" \
  -d '{"messages":[{"role":"user","content":"what did I just say?"}]}'
```

Expected: The agent references the prior turn (if session history is maintained server-side).

---

## Part D: REST API Testing

### 16. GET /api/v1/circuits

```bash
curl -s http://localhost:4002/api/v1/circuits | jq
```

Expected: JSON array of circuit objects, each containing `id`, `displayName`, `verifierAddress`, `easSchemaId`, `functionSelector`, and `requiredInputs`.

---

### 17. POST /api/v1/proofs/verify

```bash
curl -s -X POST http://localhost:4002/api/v1/proofs/verify \
  -H "Content-Type: application/json" \
  -d '{
    "circuitId": "coinbase_attestation",
    "proof": "0xfake",
    "publicInputs": ["0x0000000000000000000000000000000000000000000000000000000000000000"],
    "chainId": "84532"
  }' | jq
```

Expected: `{"valid": false, "error": "..."}` (on-chain revert for invalid proof bytes). A real proof returns `{"valid": true, "verifierAddress": "0x..."}`.

---

### 18. POST /api/v1/proofs (generate proof)

```bash
curl -s -X POST http://localhost:4002/api/v1/proofs \
  -H "Content-Type: application/json" \
  -d '{
    "circuitId": "coinbase_attestation",
    "scope": "test.com",
    "address": "0xD6C714247037E5201B7e3dEC97a3ab59a9d2F739",
    "signature": "0x..."
  }' | jq
```

Expected: Either a completed proof response with `proof`, `publicInputs`, and `nullifier` fields, or a signing URL response if the wallet requires user action (Phase 2 web signing).

---

## Part E: ERC-8004 Identity Testing

### 19. Discovery Endpoints

```bash
# OASF agent descriptor — should include agentRegistry and agentId registrations
curl -s http://localhost:4002/.well-known/oasf.json | jq '.registrations'

# A2A agent card — should include identity.erc8004 block
curl -s http://localhost:4002/.well-known/agent.json | jq '.identity'

# MCP discovery
curl -s http://localhost:4002/.well-known/mcp.json | jq

# Identity status
curl -s http://localhost:4002/identity/status | jq
```

Expected from `agent.json`:

```json
{
  "erc8004": {
    "contractAddress": "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    "chainId": 84532,
    "tokenId": "..."
  }
}
```

Expected from `identity/status`: contract addresses, chain ID, and registration state.

---

### 20. On-Chain Identity Verification

Verify the prover agent identity on-chain:

- **Base Sepolia Identity Registry:** `0x8004A818BFB912233c491871b3d84c89A494BD9e`
- **Prover Agent Address:** `0x5A3E649208Ae15ec52496c1Ae23b2Ff89Ac02f0c`
- **8004scan (Testnet):** [https://testnet.8004scan.io](https://testnet.8004scan.io)

> Note: The ValidationRegistry (`0x8004C269...`) currently references a different Identity contract (`0x8004AA63...`) than the one 8004scan indexes (`0x8004A818...`). TEE validation is skipped at runtime until a compatible ValidationRegistry is deployed. No agents on testnet.8004scan.io have successful validations yet — this is expected.

---

## Part F: x402 Payment Testing

### 21. Payment Status

```bash
curl -s http://localhost:4002/payment/status | jq
```

Expected: Payment mode (`disabled`, `testnet`, or `mainnet`), USDC address, price per proof, and facilitator URL.

---

### 22. x402 Payment Flow (requires PAYMENT_MODE=testnet)

When `PAYMENT_MODE=testnet` is set, `POST /a2a` with `generate_proof` returns HTTP 402 without a payment authorization header.

Full flow test:

```bash
node /Users/nhn/Workspace/proofport-app-dev/proofport-ai/scripts/test-x402-payment.ts
```

Or use the staging E2E script:

```bash
node /Users/nhn/Workspace/proofport-app-dev/proofport-ai/scripts/e2e-test.mjs
```

**Manual 402 flow verification:**

```bash
# Without payment header — expect 402
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:4002/a2a \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"role":"user","parts":[{"kind":"data","mimeType":"application/json","data":{"skill":"generate_proof","address":"0xD6C714247037E5201B7e3dEC97a3ab59a9d2F739","scope":"test.com","circuitId":"coinbase_attestation"}}]}}}'
```

Expected: `402`

> **Note:** Never skip x402 payment E2E tests. Base Sepolia is testnet — no real money involved.
> Test payer wallet: `0x8e635EDd51d35A1db33Ef24C9B99B87E1156604B`
> x402 USDC (Base Sepolia): `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, price `$0.10` = 100000 units.

---

## Part G: Phoenix Tracing

### 23. Settings Configuration

Before checking traces, configure the Phoenix connection in a2a-ui:

1. Click the **Settings** tab in the top navigation bar.
2. In the **Arize Phoenix** section, enter the Server URL: `http://localhost:6006`
3. Toggle **Enable Arize Phoenix Integration** to ON.
4. Click **Save**.

This enables the trace sidebar in the chat view, which shows per-conversation Phoenix spans inline alongside messages.

> Note: Settings are stored in the browser's local storage (`a2a-ui-settings` key) and persist between sessions.

---

### 24. Checking Traces

Open [http://localhost:6006](http://localhost:6006) in a browser.

**Steps:**

1. On the Phoenix home screen, locate the **proveragent.eth** project. This project is auto-created when the agent emits its first OTLP trace.
2. Click on the project to view the trace list.
3. Each conversation message generates a new trace. Select a trace to inspect its spans.

**Expected trace structure:**

- `a2a.message.send` or `a2a.message.stream` span — top-level span covering the full request handling cycle (name varies by transport mode)
- `a2a.task.process` span — span covering skill execution, with `a2a.skill` and `a2a.task_id` attributes
- `session_id` attribute on spans — matches the Context ID shown in the Agent Details panel for the active conversation
- OK/ERROR status — successful skills show OK, failed skills (missing params, unknown skill) show ERROR

Traces appear within 1-2 seconds after a message is sent (using `SimpleSpanProcessor` for immediate flush).

---

## Comprehensive Test Checklist

| # | Test | Interface | Command/Action | Expected | Status |
|---|------|-----------|----------------|----------|--------|
| 1 | Health check | HTTP | `GET /health` | 200, status: ok | |
| 2 | Payment status | HTTP | `GET /payment/status` | 200, mode info | |
| 3 | Signing status | HTTP | `GET /signing/status` | 200, providers | |
| 4 | TEE status | HTTP | `GET /tee/status` | 200, mode info | |
| 5 | Identity status | HTTP | `GET /identity/status` | 200, ERC-8004 contracts | |
| 6 | OASF discovery | HTTP | `GET /.well-known/oasf.json` | agent descriptor with registrations | |
| 7 | A2A agent card | HTTP | `GET /.well-known/agent.json` | 3 skills, identity block | |
| 8 | MCP discovery | HTTP | `GET /.well-known/mcp.json` | 3 tools listed | |
| 9 | OpenAPI spec | HTTP | `GET /openapi.json` | valid OpenAPI spec | |
| 10 | A2A text: list circuits | A2A | `message/send` text | completed, circuits artifact | |
| 11 | A2A DataPart: get_circuits | A2A | `message/send` DataPart | completed, circuit data | |
| 12 | A2A DataPart: verify_proof | A2A | `message/send` DataPart | completed, valid field | |
| 13 | A2A DataPart: generate_proof | A2A | `message/send` DataPart | completed or signing URL | |
| 14 | A2A streaming | A2A | `message/stream` | SSE events received | |
| 15 | A2A error: unrecognized text | A2A | `message/send` unknown text | -32602, skill not found | |
| 16 | A2A error: missing params | A2A | `message/send` partial params | error artifact with missing fields | |
| 17 | A2A error: empty message | A2A | `message/send` empty | -32602 | |
| 18 | MCP initialize | MCP | `POST /mcp` initialize | server info, protocolVersion | |
| 19 | MCP tools/list | MCP | `POST /mcp` tools/list | 3 tools returned | |
| 20 | MCP get_supported_circuits | MCP | `tools/call` | circuit data SSE response | |
| 21 | MCP verify_proof | MCP | `tools/call` fake proof | valid: false, error field | |
| 22 | MCP generate_proof | MCP | `tools/call` | proof or signing URL | |
| 23 | MCP GET rejected | MCP | `GET /mcp` | 405 Method Not Allowed | |
| 24 | REST list circuits | REST | `GET /api/v1/circuits` | circuit array | |
| 25 | REST verify proof | REST | `POST /api/v1/proofs/verify` | valid field | |
| 26 | REST generate proof | REST | `POST /api/v1/proofs` | proof data or signing URL | |
| 27 | Chat models | OpenAI | `GET /v1/models` | zkproofport model listed | |
| 28 | Chat completions | OpenAI | `POST /v1/chat/completions` | assistant response | |
| 29 | Chat streaming | OpenAI | `POST stream:true` | SSE delta chunks, [DONE] | |
| 30 | Chat session | OpenAI | session headers | X-Session-Id returned | |
| 31 | ERC-8004 identity block | ERC-8004 | `/.well-known/agent.json` | identity.erc8004 present | |
| 32 | ERC-8004 registrations | ERC-8004 | `/.well-known/oasf.json` | registrations array | |
| 33 | x402 payment status | Payment | `GET /payment/status` | mode info | |
| 34 | x402 402 response | Payment | `POST /a2a` generate_proof | HTTP 402 (when PAYMENT_MODE=testnet) | |
| 35 | Phoenix traces | Tracing | Phoenix UI at :6006 | traces visible per message | |

---

## Automated Test Suite

### Unit and Integration Tests (Vitest)

```bash
cd /Users/nhn/Workspace/proofport-app-dev/proofport-ai && npm test
```

Covers: A2A handler, task worker, MCP tools, chat handler, payment middleware, signing, TEE, identity, circuits.

### Docker Stack E2E (bash)

```bash
# Start stack
./scripts/a2a-test.sh

# Run all automated assertions
npm run test:e2e

# Quick mode (skip Phoenix trace check)
npm run test:e2e:quick
```

### Staging E2E (real payment + proof on Base Sepolia)

```bash
node /Users/nhn/Workspace/proofport-app-dev/proofport-ai/scripts/e2e-test.mjs
```

---

## Stop Test Stack

```bash
./scripts/a2a-test-stop.sh
```

This stops and removes all 5 test containers (ai, redis, a2a-ui, phoenix, phoenix-proxy) while preserving any local data volumes.

---

## Troubleshooting

### "Cannot connect to agent" in a2a-ui

Verify the full stack is running:

```bash
docker compose -f docker-compose.yml -f docker-compose.test.yml ps
```

Check agent health directly:

```bash
curl http://localhost:4002/health
```

If health returns an error, inspect the `ai` container logs:

```bash
docker compose -f docker-compose.yml -f docker-compose.test.yml logs ai
```

### Agent shows "Unknown" in conversation

The agent was deleted from the Agents list after the conversation was created. The conversation retains a stale agent reference. Delete the affected conversation and create a new one after re-registering the agent.

### "Network error: Failed to fetch" when sending a message

This is a CORS rejection. The `ai` container must have `A2A_CORS_ORIGINS=http://localhost:3001` set.

Verify:

```bash
docker compose -f docker-compose.yml -f docker-compose.test.yml exec ai env | grep CORS
```

If the variable is missing, check `.env.development` for the `A2A_CORS_ORIGINS` entry and restart the stack.

### MCP curl returns no output

Ensure `Accept: application/json, text/event-stream` header is included. Without it the server may reject the request or return an empty body. The MCP StreamableHTTP transport uses SSE framing even for single-response calls.

### Chat completions return 404

Verify the `/v1` routes are registered. Check that the server started without errors:

```bash
docker compose -f docker-compose.yml -f docker-compose.test.yml logs ai | grep "v1"
```

### Phoenix shows no traces

Verify the OTLP endpoint is configured in the `ai` container:

```bash
docker compose -f docker-compose.yml -f docker-compose.test.yml exec ai env | grep PHOENIX
```

Expected: `PHOENIX_COLLECTOR_ENDPOINT=http://phoenix:6006`

Check Phoenix is accepting connections:

```bash
curl http://localhost:6006/healthz
```

Traces appear within 1-2 seconds (using `SimpleSpanProcessor` for immediate flush). The OTLP exporter uses protobuf format (`@opentelemetry/exporter-trace-otlp-proto`) — Phoenix rejects JSON format.

### Port conflict

Ports `3001` (a2a-ui), `4002` (proofport-ai), and `6006` (Phoenix) must be free before starting the stack.

Check for conflicts:

```bash
lsof -i :3001 -i :4002 -i :6006
```

Stop any process occupying those ports before running `./scripts/a2a-test.sh`.

### x402 payment returns 500 instead of 402

Check that `PAYMENT_MODE` is set to `testnet` (not `disabled`) and that the x402 middleware is properly initialized:

```bash
docker compose -f docker-compose.yml -f docker-compose.test.yml exec ai env | grep PAYMENT
curl -s http://localhost:4002/payment/status | jq
```

If `PAYMENT_MODE=disabled`, the middleware is bypassed and `generate_proof` proceeds without payment — no 402 is returned.
