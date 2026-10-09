// Shared contract between the game (browser) and the server.
// The simulation, the agent and the game all read this file.
// See docs/SIM_SPEC.md for how the simulation uses these definitions.

// ─── Signals ─────────────────────────────────────────────────────────────────
// Every part reports sensor signals. A reading moves from `nominal` toward
// `fail` as the part degrades. Crossing `warn` writes a WARN line to the plant
// log; reaching `fail` is a FAULT and stops the machine.
//   { key, label, unit, nominal, warn, fail, digits }
// `effects` on a part push OTHER parts' signals toward fail as this part
// degrades (e.g. a sagging power supply makes the servo lose position).
// This is what makes diagnosis non-trivial: the part throwing the FAULT is
// not always the part that is broken.

// ─── Machines and their parts ────────────────────────────────────────────────
// Part catalog fields (used by the live Reap catalog search):
//   query, keywords, maxPrice, qty
// Simulation fields:
//   life      mean game-minutes from new to failure under normal wear
//   code      fault code written to the plant log when this part faults
//   fault     fault message
//   signals   sensor channels
//   effects   [{ target: componentId, signal: key, weight }]
export const MACHINES = [
  {
    id: 'conveyor',
    name: 'Conveyor',
    pos: [-6, 0],
    critical: false,
    downtimeCostPerMin: 30,
    components: [
      {
        id: 'drive-motor', name: 'Drive stepper motor', query: 'NEMA 17 stepper motor', keywords: [['stepper'], ['motor']], maxPrice: 80, qty: 1,
        life: 900, code: 'E-CNV-110', fault: 'Drive motor stalled',
        signals: [
          { key: 'motorTemp', label: 'Motor temp', unit: '°C', nominal: 45, warn: 62, fail: 90, digits: 0 },
          { key: 'beltSpeed', label: 'Belt speed', unit: 'm/s', nominal: 0.5, warn: 0.4, fail: 0.1, digits: 2 },
        ],
      },
      {
        id: 'motor-driver', name: 'Motor driver board', query: 'stepper motor driver board', keywords: [['driver'], ['motor', 'stepper']], maxPrice: 60, qty: 1,
        life: 1200, code: 'E-CNV-120', fault: 'Motor driver not responding',
        signals: [
          { key: 'driverTemp', label: 'Driver temp', unit: '°C', nominal: 40, warn: 58, fail: 85, digits: 0 },
          { key: 'stepRate', label: 'Step rate', unit: '%', nominal: 100, warn: 88, fail: 20, digits: 0 },
        ],
        effects: [{ target: 'drive-motor', signal: 'beltSpeed', weight: 0.9 }],
      },
      {
        id: 'roller-bearing', name: 'Roller bearing', query: 'ball bearing 608', keywords: [['bearing']], maxPrice: 20, qty: 4,
        life: 700, code: 'E-CNV-130', fault: 'Roller seized',
        signals: [
          { key: 'vibration', label: 'Vibration', unit: 'mm/s', nominal: 1.8, warn: 4.0, fail: 9.0, digits: 1 },
          { key: 'noise', label: 'Noise', unit: 'dB', nominal: 62, warn: 70, fail: 88, digits: 0 },
        ],
        effects: [{ target: 'drive-motor', signal: 'motorTemp', weight: 0.4 }],
      },
      {
        id: 'main-fuse', name: 'Main fuse', query: '5x20mm glass fuse 5A', keywords: [['fuse']], maxPrice: 10, qty: 5,
        life: 3000, code: 'E-CNV-101', fault: 'Main power lost (fuse open)',
        signals: [{ key: 'busVoltage', label: 'Bus voltage', unit: 'V', nominal: 24, warn: 22.5, fail: 0, digits: 1 }],
        effects: [{ target: 'drive-motor', signal: 'beltSpeed', weight: 1.0 }],
      },
    ],
  },
  {
    id: 'sorter',
    name: 'Sorter',
    pos: [-2, 0],
    critical: true,
    downtimeCostPerMin: 40,
    components: [
      {
        id: 'prox-sensor', name: 'Inductive proximity sensor', query: 'inductive proximity sensor M18', keywords: [['proximity'], ['sensor']], maxPrice: 80, qty: 1,
        life: 800, code: 'E-SRT-201', fault: 'Item sensor: no signal',
        signals: [
          { key: 'sensorSignal', label: 'Sensor signal', unit: '%', nominal: 96, warn: 70, fail: 8, digits: 0 },
          { key: 'detectRate', label: 'Detect rate', unit: '%', nominal: 99.5, warn: 95, fail: 20, digits: 1 },
        ],
      },
      {
        id: 'relay-board', name: 'Relay board', query: '24V relay board module', keywords: [['relay']], maxPrice: 60, qty: 1,
        life: 1000, code: 'E-SRT-220', fault: 'Diverter relay not switching',
        signals: [
          { key: 'contactRes', label: 'Contact resistance', unit: 'mΩ', nominal: 45, warn: 140, fail: 600, digits: 0 },
          { key: 'gateFire', label: 'Gate fire success', unit: '%', nominal: 100, warn: 96, fail: 10, digits: 1 },
        ],
      },
      {
        id: 'limit-switch', name: 'Gate limit switch', query: 'roller arm industrial limit switch', keywords: [['limit'], ['switch']], maxPrice: 40, qty: 1,
        life: 1100, code: 'E-SRT-230', fault: 'Gate position timeout',
        signals: [{ key: 'switchResponse', label: 'Switch response', unit: 'ms', nominal: 14, warn: 40, fail: 250, digits: 0 }],
        effects: [{ target: 'relay-board', signal: 'gateFire', weight: 0.5 }],
      },
      {
        id: 'indicator-light', name: 'Status indicator light', query: '22mm LED pilot indicator light', keywords: [['indicator', 'pilot'], ['light', 'led']], maxPrice: 15, qty: 2,
        life: 1500, code: 'E-SRT-240', fault: 'Status lamp failed',
        signals: [{ key: 'lampCurrent', label: 'Lamp current', unit: 'mA', nominal: 20, warn: 14, fail: 0, digits: 1 }],
      },
    ],
  },
  {
    id: 'arm',
    name: 'Robot Arm',
    pos: [2, 0],
    critical: true,
    downtimeCostPerMin: 60,
    components: [
      {
        id: 'gripper-servo', name: 'Gripper servo', query: 'high torque digital servo', keywords: [['servo']], maxPrice: 120, qty: 2,
        life: 700, code: 'E-ARM-310', fault: 'Gripper position error',
        signals: [
          { key: 'posError', label: 'Position error', unit: '°', nominal: 0.4, warn: 1.5, fail: 5.0, digits: 2 },
          { key: 'servoTemp', label: 'Servo temp', unit: '°C', nominal: 42, warn: 58, fail: 80, digits: 0 },
        ],
      },
      {
        id: 'arm-psu', name: '24V power supply', query: '24V switching power supply', keywords: [['power supply', 'psu'], ['24v']], maxPrice: 120, qty: 1,
        life: 1400, code: 'E-ARM-301', fault: '24V rail collapsed',
        signals: [
          { key: 'railVoltage', label: '24V rail', unit: 'V', nominal: 24.1, warn: 23.2, fail: 19.5, digits: 2 },
          { key: 'ripple', label: 'Ripple', unit: 'mV', nominal: 35, warn: 120, fail: 450, digits: 0 },
        ],
        // A sagging rail starves the servo first: its position error crosses
        // FAULT while the supply itself only shows WARN. Classic misdiagnosis.
        effects: [
          { target: 'gripper-servo', signal: 'posError', weight: 1.6 },
          { target: 'arm-driver', signal: 'jointSpeed', weight: 0.5 },
        ],
      },
      {
        id: 'estop', name: 'Emergency stop button', query: 'emergency stop push button switch', keywords: [['emergency', 'e-stop'], ['stop']], maxPrice: 60, qty: 1,
        life: 2500, code: 'E-ARM-350', fault: 'Safety loop open (E-stop)',
        signals: [{ key: 'safetyLoop', label: 'Safety loop', unit: '%', nominal: 100, warn: 92, fail: 0, digits: 0 }],
      },
      {
        id: 'arm-driver', name: 'Motor driver', query: 'L298N motor driver module', keywords: [['driver']], maxPrice: 40, qty: 1,
        life: 1000, code: 'E-ARM-320', fault: 'Base joint driver fault',
        signals: [
          { key: 'armDriverTemp', label: 'Driver temp', unit: '°C', nominal: 41, warn: 60, fail: 88, digits: 0 },
          { key: 'jointSpeed', label: 'Joint speed', unit: '%', nominal: 100, warn: 85, fail: 15, digits: 0 },
        ],
      },
    ],
  },
  {
    id: 'packer',
    name: 'Packer',
    pos: [6, 0],
    critical: false,
    downtimeCostPerMin: 35,
    components: [
      {
        id: 'net-switch', name: 'Network switch', query: 'gigabit PoE network switch', keywords: [['switch'], ['gigabit', 'poe', 'ethernet', 'network']], maxPrice: 400, qty: 1,
        life: 2000, code: 'E-PCK-410', fault: 'Packer controller offline',
        signals: [
          { key: 'packetLoss', label: 'Packet loss', unit: '%', nominal: 0.1, warn: 2, fail: 40, digits: 1 },
          { key: 'latency', label: 'Latency', unit: 'ms', nominal: 2, warn: 25, fail: 400, digits: 0 },
        ],
      },
      {
        id: 'cooling-fan', name: 'Cooling fan', query: '120mm 12V cooling fan', keywords: [['fan']], maxPrice: 30, qty: 2,
        life: 600, code: 'E-PCK-420', fault: 'Cabinet over-temperature',
        signals: [
          { key: 'fanRpm', label: 'Fan speed', unit: 'rpm', nominal: 2400, warn: 1700, fail: 0, digits: 0 },
          { key: 'cabinetTemp', label: 'Cabinet temp', unit: '°C', nominal: 34, warn: 46, fail: 68, digits: 0 },
        ],
        // A hot cabinet makes the switch drop packets.
        effects: [{ target: 'net-switch', signal: 'packetLoss', weight: 0.7 }],
      },
      {
        id: 'barcode-scanner', name: 'Barcode scanner', query: 'barcode scanner', keywords: [['barcode', 'scanner']], maxPrice: 400, qty: 1,
        life: 1600, code: 'E-PCK-430', fault: 'Label verification failed',
        signals: [{ key: 'readRate', label: 'Read rate', unit: '%', nominal: 99.2, warn: 94, fail: 25, digits: 1 }],
      },
    ],
  },
];

