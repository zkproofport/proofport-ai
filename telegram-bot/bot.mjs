import TelegramBot from 'node-telegram-bot-api';

// ─── Configuration ───────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_API_URL = process.env.CHAT_API_URL || 'https://stg-ai.zkproofport.app/v1/chat/completions';

if (!BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN environment variable is not set.');
  process.exit(1);
}

console.log('proveragent.base.eth Telegram Bot starting...');
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
async function callChatAPIStreaming(message, session, onStep) {
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
      steps: [],
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
  const steps = [];
  let currentEventType = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      // Skip heartbeat comments and empty lines
      if (!line || line.startsWith(':')) continue;

      if (line.startsWith('event: ')) {
        currentEventType = line.slice(7).trim();
        continue;
      }

      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);

          // Handle named step events
          if (currentEventType === 'step') {
            const stepMessage = parsed.message;
            steps.push(stepMessage);
            if (onStep) onStep(stepMessage);
            currentEventType = null;
            continue;
          }

          // Check for SSE error events
          if (parsed.error) {
            return {
              status: 200,
              content: fullContent,
              steps,
              error: parsed.error.message,
              headers: sessionHeaders,
            };
          }

          // Default: content chunk
          currentEventType = null;
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            fullContent += delta.content;
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
    steps,
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
 * Extract all HTTPS URLs from text, replace with HTML <a> links, and return inline keyboard buttons for sign/pay.
 * Uses placeholder approach: URLs → placeholders → escapeHtml → replace placeholders with <a> tags.
 * Returns { cleanedText, buttons, hasHtml }.
 */
function extractAndReplaceUrls(text) {
  const urlRegex = /https?:\/\/[^\s)<>]+/g;
  const buttons = [];
  const replacements = [];
  const seenUrls = new Set();

  const matches = [...text.matchAll(urlRegex)];
  for (const match of matches) {
    let url = match[0];
    // Strip trailing punctuation that's not part of URL
    url = url.replace(/[.,;:!?'"]+$/, '');
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);
    if (!url.startsWith('https://')) continue;

    // Determine label and whether to create inline keyboard button
    let label, emoji;
    let addButton = false;
    if (/\/pay\//.test(url)) {
      label = 'Pay with USDC'; emoji = '💳'; addButton = true;
    } else if (/\/s\//.test(url)) {
      label = 'Connect Wallet & Sign'; emoji = '✍️'; addButton = true;
    } else if (/\/v\//.test(url)) {
      label = 'Verify Proof'; emoji = '✅';
    } else if (/\/a\//.test(url)) {
      label = 'View Attestation'; emoji = '🔒';
    } else if (/basescan\.org/.test(url)) {
      label = 'View on Basescan'; emoji = '🧾';
    } else if (/8004scan/.test(url)) {
      label = 'View on 8004scan'; emoji = '🔍';
    } else {
      label = 'Open Link'; emoji = '🔗';
    }

    if (addButton) {
      buttons.push({ text: `${emoji} ${label}`, url });
    }

    // Replace URL with placeholder (safe for HTML escaping)
    const placeholder = `__URL${replacements.length}__`;
    replacements.push({ placeholder, html: `<a href="${url}">${emoji} ${label}</a>` });

    const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(escaped, 'g'), placeholder);
  }

  // Clean up empty lines
  text = text.replace(/^\s*$/gm, '');
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  // Escape HTML in text, then replace placeholders with actual <a> tags
  if (replacements.length > 0) {
    text = escapeHtml(text);
    for (const { placeholder, html } of replacements) {
      text = text.replace(new RegExp(placeholder, 'g'), html);
    }
  }

  return { cleanedText: text, buttons, hasHtml: replacements.length > 0 };
}

/**
 * Escape HTML special characters for Telegram HTML parse mode.
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}


/**
 * Clean display text for Telegram:
 * - Strips > blockquote markers
 * - Strips **bold** markdown markers
 * - Strips generic ``` code block fences
 * - Converts [text](url) markdown links to just the URL
 * - Collapses excessive blank lines (3+ → 2)
 */
