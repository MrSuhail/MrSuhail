const { badRequest } = require('./errors');

/**
 * Tiny schema validator. A schema maps field -> rule:
 *   { type: 'string'|'int'|'bool'|'array', required, min, max, enum, maxLength }
 * With partial=true (for PATCH), required is ignored.
 * Returns only the known fields that were supplied.
 */
function validate(body, schema, { partial = false } = {}) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object');
  }
  const out = {};
  const errors = [];

  for (const [field, rule] of Object.entries(schema)) {
    const value = body[field];
    if (value === undefined || value === null || value === '') {
      if (rule.required && !partial) errors.push(`${field} is required`);
      else if (value === null && rule.nullable) out[field] = null;
      continue;
    }

    switch (rule.type) {
      case 'string':
        if (typeof value !== 'string') { errors.push(`${field} must be a string`); continue; }
        if (rule.maxLength && value.length > rule.maxLength) {
          errors.push(`${field} must be at most ${rule.maxLength} characters`); continue;
        }
        break;
      case 'int':
        if (!Number.isInteger(value)) { errors.push(`${field} must be an integer`); continue; }
        if (rule.min !== undefined && value < rule.min) { errors.push(`${field} must be >= ${rule.min}`); continue; }
        if (rule.max !== undefined && value > rule.max) { errors.push(`${field} must be <= ${rule.max}`); continue; }
        break;
      case 'bool':
        if (typeof value !== 'boolean') { errors.push(`${field} must be a boolean`); continue; }
        break;
      case 'array':
        if (!Array.isArray(value)) { errors.push(`${field} must be an array`); continue; }
        if (rule.min !== undefined && value.length < rule.min) {
          errors.push(`${field} must contain at least ${rule.min} item(s)`); continue;
        }
        if (rule.max !== undefined && value.length > rule.max) {
          errors.push(`${field} must contain at most ${rule.max} item(s)`); continue;
        }
        break;
    }
    if (rule.enum && !rule.enum.includes(value)) {
      errors.push(`${field} must be one of: ${rule.enum.join(', ')}`); continue;
    }
    out[field] = typeof value === 'string' ? value.trim() : value;
  }

  if (errors.length) throw badRequest('Validation failed', errors);
  return out;
}

function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Invalid id');
  return id;
}

module.exports = { validate, parseId };
