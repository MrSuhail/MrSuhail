const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');
const { seed } = require('../src/seed');

const ADMIN = 'test-key';
let server, base, db;

before(async () => {
  db = openDatabase(':memory:');
  seed(db);
  const app = createApp(db, { adminApiKey: ADMIN, taxRateBps: 1000, deliveryFeeCents: 500, minDeliveryOrderCents: 1000 });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.close(); db.close(); });

async function call(method, path, body, { admin = false } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (admin) headers.authorization = `Bearer ${ADMIN}`;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const itemByName = async (name) => (await call('GET', `/api/items?q=${encodeURIComponent(name)}`)).body.data[0];

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
  const items = [{ menu_item_id: pizza.id, quantity: 2, price_cents: 1 }, { menu_item_id: lemonade.id, quantity: 1 }];

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
  const burger = await itemByName('Burger');
  const { body: order } = await call('POST', '/api/orders', pickupOrder([{ menu_item_id: burger.id, quantity: 1 }]));
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
