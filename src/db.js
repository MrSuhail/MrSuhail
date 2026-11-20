const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS menu_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  available   INTEGER NOT NULL DEFAULT 1,
  tags        TEXT NOT NULL DEFAULT '[]',
  image_url   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  code             TEXT NOT NULL UNIQUE,
  customer_name    TEXT NOT NULL,
  customer_phone   TEXT NOT NULL,
  customer_email   TEXT,
  type             TEXT NOT NULL CHECK (type IN ('pickup', 'delivery')),
  delivery_address TEXT,
  notes            TEXT NOT NULL DEFAULT '',
  scheduled_for    TEXT,
  status           TEXT NOT NULL DEFAULT 'pending',
  subtotal_cents   INTEGER NOT NULL,
  tax_cents        INTEGER NOT NULL,
  delivery_fee_cents INTEGER NOT NULL DEFAULT 0,
  total_cents      INTEGER NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id     INTEGER REFERENCES menu_items(id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  notes            TEXT NOT NULL DEFAULT '',
  options          TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS option_groups (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  min_select   INTEGER NOT NULL DEFAULT 0,
  max_select   INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS options (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id          INTEGER NOT NULL REFERENCES option_groups(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  price_delta_cents INTEGER NOT NULL DEFAULT 0,
  available         INTEGER NOT NULL DEFAULT 1,
  sort_order        INTEGER NOT NULL DEFAULT 0
);

-- Weekly schedule. day_of_week: 0 = Sunday ... 6 = Saturday. Times are 'HH:MM' local time.
-- A close_time at or before open_time means the shift runs past midnight.
CREATE TABLE IF NOT EXISTS opening_hours (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  open_time   TEXT NOT NULL,
  close_time  TEXT NOT NULL
);

-- Whole days the restaurant is closed (holidays etc.), as local 'YYYY-MM-DD'.
CREATE TABLE IF NOT EXISTS closures (
  date   TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_menu_items_category ON menu_items(category_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_option_groups_item ON option_groups(menu_item_id);
CREATE INDEX IF NOT EXISTS idx_options_group ON options(group_id);
`;

/** Columns added after the first release; added to older databases on startup. */
const MIGRATIONS = [
  ['orders', 'scheduled_for', 'TEXT'],
  ['order_items', 'options', "TEXT NOT NULL DEFAULT '[]'"],
];

function migrate(db) {
  for (const [table, column, definition] of MIGRATIONS) {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function openDatabase(file = process.env.DB_FILE || 'restaurant.db') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Run fn inside a transaction; rolls back on any thrown error. */
function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDatabase, transaction };
