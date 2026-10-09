# Wrench-bot Factory — Simulation spec

Source of truth for every module. Data definitions live in `shared/contract.js`
(MACHINES with signals/effects, PRESETS, EVENTS, LOG_LEVELS). Read it first.

Stack: Node 20 ESM + Express (server/), Vite + Three.js 0.169 (game/), no other
dependencies. Never edit `.env`. Never add npm packages.

```
server/src/
  index.js              HTTP API + SSE                         (Builder B)
  config.js events.js   existing, keep                         (shared, don't change signatures)
  sim/engine.js         simulation: health, signals, logs, KPIs (Builder A)  NEW
  sim/diagnostics.js    heuristic "System 1" diagnosis          (Builder A)  NEW
  agent/orchestrator.js incident pipeline + monitor             (Builder B)
  agent/decide.js       decision model providers                (Builder B)
  agent/policy.js       hard spending limits                    (Builder B)
  agent/technicians.js  existing, keep
  catalog/*             live Reap catalog — existing, keep      (nobody)
  reap/*                Reap client/mock/purchase — keep        (nobody)
game/src/
  main.js director.js   wiring                                  (Builder C2)
  ui/*                  DOM overlay                             (C1 + C2, split below)
  world/*               Three.js world                          (Builder D)
```

---

## 1. Time

- The sim ticks every **1000 ms real time**. Each tick advances `dt = speed` game-minutes
  (`speed` ∈ {1, 2, 4, 8}; default 1). When paused, ticks advance nothing.
- `t` = game minutes since shift start. `clock` = `HH:MM` starting at **08:00** (`08:00 + t`).
- All agent waits that represent real-world time (delivery, technician travel, repair,
  verification) use **game minutes** via `sim.waitMinutes(n)` so they respect speed/pause.
  Short animation pauses (robot walking) may use real `setTimeout` (≤ 2.5 s).

## 2. Part model (engine.js)

Each part has hidden state: `health ∈ [0, 1]` (1 = new). **Health is never sent to the
game or the decision model** — they only see signals and logs, like a real plant.

### Degradation curve
```
d(h) = clamp((0.7 - h) / 0.7, 0, 1) ** 1.6        // 0 while h ≥ 0.7, 1 at h = 0
```
### Signal value
For signal `s` of part `c` on machine `m`:
```
frac  = d(c.health) + Σ over every part p on m with effect {target: c.id, signal: s.key}: weight × d(p.health)
frac  = min(frac, 1.15)
value = s.nominal + (s.fail - s.nominal) × frac + noise
noise = gaussian-ish, σ = 0.8% × |s.fail - s.nominal|  (sum of 3 uniforms is fine)
clamp: never below 0 for %, rpm, V, mA, mΩ, ms, dB, mm/s, °C; % never above 100
```
Round displayed values to `s.digits`.

### Status (computed from the NOISELESS frac — no flapping)
```
warnFrac(s) = (s.warn - s.nominal) / (s.fail - s.nominal)
signal status: 'fault' if frac ≥ 0.97, else 'warn' if frac ≥ warnFrac(s), else 'ok'
part status   = worst of its signals
machine.status:
  'maintenance'  if the orchestrator set it (sim.setMaintenance)
  'down'         else if any part status is 'fault'
  'running'      otherwise
machine.degraded = any part status 'warn' (and not down)
machine.activeCodes = codes of parts currently in 'fault'
```
Note: a fault caused only by an *effect* is attributed to the part that owns the signal
(e.g. the servo faults because the PSU sags). That is intended.

### Wear
Each tick, for every part: `health -= dt × preset.wear × (1 / part.life) × jitter`,
jitter ∈ [0.8, 1.2] (fixed per part per preset load). `health` never below 0.
Scripted events (from the preset) apply on the tick where `t` crosses `at`:
- `{ at, target, health }` → set health immediately.
- `{ at, target, degradeTo, over }` → linear decline from current health to `degradeTo`
  over `over` minutes (store as an active ramp on the part; ramps are cancelled when the
  part is replaced).

### Replacement
`sim.replaceComponent(machineId, componentId)` → health = 1, cancel ramps on that part,
reset its warn timer, log INFO `Replaced <part name>`.

