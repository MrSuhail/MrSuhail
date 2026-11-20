# Restaurant Ordering API

A REST API for a restaurant's online menu and ordering. It's built with Node.js and Express and stores data in SQLite, using the SQLite that ships with Node 22, so there's nothing native to compile.

- **Menu**: categories and items, with prices, tags (vegan, gluten-free, …), images and an available/sold-out flag
- **Item options**: sizes, sides, extras and toppings, each with its own price and rules (e.g. "choose 1 size", "up to 3 extras")
- **Opening hours**: a weekly schedule (with lunch/dinner shifts and shifts past midnight), holiday closures, an order cut-off before closing, and pickup/delivery time slots so customers can order for later
- **Ordering**: pickup or delivery. The server works out prices, tax, delivery fee and a minimum delivery order. Customers can price a cart before placing it.
- **Order tracking**: customers look up or cancel their order with a short private code. Staff move orders through a fixed set of status steps.
- **Admin API**: manage the menu and orders, protected by an API key

## Quick start

```bash
npm install
ADMIN_API_KEY=supersecret npm start     # http://localhost:3000
npm test
```

On first start the database (`restaurant.db`) gets a sample menu, with options, and sample opening hours. Set `TIMEZONE` to where the restaurant is, or the hours will be read in the server's time zone.

Databases from the earlier version are upgraded automatically on start. They have no opening hours, so they stay open around the clock until you set some.

### Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_FILE` | `restaurant.db` | SQLite file path (`:memory:` for throwaway) |
| `ADMIN_API_KEY` | `change-me` | Key for `/api/admin/*`. **Set this in production.** |
| `TAX_RATE_BPS` | `825` | Tax in basis points (825 = 8.25%) |
| `DELIVERY_FEE_CENTS` | `499` | Flat delivery fee |
| `MIN_DELIVERY_ORDER_CENTS` | `1500` | Minimum subtotal for delivery |
| `TIMEZONE` | server's zone | Restaurant time zone, e.g. `America/New_York`. Opening hours are in this zone. |
| `ORDER_CUTOFF_MINUTES` | `15` | Stop taking ASAP orders this long before closing |
| `PREP_TIME_MINUTES` | `20` | Notice needed for a scheduled order; the first slot of a shift is this long after opening |
| `SLOT_INTERVAL_MINUTES` | `15` | Spacing of the pickup/delivery times offered |
| `MAX_DAYS_AHEAD` | `7` | How far ahead customers can schedule |

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
| GET | `/api/hours` | Weekly hours, upcoming closures, and `open_now` / `accepting_asap_orders` / `closes_at` / `next_opens_at` |
| GET | `/api/hours/slots?date=YYYY-MM-DD` | Pickup/delivery times available on a date (default today) |
| POST | `/api/orders/quote` | Price a cart without ordering |
| POST | `/api/orders` | Place an order |
| GET | `/api/orders/:code` | Track an order by its code |
| POST | `/api/orders/:code/cancel` | Cancel (only while `pending`) |

### Admin (header `Authorization: Bearer <ADMIN_API_KEY>` or `X-Admin-Key: <key>`)