// ─── Scenario presets ────────────────────────────────────────────────────────
// Loading a preset resets the factory, the policy and the shift clock.
//   policy     overrides for the Manager's Desk (see server/src/agent/policy.js)
//   initial    starting health per 'machine/component' (default 1.0)
//   wear       > 0 enables the failure scheduler (Free play): one random failure at a time
//   failureEvery [min, max] calm game-minutes before the scheduler starts the next failure
//   script     timed events, `at` in game minutes:
//                { at, target: 'machine/component', health }            sudden change
//                { at, target, degradeTo, over }                         linear decline over N minutes
export const PRESETS = [
  {
    id: 'first-failure',
    name: 'Sensor burnout',
    tagline: 'One cheap part dies. Watch the agent fix it alone.',
    teaches: 'Auto-approve: a $15 sensor is under the limit, so Wrench-bot buys it without asking.',
    policy: { autoApproveLimit: 60, monthlyBudget: 1000, spent: 0, predictiveMaintenance: false },
    wear: 0,
    script: [{ at: 3, target: 'sorter/prox-sensor', health: 0 }],
  },
  {
    id: 'brownout',
    name: 'Brownout',
    tagline: 'The servo throws the fault. Is the servo really the problem?',
    teaches: 'Reading the logs: a sagging 24V rail makes the servo fault. Buy the wrong part and the fault comes back.',
    policy: { autoApproveLimit: 60, monthlyBudget: 1000, spent: 0, predictiveMaintenance: false },
    wear: 0,
    initial: { 'arm/arm-psu': 0.55 },
    script: [{ at: 1, target: 'arm/arm-psu', degradeTo: 0.1, over: 6 }],
  },
  {
    id: 'predictive',
    name: 'Grinding noise',
    tagline: 'A bearing is wearing out. Fix it before it seizes.',
    teaches: 'Predictive maintenance: the agent spots rising vibration in the logs and orders the part before the line stops.',
    policy: { autoApproveLimit: 60, monthlyBudget: 1000, spent: 0, predictiveMaintenance: true },
    wear: 0,
    initial: { 'conveyor/roller-bearing': 0.5 },
    script: [{ at: 0, target: 'conveyor/roller-bearing', degradeTo: 0, over: 30 }],
  },
  {
    id: 'budget-crunch',
    name: 'Month-end crunch',
    tagline: '$38 left in the budget and two machines about to fail.',
    teaches: 'Spending controls: over-budget orders go to the manager, who decides what is worth it.',
    policy: { autoApproveLimit: 60, monthlyBudget: 150, spent: 112, predictiveMaintenance: false },
    wear: 0,
    script: [
      { at: 3, target: 'packer/net-switch', health: 0 },
      { at: 14, target: 'sorter/relay-board', health: 0 },
    ],
  },
  {
    id: 'untrusted',
    name: 'Supplier gap',
    tagline: 'The only store with the part is not on the trusted list.',
    teaches: 'Store allowlist: the agent is blocked from buying until the manager trusts the store.',
    policy: { autoApproveLimit: 60, monthlyBudget: 1000, spent: 0, predictiveMaintenance: false, allowedMerchants: ['Switch Electronics', 'Digitmakers.ca'] },
    wear: 0,
    script: [{ at: 3, target: 'packer/barcode-scanner', health: 0 }],
  },
  {
    id: 'sandbox',
    name: 'Free play',
    tagline: 'Parts wear out one at a time. Keep the line running.',
    teaches: 'Parts age at random. Use the chaos tools and the Manager\'s Desk however you like.',
    policy: { autoApproveLimit: 60, monthlyBudget: 1000, spent: 0, predictiveMaintenance: true },
    wear: 1, //               > 0 turns on the failure scheduler: one failure at a time
    failureEvery: [6, 12], // game-minutes of calm between failures
    script: [],
  },
];

