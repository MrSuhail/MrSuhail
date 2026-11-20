const express = require('express');
const { validate } = require('../validate');
const { transaction } = require('../db');
const { badRequest, notFound } = require('../errors');
const { createSchedule, DAYS, TIME_RE, isValidDate } = require('../hours');

function weeklyView(schedule) {
  return schedule.weekly().map((r) => ({ day: DAYS[r.day_of_week], open: r.open_time, close: r.close_time }));
}

function publicHoursRouter(db, config) {
  const router = express.Router();
  const schedule = createSchedule(db, config);

  router.get('/hours', (_req, res) => {
    const today = schedule.localDate(config.now(), schedule.tz);
    res.json({
      timezone: schedule.tz,
      weekly: weeklyView(schedule),
      closures: db.prepare('SELECT date, reason FROM closures WHERE date >= ? ORDER BY date').all(today),
      ...schedule.status(),
    });
  });

  // Pickup/delivery times customers can choose. ?date=YYYY-MM-DD (restaurant local date, default today)
  router.get('/hours/slots', (req, res) => {
    const date = req.query.date ?? schedule.localDate(config.now(), schedule.tz);
    if (!isValidDate(date)) throw badRequest('date must be YYYY-MM-DD');
    res.json({ date, timezone: schedule.tz, slots: schedule.slots(date) });
  });

  return router;
}

function adminHoursRouter(db, config) {
  const router = express.Router();
  const schedule = createSchedule(db, config);

  // Replace the whole weekly schedule. Multiple shifts per day are allowed (e.g. lunch and dinner).
  // { "weekly": [{ "day": "monday", "open": "11:00", "close": "22:00" }, ...] }  — an empty list means always open.
  router.put('/hours', (req, res) => {
    const { weekly } = validate(req.body, { weekly: { type: 'array', required: true } });
    const errors = [];
    const rows = weekly.map((s, i) => {
      if (!s || typeof s !== 'object') { errors.push(`weekly[${i}] must be an object`); return null; }
      const day = DAYS.indexOf(String(s.day).toLowerCase());
      if (day === -1) errors.push(`weekly[${i}].day must be one of: ${DAYS.join(', ')}`);
      if (!TIME_RE.test(s.open)) errors.push(`weekly[${i}].open must be HH:MM (24-hour)`);
      if (!TIME_RE.test(s.close)) errors.push(`weekly[${i}].close must be HH:MM (24-hour)`);
      if (s.open === s.close) errors.push(`weekly[${i}]: open and close can't be the same time`);
      return [day, s.open, s.close];
    });
    if (errors.length) throw badRequest('Validation failed', errors);

    transaction(db, () => {
      db.exec('DELETE FROM opening_hours');
      const insert = db.prepare('INSERT INTO opening_hours (day_of_week, open_time, close_time) VALUES (?, ?, ?)');
      for (const r of rows) insert.run(...r);
    });
    res.json({ timezone: schedule.tz, weekly: weeklyView(schedule), ...schedule.status() });
  });

  router.get('/closures', (_req, res) => {
    res.json({ data: db.prepare('SELECT date, reason FROM closures ORDER BY date').all() });
  });

  // Close for a whole day: { "date": "2026-12-25", "reason": "Christmas" }. Re-posting a date updates its reason.
  router.post('/closures', (req, res) => {
    const data = validate(req.body, {
      date: { type: 'string', required: true },
      reason: { type: 'string', maxLength: 200 },
    });
    if (!isValidDate(data.date)) throw badRequest('date must be YYYY-MM-DD');
    db.prepare('INSERT INTO closures (date, reason) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET reason = excluded.reason')
      .run(data.date, data.reason ?? '');
    res.status(201).json(db.prepare('SELECT date, reason FROM closures WHERE date = ?').get(data.date));
  });

  router.delete('/closures/:date', (req, res) => {
    const { changes } = db.prepare('DELETE FROM closures WHERE date = ?').run(req.params.date);
    if (!changes) throw notFound('Closure');
    res.status(204).end();
  });

  return router;
}

module.exports = { publicHoursRouter, adminHoursRouter };
