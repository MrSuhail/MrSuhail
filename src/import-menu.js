/**
 * Replaces the whole menu with the contents of a JSON file.
 *
 *   npm run import-menu -- menu.json
 *
 * Prices are in normal currency units (59.90), not cents. See menu.example.json for the format.
 * Past orders are kept: they store their own copy of item names and prices.
 */
const fs = require('node:fs');
const { openDatabase, transaction } = require('./db');
const { parseOptionGroups, replaceOptionGroups } = require('./options');

const cents = (v, where) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${where}: price must be a number, e.g. 59.90`);
  return Math.round(v * 100);
};

/** Validates the file contents and converts it to rows. Throws with a readable message on problems. */
function parseMenu(json) {
  if (!json || !Array.isArray(json.categories) || !json.categories.length) throw new Error('The file needs a "categories" list');
  const seen = new Set();
  return json.categories.map((c, ci) => {
    const where = `categories[${ci}]`;
    if (!c.name || typeof c.name !== 'string') throw new Error(`${where}: missing "name"`);
    if (seen.has(c.name.toLowerCase())) throw new Error(`${where}: category "${c.name}" appears twice`);
    seen.add(c.name.toLowerCase());
    if (!Array.isArray(c.items) || !c.items.length) throw new Error(`${where} (${c.name}): needs an "items" list`);
    return {
      name: c.name.trim(),
      description: c.description ?? '',
      items: c.items.map((i, ii) => {
        const iw = `${c.name} → items[${ii}]${i.name ? ` (${i.name})` : ''}`;
        if (!i.name || typeof i.name !== 'string') throw new Error(`${iw}: missing "name"`);
        let groups = [];
        try {
          groups = parseOptionGroups((i.options ?? []).map((g) => ({
            name: g.name,
            min_select: g.min ?? (g.required ? 1 : 0),
            max_select: g.max ?? 1,
            options: (g.choices ?? []).map((o) => (typeof o === 'string'
              ? { name: o }
              : { name: o.name, price_delta_cents: o.price === undefined ? 0 : cents(o.price, `${iw} ${g.name} ${o.name}`), available: o.available ?? true })),
          })));
        } catch (err) {
          throw new Error(`${iw}: ${err.message}${err.details ? ` (${err.details.join('; ')})` : ''}`);
        }
        return {
          name: i.name.trim(),
          description: i.description ?? '',
          price_cents: cents(i.price, iw),
          tags: JSON.stringify((i.tags ?? []).map((t) => String(t).trim().toLowerCase())),
          available: i.available === false ? 0 : 1,
          image_url: i.image_url ?? null,
          groups,
        };
      }),
    };
  });
}

function importMenu(db, json) {
  const categories = parseMenu(json);
  transaction(db, () => {
    db.exec('DELETE FROM menu_items; DELETE FROM categories;');
    const insertCat = db.prepare('INSERT INTO categories (name, description, sort_order) VALUES (?, ?, ?)');
    const insertItem = db.prepare(
      'INSERT INTO menu_items (category_id, name, description, price_cents, available, tags, image_url) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    categories.forEach((c, ci) => {
      const catId = Number(insertCat.run(c.name, c.description, ci).lastInsertRowid);
      for (const i of c.items) {
        const itemId = Number(insertItem.run(catId, i.name, i.description, i.price_cents, i.available, i.tags, i.image_url).lastInsertRowid);
        if (i.groups.length) replaceOptionGroups(db, itemId, i.groups);
      }
    });
  });
  return { categories: categories.length, items: categories.reduce((n, c) => n + c.items.length, 0) };
}

module.exports = { importMenu, parseMenu };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: npm run import-menu -- path/to/menu.json');
    process.exit(1);
  }
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const db = openDatabase();
    const result = importMenu(db, json);
    db.close();
    console.log(`Menu imported: ${result.categories} categories, ${result.items} items.`);
  } catch (err) {
    console.error(`Menu not imported: ${err.message}`);
    process.exit(1);
  }
}