| Method | Path | Description |
|---|---|---|
| POST / PATCH / DELETE | `/api/admin/categories[/:id]` | Manage categories (a category can't be deleted while it still has items) |
| POST / PATCH / DELETE | `/api/admin/items[/:id]` | Manage menu items. Sending `option_groups` replaces all of the item's options. |
| PATCH | `/api/admin/options/:id` | Change one option, e.g. `{ "available": false }` or a new `price_delta_cents` |
| PUT | `/api/admin/hours` | Replace the weekly schedule (an empty list means always open) |
| GET / POST | `/api/admin/closures` | List closures / close for a day: `{ "date": "2026-12-25", "reason": "Christmas" }` |
| DELETE | `/api/admin/closures/:date` | Remove a closure |
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

## Item options

Each item can have **option groups**. A group has `min_select` and `max_select`:

| Kind of choice | min_select | max_select |
|---|---|---|
| Required single choice ("Size") | 1 | 1 |
| Optional single choice ("Crust") | 0 | 1 |
| Up to N extras ("Extras", up to 3) | 0 | 3 |

Every option has a `price_delta_cents` (`0` for no change, negative for a discount like "No ice cream: -100"). Items come back from the menu with their groups:

```json
{
  "id": 4, "name": "Classic Burger", "price_cents": 1599,
  "option_groups": [
    { "id": 1, "name": "Cooked", "min_select": 1, "max_select": 1,
      "options": [{ "id": 1, "name": "Medium rare", "price_delta_cents": 0, "available": true }, ...] },
    { "id": 3, "name": "Extras", "min_select": 0, "max_select": 3,
      "options": [{ "id": 7, "name": "Bacon", "price_delta_cents": 200, "available": true }, ...] }
  ]
}
```

To order, send the chosen option ids on each line: `{ "menu_item_id": 4, "quantity": 1, "options": [2, 4, 7] }`. The API checks every group's rules, refuses sold-out options, and works out the unit price (base + options). The chosen option names and prices are copied into the order.

Set an item's options when creating or editing it:

```bash
curl -X PATCH localhost:3000/api/admin/items/4 \
  -H 'authorization: Bearer supersecret' -H 'content-type: application/json' \
  -d '{"option_groups": [
        {"name": "Size", "min_select": 1, "max_select": 1,
         "options": [{"name": "Regular"}, {"name": "Large", "price_delta_cents": 300}]}
      ]}'
```

Replacing groups gives the options new ids. To change a single option, such as marking it sold out, use `PATCH /api/admin/options/:id` so its id stays the same.

## Opening hours and scheduled orders

- **ASAP orders** (no `scheduled_for`) are only accepted while open, and not in the last `ORDER_CUTOFF_MINUTES` before closing. Otherwise you get `409` with the next opening time.
- **Scheduled orders**: send `"scheduled_for": "2026-11-21T18:30:00-05:00"` (an ISO date-time with a time zone). The time must be at least `PREP_TIME_MINUTES` from now, inside opening hours (and at least prep time after opening), and within `MAX_DAYS_AHEAD`. Customers can order for tomorrow while you're closed.
- `GET /api/hours/slots` lists the times that will be accepted, so a checkout page can show a time picker.

Set the weekly schedule (times are 24-hour, in `TIMEZONE`). Add two entries for one day to split it into shifts. A close time earlier than the open time means the shift runs past midnight:

```bash
curl -X PUT localhost:3000/api/admin/hours \
  -H 'authorization: Bearer supersecret' -H 'content-type: application/json' \
  -d '{"weekly": [
        {"day": "monday", "open": "11:00", "close": "22:00"},
        {"day": "friday", "open": "11:30", "close": "14:30"},
        {"day": "friday", "open": "18:00", "close": "01:00"}
      ]}'
```

Days not listed are closed. Use closures for one-off days such as holidays.

## Examples

Place an order:

```bash
curl -X POST localhost:3000/api/orders -H 'content-type: application/json' -d '{
  "customer_name": "Sam",
  "customer_phone": "555-0100",
  "type": "delivery",
  "delivery_address": "1 Main St",
  "scheduled_for": "2026-11-21T18:30:00-05:00",
  "items": [
    { "menu_item_id": 4, "quantity": 2, "options": [2, 4, 7], "notes": "no pickles" },
    { "menu_item_id": 10, "quantity": 1, "options": [23] }
  ]
}'
```

Leave out `scheduled_for` for "as soon as possible". The response includes a `code` (e.g. `NILFHFCF`) to track the order at `GET /api/orders/NILFHFCF`. Any prices the client sends are ignored. The server uses the current menu price and copies it into the order, so changing the menu later doesn't change past orders.

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
  db.js            schema, upgrades for older databases, transaction helper
  hours.js         opening hours, time zones, slots
  options.js       item options: validation and pricing
  seed.js          sample menu (also: npm run seed)
  auth.js          admin API key check
  validate.js      request validation
  routes/menu.js   menu + category endpoints
  routes/orders.js ordering, quotes, status steps
  routes/hours.js  hours, slots, closures
test/api.test.js   end-to-end tests (node:test)
```
