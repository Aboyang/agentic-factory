// Factory simulation (docs/SIM_SPEC.md sections 1-4).
// Every part has a hidden health. Health drives sensor signals, signals drive
// part/machine status, and status changes write the plant log. Health never
// leaves this module: the game and the decision model only see signals + logs.

import { MACHINES, PRESETS, EVENTS, LOG_LEVELS } from '../../../shared/contract.js';
import { emit } from '../events.js';

const TICK_MS = 1000;
const SPEEDS = [1, 2, 4, 8];
const SHIFT_START = 8 * 60; // 08:00
const MAX_LOGS = 500;
const MAX_HISTORY = 120;
const WARN_REPEAT_MIN = 5; //  a moving reading is re-logged every 5 game-min with its trend
const WARN_REMIND_MIN = 15; // a slow or steady one only every 15, so long alarms don't flood the log
const MOVING_FRAC = 0.03; //   "moving" = changed ≥ 3% of its nominal→fail span since the last line
const FAULT_FRAC = 0.97;
const MAX_FRAC = 1.15;
const NOISE_SIGMA = 0.008; // as a fraction of |fail - nominal|
const UNITS_PER_MIN = 12;
const PRICE_PER_UNIT = 5;
const GRADUAL_FAULT_MIN = 12;
const KPI_KEYS = ['partsSpend', 'laborSpend', 'incidentsResolved'];
const EPS = 1e-9;

// ─── Static model ────────────────────────────────────────────────────────────

const machineDefs = new Map(MACHINES.map((m) => [m.id, m]));
const keyOf = (machineId, componentId) => `${machineId}/${componentId}`;

// 'machine/target/signal' → [{ source: 'machine/component', weight }]
const effectIndex = new Map();
for (const m of MACHINES) {
  for (const c of m.components) {
    for (const e of c.effects || []) {
      const k = `${m.id}/${e.target}/${e.signal}`;
      if (!effectIndex.has(k)) effectIndex.set(k, []);
      effectIndex.get(k).push({ source: keyOf(m.id, c.id), weight: e.weight });
    }
  }
}

// ─── Math + formatting helpers ───────────────────────────────────────────────

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const roundTo = (v, digits = 0) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/** d(h): 0 while h ≥ 0.7, 1 at h = 0. */
export const degradation = (h) => clamp((0.7 - h) / 0.7, 0, 1) ** 1.6;
const warnFrac = (sig) => (sig.warn - sig.nominal) / (sig.fail - sig.nominal);
const worse = (a, b) => (RANK[b] > RANK[a] ? b : a);
const RANK = { ok: 0, warn: 1, fault: 2 };

/** E-ARM-301 → W-ARM-301 */
export const warnCode = (code) => `W${String(code).replace(/^E/, '')}`;

const TIGHT_UNITS = new Set(['°', '°C', '%']);
export function withUnit(text, unit) {
  if (!unit) return String(text);
  return TIGHT_UNITS.has(unit) ? `${text}${unit}` : `${text} ${unit}`;
}
/** A reading as the plant shows it: '20.61 V', '6.12°', '62°C'. */
export const formatReading = (sig, value) => withUnit(Number(value).toFixed(sig.digits ?? 0), sig.unit);
/** A threshold as written in the contract: '23.2 V', '5°'. */
export const formatThreshold = (sig, value) => withUnit(String(value), sig.unit);
/** The size of a change: '1.9 V'. */
export const formatChange = (sig, delta) => withUnit(Math.abs(delta).toFixed(sig.digits ?? 0), sig.unit);

