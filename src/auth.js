const crypto = require('node:crypto');
const { HttpError } = require('./errors');

/** Requires `Authorization: Bearer <key>` or `X-Admin-Key: <key>`. */
function requireAdmin(adminApiKey) {
  const expected = Buffer.from(adminApiKey);
  return (req, _res, next) => {
    const header = req.get('authorization') || '';
    const supplied = header.startsWith('Bearer ') ? header.slice(7) : req.get('x-admin-key') || '';
    const given = Buffer.from(supplied);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      return next(new HttpError(401, 'Admin API key required'));
    }
    next();
  };
}

module.exports = { requireAdmin };
