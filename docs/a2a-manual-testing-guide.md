# A2A Manual Testing Guide

This guide documents how to manually test the proofport-ai A2A protocol agent using the a2a-ui web interface and Arize Phoenix distributed tracing.

The a2a-ui is a community-built web UI ([a2a-community/a2a-ui](https://github.com/a2a-community/a2a-ui)) that speaks the A2A JSON-RPC protocol. It runs in Docker alongside proofport-ai and Phoenix as a self-contained test stack.

---

## Prerequisites

- Docker Desktop running
- `.env.development` file present in `proofport-ai/` (copy from `.env.example` and fill in required values)
- Ports `3001`, `4002`, and `6006` free on the host

---

## 1. Start the Test Stack

Run the test stack startup script from the `proofport-ai/` directory:

```bash
./scripts/a2a-test.sh
```

This starts 4 containers: `ai`, `redis`, `a2a-ui`, and `phoenix`. Wait until all containers report healthy status.

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

## 2. Register Agent in a2a-ui

Open [http://localhost:3001](http://localhost:3001) in a browser.

**Steps:**

1. Click the **Agents** tab in the top navigation bar.
2. Click the **Add** button (top-right area of the Agents list).
3. In the dialog, enter the agent URL: `http://localhost:4002`
4. Click **Create Agent**.

**Expected result:** The agent `proveragent.eth` appears in the Agents list with status **Active** and **3 messages** (reflecting the 3 registered skills: `get_supported_circuits`, `generate_proof`, `verify_proof`).

If the agent fails to register, see the Troubleshooting section for CORS and connectivity issues.

### Delete an Agent

On the agent row, the three icon buttons are (left to right): **delete**, **edit**, **open**.

1. Click the **first icon button** (trash icon) on the agent row.
2. Confirm in the "Delete Agent" dialog.
3. The agent is permanently removed from local storage.

> Note: Deleting an agent does not delete conversations associated with it, but those conversations will show `Agent: Unknown`.

---

## 3. Create a Conversation

1. Click the **Conversations** tab in the top navigation bar.
2. Click the **Add** button.
3. Conversation name: leave as default ("New conversation") or enter a custom name.
4. Agent selector: `proveragent.eth (http://localhost:4002/a2a)` should be auto-selected from the registered agents.
5. Click **Create Conversation**.

**Expected result:** The new conversation appears in the list, showing `Agent: proveragent.eth`.

### Delete a Conversation

On the conversation row, the three icon buttons are (left to right): **delete**, **edit**, **open chat**.

1. Click the **first icon button** (trash icon) on the conversation row.
2. Confirm in the "Delete Conversation" dialog.
3. The conversation and all messages are permanently removed from local storage.

---

## 4. Open Chat and Send Messages

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

## 5. Multiple Messages and Other Queries

### Consecutive Messages

Send multiple messages in the same conversation to verify stateless skill routing:

1. `list supported circuits` — returns circuit data artifact
2. `what circuits do you support?` — same `get_supported_circuits` result (tests alternative keyword routing)
3. `verify this proof` — routes to `verify_proof` (will fail without actual proof data, but confirms routing)
4. `generate a proof` — routes to `generate_proof` (will fail without wallet/signature params, but confirms routing)

Each message should produce a separate response. proofport-ai is stateless (no conversational context), so each message is processed independently.

### Context ID

In the **Agent Details** panel (right side of chat view), the **Conversation** section shows:

- **Context ID**: a UUID used to group traces in Phoenix. Click **Edit** to change it, or **Generate** to create a new one.
- Changing the Context ID mid-conversation starts a new trace group in Phoenix, which is useful for testing trace isolation.

> Note: `generate_proof` and `verify_proof` require structured parameters (wallet address, signature, proof bytes, etc.) that cannot be provided via free-form text chat. Use the `curl` DataPart method described in Section 9 for full parameter testing of these skills.

---

## 6. Streaming Mode (Optional)

In the **Agent Details** panel (right side of chat view):

1. Toggle the **Streaming** switch to ON.
2. The mode label changes from "Standard Mode" to "Streaming Mode".
3. Send a message — the response now arrives via SSE (Server-Sent Events) streaming rather than a synchronous JSON-RPC response.

Both modes produce the same final content. Streaming is useful for observing incremental response delivery and testing the agent's streaming transport layer.

---

## 7. Settings: Configure Phoenix Integration

Before checking traces, configure the Phoenix connection in a2a-ui:

1. Click the **Settings** tab in the top navigation bar.
2. In the **Arize Phoenix** section, enter the Server URL: `http://localhost:6006`
3. Toggle **Enable Arize Phoenix Integration** to ON.
4. Click **Save**.

This enables the trace sidebar in the chat view, which shows per-conversation Phoenix spans inline alongside messages.

> Note: Settings are stored in the browser's local storage (`a2a-ui-settings` key) and persist between sessions.

---

## 8. Event List Tab

Click the **Event List** tab in the navigation bar.

This page displays system-level events (JSON-RPC calls, errors, connection events) as they occur. Events are recorded when messages are sent or agents are registered.

If no events appear, send a message in a conversation first — events are generated per JSON-RPC interaction.

---

## 9. Tasks Tab

Click the **Tasks** tab in the navigation bar.

This page shows A2A tasks created by `message/send` requests. Each message sent through a2a-ui creates a task with:

- Task ID
- Status (submitted, working, completed, failed)
- Associated skill

Tasks may not persist in the UI if they complete too quickly (synchronous `message/send` completes within the same request). For tasks with longer execution (e.g., `generate_proof`), this tab shows real-time status transitions.

---

## 10. Check Phoenix Traces

Open [http://localhost:6006](http://localhost:6006) in a browser.

**Steps:**

1. On the Phoenix home screen, locate the **proveragent.eth** project. This project is auto-created when the agent emits its first OTLP trace.
2. Click on the project to view the trace list.
3. Each conversation message generates a new trace. Select a trace to inspect its spans.

**Expected trace structure:**

- `a2a.message.send` span — top-level span covering the full request handling cycle
- `a2a.task.process` span — child span covering skill execution
- `session_id` attribute on spans — matches the Context ID shown in the Agent Details panel for the active conversation

Traces may take 2-3 seconds to appear after a message is sent, as the OTLP exporter flushes asynchronously.

---

## 11. Error Testing

Send edge-case inputs to verify error handling:

- **Empty message:** Submit a blank input. The agent should return an error response rather than crash.
- **Unrecognized text:** Send a message that does not match any skill keyword (e.g., `"what is the weather today?"`). The agent may route to a default handler or return a structured error indicating no matching skill was found.

Both cases should return valid JSON-RPC error responses, not unhandled exceptions or silent failures.

---

## 12. Advanced: curl DataPart Testing

For skills that require structured input parameters, use the A2A `DataPart` message format. This bypasses the text-based routing and directly addresses a skill with its required fields.

### get_supported_circuits

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

### verify_proof

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

### generate_proof

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

## 13. Stop Test Stack

```bash
./scripts/a2a-test-stop.sh
```

This stops and removes all 4 test containers (ai, redis, a2a-ui, phoenix) while preserving any local data volumes.

---

## Automated E2E Tests

For non-interactive regression testing, use the automated E2E suite:

```bash
# Run all 31 automated assertions
npm run test:e2e

# Quick mode (skips Phoenix trace check)
npm run test:e2e:quick
```

The automated suite covers agent registration, conversation creation, skill routing, streaming mode, and Phoenix trace verification. Run this suite after any changes to the A2A message handling, skill routing, or agent card configuration.

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

Wait 2-3 seconds after sending a message before expecting traces to appear. The OTLP batch exporter flushes on a timer, not per-request.

### Port conflict

Ports `3001` (a2a-ui), `4002` (proofport-ai), and `6006` (Phoenix) must be free before starting the stack.

Check for conflicts:

```bash
lsof -i :3001 -i :4002 -i :6006
```

Stop any process occupying those ports before running `./scripts/a2a-test.sh`.
