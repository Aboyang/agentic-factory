// The agent. A monitor watches the simulation and opens incidents; each incident
// runs the pipeline:
//   diagnose (telemetry + plant log + prior) → search live catalog → quote → policy
//   → pay → ship → repair → verify → pay the technician → re-diagnose if the fault is still there
// Parts: AUTO orders try the Kwal USDC vault first, then the Reap card (escalated
// orders always go to Reap's approval page). Labor: USDC onchain (Ink Sepolia).
// Ground truth lives in the sim. The agent only sees what a real plant shows:
// signals and log lines. Every step emits an event the game animates and writes
// an AGENT line to the plant log.

import { randomUUID } from 'node:crypto';
import { MACHINES, EVENTS } from '../../../shared/contract.js';
import { config } from '../config.js';
import { emit } from '../events.js';
import { sim, formatReading } from '../sim/engine.js';
import { scoreComponents } from '../sim/diagnostics.js';
import { decide, say } from './decide.js';
import { evaluate, recordSpend, getPolicy } from './policy.js';
import { TECHNICIANS, lockEscrow, releaseEscrow, confirmPayout, PAYOUT_NOTE, usdcText } from './technicians.js';
import { findReplacement } from '../catalog/catalog.js';
import { quoteParts, startCheckout } from '../reap/purchase.js';
import { reap } from '../reap/index.js';
import { vaultCheckout, kwalRailEnabled, kwalCooldown } from '../kwal/rail.js';
import { refreshAfterPayout } from '../chain/treasury.js';

const MAX_ATTEMPTS = 3;
const PREDICTIVE_AFTER_MIN = 3; // a part must WARN this long before the agent acts on it
const MINUTES = { express: 3, standard: 6, travel: 2, repair: 4, verify: 2 }; // game minutes
const APPROVAL_TIMEOUT_MS = 10 * 60_000; // real time: the manager is a real person
const POLL_MS = config.mockReap ? 700 : 2500;
const QUOTE_RETRY_CODES = new Set(['QUOTE_UNFULFILLABLE', 'CARD_PAYMENT_UNAVAILABLE', 'AGENTIC_REQUEST_REJECTED', 'CHECKOUT_URL_INVALID']);
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'EXPIRED']);
const ACTIVE = new Set(['open', 'blocked', 'error']); // one of these per machine at most

export const incidents = new Map(); // id → incident (public, sent to the game)
const runtime = new Map(); // id → { controller, ruledOut, maintenance, lastOrder, labor, overtaken }
const merchantsSeen = new Set();
const demoApprovals = new Map(); // judge mode: checkoutId → resolve(approved: boolean)

class IncidentStop extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

class Cancelled extends Error {
  constructor() {
    super('cancelled');
    this.code = 'CANCELLED';
  }
}

// ─── Monitor ─────────────────────────────────────────────────────────────────
let monitoring = false;
let lastTickT = null;

export function startMonitor() {
  if (monitoring) return;
  monitoring = true;
  sim.on('machine.down', onMachineDown);
  sim.on('tick', onTick);
  sim.on('minute', onMinute); // every game minute, so a predictive job opens on time at 8×
  sim.on('preset', () => resetIncidents()); // safety net: a new shift never inherits incidents
  // One failure at a time: chaos and scripted failures wait until the open job is finished.
  sim.addBusyCheck?.(() => {
    for (const inc of incidents.values()) if (inc.status === 'open') return true;
    return false;
  });
}

function onMachineDown({ machineId, codes = [] } = {}) {
  try {
    const machine = machineById(machineId);
    if (!machine) return;
    const current = activeIncident(machineId);
    if (current?.status === 'open') {
      current.codes = [...new Set([...current.codes, ...codes])];
      const rt = runtime.get(current.id);
      const early = ['diagnosing', 'sourcing', 'quoting', 'approval', 'shipping'].includes(current.step);
      if (current.kind === 'predictive' && early && rt && !rt.overtaken) {
        rt.overtaken = true;
        agentLog(current, null, 'INC', `${machine.name} failed (${codes.join(', ') || 'stopped'}) before the planned swap. Repair already under way.`);
      }
      return;
    }
    // A predictive job stuck on the manager (blocked / error) is replaced by the breakdown.
    if (current) {
      agentLog(current, null, 'INC', `Planned job superseded: the ${machine.name} has now failed.`);
      cancel(current);
    }
    startIncident({ machineId, kind: 'breakdown', codes });
  } catch (err) {
    console.error('[monitor] machine.down:', err);
  }
}

function onTick(snap) {
  try {
    trackDowntime(snap);
  } catch (err) {
    console.error('[monitor] tick:', err);
  }
}

function onMinute() {
  try {
    if (getPolicy().predictiveMaintenance) checkWarnings();
  } catch (err) {
    console.error('[monitor] minute:', err);
  }
}

// Minutes each incident's machine spent not running (down or in maintenance).
function trackDowntime(snap) {
  const t = snap?.t;
  if (!Number.isFinite(t)) return;
  const dt = lastTickT === null || t < lastTickT ? 0 : t - lastTickT;
  lastTickT = t;
  if (!dt) return;
  for (const inc of incidents.values()) {
    if (!ACTIVE.has(inc.status)) continue;
    const status = snap.machines?.[inc.machineId]?.status;
    // An incident opened mid-step only counts the minutes since it opened.
    const span = Math.min(dt, Math.max(0, t - (inc.startedAt || 0)));
    if (span && status && status !== 'running') inc.downtimeMin = round1(inc.downtimeMin + span);
  }
}

