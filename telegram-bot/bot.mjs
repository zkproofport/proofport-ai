import TelegramBot from 'node-telegram-bot-api';

// ─── Configuration ───────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_API_URL = process.env.CHAT_API_URL || 'https://stg-ai.zkproofport.app/v1/chat/completions';

if (!BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN environment variable is not set.');
  process.exit(1);
}

console.log('proveragent.eth Telegram Bot starting...');
console.log(`Chat API: ${CHAT_API_URL}`);

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ─── Session Store (chatId → { sessionId, sessionSecret }) ───────────
const sessions = new Map();

// ─── Helper: Call Chat API (non-streaming, for simple commands) ──────
async function callChatAPI(message, session) {
  const headers = { 'Content-Type': 'application/json' };
  if (session) {
    headers['X-Session-Id'] = session.sessionId;
    headers['X-Session-Secret'] = session.sessionSecret;
  }

  const body = {
    messages: [{ role: 'user', content: message }],
    model: 'zkproofport',
  };

  const resp = await fetch(CHAT_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  return {
    status: resp.status,
    data: await resp.json(),
    headers: {
      sessionId: resp.headers.get('x-session-id'),
      sessionSecret: resp.headers.get('x-session-secret'),
    },
  };
}

// ─── Helper: Call Chat API with SSE streaming ────────────────────────
async function callChatAPIStreaming(message, session, onChunk) {
  const headers = { 'Content-Type': 'application/json' };
  if (session) {
    headers['X-Session-Id'] = session.sessionId;
    headers['X-Session-Secret'] = session.sessionSecret;
  }

  const body = {
    messages: [{ role: 'user', content: message }],
    model: 'zkproofport',
    stream: true,
  };

  const resp = await fetch(CHAT_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  // Check for non-streaming error responses (session expired, bad request)
  if (resp.status !== 200) {
    const errorData = await resp.json().catch(() => ({}));
    return {
      status: resp.status,
      content: '',
      error: errorData.error?.message || `HTTP ${resp.status}`,
      headers: {
        sessionId: resp.headers.get('x-session-id'),
        sessionSecret: resp.headers.get('x-session-secret'),
      },
    };
  }

  const sessionHeaders = {
    sessionId: resp.headers.get('x-session-id'),
    sessionSecret: resp.headers.get('x-session-secret'),
  };

  // Parse SSE stream
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullContent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      // Skip heartbeat comments and empty lines
      if (!line || line.startsWith(':')) continue;

      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);

          // Check for SSE error events
          if (parsed.error) {
            return {
              status: 200,
              content: fullContent,
              error: parsed.error.message,
              headers: sessionHeaders,
            };
          }

          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            fullContent += delta.content;
            onChunk(fullContent);
          }
        } catch {
          // Ignore malformed SSE data lines
        }
      }
    }
  }

  return {
    status: 200,
    content: fullContent,
    error: null,
    headers: sessionHeaders,
  };
}

/**
 * Extract response text and error from pure OpenAI-compatible response format.
 */
function parseResponse(data) {
  const content = data.choices?.[0]?.message?.content || '';
  const errorMessage = data.error?.message || null;
  return { content, errorMessage };
}

/**
 * Extract and strip ```proofport DSL block from content.
 * Returns { text, data } where text is the clean display text
 * and data is the parsed JSON from the DSL block (or null).
 */
function extractProofportBlock(content) {
  const match = content.match(/\n?\n?```proofport\n([\s\S]*?)\n```\s*$/);
  if (!match) return { text: content, data: null };

  const text = content.slice(0, match.index).trimEnd();
  try {
    const data = JSON.parse(match[1]);
    return { text, data };
  } catch {
    return { text, data: null };
  }
}

/**
 * Clean display text for Telegram:
 * - Strips generic ``` code block fences
 * - Converts [text](url) markdown links to plain: "text: url" or just url
 * - Collapses excessive blank lines (3+ → 2)
 */
