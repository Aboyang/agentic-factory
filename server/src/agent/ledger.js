// Manager ledger: every purchase, payout, approval, block and agent decision,
// kept across scenarios and server restarts (server/.cache/ledger.json).
// Built by watching the events the server already emits (events.js onEmit), so
// the agent pipeline doesn't know it exists. Shape: LEDGER in shared/contract.js.
//
//   startLedger()   load the file and start listening (idempotent)
//   getLedger({ limit })  → { entries (newest last), totals }
//   clearLedger()   manager reset

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENTS, MACHINES } from '../../../shared/contract.js';
import { config } from '../config.js';
import { emit, onEmit } from '../events.js';
import { sim } from '../sim/engine.js';
import { TECHNICIANS } from './technicians.js';

const MAX_ENTRIES = 1000;
const MAX_REMEMBERED = 200; // incidents whose context (quote, verdict…) we keep in memory
const WRITE_DELAY_MS = 1000;
const FILE = fileURLToPath(new URL('../../.cache/ledger.json', import.meta.url));

let entries = [];
let seq = 0;
let started = false;
let writeTimer = null;
const memory = new Map(); // incidentId → { machineId, title, kind, part, chosen, quote, verdict }

export function startLedger() {
  if (started) return;
  started = true;
  load();
  onEmit(observe);
}

export function getLedger({ limit } = {}) {
  const list = limit ? entries.slice(-limit) : entries;
  return { entries: list.map((e) => ({ ...e })), totals: totals() };
}

export function clearLedger() {
  entries = [];
  memory.clear();
  persist();
  return getLedger();
}