// Predictive maintenance: a part on a RUNNING machine in WARN for ≥ 3 game-min.
function checkWarnings() {
  const byMachine = new Map();
  for (const w of sim.warnings() || []) {
    if (!(w.minutes >= PREDICTIVE_AFTER_MIN)) continue;
    if (sim.machineStatus(w.machineId) !== 'running') continue;
    if (!byMachine.has(w.machineId)) byMachine.set(w.machineId, []);
    byMachine.get(w.machineId).push(w);
  }
  for (const [machineId, warned] of byMachine) {
    if (activeIncident(machineId)) continue;
    startIncident({
      machineId,
      kind: 'predictive',
      componentIds: warned.map((w) => w.componentId),
      warnMinutes: Math.max(...warned.map((w) => w.minutes)),
    });
  }
}

// ─── Incidents ───────────────────────────────────────────────────────────────
export function listIncidents() {
  return [...incidents.values()].map((i) => ({ ...i }));
}

export function knownMerchants() {
  return [...merchantsSeen];
}

/** Opens an incident (the monitor calls this). Returns null if the machine already has one. */
export function startIncident({ machineId, kind = 'breakdown', componentIds = [], codes, warnMinutes } = {}) {
  const machine = machineById(machineId);
  if (!machine) throw new Error(`Unknown machine ${machineId}`);
  if (activeIncident(machineId)) return null;

  const telemetry = safeTelemetry(machineId);
  if (kind === 'breakdown') {
    codes = codes?.length ? codes : telemetry?.activeCodes || [];
    componentIds = machine.components.filter((c) => codes.includes(c.code)).map((c) => c.id);
  } else {
    componentIds = componentIds.filter((cid) => machine.components.some((c) => c.id === cid));
    codes = componentIds.map((cid) => warnCode(machine.components.find((c) => c.id === cid)));
  }

  const worst = kind === 'predictive' ? worstSignal(telemetry, componentIds) : null;
  const incident = {
    id: `inc_${randomUUID().slice(0, 6)}`,
    kind,
    machineId,
    title: kind === 'predictive' ? predictiveTitle(machine, componentIds, worst) : breakdownTitle(machine, codes),
    codes: [...codes],
    componentIds,
    status: 'open',
    step: 'diagnosing',
    attempts: 0,
    spent: 0,
    startedAt: gameNow(),
    endedAt: null,
    downtimeMin: 0,
    ruledOut: [],
    error: null,
  };
  incidents.set(incident.id, incident);
  runtime.set(incident.id, { controller: null, ruledOut: new Set(), maintenance: false, lastOrder: null, labor: 0, payouts: [], overtaken: false });
  emit(EVENTS.INCIDENT_CREATED, { incident: { ...incident } }, incident.id);

  if (kind === 'predictive') {
    const part = worst?.part.name || 'A part';
    const sig = worst ? ` (${signalText(worst.signal)})` : '';
    agentLog(incident, componentIds[0], 'PREDICT', `${part} in WARN for ${Math.round(warnMinutes || PREDICTIVE_AFTER_MIN)} min${sig}. Replacing it before it fails.`);
  } else {
    agentLog(incident, componentIds[0], 'INC', `Responding to ${codes.join(', ') || 'stop'} on the ${machine.name}.`);
  }
  launch(incident);
  return incident;
}

/** Re-run a failed or blocked incident (e.g. after the manager changes the policy). */
export function retryIncident(incidentId) {
  const incident = incidents.get(incidentId);
  if (!incident) throw new Error(`Unknown incident ${incidentId}`);
  if (incident.status !== 'error' && incident.status !== 'blocked') throw new Error(`Incident is ${incident.status}`);
  const machine = machineById(incident.machineId);
  const rt = runtime.get(incident.id);
  if (rt.ruledOut.size >= machine.components.length) {
    rt.ruledOut.clear();
    incident.ruledOut = [];
  }
  incident.status = 'open';
  incident.attempts = 0;
  incident.error = null;
  agentLog(incident, null, 'INC', `Retrying: ${incident.title}`);
  launch(incident);
  return { ...incident };
}

/** Abort every incident that isn't finished (called before a preset loads). */
export function cancelAll() {
  for (const incident of incidents.values()) {
    if (ACTIVE.has(incident.status)) cancel(incident);
  }
}

/** cancelAll() and forget them: a new shift starts with a clean board. */
export function resetIncidents() {
  cancelAll();
  incidents.clear();
  runtime.clear();
  lastTickT = null;
}

function cancel(incident) {
  const rt = runtime.get(incident.id);
  if (rt?.maintenance) setMaintenance(incident, false);
  rt?.controller?.abort();
  incident.status = 'cancelled';
  incident.endedAt = gameNow();
  emit(EVENTS.INCIDENT_CANCELLED, {}, incident.id);
}

function launch(incident) {
  const rt = runtime.get(incident.id);
  const controller = new AbortController();
  rt.controller = controller;
  holdClock(incident, true); // game time stands still while the agent works in real time
  run(context(incident, controller.signal))
    .catch((err) => {
      if (controller.signal.aborted || incident.status === 'cancelled') return; // stop quietly
      fail(incident, err);
    })
    .finally(() => {
      holdClock(incident, false);
      if (!controller.signal.aborted && rt.maintenance) setMaintenance(incident, false);
      if (rt.controller === controller) rt.controller = null;
    });
}

function holdClock(incident, on) {
  try {
    sim.hold?.(incident.id, on);
  } catch (err) {
    console.error('[agent] hold:', err.message);
  }
}

function fail(incident, err) {
  const code = err.code || 'ERROR';
  const message = err.message || String(err);
  incident.status = code === 'BLOCKED' ? 'blocked' : 'error';
  incident.error = { code, message };
  const text = code === 'BLOCKED'
    ? `Purchase blocked: ${message}. Waiting for the manager.`
    : `Agent stopped (${incident.step}): ${message}`;
  sim.log('ERROR', incident.machineId, null, code, text);
  emit(EVENTS.INCIDENT_ERROR, { code, message, retryable: true }, incident.id);
  if (!(err instanceof IncidentStop)) console.error(`[agent] ${incident.id}:`, err);
}

