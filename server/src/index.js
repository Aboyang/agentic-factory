import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { MACHINES, PRESETS, EVENTS, LOG_LEVELS } from '../../shared/contract.js';
import { sseHandler, setSnapshot, emit, clientCount } from './events.js';
import { isMockReap } from './reap/index.js';
import { reapMock } from './reap/mock.js';
import { sim } from './sim/engine.js';
import { getPolicy, updatePolicy, reset as resetPolicy, DEFAULT_POLICY } from './agent/policy.js';
import { startMonitor, retryIncident, resetIncidents, listIncidents, knownMerchants, approveDemo } from './agent/orchestrator.js';
import { startLedger, getLedger, clearLedger } from './agent/ledger.js';
import { TECHNICIANS } from './agent/technicians.js';
import { getCatalog, warmCatalog, searchOffers, findReplacement } from './catalog/catalog.js';
import { startTreasury, getTreasury, refreshTreasury, chainActive, chainOffReason } from './chain/treasury.js';
import { kwalRailEnabled } from './kwal/rail.js';

const BOOT_PRESET = 'first-failure';
const SPEEDS = [1, 2, 4, 8];
// Judge mode: nobody around this long → back to the first scenario (JUDGE_IDLE_MS for tests).
const IDLE_RESET_MS = Number(process.env.JUDGE_IDLE_MS) > 0 ? Number(process.env.JUDGE_IDLE_MS) : 10 * 60_000;
const GAME_DIST = fileURLToPath(new URL('../../game/dist', import.meta.url));

startLedger(); // before anything emits

const app = express();

// Judge mode idle reset: any request (except health checks) or open stream is activity.
let lastActivity = Date.now();
let idleResetDone = false;
app.use((req, res, next) => {
  if (req.path !== '/api/health') {
    lastActivity = Date.now();
    idleResetDone = false;
  }
  next();
});
app.use(express.json({ limit: '1mb' }));

const mode = () => ({
  mockReap: isMockReap,
  mockAi: config.mockAi,
  // Judge mode never charges the card, so it needs no enrollment.
  enrolled: Boolean(config.reap.enrollmentId) || isMockReap || config.judge,
  onchain: chainActive(),
  kwal: kwalRailEnabled(),
  judge: config.judge, // checkout simulated: show the offline approve/reject buttons
});
const presetInfo = ({ id, name, tagline, teaches }) => ({ id, name, tagline, teaches });
const machineById = (id) => MACHINES.find((m) => m.id === id);

// Stores the manager can trust: every store that sells a usable part, plus the policy's list.
const catalogMerchants = new Set();
function merchants() {
  const names = new Set([...DEFAULT_POLICY.allowedMerchants, ...getPolicy().allowedMerchants, ...catalogMerchants, ...knownMerchants()]);
  for (const m of getCatalog().machines) for (const c of m.components) if (c.best?.merchant) names.add(c.best.merchant);
  return [...names].sort((a, b) => a.localeCompare(b));
}

function state() {
  return {
    sim: sim.snapshot(),
    presets: PRESETS.map(presetInfo),
    machines: MACHINES,
    technicians: TECHNICIANS,
    policy: getPolicy(),
    incidents: listIncidents(),
    logs: sim.recentLogs({ limit: 200 }),
    catalog: getCatalog(),
    mode: mode(),
    merchants: merchants(),
    treasury: getTreasury(),
    ledger: getLedger({ limit: 200 }),
  };
}

setSnapshot(state);

app.get('/api/events', sseHandler);
app.get('/api/state', (req, res) => res.json(state()));
app.get('/api/health', (req, res) => res.json({ ok: true, ...mode() }));

// ─── Treasury (onchain wallet + Kwal vault) ─────────────────────────────────
// GET /api/treasury → the TREASURY_UPDATED payload; ?refresh=1 reads the chain now.
app.get('/api/treasury', async (req, res) => {
  if (req.query.refresh === '1') {
    try {
      return res.json(await refreshTreasury());
    } catch {
      // fall through to the last known state
    }
  }
  res.json(getTreasury());
});

// ─── Simulation ──────────────────────────────────────────────────────────────
// Loading a scenario resets the factory, the policy and the incident board.
function loadPreset(preset) {
  resetIncidents(); // cancelAll() + a clean board for the new shift
  const policy = resetPolicy(preset.policy);
  sim.loadPreset(preset.id);
  emit(EVENTS.POLICY_UPDATED, { policy });
}