// ─── Server → game events (SSE at GET /api/events) ───────────────────────────
// Every event: { type, incidentId?, data, at }
export const EVENTS = {
  STATE: 'state', //                  snapshot on connect: see server/src/index.js
  SIM_TICK: 'sim.tick', //                       { sim }  see SIM_SPEC "Snapshot"
  SIM_PRESET: 'sim.preset', //                   { preset, sim }  a preset was loaded (factory reset)
  LOG_ENTRY: 'log.entry', //                     { entry: { id, t, clock, level, machineId, componentId, code, message } }
  CATALOG_UPDATED: 'catalog.updated', //         { catalog }
  INCIDENT_CREATED: 'incident.created', //       { incident }
  INCIDENT_CANCELLED: 'incident.cancelled', //   {}
  AGENT_THINKING: 'agent.thinking', //           { text }
  AGENT_DIAGNOSIS: 'agent.diagnosis', //         { componentId, component, probabilities, prior, confidence, provider, attempt, evidence: [string], explanation }
  AGENT_SEARCHING: 'agent.searching', //         { query, part }
  CATALOG_RESULTS: 'catalog.results', //         { part, query, offers, chosen, probabilities, confidence, provider, source }
  PROCUREMENT_QUOTE: 'procurement.quote', //     { quote }
  POLICY_DECISION: 'policy.decision', //         { action: 'AUTO'|'ESCALATE'|'BLOCK', reasons, total, confidence }
  APPROVAL_REQUIRED: 'checkout.approval_required', // { checkoutId, approvalUrl, total, reasons }
  CHECKOUT_COMPLETED: 'checkout.completed', //   { checkoutId, orderId, finalAmount, rail: 'kwal'|'reap' }
  CHECKOUT_FAILED: 'checkout.failed', //         { checkoutId, status, reason }
  DELIVERY_DISPATCHED: 'delivery.dispatched', // { etaMinutes, shipping }
  DELIVERY_ARRIVED: 'delivery.arrived', //       {}
  TECH_DISPATCHED: 'technician.dispatched', //   { technician, escrow }
  TECH_REPAIRING: 'technician.repairing', //     { minutes, componentId }
  PART_REPLACED: 'part.replaced', //             { machineId, componentId }
  ESCROW_RELEASED: 'escrow.released', //         { escrow: { id, technicianId, amount, currency, status, onchain, amountUsdc?, to?, txHash?, txUrl?, simulatedReason? } }
  INCIDENT_RESOLVED: 'incident.resolved', //     { summary }
  INCIDENT_ERROR: 'incident.error', //           { code, message, retryable }
  POLICY_UPDATED: 'policy.updated', //           { policy }
  TREASURY_UPDATED: 'treasury.updated', //       { treasury }  onchain balances, see below
  LEDGER_ENTRY: 'ledger.entry', //               { entry }  manager dashboard history, see LEDGER below
};