export function clockAt(t) {
  const m = ((Math.floor(SHIFT_START + t + EPS) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** '[08:14] FAULT E-ARM-310 Gripper position error — …' */
export function formatLogLine(entry) {
  return `[${entry.clock}] ${entry.level}${entry.code ? ` ${entry.code}` : ''} ${entry.message}`;
}

// Small seeded PRNG so a preset can be replayed exactly (tests pass a seed).
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  preset: null,
  t: 0,
  speed: 1,
  paused: false,
  rng: Math.random,
  parts: new Map(), //    'machine/component' → part state (see makePart)
  machines: new Map(), // machineId → { def, maintenance, status, degraded, activeCodes }
  script: [],
  kpis: emptyKpis(),
  runningMinutes: 0,
  totalMinutes: 0,
  logs: [],
  logSeq: 0,
  history: new Map(), // machineId → [{ t, readings }]
  waiters: new Set(),
  quietSince: 0, //      game minute since which nothing has been broken or wearing (null while busy)
  nextGap: 8, //         minutes of calm before the scheduler starts the next failure
};
const listeners = new Map();
let timer = null;
let stepping = false;
// Clock holds: while Wrench-bot works in real time (walking, model calls, store
// quotes, payment, the manager's approval) the game clock stands still, so a
// slow network or a slow manager never costs extra game-minutes at 8×. Only
// waits that represent real-world time (sim.waitMinutes) advance the clock.
const holds = new Set();
const busyChecks = new Set(); // extra "a failure is in progress" predicates (open incidents)
let interrupted = false; //     a wait finished or a hold started mid-step: stop the step there

function emptyKpis() {
  return { unitsProduced: 0, revenue: 0, downtimeCost: 0, partsSpend: 0, laborSpend: 0, incidentsResolved: 0 };
}

function makePart(machineId, def, health, jitter) {
  return {
    key: keyOf(machineId, def.id),
    machineId,
    def,
    health,
    jitter, //        wear multiplier, fixed per part per preset load
    ramps: [], //     [{ rate, remaining }] scripted / injected linear declines
    status: 'ok',
    signals: {}, //   key → { frac, status, value }  (frac is noiseless)
    fresh: false, //  just replaced: re-announce a WARN/FAULT that survives the swap
    warnSince: null,
    lastWarnT: null,
    lastWarnKey: null,
    lastWarnTrue: null,
    faultKey: null,
  };
}

const partsOf = (machineId) => machineDefs.get(machineId).components.map((c) => state.parts.get(keyOf(machineId, c.id)));

function requirePart(machineId, componentId) {
  const part = state.parts.get(keyOf(machineId, componentId));
  if (!part) throw new Error(`Unknown part ${machineId}/${componentId}`);
  return part;
}

function requireMachine(machineId) {
  const m = state.machines.get(machineId);
  if (!m) throw new Error(`Unknown machine ${machineId}`);
  return m;
}

// ─── Signals ─────────────────────────────────────────────────────────────────

/** Noiseless fraction of the way from nominal to fail (own wear + effects from other parts). */
function signalFrac(part, sig) {
  let frac = degradation(part.health);
  for (const { source, weight } of effectIndex.get(`${part.key}/${sig.key}`) || []) {
    frac += weight * degradation(state.parts.get(source).health);
  }
  return Math.min(frac, MAX_FRAC);
}

function signalStatus(sig, frac) {
  if (frac >= FAULT_FRAC) return 'fault';
  if (frac >= warnFrac(sig)) return 'warn';
  return 'ok';
}

const trueValue = (sig, frac) => sig.nominal + (sig.fail - sig.nominal) * frac;

// Sum of three U(-1, 1) has σ = 1: gaussian-ish and bounded to ±3.
const uniform = () => 2 * state.rng() - 1;
const gauss = () => uniform() + uniform() + uniform();

/**
 * Noisy reading, rounded to the signal's digits. Noise never pushes a reading
 * across the band of its (noiseless) status, so an OK chip never shows a value
 * past the warn line and a FAULT always reads at or beyond the limit.
 */
function noisyReading(sig, frac, status) {
  const span = sig.fail - sig.nominal;
  const dir = Math.sign(span) || 1;
  const step = 10 ** -(sig.digits ?? 0);
  const past = (v, threshold) => (v - threshold) * dir >= -EPS;
  let v = roundTo(sig.nominal + span * (frac + NOISE_SIGMA * gauss()), sig.digits);
  if (status === 'ok' && past(v, sig.warn)) v = sig.warn - dir * step;
  else if (status === 'warn' && !past(v, sig.warn)) v = sig.warn;
  else if (status === 'warn' && past(v, sig.fail)) v = sig.fail - dir * step;
  else if (status === 'fault' && !past(v, sig.fail)) v = sig.fail;
  v = Math.max(0, v); // every channel here is a non-negative magnitude
  if (sig.unit === '%') v = Math.min(100, v);
  return roundTo(v, sig.digits);
}

/** The signal furthest past its own warn line (optionally only among signals in `status`). */
function worstSignal(part, status) {
  let best = null;
  let bestScore = -Infinity;
  for (const sig of part.def.signals) {
    const s = part.signals[sig.key];
    if (!s || (status && s.status !== status)) continue;
    const wf = warnFrac(sig);
    const score = (s.frac - wf) / (1 - wf);
    if (score > bestScore) {
      best = sig;
      bestScore = score;
    }
  }
  return best || part.def.signals[0];
}

const sigDef = (part, key) => part.def.signals.find((s) => s.key === key) || part.def.signals[0];
const readingText = (part, sig) => `${sig.label} ${formatReading(sig, part.signals[sig.key].value)}`;

// ─── Evaluation: status + log transitions ────────────────────────────────────

/** Recompute every reading and status, log transitions, then fire internal events. */
function evaluate() {
  const fired = [];
  for (const m of state.machines.values()) {
    const codes = [];
    let anyWarn = false;
    for (const part of partsOf(m.def.id)) {
      const prev = part.status;
      const fresh = part.fresh;
      part.fresh = false;
      let status = 'ok';
      const signals = {};
      for (const sig of part.def.signals) {
        const frac = signalFrac(part, sig);
        const s = signalStatus(sig, frac);
        signals[sig.key] = { frac, status: s, value: noisyReading(sig, frac, s) };
        status = worse(status, s);
      }
      part.signals = signals;
      part.status = status;
      partTransition(m, part, prev, status, fresh, fired);
      if (status === 'fault') codes.push(part.def.code);
      if (status === 'warn') anyWarn = true;
    }
    const prev = m.status;
    const next = m.maintenance ? 'maintenance' : codes.length ? 'down' : 'running';
    m.status = next;
    m.activeCodes = codes;
    m.degraded = anyWarn && next !== 'down';
    machineTransition(m, prev, next, fired);
  }
  for (const [name, payload] of fired) fire(name, payload);
}

function partTransition(m, part, prev, next, fresh, fired) {
  const { def } = part;
  const machineId = m.def.id;

  if (prev === 'fault' && next !== 'fault') {
    const sig = sigDef(part, part.faultKey);
    addLog('INFO', machineId, def.id, def.code, `${def.code} cleared — ${readingText(part, sig)}`);
    part.faultKey = null;
  }
  if (prev === 'warn' && next === 'ok') {
    const sig = sigDef(part, part.lastWarnKey);
    addLog('INFO', machineId, def.id, warnCode(def.code), `${warnCode(def.code)} cleared — ${readingText(part, sig)}`);
  }

  if (next === 'fault') {
    if (prev !== 'fault' || fresh) {
      const sig = worstSignal(part, 'fault');
      part.faultKey = sig.key;
      addLog('FAULT', machineId, def.id, def.code, `${def.fault} — ${readingText(part, sig)} (limit ${formatThreshold(sig, sig.fail)})`);
    }
  } else if (next === 'warn') {
    const sig = worstSignal(part, 'warn');
    const s = part.signals[sig.key];
    if (prev !== 'warn' || fresh) {
      part.warnSince = state.t;
      addLog('WARN', machineId, def.id, warnCode(def.code), `${readingText(part, sig)} (warn ${formatThreshold(sig, sig.warn)})`);
      fired.push(['part.warn', { machineId, componentId: def.id }]);
    } else {
      const elapsed = state.t - part.lastWarnT;
      const sameSignal = part.lastWarnKey === sig.key;
      // Trend from the noiseless values so a plateau reads as steady, not as noise.
      const delta = sameSignal ? trueValue(sig, s.frac) - part.lastWarnTrue : 0;
      const moving = !sameSignal || Math.abs(delta) >= MOVING_FRAC * Math.abs(sig.fail - sig.nominal);
      const due = elapsed >= (moving ? WARN_REPEAT_MIN : WARN_REMIND_MIN) - EPS;
      if (!due) return; // between repeats: keep the last logged reference values
      const minutes = Math.round(elapsed);
      let message = `${readingText(part, sig)} (warn ${formatThreshold(sig, sig.warn)})`;
      if (sameSignal) {
        const steady = Math.abs(delta) < 0.5 * 10 ** -(sig.digits ?? 0);
        message = steady
          ? `${readingText(part, sig)}, steady for ${minutes} min`
          : `${readingText(part, sig)}, ${delta < 0 ? 'down' : 'up'} ${formatChange(sig, delta)} in ${minutes} min`;
      }
      addLog('WARN', machineId, def.id, warnCode(def.code), message);
    }
    part.lastWarnT = state.t;
    part.lastWarnKey = sig.key;
    part.lastWarnTrue = trueValue(sig, s.frac);
    return;
  }
  // ok or fault: not in warn any more
  part.warnSince = null;
  part.lastWarnT = null;
  part.lastWarnTrue = null;
  if (next === 'ok') part.lastWarnKey = null;
}

function machineTransition(m, prev, next, fired) {
  if (prev === next) return;
  const { id, name } = m.def;
  if (next === 'down') {
    const codes = [...m.activeCodes];
    const verb = prev === 'maintenance' ? 'down after maintenance' : 'stopped';
    addLog('ERROR', id, null, 'M-DOWN', `${name} ${verb}: ${codes.join(', ')}`);
    fired.push(['machine.down', { machineId: id, codes }]);
  } else if (next === 'running') {
    addLog('INFO', id, null, 'M-UP', `${name} running`);
    fired.push(['machine.up', { machineId: id }]);
  } else if (next === 'maintenance') {
    addLog('INFO', id, null, 'MAINT', `${name} locked out for maintenance`);
  }
}

// ─── Plant log ───────────────────────────────────────────────────────────────

function addLog(level, machineId, componentId, code, message) {
  const entry = {
    id: ++state.logSeq,
    t: roundTo(state.t, 2),
    clock: clockAt(state.t),
    level: LOG_LEVELS.includes(level) ? level : 'INFO',
    machineId: machineId || null,
    componentId: componentId || null,
    code: code || null,
    message: String(message ?? ''),
  };
  state.logs.push(entry);
  if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS);
  emit(EVENTS.LOG_ENTRY, { entry });
  return entry;
}

// ─── Internal events ─────────────────────────────────────────────────────────

function fire(name, payload) {
  for (const fn of [...(listeners.get(name) || [])]) {
    try {
      const r = fn(payload);
      if (r && typeof r.catch === 'function') r.catch((err) => console.error(`[sim] '${name}' listener failed:`, err));
    } catch (err) {
      console.error(`[sim] '${name}' listener failed:`, err);
    }
  }
}

function on(name, fn) {
  if (typeof fn !== 'function') return;
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
}

function off(name, fn) {
  listeners.get(name)?.delete(fn);
}

// ─── Time ────────────────────────────────────────────────────────────────────

function addRamp(part, to, over, elapsed = 0) {
  const target = clamp(Number(to), 0, 1);
  const minutes = Number(over);
  if (!(minutes > 0)) {
    part.health = Math.min(part.health, target);
    return;
  }
  if (part.health <= target) return;
  const ramp = { rate: (part.health - target) / minutes, remaining: minutes };
  if (elapsed > 0) {
    const s = Math.min(elapsed, ramp.remaining);
    part.health = clamp(part.health - ramp.rate * s, 0, 1);
    ramp.remaining -= s;
  }
  if (ramp.remaining > EPS) part.ramps.push(ramp);
}

function applyScript(ev, elapsed) {
  ev.fired = true;
  const part = state.parts.get(ev.target);
  if (!part) return console.warn(`[sim] script target not found: ${ev.target}`);
  if (typeof ev.health === 'number') part.health = clamp(ev.health, 0, 1);
  else if (typeof ev.degradeTo === 'number') addRamp(part, ev.degradeTo, ev.over, elapsed);
}

/** Production and costs over `dt`, using the statuses that held during it. */
function accrue(dt) {
  const k = state.kpis;
  state.totalMinutes += dt;
  if (lineRunning()) {
    state.runningMinutes += dt;
    k.unitsProduced += UNITS_PER_MIN * dt;
    k.revenue += UNITS_PER_MIN * dt * PRICE_PER_UNIT;
  }
  for (const m of state.machines.values()) {
    if (m.status !== 'running') k.downtimeCost += m.def.downtimeCostPerMin * dt;
  }
}

// ─── One failure at a time ───────────────────────────────────────────────────
// A failure is "in progress" while any machine is down or under maintenance,
// any part is faulted, or any part is on a decline ramp. While busy, the
// scheduler and scripted events wait, and chaos is refused, so the story on
// screen is always one breakdown → one diagnosis → one repair.

function busy() {
  for (const m of state.machines.values()) if (m.status !== 'running') return true;
  for (const part of state.parts.values()) if (part.status === 'fault' || part.ramps.length) return true;
  for (const check of busyChecks) {
    try {
      if (check()) return true;
    } catch {
      // a broken check never blocks the factory
    }
  }
  return false;
}

/** Register an extra busy predicate (the orchestrator: "an incident is still open"). */
function addBusyCheck(fn) {
  if (typeof fn === 'function') busyChecks.add(fn);
}

/** Hold (on) or release (off) the game clock for `key` (an incident id). */
function hold(key, on = true) {
  if (on) {
    if (!holds.has(key)) {
      holds.add(key);
      interrupted = true;
    }
  } else {
    holds.delete(key);
  }
  return holds.size > 0;
}

const held = () => holds.size > 0;

const gapMinutes = () => {
  const [lo, hi] = state.preset?.failureEvery || [6, 12];
  return lo + (hi - lo) * state.rng();
};

/** Free play: after a calm gap, start exactly one failure (mostly gradual, so WARNs show first). */
function scheduleFailure() {
  if (!(state.preset?.wear > 0) || state.quietSince === null) return;
  if (state.t - state.quietSince < state.nextGap) return;
  const parts = [...state.parts.values()];
  const total = parts.reduce((sum, p) => sum + 1 / p.def.life, 0);
  let r = state.rng() * total;
  const part = parts.find((p) => (r -= 1 / p.def.life) <= 0) || parts[parts.length - 1];
  if (state.rng() < 0.3) part.health = 0;
  else addRamp(part, 0, 10 + 6 * state.rng());
  state.quietSince = null;
}

/** One sub-step of at most 1 game-minute: KPIs, ramps, script, status, history, waits. */
function advance(dt) {
  accrue(dt);
  for (const part of state.parts.values()) {
    let h = part.health;
    part.ramps = part.ramps.filter((r) => {
      const s = Math.min(dt, r.remaining);
      h -= r.rate * s;
      r.remaining -= s;
      return r.remaining > EPS;
    });
    part.health = clamp(h, 0, 1);
  }
  state.t += dt;
  for (const ev of state.script) {
    if (ev.fired || ev.at > state.t + EPS) continue;
    // Held while another failure is in progress; fires after 2 calm minutes
    // (quietSince is still null on the first calm minute).
    if (busy() || (ev.held && (state.quietSince === null || state.t - state.quietSince < 2))) continue;
    applyScript(ev, ev.held ? 0 : state.t - ev.at);
    break; // one event per minute at most
  }
  for (const ev of state.script) if (!ev.fired && ev.at <= state.t + EPS && busy()) ev.held = true;
  evaluate();
  if (busy()) {
    state.quietSince = null;
  } else if (state.quietSince === null) {
    state.quietSince = state.t;
    state.nextGap = gapMinutes();
  }
  scheduleFailure();
  evaluate();
  recordHistory();
  for (const w of [...state.waiters]) {
    if (w.signal?.aborted) {
      w.cancel();
      continue;
    }
    w.remaining -= dt;
    if (w.remaining <= EPS) {
      w.done();
      interrupted = true;
    }
  }
  fire('minute', { t: state.t });
}

/** Advance `dt` game-minutes synchronously (the 1 s loop calls this with dt = speed, or 0 when paused). */
function step(dt = state.speed) {
  if (stepping) return null;
  stepping = true;
  let snap = null;
  try {
    let remaining = Number(dt);
    if (!Number.isFinite(remaining) || remaining < 0) remaining = 0;
    // Sub-steps keep log timestamps, waits and warn timers exact at 8× speed.
    // When a wait finishes (or the agent starts working) the step stops right
    // there, so the agent acts at that game minute instead of up to 7 later.
    interrupted = false;
    while (remaining > EPS) {
      const sub = Math.min(1, remaining);
      advance(sub);
      remaining -= sub;
      if (interrupted) break;
    }
    for (const w of [...state.waiters]) if (w.signal?.aborted) w.cancel();
    snap = snapshot();
  } finally {
    stepping = false;
  }
  emit(EVENTS.SIM_TICK, { sim: snap });
  fire('tick', snap);
  return snap;
}

function start() {
  if (timer) return;
  timer = setInterval(() => {
    try {
      step(state.paused || holds.size ? 0 : state.speed);
    } catch (err) {
      console.error('[sim] tick failed:', err);
    }
  }, TICK_MS);
}

function stop() {
  clearInterval(timer);
  timer = null;
}

function cancelledError() {
  const err = new Error('cancelled');
  err.code = 'CANCELLED';
  return err;
}

/** Resolves after `n` game-minutes (respects speed and pause); rejects Error('cancelled') on abort. */
function waitMinutes(n, opts) {
  const signal = opts?.signal;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelledError());
    const minutes = Number(n);
    if (!(minutes > 0)) return resolve();
    const w = { remaining: minutes, signal };
    const cleanup = () => {
      state.waiters.delete(w);
      signal?.removeEventListener?.('abort', w.cancel);
    };
    w.cancel = () => {
      cleanup();
      reject(cancelledError());
    };
    w.done = () => {
      cleanup();
      resolve();
    };
    state.waiters.add(w);
    signal?.addEventListener?.('abort', w.cancel, { once: true });
  });
}