function cleanDisplayText(text) {
  let cleaned = text;

  // Strip > blockquote markers at start of lines
  cleaned = cleaned.replace(/^>\s?/gm, '');

  // Strip markdown bold **text** → text
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1');

  // Strip generic code block fences
  cleaned = cleaned.replace(/^```\s*\n/gm, '');
  cleaned = cleaned.replace(/\n```\s*$/gm, '');
  cleaned = cleaned.replace(/\n```\n/g, '\n');

  // Convert markdown links [text](url) to just the URL (extractAndReplaceUrls handles labels)
  cleaned = cleaned.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$2');

  // Collapse 3+ consecutive blank lines to 2
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  return cleaned.trim();
}

/**
 * Process accumulated content: extract DSL block, clean for Telegram display.
 * Strips both complete and partial/incomplete proofport DSL blocks.
 */
function processForDisplay(content) {
  const { text } = extractProofportBlock(content);
  let cleaned = cleanDisplayText(text);
  // Strip any partial/incomplete proofport block that hasn't closed yet
  cleaned = cleaned.replace(/```proofport[\s\S]*$/, '').trimEnd();
  return cleaned;
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
  const welcome = `*proveragent.base.eth*

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

// ─── General message handler (SSE streaming with step events) ───────
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

    // onStep callback: send each step as a SEPARATE Telegram message
    const onStep = async (stepMessage) => {
      try {
        const { cleanedText: stepCleaned, buttons: stepButtons, hasHtml } = extractAndReplaceUrls(stepMessage);
        const stepOptions = { disable_web_page_preview: true };
        if (hasHtml) stepOptions.parse_mode = 'HTML';
        if (stepButtons.length > 0) {
          stepOptions.reply_markup = {
            inline_keyboard: stepButtons.map(b => [{ text: b.text, url: b.url }]),
          };
        }
        await bot.sendMessage(chatId, stepCleaned || stepMessage, stepOptions);
      } catch (e) {
        console.error(`[${chatId}] Step send error:`, e.message);
      }
    };

    // Try streaming call
    let result = await callChatAPIStreaming(userMessage, session, onStep);

    // Session expired → retry without session
    if (result.status === 404 || result.status === 403) {
      console.log(`[${chatId}] Session expired, creating new session...`);
      sessions.delete(chatId);
      result = await callChatAPIStreaming(userMessage, null, onStep);
    }

    // Save session
    if (result.headers.sessionSecret) {
      sessions.set(chatId, {
        sessionId: result.headers.sessionId,
        sessionSecret: result.headers.sessionSecret,
      });
      console.log(`[${chatId}] New session created: ${result.headers.sessionId}`);
    }

    // Handle error
    if (result.error && !result.content) {
      await bot.sendMessage(chatId, `Error: ${result.error}\n\nTry /reset to start a fresh session.`, { disable_web_page_preview: true });
      return;
    }

    // Send final response as ONE message (accumulated content)
    const fullContent = result.content || '';
    const { text: displayText, data: proofportData } = extractProofportBlock(fullContent);
    const baseCleanedText = cleanDisplayText(displayText);
    const { cleanedText, buttons, hasHtml } = extractAndReplaceUrls(baseCleanedText);

    if (cleanedText || buttons.length > 0) {
      const msgOptions = {};
      if (hasHtml) msgOptions.parse_mode = 'HTML';
      if (buttons.length > 0) {
        msgOptions.reply_markup = {
          inline_keyboard: buttons.map(b => [{ text: b.text, url: b.url }]),
        };
      }
      await sendLongMessage(chatId, cleanedText, msgOptions);
    }

    // Send QR images from proofport DSL data with inline keyboard buttons
    if (proofportData?.skillResult) {
      const sr = proofportData.skillResult;

      if (sr.qrImageUrl && sr.verifyUrl) {
        try {
          await bot.sendPhoto(chatId, sr.qrImageUrl, {
            caption: 'Proof Verification',
            reply_markup: {
              inline_keyboard: [[{ text: '✅ Verify Proof On-Chain', url: sr.verifyUrl }]],
            },
          });
        } catch (e) {
          console.error(`[${chatId}] QR send failed:`, e.message);
        }
      }

      if (sr.attestationQrImageUrl && sr.attestationUrl) {
        try {
          await bot.sendPhoto(chatId, sr.attestationQrImageUrl, {
            caption: 'TEE Attestation',
            reply_markup: {
              inline_keyboard: [[{ text: '🔒 View TEE Attestation', url: sr.attestationUrl }]],
            },
          });
        } catch (e) {
          console.error(`[${chatId}] Attestation QR failed:`, e.message);
        }
      }

      if (sr.receiptQrImageUrl && sr.paymentReceiptUrl) {
        try {
          await bot.sendPhoto(chatId, sr.receiptQrImageUrl, {
            caption: 'Payment Receipt',
            reply_markup: {
              inline_keyboard: [[{ text: '🧾 View Payment Receipt', url: sr.paymentReceiptUrl }]],
            },
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

// ─── Render Web Service Keep-Alive ───────────────────────────────────
// Render requires an open HTTP port for Web Services.
// This lightweight server satisfies that requirement.
import http from 'http';
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running!');
});
server.listen(process.env.PORT || 3000, () => {
  console.log('Health server listening on port', process.env.PORT || 3000);
});