// Plant log levels, in increasing severity. AGENT = something Wrench-bot did.
export const LOG_LEVELS = ['INFO', 'AGENT', 'WARN', 'ERROR', 'FAULT'];

// Onchain treasury (Ink Sepolia testnet, chain 763373). TREASURY_UPDATED payload and STATE.treasury:
//   { onchain: boolean,            // a treasury key is configured
//     address, vaultAddress,       // treasury wallet (owns the Kwal vault) and the Kwal vault contract
//     usdc, vaultUsdc, eth,        // live balances (numbers), null if unknown
//     explorer: { treasury, vault } // block-explorer URLs
//     kwal: { enabled, step, state } }  // Kwal setup state ("deposit_observation", "ready", …)
// Payment rails: within policy limits the agent pays from the Kwal vault (USDC, no approval page);
// escalated orders go through the Reap card with the manager's approval on Reap's hosted page.

// ─── Manager ledger (dashboard) ──────────────────────────────────────────────
// Every purchase, payout, approval, block and agent decision, kept across
// scenarios (persisted on the server). GET /api/ledger →
//   { entries: [LedgerEntry] (newest last, max 1000), totals }
// LedgerEntry:
//   { id, at (ISO time), t, clock (game time), preset: { id, name }, incidentId, machineId,
//     type: 'purchase' | 'payout' | 'decision' | 'approval' | 'blocked' | 'failed' | 'incident' | 'resolved',
//     title,                       // one line, e.g. 'Bought 2× FT5320M servo from Switch Electronics'
//     detail,                      // optional second line (reasons, evidence, explanation)
//     amount, currency,            // purchases: USD (or USDC for the Kwal rail); payouts: USDC
//     rail: 'reap' | 'kwal',       // purchases
//     approval: 'auto' | 'manager' | 'blocked',
//     orderId, merchant, part, qty,
//     onchain, txHash, txUrl,      // payouts (txUrl → Ink Sepolia explorer)
//     confidence, provider,        // decisions
//     simulated }                  // true when the payment/payout was simulated (offline or judge demo)
// totals: { partsSpend, laborUsd, laborUsdc, orders, autoApproved, managerApproved, blocked,
//           failed, incidents, resolved, avgMinutesToFix }