function setSpeed(n) {
  const want = Number(n);
  const speed = Number.isFinite(want) ? SPEEDS.reduce((best, s) => (Math.abs(s - want) < Math.abs(best - want) ? s : best), SPEEDS[0]) : 1;
  state.speed = speed;
  state.paused = false; // picking a speed always means "run"
  return speed;
}

function pause() {
  state.paused = true;
}

function resume() {
  state.paused = false;
}

// ─── Presets ─────────────────────────────────────────────────────────────────

function reset(preset, seed) {
  for (const w of [...state.waiters]) w.cancel(); // waits from the old shift never resolve into the new one
  holds.clear();
  state.rng = mulberry32(Number.isFinite(seed) ? seed : Math.floor(Math.random() * 2 ** 32));
  state.preset = preset;
  state.t = 0;
  state.speed = 1;
  state.paused = false;
  state.kpis = emptyKpis();
  state.runningMinutes = 0;
  state.totalMinutes = 0;
  state.logs = [];
  state.history = new Map(MACHINES.map((m) => [m.id, []]));

  const initial = preset?.initial || {};
  for (const target of Object.keys(initial)) if (!findDef(target)) console.warn(`[sim] preset initial target not found: ${target}`);
  const [lo, hi] = preset?.randomize || [1, 1];
  state.parts = new Map();
  state.machines = new Map();
  for (const m of MACHINES) {
    for (const c of m.components) {
      const key = keyOf(m.id, c.id);
      const jitter = 0.8 + 0.4 * state.rng();
      const health = typeof initial[key] === 'number' ? initial[key] : lo + (hi - lo) * state.rng();
      state.parts.set(key, makePart(m.id, c, clamp(health, 0, 1), jitter));
    }
    state.machines.set(m.id, { def: m, maintenance: false, status: 'running', degraded: false, activeCodes: [] });
  }
  state.script = (preset?.script || []).map((ev) => ({ ...ev, at: Number(ev.at) || 0, fired: false, held: false })).sort((a, b) => a.at - b.at);
  state.quietSince = 0;
  state.nextGap = gapMinutes();

  if (preset) addLog('INFO', null, null, 'SHIFT', `Shift started: ${preset.name}`);
  for (const ev of state.script) if (ev.at <= EPS) applyScript(ev, 0);
  evaluate();
  recordHistory();
}

