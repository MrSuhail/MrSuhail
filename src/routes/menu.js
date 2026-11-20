const express = require('express');
const { validate, parseId } = require('../validate');
const { notFound, conflict, badRequest } = require('../errors');

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

function serializeItem(row) {
  return {
    id: row.id,
    category_id: row.category_id,
    name: row.name,
    description: row.description,
    price_cents: row.price_cents,
    available: Boolean(row.available),
    tags: JSON.parse(row.tags),
    image_url: row.image_url,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
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
    const items = db
      .prepare(`SELECT * FROM menu_items ${includeUnavailable ? '' : 'WHERE available = 1'} ORDER BY name`)
      .all()
      .map(serializeItem);
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
    res.json({ data: db.prepare(sql).all(...params).map(serializeItem) });
  });

  router.get('/items/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(parseId(req.params.id));
    if (!row) throw notFound('Menu item');
    res.json(serializeItem(row));
  });

  return router;
}

/** Admin routes for managing categories and items. */
function adminMenuRouter(db) {
  const router = express.Router();

  const getCategory = (id) => db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  const getItem = (id) => db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id);
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
    assertCategory(data.category_id);
    const result = db.prepare(
      `INSERT INTO menu_items (category_id, name, description, price_cents, available, tags, image_url)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(data.category_id, data.name, data.description ?? '', data.price_cents,
      data.available ?? 1, data.tags ?? '[]', data.image_url ?? null);
    res.status(201).json(serializeItem(getItem(Number(result.lastInsertRowid))));
  });

  router.patch('/items/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (!getItem(id)) throw notFound('Menu item');
    const data = toDbFields(validate(req.body, itemSchema, { partial: true }));
    if (data.category_id) assertCategory(data.category_id);
    if (Object.keys(data).length) {
      const { sql, params } = buildUpdate('menu_items', id, data, true);
      db.prepare(sql).run(...params);
    }
    res.json(serializeItem(getItem(id)));
  });

  router.delete('/items/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (!getItem(id)) throw notFound('Menu item');
    db.prepare('DELETE FROM menu_items WHERE id = ?').run(id);
    res.status(204).end();
  });

  return router;
}

module.exports = { publicMenuRouter, adminMenuRouter };
