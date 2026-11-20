/**
 * WhatsApp ordering assistant.
 *
 * Flow: greeting → categories → items → options (one group at a time) → quantity → cart
 *       → name → collection time → confirm → order placed.
 * "Talk to staff" pauses the bot for that chat so a person can reply from the staff page.
 *
 * Button/list taps carry ids like "item:5" or "opt:12", so most steps don't depend on stored state.
 * Stored state is only needed for typed answers (quantity, name) and for the item being built.
 */
const { createOrderService } = require('../routes/orders');
const { loadOptionGroups } = require('../options');
const { localDate, addDays } = require('../hours');

const GREETINGS = new Set(['hi', 'hello', 'hey', 'hiya', 'howzit', 'hallo', 'molo', 'sawubona', 'good morning', 'good afternoon', 'good evening', 'start', 'menu', 'order']);
const STAFF_WORDS = new Set(['staff', 'help', 'agent', 'human', 'person', 'talk to staff']);

const STATUS_TEXT = {
  pending: 'Received — waiting for the store to confirm',
  confirmed: 'Confirmed ✅',
  preparing: 'Being made now 👩‍🍳',
  ready: 'Ready for collection 🎉',
  out_for_delivery: 'Out for delivery 🛵',
  completed: 'Collected — thank you! 💚',
  cancelled: 'Cancelled',
};