function findDef(target) {
  const [machineId, componentId] = String(target).split('/');
  return machineDefs.get(machineId)?.components.find((c) => c.id === componentId);
}

function loadPreset(presetId, opts) {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new Error(`Unknown preset ${presetId}`);
  reset(preset, opts?.seed);
  const { id, name, tagline, teaches } = preset;
  emit(EVENTS.SIM_PRESET, { preset: { id, name, tagline, teaches }, sim: snapshot() });
  fire('preset', { preset });
  return preset;
}

// ─── Actions (orchestrator + chaos) ──────────────────────────────────────────

function injectFault(machineId, componentId, mode = 'sudden') {
  const part = requirePart(machineId, componentId);
  if (busy()) {
    const err = new Error('One failure at a time: wait until the current repair is finished.');
    err.code = 'BUSY';
    err.status = 409;
    throw err;
  }
  if (mode === 'sudden') {
    part.health = 0;
  } else if (mode === 'gradual') {
    addRamp(part, 0, GRADUAL_FAULT_MIN);
  } else {
    throw new Error(`Unknown fault mode ${mode} (use 'sudden' or 'gradual')`);
  }
  // No log line: chaos is invisible, the plant only shows the symptoms.
  evaluate();
  return { machineId, componentId, mode };
}

function replaceComponent(machineId, componentId) {
  const part = requirePart(machineId, componentId);
  part.health = 1;
  part.ramps = [];
  part.warnSince = null;
  part.lastWarnT = null;
  part.fresh = true;
  addLog('INFO', machineId, componentId, 'MAINT', `Replaced ${part.def.name}`);
  evaluate();
  return { machineId, componentId, status: part.status };
}

