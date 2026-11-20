const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');
const { seed } = require('../src/seed');

const ADMIN = 'test-key';
let server, base, db;

// Tests run on a fixed clock in UTC. Seeded hours: Mon–Thu 11:00–22:00, Fri–Sat 11:00–23:00, Sun 12:00–21:00.
const WED_1PM = Date.parse('2026-11-25T13:00:00Z');
let clock = WED_1PM;
const at = (iso) => { clock = Date.parse(iso); };

before(async () => {
  db = openDatabase(':memory:');
  seed(db);
  const app = createApp(db, {
    adminApiKey: ADMIN, taxRateBps: 1000, deliveryFeeCents: 500, minDeliveryOrderCents: 1000,
    timezone: 'UTC', orderCutoffMinutes: 15, prepTimeMinutes: 20, slotIntervalMinutes: 15, maxDaysAhead: 7,
    now: () => clock,
  });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.closeAllConnections(); server.close(); db.close(); });

async function call(method, path, body, { admin = false } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (admin) headers.authorization = `Bearer ${ADMIN}`;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const itemByName = async (name) => (await call('GET', `/api/items?q=${encodeURIComponent(name)}`)).body.data[0];

const optionId = (item, group, name) =>
  item.option_groups.find((g) => g.name === group).options.find((o) => o.name === name).id;

const pickupOrder = (items) => ({ customer_name: 'Ada', customer_phone: '555-0100', type: 'pickup', items });

test('menu is grouped by category and hides unavailable items', async () => {
  const { status, body } = await call('GET', '/api/menu');
  assert.equal(status, 200);
  assert.deepEqual(body.categories.map((c) => c.name), ['Starters', 'Mains', 'Desserts', 'Drinks']);
  assert.ok(body.categories[1].items.length > 0);

  const burger = await itemByName('Burger');
  await call('PATCH', `/api/admin/items/${burger.id}`, { available: false }, { admin: true });
  const after = await call('GET', '/api/menu');
  assert.ok(!after.body.categories[1].items.some((i) => i.id === burger.id));
  const all = await call('GET', '/api/menu?include_unavailable=true');
  assert.ok(all.body.categories[1].items.some((i) => i.id === burger.id));
  await call('PATCH', `/api/admin/items/${burger.id}`, { available: true }, { admin: true });
});

test('items can be filtered by tag and search', async () => {
  const vegan = await call('GET', '/api/items?tag=vegan');
  assert.ok(vegan.body.data.length >= 1);
  assert.ok(vegan.body.data.every((i) => i.tags.includes('vegan')));
  const search = await call('GET', '/api/items?q=salmon');
  assert.equal(search.body.data.length, 1);
});

test('admin routes require the API key', async () => {
  const res = await call('POST', '/api/admin/categories', { name: 'Specials' });
  assert.equal(res.status, 401);
});

test('admin can manage categories and items', async () => {
  const cat = await call('POST', '/api/admin/categories', { name: 'Specials', sort_order: 9 }, { admin: true });
  assert.equal(cat.status, 201);

  const dup = await call('POST', '/api/admin/categories', { name: 'Specials' }, { admin: true });
  assert.equal(dup.status, 409);

  const bad = await call('POST', '/api/admin/items', { category_id: cat.body.id, name: 'X', price_cents: -1 }, { admin: true });
  assert.equal(bad.status, 400);

  const item = await call('POST', '/api/admin/items',
    { category_id: cat.body.id, name: 'Lobster Roll', price_cents: 2800, tags: ['Seafood'] }, { admin: true });
  assert.equal(item.status, 201);
  assert.deepEqual(item.body.tags, ['seafood']);

  const blocked = await call('DELETE', `/api/admin/categories/${cat.body.id}`, undefined, { admin: true });
  assert.equal(blocked.status, 409);

  assert.equal((await call('DELETE', `/api/admin/items/${item.body.id}`, undefined, { admin: true })).status, 204);
  assert.equal((await call('DELETE', `/api/admin/categories/${cat.body.id}`, undefined, { admin: true })).status, 204);
});

test('quote and order use server-side prices, tax and delivery fee', async () => {
  const pizza = await itemByName('Margherita'); // 1399
  const lemonade = await itemByName('Lemonade'); // 399
  const items = [
    { menu_item_id: pizza.id, quantity: 2, price_cents: 1, options: [optionId(pizza, 'Size', '10 inch')] },
    { menu_item_id: lemonade.id, quantity: 1, options: [optionId(lemonade, 'Size', 'Regular')] },
  ];

  const quote = await call('POST', '/api/orders/quote', { type: 'delivery', items });
  assert.equal(quote.status, 200);
  assert.equal(quote.body.subtotal_cents, 3197);
  assert.equal(quote.body.tax_cents, 320);
  assert.equal(quote.body.delivery_fee_cents, 500);
  assert.equal(quote.body.total_cents, 4017);

  const noAddr = await call('POST', '/api/orders', { ...pickupOrder(items), type: 'delivery' });
  assert.equal(noAddr.status, 400);

  const order = await call('POST', '/api/orders', { ...pickupOrder(items), type: 'delivery', delivery_address: '1 Main St' });
  assert.equal(order.status, 201);
  assert.equal(order.body.status, 'pending');
  assert.equal(order.body.total_cents, 4017);
  assert.equal(order.body.items.length, 2);

  const fetched = await call('GET', `/api/orders/${order.body.code}`);
  assert.equal(fetched.body.id, order.body.id);
});

test('orders reject unavailable items, bad quantities and small delivery orders', async () => {
  const tea = await itemByName('Iced Tea');
  assert.equal((await call('POST', '/api/orders', pickupOrder([{ menu_item_id: tea.id, quantity: 0 }]))).status, 400);
  assert.equal((await call('POST', '/api/orders', pickupOrder([{ menu_item_id: 99999, quantity: 1 }]))).status, 400);
  assert.equal((await call('POST', '/api/orders', pickupOrder([]))).status, 400);

  const small = await call('POST', '/api/orders',
    { ...pickupOrder([{ menu_item_id: tea.id, quantity: 1 }]), type: 'delivery', delivery_address: 'x' });
  assert.equal(small.status, 400);

  await call('PATCH', `/api/admin/items/${tea.id}`, { available: false }, { admin: true });
  assert.equal((await call('POST', '/api/orders', pickupOrder([{ menu_item_id: tea.id, quantity: 1 }]))).status, 409);
  await call('PATCH', `/api/admin/items/${tea.id}`, { available: true }, { admin: true });
});

test('order status follows the allowed workflow', async () => {
  const bread = await itemByName('Garlic Bread');
  const { body: order } = await call('POST', '/api/orders', pickupOrder([{ menu_item_id: bread.id, quantity: 1 }]));
  const set = (status) => call('PATCH', `/api/admin/orders/${order.id}/status`, { status }, { admin: true });

  assert.equal((await set('ready')).status, 409); // can't skip steps
  assert.equal((await set('confirmed')).body.status, 'confirmed');

  // Customer can't cancel once confirmed
  assert.equal((await call('POST', `/api/orders/${order.code}/cancel`)).status, 409);

  assert.equal((await set('preparing')).status, 200);
  assert.equal((await set('ready')).status, 200);
  assert.equal((await set('out_for_delivery')).status, 409); // pickup order
  assert.equal((await set('completed')).body.status, 'completed');
  assert.equal((await set('cancelled')).status, 409);
});

test('customer can cancel a pending order and admin can list orders by status', async () => {
  const bread = await itemByName('Garlic Bread');
  const { body: order } = await call('POST', '/api/orders', pickupOrder([{ menu_item_id: bread.id, quantity: 3 }]));
  const cancel = await call('POST', `/api/orders/${order.code.toLowerCase()}/cancel`);
  assert.equal(cancel.body.status, 'cancelled');

  const list = await call('GET', '/api/admin/orders?status=cancelled', undefined, { admin: true });
  assert.ok(list.body.data.some((o) => o.id === order.id));
  assert.ok(list.body.data.every((o) => o.status === 'cancelled'));
});

test('unknown routes and malformed JSON return clean errors', async () => {
  assert.equal((await call('GET', '/api/nope')).status, 404);
  const res = await fetch(`${base}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Malformed JSON body');
});

// ---------- item options ----------

test('menu items include their option groups', async () => {
  const burger = await itemByName('Burger');
  assert.deepEqual(burger.option_groups.map((g) => g.name), ['Cooked', 'Side', 'Extras']);
  const extras = burger.option_groups[2];
  assert.equal(extras.min_select, 0);
  assert.equal(extras.max_select, 3);
  assert.equal(extras.options.find((o) => o.name === 'Bacon').price_delta_cents, 200);
});

test('options are priced into the order and stored on the line', async () => {
  const burger = await itemByName('Burger'); // 1599
  const line = {
    menu_item_id: burger.id,
    quantity: 2,
    options: [
      optionId(burger, 'Extras', 'Bacon'), // +200
      optionId(burger, 'Cooked', 'Medium'),
      optionId(burger, 'Side', 'Sweet potato fries'), // +150
      optionId(burger, 'Extras', 'Avocado'), // +150
    ],
  };
  const { status, body } = await call('POST', '/api/orders', pickupOrder([line]));
  assert.equal(status, 201);
  assert.equal(body.items[0].unit_price_cents, 2099);
  assert.equal(body.items[0].line_total_cents, 4198);
  assert.equal(body.subtotal_cents, 4198);
  // Stored in menu order, not request order
  assert.deepEqual(body.items[0].options.map((o) => `${o.group}: ${o.name}`),
    ['Cooked: Medium', 'Side: Sweet potato fries', 'Extras: Bacon', 'Extras: Avocado']);
});

test('option rules are enforced', async () => {
  const burger = await itemByName('Burger');
  const pizza = await itemByName('Margherita');
  const tea = await itemByName('Iced Tea');
  const medium = optionId(burger, 'Cooked', 'Medium');
  const fries = optionId(burger, 'Side', 'Fries');
  const order = (item, options) => call('POST', '/api/orders', pickupOrder([{ menu_item_id: item.id, quantity: 1, options }]));

  const missing = await order(burger, [medium]); // no side chosen
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /choose 1 for "Side"/);

  const extras = burger.option_groups[2].options.map((o) => o.id);
  assert.equal((await order(burger, [medium, fries, ...extras])).status, 400); // 4 extras, max 3
  assert.equal((await order(burger, [medium, fries, medium])).status, 400); // duplicate
  assert.equal((await order(burger, [medium, fries, optionId(pizza, 'Size', '10 inch')])).status, 400); // other item's option
  assert.equal((await order(burger, [medium, fries, 'bacon'])).status, 400);

  // Sold-out option
  const peach = optionId(tea, 'Flavor', 'Peach');
  const off = await call('PATCH', `/api/admin/options/${peach}`, { available: false }, { admin: true });
  assert.equal(off.status, 200);
  assert.equal(off.body.option_groups[0].options.find((o) => o.id === peach).available, false);
  assert.equal((await order(tea, [peach])).status, 409);
  assert.equal((await order(tea, [optionId(tea, 'Flavor', 'Classic')])).status, 201);
  await call('PATCH', `/api/admin/options/${peach}`, { available: true }, { admin: true });
});

test('admin can create and replace an item’s option groups', async () => {
  const mains = (await call('GET', '/api/categories')).body.data.find((c) => c.name === 'Mains');
  const created = await call('POST', '/api/admin/items', {
    category_id: mains.id, name: 'Build-a-Bowl', price_cents: 1200,
    option_groups: [
      { name: 'Base', min_select: 1, max_select: 1, options: [{ name: 'Rice' }, { name: 'Noodles' }] },
      { name: 'Protein', min_select: 1, max_select: 2, options: [{ name: 'Tofu' }, { name: 'Chicken', price_delta_cents: 300 }] },
    ],
  }, { admin: true });
  assert.equal(created.status, 201);
  assert.equal(created.body.option_groups.length, 2);

  const invalid = await call('PATCH', `/api/admin/items/${created.body.id}`, {
    option_groups: [{ name: 'Base', min_select: 3, max_select: 1, options: [{ name: 'Rice' }] }],
  }, { admin: true });
  assert.equal(invalid.status, 400);

  const replaced = await call('PATCH', `/api/admin/items/${created.body.id}`, {
    price_cents: 1300,
    option_groups: [{ name: 'Spice', max_select: 1, options: [{ name: 'Mild' }, { name: 'Hot' }] }],
  }, { admin: true });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.price_cents, 1300);
  assert.deepEqual(replaced.body.option_groups.map((g) => g.name), ['Spice']);

  // Optional group: ordering with no options is fine
  const order = await call('POST', '/api/orders', pickupOrder([{ menu_item_id: created.body.id, quantity: 1 }]));
  assert.equal(order.status, 201);
  assert.equal(order.body.subtotal_cents, 1300);

  const cleared = await call('PATCH', `/api/admin/items/${created.body.id}`, { option_groups: [] }, { admin: true });
  assert.deepEqual(cleared.body.option_groups, []);
});

// ---------- opening hours ----------

test('GET /api/hours shows the schedule and whether we are open', async () => {
  at('2026-11-25T13:00:00Z'); // Wednesday 1pm
  const { body } = await call('GET', '/api/hours');
  assert.equal(body.timezone, 'UTC');
  assert.equal(body.weekly.length, 7);
  assert.deepEqual(body.weekly.find((d) => d.day === 'wednesday'), { day: 'wednesday', open: '11:00', close: '22:00' });
  assert.equal(body.open_now, true);
  assert.equal(body.accepting_asap_orders, true);
  assert.equal(body.closes_at, '2026-11-25T22:00:00.000Z');

  at('2026-11-25T23:30:00Z'); // after close
  const closed = (await call('GET', '/api/hours')).body;
  assert.equal(closed.open_now, false);
  assert.equal(closed.next_opens_at, '2026-11-26T11:00:00.000Z');
  at('2026-11-25T13:00:00Z');
});

test('ASAP orders are refused when closed or past the cut-off', async () => {
  const bread = await itemByName('Garlic Bread');
  const place = (extra = {}) => call('POST', '/api/orders', { ...pickupOrder([{ menu_item_id: bread.id, quantity: 1 }]), ...extra });

  at('2026-11-25T08:00:00Z'); // before opening
  const early = await place();
  assert.equal(early.status, 409);
  assert.match(early.body.error, /closed right now.*2026-11-25T11:00:00.000Z/);

  at('2026-11-25T21:50:00Z'); // open, but within 15 min of closing
  const late = await place();
  assert.equal(late.status, 409);
  assert.match(late.body.error, /stopped taking orders/);

  at('2026-11-25T21:44:00Z');
  assert.equal((await place()).status, 201);
  at('2026-11-25T13:00:00Z');
});

test('orders can be scheduled for later, within opening hours', async () => {
  const bread = await itemByName('Garlic Bread');
  const place = (scheduled_for) =>
    call('POST', '/api/orders', { ...pickupOrder([{ menu_item_id: bread.id, quantity: 1 }]), scheduled_for });

  at('2026-11-25T23:30:00Z'); // closed now, but can order for tomorrow
  const ok = await place('2026-11-26T12:30:00Z');
  assert.equal(ok.status, 201);
  assert.equal(ok.body.scheduled_for, '2026-11-26T12:30:00.000Z');

  assert.equal((await place('2026-11-26T08:00:00Z')).status, 409); // before opening
  assert.equal((await place('2026-11-26T11:10:00Z')).status, 409); // less than prep time after opening
  assert.equal((await place('2026-11-25T23:40:00Z')).status, 409); // too soon / closed
  assert.equal((await place('2026-12-10T12:00:00Z')).status, 409); // too far ahead
  assert.equal((await place('tomorrow at noon')).status, 400);
  assert.equal((await place('2026-11-26T12:30:00')).status, 400); // no time zone
  at('2026-11-25T13:00:00Z');
});

test('slots respect prep time, closing time and closures', async () => {
  at('2026-11-25T13:02:00Z');
  const today = (await call('GET', '/api/hours/slots')).body;
  assert.equal(today.date, '2026-11-25');
  assert.equal(today.slots[0], '2026-11-25T13:30:00.000Z'); // 13:02 + 20 min prep, rounded up to :30
  assert.equal(today.slots.at(-1), '2026-11-25T22:00:00.000Z');

  const sunday = (await call('GET', '/api/hours/slots?date=2026-11-29')).body;
  assert.equal(sunday.slots[0], '2026-11-29T12:30:00.000Z'); // opens 12:00 + 20 min prep = 12:20, rounded up to 12:30
  assert.equal(sunday.slots.at(-1), '2026-11-29T21:00:00.000Z');

  assert.equal((await call('GET', '/api/hours/slots?date=2026-02-30')).status, 400);

  // Closed for a holiday
  const added = await call('POST', '/api/admin/closures', { date: '2026-11-26', reason: 'Thanksgiving' }, { admin: true });
  assert.equal(added.status, 201);
  assert.deepEqual((await call('GET', '/api/hours/slots?date=2026-11-26')).body.slots, []);
  assert.ok((await call('GET', '/api/hours')).body.closures.some((c) => c.reason === 'Thanksgiving'));
  const bread = await itemByName('Garlic Bread');
  const blocked = await call('POST', '/api/orders',
    { ...pickupOrder([{ menu_item_id: bread.id, quantity: 1 }]), scheduled_for: '2026-11-26T13:00:00Z' });
  assert.equal(blocked.status, 409);
  assert.equal((await call('DELETE', '/api/admin/closures/2026-11-26', undefined, { admin: true })).status, 204);
  at('2026-11-25T13:00:00Z');
});

test('admin can replace the weekly hours, including late-night shifts', async () => {
  const original = (await call('GET', '/api/hours')).body.weekly;

  const bad = await call('PUT', '/api/admin/hours', { weekly: [{ day: 'funday', open: '25:00', close: '10:00' }] }, { admin: true });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.details.length, 2);

  // Friday lunch + a dinner shift that runs past midnight
  const res = await call('PUT', '/api/admin/hours', { weekly: [
    { day: 'friday', open: '11:30', close: '14:30' },
    { day: 'friday', open: '18:00', close: '02:00' },
  ] }, { admin: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.weekly.length, 2);

  at('2026-11-27T16:00:00Z'); // Friday between shifts
  let h = (await call('GET', '/api/hours')).body;
  assert.equal(h.open_now, false);
  assert.equal(h.next_opens_at, '2026-11-27T18:00:00.000Z');

  at('2026-11-28T01:00:00Z'); // Saturday 1am, still in Friday's late shift
  h = (await call('GET', '/api/hours')).body;
  assert.equal(h.open_now, true);
  assert.equal(h.closes_at, '2026-11-28T02:00:00.000Z');

  // Empty schedule = always open
  await call('PUT', '/api/admin/hours', { weekly: [] }, { admin: true });
  at('2026-11-25T04:00:00Z');
  const always = (await call('GET', '/api/hours')).body;
  assert.equal(always.accepting_asap_orders, true);
  assert.equal(always.closes_at, null);

  await call('PUT', '/api/admin/hours', { weekly: original }, { admin: true });
  at('2026-11-25T13:00:00Z');
});

test('time zones and daylight saving are handled', () => {
  const { createSchedule } = require('../src/hours');
  const { openDatabase } = require('../src/db');
  const local = openDatabase(':memory:');
  local.prepare("INSERT INTO opening_hours (day_of_week, open_time, close_time) VALUES (0, '11:00', '22:00')").run();
  const sched = createSchedule(local, {
    timezone: 'America/New_York', orderCutoffMinutes: 15, prepTimeMinutes: 20, slotIntervalMinutes: 30, maxDaysAhead: 30,
    now: () => Date.parse('2026-10-25T12:00:00Z'),
  });
  // Sunday before DST ends (EDT, UTC-4) and the Sunday after (EST, UTC-5)
  assert.equal(sched.slots('2026-10-25').at(-1), '2026-10-26T02:00:00.000Z');
  assert.equal(sched.slots('2026-11-01')[0], '2026-11-01T16:30:00.000Z');
  assert.equal(sched.slots('2026-11-01').at(-1), '2026-11-02T03:00:00.000Z');
  local.close();
  assert.throws(() => createSchedule(local, { timezone: 'Mars/Olympus' }), /Invalid TIMEZONE/);
});
