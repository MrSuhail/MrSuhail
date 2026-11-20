# Restaurant Ordering API

A REST API for a restaurant's online menu and ordering. It's built with Node.js and Express and stores data in SQLite, using the SQLite that ships with Node 22, so there's nothing native to compile.

- **Menu**: categories and items, with prices, tags (vegan, gluten-free, …), images and an available/sold-out flag
- **Item options**: sizes, sides, extras and toppings, each with its own price and rules (e.g. "choose 1 size", "up to 3 extras")
- **WhatsApp ordering**: customers order by chatting to the store's WhatsApp number. A bot shows the menu, takes the order and confirms it, and customers get a message when it's ready. "Talk to staff" hands the chat to a person.
- **Staff page** (`/staff`): new orders with a sound alert, WhatsApp chats to reply to, and sold-out switches. It works on a phone or tablet.
- **Opening hours**: a weekly schedule (with lunch/dinner shifts and shifts past midnight), holiday closures, an order cut-off before closing, and pickup/delivery time slots so customers can order for later
- **Ordering**: pickup or delivery. The server works out prices, tax, delivery fee and a minimum delivery order. Customers can price a cart before placing it.
- **Order tracking**: customers look up or cancel their order with a short private code. Staff move orders through a fixed set of status steps.
- **Admin API**: manage the menu and orders, protected by an API key

## Quick start

```bash
npm install
cp .env.example .env      # then fill it in: store name, admin key, WhatsApp settings
npm start                 # http://localhost:3000  ·  staff page: http://localhost:3000/staff
npm test
```

`.env.example` is already set up for a South African store: Johannesburg time, rands, and 15% VAT included in menu prices.

