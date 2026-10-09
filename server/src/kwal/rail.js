// Kwal vault rail: pay for a part straight from the factory's onchain USDC vault
// (the vault backs a sandbox card, so there is no per-charge approval page).
// The orchestrator only uses it for orders the policy already marked AUTO, and
// falls back to the Reap card on ANY error thrown from here.
//
//   vaultCheckout({ query, listingName, merchant, qty, express, approve, signal })
//     products(query) → best title match → variant → quote → (shipping) → pay → wait
//     → { rail: 'kwal', paymentId, orderId, finalAmount: { amount, currency: 'USDC' }, product, quoteId }
//   approve(total, merchant) → boolean   re-checks the policy on Kwal's own price and store
//   kwalCooldown()                       the last failure while the rail is resting, else null

import { config } from '../config.js';
import { kwal, kwalEnabled, kwalState, kwalAmount, KwalError } from './client.js';

// After a failure, skip the rail for a while instead of paying ~2 s per call
// to rediscover it (Kwal's variant/quote endpoints are currently returning 400).
const COOLDOWN_MS = Number.isFinite(Number(process.env.KWAL_RETRY_MS)) ? Number(process.env.KWAL_RETRY_MS) : 120_000;
const PAYMENT_TIMEOUT_MS = 90_000;

let lastFailure = null; // { code, at }

/** The vault rail is on: a Kwal session exists, KWAL!=0, and we're not in offline (MOCK_REAP) mode. */
export const kwalRailEnabled = () => !config.mockReap && kwalEnabled();

export function kwalCooldown() {
  if (lastFailure && Date.now() - lastFailure.at < COOLDOWN_MS) return lastFailure;
  return null;
}

export async function vaultCheckout(opts) {
  try {
    const result = await checkout(opts);
    lastFailure = null;
    return result;
  } catch (err) {
    if (err?.code !== 'CANCELLED') lastFailure = { code: err?.code || err?.status || 'error', at: Date.now() };
    throw err;
  }
}

async function checkout({ query, listingName, merchant, qty = 1, express = false, approve = () => true, signal } = {}) {
  const stopIfCancelled = () => {
    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
  };

  // 1. Same part in Kwal's catalog: the product whose title best matches the Reap listing.
  const found = await kwal.products(query || listingName, 10);
  const products = (found?.products || []).filter((p) => p?.productId);
  if (!products.length) throw fail('NO_PRODUCT', `Kwal has no listing for "${query}"`);
  const product = bestMatch(products, listingName, merchant);
  stopIfCancelled();

  // 2. Product → purchasable variant.
  const v = await kwal.variant(product.productId, []);
  const variantId = v?.variantId || v?.variant?.variantId || v?.variant?.id || v?.id;
  if (!variantId) throw fail('NO_VARIANT', `Kwal returned no variant for ${product.title}`);
  stopIfCancelled();

  // 3. Quote, then shipping if the quote asks for it.
  let q = await kwal.quote([{ variantId, quantity: qty }]);
  const quoteId = q?.quoteId || q?.id;
  if (!quoteId) throw fail('NO_QUOTE', 'Kwal returned no quote id');
  const options = shippingOptions(q);
  const selected = q?.selectedShippingOptionId || q?.shipping?.selectedOptionId || options.find((o) => o.selected)?.id;
  if (options.length && (!selected || /shipping/.test(kwalState(q?.state) || ''))) {
    const pick = (express && options.find((o) => /express|overnight|2.?day|priority|next/i.test(o.name))) || options[0];
    const updated = await kwal.selectShipping(quoteId, pick.id);
    q = updated?.quoteId || updated?.id ? updated : await kwal.readQuote(quoteId);
  }
  stopIfCancelled();

  // 4. Re-check the policy on Kwal's own total and store before any money moves.
  const total = quoteTotal(q);
  if (!(total > 0)) throw fail('NO_TOTAL', 'Kwal quote has no total');
  const store = product.merchant || merchant;
  if (!approve(total, store)) throw fail('OUTSIDE_POLICY', `Kwal price ${total.toFixed(2)} USDC at ${store} is outside the auto-approve policy`);

  // 5. Enough USDC in the vault?
  const funding = await kwal.funding(total).catch(() => null);
  const available = kwalAmount(funding?.available);
  if (available !== null && available < total) throw fail('VAULT_LOW', `Vault holds ${available.toFixed(2)} USDC, needs ${total.toFixed(2)}`);
  stopIfCancelled();

  // 6. Pay from the vault and wait for the card spend to settle.
  const payment = await kwal.pay(quoteId);
  const paymentId = payment.paymentId;
  const final = await kwal.waitPayment(paymentId, { timeoutMs: PAYMENT_TIMEOUT_MS });
  const state = kwalState(final?.state) || 'unknown';
  if (state !== 'completed') {
    throw fail(`PAYMENT_${state.toUpperCase()}`, `Kwal payment ${paymentId} ended ${state}`, { paymentId, maybePaid: !['declined', 'error', 'failed'].includes(state) });
  }

  const amount = kwalAmount(final.amount) ?? kwalAmount(final.total) ?? total;
  return {
    rail: 'kwal',
    paymentId,
    orderId: final.orderId || payment.orderId || paymentId,
    finalAmount: { amount: Math.round(amount * 100) / 100, currency: 'USDC' },
    product: { id: product.productId, title: product.title, merchant: store },
    quoteId,
  };
}

function fail(code, message, extra = {}) {
  return Object.assign(new KwalError(400, { code, message }), extra);
}

// Token overlap between the Reap listing name and each Kwal title; same store breaks ties.
function bestMatch(products, listingName, merchant) {
  const want = tokens(listingName);
  let best = products[0];
  let bestScore = -1;
  for (const p of products) {
    const have = tokens(p.title);
    const shared = [...want].filter((t) => have.has(t)).length;
    const score = (want.size ? shared / Math.max(want.size, have.size) : 0) + (merchant && sameStore(p.merchant, merchant) ? 0.15 : 0);
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}

function tokens(s = '') {
  return new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1));
}

const sameStore = (a = '', b = '') => a.split(' | ')[0].trim().toLowerCase() === b.split(' | ')[0].trim().toLowerCase();

function shippingOptions(q) {
  const list = q?.shippingOptions || q?.shipping?.options || [];
  return list
    .map((o) => ({ id: o.shippingOptionId || o.id, name: o.name || o.title || '', selected: Boolean(o.selected) }))
    .filter((o) => o.id);
}

function quoteTotal(q) {
  const candidates = [q?.total, q?.totalAmount, q?.amount, q?.totals?.total, q?.amounts?.total, q?.amountBreakdown?.finalAmount, q?.price];
  for (const c of candidates) {
    const n = kwalAmount(c);
    if (n !== null) return n;
  }
  return null;
}
