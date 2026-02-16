# ZKProofport Telegram Bot

A Telegram bot interface for [ZKProofport Prover Agent](https://stg-ai.zkproofport.app) — generate and verify zero-knowledge proofs through natural language conversation.

## Features

- **Natural Language Interface** — Ask questions and request proofs in plain English via the ZKProofport Chat API
- **Session Management** — Automatic per-chat session handling with transparent expiry recovery
- **Slash Commands** — `/start`, `/circuits`, `/status`, `/reset`
- **Long Message Splitting** — Gracefully handles responses exceeding Telegram's 4096-character limit
- **Signing URL Support** — Surfaces wallet signing links when proof generation requires user signatures

## Quick Start

### 1. Create a Telegram Bot

1. Open [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and set your bot token:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
```

### 3. Install & Run

```bash
npm install
npm start
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | — | Bot token from @BotFather |
| `CHAT_API_URL` | ❌ | `https://stg-ai.zkproofport.app/api/v1/chat` | ZKProofport Chat API endpoint |

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and usage guide |
| `/circuits` | List supported ZK circuits |
| `/status` | Check Prover Agent server health |
| `/reset` | Reset the current chat session |

Any other message is forwarded as natural language to the ZKProofport Chat API.

## Architecture

```
Telegram User
    │
    ▼
Telegram Bot (this repo)
    │  POST /api/v1/chat
    ▼
ZKProofport Prover Agent
    │  LLM function calling
    ▼
ZK Proof Generation / Verification
```

The bot acts as a thin relay between Telegram and the ZKProofport Chat API. Session state (`sessionId` / `sessionSecret`) is maintained in-memory per Telegram chat ID.

## Security

- **No secrets in code** — Bot token is loaded exclusively from environment variables
- **Session isolation** — Each Telegram chat gets an independent API session
- **Auto-recovery** — Expired or invalid sessions are automatically re-created
- **No data persistence** — Sessions are stored in-memory only; restarting the bot clears all sessions

## License

MIT