On first start the database (`restaurant.db`) gets a sample menu, with options, and the store's trading hours (Mon–Fri 07:30–18:30, Sat 08:00–17:00, Sun 09:00–15:00). Set `TIMEZONE` to where the restaurant is, or the hours will be read in the server's time zone.

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
| `STORE_NAME` | `Our Restaurant` | Shown to customers on WhatsApp and on the staff page |
| `CURRENCY_SYMBOL` | `$` | e.g. `R` |
| `PRICES_INCLUDE_TAX` | `false` | `true` when menu prices already include VAT. Orders then show the VAT portion without adding it. |
| `PAYMENT_NOTE` | "Please pay at the counter when you collect." | Shown on WhatsApp after ordering |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` | — | See [Connecting WhatsApp](#connecting-whatsapp). WhatsApp stays off until all four are set. |
| `WHATSAPP_HANDOFF_HOURS` | `2` | After "Talk to staff", how long the bot stays quiet without a staff reply |
| `WHATSAPP_API_VERSION` | `v23.0` | Meta Graph API version |
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
| GET | `/api/admin/whatsapp/status` | Whether WhatsApp is connected, and which settings are missing |
| GET | `/api/admin/whatsapp/chats` | WhatsApp chats, those needing a reply first |
| GET | `/api/admin/whatsapp/chats/:phone/messages` | A chat's messages (`?after_id=` for new ones only) |
| POST | `/api/admin/whatsapp/chats/:phone/messages` | Staff reply: `{ "text": "..." }`. Pauses the bot for that chat. |
| POST | `/api/admin/whatsapp/chats/:phone/release` | Hand the chat back to the bot |
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

## WhatsApp ordering

When a customer messages the store's WhatsApp number:

1. The bot greets them by name, says whether you're open, and offers **Order now / My order / Talk to staff**.
2. **Order now** opens the menu as a WhatsApp list: sections, then items with prices.
3. For items with options, it asks one group at a time: buttons for "pick one", a list for extras, "No thanks" for optional groups. Then it asks how many.
4. The cart shows the items, the total and the VAT, with **Checkout / Add more / Edit cart**.
5. At checkout it asks for a name (offering their WhatsApp name), then a collection time: **ASAP**, or a list of time slots. Only time slots are offered when you're closed or past the cut-off, so customers can order ahead.
6. They confirm, get an order number, and the order appears on the staff page with a sound.
7. When staff tap **Accept**, **Start making**, **Ready** or **Cancel**, the customer gets a WhatsApp message.

Customers can also type **MENU**, **CART**, **STATUS**, **CANCEL** or **STAFF** at any point.

**Talk to staff** (or typing "staff" / "help") pauses the bot for that chat. The chat goes to the top of the staff page marked *needs reply*. Staff reply from the staff page, and the bot stays quiet while they talk. It comes back when staff tap **Hand back to bot**, when the customer types **MENU**, or after `WHATSAPP_HANDOFF_HOURS` without a staff reply.

WhatsApp only allows normal messages within **24 hours of the customer's last message**. The staff page tells you when a chat is past that. An order scheduled for more than 24 hours after the customer's last message may not get its "ready" message. Sending messages outside the 24 hours needs Meta-approved message templates, which this doesn't use yet.

## Connecting WhatsApp

Automatic replies need Meta's **WhatsApp Business Platform (Cloud API)**. The normal WhatsApp Business app on a phone can't be connected to software.

1. **Put the server online** with a public `https://` address, e.g. on Render, Railway or Fly.io. If you keep the SQLite database, use a persistent disk. Set the variables from `.env.example`.
2. Create a **Meta Business portfolio** at business.facebook.com (if you don't have one), then go to developers.facebook.com → **Create app** → type **Business** → add the **WhatsApp** product.
3. In **WhatsApp → API Setup**, add and verify the store's phone number. Copy its **Phone number ID** into `WHATSAPP_PHONE_NUMBER_ID`.
   - A number already used on the WhatsApp Business app normally has to be moved over to the platform. Meta offers a way to keep using the app on the same number for some accounts, but not all. Many stores use a separate number for ordering.
4. Create a **permanent access token**: Business settings → Users → **System users** → add one → assign your app → **Generate token** with the `whatsapp_business_messaging` and `whatsapp_business_management` permissions. Put it in `WHATSAPP_TOKEN`. (The temporary token on the API Setup page expires after a day.)
5. App settings → Basic → **App secret** → `WHATSAPP_APP_SECRET`.
6. Make up a random string for `WHATSAPP_VERIFY_TOKEN`, restart the server, then in **WhatsApp → Configuration → Webhook**:
   - Callback URL: `https://YOUR-SERVER/webhooks/whatsapp`
   - Verify token: the same random string
   - Then subscribe to the **messages** webhook field.
7. Send "Hi" to the number from your own phone to test.

Before going live, Meta asks you to verify the business and approve the display name. Replies to customer messages within the 24-hour window are generally free, but Meta changes its pricing, so check their current pricing page.

## Staff page

Open `https://YOUR-SERVER/staff` and sign in with `ADMIN_API_KEY`. The key is kept only until the browser tab is closed.

- **Orders**: New → Accepted → Making → Ready for collection, with one-tap buttons. Scheduled orders show their collection time. A sound plays when a new order arrives, after you've interacted with the page once (browsers block sound before that).
- **WhatsApp**: chats that need a reply first. Reply from here, or hand the chat back to the bot.
- **Sold out**: switch items or single options (e.g. "Avocado") off and on.

## Loading your menu

Write the menu as JSON (see `menu.example.json`; prices are in rands, e.g. `59.90`) and run:

```bash
npm run import-menu -- my-menu.json
```

This replaces the whole menu. Past orders keep their own item names and prices. If the file has a mistake, nothing is changed and the error says which item it is.

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
  routes/whatsapp.js  WhatsApp webhook and staff chat endpoints
  whatsapp/bot.js     the WhatsApp ordering conversation
  whatsapp/client.js  sends WhatsApp messages (Meta Cloud API)
  import-menu.js   load a menu from a JSON file
public/staff.html  staff page
test/              end-to-end tests (node:test), including a simulated WhatsApp conversation
```
