const crypto = require('node:crypto');
const express = require('express');
const { validate } = require('../validate');
const { HttpError, notFound, conflict } = require('../errors');
const { createWhatsAppClient } = require('../whatsapp/client');
const { createBot } = require('../whatsapp/bot');

const REQUIRED = [
  ['token', 'WHATSAPP_TOKEN'],
  ['phoneNumberId', 'WHATSAPP_PHONE_NUMBER_ID'],
  ['appSecret', 'WHATSAPP_APP_SECRET'],
  ['verifyToken', 'WHATSAPP_VERIFY_TOKEN'],
];

/** Names of missing WhatsApp settings; empty when WhatsApp is fully configured. */
const missingSettings = (config) => REQUIRED.filter(([key]) => !config.whatsapp[key]).map(([, env]) => env);

/** Turns a webhook payload into simple message objects. */
function parseWebhook(body) {
  const out = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const names = Object.fromEntries((value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? '']));
      for (const m of value.messages ?? []) {
        const base = { phone: String(m.from), name: names[m.from] ?? '', messageId: m.id, type: m.type };
        if (m.type === 'text') out.push({ ...base, kind: 'text', text: m.text?.body ?? '' });
        else if (m.type === 'interactive') {
          const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
          if (r) out.push({ ...base, kind: 'reply', replyId: String(r.id), text: r.title ?? '' });
        } else if (m.type === 'button') out.push({ ...base, kind: 'text', text: m.button?.text ?? '' });
        else out.push({ ...base, kind: 'unsupported', text: `[${m.type}]` });
      }
    }
  }
  return out;
}