// Per-run helpers. Every await goes through guard/sleep/minutes so a cancel
// stops the pipeline at once and nothing is emitted afterwards.
function context(incident, signal) {
  const machine = machineById(incident.machineId);
  return {
    incident,
    machine,
    signal,
    rt: runtime.get(incident.id),
    guard: (promise) => guard(promise, signal),
    sleep: (ms) => sleep(ms, signal),
    // Animation pauses shrink at high speed so they don't eat game-minutes.
    pause: (ms) => sleep(Math.round(ms / Math.sqrt(currentSpeed())), signal),
    // Real-world waits (shipping, travel, repair, test run) are the only steps
    // that let the game clock run; everything else holds it (see launch).
    async minutes(n) {
      holdClock(incident, false);
      try {
        await guard(sim.waitMinutes(n, { signal }), signal);
      } finally {
        if (!signal.aborted) holdClock(incident, true);
      }
    },
    async step(name) {
      incident.step = name;
      while (isPaused()) await sleep(300, signal); // the agent freezes with the factory
    },
    think: (text) => emit(EVENTS.AGENT_THINKING, { text }, incident.id),
    log: (code, message, componentId = null) => agentLog(incident, componentId, code, message),
  };
}

// ─── Pipeline ────────────────────────────────────────────────────────────────
async function run(ctx) {
  const { incident, machine, rt } = ctx;

  while (incident.attempts < MAX_ATTEMPTS) {
    if (incident.kind === 'breakdown' && sim.isHealthy(machine.id) && sim.machineStatus(machine.id) === 'running') {
      return resolve(ctx, null, null); // nothing left to fix
    }
    incident.attempts += 1;

    await ctx.step('diagnosing');
    await walkOver(ctx);
    const part = await diagnose(ctx);

    await ctx.step('sourcing');
    const found = await searchCatalog(ctx, part);

    await ctx.step('quoting');
    const quote = await quoteWithFallback(ctx, found, wantsExpress(ctx));

    await ctx.step('approval');
    const confidence = Math.min(part.confidence, found.confidence ?? 1);
    const verdict = evaluate({ total: quote.total, merchant: quote.merchant, confidence });
    emit(EVENTS.POLICY_DECISION, { ...verdict, total: quote.total, confidence }, incident.id);
    ctx.log('POLICY', `Policy ${verdict.action}. ${verdict.reasons.join('. ')}`, part.id);
    if (verdict.action === 'BLOCK') throw new IncidentStop('BLOCKED', verdict.reasons.join('; '), { merchant: quote.merchant });
    rt.lastOrder = await pay(ctx, quote, verdict, part, confidence);

    await ctx.step('shipping');
    await deliver(ctx, quote, part);

    await ctx.step('repairing');
    const job = await repair(ctx, part);

    await ctx.step('verifying');
    const fixed = await verify(ctx, part);
    // The technician is paid either way (the work was done). A verified fix waits
    // for the payout so the summary can show the tx; a failed one pays in the
    // background while the agent re-diagnoses.
    const payout = payTechnician(ctx, job, part, fixed);
    if (fixed) {
      await ctx.guard(payout);
      return resolve(ctx, part, job.technician);
    }
    payout.catch(() => {});
  }

  throw new IncidentStop('GAVE_UP', `Could not fix the ${machine.name} after ${MAX_ATTEMPTS} attempts`);
}

async function walkOver(ctx) {
  const { incident, machine } = ctx;
  if (incident.attempts > 1) return ctx.pause(2000); // "re-diagnosing" bubble is still up
  // Canned line, no LLM round trip: at 8× every real second is 8 game-minutes.
  ctx.think(incident.kind === 'predictive'
    ? `The ${machine.name} is showing wear. Let's swap the part before it fails.`
    : `On my way to the ${machine.name}: ${incident.codes[0] || 'it'} just tripped.`);
  await ctx.pause(2500); // robot walks over
}

// 2. Diagnose from what the plant shows: telemetry, the log and the heuristic prior.
async function diagnose(ctx) {
  const { incident, machine, rt } = ctx;
  let candidates = machine.components.filter((c) => !rt.ruledOut.has(c.id));
  if (incident.kind === 'predictive' && sim.machineStatus(machine.id) !== 'down') {
    const warned = candidates.filter((c) => incident.componentIds.includes(c.id));
    if (warned.length) candidates = warned;
  }
  if (!candidates.length) throw new IncidentStop('GAVE_UP', `Every part on the ${machine.name} has been ruled out`);

  const ruledOutNames = machine.components.filter((c) => rt.ruledOut.has(c.id)).map((c) => c.name);
  const prior = safePrior(machine.id, [...rt.ruledOut]);
  const telemetry = safeTelemetry(machine.id);
  const options = candidates.map((c) => c.name);
  const priorOverOptions = restrictPrior(prior.probabilities, candidates);

  const d = await ctx.guard(decide({
    kind: 'choice',
    question: incident.kind === 'predictive' && sim.isHealthy(machine.id)
      ? `Which part on the ${machine.name} is wearing out and should be replaced before it fails?`
      : `Which part is the root cause of the fault on the ${machine.name}?`,
    options,
    context: {
      machine: machine.name,
      kind: incident.kind,
      telemetry,
      log: logLines(machine.id, 20),
      prior: priorOverOptions,
      ruledOut: ruledOutNames,
    },
  }));

  const top = candidates.find((c) => c.id === prior.ranking[0]?.componentId);
  const component = candidates.find((c) => c.name === d.answer) || top || candidates[0];
  const confidence = d.probabilities?.[component.name] ?? d.confidence;
  const pct = Math.round(confidence * 100);
  const ranked = prior.ranking.find((r) => r.componentId === component.id);
  const evidence = (ranked?.evidence?.length ? ranked.evidence : fallbackEvidence(telemetry, component.id)).slice(0, 4);

  const why = evidence[0] ? `: ${lowerFirst(evidence[0])}` : '';
  const fallback = ruledOutNames.length
    ? `Not the ${ruledOutNames.at(-1)}. Now the ${component.name} looks likeliest (${pct}%)${why}.`
    : `Looks like the ${component.name} (${pct}%)${why}.`;
  const explanation = await ctx.guard(say(
    `You diagnosed the ${component.name} on the ${machine.name} (${pct}% sure). Evidence: ${evidence.join('; ') || 'none'}.` +
      `${ruledOutNames.length ? ` Already replaced without effect: ${ruledOutNames.join(', ')}.` : ''} Explain briefly.`,
    fallback,
  ));

  emit(EVENTS.AGENT_DIAGNOSIS, {
    componentId: component.id,
    component: component.name,
    probabilities: d.probabilities,
    prior: priorOverOptions, // the fault-code heuristic, shown next to the model's read
    confidence,
    provider: d.provider,
    attempt: incident.attempts,
    evidence,
    explanation,
  }, incident.id);

  const runnerUp = Object.entries(d.probabilities || {}).filter(([name]) => name !== component.name).sort((a, b) => b[1] - a[1])[0];
  ctx.log('DIAG', `Diagnosis: ${component.name} (${pct}%)${evidence[0] ? `. ${evidence[0]}` : ''}` +
    `${runnerUp ? `. Next: ${runnerUp[0]} (${Math.round(runnerUp[1] * 100)}%)` : ''}`, component.id);
  return { ...component, confidence, evidence };
}