### Production + KPIs
- Line runs only if **every** machine status is `'running'`.
- Running: `unitsProduced += 12 × dt`, `revenue += 12 × dt × 5` (USD).
- For every machine not `'running'`: `downtimeCost += machine.downtimeCostPerMin × dt`.
- `uptimePct = runningMinutes / totalMinutes × 100` (line-level).
- `partsSpend`, `laborSpend`, `incidentsResolved` are bumped by the orchestrator through
  `sim.bump(key, amount)`.

## 3. Plant log (engine.js)

Entry: `{ id, t, clock, level, machineId, componentId, code, message }`; levels from
`LOG_LEVELS`. Keep the last 500. Every new entry is emitted as `EVENTS.LOG_ENTRY` `{ entry }`.

Rules (the engine writes these automatically):
| When | Level | code | message example |
|---|---|---|---|
| part ok → warn | WARN | `W` + part code without `E` (e.g. `W-ARM-301`) | `24V rail 21.48 V (warn 23.2 V)` — name the worst signal |
| still warn, every 5 game-min | WARN | same | `24V rail 20.91 V, down 0.57 V in 5 min` (show trend) |
| part → fault | FAULT | part.code | `Gripper position error — Position error 6.12° (limit 5°)` |
| part fault cleared | INFO | part.code | `E-ARM-310 cleared` |
| machine running → down | ERROR | `M-DOWN` | `Robot Arm stopped: E-ARM-310` |
| machine down/maint → running | INFO | `M-UP` | `Robot Arm running` |
| part replaced | INFO | `MAINT` | `Replaced Gripper servo` |
| preset loaded | INFO | `SHIFT` | `Shift started: Brownout` |
`sim.log(level, machineId, componentId, code, message)` is public — the orchestrator uses
level `AGENT` for its own actions (`Ordered 2× FT5320M servo from Switch Electronics ($93.15)`).

## 4. Engine public API (`server/src/sim/engine.js`)

```js
import { sim } from './sim/engine.js'
sim.start()                         // begins the 1 s tick loop (idempotent)
sim.loadPreset(presetId)            // reset parts/KPIs/logs/clock, apply initial/randomize/script, paused=false, speed=1
                                    // emits EVENTS.SIM_PRESET { preset: {id,name,tagline,teaches}, sim: snapshot() }
                                    // returns the preset object. Throws on unknown id.
sim.setSpeed(n)  sim.pause()  sim.resume()
sim.injectFault(machineId, componentId, mode)  // mode 'sudden' → health 0; 'gradual' → ramp to 0 over 12 min
sim.replaceComponent(machineId, componentId)
sim.setMaintenance(machineId, on)   // on=true forces status 'maintenance' (planned stop)
sim.machineStatus(machineId)        // 'running' | 'down' | 'maintenance'
sim.isHealthy(machineId)            // true if no part in 'fault'
sim.snapshot()                      // see "Snapshot" below (no health values!)
sim.telemetryContext(machineId)     // see below — what the decision model reads
sim.recentLogs({ machineId, limit = 20, minLevel }) // newest last
sim.history(machineId)              // last 120 samples: [{ t, readings: { componentId: { key: value } } }]
sim.warnings()                      // [{ machineId, componentId, since, minutes }] parts currently in warn
sim.log(level, machineId, componentId, code, message)
sim.bump(key, amount)               // KPI counters: partsSpend, laborSpend, incidentsResolved
sim.waitMinutes(n, { signal })      // Promise resolving after n game-minutes; rejects with Error('cancelled') if
                                    // signal.aborted (AbortSignal) — check each tick
sim.on(name, fn) / sim.off(name, fn)  // internal events:
   'tick'          (snapshot)
   'machine.down'  ({ machineId, codes })
   'machine.up'    ({ machineId })
   'part.warn'     ({ machineId, componentId })
   'preset'        ({ preset })
```
Every tick the engine also emits `EVENTS.SIM_TICK { sim: snapshot() }` over SSE.
On boot `index.js` calls `sim.loadPreset('first-failure')` then `sim.pause()` so nothing
happens until a player picks a scenario.

### Snapshot
```js
{
  t, clock, speed, paused,
  preset: { id, name },
  lineRunning: boolean,
  machines: {
    [machineId]: {
      status: 'running'|'down'|'maintenance', degraded: boolean, activeCodes: [string],
      components: { [componentId]: { status: 'ok'|'warn'|'fault', readings: { [signalKey]: number } } }
    }
  },
  kpis: { unitsProduced, revenue, downtimeCost, partsSpend, laborSpend, uptimePct, incidentsResolved }
}
```