function setMaintenance(machineId, on) {
  const m = requireMachine(machineId);
  if (m.maintenance === Boolean(on)) return m.status;
  m.maintenance = Boolean(on);
  evaluate();
  return m.status;
}

function machineStatus(machineId) {
  return state.machines.get(machineId)?.status ?? null;
}

function isHealthy(machineId) {
  const m = state.machines.get(machineId);
  return Boolean(m) && partsOf(machineId).every((p) => p.status !== 'fault');
}

function bump(key, amount) {
  if (!KPI_KEYS.includes(key)) return console.warn(`[sim] bump: unknown KPI ${key}`);
  const n = Number(amount);
  if (!Number.isFinite(n)) return;
  state.kpis[key] = roundTo(state.kpis[key] + n, 2);
}

function log(level, machineId, componentId, code, message) {
  return { ...addLog(level, machineId, componentId, code, message) };
}

// ─── Read models ─────────────────────────────────────────────────────────────

function lineRunning() {
  for (const m of state.machines.values()) if (m.status !== 'running') return false;
  return true;
}

function readingsOf(machineId) {
  const out = {};
  for (const part of partsOf(machineId)) {
    const readings = {};
    for (const sig of part.def.signals) readings[sig.key] = part.signals[sig.key]?.value ?? sig.nominal;
    out[part.def.id] = readings;
  }
  return out;
}