// 3. Find a live replacement.
async function searchCatalog(ctx, part) {
  const { incident, machine } = ctx;
  emit(EVENTS.AGENT_SEARCHING, { query: part.query, part: part.name }, incident.id);
  const found = await ctx.guard(findReplacement(part, {
    trusted: getPolicy().allowedMerchants,
    context: { machine: machine.name, fault: incident.title },
  }));
  for (const o of found.offers || []) if (o.merchant) merchantsSeen.add(o.merchant);
  emit(EVENTS.CATALOG_RESULTS, {
    part: { id: part.id, name: part.name, qty: part.qty },
    query: found.query,
    offers: found.offers,
    chosen: found.chosen,
    probabilities: found.probabilities,
    confidence: found.confidence,
    provider: found.provider,
    source: found.source,
  }, incident.id);
  if (!found.chosen) throw new IncidentStop('NO_PARTS', `No listing found for "${part.name}"`);
  const n = found.offers.length;
  ctx.log('SOURCE', `Best listing for the ${part.name}: ${short(found.chosen.name)} from ${found.chosen.merchant}, ${money(found.chosen.price)} each (${n} option${n === 1 ? '' : 's'}, ${found.source})`, part.id);
  return found;
}

// Express only when the machine is actually stopped and the policy allows it.
function wantsExpress(ctx) {
  const down = sim.machineStatus(ctx.machine.id) !== 'running';
  return down && (ctx.machine.critical || !getPolicy().expressForCriticalOnly);
}

// 4. Quote (falls through to the next listing if a store can't fill it).
async function quoteWithFallback(ctx, found, express) {
  const { incident } = ctx;
  const order = [found.chosen, ...found.offers.filter((o) => o.variantId !== found.chosen.variantId)].slice(0, 3);
  for (const offer of order) {
    try {
      ctx.think(`Getting a quote from ${offer.merchant}…`);
      const quote = await ctx.guard(quoteParts([offer], { express }));
      emit(EVENTS.PROCUREMENT_QUOTE, { quote }, incident.id);
      const ship = quote.shipping ? `${quote.shipping.name} shipping ${money(quote.shipping.amount)}` : 'shipping n/a';
      ctx.log('QUOTE', `${quote.merchant}: ${money(quote.total)} total = parts ${money(quote.subtotal)} + ${ship} + tax ${money(quote.tax)}`);
      return quote;
    } catch (err) {
      if (err instanceof Cancelled || !QUOTE_RETRY_CODES.has(err.code)) throw err;
      ctx.think(`${offer.merchant} can't fill this order (${err.code}). Trying the next listing.`);
      sim.log('WARN', incident.machineId, null, err.code, `${offer.merchant} can't fill the order. Trying the next listing.`);
    }
  }
  throw new IncidentStop('NO_QUOTE', 'No store could fill this order');
}

// 6. Pay. AUTO: Kwal USDC vault first (no approval page); any Kwal error → Reap card.
async function pay(ctx, quote, verdict, part, confidence) {
  const { incident } = ctx;
  if (config.judge) return payDemo(ctx, quote, verdict, part);
  if (verdict.action === 'AUTO' && kwalRailEnabled()) {
    const viaVault = await payFromVault(ctx, quote, part, confidence);
    if (viaVault) return viaVault;
  }
  if (!config.mockReap && !config.reap.enrollmentId) {
    throw new IncidentStop('NO_CARD', 'No card on file yet. Run `npm run reap:enroll -w server` and set REAP_ENROLLMENT_ID.');
  }
  const autoApprove = verdict.action === 'AUTO';
  if (!autoApprove) ctx.think(`${money(quote.total)} needs the manager's OK: ${lowerFirst(verdict.reasons[0] || 'policy')}.`);
  const co = await ctx.guard(startCheckout(quote, { autoApprove }));
  if (co.approvalUrl) {
    emit(EVENTS.APPROVAL_REQUIRED, { checkoutId: co.checkoutId, approvalUrl: co.approvalUrl, total: quote.total, reasons: verdict.reasons }, incident.id);
    ctx.log('APPROVAL', `Approval requested: ${money(quote.total)} at ${quote.merchant}. ${verdict.reasons.join('; ')}`, part.id);
  }

  const result = await pollCheckout(ctx, co.checkoutId);
  if (result.status !== 'COMPLETED') {
    const reason = {
      EXPIRED: 'The manager did not approve the order',
      TIMEOUT: 'No answer from the payment page',
      FAILED: 'The payment or order did not go through',
    }[result.status] || `Checkout ended as ${result.status}`;
    emit(EVENTS.CHECKOUT_FAILED, { checkoutId: co.checkoutId, status: result.status, reason }, incident.id);
    throw new IncidentStop(`CHECKOUT_${result.status}`, reason);
  }

  const amount = round2(Number(result.finalAmount?.amount ?? quote.total));
  incident.spent = round2(incident.spent + amount);
  recordSpend(amount);
  sim.bump('partsSpend', amount);
  emit(EVENTS.CHECKOUT_COMPLETED, { checkoutId: co.checkoutId, orderId: result.orderId, finalAmount: result.finalAmount, rail: 'reap' }, incident.id);
  emit(EVENTS.POLICY_UPDATED, { policy: getPolicy() });

  const item = quote.items?.[0];
  if (!autoApprove) ctx.log('APPROVAL', `Manager approved ${money(amount)}`, part.id);
  ctx.log('ORDER', `Ordered ${item?.qty || part.qty}× ${short(item?.name || part.name)} from ${quote.merchant} (${money(amount)}), order ${result.orderId || 'n/a'}`, part.id);
  return { orderId: result.orderId, approval: verdict.action, amount, rail: 'reap' };
}

