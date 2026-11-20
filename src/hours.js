const { conflict, badRequest } = require('./errors');

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MINUTE = 60_000;

// ---------- time-zone helpers (no external libraries) ----------

const formatters = new Map();
function formatter(tz) {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return formatters.get(tz);
}

/** Wall-clock parts of an instant in a time zone. */
function localParts(ms, tz) {
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second };
}

const pad = (n) => String(n).padStart(2, '0');

/** Local calendar date ('YYYY-MM-DD') of an instant. */
function localDate(ms, tz) {
  const p = localParts(ms, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function dayOfWeek(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function offsetMs(ms, tz) {
  const t = Math.floor(ms / 1000) * 1000;
  const p = localParts(t, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - t;
}

/** Instant for a local date plus minutes since local midnight (minutes may exceed 1440). */
function localToUtc(date, minutes, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const first = guess - offsetMs(guess, tz);
  const second = guess - offsetMs(first, tz); // corrects across DST changes
  return second;
}

const toMinutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(s) {
  return typeof s === 'string' && DATE_RE.test(s) && addDays(s, 0) === s;
}

function assertTimezone(tz) {
  try { formatter(tz); } catch { throw new Error(`Invalid TIMEZONE "${tz}"`); }
}

// ---------- schedule ----------

function createSchedule(db, config) {
  const tz = config.timezone;
  assertTimezone(tz);

  const weekly = () => db.prepare('SELECT day_of_week, open_time, close_time FROM opening_hours ORDER BY day_of_week, open_time').all();
  const closedDates = () => new Set(db.prepare('SELECT date FROM closures').all().map((r) => r.date));

  /**
   * Concrete open periods [{start, end}] (epoch ms) for shifts starting on local dates
   * from `fromDate` for `days` days, with closures removed and touching periods merged.
   * With no weekly hours configured, the restaurant counts as open around the clock.
   */
  function periods(fromDate, days) {
    const rows = weekly();
    const closed = closedDates();
    const out = [];
    for (let i = 0; i < days; i++) {
      const date = addDays(fromDate, i);
      if (closed.has(date)) continue;
      const shifts = rows.length
        ? rows.filter((r) => r.day_of_week === dayOfWeek(date)).map((r) => {
          const open = toMinutes(r.open_time);
          let close = toMinutes(r.close_time);
          if (close <= open) close += 1440; // runs past midnight
          return [open, close];
        })
        : [[0, 1440]];
      for (const [open, close] of shifts) out.push({ start: localToUtc(date, open, tz), end: localToUtc(date, close, tz) });
    }
    out.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const p of out) {
      const last = merged[merged.length - 1];
      if (last && p.start <= last.end) last.end = Math.max(last.end, p.end);
      else merged.push({ ...p });
    }
    return merged;
  }

  /** Periods relevant to "now": yesterday (for shifts past midnight) through the booking window. */
  const windowDays = () => config.maxDaysAhead + 2;
  const upcoming = (now) => periods(addDays(localDate(now, tz), -1), windowDays());

  function status(now = config.now()) {
    const all = upcoming(now);
    const current = all.find((p) => p.start <= now && now < p.end);
    const next = all.find((p) => p.start > now);
    const iso = (ms) => (ms === undefined ? null : new Date(ms).toISOString());
    // A period reaching the end of the look-ahead window has no known closing time (e.g. open 24/7).
    const windowEnd = localToUtc(addDays(localDate(now, tz), windowDays() - 2), 1440, tz);
    return {
      open_now: Boolean(current),
      accepting_asap_orders: Boolean(current) && now <= current.end - config.orderCutoffMinutes * MINUTE,
      closes_at: current && current.end < windowEnd ? iso(current.end) : null,
      next_opens_at: iso(next?.start),
    };
  }

  function describeNextOpening(now) {
    const next = upcoming(now).find((p) => p.start > now);
    return next ? ` We next open at ${new Date(next.start).toISOString()}.` : '';
  }

  /** Throws 409 unless an ASAP order can be accepted right now. */
  function assertAcceptingAsap(now = config.now()) {
    const s = status(now);
    if (s.accepting_asap_orders) return;
    if (s.open_now) {
      throw conflict(`We've stopped taking orders for today (kitchen closes at ${s.closes_at}). You can schedule an order for later.${describeNextOpening(now)}`);
    }
    throw conflict(`The restaurant is closed right now.${describeNextOpening(now)} You can schedule an order for later.`);
  }

  /** Validates a requested pickup/delivery time; returns it as epoch ms. */
  function assertSchedulable(when, now = config.now()) {
    const t = typeof when === 'string' && /T.*(Z|[+-]\d{2}:?\d{2})$/.test(when) ? Date.parse(when) : NaN;
    if (Number.isNaN(t)) throw badRequest('scheduled_for must be an ISO 8601 date-time with a time zone, e.g. 2026-11-21T18:30:00Z');
    if (t < now + config.prepTimeMinutes * MINUTE) {
      throw conflict(`Scheduled orders need at least ${config.prepTimeMinutes} minutes of notice`);
    }
    if (t > now + config.maxDaysAhead * 1440 * MINUTE) {
      throw conflict(`Orders can be scheduled at most ${config.maxDaysAhead} days ahead`);
    }
    const ok = upcoming(now).some((p) => t >= p.start + config.prepTimeMinutes * MINUTE && t <= p.end);
    if (!ok) throw conflict('The restaurant is not open at that time; see GET /api/hours/slots for available times');
    return t;
  }

  /** Available pickup/delivery times on a local date. */
  function slots(date, now = config.now()) {
    const step = config.slotIntervalMinutes;
    const earliest = now + config.prepTimeMinutes * MINUTE;
    const latest = now + config.maxDaysAhead * 1440 * MINUTE;
    const result = [];
    for (const p of periods(addDays(date, -1), 2)) {
      let t = Math.max(p.start + config.prepTimeMinutes * MINUTE, earliest);
      // Round up to the next slot boundary in local time.
      const lp = localParts(t, tz);
      const local = lp.h * 60 + lp.min + (lp.s > 0 || t % MINUTE > 0 ? 1 : 0);
      t = localToUtc(localDate(t, tz), Math.ceil(local / step) * step, tz);
      for (; t <= p.end && t <= latest; t += step * MINUTE) {
        if (localDate(t, tz) === date) result.push(new Date(t).toISOString());
      }
    }
    return result;
  }

  return { tz, weekly, status, assertAcceptingAsap, assertSchedulable, slots, localDate };
}

module.exports = { createSchedule, DAYS, TIME_RE, isValidDate, localDate, addDays, assertTimezone };