function recordHistory() {
  for (const m of MACHINES) {
    const hist = state.history.get(m.id);
    hist.push({ t: roundTo(state.t, 2), readings: readingsOf(m.id) });
    if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY);
  }
}

function snapshot() {
  const machines = {};
  for (const m of state.machines.values()) {
    const components = {};
    for (const part of partsOf(m.def.id)) {
      const readings = {};
      for (const sig of part.def.signals) readings[sig.key] = part.signals[sig.key]?.value ?? sig.nominal;
      components[part.def.id] = { status: part.status, readings };
    }
    machines[m.def.id] = { status: m.status, degraded: m.degraded, activeCodes: [...m.activeCodes], components };
  }
  const k = state.kpis;
  return {
    t: roundTo(state.t, 2),
    clock: clockAt(state.t),
    speed: state.speed,
    paused: state.paused,
    held: holds.size > 0, // clock held while Wrench-bot works in real time (not a user pause)
    preset: state.preset ? { id: state.preset.id, name: state.preset.name } : null,
    lineRunning: lineRunning(),
    machines,
    kpis: {
      unitsProduced: Math.round(k.unitsProduced),
      revenue: roundTo(k.revenue, 2),
      downtimeCost: roundTo(k.downtimeCost, 2),
      partsSpend: roundTo(k.partsSpend, 2),
      laborSpend: roundTo(k.laborSpend, 2),
      uptimePct: state.totalMinutes > 0 ? roundTo((state.runningMinutes / state.totalMinutes) * 100, 1) : 100,
      incidentsResolved: k.incidentsResolved,
    },
  };
}