// ─── Event → entry ───────────────────────────────────────────────────────────
function observe(evt) {
  if (!evt || evt.type === EVENTS.LEDGER_ENTRY) return; // never react to our own output
  const { type, incidentId, data = {} } = evt;
  const mem = incidentId ? remember(incidentId) : {};

  switch (type) {
    case EVENTS.INCIDENT_CREATED: {
      const inc = data.incident || {};
      Object.assign(mem, { machineId: inc.machineId, title: inc.title, kind: inc.kind });
      return add(incidentId, {
        type: 'incident',
        title: inc.title || `${machineName(inc.machineId)} incident`,
        detail: inc.kind === 'predictive'
          ? 'Predictive maintenance: a part is wearing out'
          : `Breakdown${inc.codes?.length ? `: ${inc.codes.join(', ')}` : ''}`,
      });
    }

    case EVENTS.AGENT_DIAGNOSIS: {
      const pct = Number.isFinite(data.confidence) ? Math.round(data.confidence * 100) : null;
      mem.part = data.component || mem.part;
      const evidence = (data.evidence || []).filter(Boolean).join('; ');
      return add(incidentId, {
        type: 'decision',
        title: `Diagnosed the ${data.component || 'part'}${pct === null ? '' : ` (${pct}% sure)`}${data.attempt > 1 ? `, attempt ${data.attempt}` : ''}`,
        detail: [data.explanation, evidence && `Evidence: ${evidence}`].filter(Boolean).join(' ') || null,
        part: data.component || null,
        confidence: num(data.confidence),
        provider: data.provider || null,
      });
    }

    case EVENTS.CATALOG_RESULTS:
      mem.part = data.part?.name || mem.part;
      mem.qty = data.part?.qty || mem.qty;
      mem.chosen = data.chosen || null;
      return;

    case EVENTS.PROCUREMENT_QUOTE:
      mem.quote = data.quote || null;
      return;

    case EVENTS.POLICY_DECISION:
      mem.verdict = data.action;
      if (data.action !== 'BLOCK') return;
      return add(incidentId, {
        type: 'blocked',
        title: `Blocked ${money(data.total)}${merchantOf(mem) ? ` at ${merchantOf(mem)}` : ''}${mem.part ? ` for the ${mem.part}` : ''}`,
        detail: (data.reasons || []).join('; ') || null,
        amount: num(data.total),
        currency: mem.quote?.currency || 'USD',
        approval: 'blocked',
        merchant: merchantOf(mem),
        part: mem.part || null,
        qty: qtyOf(mem),
        confidence: num(data.confidence),
      });

    case EVENTS.APPROVAL_REQUIRED:
      return add(incidentId, {
        type: 'approval',
        title: `Asked the manager to approve ${money(data.total)}${merchantOf(mem) ? ` at ${merchantOf(mem)}` : ''}`,
        detail: (data.reasons || []).join('; ') || null,
        amount: num(data.total),
        currency: mem.quote?.currency || 'USD',
        approval: 'manager',
        merchant: merchantOf(mem),
        part: mem.part || null,
        qty: qtyOf(mem),
        simulated: Boolean(data.demo || config.mockReap),
      });

    case EVENTS.CHECKOUT_COMPLETED: {
      const item = mem.quote?.items?.[0];
      const merchant = data.merchant || merchantOf(mem);
      const qty = qtyOf(mem);
      const rail = data.rail || 'reap';
      return add(incidentId, {
        type: 'purchase',
        title: `Bought ${qty ? `${qty}× ` : ''}${short(item?.name || mem.chosen?.name || mem.part || 'part')}${merchant ? ` from ${merchant}` : ''}`,
        detail: mem.verdict === 'AUTO' ? 'Auto-approved within policy' : 'Approved by the manager',
        amount: num(data.finalAmount?.amount ?? mem.quote?.total),
        currency: data.finalAmount?.currency || (rail === 'kwal' ? 'USDC' : 'USD'),
        rail,
        approval: mem.verdict === 'AUTO' ? 'auto' : 'manager',
        orderId: data.orderId || null,
        merchant: merchant || null,
        part: mem.part || null,
        qty,
        simulated: Boolean(data.demo || (rail === 'reap' && config.mockReap)),
      });
    }

    case EVENTS.CHECKOUT_FAILED:
      return add(incidentId, {
        type: 'failed',
        title: `Checkout failed${merchantOf(mem) ? ` at ${merchantOf(mem)}` : ''}: ${data.reason || data.status || 'unknown'}`,
        detail: data.status ? `Status ${data.status}` : null,
        amount: num(mem.quote?.total),
        currency: mem.quote?.currency || 'USD',
        approval: mem.verdict === 'AUTO' ? 'auto' : 'manager',
        merchant: merchantOf(mem),
        part: mem.part || null,
        qty: qtyOf(mem),
        simulated: Boolean(data.demo || config.mockReap),
      });

    case EVENTS.ESCROW_RELEASED: {
      const e = data.escrow || {};
      const name = e.technicianName || TECHNICIANS.find((t) => t.id === e.technicianId)?.name || 'the technician';
      const onchain = Boolean(e.onchain);
      const usdc = `${usdcText(e.amountUsdc)} USDC`;
      return add(incidentId, {
        type: 'payout',
        title: onchain ? `Paid ${name} ${usdc} onchain` : `Paid ${name} ${usdc} (simulated)`,
        detail: [
          `${money(e.amount)} job`,
          onchain ? `Ink Sepolia testnet${e.scale ? `, scaled ×${e.scale}` : ''}` : e.simulatedReason || 'simulated payout',
          e.confirmed === false ? 'awaiting confirmation' : null,
        ].filter(Boolean).join(' · '),
        amount: num(e.amountUsdc),
        currency: 'USDC',
        jobUsd: num(e.amount),
        technician: name,
        to: e.to || null,
        onchain,
        txHash: e.txHash || null,
        txUrl: e.txUrl || null,
        simulated: e.simulated ?? !onchain,
      });
    }

    case EVENTS.INCIDENT_RESOLVED: {
      const s = data.summary || {};
      const machine = machineName(mem.machineId);
      const planned = s.kind === 'predictive';
      const attempts = s.attempts || 0;
      return add(incidentId, {
        type: 'resolved',
        title: s.component
          ? `${machine} ${planned ? 'serviced' : 'back up'}: ${s.component} replaced`
          : `${machine} running again`,
        detail: `Parts ${money(s.spent)} + labor ${money(s.labor)}, ${attempts} attempt${attempts === 1 ? '' : 's'}, ` +
          `${num(s.downtimeMin) ?? 0} min stopped, ${num(s.durationMin) ?? 0} min to fix`,
        amount: num(s.totalCost),
        currency: 'USD',
        orderId: s.orderId || null,
        part: s.component || null,
        minutes: num(s.durationMin),
        downtimeMin: num(s.downtimeMin),
        attempts,
      });
    }

    case EVENTS.INCIDENT_ERROR:
      // Blocks and failed checkouts already have their own line.
      if (data.code === 'BLOCKED' || String(data.code || '').startsWith('CHECKOUT_')) return;
      return add(incidentId, {
        type: 'failed',
        title: `Agent stopped: ${data.message || data.code || 'error'}`,
        detail: data.code ? `Code ${data.code}` : null,
        part: mem.part || null,
      });

    default:
  }
}