// Judge mode: the quote is live, but the Reap checkout is simulated (public
// visitors can't confirm our passkey). AUTO completes at once; ESCALATE waits
// for the game's approve/reject buttons (POST /api/mock/approve/:checkoutId).
async function payDemo(ctx, quote, verdict, part) {
  const { incident } = ctx;
  const checkoutId = `chk_demo_${randomUUID().slice(0, 8)}`;
  const autoApprove = verdict.action === 'AUTO';
  if (autoApprove) {
    ctx.think(`Within policy. Paying ${money(quote.total)} (demo checkout)…`);
    await ctx.pause(1200);
  } else {
    ctx.think(`${money(quote.total)} needs the manager's OK: ${lowerFirst(verdict.reasons[0] || 'policy')}.`);
    const answer = new Promise((resolve) => demoApprovals.set(checkoutId, resolve));
    emit(EVENTS.APPROVAL_REQUIRED, { checkoutId, approvalUrl: null, total: quote.total, reasons: verdict.reasons, demo: true }, incident.id);
    ctx.log('APPROVAL', `Approval requested: ${money(quote.total)} at ${quote.merchant}. ${verdict.reasons.join('; ')}`, part.id);
    let approved;
    let timer;
    try {
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve('TIMEOUT'), APPROVAL_TIMEOUT_MS);
      });
      approved = await ctx.guard(Promise.race([answer, timeout]));
    } finally {
      clearTimeout(timer);
      demoApprovals.delete(checkoutId);
    }
    if (approved !== true) {
      const status = approved === 'TIMEOUT' ? 'TIMEOUT' : 'EXPIRED';
      const reason = status === 'TIMEOUT' ? 'No answer from the manager' : 'The manager did not approve the order';
      emit(EVENTS.CHECKOUT_FAILED, { checkoutId, status, reason, demo: true }, incident.id);
      throw new IncidentStop(`CHECKOUT_${status}`, reason);
    }
  }

  const amount = round2(Number(quote.total));
  const orderId = `DEMO-${Math.floor(10000 + Math.random() * 90000)}`;
  incident.spent = round2(incident.spent + amount);
  recordSpend(amount);
  sim.bump('partsSpend', amount);
  emit(EVENTS.CHECKOUT_COMPLETED, {
    checkoutId,
    orderId,
    finalAmount: { amount, currency: quote.currency || 'USD' },
    rail: 'reap',
    merchant: quote.merchant,
    demo: true,
  }, incident.id);
  emit(EVENTS.POLICY_UPDATED, { policy: getPolicy() });

  const item = quote.items?.[0];
  if (!autoApprove) ctx.log('APPROVAL', `Manager approved ${money(amount)}`, part.id);
  ctx.log('ORDER', `Ordered ${item?.qty || part.qty}× ${short(item?.name || part.name)} from ${quote.merchant} (${money(amount)}, demo checkout), order ${orderId}`, part.id);
  return { orderId, approval: verdict.action, amount, rail: 'reap', simulated: true };
}

/** Judge mode: the manager's answer to a demo checkout. Returns null if nothing is waiting on it. */
export function approveDemo(checkoutId, approve = true) {
  const resolve = demoApprovals.get(checkoutId);
  if (!resolve) return null;
  demoApprovals.delete(checkoutId);
  resolve(Boolean(approve));
  return { id: checkoutId, status: approve ? 'PROCESSING' : 'EXPIRED', demo: true };
}

