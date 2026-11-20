# Restaurant Ordering API

A REST API for a restaurant's online menu and ordering. It's built with Node.js and Express and stores data in SQLite, using the SQLite that ships with Node 22, so there's nothing native to compile.

- **Menu**: categories and items, with prices, tags (vegan, gluten-free, …), images and an available/sold-out flag
- **Ordering**: pickup or delivery. The server works out prices, tax, delivery fee and a minimum delivery order. Customers can price a cart before placing it.
- **Order tracking**: customers look up or cancel their order with a short private code. Staff move orders through a fixed set of status steps.
- **Admin API**: manage the menu and orders, protected by an API key

## Quick start

```bash
npm install
ADMIN_API_KEY=supersecret npm start     # http://localhost:3000
npm test
```

On first start the database (`restaurant.db`) gets a sample menu.

### Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_FILE` | `restaurant.db` | SQLite file path (`:memory:` for throwaway) |
| `ADMIN_API_KEY` | `change-me` | Key for `/api/admin/*`. **Set this in production.** |
| `TAX_RATE_BPS` | `825` | Tax in basis points (825 = 8.25%) |
| `DELIVERY_FEE_CENTS` | `499` | Flat delivery fee |
| `MIN_DELIVERY_ORDER_CENTS` | `1500` | Minimum subtotal for delivery |

All money values are **integer cents** (`1599` = $15.99).

## Endpoints

### Public

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check |
| GET | `/api/menu` | Full menu grouped by category (`?include_unavailable=true` to include sold-out items) |
| GET | `/api/categories` | List categories |
| GET | `/api/categories/:id` | One category |
| GET | `/api/items` | List items. Filters: `category_id`, `q` (search), `tag`, `available=true\|false` |
| GET | `/api/items/:id` | One item |
| POST | `/api/orders/quote` | Price a cart without ordering |
| POST | `/api/orders` | Place an order |
| GET | `/api/orders/:code` | Track an order by its code |
| POST | `/api/orders/:code/cancel` | Cancel (only while `pending`) |

### Admin (header `Authorization: Bearer <ADMIN_API_KEY>` or `X-Admin-Key: <key>`)

| Method | Path | Description |
|---|---|---|
| POST / PATCH / DELETE | `/api/admin/categories[/:id]` | Manage categories (a category can't be deleted while it still has items) |
| POST / PATCH / DELETE | `/api/admin/items[/:id]` | Manage menu items |
| GET | `/api/admin/orders` | List orders. Filters: `status=pending,confirmed`, `type`, `limit`, `offset` |
| GET | `/api/admin/orders/:id` | One order |
| PATCH | `/api/admin/orders/:id/status` | Change status: `{ "status": "confirmed" }` |

### Order status steps

```
pending → confirmed → preparing → ready → completed              (pickup)
                                      └→ out_for_delivery → completed  (delivery)
pending / confirmed / preparing → cancelled
```

A status change that isn't allowed (skipping a step, sending a pickup order out for delivery, changing a completed order) returns `409`.

## Examples

Place an order:

```bash
curl -X POST localhost:3000/api/orders -H 'content-type: application/json' -d '{
  "customer_name": "Sam",
  "customer_phone": "555-0100",
  "type": "delivery",
  "delivery_address": "1 Main St",
  "items": [
    { "menu_item_id": 4, "quantity": 2, "notes": "no pickles" },
    { "menu_item_id": 10, "quantity": 1 }
  ]
}'
```

The response includes a `code` (e.g. `NILFHFCF`) to track the order at `GET /api/orders/NILFHFCF`. Any prices the client sends are ignored. The server uses the current menu price and copies it into the order, so changing the menu later doesn't change past orders.

Add a menu item:

```bash
curl -X POST localhost:3000/api/admin/items \
  -H 'authorization: Bearer supersecret' -H 'content-type: application/json' \
  -d '{"category_id": 2, "name": "Veggie Burger", "price_cents": 1499, "tags": ["vegetarian"]}'
```

Mark an item as sold out:

```bash
curl -X PATCH localhost:3000/api/admin/items/4 \
  -H 'authorization: Bearer supersecret' -H 'content-type: application/json' \
  -d '{"available": false}'
```

Errors come back as `{ "error": "message", "details": [...] }` with the matching HTTP status (400, 401, 404 or 409).

## Project layout

```
src/
  server.js        entry point (opens DB, seeds, listens)
  app.js           Express app, routing, error handler
  config.js        env-based settings
  db.js            schema + transaction helper
  seed.js          sample menu (also: npm run seed)
  auth.js          admin API key check
  validate.js      request validation
  routes/menu.js   menu + category endpoints
  routes/orders.js ordering, quotes, status steps
test/api.test.js   end-to-end tests (node:test)
```