/** The reading of a signal ~`minutesAgo` game-minutes back (or the oldest sample if the shift is younger). */
function pastReading(machineId, componentId, key, minutesAgo) {
  const hist = state.history.get(machineId) || [];
  const target = state.t - minutesAgo;
  let sample = null;
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i].t <= target + EPS) {
      sample = hist[i];
      break;
    }
  }
  sample = sample || hist[0];
  if (!sample || sample.t >= state.t - EPS) return null;
  const value = sample.readings[componentId]?.[key];
  return typeof value === 'number' ? { value, minutes: roundTo(state.t - sample.t, 2) } : null;
}

/** What the decision model reads: statuses, readings, thresholds, severities, trends. No health. */
function telemetryContext(machineId) {
  const m = state.machines.get(machineId);
  if (!m) return null;
  return {
    machineId,
    machine: m.def.name,
    status: m.status,
    degraded: m.degraded,
    activeCodes: [...m.activeCodes],
    t: roundTo(state.t, 2),
    clock: clockAt(state.t),
    parts: partsOf(machineId).map((part) => ({
      id: part.def.id,
      name: part.def.name,
      code: part.def.code,
      fault: part.def.fault,
      status: part.status,
      warnForMinutes: part.status === 'warn' && part.warnSince !== null ? roundTo(state.t - part.warnSince, 2) : 0,
      signals: part.def.signals.map((sig) => {
        const s = part.signals[sig.key] || { value: sig.nominal, status: 'ok' };
        const past = pastReading(machineId, part.def.id, sig.key, 10);
        return {
          key: sig.key,
          label: sig.label,
          unit: sig.unit,
          digits: sig.digits,
          value: s.value,
          nominal: sig.nominal,
          warn: sig.warn,
          fail: sig.fail,
          status: s.status,
          severity: roundTo(clamp((s.value - sig.nominal) / (sig.fail - sig.nominal), 0, 1.2), 3),
          trend10m: past ? roundTo(s.value - past.value, sig.digits) : 0,
          trendMinutes: past ? past.minutes : 0,
        };
      }),
    })),
  };
}

