// Live spare-parts catalog built from Reap product search.
//
//   searchOffers(query, { merchant })       → normalized, cached offers
//   findReplacement(component, opts)        → { chosen, offers, probabilities, ... }
//   warmCatalog(onUpdate)                   → best live offer for every part on every machine
//   getCatalog()                            → snapshot for the game
//
// Search results are cached in memory (10 min) and on disk (server/.cache), so
// repeated incidents are fast and the game still works offline (MOCK_REAP=1).

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MACHINES } from '../../../shared/contract.js';
import { config } from '../config.js';
import { reap } from '../reap/index.js';
import { reapMock } from '../reap/mock.js';
import { decide } from '../agent/decide.js';
import { FALLBACK_OFFERS } from './fallback.js';

const TTL_MS = 10 * 60_000;
const CACHE_FILE = fileURLToPath(new URL('../../.cache/catalog.json', import.meta.url));

// ─── Cache ───────────────────────────────────────────────────────────────────
const memory = new Map(); // key → { at, offers }
let disk = loadDisk();

function loadDisk() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

let saveTimer;
function saveDisk() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(new URL('../../.cache/', import.meta.url), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(disk));
  }, 500);
}

// ─── Search ──────────────────────────────────────────────────────────────────
export const cleanMerchant = (name = '') => name.split(' | ')[0].trim();

function toOffer(p) {
  const v = p.previewVariant || {};
  return {
    productId: p.id,
    variantId: v.id,
    name: p.name,
    merchant: cleanMerchant(p.merchant?.name),
    price: v.price?.amount ?? p.priceRange?.min?.amount,
    currency: v.price?.currency ?? p.priceRange?.min?.currency ?? 'USD',
    image: p.imageUrl,
    available: p.available !== false && v.available !== false,
  };
}

export async function searchOffers(query, { merchant, limit = 20 } = {}) {
  const key = `${query.toLowerCase()}|${merchant || ''}`;
  const hit = memory.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.offers;

  if (config.mockReap) return offlineSearch(query, merchant);

  try {
    const res = await reap.search(query, {
      limit,
      filters: { availability: 'AVAILABLE_ONLY' },
      ...(merchant ? { merchantPreference: { mode: 'ONLY', merchantName: merchant } } : {}),
    });
    const offers = (res.products || []).map(toOffer).filter((o) => o.variantId);
    memory.set(key, { at: Date.now(), offers });
    disk[key] = offers;
    saveDisk();
    return offers;
  } catch (err) {
    console.warn(`[catalog] search "${query}" failed (${err.code || err.message}); using cache`);
    return disk[key] || offlineSearch(query, merchant);
  }
}

// Offline: search everything we've ever cached plus the verified fallbacks.
function offlineSearch(query, merchant) {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const all = [...Object.values(disk).flat(), ...Object.values(FALLBACK_OFFERS).map((o) => ({ ...o, currency: 'USD', available: true }))];
  const seen = new Set();
  const offers = all.filter((o) => {
    if (seen.has(o.variantId)) return false;
    seen.add(o.variantId);
    if (merchant && o.merchant !== merchant) return false;
    const n = o.name.toLowerCase();
    return words.some((w) => n.includes(w));
  });
  reapMock.registerOffers(offers);
  return offers;
}

// ─── Relevance ───────────────────────────────────────────────────────────────
function matchesSpec(offer, component) {
  const n = offer.name.toLowerCase();
  return component.keywords.every((group) => group.some((w) => n.includes(w)));
}

function relevance(offer, component, trusted) {
  const n = offer.name.toLowerCase();
  const tokens = component.query.toLowerCase().split(/\s+/);
  const overlap = tokens.filter((t) => n.includes(t)).length / tokens.length;
  const trustBonus = trusted.includes(offer.merchant) ? 0.4 : 0;
  const pricePenalty = (offer.price / component.maxPrice) * 0.15;
  return overlap + trustBonus - pricePenalty;
}

