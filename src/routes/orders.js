const crypto = require('node:crypto');
const express = require('express');
const { validate, parseId } = require('../validate');
const { transaction } = require('../db');
const { badRequest, notFound, conflict } = require('../errors');

const STATUSES = ['pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'completed', 'cancelled'];

/** Allowed status transitions. Delivery orders go ready -> out_for_delivery -> completed. */
const TRANSITIONS = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['out_for_delivery', 'completed'],
  out_for_delivery: ['completed'],
  completed: [],
  cancelled: [],
};

const orderSchema = {
  customer_name: { type: 'string', required: true, maxLength: 100 },
  customer_phone: { type: 'string', required: true, maxLength: 30 },
  customer_email: { type: 'string', maxLength: 200 },
  type: { type: 'string', required: true, enum: ['pickup', 'delivery'] },
  delivery_address: { type: 'string', maxLength: 500 },
  notes: { type: 'string', maxLength: 500 },
  items: { type: 'array', required: true, min: 1 },
};

const lineSchema = {
  menu_item_id: { type: 'int', required: true, min: 1 },
  quantity: { type: 'int', required: true, min: 1 },
  notes: { type: 'string', maxLength: 200 },
};

/** Short, unguessable code customers use to look up their order. */
const newOrderCode = () => crypto.randomBytes(6).toString('base64url').toUpperCase().replace(/[-_]/g, 'X');

