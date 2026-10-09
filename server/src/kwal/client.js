// Kwal (Payward) participant API: an onchain USDC vault on Ink Sepolia backs a
// sandbox card, so the agent can pay from the factory treasury without a
// per-charge approval page. Routes from github.com/payward/kwal-skill.
//   status(), funding(requiredUsdc?), products(query), variant(productId, optionIds),
//   quote(lines), selectShipping(id, optionId), pay(quoteId) → payment, readPayment(id), waitPayment(id)
// The session token comes from the Kwal skill's credentials file (outside the repo).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

const CRED_FILE = process.env.PWS_CREDENTIALS_FILE || path.join(os.homedir(), '.config/pws/agent-payment/credentials.json');

function session() {
  try {
    const c = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    if (c.expires_at && c.expires_at * 1000 < Date.now()) return null;
    return c;
  } catch {
    return null;
  }
}

export const kwalEnabled = () => Boolean(session()) && process.env.KWAL !== '0';

// Errors come back as problem+json: { type, status, title: 'ParticipantBadRequest', detail?, data, source }.
export class KwalError extends Error {
  constructor(status, body) {
    const err = typeof body?.error === 'object' ? body.error : null;
    super(body?.message || body?.detail || err?.message || body?.title || (typeof body?.error === 'string' ? body.error : '') || `Kwal HTTP ${status}`);
    this.status = status;
    this.code = body?.code || err?.code || body?.title || (typeof body?.error === 'string' ? body.error : '') || `HTTP_${status}`;
  }
}

/** 'PARTICIPANT_SETUP_STATE_READY' → 'ready', 'PAYMENT_STATE_COMPLETED' → 'completed', 'completed' → 'completed'. */
export function kwalState(state) {
  if (!state) return null;
  const s = String(state).toLowerCase();
  const i = s.lastIndexOf('state_');
  return i >= 0 ? s.slice(i + 6) : s;
}

async function call(method, route, body) {
  const s = session();
  if (!s) throw new KwalError(401, { message: 'No Kwal session (run the Kwal skill register + setup)' });
  const res = await fetch(s.service_url + route, {
    method,
    headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { message: text.slice(0, 200) };
  }
  if (!res.ok) throw new KwalError(res.status, json);
  return json;
}

/**
 * Kwal money → number. Accepts 1.2, '1.2', { minorUnits: '1200000', decimals: 6 },
 * { amount: '1.20' } or { amount: { minorUnits, decimals } }. null if unknown.
 */
export function kwalAmount(x) {
  if (x === null || x === undefined || x === '') return null;
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x === 'string') return Number.isFinite(Number(x)) ? Number(x) : null;
  if (typeof x !== 'object') return null;
  if (x.minorUnits !== undefined) {
    const decimals = Number.isFinite(Number(x.decimals)) ? Number(x.decimals) : /usdc/i.test(x.currency || 'USDC') ? 6 : 2;
    const n = Number(x.minorUnits) / 10 ** decimals;
    return Number.isFinite(n) ? n : null;
  }
  if (x.amount !== undefined) return kwalAmount(x.amount);
  if (x.value !== undefined) return kwalAmount(x.value);
  return null;
}

const P = '/kwal/participant/v1';
const minor = (usdc) => Math.round(usdc * 1e6);

export const kwal = {
  status: () => call('GET', `${P}/status`),
  funding: (requiredUsdc) => call('GET', `${P}/funding${requiredUsdc ? `?requiredMinorUnits=${minor(requiredUsdc)}` : ''}`),
  products: (query, limit = 10) => call('GET', `${P}/products?${new URLSearchParams({ query, limit: String(limit) })}`),
  // Resolve a product (+ chosen options) to a purchasable variant.
  variant: (productId, optionIds = []) => call('POST', `${P}/products/${encodeURIComponent(productId)}/variant`, { optionIds }),

  // lines: [{ variantId, quantity }]
  quote: (lines) =>
    call('POST', `${P}/quotes`, { email: config.buyerEmail, lines, shippingAddress: config.shippingAddress }),
  readQuote: (quoteId) => call('GET', `${P}/quotes/${quoteId}`),
  selectShipping: (quoteId, shippingOptionId) => call('POST', `${P}/quotes/${quoteId}/shipping`, { shippingOptionId }),

  // The client picks the payment id (idempotency key); it is echoed back on the result.
  async pay(quoteId) {
    const paymentId = `pay_${randomUUID().replace(/-/g, '')}`;
    const res = await call('POST', `${P}/payments`, { paymentId, quoteId });
    return { paymentId, ...res };
  },
  readPayment: (paymentId) => call('GET', `${P}/payments/${paymentId}`),

  /** Poll until the vault-backed card spend completes or is declined. */
  async waitPayment(paymentId, { timeoutMs = 120_000, signal } = {}) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const p = await kwal.readPayment(paymentId);
      if (['completed', 'declined', 'error', 'failed', 'requires_action'].includes(kwalState(p.state))) return p;
      if (Date.now() > until || signal?.aborted) return p;
      await new Promise((r) => setTimeout(r, 2500));
    }
  },
};