app.post('/api/sim/preset', (req, res) => {
  const id = req.body?.id;
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) return res.status(400).json({ error: `Unknown preset "${id}"`, presets: PRESETS.map((p) => p.id) });
  loadPreset(preset);
  res.json({ ok: true, preset: presetInfo(preset) });
});

app.post('/api/sim/speed', (req, res) => {
  const speed = Number(req.body?.speed);
  if (!SPEEDS.includes(speed)) return res.status(400).json({ error: `speed must be one of ${SPEEDS.join(', ')}` });
  sim.setSpeed(speed);
  sim.resume();
  res.json({ ok: true, speed, paused: false });
});

app.post('/api/sim/pause', (req, res) => {
  sim.pause();
  res.json({ ok: true, paused: true });
});

app.post('/api/sim/resume', (req, res) => {
  sim.resume();
  res.json({ ok: true, paused: false });
});

// Chaos: break a part. The plant log shows only the symptoms; the monitor reacts.
app.post('/api/sim/fault', (req, res) => {
  const { machineId, componentId, mode: faultMode = 'sudden' } = req.body || {};
  const machine = machineById(machineId);
  if (!machine) return res.status(400).json({ error: `Unknown machine "${machineId}"` });
  if (!machine.components.some((c) => c.id === componentId)) return res.status(400).json({ error: `Unknown part "${componentId}" on the ${machine.name}` });
  if (!['sudden', 'gradual'].includes(faultMode)) return res.status(400).json({ error: 'mode must be "sudden" or "gradual"' });
  try {
    res.json({ ok: true, ...sim.injectFault(machineId, componentId, faultMode) });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
});

app.get('/api/sim/history/:machineId', (req, res) => {
  if (!machineById(req.params.machineId)) return res.status(404).json({ error: 'unknown machine' });
  res.json(sim.history(req.params.machineId));
});

// GET /api/sim/logs?machineId=arm&limit=50&minLevel=WARN
app.get('/api/sim/logs', (req, res) => {
  const machineId = req.query.machineId ? String(req.query.machineId) : undefined;
  if (machineId && !machineById(machineId)) return res.status(404).json({ error: 'unknown machine' });
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const minLevel = LOG_LEVELS.includes(req.query.minLevel) ? req.query.minLevel : undefined;
  res.json(sim.recentLogs({ machineId, limit, minLevel }));
});

// ─── Incidents (opened by the monitor, never by hand) ───────────────────────
app.get('/api/incidents', (req, res) => res.json(listIncidents()));
app.post('/api/incidents/:id/retry', (req, res) => {
  try {
    res.json(retryIncident(req.params.id));
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// ─── Policy (Manager's Desk) ─────────────────────────────────────────────────
app.get('/api/policy', (req, res) => res.json(getPolicy()));
app.put('/api/policy', (req, res) => {
  const policy = updatePolicy(req.body || {});
  emit(EVENTS.POLICY_UPDATED, { policy });
  res.json(policy);
});

// ─── Live catalog ────────────────────────────────────────────────────────────
const warm = () =>
  Promise.resolve(warmCatalog({ trusted: getPolicy().allowedMerchants, onUpdate: (catalog) => emit(EVENTS.CATALOG_UPDATED, { catalog }) }))
    .then(collectMerchants)
    .catch((err) => console.warn(`[catalog] warm-up failed: ${err.message}`));

// Every store with a usable listing for some part (searches are cached by now).
async function collectMerchants() {
  for (const m of MACHINES) {
    for (const c of m.components) {
      try {
        const found = await findReplacement(c, { useModel: false });
        for (const o of found.offers || []) if (o.merchant) catalogMerchants.add(o.merchant);
      } catch {
        // offline and uncached: skip this part
      }
    }
  }
}

app.get('/api/catalog', (req, res) => res.json(getCatalog()));
app.post('/api/catalog/refresh', (req, res) => {
  warm();
  res.json({ ok: true });
});
// GET /api/catalog/search?q=relay&merchant=Switch%20Electronics
app.get('/api/catalog/search', async (req, res) => {
  try {
    res.json(await searchOffers(String(req.query.q || ''), { merchant: req.query.merchant || undefined }));
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code });
  }
});
// GET /api/catalog/replacement/sorter/prox-sensor → what the agent would buy right now
app.get('/api/catalog/replacement/:machineId/:componentId', async (req, res) => {
  const component = machineById(req.params.machineId)?.components.find((c) => c.id === req.params.componentId);
  if (!component) return res.status(404).json({ error: 'unknown part' });
  try {
    res.json(await findReplacement(component, { trusted: getPolicy().allowedMerchants, useModel: req.query.model === '1' }));
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code });
  }
});