function recentLogs(opts) {
  const { machineId, limit = 20, minLevel } = opts || {};
  const min = minLevel ? LOG_LEVELS.indexOf(minLevel) : -1;
  let out = state.logs;
  if (machineId) out = out.filter((e) => e.machineId === machineId);
  if (min > 0) out = out.filter((e) => LOG_LEVELS.indexOf(e.level) >= min);
  const n = Number(limit);
  const count = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_LOGS) : 20;
  return out.slice(-count).map((e) => ({ ...e }));
}

function history(machineId) {
  return (state.history.get(machineId) || []).map((s) => ({ t: s.t, readings: s.readings }));
}

function warnings() {
  const out = [];
  for (const part of state.parts.values()) {
    if (part.status !== 'warn' || part.warnSince === null) continue;
    out.push({ machineId: part.machineId, componentId: part.def.id, since: part.warnSince, minutes: roundTo(state.t - part.warnSince, 2) });
  }
  return out;
}

const now = () => state.t;
const currentPreset = () => state.preset;

reset(null); // idle factory until a preset is loaded

export const sim = {
  busy, //               true while a failure is in progress (chaos and the scheduler wait)
  addBusyCheck, //       extra busy predicate, e.g. "an incident is still open"
  hold, //               hold(key, on): stop the game clock while the agent works in real time
  held,
  start,
  stop,
  step,
  loadPreset,
  setSpeed,
  pause,
  resume,
  injectFault,
  replaceComponent,
  setMaintenance,
  machineStatus,
  isHealthy,
  snapshot,
  telemetryContext,
  recentLogs,
  history,
  warnings,
  log,
  bump,
  waitMinutes,
  on,
  off,
  now,
  currentPreset,
};
