import TelegramBot from 'node-telegram-bot-api';

// ─── Configuration ───────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_API_URL = process.env.CHAT_API_URL || 'https://stg-ai.zkproofport.app/api/v1/chat';

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN environment variable is not set.');
  process.exit(1);
}

console.log('🤖 ZKProofport Telegram Bot starting...');
console.log(`📡 Chat API: ${CHAT_API_URL}`);

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ─── Session Store (chatId → { sessionId, sessionSecret }) ───────────
const sessions = new Map();

// ─── Helper: Call Chat API ───────────────────────────────────────────
async function callChatAPI(message, session) {
  const body = { message };

  if (session) {
    body.sessionId = session.sessionId;
    body.sessionSecret = session.sessionSecret;
  }

  const resp = await fetch(CHAT_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  return { status: resp.status, data: await resp.json() };
}

// ─── Helper: Split and send long messages (Telegram 4096 char limit) ─
async function sendLongMessage(chatId, text, options = {}) {
  const MAX_LEN = 4000;
  if (text.length <= MAX_LEN) {
    return bot.sendMessage(chatId, text, options);
  }

  // Split long messages into multiple chunks
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) {
      chunks.push(remaining);
      break;
    }
    // Split at newline boundaries for natural breaks
    let splitIdx = remaining.lastIndexOf('\n', MAX_LEN);
    if (splitIdx < MAX_LEN / 2) splitIdx = MAX_LEN;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }

  for (const chunk of chunks) {
    await bot.sendMessage(chatId, chunk, options);
  }
}

// ─── /start command ──────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const welcome = `🔐 *ZKProofport Prover Agent Bot*

An AI agent that generates and verifies zero-knowledge proofs.

*Available commands:*
/circuits — List supported circuits
/reset — Reset session
/status — Check server status

*Try asking in natural language:*
• "What proofs can you generate?"
• "Generate a Coinbase KYC proof"
• "Verify my proof"

Send a message to get started! 🚀`;

  bot.sendMessage(msg.chat.id, welcome, { parse_mode: 'Markdown' });
});

// ─── /reset command ──────────────────────────────────────────────────
bot.onText(/\/reset/, (msg) => {
  sessions.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id, '🔄 Session reset. Send a new message to start a fresh session.');
});

// ─── /status command (server health check) ───────────────────────────
bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const baseUrl = CHAT_API_URL.replace('/api/v1/chat', '');
    const resp = await fetch(`${baseUrl}/health`);
    const data = await resp.json();
    const statusText = `✅ *Server Status: Healthy*
• URL: \`${baseUrl}\`
• Payment Mode: \`${data.paymentMode || 'unknown'}\``;
    bot.sendMessage(chatId, statusText, { parse_mode: 'Markdown' });
  } catch (error) {
    bot.sendMessage(chatId, `❌ Server unreachable: ${error.message}`);
  }
});

// ─── /circuits command ───────────────────────────────────────────────
bot.onText(/\/circuits/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendChatAction(chatId, 'typing');

  try {
    const { data } = await callChatAPI('List all supported circuits', sessions.get(chatId));

    if (data.sessionSecret) {
      sessions.set(chatId, {
        sessionId: data.sessionId,
        sessionSecret: data.sessionSecret,
      });
    }

    await sendLongMessage(chatId, data.response || JSON.stringify(data, null, 2));
  } catch (error) {
    bot.sendMessage(chatId, `❌ Error: ${error.message}`);
  }
});

// ─── General message handler (natural language) ──────────────────────
bot.on('message', async (msg) => {
  // Skip commands
  if (!msg.text || msg.text.startsWith('/')) return;

  const chatId = msg.chat.id;
  const userMessage = msg.text;

  // Show typing indicator
  await bot.sendChatAction(chatId, 'typing');

  try {
    let session = sessions.get(chatId);
    let result = await callChatAPI(userMessage, session);

    // Session expired or auth failure → retry with new session
    if (result.status === 404 || result.status === 401 || result.status === 403) {
      console.log(`[${chatId}] Session expired, creating new session...`);
      sessions.delete(chatId);
      result = await callChatAPI(userMessage, null);
    }

    const data = result.data;

    // Save session (sessionSecret is returned on first response)
    if (data.sessionSecret) {
      sessions.set(chatId, {
        sessionId: data.sessionId,
        sessionSecret: data.sessionSecret,
      });
      console.log(`[${chatId}] New session created: ${data.sessionId}`);
    }

    // Send response
    let responseText = data.response || data.error || JSON.stringify(data, null, 2);

    // Append signing URL if present
    if (data.signingUrl) {
      responseText += `\n\n🔗 *Signing page:* ${data.signingUrl}`;
    }

    await sendLongMessage(chatId, responseText);

  } catch (error) {
    console.error(`[${chatId}] Error:`, error);
    bot.sendMessage(chatId, `❌ An error occurred: ${error.message}\n\nTry /reset to start a fresh session.`);
  }
});

// ─── Error Handling ──────────────────────────────────────────────────
bot.on('polling_error', (error) => {
  console.error('Polling error:', error.code, error.message);
});

console.log('✅ Bot is listening for messages...');