/**
 * Find a live replacement for a part.
 * @param component  a part from MACHINES[].components
 * @param opts.trusted   merchant names the policy trusts (ranked first)
 * @param opts.merchant  restrict to one merchant (keeps multi-part orders in one cart)
 * @param opts.useModel  let the decision model choose among the shortlist (default true)
 * @param opts.context   extra context for the model (machine, symptoms)
 */
export async function findReplacement(component, { trusted = [], merchant, useModel = true, context = {} } = {}) {
  const queries = [component.query, component.name];
  let pool = [];
  let query = component.query;
  for (const q of queries) {
    query = q;
    pool = dedupe([...pool, ...(await searchOffers(q, { merchant }))]);
    if (shortlistOf(pool, component, trusted).length >= 3) break;
  }

  const shortlist = shortlistOf(pool, component, trusted);
  if (!shortlist.length) {
    const fb = FALLBACK_OFFERS[component.id];
    if (!fb) return { component, query, offers: [], chosen: null, source: 'none' };
    const offer = { ...fb, currency: 'USD', available: true, qty: component.qty };
    reapMock.registerOffers([offer]);
    return { component, query, offers: [offer], chosen: offer, probabilities: { [offer.productId]: 1 }, confidence: 1, provider: 'fallback', source: 'fallback' };
  }

  let idx = 0;
  let decision = { probabilities: { option_1: 1 }, confidence: 1, provider: 'heuristic' };
  if (useModel && shortlist.length > 1) {
    const options = shortlist.map((_, i) => `option_${i + 1}`);
    decision = await decide({
      kind: 'choice',
      question: `Which listing is the right replacement for the "${component.name}" (spec: ${component.query})? Prefer exact matches from trusted suppliers at a sensible price.`,
      options,
      context: {
        ...context,
        part: component.name,
        quantityNeeded: component.qty,
        listings: shortlist.map((o, i) => ({ id: options[i], name: o.name, merchant: o.merchant, priceUSD: o.price, trustedSupplier: trusted.includes(o.merchant) })),
        hint: 'option_1',
      },
    });
    idx = Math.max(0, options.indexOf(decision.answer));
  }

  const probabilities = Object.fromEntries(
    shortlist.map((o, i) => [o.productId, decision.probabilities[`option_${i + 1}`] ?? 0]),
  );
  const offers = shortlist.map((o) => ({ ...o, qty: component.qty }));
  return {
    component,
    query,
    offers,
    chosen: offers[idx],
    probabilities,
    confidence: decision.confidence,
    provider: decision.provider,
    source: config.mockReap ? 'offline' : 'live',
  };
}

function shortlistOf(pool, component, trusted) {
  return pool
    .filter((o) => o.available && o.price <= component.maxPrice && matchesSpec(o, component))
    .sort((a, b) => relevance(b, component, trusted) - relevance(a, component, trusted))
    .slice(0, 5);
}

function dedupe(offers) {
  const seen = new Set();
  return offers.filter((o) => !seen.has(o.variantId) && seen.add(o.variantId));
}

// ─── Warm catalog: best live offer for every part ───────────────────────────
const state = { warming: false, updatedAt: null, machines: {} };

export function getCatalog() {
  return {
    warming: state.warming,
    updatedAt: state.updatedAt,
    machines: MACHINES.map((m) => ({
      id: m.id,
      name: m.name,
      components: m.components.map((c) => ({ id: c.id, name: c.name, qty: c.qty, ...(state.machines[m.id]?.[c.id] || { status: 'pending' }) })),
    })),
  };
}

export async function warmCatalog({ trusted = [], onUpdate = () => {} } = {}) {
  if (state.warming) return;
  state.warming = true;
  onUpdate(getCatalog());
  try {
    for (const m of MACHINES) {
      state.machines[m.id] ||= {};
      await Promise.all(
        m.components.map(async (c) => {
          const r = await findReplacement(c, { trusted, useModel: false });
          state.machines[m.id][c.id] = {
            status: r.chosen ? 'ok' : 'none',
            best: r.chosen,
            optionCount: r.offers.length,
            source: r.source,
          };
        }),
      );
      state.updatedAt = new Date().toISOString();
      onUpdate(getCatalog());
    }
  } finally {
    state.warming = false;
    onUpdate(getCatalog());
  }
}