function validSignature(rawBody, header, secret) {
  if (!rawBody || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(rawBody).digest('hex'));
  const given = Buffer.from(header.slice(7));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * Sets up WhatsApp: the webhook Meta calls, order status notifications, and staff chat endpoints.
 * Returns { webhook, admin, idle } routers; `idle()` resolves when queued messages are processed (for tests).
 */
function createWhatsApp(db, config, { fetch } = {}) {
  const missing = missingSettings(config);
  const enabled = missing.length === 0;
  const client = createWhatsAppClient(db, config, { fetch });
  const bot = createBot(db, config, client);

  // Process each customer's messages one at a time, in order.
  const queues = new Map();
  const pending = new Set();
  function enqueue(phone, task) {
    const run = (queues.get(phone) ?? Promise.resolve()).then(task).catch((err) => console.error('WhatsApp handler error:', err));
    queues.set(phone, run);
    pending.add(run);
    run.finally(() => {
      pending.delete(run);
      if (queues.get(phone) === run) queues.delete(phone);
    });
  }
  const idle = async () => { while (pending.size) await Promise.all([...pending]); };

  if (enabled) {
    config.events?.on('order:status', (order) => enqueue(order.customer_phone, () => bot.notifyStatus(order)));
  }

  // ---------- webhook (called by Meta) ----------
  const webhook = express.Router();

  webhook.use((_req, _res, next) => next(enabled ? undefined
    : new HttpError(503, `WhatsApp is not configured. Missing: ${missing.join(', ')}`)));

  // Meta checks the webhook URL once when you set it up.
  webhook.get('/', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === config.whatsapp.verifyToken) {
      return res.type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
    }
    res.sendStatus(403);
  });

  webhook.post('/', (req, res) => {
    if (!validSignature(req.rawBody, req.get('x-hub-signature-256'), config.whatsapp.appSecret)) {
      return res.sendStatus(401);
    }
    res.sendStatus(200); // reply straight away; Meta retries slow webhooks

    for (const msg of parseWebhook(req.body)) {
      // Meta can deliver the same message twice; the unique wa_id makes the second insert a no-op.
      const { changes } = db.prepare(
        "INSERT INTO whatsapp_messages (phone, direction, author, body, wa_id) VALUES (?, 'in', 'customer', ?, ?) ON CONFLICT(wa_id) DO NOTHING"
      ).run(msg.phone, msg.text || `[${msg.type}]`, msg.messageId);
      if (!changes) continue;
      client.markRead(msg.messageId);
      enqueue(`+${msg.phone}`, () => bot.handle(msg));
    }
  });

  // ---------- staff chat (admin) ----------
  const admin = express.Router();

  const chatRow = (phone) => db.prepare('SELECT * FROM whatsapp_chats WHERE phone = ?').get(phone);
  const view = (c) => ({
    phone: c.phone,
    profile_name: c.profile_name,
    customer_name: c.customer_name,
    needs_staff: Boolean(c.needs_staff),
    staff_handling: Boolean(c.handoff_until && Date.parse(c.handoff_until) > config.now()),
    handoff_until: c.handoff_until,
    last_inbound_at: c.last_inbound_at,
    last_message_at: c.last_message_at,
    last_message: c.last_body ?? null,
  });

  admin.get('/whatsapp/status', (_req, res) => {
    res.json({
      enabled, missing_settings: missing,
      store_name: config.storeName, currency_symbol: config.currencySymbol, timezone: config.timezone,
    });
  });

  // Chats waiting for staff first, then most recent.
  admin.get('/whatsapp/chats', (_req, res) => {
    const rows = db.prepare(`SELECT c.*, (SELECT body FROM whatsapp_messages m WHERE m.phone = c.phone ORDER BY id DESC LIMIT 1) AS last_body
                             FROM whatsapp_chats c ORDER BY c.needs_staff DESC, c.last_message_at DESC LIMIT 200`).all();
    res.json({ data: rows.map(view) });
  });

  admin.get('/whatsapp/chats/:phone/messages', (req, res) => {
    const chat = chatRow(req.params.phone);
    if (!chat) throw notFound('Chat');
    const after = Number(req.query.after_id) || 0;
    const messages = db.prepare('SELECT id, direction, author, body, error, created_at FROM whatsapp_messages WHERE phone = ? AND id > ? ORDER BY id DESC LIMIT 200')
      .all(chat.phone, after).reverse();
    res.json({ chat: view(chat), messages });
  });

  // Staff reply. Pauses the bot for this chat while staff are talking.
  admin.post('/whatsapp/chats/:phone/messages', async (req, res) => {
    if (!enabled) throw new HttpError(503, 'WhatsApp is not configured');
    const { text } = validate(req.body, { text: { type: 'string', required: true, maxLength: 4000 } });
    const chat = chatRow(req.params.phone);
    if (!chat) throw notFound('Chat');
    // WhatsApp only allows free-form replies within 24 hours of the customer's last message.
    if (!chat.last_inbound_at || config.now() - Date.parse(chat.last_inbound_at) > 24 * 3600_000) {
      throw conflict("WhatsApp only allows replies within 24 hours of the customer's last message. Ask them to message you first.");
    }
    const until = new Date(config.now() + config.whatsapp.handoffHours * 3600_000).toISOString();
    db.prepare('UPDATE whatsapp_chats SET handoff_until = ?, needs_staff = 0 WHERE phone = ?').run(until, chat.phone);
    const result = await client.text(chat.phone, text, 'staff');
    if (!result.ok) throw new HttpError(502, `WhatsApp didn't accept the message: ${result.error}`);
    res.status(201).json({ ok: true });
  });

  // Hand the chat back to the bot.
  admin.post('/whatsapp/chats/:phone/release', async (req, res) => {
    const chat = chatRow(req.params.phone);
    if (!chat) throw notFound('Chat');
    const wasHandling = chat.handoff_until && Date.parse(chat.handoff_until) > config.now();
    db.prepare('UPDATE whatsapp_chats SET handoff_until = NULL, needs_staff = 0 WHERE phone = ?').run(chat.phone);
    if (enabled && wasHandling) {
      await client.text(chat.phone, 'Thanks for chatting to us! 🙂 Type *MENU* any time to place an order.');
    }
    res.json(view(chatRow(chat.phone)));
  });

  return { webhook, admin, idle, enabled, missing };
}

module.exports = { createWhatsApp, parseWebhook, validSignature, missingSettings };