// Kwal vault rail. Returns the order, or null to fall back to the Reap card.
async function payFromVault(ctx, quote, part, confidence) {
  const { incident } = ctx;
  const resting = kwalCooldown();
  if (resting) {
    ctx.log('PAY', `Kwal vault rail unavailable (${resting.code}) — paying by Reap card instead`, part.id);
    return null;
  }
  const item = quote.items?.[0];
  const qty = item?.qty || part.qty || 1;
  ctx.think(`Within policy. Paying from the Kwal USDC vault…`);
  try {
    const r = await ctx.guard(vaultCheckout({
      query: part.query,
      listingName: item?.name || part.name,
      merchant: quote.merchant,
      qty,
      express: /express|overnight|2.?day|priority|next/i.test(quote.shipping?.name || ''),
      approve: (total, merchant) => evaluate({ total, merchant, confidence }).action === 'AUTO',
      signal: ctx.signal,
    }));
    const amount = round2(Number(r.finalAmount.amount));
    incident.spent = round2(incident.spent + amount);
    recordSpend(amount);
    sim.bump('partsSpend', amount);
    emit(EVENTS.CHECKOUT_COMPLETED, {
      checkoutId: r.paymentId,
      orderId: r.orderId,
      finalAmount: { amount, currency: 'USDC' },
      rail: 'kwal',
      merchant: r.product.merchant,
    }, incident.id);
    emit(EVENTS.POLICY_UPDATED, { policy: getPolicy() });
    refreshAfterPayout();
    ctx.log('ORDER', `Ordered ${qty}× ${short(r.product.title)} from ${r.product.merchant} (${usdcText(amount)} from the Kwal vault, no approval needed), order ${r.orderId}`, part.id);
    return { orderId: r.orderId, approval: 'AUTO', amount, rail: 'kwal' };
  } catch (err) {
    if (err instanceof Cancelled || ctx.signal.aborted) throw err instanceof Cancelled ? err : new Cancelled();
    const code = err.code || (err.status ? `HTTP_${err.status}` : 'error');
    console.warn(`[kwal] ${incident.id}: ${code}: ${err.message}`);
    const pending = err.maybePaid ? ` (payment ${err.paymentId} unconfirmed)` : '';
    ctx.log('PAY', `Kwal vault rail unavailable (${code})${pending} — paying by Reap card instead`, part.id);
    return null;
  }
}

// Polls the checkout until it settles. Tolerates a couple of network blips.
async function pollCheckout(ctx, checkoutId) {
  const until = Date.now() + APPROVAL_TIMEOUT_MS;
  let failures = 0;
  while (Date.now() < until) {
    try {
      const co = await ctx.guard(reap.getCheckout(checkoutId));
      failures = 0;
      if (TERMINAL.has(co?.status)) return { status: co.status, orderId: co.orderId, finalAmount: co.finalAmount || co.amount };
    } catch (err) {
      if (err instanceof Cancelled || ++failures >= 3) throw err;
    }
    await ctx.sleep(POLL_MS);
  }
  return { status: 'TIMEOUT' };
}

// 7. Ship (game minutes, so it respects speed and pause).
async function deliver(ctx, quote, part) {
  const { incident } = ctx;
  const fast = /express|overnight|2.?day|priority|next/i.test(quote.shipping?.name || '');
  const etaMinutes = fast ? MINUTES.express : MINUTES.standard;
  emit(EVENTS.DELIVERY_DISPATCHED, { etaMinutes, shipping: quote.shipping }, incident.id);
  ctx.log('SHIP', `${fast ? 'Express' : 'Standard'} shipping from ${quote.merchant}: arrives in ${etaMinutes} min`, part.id);
  await ctx.minutes(etaMinutes);
  emit(EVENTS.DELIVERY_ARRIVED, {}, incident.id);
  ctx.log('SHIP', `Delivered to the dock: ${part.qty}× ${part.name}`, part.id);
  await ctx.pause(1500); // robot picks up the crate
}

// 8. Repair: hire a technician, stop the machine, swap the part.
async function repair(ctx, part) {
  const { incident, machine, rt } = ctx;
  const pick = await ctx.guard(decide({
    kind: 'choice',
    question: `Which technician should replace the ${part.name} on the ${machine.name}?`,
    options: TECHNICIANS.map((t) => t.id),
    context: {
      part: part.name,
      machine: machine.name,
      technicians: TECHNICIANS.map(({ id, name, skills, rating, rate }) => ({ id, name, skills, rating, rateUSDC: rate })),
      hint: techFor(part.name),
    },
  }));
  const technician = TECHNICIANS.find((t) => t.id === pick.answer) || TECHNICIANS[0];
  const escrow = lockEscrow(technician, incident.id);
  emit(EVENTS.TECH_DISPATCHED, { technician, escrow }, incident.id);
  const rail = escrow.onchain ? `${usdcText(escrow.amountUsdc)} (${PAYOUT_NOTE})` : `${usdcText(escrow.amountUsdc)} (simulated payout)`;
  ctx.log('TECH', `Dispatched ${technician.name} (${technician.skills.join(', ')}). ${money(technician.rate)} job: ${rail} held in escrow until the fix is checked`, part.id);
  await ctx.minutes(MINUTES.travel);

  setMaintenance(incident, true);
  emit(EVENTS.TECH_REPAIRING, { minutes: MINUTES.repair, componentId: part.id }, incident.id);
  ctx.log('TECH', `${technician.name} on site, replacing the ${part.name} (${MINUTES.repair} min)`, part.id);
  await ctx.minutes(MINUTES.repair);

  sim.replaceComponent(machine.id, part.id);
  emit(EVENTS.PART_REPLACED, { machineId: machine.id, componentId: part.id }, incident.id);
  setMaintenance(incident, false);
  ctx.log('TECH', `Swap done. ${technician.name}'s escrow is released once the test run is checked`, part.id);
  return { technician, escrow };
}