function createBot(db, config, client) {
  const svc = createOrderService(db, config);
  const { schedule } = svc;
  const tz = config.timezone;
  const MINUTE = 60_000;

  // ---------- formatting ----------

  const money = (cents) => `${config.currencySymbol}${(cents / 100).toFixed(2)}`;
  const delta = (cents) => (cents > 0 ? `+${money(cents)}` : cents < 0 ? `-${money(-cents)}` : '');

  const timeFmt = new Intl.DateTimeFormat('en-ZA', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const dayFmt = new Intl.DateTimeFormat('en-ZA', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' });

  /** "Today 12:30", "Tomorrow 08:15" or "Sat 22 Nov 08:15" in the restaurant's time zone. */
  function when(isoOrMs) {
    const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
    const now = config.now();
    const d = localDate(ms, tz);
    const today = localDate(now, tz);
    const day = d === today ? 'Today' : d === addDays(today, 1) ? 'Tomorrow' : dayFmt.format(ms);
    return `${day} ${timeFmt.format(ms)}`;
  }

  function hoursLine() {
    const s = schedule.status();
    if (s.accepting_asap_orders) return s.closes_at ? `We're open until ${timeFmt.format(Date.parse(s.closes_at))} today.` : "We're open.";
    if (s.open_now) return "We've stopped taking orders for today, but you can order ahead for later.";
    return s.next_opens_at
      ? `We're closed right now. You can order ahead for when we open (${when(s.next_opens_at)}).`
      : "We're closed right now.";
  }

  // ---------- chat state ----------

  function loadChat(phone, profileName) {
    db.prepare(`INSERT INTO whatsapp_chats (phone, profile_name) VALUES (?, ?)
                ON CONFLICT(phone) DO UPDATE SET profile_name = CASE WHEN excluded.profile_name <> '' THEN excluded.profile_name ELSE profile_name END`)
      .run(phone, profileName || '');
    const row = db.prepare('SELECT * FROM whatsapp_chats WHERE phone = ?').get(phone);
    return { ...row, data: JSON.parse(row.data), cart: JSON.parse(row.cart) };
  }

  function save(chat) {
    db.prepare('UPDATE whatsapp_chats SET state = ?, data = ?, cart = ?, customer_name = ?, handoff_until = ?, needs_staff = ? WHERE phone = ?')
      .run(chat.state, JSON.stringify(chat.data), JSON.stringify(chat.cart), chat.customer_name ?? null,
        chat.handoff_until ?? null, chat.needs_staff ? 1 : 0, chat.phone);
  }

  const inHandoff = (chat) => chat.handoff_until && Date.parse(chat.handoff_until) > config.now();

  // ---------- menu helpers ----------

  const getItem = (id) => db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id);

  /** Option groups with sold-out options removed. */
  function groupsFor(itemId) {
    return (loadOptionGroups(db, [itemId]).get(itemId) ?? []).map((g) => ({ ...g, options: g.options.filter((o) => o.available) }));
  }

  /** Rows for a list message, with paging when there are more than fit. extra rows (e.g. "Back") are kept on every page. */
  function page(rows, pageNo, moreId, extra = []) {
    const room = 10 - extra.length;
    if (rows.length <= room) return [...rows, ...extra];
    const per = room - 1;
    const slice = rows.slice(pageNo * per, pageNo * per + per);
    const more = (pageNo + 1) * per < rows.length ? [{ id: `${moreId}:${pageNo + 1}`, title: 'More…', description: 'See more options' }] : [];
    return [...slice, ...more, ...extra];
  }

  function priceLine(line) {
    try {
      return svc.price([line], 'pickup').lines[0];
    } catch {
      return null;
    }
  }

  function describeLine(l) {
    const opts = l.options.length ? `\n   _${l.options.map((o) => o.name).join(', ')}_` : '';
    return `${l.quantity}× ${l.name} — ${money(l.line_total_cents)}${opts}`;
  }

  // ---------- screens ----------

  async function showMain(chat, intro) {
    chat.state = 'idle';
    chat.data = {};
    save(chat);
    const name = chat.customer_name || chat.profile_name;
    const greeting = intro ?? `Hi${name ? ` ${name.split(' ')[0]}` : ''}! 👋 Welcome to *${config.storeName}*.`;
    const second = chat.cart.length
      ? { id: 'cart', title: `🛒 My cart (${chat.cart.reduce((n, l) => n + l.quantity, 0)})` }
      : { id: 'status', title: '📦 My order' };
    await client.buttons(chat.phone, `${greeting}\n\n${hoursLine()}\n\nWhat would you like to do?`, [
      { id: 'order', title: chat.cart.length ? '🍽️ Add items' : '🍽️ Order now' },
      second,
      { id: 'staff', title: '🙋 Talk to staff' },
    ]);
  }

  async function showCategories(chat, pageNo = 0) {
    const cats = db.prepare(`SELECT c.id, c.name, c.description, COUNT(i.id) AS n FROM categories c
                             JOIN menu_items i ON i.category_id = c.id AND i.available = 1
                             GROUP BY c.id ORDER BY c.sort_order, c.name`).all();
    if (!cats.length) return client.text(chat.phone, "Sorry, our menu isn't available right now. Type STAFF to chat to us.");
    chat.state = 'browsing';
    save(chat);
    const rows = cats.map((c) => ({ id: `cat:${c.id}`, title: c.name, description: c.description || `${c.n} item${c.n === 1 ? '' : 's'}` }));
    return client.list(chat.phone, 'What are you in the mood for? Choose a section of the menu:', 'View menu', page(rows, pageNo, 'cats'), { header: config.storeName });
  }

  async function showItems(chat, categoryId, pageNo = 0) {
    const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(categoryId);
    const items = db.prepare('SELECT * FROM menu_items WHERE category_id = ? AND available = 1 ORDER BY name').all(categoryId);
    if (!cat || !items.length) return showCategories(chat);
    chat.state = 'browsing';
    save(chat);
    const rows = items.map((i) => ({ id: `item:${i.id}`, title: i.name, description: [money(i.price_cents), i.description].filter(Boolean).join(' · ') }));
    const back = [{ id: 'order', title: '⬅️ Back to menu' }];
    return client.list(chat.phone, `*${cat.name}*${cat.description ? `\n${cat.description}` : ''}\n\nTap an item to add it:`, 'Choose item',
      page(rows, pageNo, `items:${categoryId}`, back), { header: cat.name });
  }

  async function startItem(chat, itemId) {
    const item = getItem(itemId);
    if (!item || !item.available) {
      await client.text(chat.phone, 'Sorry, that item is sold out right now.');
      return showCategories(chat);
    }
    chat.state = 'options';
    chat.data = { build: { itemId, group: 0, chosen: [] } };
    return askNextOption(chat);
  }

  /** Asks for the current option group, skipping empty optional ones; moves on to quantity when done. */
  async function askNextOption(chat) {
    const b = chat.data.build;
    const item = getItem(b.itemId);
    const groups = groupsFor(b.itemId);

    while (b.group < groups.length && groups[b.group].options.length === 0) {
      if (groups[b.group].min_select > 0) {
        await client.text(chat.phone, `Sorry, ${item.name} isn't available right now (we're out of ${groups[b.group].name.toLowerCase()} options).`);
        return showItems(chat, item.category_id);
      }
      b.group += 1;
    }
    if (b.group >= groups.length) return askQuantity(chat);
    save(chat);

    const g = groups[b.group];
    const picked = g.options.filter((o) => b.chosen.includes(o.id));
    const label = (o) => `${o.name}${o.price_delta_cents ? ` ${delta(o.price_delta_cents)}` : ''}`;
    const header = `${item.name} — ${money(item.price_cents)}`;

    if (g.max_select === 1) {
      const body = g.min_select ? `Choose your *${g.name}*:` : `Would you like *${g.name}*? (optional)`;
      if (g.min_select && g.options.length <= 3) {
        return client.buttons(chat.phone, `*${header}*\n\n${body}`, g.options.map((o) => ({ id: `opt:${o.id}`, title: label(o) })));
      }
      const rows = g.options.map((o) => ({ id: `opt:${o.id}`, title: o.name, description: delta(o.price_delta_cents) || undefined }));
      if (!g.min_select) rows.push({ id: 'opt:skip', title: 'No thanks' });
      return client.list(chat.phone, body, 'Choose', rows, { header });
    }

    const remaining = g.options.filter((o) => !b.chosen.includes(o.id));
    const rows = remaining.map((o) => ({ id: `opt:${o.id}`, title: o.name, description: delta(o.price_delta_cents) || undefined }));
    if (picked.length >= g.min_select) rows.unshift({ id: 'opt:done', title: picked.length ? '✅ Done' : 'No thanks' });
    const so = picked.length ? `\nSo far: ${picked.map((o) => o.name).join(', ')}` : '';
    const rule = g.min_select ? `choose ${g.min_select}–${g.max_select}` : `up to ${g.max_select}, optional`;
    return client.list(chat.phone, `Add *${g.name}* (${rule}).${so}`, 'Choose', rows.slice(0, 10), { header });
  }

  async function chooseOption(chat, value) {
    const b = chat.data.build;
    if (chat.state !== 'options' || !b) return showMain(chat, 'That option has expired.');
    const groups = groupsFor(b.itemId);
    const g = groups[b.group];
    if (!g) return askQuantity(chat);
    const pickedCount = g.options.filter((o) => b.chosen.includes(o.id)).length;

    if (value === 'skip' || value === 'done') {
      if (pickedCount < g.min_select) return askNextOption(chat);
      b.group += 1;
      return askNextOption(chat);
    }
    const id = Number(value);
    const opt = g.options.find((o) => o.id === id);
    if (!opt) {
      await client.text(chat.phone, 'That choice is no longer available — please choose again.');
      return askNextOption(chat);
    }
    if (!b.chosen.includes(id)) b.chosen.push(id);
    if (g.max_select === 1 || pickedCount + 1 >= g.max_select) b.group += 1;
    return askNextOption(chat);
  }

  async function askQuantity(chat) {
    const b = chat.data.build;
    const item = getItem(b.itemId);
    chat.state = 'quantity';
    save(chat);
    const priced = priceLine({ menu_item_id: b.itemId, quantity: 1, options: b.chosen });
    const opts = priced?.options.length ? ` (${priced.options.map((o) => o.name).join(', ')})` : '';
    return client.buttons(chat.phone, `How many *${item.name}*${opts}?\n${money(priced ? priced.unit_price_cents : item.price_cents)} each.\n\nTap or type a number.`,
      [1, 2, 3].map((n) => ({ id: `qty:${n}`, title: String(n) })));
  }

  async function addToCart(chat, quantity) {
    const b = chat.data.build;
    if (!b) return showMain(chat);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > config.maxQuantityPerItem) {
      return client.text(chat.phone, `Please type a number from 1 to ${config.maxQuantityPerItem}.`);
    }
    const line = { menu_item_id: b.itemId, quantity, options: b.chosen };
    const priced = priceLine(line);
    if (!priced) {
      await client.text(chat.phone, 'Sorry, that item or one of its options just sold out.');
      return showCategories(chat);
    }
    chat.cart.push(line);
    chat.data = {};
    await client.text(chat.phone, `✅ Added ${describeLine(priced)}`);
    return showCart(chat);
  }

  /** Re-prices the cart, dropping lines that are no longer available. Returns quote or null if empty. */
  async function repriceCart(chat) {
    const kept = [];
    const dropped = [];
    for (const line of chat.cart) (priceLine(line) ? kept : dropped).push(line);
    if (dropped.length) {
      chat.cart = kept;
      await client.text(chat.phone, `Heads up: ${dropped.length === 1 ? 'an item' : `${dropped.length} items`} in your cart sold out and ${dropped.length === 1 ? 'was' : 'were'} removed.`);
    }
    save(chat);
    return chat.cart.length ? svc.price(chat.cart, 'pickup') : null;
  }

  function totalsText(q) {
    return q.prices_include_tax
      ? `*Total: ${money(q.total_cents)}* (incl. VAT ${money(q.tax_cents)})`
      : `Subtotal: ${money(q.subtotal_cents)}\nTax: ${money(q.tax_cents)}\n*Total: ${money(q.total_cents)}*`;
  }

  async function showCart(chat) {
    chat.state = 'cart';
    const q = await repriceCart(chat);
    if (!q) return showMain(chat, 'Your cart is empty.');
    const lines = q.lines.map((l, i) => `${i + 1}. ${describeLine(l)}`).join('\n');
    return client.buttons(chat.phone, `🛒 *Your order*\n\n${lines}\n\n${totalsText(q)}`, [
      { id: 'checkout', title: '✅ Checkout' },
      { id: 'order', title: '➕ Add more' },
      { id: 'editcart', title: '✏️ Edit cart' },
    ]);
  }

  async function showEditCart(chat) {
    const q = await repriceCart(chat);
    if (!q) return showMain(chat, 'Your cart is empty.');
    const rows = q.lines.slice(0, 8).map((l, i) => ({ id: `rm:${i}`, title: `Remove ${l.quantity}× ${l.name}`, description: l.options.map((o) => o.name).join(', ') || undefined }));
    rows.push({ id: 'clearcart', title: '🗑️ Empty cart' }, { id: 'cart', title: '⬅️ Back to cart' });
    return client.list(chat.phone, 'What would you like to remove?', 'Edit cart', rows);
  }

  async function checkout(chat) {
    const q = await repriceCart(chat);
    if (!q) return showMain(chat, 'Your cart is empty.');
    if (!chat.customer_name) {
      chat.state = 'name';
      save(chat);
      const first = (chat.profile_name || '').trim().slice(0, 20);
      const body = 'What name should we put on the order?\n\nType your name' + (first ? ', or tap below.' : '.');
      return first
        ? client.buttons(chat.phone, body, [{ id: 'name:profile', title: first }])
        : client.text(chat.phone, body);
    }
    return askTime(chat);
  }

  /** All bookable collection times, soonest first, across the booking window. */
  function allSlots() {
    const out = [];
    const today = localDate(config.now(), tz);
    for (let i = 0; i <= config.maxDaysAhead && out.length < 200; i++) out.push(...schedule.slots(addDays(today, i)));
    return out;
  }

  async function askTime(chat) {
    chat.state = 'time';
    save(chat);
    const s = schedule.status();
    if (s.accepting_asap_orders) {
      return client.buttons(chat.phone, `Thanks ${chat.customer_name}! When would you like to collect?`, [
        { id: 'time:asap', title: `⚡ ASAP (~${config.prepTimeMinutes} min)` },
        { id: 'time:pick', title: '🕒 Choose a time' },
      ]);
    }
    return showSlots(chat, 0, `${hoursLine()}\n\n`);
  }

  async function showSlots(chat, pageNo = 0, prefix = '') {
    const slots = allSlots();
    if (!slots.length) {
      return showMain(chat, "Sorry, we can't take orders for collection at the moment. Type STAFF to chat to us.");
    }
    chat.state = 'time';
    save(chat);
    const rows = slots.map((iso) => ({ id: `time:${iso}`, title: when(iso) }));
    return client.list(chat.phone, `${prefix}Choose a collection time:`, 'Choose time', page(rows, pageNo, 'times'));
  }

  async function confirm(chat, whenValue) {
    const q = await repriceCart(chat);
    if (!q) return showMain(chat, 'Your cart is empty.');
    chat.state = 'confirm';
    chat.data = { when: whenValue };
    save(chat);
    const lines = q.lines.map((l) => `• ${describeLine(l)}`).join('\n');
    const time = whenValue === 'asap' ? `As soon as possible (about ${config.prepTimeMinutes} min)` : when(whenValue);
    return client.buttons(chat.phone,
      `Please check your order:\n\n${lines}\n\n${totalsText(q)}\n\n👤 ${chat.customer_name}\n📍 Collect at ${config.storeName}\n🕒 ${time}`,
      [
        { id: 'place', title: '✅ Place order' },
        { id: 'cart', title: '✏️ Change' },
        { id: 'abandon', title: '❌ Cancel' },
      ]);
  }

  async function place(chat) {
    if (chat.state !== 'confirm' || !chat.data.when) return showCart(chat);
    const asap = chat.data.when === 'asap';
    // Re-check timing first so the customer gets a friendly message rather than an error.
    if (asap && !schedule.status().accepting_asap_orders) {
      return showSlots(chat, 0, `Sorry — ${hoursLine().charAt(0).toLowerCase()}${hoursLine().slice(1)}\n\n`);
    }
    if (!asap && !schedule.slots(localDate(Date.parse(chat.data.when), tz)).includes(chat.data.when)) {
      return showSlots(chat, 0, 'Sorry, that time is no longer available.\n\n');
    }
    let order;
    try {
      order = svc.create({
        customer_name: chat.customer_name,
        customer_phone: `+${chat.phone}`,
        type: 'pickup',
        items: chat.cart,
        ...(asap ? {} : { scheduled_for: chat.data.when }),
      }, { source: 'whatsapp' });
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      await client.text(chat.phone, `Sorry, we couldn't place that order: ${err.message}`);
      return showCart(chat);
    }
    chat.cart = [];
    chat.state = 'idle';
    chat.data = {};
    save(chat);
    const time = order.scheduled_for ? when(order.scheduled_for) : `in about ${config.prepTimeMinutes} minutes`;
    return client.buttons(chat.phone,
      `✅ *Order placed!*\n\nOrder number: *${order.code}*\nTotal: ${money(order.total_cents)}\nCollect: ${time}\n\n` +
      `We'll send you a message here when it's confirmed and when it's ready.${config.paymentNote ? `\n\n${config.paymentNote}` : ''}`,
      [{ id: 'status', title: '📦 Track order' }, { id: 'order', title: '🍽️ Order more' }]);
  }

  async function showStatus(chat) {
    const order = svc.latestForPhone(`+${chat.phone}`);
    if (!order) return showMain(chat, "You haven't placed an order with us yet.");
    const lines = order.items.map((l) => `• ${describeLine(l)}`).join('\n');
    const time = order.scheduled_for ? `\n🕒 Collect: ${when(order.scheduled_for)}` : '';
    const body = `📦 Order *${order.code}*\nStatus: *${STATUS_TEXT[order.status] ?? order.status}*${time}\n\n${lines}\n\nTotal: ${money(order.total_cents)}`;
    const btns = order.status === 'pending' ? [{ id: `cancelorder:${order.code}`, title: '❌ Cancel order' }] : [];
    btns.push({ id: 'menu', title: '🏠 Main menu' }, { id: 'staff', title: '🙋 Talk to staff' });
    return client.buttons(chat.phone, body, btns);
  }

  async function cancelOrder(chat, code) {
    const order = svc.load('code', code);
    if (!order || order.customer_phone !== `+${chat.phone}`) return showStatus(chat);
    if (order.status !== 'pending') {
      return client.buttons(chat.phone, `Order *${code}* has already been accepted by the kitchen, so it can't be cancelled here. Please chat to us.`,
        [{ id: 'staff', title: '🙋 Talk to staff' }, { id: 'menu', title: '🏠 Main menu' }]);
    }
    svc.setStatus(order, 'cancelled'); // the status notification tells the customer
    return null;
  }

  async function startHandoff(chat) {
    chat.handoff_until = new Date(config.now() + config.whatsapp.handoffHours * 60 * MINUTE).toISOString();
    chat.needs_staff = true;
    chat.state = 'idle';
    save(chat);
    config.events?.emit('whatsapp:handoff', chat.phone);
    const closed = schedule.status().open_now ? '' : "\n\nWe're closed right now, so we'll reply when we're back.";
    return client.text(chat.phone, `No problem! A team member will reply here as soon as possible. 🙂${closed}\n\nType *MENU* any time to go back to ordering.`);
  }

  // ---------- message routing ----------

  /** Handles a tap on a button or list row. */
  async function onReply(chat, id) {
    const [action, arg] = [id.split(':')[0], id.slice(id.indexOf(':') + 1)];
    switch (action) {
      case 'menu': return showMain(chat);
      case 'order': return showCategories(chat);
      case 'cats': return showCategories(chat, Number(arg));
      case 'cat': return showItems(chat, Number(arg));
      case 'items': { const [cat, pg] = arg.split(':').map(Number); return showItems(chat, cat, pg); }
      case 'item': return startItem(chat, Number(arg));
      case 'opt': return chooseOption(chat, arg);
      case 'qty': return chat.state === 'quantity' ? addToCart(chat, Number(arg)) : showCart(chat);
      case 'cart': return showCart(chat);
      case 'editcart': return showEditCart(chat);
      case 'rm': {
        const i = Number(arg);
        if (chat.cart[i]) chat.cart.splice(i, 1);
        return showCart(chat);
      }
      case 'clearcart': chat.cart = []; return showMain(chat, 'Your cart has been emptied.');
      case 'checkout': return checkout(chat);
      case 'name':
        if (chat.state !== 'name') return checkout(chat);
        chat.customer_name = (chat.profile_name || '').trim().slice(0, 60) || null;
        return chat.customer_name ? askTime(chat) : checkout(chat);
      case 'time':
        if (arg === 'asap') return confirm(chat, 'asap');
        if (arg === 'pick') return showSlots(chat);
        return confirm(chat, arg);
      case 'times': return showSlots(chat, Number(arg));
      case 'place': return place(chat);
      case 'abandon': chat.cart = []; return showMain(chat, 'No problem, your order has been cancelled.');
      case 'status': return showStatus(chat);
      case 'cancelorder': return cancelOrder(chat, arg);
      case 'staff': return startHandoff(chat);
      default: return showMain(chat);
    }
  }

  /** Handles typed text. */
  async function onText(chat, raw) {
    const text = raw.trim();
    const word = text.toLowerCase().replace(/[!.?,]+$/g, '');

    if (STAFF_WORDS.has(word)) return startHandoff(chat);
    if (word === 'cancel') { chat.data = {}; return showMain(chat, 'Okay, cancelled.'); }
    if (word === 'cart') return showCart(chat);
    if (word === 'status' || word === 'my order') return showStatus(chat);

    if (chat.state === 'quantity' && /^\d+$/.test(text)) return addToCart(chat, Number(text));
    if (chat.state === 'name' && !GREETINGS.has(word)) {
      if (text.length < 2 || text.length > 60) return client.text(chat.phone, 'Please type a name between 2 and 60 characters.');
      chat.customer_name = text;
      return askTime(chat);
    }
    if (GREETINGS.has(word)) return word === 'order' ? showCategories(chat) : showMain(chat);
    if (chat.state === 'idle') return showMain(chat);
    return client.buttons(chat.phone, "Sorry, I didn't understand that. Please use the buttons, or choose an option below.", [
      { id: 'menu', title: '🏠 Main menu' },
      { id: 'cart', title: '🛒 My cart' },
      { id: 'staff', title: '🙋 Talk to staff' },
    ]);
  }

  /**
   * Entry point for one incoming WhatsApp message (already logged by the caller).
   * msg: { phone, name, kind: 'text' | 'reply' | 'unsupported', text, replyId, type }
   */
  async function handle(msg) {
    const chat = loadChat(msg.phone, msg.name);
    const nowIso = new Date(config.now()).toISOString();
    db.prepare('UPDATE whatsapp_chats SET last_inbound_at = ?, last_message_at = ? WHERE phone = ?').run(nowIso, nowIso, msg.phone);

    if (inHandoff(chat)) {
      // A person is handling this chat. "MENU" hands it back to the bot; anything else waits for staff.
      const word = (msg.text || '').trim().toLowerCase();
      if (msg.kind === 'text' && word === 'menu') {
        chat.handoff_until = null;
        chat.needs_staff = false;
        return showMain(chat);
      }
      if (!chat.needs_staff) { chat.needs_staff = true; save(chat); }
      return null;
    }
    if (chat.handoff_until) { chat.handoff_until = null; chat.needs_staff = false; } // handoff expired

    if (msg.kind === 'reply') return onReply(chat, msg.replyId);
    if (msg.kind === 'text') return onText(chat, msg.text);
    return client.buttons(chat.phone, "Sorry, I can only read text messages and button taps. Would you like to order, or chat to our team?", [
      { id: 'order', title: '🍽️ Order now' },
      { id: 'staff', title: '🙋 Talk to staff' },
    ]);
  }

  /** Message sent to WhatsApp customers when staff change their order's status. */
  function statusMessage(order) {
    const code = `*${order.code}*`;
    switch (order.status) {
      case 'confirmed': return `👍 Your order ${code} is confirmed${order.scheduled_for ? ` for ${when(order.scheduled_for)}` : ''}.`;
      case 'preparing': return `👩‍🍳 We're making your order ${code} now.`;
      case 'ready': return `🎉 Your order ${code} is ready for collection at ${config.storeName}!`;
      case 'completed': return `Thanks for your order! Enjoy 💚 Message us any time to order again.`;
      case 'cancelled': return `Your order ${code} has been cancelled. Reply *STAFF* if you have any questions.`;
      default: return null;
    }
  }

  async function notifyStatus(order) {
    if (order.source !== 'whatsapp') return;
    const body = statusMessage(order);
    if (body) await client.text(order.customer_phone.replace(/^\+/, ''), body);
  }

  return { handle, notifyStatus, STATUS_TEXT };
}

module.exports = { createBot, STATUS_TEXT };
