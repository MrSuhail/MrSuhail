const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../src/db');
const { seed } = require('../src/seed');
const { importMenu } = require('../src/import-menu');
const { loadOptionGroups } = require('../src/options');

test('importing a menu file replaces the menu and keeps past orders', () => {
  const db = openDatabase(':memory:');
  seed(db);
  db.prepare("INSERT INTO orders (code, customer_name, customer_phone, type, subtotal_cents, tax_cents, total_cents) VALUES ('X1', 'A', '1', 'pickup', 599, 0, 599)").run();
  db.prepare("INSERT INTO order_items (order_id, menu_item_id, name, unit_price_cents, quantity) VALUES (1, 1, 'Garlic Bread', 599, 1)").run();

  const json = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'menu.example.json'), 'utf8'));
  assert.deepEqual(importMenu(db, json), { categories: 2, items: 2 });

  const items = db.prepare('SELECT * FROM menu_items ORDER BY id').all();
  assert.deepEqual(items.map((i) => [i.name, i.price_cents]), [['Example Berry Smoothie', 5990], ['Example Chicken Wrap', 7990]]);
  const groups = loadOptionGroups(db, [items[0].id]).get(items[0].id);
  assert.deepEqual(groups.map((g) => [g.name, g.min_select, g.max_select]), [['Size', 1, 1], ['Boosters', 0, 2]]);
  assert.equal(groups[0].options[1].price_delta_cents, 1000);
  assert.equal(db.prepare('SELECT name, menu_item_id FROM order_items').get().name, 'Garlic Bread');
  db.close();
});

test('a bad menu file is rejected without changing the menu', () => {
  const db = openDatabase(':memory:');
  seed(db);
  const before = db.prepare('SELECT COUNT(*) AS n FROM menu_items').get().n;
  assert.throws(() => importMenu(db, { categories: [{ name: 'Wraps', items: [{ name: 'Wrap', price: '79.90' }] }] }), /price must be a number/);
  assert.throws(() => importMenu(db, { categories: [{ name: 'A', items: [{ name: 'B', price: 1, options: [{ name: 'Size', min: 2, choices: ['One'] }] }] }] }), /min_select/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM menu_items').get().n, before);
  db.close();
});
