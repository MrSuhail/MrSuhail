/**
 * Minimal WhatsApp Cloud API client (Meta Graph API).
 * Message format reference: https://developers.facebook.com/docs/whatsapp/cloud-api/messages
 *
 * Every outgoing message is written to whatsapp_messages so staff can see the whole conversation.
 */

// WhatsApp's limits for interactive messages.
const LIMITS = { buttons: 3, buttonTitle: 20, listRows: 10, rowTitle: 24, rowDescription: 72, listButton: 20, body: 1024, text: 4096 };

const cut = (s, n) => {
  const str = String(s ?? '');
  return str.length <= n ? str : `${str.slice(0, n - 1)}…`;
};

function createWhatsAppClient(db, config, { fetch = globalThis.fetch } = {}) {
  const wa = config.whatsapp;
  const url = `https://graph.facebook.com/${wa.apiVersion}/${wa.phoneNumberId}/messages`;

  function log(phone, author, body, error = null) {
    db.prepare('INSERT INTO whatsapp_messages (phone, direction, author, body, error) VALUES (?, ?, ?, ?, ?)')
      .run(phone, 'out', author, body, error);
    db.prepare('UPDATE whatsapp_chats SET last_message_at = ? WHERE phone = ?').run(new Date(config.now()).toISOString(), phone);
  }

  async function post(payload) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${wa.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`WhatsApp API ${res.status}: ${detail.slice(0, 500)}`);
    }
    return res.json().catch(() => ({}));
  }

  /** Sends a message and logs it. `summary` is the readable text stored in the log. Never throws. */
  async function send(phone, message, summary, author = 'bot') {
    try {
      await post({ recipient_type: 'individual', to: phone, ...message });
      log(phone, author, summary);
      return { ok: true };
    } catch (err) {
      log(phone, author, summary, err.message);
      console.error(`WhatsApp send to ${phone} failed:`, err.message);
      return { ok: false, error: err.message };
    }
  }

  const text = (phone, body, author) =>
    send(phone, { type: 'text', text: { body: cut(body, LIMITS.text), preview_url: false } }, body, author);

  /** Up to 3 tap-to-reply buttons. buttons: [{ id, title }] */
  function buttons(phone, body, btns, { footer } = {}) {
    const list = btns.slice(0, LIMITS.buttons);
    return send(phone, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: cut(body, LIMITS.body) },
        ...(footer ? { footer: { text: cut(footer, 60) } } : {}),
        action: { buttons: list.map((b) => ({ type: 'reply', reply: { id: b.id, title: cut(b.title, LIMITS.buttonTitle) } })) },
      },
    }, `${body}\n${list.map((b) => `[${b.title}]`).join(' ')}`);
  }

  /** A list picker with up to 10 rows. rows: [{ id, title, description? }] */
  function list(phone, body, buttonText, rows, { header, footer } = {}) {
    const items = rows.slice(0, LIMITS.listRows);
    return send(phone, {
      type: 'interactive',
      interactive: {
        type: 'list',
        ...(header ? { header: { type: 'text', text: cut(header, 60) } } : {}),
        body: { text: cut(body, LIMITS.body) },
        ...(footer ? { footer: { text: cut(footer, 60) } } : {}),
        action: {
          button: cut(buttonText, LIMITS.listButton),
          sections: [{
            title: cut(header || 'Options', 24),
            rows: items.map((r) => ({
              id: r.id,
              title: cut(r.title, LIMITS.rowTitle),
              ...(r.description ? { description: cut(r.description, LIMITS.rowDescription) } : {}),
            })),
          }],
        },
      },
    }, `${body}\n${items.map((r) => `• ${r.title}${r.description ? ` (${r.description})` : ''}`).join('\n')}`);
  }

  /** Shows the customer's message as read (blue ticks). */
  function markRead(messageId) {
    return post({ status: 'read', message_id: messageId }).catch(() => {});
  }

  return { text, buttons, list, markRead, LIMITS };
}

module.exports = { createWhatsAppClient, LIMITS, cut };
