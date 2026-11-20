const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');
const { seed } = require('../src/seed');

const ADMIN = 'test-key';
const SECRET = 'app-secret';
const PHONE = '27821234567';
let server, base, db, app;
let clock = Date.parse('2026-11-25T13:00:00Z'); // Wednesday 1pm (UTC; seeded hours Mon–Thu 11:00–22:00)

// Fake WhatsApp API: records everything the bot sends.
let sent = [];
const fakeFetch = async (url, opts) => {
  sent.push({ url, body: JSON.parse(opts.body) });
  return { ok: true, json: async () => ({}), text: async () => '' };
};
const outgoing = () => sent.filter((m) => m.body.status !== 'read').map((m) => m.body);
const last = () => outgoing().at(-1);
const bodyText = (m) => m.text?.body ?? m.interactive?.body?.text ?? '';
const choices = (m) => (m.interactive?.type === 'button'
  ? m.interactive.action.buttons.map((b) => ({ id: b.reply.id, title: b.reply.title }))
  : m.interactive?.action.sections.flatMap((s) => s.rows.map((r) => ({ id: r.id, title: r.title }))) ?? []);
const idFor = (m, title) => {
  const c = choices(m).find((x) => x.title.includes(title));
  assert.ok(c, `no choice containing "${title}" in ${JSON.stringify(choices(m))}`);
  return c.id;
};

before(async () => {
  db = openDatabase(':memory:');
  seed(db);
  app = createApp(db, {
    adminApiKey: ADMIN, timezone: 'UTC', storeName: 'Test Store', currencySymbol: 'R',
    taxRateBps: 1500, pricesIncludeTax: true, prepTimeMinutes: 20, orderCutoffMinutes: 15, slotIntervalMinutes: 15, maxDaysAhead: 7,
    now: () => clock,
    whatsapp: { token: 'tok', phoneNumberId: '123', appSecret: SECRET, verifyToken: 'verify-me', handoffHours: 2 },
    fetch: fakeFetch,
  });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections(); server.close(); db.close(); });
beforeEach(() => { sent = []; clock = Date.parse('2026-11-25T13:00:00Z'); });

let msgSeq = 0;
function payload(phone, message, name = 'Thandi Mokoena') {
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: '123' },
      contacts: [{ wa_id: phone, profile: { name } }],
      messages: [{ from: phone, id: `wamid.${++msgSeq}`, timestamp: '0', ...message }],
    } }] }],
  };
}

