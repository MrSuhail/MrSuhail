const { transaction } = require('./db');

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
      ['Iced Tea', 'Peach or classic', 349, ['vegan']],
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
      for (const [name, desc, price, tags] of cat.items) insertItem.run(catId, name, desc, price, JSON.stringify(tags));
    });
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