### telemetryContext(machineId)
```js
{
  machine: 'Robot Arm', status: 'down', activeCodes: ['E-ARM-310'],
  parts: [{
    id: 'arm-psu', name: '24V power supply', status: 'warn', warnForMinutes: 4,
    signals: [{ label: '24V rail', unit: 'V', value: 20.61, nominal: 24.1, warn: 23.2, fail: 19.5,
                severity: 0.76,          // (value - nominal) / (fail - nominal), clamped 0..1.2
                trend10m: -1.9 }]        // value now minus value 10 game-min ago (0 if no history)
  }, ...]
}
```

## 5. Diagnostics heuristic (`server/src/sim/diagnostics.js`)

A fast, honest "System 1" prior computed only from what the plant shows (signals + log),
never from hidden health. Used as the decision model's prior and as the offline mock.
```js
export function scoreComponents(machineId, { ruledOut = [] } = {})
  → { probabilities: { [partName]: p },              // over candidate parts (not ruled out), sums to 1
      ranking: [{ componentId, name, score, evidence: [string] }],   // best first
      evidence: [string] }                            // top part's evidence, ≤ 4 lines
```
Score per candidate part: `0.6 × maxSeverity(own signals) + 0.4 × (part has an active FAULT code ? 1 : 0)`.
Probabilities: softmax(score / 0.25). Evidence strings, most important first, e.g.
`FAULT E-ARM-310 Gripper position error`, `Position error 6.12° (limit 5°)`,
`24V rail 20.61 V, falling 1.9 V in 10 min`.
This heuristic is deliberately naive: it trusts fault codes, so in the Brownout preset it
blames the servo first. The orchestrator recovers by re-diagnosing after a failed fix.

## 6. Agent (Builder B)

### Monitor (orchestrator.js)
- `sim.on('machine.down')` → if the machine has no open incident → `startIncident({ machineId, kind: 'breakdown' })`.
- On every tick, if `policy.predictiveMaintenance` and a part on a **running** machine has been
  in warn ≥ 3 game-min (`sim.warnings()`), and that machine has no open incident →
  `startIncident({ machineId, kind: 'predictive', componentIds: [those parts] })`.
- Chaos never creates incidents directly; it injects faults into the sim and the monitor reacts.
- `cancelAll()` aborts every open incident (AbortController per incident); status `'cancelled'`,
  emit `INCIDENT_CANCELLED`. Called before a preset loads.
- `retryIncident(id)` restarts an `error`/`blocked` incident (keeps existing behaviour).
- Remove the old `truth` map and the `hint` peeking. Ground truth is the sim.

### Incident object (sent in INCIDENT_CREATED and STATE)
`{ id, kind: 'breakdown'|'predictive', machineId, title, codes, status, step, attempts, spent, startedAt (game t) }`
`status`: open | resolved | error | blocked | cancelled. `step`: diagnosing | sourcing | quoting |
approval | shipping | repairing | verifying | done. Title: breakdown → `Robot Arm down: E-ARM-310 Gripper position error`;
predictive → `Conveyor: Roller bearing wearing (vibration 5.1 mm/s)`.

### Pipeline per attempt (max 3 attempts)
1. AGENT_THINKING (walk over, ≤ 2.5 s real).
2. **Diagnose**: `prior = scoreComponents(machineId, { ruledOut })`; candidates = parts not ruled out
   (predictive: only the warned parts). `decide({ kind:'choice', options: candidate names, context: {
   machine, kind, telemetry: sim.telemetryContext(id), log: sim.recentLogs({machineId, limit: 20}) as text lines
   "[08:14] FAULT E-ARM-310 …", prior: prior.probabilities, ruledOut } })`.
   Emit AGENT_DIAGNOSIS with `evidence` = the chosen part's evidence from `prior.ranking`
   (plus the model explanation via `say()`). `sim.log('AGENT', …, 'DIAG', 'Diagnosis: <part> (87%)')`.
3. **Source**: existing `findReplacement` + CATALOG_RESULTS (keep).
4. **Quote**: existing `quoteWithFallback` (keep).
5. **Policy**: confidence = min(diagnosis, listing choice). Keep evaluate/BLOCK/ESCALATE/AUTO.
6. **Pay**: keep. On success `sim.bump('partsSpend', amount)` and AGENT log `Ordered …`.
7. **Ship**: `etaMinutes = express ? 3 : 6`; emit DELIVERY_DISPATCHED `{ etaMinutes, shipping }`;
   `await sim.waitMinutes(etaMinutes)`; DELIVERY_ARRIVED.
