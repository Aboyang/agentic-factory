// The purchase flow the agent calls: quote → (shipping) → checkout → wait.
// Keep the return shapes stable; the game renders them.

import { reap } from './index.js';
import { config } from '../config.js';
import { ReapError } from './client.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'EXPIRED']);

/**
 * Price a list of parts from ONE merchant.
 * @param {Array<{variantId, qty, name, merchant, image}>} parts
 * @param {{ express?: boolean }} opts
 * @returns {Promise<Quote>} {
 *   quoteId, merchant, items:[{name, qty, image}], shipping:{name, amount},
 *   subtotal, tax, total, currency, expiresAt, shippingOptions:[{id,name,amount,selected}]
 * }
 */
export async function quoteParts(parts, { express = false } = {}) {
  const merchants = new Set(parts.map((p) => p.merchant));
  if (merchants.size > 1) {
    // TODO: split into one quote per merchant (Reap rejects mixed carts).
    throw new ReapError(400, { error: { code: 'MIXED_MERCHANTS', message: 'Parts come from more than one store' } });
  }

  let q = await reap.createQuote(parts.map((p) => ({ variantId: p.variantId, quantity: p.qty || 1 })));

  if (express) {
    // Pick the fastest-sounding option. TODO: smarter matching per merchant.
    const fast = q.shippingOptions.find((o) => /express|overnight|2day|priority/i.test(o.name));
    if (fast && !fast.selected) q = await reap.selectShipping(q.id, fast.id);
  }

  return toQuote(q, parts);
}

export async function refreshQuote(quote, parts, opts) {
  // TODO: call when a checkout says the quote expired; emit a "price refreshed" event.
  return quoteParts(parts, opts);
}

/**
 * Open the checkout.
 * autoApprove=true  → sandbox simulate header, no human step (our policy allowed it).
 * autoApprove=false → returns approvalUrl; the manager must approve on Reap's page.
 */
export async function startCheckout(quote, { autoApprove }) {
  // Reap's sandbox cannot place real merchant orders: without the simulate header an approved
  // checkout ends FAILED. The manager still approves on Reap's page either way.
  const sandbox = /sandbox/.test(config.reap.baseUrl);
  const co = await reap.createCheckout(quote.quoteId, sandbox || autoApprove ? { simulate: 'COMPLETED' } : {});
  return {
    checkoutId: co.id,
    status: co.status,
    approvalUrl: co.nextAction?.url || null,
    amount: co.amount,
  };
}

/** Poll until the checkout reaches COMPLETED / FAILED / EXPIRED. */
export async function waitForCheckout(checkoutId, { timeoutMs = 10 * 60_000, intervalMs = 2500 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const co = await reap.getCheckout(checkoutId);
    if (TERMINAL.has(co.status)) {
      return { status: co.status, orderId: co.orderId, finalAmount: co.finalAmount || co.amount };
    }
    await sleep(intervalMs);
  }
  return { status: 'TIMEOUT' };
}

function toQuote(q, parts) {
  const a = q.amountBreakdown;
  const sel = q.shippingOptions.find((o) => o.selected) || q.shippingOptions[0];
  return {
    quoteId: q.id,
    merchant: parts[0].merchant,
    items: parts.map((p) => ({ name: p.name, qty: p.qty || 1, image: p.image, price: p.price })),
    shipping: sel ? { name: sel.name, amount: sel.price.amount } : null,
    shippingOptions: q.shippingOptions.map((o) => ({ id: o.id, name: o.name, amount: o.price.amount, selected: o.selected })),
    subtotal: a.itemsSubtotal.amount,
    tax: a.tax?.amount?.amount ?? 0,
    total: a.finalAmount.amount,
    currency: a.finalAmount.currency,
    expiresAt: q.expiresAt,
  };
}
