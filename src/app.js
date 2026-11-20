const path = require('node:path');
const { EventEmitter } = require('node:events');
const express = require('express');
const defaultConfig = require('./config');
const { requireAdmin } = require('./auth');
const { HttpError } = require('./errors');
const { publicMenuRouter, adminMenuRouter } = require('./routes/menu');
const { publicOrdersRouter, adminOrdersRouter } = require('./routes/orders');
const { publicHoursRouter, adminHoursRouter } = require('./routes/hours');
const { createWhatsApp } = require('./routes/whatsapp');

/**
 * Builds the Express app. `overrides` replaces config values (used by tests);
 * `overrides.fetch` replaces the HTTP client used to call WhatsApp.
 */
function createApp(db, overrides = {}) {
  const { fetch, ...rest } = overrides;
  const config = {
    ...defaultConfig,
    ...rest,
    whatsapp: { ...defaultConfig.whatsapp, ...rest.whatsapp },
    events: new EventEmitter(),
  };
  const app = express();
  const whatsapp = createWhatsApp(db, config, { fetch });
  app.locals.whatsapp = whatsapp;
  app.locals.config = config;

  app.disable('x-powered-by');
  // Keep the raw body so WhatsApp webhook signatures can be checked.
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Staff page: orders, WhatsApp chats and sold-out switches.
  app.get('/staff', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'staff.html')));

  app.use('/webhooks/whatsapp', whatsapp.webhook);

  app.use('/api', publicMenuRouter(db));
  app.use('/api', publicOrdersRouter(db, config));
  app.use('/api', publicHoursRouter(db, config));

  const admin = express.Router();
  admin.use(requireAdmin(config.adminApiKey));
  admin.use(adminMenuRouter(db));
  admin.use(adminOrdersRouter(db, config));
  admin.use(adminHoursRouter(db, config));
  admin.use(whatsapp.admin);
  app.use('/api/admin', admin);

  app.use((_req, _res, next) => next(new HttpError(404, 'Route not found')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Malformed JSON body' });
    }
    const known = err instanceof HttpError;
    const status = known ? err.status : err.status && err.status < 500 ? err.status : 500;
    if (!known && status >= 500) console.error(err);
    res.status(status).json({
      error: known || status < 500 ? err.message : 'Internal server error',
      ...(err.details ? { details: err.details } : {}),
    });
  });

  return app;
}

module.exports = { createApp };
