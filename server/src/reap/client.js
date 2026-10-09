// Thin wrapper over the Reap Agentic API. One function per endpoint.
// Docs: https://docs.reap.global/agentic-payments/one-time-purchases

import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

export class ReapError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Reap HTTP ${status}`);
    this.status = status;
    this.code = body?.error?.code || 'REAP_ERROR';
    this.detail = body?.error?.detail;
  }
}

async function call(method, path, body, { idempotent = false, headers = {} } = {}) {
  const res = await fetch(config.reap.baseUrl + path, {
    method,
    headers: {
      Authorization: `Bearer ${config.reap.apiKey}`,
      'Reap-Version': config.reap.version,
      'Content-Type': 'application/json',
      ...(idempotent ? { 'Idempotency-Key': randomUUID() } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ReapError(res.status, json);
  return json;
}

export const reapLive = {
  search: (query, { limit = 10, country = 'US', currency = 'USD', filters } = {}) =>
    call('POST', '/agentic/products/search', {
      query,
      context: { country, currency },
      ...(filters ? { filters } : {}),
      pagination: { limit },
    }),

  details: (productIds) => call('POST', '/agentic/products/details', { productIds }),

  resolveVariant: (productId, optionIds) =>
    call('POST', '/agentic/products/variant', { productId, optionIds }),

  // items: [{ variantId, quantity }]  (all from ONE merchant)
  createQuote: (items) =>
    call(
      'POST',
      '/agentic/quotes',
      { items, email: config.buyerEmail, shippingAddress: config.shippingAddress },
      { idempotent: true },
    ),

  getQuote: (quoteId) => call('GET', `/agentic/quotes/${quoteId}`),

  selectShipping: (quoteId, shippingOptionId) =>
    call('POST', `/agentic/quotes/${quoteId}/shipping-option`, { shippingOptionId }),

  // simulate: 'COMPLETED' sends X-Simulate-Checkout (sandbox only).
  createCheckout: (quoteId, { simulate } = {}) =>
    call(
      'POST',
      '/agentic/checkouts',
      {
        quoteId,
        enrollmentId: config.reap.enrollmentId,
        presentation: { type: 'REDIRECT', returnUrl: config.returnUrl },
      },
      { idempotent: true, headers: simulate ? { 'X-Simulate-Checkout': simulate } : {} },
    ),

  getCheckout: (checkoutId) => call('GET', `/agentic/checkouts/${checkoutId}`),

  createEnrollment: (ownerId, email) =>
    call(
      'POST',
      '/agentic/enrollments',
      {
        source: 'EXTERNAL',
        owner: { type: 'CLIENT_REFERENCE', id: ownerId, email },
        presentation: { type: 'REDIRECT', returnUrl: config.returnUrl },
      },
      { idempotent: true },
    ),

  getEnrollment: (id) => call('GET', `/agentic/enrollments/${id}`),
};
