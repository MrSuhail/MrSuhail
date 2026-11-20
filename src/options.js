const { validate } = require('./validate');
const { badRequest, conflict } = require('./errors');

const groupSchema = {
  name: { type: 'string', required: true, maxLength: 100 },
  min_select: { type: 'int', min: 0, max: 50 },
  max_select: { type: 'int', min: 1, max: 50 },
  options: { type: 'array', required: true, min: 1 },
};

const optionSchema = {
  name: { type: 'string', required: true, maxLength: 100 },
  price_delta_cents: { type: 'int', min: -100000, max: 100000 },
  available: { type: 'bool' },
};

/**
 * Validates the `option_groups` array from an item create/update request.
 * Each group: { name, min_select = 0, max_select = 1, options: [{ name, price_delta_cents = 0, available = true }] }
 */
function parseOptionGroups(raw) {
  if (!Array.isArray(raw)) throw badRequest('option_groups must be an array');
  if (raw.length > 20) throw badRequest('An item can have at most 20 option groups');
  return raw.map((g, gi) => {
    const where = `option_groups[${gi}]`;
    const group = prefixed(where, () => validate(g, groupSchema));
    const min = group.min_select ?? 0;
    const max = group.max_select ?? 1;
    if (group.options.length > 50) throw badRequest(`${where}: at most 50 options per group`);
    if (min > max) throw badRequest(`${where}: min_select can't be greater than max_select`);
    if (min > group.options.length) throw badRequest(`${where}: min_select is more than the number of options`);
    const options = group.options.map((o, oi) => {
      const opt = prefixed(`${where}.options[${oi}]`, () => validate(o, optionSchema));
      return { name: opt.name, price_delta_cents: opt.price_delta_cents ?? 0, available: opt.available ?? true };
    });
    return { name: group.name, min_select: min, max_select: max, options };
  });
}

function prefixed(where, fn) {
  try { return fn(); } catch (err) { err.message = `${where}: ${err.message}`; throw err; }
}

/** Replaces all option groups of an item. Call inside a transaction. */
function replaceOptionGroups(db, itemId, groups) {
  db.prepare('DELETE FROM option_groups WHERE menu_item_id = ?').run(itemId);
  const insertGroup = db.prepare(
    'INSERT INTO option_groups (menu_item_id, name, min_select, max_select, sort_order) VALUES (?, ?, ?, ?, ?)'
  );
  const insertOption = db.prepare(
    'INSERT INTO options (group_id, name, price_delta_cents, available, sort_order) VALUES (?, ?, ?, ?, ?)'
  );
  groups.forEach((g, gi) => {
    const groupId = Number(insertGroup.run(itemId, g.name, g.min_select, g.max_select, gi).lastInsertRowid);
    g.options.forEach((o, oi) => insertOption.run(groupId, o.name, o.price_delta_cents, o.available ? 1 : 0, oi));
  });
}

/** Loads option groups for the given item ids (or all items when ids is omitted). Returns Map<itemId, group[]>. */
function loadOptionGroups(db, ids) {
  const filter = ids ? `WHERE g.menu_item_id IN (${ids.map(() => '?').join(',') || 'NULL'})` : '';
  const rows = db.prepare(
    `SELECT g.id AS group_id, g.menu_item_id, g.name AS group_name, g.min_select, g.max_select,
            o.id AS option_id, o.name AS option_name, o.price_delta_cents, o.available
     FROM option_groups g JOIN options o ON o.group_id = g.id
     ${filter}
     ORDER BY g.menu_item_id, g.sort_order, g.id, o.sort_order, o.id`
  ).all(...(ids ?? []));

  const byItem = new Map();
  const byGroup = new Map();
  for (const r of rows) {
    let group = byGroup.get(r.group_id);
    if (!group) {
      group = { id: r.group_id, name: r.group_name, min_select: r.min_select, max_select: r.max_select, options: [] };
      byGroup.set(r.group_id, group);
      if (!byItem.has(r.menu_item_id)) byItem.set(r.menu_item_id, []);
      byItem.get(r.menu_item_id).push(group);
    }
    group.options.push({
      id: r.option_id, name: r.option_name, price_delta_cents: r.price_delta_cents, available: Boolean(r.available),
    });
  }
  return byItem;
}

/**
 * Checks a cart line's chosen option ids against the item's option groups.
 * Returns { options: [{ group, name, price_delta_cents }], deltaCents }.
 */
function resolveSelectedOptions(item, groups, selected, where) {
  if (selected !== undefined && !Array.isArray(selected)) throw badRequest(`${where}: options must be an array of option ids`);
  const ids = selected ?? [];
  if (new Set(ids).size !== ids.length) throw badRequest(`${where}: an option was chosen more than once`);

  const index = new Map();
  for (const g of groups) for (const o of g.options) index.set(o.id, { group: g, option: o });

  const counts = new Map();
  const chosen = ids.map((id) => {
    const hit = index.get(id);
    if (!hit) throw badRequest(`${where}: option ${JSON.stringify(id)} is not an option for "${item.name}"`);
    if (!hit.option.available) throw conflict(`"${hit.option.name}" for "${item.name}" is currently unavailable`);
    counts.set(hit.group.id, (counts.get(hit.group.id) ?? 0) + 1);
    return hit;
  });

  for (const g of groups) {
    const n = counts.get(g.id) ?? 0;
    if (n < g.min_select) {
      throw badRequest(`${where}: choose ${g.min_select === g.max_select ? '' : 'at least '}${g.min_select} for "${g.name}" on "${item.name}"`);
    }
    if (n > g.max_select) throw badRequest(`${where}: choose at most ${g.max_select} for "${g.name}" on "${item.name}"`);
  }

  // Keep the menu's group/option order regardless of the order ids were sent in.
  const order = [...index.keys()];
  chosen.sort((a, b) => order.indexOf(a.option.id) - order.indexOf(b.option.id));
  return {
    options: chosen.map(({ group, option }) => ({ group: group.name, name: option.name, price_delta_cents: option.price_delta_cents })),
    deltaCents: chosen.reduce((sum, c) => sum + c.option.price_delta_cents, 0),
  };
}

module.exports = { parseOptionGroups, replaceOptionGroups, loadOptionGroups, resolveSelectedOptions, optionSchema };
