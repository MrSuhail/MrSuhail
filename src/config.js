const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

module.exports = {
  port: num(process.env.PORT, 3000),
  adminApiKey: process.env.ADMIN_API_KEY || 'change-me',
  /** Sales tax in basis points (825 = 8.25%). */
  taxRateBps: num(process.env.TAX_RATE_BPS, 825),
  deliveryFeeCents: num(process.env.DELIVERY_FEE_CENTS, 499),
  minDeliveryOrderCents: num(process.env.MIN_DELIVERY_ORDER_CENTS, 1500),
  maxQuantityPerItem: 50,

  /** IANA time zone the opening hours are written in, e.g. "America/New_York". */
  timezone: process.env.TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
  /** Stop taking ASAP orders this many minutes before closing. */
  orderCutoffMinutes: num(process.env.ORDER_CUTOFF_MINUTES, 15),
  /** Minimum time between ordering and a scheduled pickup/delivery time; also the time after opening of the first slot. */
  prepTimeMinutes: num(process.env.PREP_TIME_MINUTES, 20),
  /** Spacing of offered pickup/delivery time slots. */
  slotIntervalMinutes: num(process.env.SLOT_INTERVAL_MINUTES, 15),
  /** How far ahead customers may schedule an order. */
  maxDaysAhead: num(process.env.MAX_DAYS_AHEAD, 7),

  /** Clock, overridable in tests. Returns epoch milliseconds. */
  now: () => Date.now(),
};
