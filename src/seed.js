const { transaction } = require('./db');
const { replaceOptionGroups } = require('./options');

const opt = (name, price_delta_cents = 0) => ({ name, price_delta_cents, available: true });

/** Option groups for seeded items, keyed by item name. */
const OPTIONS = {
  'Classic Burger': [
    { name: 'Cooked', min_select: 1, max_select: 1, options: [opt('Medium rare'), opt('Medium'), opt('Well done')] },
    { name: 'Side', min_select: 1, max_select: 1, options: [opt('Fries'), opt('Side salad'), opt('Sweet potato fries', 150)] },
    { name: 'Extras', min_select: 0, max_select: 3, options: [opt('Bacon', 200), opt('Avocado', 150), opt('Fried egg', 125), opt('Extra patty', 450)] },
  ],
  'Margherita Pizza': [
    { name: 'Size', min_select: 1, max_select: 1, options: [opt('10 inch'), opt('14 inch', 400)] },
    { name: 'Toppings', min_select: 0, max_select: 5, options: [opt('Mushrooms', 150), opt('Olives', 150), opt('Pepperoni', 200), opt('Extra mozzarella', 175)] },
    { name: 'Crust', min_select: 0, max_select: 1, options: [opt('Gluten-free crust', 300)] },
  ],
  'Grilled Salmon': [
    { name: 'Side', min_select: 1, max_select: 1, options: [opt('Seasonal vegetables'), opt('Mashed potatoes'), opt('Rice')] },
  ],
  'Chocolate Brownie': [
    { name: 'Ice cream', min_select: 0, max_select: 1, options: [opt('No ice cream', -100)] },
  ],
  'Iced Tea': [
    { name: 'Flavor', min_select: 1, max_select: 1, options: [opt('Classic'), opt('Peach')] },
  ],
  'Fresh Lemonade': [
    { name: 'Size', min_select: 1, max_select: 1, options: [opt('Regular'), opt('Large', 150)] },
  ],
};

// [day_of_week (0 = Sunday), open, close]
const HOURS = [
  [0, '12:00', '21:00'],
  [1, '11:00', '22:00'], [2, '11:00', '22:00'], [3, '11:00', '22:00'], [4, '11:00', '22:00'],
  [5, '11:00', '23:00'], [6, '11:00', '23:00'],
];

const MENU = [
  {
    name: 'Starters', description: 'Small plates to share', items: [
      ['Garlic Bread', 'Toasted sourdough, garlic butter, parsley', 599, ['vegetarian']],
      ['Crispy Calamari', 'Lemon aioli, chili salt', 1199, []],
      ['Tomato Soup', 'Roasted tomatoes, basil, cream', 799, ['vegetarian', 'gluten-free']],
    ],
  },
  {
    name: 'Mains', description: 'Served with a side salad', items: [
      ['Classic Burger', 'Beef patty, cheddar, pickles, brioche bun', 1599, []],
      ['Margherita Pizza', 'San Marzano tomato, mozzarella, basil', 1399, ['vegetarian']],
      ['Grilled Salmon', 'Herb butter, seasonal vegetables', 2299, ['gluten-free']],
      ['Chickpea Curry', 'Coconut, spinach, basmati rice', 1499, ['vegan', 'gluten-free']],
    ],
  },
  {
    name: 'Desserts', description: '', items: [
      ['Chocolate Brownie', 'Warm, with vanilla ice cream', 699, ['vegetarian']],
      ['Lemon Tart', 'Shortcrust, torched meringue', 749, ['vegetarian']],
    ],
  },
  {
    name: 'Drinks', description: '', items: [
      ['Fresh Lemonade', 'House-made', 399, ['vegan']],
      ['Iced Tea', 'Brewed in-house', 349, ['vegan']],
      ['Sparkling Water', '500ml', 299, ['vegan']],
    ],
  },
];

function seed(db) {
  transaction(db, () => {
    const insertCat = db.prepare('INSERT INTO categories (name, description, sort_order) VALUES (?, ?, ?)');
    const insertItem = db.prepare(
      'INSERT INTO menu_items (category_id, name, description, price_cents, tags) VALUES (?, ?, ?, ?, ?)'
    );
    MENU.forEach((cat, i) => {
      const catId = Number(insertCat.run(cat.name, cat.description, i).lastInsertRowid);
      for (const [name, desc, price, tags] of cat.items) {
        const itemId = Number(insertItem.run(catId, name, desc, price, JSON.stringify(tags)).lastInsertRowid);
        if (OPTIONS[name]) replaceOptionGroups(db, itemId, OPTIONS[name]);
      }
    });
    const insertHours = db.prepare('INSERT INTO opening_hours (day_of_week, open_time, close_time) VALUES (?, ?, ?)');
    for (const h of HOURS) insertHours.run(...h);
  });
}

/** Seeds only when there are no categories yet. Returns true if it seeded. */
function seedIfEmpty(db) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM categories').get();
  if (n > 0) return false;
  seed(db);
  return true;
}

module.exports = { seed, seedIfEmpty };

if (require.main === module) {
  const { openDatabase } = require('./db');
  const db = openDatabase();
  console.log(seedIfEmpty(db) ? 'Seeded sample menu' : 'Database already has data; skipped');
  db.close();
}