// 8b. Release the escrow: USDC onchain when possible, simulated otherwise.
// Never throws; never pays the same escrow twice (releaseEscrow is idempotent).
async function payTechnician(ctx, { technician, escrow }, part, fixed) {
  const { incident, rt } = ctx;
  if (fixed) ctx.think(escrow.onchain ? `Fix verified. Paying ${technician.name} ${usdcText(escrow.amountUsdc)} onchain…` : `Fix verified. Paying ${technician.name}.`);
  const released = await releaseEscrow(escrow);
  if (ctx.signal.aborted) {
    console.log(`[payout] ${escrow.id} settled after ${incident.id} was cancelled: ${released.txHash || released.simulatedReason}`);
    return released;
  }
  emit(EVENTS.ESCROW_RELEASED, { escrow: released }, incident.id);
  sim.bump('laborSpend', technician.rate);
  rt.labor += technician.rate;
  rt.payouts.push(released);

  const why = fixed ? 'Repair verified. ' : `Fix didn't take, but ${technician.name} did the work. `;
  if (released.onchain) {
    const wait = released.confirmed === false ? ' (awaiting confirmation)' : '';
    ctx.log('PAYOUT', `${why}Paid ${technician.name} ${usdcText(released.amountUsdc)} onchain (${PAYOUT_NOTE} from the ${money(released.amount)} job), tx ${released.txHash}${wait}`, part.id);
    if (released.confirmed === false) {
      confirmPayout(released).then((c) => {
        if (incident.status === 'cancelled') return;
        agentLog(incident, part.id, 'PAYOUT', c.confirmed
          ? `Payout to ${technician.name} confirmed in block ${c.blockNumber}, tx ${released.txHash}`
          : `Payout to ${technician.name} still unconfirmed (${c.error}), tx ${released.txHash}`);
      });
    }
  } else {
    ctx.log('PAYOUT', `${why}Released ${money(released.amount)} to ${technician.name} (simulated payout: ${released.simulatedReason})`, part.id);
  }
  return released;
}

// 9. Verify against the live signals. Sensors are ground truth; the model's
// yes/no is reported alongside.
async function verify(ctx, part) {
  const { incident, machine, rt } = ctx;
  ctx.think(`Test run. Watching the ${machine.name} signals…`);
  ctx.log('VERIFY', `Test run: watching ${machine.name} signals for ${MINUTES.verify} min`, part.id);
  await ctx.minutes(MINUTES.verify);

  const parts = sim.snapshot().machines?.[machine.id]?.components || {};
  const healthy = sim.isHealthy(machine.id);
  const lingering = incident.kind === 'predictive' ? incident.componentIds.filter((cid) => parts[cid] && parts[cid].status !== 'ok') : [];
  const fixed = healthy && !lingering.length;

  const v = await ctx.guard(decide({
    kind: 'yesno',
    question: `After replacing the ${part.name}, is the ${machine.name} ${incident.kind === 'predictive' ? 'back to nominal' : 'working again'}?`,
    context: {
      machine: machine.name,
      telemetry: safeTelemetry(machine.id),
      log: logLines(machine.id, 12),
      prior: { yes: fixed ? 0.95 : 0.05, no: fixed ? 0.05 : 0.95 },
    },
  }));
  if (fixed) {
    const warn = Object.entries(parts).filter(([, p]) => p.status === 'warn').map(([cid]) => cid);
    const note = warn.length ? `no faults; ${names(machine, warn).join(', ')} still in WARN` : 'all signals within limits';
    ctx.log('VERIFY', `Verified (${Math.round((v.probabilities?.yes ?? 1) * 100)}%): ${machine.name} running, ${note}`, part.id);
    return true;
  }

  rt.ruledOut.add(part.id);
  incident.ruledOut = machine.components.filter((c) => rt.ruledOut.has(c.id)).map((c) => c.name);
  const replacedOk = parts[part.id]?.status === 'ok';
  const codes = sim.snapshot().machines?.[machine.id]?.activeCodes || [];
  const last = incident.attempts >= MAX_ATTEMPTS;
  const next = last ? 'Out of attempts.' : 'Re-diagnosing.';
  let text;
  if (!replacedOk) {
    // The new part trips the same way: something upstream is pushing it.
    text = `${healthy ? 'Still drifting' : 'Still faulting'}. The ${part.name} wasn't the root cause. ${last ? 'I need a human.' : 'Re-diagnosing.'}`;
    ctx.log('VERIFY', `${codes.length ? `Still faulting: ${codes.join(', ')}` : `New ${part.name} still in WARN`}. Not the root cause. ${next}`, part.id);
  } else {
    // The new part reads fine, but something else on the machine is still wrong.
    const others = codes.length ? `${codes.join(', ')} still active` : `${names(machine, lingering).join(', ')} still in WARN`;
    text = `The ${part.name} is fine now, but ${others}. ${last ? 'I need a human.' : 'Next one.'}`;
    ctx.log('VERIFY', `New ${part.name} reads OK, but ${others}. ${next}`, part.id);
  }
  ctx.think(text);
  return false;
}

function resolve(ctx, part, technician) {
  const { incident, machine, rt } = ctx;
  const t = gameNow();
  incident.status = 'resolved';
  incident.step = 'done';
  incident.endedAt = t;
  const summary = {
    kind: incident.kind,
    component: part?.name || null,
    componentId: part?.id || null,
    spent: round2(incident.spent),
    labor: rt.labor,
    totalCost: round2(incident.spent + rt.labor),
    orderId: rt.lastOrder?.orderId || null,
    technician: technician?.name || null,
    attempts: incident.attempts,
    downtimeMin: round1(incident.downtimeMin),
    durationMin: round1(Math.max(0, t - incident.startedAt)),
    approval: rt.lastOrder?.approval || null,
    rail: rt.lastOrder?.rail || null,
    payout: payoutSummary(rt.payouts.at(-1)),
    payouts: rt.payouts.map(payoutSummary),
  };
  sim.bump('incidentsResolved', 1);
  const planned = incident.kind === 'predictive' && !rt.overtaken; // swapped before it ever stopped the line
  if (part) {
    ctx.think(planned
      ? `Done. New ${part.name} in before it failed.`
      : `${machine.name} is back up. It was the ${part.name}.`);
  }
  emit(EVENTS.INCIDENT_RESOLVED, { summary }, incident.id);
  const cause = !part ? '' : planned ? `New ${part.name}. ` : `Root cause: ${part.name}. `;
  const how = planned ? `${machine.name} serviced before failure`
    : rt.overtaken ? `${machine.name} running again (it failed before the planned swap)`
    : `${machine.name} running again`;
  ctx.log('RESOLVED', `${how}. ${cause}${summary.durationMin} min, ${summary.downtimeMin} min stopped, parts ${money(summary.spent)} + labor ${money(summary.labor)}, ${summary.attempts} attempt${summary.attempts === 1 ? '' : 's'}`, part?.id || null);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function payoutSummary(e) {
  if (!e) return null;
  return {
    technicianId: e.technicianId,
    amount: e.amount,
    amountUsdc: e.amountUsdc,
    onchain: Boolean(e.onchain),
    to: e.to || null,
    txHash: e.txHash || null,
    txUrl: e.txUrl || null,
    simulatedReason: e.simulatedReason || null,
  };
}

function guard(promise, signal) {
  if (signal.aborted) return Promise.reject(new Cancelled());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) reject(new Cancelled());
        else resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(signal.aborted ? new Cancelled() : e);
      },
    );
  });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Cancelled());
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Cancelled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function setMaintenance(incident, on) {
  const rt = runtime.get(incident.id);
  if (rt) rt.maintenance = on;
  try {
    sim.setMaintenance(incident.machineId, on);
  } catch (err) {
    console.error('[agent] setMaintenance:', err.message);
  }
}