8. **Repair**: pick technician (decide, mock via skills). Escrow lock, TECH_DISPATCHED;
   `waitMinutes(2)` (travel); `sim.setMaintenance(machineId, true)`; TECH_REPAIRING `{ minutes: 4, componentId }`;
   `waitMinutes(4)`; `sim.replaceComponent(...)`; PART_REPLACED `{ machineId, componentId }`;
   `sim.setMaintenance(machineId, false)`; ESCROW_RELEASED; `sim.bump('laborSpend', technician.rate)`.
9. **Verify**: `waitMinutes(2)`, then `healthy = sim.isHealthy(machineId)`; `decide({ kind:'yesno', context: { telemetry, log, prior: { yes: healthy?0.95:0.05, no: … } } })`.
   Healthy → INCIDENT_RESOLVED `{ summary: { spent, orderId, technician, attempts, downtimeMin, approval, kind } }`,
   `sim.bump('incidentsResolved', 1)`. Not healthy → AGENT log + AGENT_THINKING
   `Still faulting. The <part> wasn't the root cause — re-diagnosing.`, rule it out, next attempt.
- Every `await` honours the incident's AbortSignal (cancelled → stop quietly).
- Predictive incidents follow the same steps; the machine only stops during the repair (`setMaintenance`).
  If the machine breaks down while a predictive incident is open, the monitor must NOT open a second one.

### decide.js
- Mock provider: if `req.context.prior` is given, use it (map onto options; missing options get 0.01)
  and return its normalized probabilities. Else keep the existing hint logic (used for technician choice).
- GPT provider: keep; the context now includes telemetry + log + prior, so it can override the prior.
- Keep the provider order (Decisions API stub → Jev stub → GPT → mock).

### policy.js
- Add `predictiveMaintenance` (bool). Add `reset(overrides)` that restores defaults then applies a
  preset's `policy` (including `spent` and `allowedMerchants`). `updatePolicy` accepts
  `predictiveMaintenance` and `allowedMerchants` (array of strings) too.

### index.js API
```
GET  /api/events                     SSE
GET  /api/state                      same object as the SSE STATE event
POST /api/sim/preset   { id }        orchestrator.cancelAll(); policy.reset(preset.policy); sim.loadPreset(id);
                                     emit POLICY_UPDATED; returns { ok, preset }
POST /api/sim/speed    { speed }     1|2|4|8 (also resumes)
POST /api/sim/pause | /api/sim/resume
POST /api/sim/fault    { machineId, componentId, mode }   chaos
GET  /api/sim/history/:machineId     sim.history()
GET  /api/sim/logs?machineId=&limit= sim.recentLogs()
PUT  /api/policy, GET /api/policy, catalog endpoints, retry, mock approve — keep.
Remove POST /api/incidents (incidents now come from the monitor).
```
STATE payload:
`{ sim: snapshot, presets: PRESETS.map(({id,name,tagline,teaches}) => ...), machines: MACHINES, technicians,
   policy, incidents: [all incidents], logs: sim.recentLogs({ limit: 200 }), catalog, mode: { mockReap, mockAi, enrolled },
   merchants: unique merchant names seen in the catalog plus policy.allowedMerchants }`

---

## 7. Game

### World API (Builder D owns `game/src/world/*`) — director calls only these
```js
world.setMachines(defs)                         // build once from MACHINES
world.setMachineStatus(id, status, degraded)    // 'running'|'down'|'maintenance'
world.setLineRunning(running)                   // belt items flow only when true
world.robotGoTo(place)                          // machine id | 'terminal' | 'home' | 'dock'
world.robotThinking(on)                         // "?" over the robot
world.spawnTruck(etaSeconds)                    // drives in, arrives at the dock after etaSeconds, drops a crate, leaves
world.technicianArrive(machineId, tech)         // tech = { name, color }; walks in from the door to the machine
world.technicianWork(on)                        // working animation + sparks
world.technicianLeave()                         // walks back out and disappears
world.partReplaced(machineId)                   // celebratory burst; removes the delivered crate
world.focusMachine(id | null)                   // selection ring on the floor
world.onMachineClick(fn)                        // fn(machineId) on click (raycast); pointer cursor on hover
world.screenPos(name)                           // 'robot' | machineId → { x, y } CSS px, or null
```
Visual states: running = animated + green lamp; degraded = amber lamp + occasional smoke puffs;
down = red blinking lamp, frozen animation, sparks, slight shake; maintenance = blue lamp, still.
Keep the low-res pixel look (render at 1/3 resolution, `image-rendering: pixelated`), isometric
orthographic camera, Nord-ish palette. Add a back wall with windows, safety floor markings, a loading
dock (+x side, near z=6) with a roll-up door, an entrance door for technicians, the procurement terminal.

