const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

module.exports = {
  port: num(process.env.PORT, 3000),
  adminApiKey: process.env.ADMIN_API_KEY || 'change-me',
  storeName: process.env.STORE_NAME || 'Our Restaurant',
  /** Symbol used when showing prices to customers (e.g. "R", "$"). */
  currencySymbol: process.env.CURRENCY_SYMBOL || '$',

  /** Sales tax / VAT in basis points (825 = 8.25%, 1500 = 15%). */
  taxRateBps: num(process.env.TAX_RATE_BPS, 825),
  /**
   * true: menu prices already include tax (e.g. South African VAT); the order shows the VAT portion but doesn't add it.
   * false: tax is added on top of menu prices (e.g. US sales tax).
   */
  pricesIncludeTax: process.env.PRICES_INCLUDE_TAX === 'true',
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

  /** Shown to WhatsApp customers after they order, e.g. how to pay. Empty to hide. */
  paymentNote: process.env.PAYMENT_NOTE ?? 'Please pay at the counter when you collect.',

  whatsapp: {
    /** Permanent access token from Meta (System User token). WhatsApp is disabled when this is unset. */
    token: process.env.WHATSAPP_TOKEN || '',
    /** "Phone number ID" from the WhatsApp > API Setup page (not the phone number itself). */
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    /** App secret, used to check that webhook calls really come from Meta. */
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
    /** Any string you choose; enter the same value when setting up the webhook in Meta. */
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v23.0',
    /** After "Talk to staff", the bot stays quiet until staff hand back, or this many hours pass without a staff reply. */
    handoffHours: num(process.env.WHATSAPP_HANDOFF_HOURS, 2),
  },

  /** Clock, overridable in tests. Returns epoch milliseconds. */
  now: () => Date.now(),
};