function createOrderService(db, config) {
  const maxQty = config.maxQuantityPerItem;

  /** Validates cart lines against the live menu and computes totals. Prices come from the DB, never the client. */
  function price(items, type) {
    const lines = items.map((raw, i) => {
      let line;
      try {
        line = validate(raw, { ...lineSchema, quantity: { ...lineSchema.quantity, max: maxQty } });
      } catch (err) {
        err.message = `items[${i}]: ${err.message}`;
        throw err;
      }
      const item = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(line.menu_item_id);
      if (!item) throw badRequest(`items[${i}]: menu item ${line.menu_item_id} does not exist`);
      if (!item.available) throw conflict(`"${item.name}" is currently unavailable`);
      return {
        menu_item_id: item.id,
        name: item.name,
        unit_price_cents: item.price_cents,
        quantity: line.quantity,
        notes: line.notes ?? '',
        line_total_cents: item.price_cents * line.quantity,
      };
    });

    const subtotal = lines.reduce((sum, l) => sum + l.line_total_cents, 0);
    const tax = Math.round((subtotal * config.taxRateBps) / 10000);
    const deliveryFee = type === 'delivery' ? config.deliveryFeeCents : 0;
    return {
      lines,
      subtotal_cents: subtotal,
      tax_cents: tax,
      delivery_fee_cents: deliveryFee,
      total_cents: subtotal + tax + deliveryFee,
    };
  }

  function load(where, value) {
    const order = db.prepare(`SELECT * FROM orders WHERE ${where} = ?`).get(value);
    if (!order) return null;
    const items = db
      .prepare('SELECT menu_item_id, name, unit_price_cents, quantity, notes FROM order_items WHERE order_id = ? ORDER BY id')
      .all(order.id)
      .map((l) => ({ ...l, line_total_cents: l.unit_price_cents * l.quantity }));
    return { ...order, items };
  }

  function create(body) {
    const data = validate(body, orderSchema);
    if (data.type === 'delivery' && !data.delivery_address) {
      throw badRequest('Validation failed', ['delivery_address is required for delivery orders']);
    }
    const quote = price(data.items, data.type);
    if (data.type === 'delivery' && quote.subtotal_cents < config.minDeliveryOrderCents) {
      throw badRequest(`Delivery orders require a subtotal of at least ${config.minDeliveryOrderCents} cents`);
    }

    const code = newOrderCode();
    const orderId = transaction(db, () => {
      const result = db.prepare(
        `INSERT INTO orders (code, customer_name, customer_phone, customer_email, type, delivery_address, notes,
           subtotal_cents, tax_cents, delivery_fee_cents, total_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(code, data.customer_name, data.customer_phone, data.customer_email ?? null, data.type,
        data.type === 'delivery' ? data.delivery_address : null, data.notes ?? '',
        quote.subtotal_cents, quote.tax_cents, quote.delivery_fee_cents, quote.total_cents);
      const id = Number(result.lastInsertRowid);
      const insertLine = db.prepare(
        'INSERT INTO order_items (order_id, menu_item_id, name, unit_price_cents, quantity, notes) VALUES (?, ?, ?, ?, ?, ?)'
      );
      for (const l of quote.lines) insertLine.run(id, l.menu_item_id, l.name, l.unit_price_cents, l.quantity, l.notes);
      return id;
    });
    return load('id', orderId);
  }

  function setStatus(order, next) {
    if (order.type === 'pickup' && next === 'out_for_delivery') {
      throw conflict('Pickup orders cannot go out for delivery');
    }
    if (!TRANSITIONS[order.status].includes(next)) {
      throw conflict(`Cannot change order from "${order.status}" to "${next}"`);
    }
    db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(next, order.id);
    return load('id', order.id);
  }

  return { price, load, create, setStatus };
}

/** Customer-facing order routes. Orders are looked up by their unguessable code. */
function publicOrdersRouter(db, config) {
  const router = express.Router();
  const svc = createOrderService(db, config);

  // Price a cart without placing an order (useful for showing totals at checkout).
  router.post('/orders/quote', (req, res) => {
    const data = validate(req.body, {
      type: { type: 'string', enum: ['pickup', 'delivery'] },
      items: orderSchema.items,
    });
    const { lines, ...totals } = svc.price(data.items, data.type ?? 'pickup');
    res.json({ items: lines, ...totals });
  });

  router.post('/orders', (req, res) => {
    const order = svc.create(req.body);
    res.status(201).location(`/api/orders/${order.code}`).json(order);
  });

  router.get('/orders/:code', (req, res) => {
    const order = svc.load('code', String(req.params.code).toUpperCase());
    if (!order) throw notFound('Order');
    res.json(order);
  });

  // Customers may cancel only while the kitchen hasn't accepted the order yet.
  router.post('/orders/:code/cancel', (req, res) => {
    const order = svc.load('code', String(req.params.code).toUpperCase());
    if (!order) throw notFound('Order');
    if (order.status !== 'pending') throw conflict('Order can no longer be cancelled online; please call the restaurant');
    res.json(svc.setStatus(order, 'cancelled'));
  });

  return router;
}

/** Staff/admin order management. */
function adminOrdersRouter(db, config) {
  const router = express.Router();
  const svc = createOrderService(db, config);

  // ?status=pending,confirmed &type=delivery &limit=50 &offset=0
  router.get('/orders', (req, res) => {
    const where = [];
    const params = [];
    if (req.query.status) {
      const statuses = String(req.query.status).split(',');
      const bad = statuses.filter((s) => !STATUSES.includes(s));
      if (bad.length) throw badRequest(`Unknown status: ${bad.join(', ')}`);
      where.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    if (req.query.type) { where.push('type = ?'); params.push(String(req.query.type)); }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM orders ${clause}`).get(...params);
    const ids = db.prepare(`SELECT id FROM orders ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    res.json({ data: ids.map((r) => svc.load('id', r.id)), total, limit, offset });
  });

  router.get('/orders/:id', (req, res) => {
    const order = svc.load('id', parseId(req.params.id));
    if (!order) throw notFound('Order');
    res.json(order);
  });

  router.patch('/orders/:id/status', (req, res) => {
    const { status } = validate(req.body, { status: { type: 'string', required: true, enum: STATUSES } });
    const order = svc.load('id', parseId(req.params.id));
    if (!order) throw notFound('Order');
    res.json(svc.setStatus(order, status));
  });

  return router;
}

module.exports = { publicOrdersRouter, adminOrdersRouter, STATUSES, TRANSITIONS };
