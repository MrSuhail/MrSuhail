const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

module.exports = {
  port: num(process.env.PORT, 3000),
  adminApiKey: process.env.ADMIN_API_KEY || 'change-me',
  /** Sales tax in basis points (825 = 8.25%). */
  taxRateBps: num(process.env.TAX_RATE_BPS, 825),
  deliveryFeeCents: num(process.env.DELIVERY_FEE_CENTS, 499),
  minDeliveryOrderCents: num(process.env.MIN_DELIVERY_ORDER_CENTS, 1500),
  maxQuantityPerItem: 50,
};