// ─── Manager ledger (dashboard history, kept across scenarios) ──────────────
app.get('/api/ledger', (req, res) => res.json(getLedger()));
app.post('/api/ledger/clear', (req, res) => {
  const ledger = clearLedger();
  emit('ledger.cleared', {}); // open dashboards empty their list
  res.json({ ok: true, ...ledger });
});

// ─── Mock / judge mode: stand-in for Reap's hosted approval page ────────────
app.post('/api/mock/approve/:checkoutId', (req, res) => {
  if (!isMockReap && !config.judge) return res.status(400).json({ error: 'Only available in mock or judge mode' });
  const approve = req.body?.approve !== false;
  const co = (config.judge && approveDemo(req.params.checkoutId, approve)) || (isMockReap && reapMock.approve(req.params.checkoutId, approve));
  if (!co) return res.status(404).json({ error: 'unknown checkout' });
  res.json(co);
});

app.use('/api', (req, res) => res.status(404).json({ error: `No route ${req.method} ${req.originalUrl}` }));

// ─── The built game (one service serves API + game, e.g. on Render) ─────────
if (fs.existsSync(path.join(GAME_DIST, 'index.html'))) {
  app.use(express.static(GAME_DIST));
  app.get('*', (req, res) => res.sendFile(path.join(GAME_DIST, 'index.html')));
}

// JSON errors instead of Express's HTML page (bad JSON bodies, thrown handlers).
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.type === 'entity.parse.failed' ? 400 : err.status || 500;
  if (status >= 500) console.error(`[api] ${req.method} ${req.path}:`, err);
  res.status(status).json({ error: status === 400 && err.type === 'entity.parse.failed' ? 'Invalid JSON body' : err.message });
});

// A stray rejection must never take the demo down.
process.on('unhandledRejection', (err) => console.error('[unhandled]', err));

// ─── Boot: idle factory, waiting for the player to pick a scenario ──────────
startMonitor();
resetPolicy(PRESETS.find((p) => p.id === BOOT_PRESET).policy);
sim.loadPreset(BOOT_PRESET);
sim.pause();
sim.start();
startTreasury();

// Judge mode: after 10 idle minutes, cancel everything and wait on the first scenario.
if (config.judge) {
  setInterval(() => {
    if (clientCount() > 0) {
      lastActivity = Date.now();
      idleResetDone = false;
      return;
    }
    if (idleResetDone || Date.now() - lastActivity < IDLE_RESET_MS) return;
    idleResetDone = true;
    try {
      loadPreset(PRESETS.find((p) => p.id === BOOT_PRESET));
      sim.pause();
      console.log(`[judge] idle for ${IDLE_RESET_MS / 60_000} min: back to "${BOOT_PRESET}", paused`);
    } catch (err) {
      console.error('[judge] idle reset failed:', err);
    }
  }, Math.min(30_000, IDLE_RESET_MS / 2)).unref();
}

app.listen(config.port, '0.0.0.0', () => {
  console.log(`Factory server on http://localhost:${config.port}`);
  console.log(`  Reap: ${isMockReap ? 'MOCK (offline catalog)' : 'LIVE sandbox'}${!isMockReap && !config.reap.enrollmentId ? '  ⚠ no REAP_ENROLLMENT_ID (run npm run reap:enroll -w server)' : ''}`);
  console.log(`  AI:   ${config.mockAi ? 'MOCK' : `OpenAI (${config.openai.model})`}`);
  console.log(`  Pay:  technicians ${chainActive() ? 'onchain USDC (Ink Sepolia)' : `simulated (${chainOffReason()})`}, parts ${config.judge ? 'demo checkout (judge mode)' : kwalRailEnabled() ? 'Kwal vault then Reap card' : 'Reap card'}`);
  console.log(`  Sim:  "${BOOT_PRESET}" loaded, paused until a scenario is picked`);
  if (config.judge) console.log(`  Judge mode: Reap checkout simulated, idle reset after ${Math.round(IDLE_RESET_MS / 1000)} s`);
  if (fs.existsSync(path.join(GAME_DIST, 'index.html'))) console.log(`  Game: serving ${GAME_DIST}`);
  warm();
});
