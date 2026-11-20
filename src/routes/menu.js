const express = require('express');
const { validate, parseId } = require('../validate');
const { notFound, conflict, badRequest } = require('../errors');
const { transaction } = require('../db');
const { parseOptionGroups, replaceOptionGroups, loadOptionGroups, optionSchema } = require('../options');

const categorySchema = {
  name: { type: 'string', required: true, maxLength: 100 },
  description: { type: 'string', maxLength: 500 },
  sort_order: { type: 'int' },
};

const itemSchema = {
  category_id: { type: 'int', required: true, min: 1 },
  name: { type: 'string', required: true, maxLength: 120 },
  description: { type: 'string', maxLength: 1000 },
  price_cents: { type: 'int', required: true, min: 0 },
  available: { type: 'bool' },
  tags: { type: 'array' },
  image_url: { type: 'string', maxLength: 2000, nullable: true },
};

function serializeItem(row, groups = []) {
  return {
    id: row.id,
    category_id: row.category_id,
    name: row.name,
    description: row.description,
    price_cents: row.price_cents,
    available: Boolean(row.available),
    tags: JSON.parse(row.tags),
    image_url: row.image_url,
    option_groups: groups,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Serializes item rows with their option groups attached. */
function serializeItems(db, rows) {
  const groups = loadOptionGroups(db, rows.map((r) => r.id));
  return rows.map((r) => serializeItem(r, groups.get(r.id)));
}

function toDbFields(data) {
  const fields = { ...data };
  if ('available' in fields) fields.available = fields.available ? 1 : 0;
  if ('tags' in fields) {
    if (!fields.tags.every((t) => typeof t === 'string')) throw badRequest('tags must be an array of strings');
    fields.tags = JSON.stringify(fields.tags.map((t) => t.trim().toLowerCase()));
  }
  return fields;
}

function buildUpdate(table, id, fields, touch = false) {
  const keys = Object.keys(fields);
  const sets = keys.map((k) => `${k} = ?`);
  if (touch) sets.push("updated_at = datetime('now')");
  return { sql: `UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, params: [...keys.map((k) => fields[k]), id] };
}

/** Public, read-only menu routes. */
function publicMenuRouter(db) {
  const router = express.Router();

  // Full menu grouped by category. ?include_unavailable=true to show sold-out items.
  router.get('/menu', (req, res) => {
    const includeUnavailable = req.query.include_unavailable === 'true';
    const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all();
    const items = serializeItems(db, db
      .prepare(`SELECT * FROM menu_items ${includeUnavailable ? '' : 'WHERE available = 1'} ORDER BY name`)
      .all());
    res.json({
      categories: categories.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        sort_order: c.sort_order,
        items: items.filter((i) => i.category_id === c.id),
      })),
    });
  });

  router.get('/categories', (_req, res) => {
    res.json({ data: db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all() });
  });

  router.get('/categories/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM categories WHERE id = ?').get(parseId(req.params.id));
    if (!row) throw notFound('Category');
    res.json(row);
  });

  // Flat item list with filters: ?category_id=&q=&tag=&available=true|false
  router.get('/items', (req, res) => {
    const where = [];
    const params = [];
    if (req.query.category_id) { where.push('category_id = ?'); params.push(parseId(req.query.category_id)); }
    if (req.query.q) {
      where.push('(name LIKE ? OR description LIKE ?)');
      params.push(`%${req.query.q}%`, `%${req.query.q}%`);
    }
    if (req.query.tag) {
      where.push('EXISTS (SELECT 1 FROM json_each(menu_items.tags) WHERE value = ?)');
      params.push(String(req.query.tag).toLowerCase());
    }
    if (req.query.available === 'true') where.push('available = 1');
    if (req.query.available === 'false') where.push('available = 0');
    const sql = `SELECT * FROM menu_items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY name`;
    res.json({ data: serializeItems(db, db.prepare(sql).all(...params)) });
  });

  router.get('/items/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(parseId(req.params.id));
    if (!row) throw notFound('Menu item');
    res.json(serializeItems(db, [row])[0]);
  });

  return router;
}

/** Admin routes for managing categories and items. */
function adminMenuRouter(db) {
  const router = express.Router();

  const getCategory = (id) => db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  const getItem = (id) => db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id);
  const itemView = (id) => serializeItems(db, [getItem(id)])[0];
  const groupsFrom = (body) => (body && body.option_groups !== undefined ? parseOptionGroups(body.option_groups) : undefined);
  const assertCategory = (id) => { if (!getCategory(id)) throw badRequest(`category_id ${id} does not exist`); };

  const uniqueName = (fn) => {
    try { return fn(); } catch (err) {
      if (String(err.message).includes('UNIQUE')) throw conflict('A category with that name already exists');
      throw err;
    }
  };

  router.post('/categories', (req, res) => {
    const data = validate(req.body, categorySchema);
    const result = uniqueName(() =>
      db.prepare('INSERT INTO categories (name, description, sort_order) VALUES (?, ?, ?)')
        .run(data.name, data.description ?? '', data.sort_order ?? 0));
    res.status(201).json(getCategory(Number(result.lastInsertRowid)));
  });

  router.patch('/categories/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (!getCategory(id)) throw notFound('Category');
    const data = validate(req.body, categorySchema, { partial: true });
    if (Object.keys(data).length) {
      const { sql, params } = buildUpdate('categories', id, data);
      uniqueName(() => db.prepare(sql).run(...params));
    }
    res.json(getCategory(id));
  });

  router.delete('/categories/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (!getCategory(id)) throw notFound('Category');
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM menu_items WHERE category_id = ?').get(id);
    if (n > 0) throw conflict(`Category still has ${n} item(s); move or delete them first`);
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    res.status(204).end();
  });

  router.post('/items', (req, res) => {
    const data = toDbFields(validate(req.body, itemSchema));
    const groups = groupsFrom(req.body);
    assertCategory(data.category_id);
    const id = transaction(db, () => {
      const result = db.prepare(
        `INSERT INTO menu_items (category_id, name, description, price_cents, available, tags, image_url)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(data.category_id, data.name, data.description ?? '', data.price_cents,
        data.available ?? 1, data.tags ?? '[]', data.image_url ?? null);
      const newId = Number(result.lastInsertRowid);
      if (groups) replaceOptionGroups(db, newId, groups);
      return newId;
    });
    res.status(201).json(itemView(id));
  });

  router.patch('/items/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (!getItem(id)) throw notFound('Menu item');
    const data = toDbFields(validate(req.body, itemSchema, { partial: true }));
    const groups = groupsFrom(req.body); // when present, replaces all of the item's option groups
    if (data.category_id) assertCategory(data.category_id);
    transaction(db, () => {
      if (Object.keys(data).length) {
        const { sql, params } = buildUpdate('menu_items', id, data, true);
        db.prepare(sql).run(...params);
      }
      if (groups) replaceOptionGroups(db, id, groups);
    });
    res.json(itemView(id));
  });

  router.delete('/items/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (!getItem(id)) throw notFound('Menu item');
    db.prepare('DELETE FROM menu_items WHERE id = ?').run(id);
    res.status(204).end();
  });

  // Change a single option without resending the item, e.g. { "available": false } when out of avocado.
  router.patch('/options/:id', (req, res) => {
    const id = parseId(req.params.id);
    const option = db.prepare('SELECT * FROM options WHERE id = ?').get(id);
    if (!option) throw notFound('Option');
    const data = validate(req.body, optionSchema, { partial: true });
    if ('available' in data) data.available = data.available ? 1 : 0;
    if (Object.keys(data).length) {
      const { sql, params } = buildUpdate('options', id, data);
      db.prepare(sql).run(...params);
    }
    const { menu_item_id: itemId } = db.prepare('SELECT menu_item_id FROM option_groups WHERE id = ?').get(option.group_id);
    res.json(itemView(itemId));
  });

  return router;
}

module.exports = { publicMenuRouter, adminMenuRouter };