async function deliver(body, { signature } = {}) {
  const raw = JSON.stringify(body);
  const sig = signature ?? `sha256=${crypto.createHmac('sha256', SECRET).update(raw).digest('hex')}`;
  const res = await fetch(`${base}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: raw });
  await app.locals.whatsapp.idle();
  return res.status;
}
const say = (text, phone = PHONE) => deliver(payload(phone, { type: 'text', text: { body: text } }));
const tap = (id, phone = PHONE) => deliver(payload(phone, { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: id } } }));

async function admin(method, path, body) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` }, body: body && JSON.stringify(body) });
  const text = await res.text();
  await app.locals.whatsapp.idle();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('webhook verification and signatures', async () => {
  const ok = await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '12345');
  const bad = await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`);
  assert.equal(bad.status, 403);

  assert.equal(await deliver(payload(PHONE, { type: 'text', text: { body: 'hi' } }), { signature: 'sha256=00' }), 401);
  assert.equal(outgoing().length, 0);
});

test('duplicate deliveries are only answered once', async () => {
  const p = payload('27830000001', { type: 'text', text: { body: 'hi' } });
  await deliver(p);
  await deliver(p);
  assert.equal(outgoing().length, 1);
});

test('a customer can order over WhatsApp from greeting to confirmation', async () => {
  await say('Hi');
  let m = last();
  assert.equal(m.to, PHONE);
  assert.match(bodyText(m), /Hi Thandi! .*Test Store/s);
  assert.match(bodyText(m), /open until 22:00/);
  assert.deepEqual(choices(m).map((c) => c.id), ['order', 'status', 'staff']);

  await tap('order');
  m = last();
  assert.equal(m.interactive.type, 'list');
  await tap(idFor(m, 'Mains'));
  m = last();
  await tap(idFor(m, 'Classic Burger'));

  m = last(); // Cooked: required, 3 options → buttons
  assert.equal(m.interactive.type, 'button');
  assert.match(bodyText(m), /Choose your \*Cooked\*/);
  await tap(idFor(m, 'Medium rare'));

  m = last(); // Side
  await tap(idFor(m, 'Sweet potato'));

  m = last(); // Extras: multi-select list with "No thanks"
  assert.equal(m.interactive.type, 'list');
  assert.equal(choices(m)[0].title, 'No thanks');
  await tap(idFor(m, 'Bacon'));
  m = last();
  assert.match(bodyText(m), /So far: Bacon/);
  assert.equal(choices(m)[0].title, '✅ Done');
  await tap('opt:done');

  m = last(); // quantity
  assert.match(bodyText(m), /How many \*Classic Burger\* \(Medium rare, Sweet potato fries, Bacon\)\?/);
  assert.match(bodyText(m), /R19\.49 each/);
  await say('2');

  const added = outgoing().at(-2);
  assert.match(bodyText(added), /✅ Added 2× Classic Burger — R38\.98/);
  m = last();
  assert.match(bodyText(m), /\*Total: R38\.98\* \(incl\. VAT R5\.08\)/);
  await tap('checkout');

  m = last(); // name: offers the WhatsApp profile name
  assert.match(bodyText(m), /What name/);
  assert.equal(choices(m)[0].id, 'name:profile');
  await say('Thandi');

  m = last(); // open now → ASAP or choose a time
  assert.deepEqual(choices(m).map((c) => c.id), ['time:asap', 'time:pick']);
  await tap('time:asap');

  m = last();
  assert.match(bodyText(m), /Please check your order/);
  assert.match(bodyText(m), /👤 Thandi/);
  await tap('place');

  m = last();
  const code = bodyText(m).match(/Order number: \*([A-Z0-9]+)\*/)[1];
  assert.match(bodyText(m), /Please pay at the counter/);

  const order = db.prepare('SELECT * FROM orders WHERE code = ?').get(code);
  assert.equal(order.source, 'whatsapp');
  assert.equal(order.customer_phone, `+${PHONE}`);
  assert.equal(order.customer_name, 'Thandi');
  assert.equal(order.total_cents, 3898); // VAT included, not added
  assert.equal(order.tax_cents, 508);

  // Status updates go back to the customer on WhatsApp
  sent = [];
  await admin('PATCH', `/api/admin/orders/${order.id}/status`, { status: 'confirmed' });
  assert.match(bodyText(last()), new RegExp(`order \\*${code}\\* is confirmed`));
  await admin('PATCH', `/api/admin/orders/${order.id}/status`, { status: 'preparing' });
  await admin('PATCH', `/api/admin/orders/${order.id}/status`, { status: 'ready' });
  assert.match(bodyText(last()), /ready for collection at Test Store/);

  // Tracking shows the latest status; the name is remembered next time
  await tap('status');
  assert.match(bodyText(last()), /Ready for collection/);
});

test('when closed, customers can order ahead for a time slot', async () => {
  const phone = '27830000002';
  clock = Date.parse('2026-11-25T23:00:00Z'); // closed
  await say('hello', phone);
  assert.match(bodyText(last()), /closed right now.*Tomorrow 11:00/s);

  await tap('order', phone);
  await tap(idFor(last(), 'Drinks'), phone);
  await tap(idFor(last(), 'Sparkling Water'), phone);
  await tap('qty:1', phone); // no options → straight to quantity
  await tap('checkout', phone);
  await say('Sipho', phone);

  const m = last(); // no ASAP option, goes straight to slots
  assert.equal(m.interactive.type, 'list');
  assert.equal(choices(m)[0].title, 'Tomorrow 11:30'); // 11:00 opening + 20 min prep → 11:30
  assert.equal(choices(m).at(-1).title, 'More…');
  await tap(choices(m)[1].id, phone);
  assert.match(bodyText(last()), /🕒 Tomorrow 11:45/);
  await tap('place', phone);

  const order = db.prepare('SELECT * FROM orders WHERE customer_phone = ?').get(`+${phone}`);
  assert.equal(order.scheduled_for, '2026-11-26T11:45:00.000Z');
});

test('customers can edit their cart and cancel a pending order', async () => {
  const phone = '27830000003';
  await say('hi', phone);
  await tap('order', phone);
  await tap(idFor(last(), 'Starters'), phone);
  await tap(idFor(last(), 'Garlic Bread'), phone);
  await tap('qty:3', phone);
  await tap('order', phone);
  await tap(idFor(last(), 'Starters'), phone);
  await tap(idFor(last(), 'Tomato Soup'), phone);
  await say('1', phone);
  assert.match(bodyText(last()), /3× Garlic Bread[\s\S]*1× Tomato Soup/);

  await tap('editcart', phone);
  await tap(idFor(last(), 'Remove 3× Garlic Bread'), phone);
  assert.doesNotMatch(bodyText(last()), /Garlic Bread/);

  await tap('checkout', phone);
  await say('Lerato', phone);
  await tap('time:asap', phone);
  await tap('place', phone);
  await tap('status', phone);
  const cancelId = idFor(last(), 'Cancel order');
  await tap(cancelId, phone);
  assert.match(bodyText(last()), /has been cancelled/);
  assert.equal(db.prepare('SELECT status FROM orders WHERE customer_phone = ?').get(`+${phone}`).status, 'cancelled');
});

test('"Talk to staff" pauses the bot until staff hand back', async () => {
  const phone = '27830000004';
  await say('hi', phone);
  await tap('staff', phone);
  assert.match(bodyText(last()), /team member will reply/);

  const before = outgoing().length;
  await say('Do you have gluten-free wraps?', phone);
  assert.equal(outgoing().length, before, 'bot stays quiet during handoff');

  let chats = (await admin('GET', '/api/admin/whatsapp/chats')).body.data;
  const chat = chats.find((c) => c.phone === phone);
  assert.equal(chat.needs_staff, true);
  assert.equal(chat.staff_handling, true);
  assert.equal(chats[0].phone, phone, 'chats needing staff are listed first');

  const reply = await admin('POST', `/api/admin/whatsapp/chats/${phone}/messages`, { text: 'Yes we do! 😊' });
  assert.equal(reply.status, 201);
  assert.equal(bodyText(last()), 'Yes we do! 😊');

  const thread = (await admin('GET', `/api/admin/whatsapp/chats/${phone}/messages`)).body;
  assert.deepEqual(thread.messages.slice(-2).map((m) => m.author), ['customer', 'staff']);
  assert.equal(thread.chat.needs_staff, false);

  await admin('POST', `/api/admin/whatsapp/chats/${phone}/release`);
  assert.match(bodyText(last()), /Type \*MENU\*/);
  await say('hi', phone);
  assert.deepEqual(choices(last()).map((c) => c.id), ['order', 'status', 'staff']);
});

test('customer can return to the bot with MENU, and handoff expires', async () => {
  const phone = '27830000005';
  await say('staff', phone);
  await say('menu', phone);
  assert.deepEqual(choices(last()).map((c) => c.id), ['order', 'status', 'staff']);

  await say('staff', phone);
  clock += 3 * 3600_000; // past the 2 hour handoff
  await say('hi', phone);
  assert.deepEqual(choices(last()).map((c) => c.id), ['order', 'status', 'staff']);
});

test('staff can only send free-form replies within 24 hours', async () => {
  const phone = '27830000006';
  await say('hi', phone);
  clock += 25 * 3600_000;
  const res = await admin('POST', `/api/admin/whatsapp/chats/${phone}/messages`, { text: 'Hello?' });
  assert.equal(res.status, 409);
});

test('unsupported messages get a helpful reply', async () => {
  await deliver(payload('27830000007', { type: 'image', image: { id: 'x' } }));
  assert.match(bodyText(last()), /only read text messages/);
});

test('without WhatsApp settings the webhook is off and says what is missing', async () => {
  const local = openDatabase(':memory:');
  const offApp = createApp(local, { adminApiKey: ADMIN, whatsapp: { token: '', phoneNumberId: '', appSecret: '', verifyToken: '' } });
  const srv = await new Promise((resolve) => { const s = offApp.listen(0, () => resolve(s)); });
  const url = `http://127.0.0.1:${srv.address().port}`;
  const res = await fetch(`${url}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /WHATSAPP_TOKEN/);
  const status = await fetch(`${url}/api/admin/whatsapp/status`, { headers: { authorization: `Bearer ${ADMIN}` } });
  assert.equal((await status.json()).enabled, false);
  srv.closeAllConnections();
  srv.close();
  local.close();
});