function add(incidentId, fields) {
  const snap = safeSnapshot();
  const mem = incidentId ? memory.get(incidentId) : null;
  const entry = {
    id: `led_${Date.now().toString(36)}_${(seq++).toString(36)}`,
    at: new Date().toISOString(),
    t: snap?.t ?? null,
    clock: snap?.clock ?? null,
    preset: snap?.preset ? { id: snap.preset.id, name: snap.preset.name } : null,
    incidentId: incidentId || null,
    machineId: mem?.machineId || null,
    title: '',
    detail: null,
    ...fields,
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  persist();
  emit(EVENTS.LEDGER_ENTRY, { entry: { ...entry } }, incidentId);
  return entry;
}

function remember(incidentId) {
  let mem = memory.get(incidentId);
  if (!mem) {
    mem = {};
    memory.set(incidentId, mem);
    if (memory.size > MAX_REMEMBERED) memory.delete(memory.keys().next().value);
  }
  return mem;
}

// ─── Totals ──────────────────────────────────────────────────────────────────
function totals() {
  const t = {
    partsSpend: 0, laborUsd: 0, laborUsdc: 0, orders: 0, autoApproved: 0, managerApproved: 0,
    blocked: 0, failed: 0, incidents: 0, resolved: 0, avgMinutesToFix: null,
  };
  let fixMinutes = 0;
  let fixCount = 0;
  for (const e of entries) {
    switch (e.type) {
      case 'purchase':
        t.orders += 1;
        t.partsSpend += Number(e.amount) || 0;
        if (e.approval === 'auto') t.autoApproved += 1;
        else t.managerApproved += 1;
        break;
      case 'payout':
        t.laborUsd += Number(e.jobUsd) || 0;
        t.laborUsdc += Number(e.amount) || 0;
        break;
      case 'blocked':
        t.blocked += 1;
        break;
      case 'failed':
        t.failed += 1;
        break;
      case 'incident':
        t.incidents += 1;
        break;
      case 'resolved':
        t.resolved += 1;
        if (Number.isFinite(e.minutes)) {
          fixMinutes += e.minutes;
          fixCount += 1;
        }
        break;
      default:
    }
  }
  t.partsSpend = round(t.partsSpend, 2);
  t.laborUsd = round(t.laborUsd, 2);
  t.laborUsdc = round(t.laborUsdc, 6);
  t.avgMinutesToFix = fixCount ? round(fixMinutes / fixCount, 1) : null;
  return t;
}

// ─── Persistence ─────────────────────────────────────────────────────────────
function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const list = Array.isArray(saved) ? saved : saved?.entries;
    if (Array.isArray(list)) entries = list.filter((e) => e && e.id && e.type).slice(-MAX_ENTRIES);
    console.log(`[ledger] loaded ${entries.length} entries`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[ledger] could not read ${FILE}: ${err.message}`);
  }
}

function persist() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const body = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), entries });
    const tmp = `${FILE}.tmp`;
    fs.promises.mkdir(path.dirname(FILE), { recursive: true })
      .then(() => fs.promises.writeFile(tmp, body))
      .then(() => fs.promises.rename(tmp, FILE))
      .catch((err) => console.warn(`[ledger] could not save: ${err.message}`));
  }, WRITE_DELAY_MS);
  writeTimer.unref?.();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function safeSnapshot() {
  try {
    return sim.snapshot();
  } catch {
    return null;
  }
}

const merchantOf = (mem) => mem.quote?.merchant || mem.chosen?.merchant || null;
const qtyOf = (mem) => mem.quote?.items?.[0]?.qty || mem.qty || null;
const machineName = (id) => MACHINES.find((m) => m.id === id)?.name || 'Machine';
const num = (n) => (n === null || n === undefined || n === '' || !Number.isFinite(Number(n)) ? null : Number(n));
const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const usdcText = (n) => {
  const v = Number(n) || 0;
  return v >= 0.1 || v === 0 ? v.toFixed(2) : String(round(v, 6));
};
const short = (s, n = 48) => (s && s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