function agentLog(incident, componentId, code, message) {
  try {
    sim.log('AGENT', incident.machineId, componentId || null, code, message);
  } catch (err) {
    console.error('[agent] log:', err.message);
  }
}

function activeIncident(machineId) {
  for (const inc of incidents.values()) if (inc.machineId === machineId && ACTIVE.has(inc.status)) return inc;
  return null;
}

function isPaused() {
  try {
    return Boolean(sim.snapshot().paused);
  } catch {
    return false;
  }
}

function currentSpeed() {
  try {
    return Math.max(1, sim.snapshot().speed || 1);
  } catch {
    return 1;
  }
}

function gameNow() {
  try {
    return Math.round((typeof sim.now === 'function' ? sim.now() : sim.snapshot().t) * 100) / 100 || 0;
  } catch {
    return 0;
  }
}

function safeTelemetry(machineId) {
  try {
    return sim.telemetryContext(machineId);
  } catch (err) {
    console.warn('[agent] telemetryContext:', err.message);
    return null;
  }
}

function safePrior(machineId, ruledOut) {
  try {
    const p = scoreComponents(machineId, { ruledOut }) || {};
    return { probabilities: p.probabilities || {}, ranking: p.ranking || [], evidence: p.evidence || [] };
  } catch (err) {
    console.warn('[agent] scoreComponents:', err.message);
    return { probabilities: {}, ranking: [], evidence: [] };
  }
}

// The prior over just these candidates, renormalized (keys are part names).
function restrictPrior(probabilities, candidates) {
  const entries = candidates
    .map((c) => [c.name, probabilities[c.name] ?? probabilities[c.id]])
    .filter(([, p]) => Number.isFinite(p) && p >= 0);
  const total = entries.reduce((s, [, p]) => s + p, 0);
  if (!total) return undefined;
  return Object.fromEntries(entries.map(([name, p]) => [name, Math.round((p / total) * 1000) / 1000]));
}

// Plant log lines as the model reads them: "[08:14] FAULT E-ARM-310 Gripper position error …"
function logLines(machineId, limit) {
  try {
    return (sim.recentLogs({ machineId, limit }) || []).map((e) => `[${e.clock}] ${e.level} ${e.code ? `${e.code} ` : ''}${e.message}`);
  } catch {
    return [];
  }
}

// Used only if the diagnostics module returns no evidence for a part.
function fallbackEvidence(telemetry, componentId) {
  const part = telemetry?.parts?.find((p) => p.id === componentId);
  if (!part) return [];
  return [...(part.signals || [])]
    .sort((a, b) => (b.severity || 0) - (a.severity || 0))
    .slice(0, 2)
    .map((s) => `${signalText(s, false)} (warn ${s.warn}, fail ${s.fail})`);
}

// The signal furthest past its own warn line (same ranking the plant log uses).
function worstSignal(telemetry, componentIds) {
  let worst = null;
  for (const part of telemetry?.parts || []) {
    if (!componentIds.includes(part.id)) continue;
    for (const signal of part.signals || []) {
      const wf = (signal.warn - signal.nominal) / (signal.fail - signal.nominal);
      const score = ((signal.severity || 0) - wf) / (1 - wf || 1);
      if (!worst || score > worst.score) worst = { part, signal, score };
    }
  }
  return worst;
}

function breakdownTitle(machine, codes) {
  const code = codes[0];
  if (!code) return `${machine.name} down`;
  const part = machine.components.find((c) => c.code === code);
  const more = codes.length > 1 ? ` (+${codes.length - 1} more)` : '';
  return `${machine.name} down: ${code}${part ? ` ${part.fault}` : ''}${more}`;
}

function predictiveTitle(machine, componentIds, worst) {
  const part = worst?.part.name || machine.components.find((c) => c.id === componentIds[0])?.name || 'part';
  return `${machine.name}: ${part} wearing${worst ? ` (${signalText(worst.signal, true)})` : ''}`;
}

function signalText(s, lower = true) {
  return `${lower ? s.label.toLowerCase() : s.label} ${formatReading(s, s.value)}`;
}

const warnCode = (c) => `W${c.code.slice(1)}`; // E-CNV-130 → W-CNV-130
const names = (machine, ids) => machine.components.filter((c) => ids.includes(c.id)).map((c) => c.name);
const machineById = (id) => MACHINES.find((m) => m.id === id);
const lowerFirst = (s) => (s && /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s); // keeps "FAULT", "24V"…
const short = (s, n = 44) => (s && s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

// Mock hint for the technician choice: match the part to the technician's skills.
function techFor(part) {
  if (/network|barcode|scanner|fan/i.test(part)) return 'tech-mei'; // networking, electrical
  if (/motor|servo|driver|bearing/i.test(part)) return 'tech-raj'; // motors, servos
  return 'tech-ana'; // sensors, electrical
}