### UI (DOM overlay, `game/src/ui/*`)
Builder C1 owns `hud.js scenarios.js plantlog.js inspector.js ui-shell.css`.
Builder C2 owns `UI.js agentpanel.js desk.js chaos.js catalogpanel.js ui.css ui-agent.css`, plus
`game/src/director.js`, `game/src/main.js`, `game/index.html`.

C1 module interfaces (C2 composes them inside UI.js):
```js
export class Hud {            // top bar
  constructor(root, { api, onScenarios })      // api = (method, path, body) => Promise
  update(sim, policy)                          // clock, preset name, KPIs, budget bar, speed buttons state
  setMode(mode)                                // { mockReap, mockAi, enrolled } badges
}
export class ScenarioPicker { // full-screen overlay with one card per preset
  constructor(root, { presets, onPick })       // onPick(presetId)
  show(), hide(), setMode(mode)
}
export class PlantLog {       // bottom console, PLC style
  constructor(root)
  load(entries), add(entry)                    // filters: ALL | WARN+ | AGENT, per-machine filter, autoscroll, max 400 rows
}
export class Inspector {      // machine cards + detail of the selected machine
  constructor(root, { machines, onSelect })    // machines = MACHINES (signals with thresholds)
  update(sim)                                  // called every tick; keeps a client-side history (last 90 samples) per signal
  select(machineId)                            // expand that machine (also called when the 3D machine is clicked)
  loadHistory(machineId, history)              // seed from GET /api/sim/history/:id
}
```
Inspector detail per part: name, status chip (OK/WARN/FAULT), each signal value + unit, a threshold bar
(nominal → warn → fail with the current value marked), a tiny sparkline canvas. Header: machine status chip
(RUNNING/DEGRADED/DOWN/MAINTENANCE) and active fault codes. This panel = "what the decision model sees".

C2 responsibilities:
- `director.js`: maps every EVENTS type to world + UI calls (use only the World API above). On SIM_TICK:
  `world.setMachineStatus` for each machine, `world.setLineRunning(sim.lineRunning)`, `ui.updateSim(sim)`.
  Truck: `world.spawnTruck(etaMinutes / sim.speed)` (1 game-minute = 1/speed seconds). Technician:
  TECH_DISPATCHED → technicianArrive, TECH_REPAIRING → technicianWork(true), PART_REPLACED → partReplaced + technicianWork(false),
  ESCROW_RELEASED → technicianLeave. Robot: incident created → robotGoTo(machine); AGENT_SEARCHING → 'terminal';
  DELIVERY_ARRIVED → 'dock'; resolved/error/cancelled → 'home'. SIM_PRESET → reset everything (clear panels, reload state via GET /api/state).
- `agentpanel.js` (left column): current incident card — kind badge (BREAKDOWN / PREDICTIVE), title, a step
  tracker (Diagnose → Source → Quote → Approve → Ship → Repair → Verify), diagnosis with probability bars and
  the evidence lines it used, the catalog listings (image, name, store, price, probability; chosen highlighted),
  quote breakdown, policy verdict, retry button on error. Tabs if several incidents are open.
- Approval modal (live: link to Reap's page; mock: approve/reject buttons → POST /api/mock/approve/:id).
- `desk.js` Manager's Desk: auto-approve slider, monthly budget slider, confidence slider, predictive-maintenance
  toggle, trusted-store checkboxes (from STATE.merchants) → PUT /api/policy.
- `chaos.js`: machine + part selects, mode (sudden / gradual), BREAK button → POST /api/sim/fault.
- `catalogpanel.js`: the existing live spare-parts list (move it out of UI.js).
- Speech bubble that follows the robot; floating text over a machine when it goes down ("DOWN −$40/min"),
  comes back ("RUNNING"), or a part is replaced ("PART REPLACED"); toasts for orders/approvals.
- Layout at 1280×720 and up: HUD top, agent panel left, inspector + desk/chaos/catalog tabs right, plant log
  bottom-center, 3D world visible in the middle. Pixel aesthetic (Press Start 2P for titles, VT323 for text).
