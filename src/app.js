const express = require('express');
const defaultConfig = require('./config');
const { requireAdmin } = require('./auth');
const { HttpError } = require('./errors');
const { publicMenuRouter, adminMenuRouter } = require('./routes/menu');
const { publicOrdersRouter, adminOrdersRouter } = require('./routes/orders');
const { publicHoursRouter, adminHoursRouter } = require('./routes/hours');

function createApp(db, overrides = {}) {
  const config = { ...defaultConfig, ...overrides };
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.use('/api', publicMenuRouter(db));
  app.use('/api', publicOrdersRouter(db, config));
  app.use('/api', publicHoursRouter(db, config));

  const admin = express.Router();
  admin.use(requireAdmin(config.adminApiKey));
  admin.use(adminMenuRouter(db));
  admin.use(adminOrdersRouter(db, config));
  admin.use(adminHoursRouter(db, config));
  app.use('/api/admin', admin);

  app.use((_req, _res, next) => next(new HttpError(404, 'Route not found')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Malformed JSON body' });
    }
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({
      error: status >= 500 ? 'Internal server error' : err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  });

  return app;
}

module.exports = { createApp };
