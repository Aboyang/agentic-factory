import express from 'express';
import { config } from './config.js';
import { MACHINES, PRESETS, EVENTS, LOG_LEVELS } from '../../shared/contract.js';
import { sseHandler, setSnapshot, emit } from './events.js';
import { isMockReap } from './reap/index.js';
import { reapMock } from './reap/mock.js';
import { sim } from './sim/engine.js';
import { getPolicy, updatePolicy, reset as resetPolicy, DEFAULT_POLICY } from './agent/policy.js';
import { startMonitor, retryIncident, resetIncidents, listIncidents, knownMerchants } from './agent/orchestrator.js';
import { TECHNICIANS } from './agent/technicians.js';
import { getCatalog, warmCatalog, searchOffers, findReplacement } from './catalog/catalog.js';
import { startTreasury, getTreasury, refreshTreasury, chainActive, chainOffReason } from './chain/treasury.js';
import { kwalRailEnabled } from './kwal/rail.js';

const BOOT_PRESET = 'first-failure';
const SPEEDS = [1, 2, 4, 8];

const app = express();
app.use(express.json({ limit: '1mb' }));

const mode = () => ({
  mockReap: isMockReap,
  mockAi: config.mockAi,
  enrolled: Boolean(config.reap.enrollmentId) || isMockReap,
  onchain: chainActive(),
  kwal: kwalRailEnabled(),
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
app.post('/api/sim/preset', (req, res) => {
  const id = req.body?.id;
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) return res.status(400).json({ error: `Unknown preset "${id}"`, presets: PRESETS.map((p) => p.id) });
  resetIncidents(); // cancelAll() + a clean board for the new shift
  const policy = resetPolicy(preset.policy);
  sim.loadPreset(preset.id);
  emit(EVENTS.POLICY_UPDATED, { policy });
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

// ─── Mock only: stand-in for Reap's hosted approval page ────────────────────
app.post('/api/mock/approve/:checkoutId', (req, res) => {
  if (!isMockReap) return res.status(400).json({ error: 'Only available in mock mode' });
  const co = reapMock.approve(req.params.checkoutId, req.body?.approve !== false);
  if (!co) return res.status(404).json({ error: 'unknown checkout' });
  res.json(co);
});

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

app.listen(config.port, () => {
  console.log(`Factory server on http://localhost:${config.port}`);
  console.log(`  Reap: ${isMockReap ? 'MOCK (offline catalog)' : 'LIVE sandbox'}${!isMockReap && !config.reap.enrollmentId ? '  ⚠ no REAP_ENROLLMENT_ID (run npm run reap:enroll -w server)' : ''}`);
  console.log(`  AI:   ${config.mockAi ? 'MOCK' : `OpenAI (${config.openai.model})`}`);
  console.log(`  Pay:  technicians ${chainActive() ? 'onchain USDC (Ink Sepolia)' : `simulated (${chainOffReason()})`}, parts ${kwalRailEnabled() ? 'Kwal vault then Reap card' : 'Reap card'}`);
  console.log(`  Sim:  "${BOOT_PRESET}" loaded, paused until a scenario is picked`);
  warm();
});