function cleanDisplayText(text) {
  let cleaned = text;

  // Strip generic code block fences
  cleaned = cleaned.replace(/^```\s*\n/gm, '');
  cleaned = cleaned.replace(/\n```\s*$/gm, '');
  cleaned = cleaned.replace(/\n```\n/g, '\n');

  // Convert markdown links [text](url) to plain format
  cleaned = cleaned.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
    if (text === url) return url;
    return `${text}: ${url}`;
  });

  // Collapse 3+ consecutive blank lines to 2
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  return cleaned.trim();
}

/**
 * Process accumulated content: extract DSL block, clean for Telegram display.
 * Returns cleaned text (without DSL block and code fences).
 */
function processForDisplay(content) {
  const { text } = extractProofportBlock(content);
  return cleanDisplayText(text);
}

// ─── Helper: Split and send long messages (Telegram 4096 char limit) ─
async function sendLongMessage(chatId, text, options = {}) {
  const MAX_LEN = 4000;
  const finalOptions = { disable_web_page_preview: true, ...options };

  if (text.length <= MAX_LEN) {
    return bot.sendMessage(chatId, text, finalOptions);
  }

  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf('\n', MAX_LEN);
    if (splitIdx < MAX_LEN / 2) splitIdx = MAX_LEN;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }

  let firstMsg;
  for (const chunk of chunks) {
    const sent = await bot.sendMessage(chatId, chunk, finalOptions);
    if (!firstMsg) firstMsg = sent;
  }
  return firstMsg;
}

// ─── /start command ──────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const welcome = `*proveragent.eth*

Zero-knowledge proof generation and verification agent.

*Available commands:*
/circuits - List supported circuits
/reset - Reset session
/status - Check server status

*Try asking in natural language:*
- "What proofs can you generate?"
- "Generate a Coinbase KYC proof"
- "Verify my proof"

Send a message to get started!`;

  bot.sendMessage(msg.chat.id, welcome, { parse_mode: 'Markdown' });
});

// ─── /reset command ──────────────────────────────────────────────────
bot.onText(/\/reset/, (msg) => {
  sessions.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id, 'Session reset. Send a new message to start a fresh session.', { disable_web_page_preview: true });
});

// ─── /status command (server health check) ───────────────────────────
bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const baseUrl = CHAT_API_URL.replace('/v1/chat/completions', '');
    const resp = await fetch(`${baseUrl}/health`);
    const data = await resp.json();
    const statusText = `*Server Status: Healthy*
- URL: \`${baseUrl}\`
- Payment Mode: \`${data.paymentMode || 'unknown'}\``;
    bot.sendMessage(chatId, statusText, { parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch (error) {
    bot.sendMessage(chatId, `Server unreachable: ${error.message}`, { disable_web_page_preview: true });
  }
});

// ─── /circuits command (non-streaming) ───────────────────────────────
bot.onText(/\/circuits/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendChatAction(chatId, 'typing');

  try {
    const result = await callChatAPI('List all supported circuits', sessions.get(chatId));
    const parsed = parseResponse(result.data);

    if (result.headers.sessionSecret) {
      sessions.set(chatId, {
        sessionId: result.headers.sessionId,
        sessionSecret: result.headers.sessionSecret,
      });
    }

    const { text: displayText } = extractProofportBlock(
      parsed.content || parsed.errorMessage || JSON.stringify(result.data, null, 2)
    );
    const cleanedText = cleanDisplayText(displayText);
    await sendLongMessage(chatId, cleanedText);
  } catch (error) {
    bot.sendMessage(chatId, `Error: ${error.message}`, { disable_web_page_preview: true });
  }
});

// ─── General message handler (SSE streaming with progressive updates) ─
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;

  const chatId = msg.chat.id;
  const userMessage = msg.text;

  await bot.sendChatAction(chatId, 'typing');

  // Keep typing indicator active during long operations
  const typingInterval = setInterval(() => {
    bot.sendChatAction(chatId, 'typing').catch(() => {});
  }, 4000);

  try {
    let session = sessions.get(chatId);
    let sentMessageId = null;
    let lastEditedText = '';
    let editTimer = null;
    const EDIT_DEBOUNCE_MS = 600;

    // Debounced message update: sends first chunk immediately, then edits every 600ms
    const scheduleEdit = (accumulatedContent) => {
      const displayText = processForDisplay(accumulatedContent);
      if (!displayText || displayText === lastEditedText) return;

      if (editTimer) clearTimeout(editTimer);

      const doEdit = async () => {
        try {
          // Truncate for Telegram 4096 limit (leave room for "..." indicator)
          const text = displayText.length > 4000 ? displayText.slice(0, 3997) + '...' : displayText;

          if (!sentMessageId) {
            const sent = await bot.sendMessage(chatId, text, { disable_web_page_preview: true });
            sentMessageId = sent.message_id;
          } else {
            await bot.editMessageText(text, {
              chat_id: chatId,
              message_id: sentMessageId,
              disable_web_page_preview: true,
            });
          }
          lastEditedText = displayText;
        } catch (e) {
          // Ignore "message is not modified" and other transient errors
          if (!e.message?.includes('not modified')) {
            console.error(`[${chatId}] Edit error:`, e.message);
          }
        }
      };

      // First message: send immediately. Subsequent: debounce.
      if (!sentMessageId) {
        doEdit();
      } else {
        editTimer = setTimeout(doEdit, EDIT_DEBOUNCE_MS);
      }
    };

    // Try streaming call
    let result = await callChatAPIStreaming(userMessage, session, scheduleEdit);

    // Session expired → retry without session
    if (result.status === 404 || result.status === 403) {
      console.log(`[${chatId}] Session expired, creating new session...`);
      sessions.delete(chatId);
      sentMessageId = null;
      lastEditedText = '';
      result = await callChatAPIStreaming(userMessage, null, scheduleEdit);
    }

    // Cancel pending edit timer
    if (editTimer) clearTimeout(editTimer);

    // Save session
    if (result.headers.sessionSecret) {
      sessions.set(chatId, {
        sessionId: result.headers.sessionId,
        sessionSecret: result.headers.sessionSecret,
      });
      console.log(`[${chatId}] New session created: ${result.headers.sessionId}`);
    }

    // Handle error responses
    if (result.error && !result.content) {
      const errorText = `Error: ${result.error}\n\nTry /reset to start a fresh session.`;
      if (sentMessageId) {
        await bot.editMessageText(errorText, {
          chat_id: chatId,
          message_id: sentMessageId,
          disable_web_page_preview: true,
        }).catch(() => {});
      } else {
        await bot.sendMessage(chatId, errorText, { disable_web_page_preview: true });
      }
      return;
    }

    // Final update with complete content
    const fullContent = result.content || '';
    const { text: displayText, data: proofportData } = extractProofportBlock(fullContent);
    const cleanedText = cleanDisplayText(displayText);

    if (cleanedText && cleanedText !== lastEditedText) {
      if (cleanedText.length > 4000) {
        // Final text too long for single message — send remaining as new messages
        if (sentMessageId) {
          // Edit first message with truncated content, send overflow as new
          const firstPart = cleanedText.slice(0, 4000);
          await bot.editMessageText(firstPart, {
            chat_id: chatId,
            message_id: sentMessageId,
            disable_web_page_preview: true,
          }).catch(() => {});
          const overflow = cleanedText.slice(4000);
          if (overflow.trim()) {
            await bot.sendMessage(chatId, overflow.trim(), { disable_web_page_preview: true });
          }
        } else {
          await sendLongMessage(chatId, cleanedText);
        }
      } else {
        if (!sentMessageId) {
          await bot.sendMessage(chatId, cleanedText, { disable_web_page_preview: true });
        } else {
          await bot.editMessageText(cleanedText, {
            chat_id: chatId,
            message_id: sentMessageId,
            disable_web_page_preview: true,
          }).catch(() => {});
        }
      }
    }

    // Send QR images from proofport DSL data
    if (proofportData?.skillResult) {
      const sr = proofportData.skillResult;

      if (sr.qrImageUrl) {
        try {
          await bot.sendPhoto(chatId, sr.qrImageUrl, {
            caption: `Verify on-chain: ${sr.verifyUrl || ''}`,
          });
        } catch (e) {
          console.error(`[${chatId}] QR send failed:`, e.message);
        }
      }

      if (sr.receiptQrImageUrl) {
        try {
          await bot.sendPhoto(chatId, sr.receiptQrImageUrl, {
            caption: `Payment receipt: ${sr.paymentReceiptUrl || ''}`,
          });
        } catch (e) {
          console.error(`[${chatId}] Receipt QR failed:`, e.message);
        }
      }
    }

  } catch (error) {
    console.error(`[${chatId}] Error:`, error);
    bot.sendMessage(chatId, `An error occurred: ${error.message}\n\nTry /reset to start a fresh session.`, { disable_web_page_preview: true });
  } finally {
    clearInterval(typingInterval);
  }
});

// ─── Error Handling ──────────────────────────────────────────────────
bot.on('polling_error', (error) => {
  console.error('Polling error:', error.code, error.message);
});

console.log('Bot is listening for messages...');
