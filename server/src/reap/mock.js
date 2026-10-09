// Fake Reap with the same interface as client.js, so the game runs with no key
// or network (MOCK_REAP=1). Search is served by the catalog's offline cache;
// this file prices quotes and fakes checkouts. Checkouts created without
// `simulate` wait for POST /api/mock/approve/:checkoutId.

import { randomUUID } from 'node:crypto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const id = (p) => `${p}_mock_${randomUUID().slice(0, 8)}`;
const usd = (amount) => ({ amount: Math.round(amount * 100) / 100, currency: 'USD' });

const catalog = new Map(); // variantId → offer (registered by the catalog)
const quotes = new Map();
const checkouts = new Map();

function breakdown(subtotal, shipping) {
  const tax = subtotal * 0.08;
  return {
    itemsSubtotal: usd(subtotal),
    shipping: usd(shipping),
    tax: { amount: usd(tax), includedInPrices: false },
    discounts: [],
    additionalCharges: [],
    finalAmount: usd(subtotal + shipping + tax),
  };
}

export const reapMock = {
  registerOffers(offers) {
    for (const o of offers) catalog.set(o.variantId, o);
  },

  async search() {
    // The catalog handles offline search itself (catalog.js → offlineSearch).
    return { id: id('qry'), products: [], pagination: { hasNextPage: false, returnedCount: 0 }, warnings: [] };
  },

  async details(productIds) {
    return { products: productIds.map((pid) => ({ id: pid, options: [] })), errors: [] };
  },

  async resolveVariant(productId) {
    const p = [...catalog.values()].find((x) => x.productId === productId);
    return { id: p?.variantId, price: usd(p?.price || 0), available: true, requiresShipping: true };
  },

  async createQuote(items) {
    await sleep(1500);
    const subtotal = items.reduce((sum, it) => {
      const p = catalog.get(it.variantId);
      return sum + (p ? p.price : 10) * it.quantity;
    }, 0);
    const options = [
      { id: id('ship'), name: 'Standard', selected: true, price: usd(6) },
      { id: id('ship'), name: 'Express', selected: false, price: usd(18) },
    ];
    const quote = {
      id: id('quo'),
      shippingOptions: options,
      amountBreakdown: breakdown(subtotal, 6),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      _subtotal: subtotal,
    };
    quotes.set(quote.id, quote);
    return quote;
  },

  async getQuote(quoteId) {
    return quotes.get(quoteId);
  },

  async selectShipping(quoteId, shippingOptionId) {
    await sleep(500);
    const q = quotes.get(quoteId);
    q.shippingOptions = q.shippingOptions.map((o) => ({ ...o, selected: o.id === shippingOptionId }));
    const sel = q.shippingOptions.find((o) => o.selected);
    q.amountBreakdown = breakdown(q._subtotal, sel.price.amount);
    return q;
  },

  async createCheckout(quoteId, { simulate } = {}) {
    await sleep(800);
    const q = quotes.get(quoteId);
    const co = {
      id: id('chk'),
      quoteId,
      status: simulate === 'COMPLETED' ? 'PROCESSING' : 'REQUIRES_ACTION',
      amount: q.amountBreakdown.finalAmount,
      nextAction: simulate ? null : { type: 'REDIRECT', url: `http://localhost:5173/?mockApprove=1` },
      _createdAt: Date.now(),
    };
    checkouts.set(co.id, co);
    return co;
  },

  async getCheckout(checkoutId) {
    const co = checkouts.get(checkoutId);
    if (co.status === 'PROCESSING' && Date.now() - co._createdAt > 1500) {
      co.status = 'COMPLETED';
      co.orderId = `#${Math.floor(10000 + Math.random() * 90000)}`;
      co.finalAmount = co.amount;
      co.nextAction = null;
    }
    return co;
  },

  // Mock-only: called by POST /api/mock/approve/:checkoutId
  approve(checkoutId, approve = true) {
    const co = checkouts.get(checkoutId);
    if (!co) return null;
    if (approve) {
      co.status = 'PROCESSING';
      co._createdAt = Date.now();
    } else {
      co.status = 'EXPIRED';
    }
    return co;
  },

  async createEnrollment() {
    return { id: id('enr'), status: 'ACTIVE', nextAction: null };
  },

  async getEnrollment(enrId) {
    return { id: enrId, status: 'ACTIVE', paymentMethod: { network: 'VISA', last4: '1811' } };
  },
};
