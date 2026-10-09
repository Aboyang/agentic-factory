// Turns server events into animations (world) and panels (ui).
// The server (simulation + agent) is the source of truth; the director only reacts.
// It uses only the World API from docs/SIM_SPEC.md §7 and the UI facade (ui/UI.js).

import { EVENTS, MACHINES } from '../../shared/contract.js';

const MACHINE = Object.fromEntries(MACHINES.map((m) => [m.id, m]));
const money = (n) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Call a world method without letting a missing/broken one stop the event flow. */
function call(obj, method, ...args) {
  try {
    return typeof obj?.[method] === 'function' ? obj[method](...args) : undefined;
  } catch (err) {
    console.error(`[director] ${method} failed`, err);
    return undefined;
  }
}

export class Director {
  constructor(world, ui, { api } = {}) {
    this.world = world;
    this.ui = ui;
    this.api = api;
    this.sim = null;
    this.state = null;
    this.incidents = new Map(); // id → { machineId, kind, place, open, unsure }
    this.prev = new Map(); // machineId → { status, degraded } from the last tick
    this.techs = new Map(); // incidentId → machineId while that incident's technician is on the floor
    this.loadSeq = 0;
    this.pickerShown = false;
    this.historyLoaded = new Set();
    this.selected = null;

    ui.onSelectMachine = (id, opts) => this.selectMachine(id, opts);
    call(world, 'onMachineClick', (id) => this.selectMachine(id, { from: 'world' }));
  }

  // ─── Boot ────────────────────────────────────────────────────────────
  /** GET /api/state, build everything, show the scenario picker. Retries until the server answers. */
  async boot() {
    const seq = ++this.loadSeq;
    for (let attempt = 0; ; attempt++) {
      try {
        const state = await this.api('GET', '/state');
        if (seq === this.loadSeq) this.applyState(state);
        return;
      } catch (err) {
        if (this.state) return; // the SSE STATE event got there first
        this.ui.bootError(`${err.message}. Is the server running on :8787?`);
        await new Promise((r) => setTimeout(r, Math.min(5000, 1000 + attempt * 500)));
      }
    }
  }

  /** Apply a full STATE payload (boot, SSE connect, or after a preset). */
  applyState(state) {
    if (!state || typeof state !== 'object') return;
    this.state = state;
    this.ui.setState(state);

    // Incidents still in play (page opened mid-incident or SSE reconnect).
    for (const inc of state.incidents || []) {
      if (!inc?.id) continue;
      const open = ['open', 'error', 'blocked'].includes(inc.status);
      if (!open) continue;
      if (!this.incidents.has(inc.id)) this.incidents.set(inc.id, { machineId: inc.machineId, kind: inc.kind, place: inc.machineId, open: true, unsure: false });
    }

    if (state.sim) this.#applySim(state.sim, { floats: false });
    this.#syncThinking();
    this.#seedHistory();

    if (!this.pickerShown) {
      this.pickerShown = true;
      this.ui.showScenarios({ closable: !(state.sim?.paused && state.sim?.t === 0) });
    }
  }

  // ─── Events ──────────────────────────────────────────────────────────
  handle(evt) {
    if (!evt || typeof evt !== 'object') return;
    const { type, incidentId } = evt;
    const data = evt.data || {};
    try {
      this.#dispatch(type, incidentId, data);
    } catch (err) {
      console.error(`[director] ${type} failed`, err, evt);
    }
  }

  #dispatch(type, id, data) {
    const ui = this.ui;
    const world = this.world;

    switch (type) {
      // ─── Plant ───
      case EVENTS.STATE:
        this.applyState(data);
        break;

      case EVENTS.SIM_TICK:
        if (data.sim) this.#applySim(data.sim, { floats: true });
        break;

      case EVENTS.SIM_PRESET: {
        // Factory reset: forget everything, then reload the whole state.
        this.#clearFloor();
        ui.resetForPreset(data.preset);
        this.prev.clear();
        this.historyLoaded.clear();
        if (data.sim) this.#applySim(data.sim, { floats: false });
        this.#reloadState();
        break;
      }

      case EVENTS.LOG_ENTRY:
        if (data.entry) ui.addLog(data.entry);
        break;

      case EVENTS.CATALOG_UPDATED:
        if (data.catalog) ui.setCatalog(data.catalog);
        break;

      case EVENTS.POLICY_UPDATED:
        if (data.policy) {
          ui.setPolicy(data.policy);
          this.#syncThinking();
        }
        break;

      case EVENTS.TREASURY_UPDATED:
        ui.setTreasury(data.treasury || null);
        break;

      case EVENTS.LEDGER_ENTRY: // manager dashboard history (not tied to the incident cards)
        if (data.entry) ui.ledgerEntry?.(data.entry);
        break;

      case 'ledger.cleared': // server-only event after POST /api/ledger/clear
        ui.ledgerCleared?.();
        break;

      // ─── Incident lifecycle ───
      case EVENTS.INCIDENT_CREATED: {
        const inc = data.incident || {};
        const iid = inc.id || id;
        if (!iid) break;
        const known = this.incidents.get(iid);
        this.incidents.set(iid, { machineId: inc.machineId, kind: inc.kind, place: inc.machineId, open: true, unsure: false, ...(known ? { place: known.place } : {}) });
        ui.incident(type, iid, data);
        // No popup: the agent chip (top-centre) and the hint chip over the machine show it.
        if (!known) this.#robotTo(iid, inc.machineId);
        break;
      }

      case EVENTS.INCIDENT_CANCELLED:
        ui.incident(type, id, data);
        ui.dropApprovals(id);
        this.#release(id);
        break;

      case EVENTS.INCIDENT_RESOLVED: {
        const card = ui.incident(type, id, data);
        const name = MACHINE[this.incidents.get(id)?.machineId]?.name || card?.machineName || 'Machine';
        const s = data.summary || {};
        ui.note(`${name} ${s.kind === 'predictive' ? 'serviced before it failed' : 'fixed'}${Number(s.attempts) > 1 ? ` after ${s.attempts} tries` : ''} · parts ${money(s.spent)}`, { code: s.kind === 'predictive' ? 'CAUGHT' : 'FIXED', machineId: this.incidents.get(id)?.machineId || card?.machineId });
        ui.say(s.kind === 'predictive' ? `Swapped it before it failed. The ${name} keeps running.` : `The ${name} is running again.`);
        ui.dropApprovals(id);
        this.#release(id);
        break;
      }

      case EVENTS.INCIDENT_ERROR: {
        const card = ui.incident(type, id, data);
        ui.dropApprovals(id);
        const blocked = data.code === 'BLOCKED';
        ui.toast(`${card?.machineName ? `${card.machineName}: ` : ''}${data.message || data.code || 'Incident stopped'}`, 'bad', blocked ? 'BLOCKED' : 'STOPPED');
        if (blocked) {
          const merchant = card?.quote?.merchant || card?.results?.chosen?.merchant;
          if (merchant) ui.flagMerchant(merchant);
        }
        const inc = this.incidents.get(id);
        if (inc) inc.unsure = false;
        this.#robotTo(id, 'home', { keepOpen: true });
        this.#syncThinking();
        break;
      }

      // ─── Agent reasoning ───
      case EVENTS.AGENT_THINKING: {
        ui.incident(type, id, data);
        if (data.text) ui.say(data.text);
        // Re-diagnosing after a failed fix: walk back to the machine.
        const inc = this.incidents.get(id);
        if (inc && /re-diagnos|still fault|still broken/i.test(data.text || '')) this.#robotTo(id, inc.machineId);
        else if (inc && inc.place === 'home') this.#robotTo(id, inc.machineId); // retried after an error
        this.#syncThinking();
        break;
      }

      case EVENTS.AGENT_DIAGNOSIS: {
        ui.incident(type, id, data);
        if (data.explanation) ui.say(data.explanation);
        const inc = this.incidents.get(id);
        if (inc) {
          const bar = ui.policy?.confidenceThreshold ?? 0.75;
          inc.unsure = Number(data.confidence) < bar;
          if (inc.place !== inc.machineId) this.#robotTo(id, inc.machineId);
        }
        this.#syncThinking();
        break;
      }

      case EVENTS.AGENT_SEARCHING: {
        ui.incident(type, id, data);
        const inc = this.incidents.get(id);
        if (inc) inc.unsure = false;
        this.#robotTo(id, 'terminal');
        this.#syncThinking();
        break;
      }

      case EVENTS.CATALOG_RESULTS:
        ui.incident(type, id, data);
        ui.addMerchants((data.offers || []).map((o) => o?.merchant).filter(Boolean));
        break;

      case EVENTS.PROCUREMENT_QUOTE:
        ui.incident(type, id, data);
        break;

      case EVENTS.POLICY_DECISION: {
        const card = ui.incident(type, id, data);
        if (data.action === 'ESCALATE') ui.say(`I need your OK for this one: ${(data.reasons || [])[0] || 'outside my limits'}.`);
        else if (data.action === 'BLOCK') ui.say(`I'm not allowed to buy this: ${(data.reasons || [])[0] || 'blocked by policy'}.`);
        else if (data.action === 'AUTO') ui.say(`${money(data.total)} is within my limits. Buying it now.`);
        if (data.action === 'BLOCK') {
          const merchant = card?.quote?.merchant || card?.results?.chosen?.merchant;
          if (merchant) ui.flagMerchant(merchant);
        }
        this.#syncThinking();
        break;
      }

      // ─── Payment ───
      case EVENTS.APPROVAL_REQUIRED:
        ui.incident(type, id, data);
        ui.openApproval(id, data); // the modal pops by itself: the one essential action
        this.#syncThinking();
        break;

      case EVENTS.CHECKOUT_COMPLETED: {
        const card = ui.incident(type, id, data);
        ui.closeApproval(data.checkoutId);
        ui.paid(id, data, card); // "Paid from Kwal vault (USDC)" vs "Paid by Reap card", in the log
        this.#syncThinking();
        break;
      }

      case EVENTS.CHECKOUT_FAILED:
        ui.incident(type, id, data);
        ui.closeApproval(data.checkoutId);
        ui.toast(`Checkout ${String(data.status || 'failed').toLowerCase()}: ${data.reason || 'no order placed'}`, 'bad', 'PAYMENT');
        this.#syncThinking();
        break;

      // ─── Delivery + repair ───
      case EVENTS.DELIVERY_DISPATCHED: {
        ui.incident(type, id, data);
        const speed = Number(this.sim?.speed) || 1;
        const secs = data.etaMinutes != null ? Number(data.etaMinutes) / speed : Number(data.etaSeconds) || 6;
        call(world, 'spawnTruck', Math.max(1, secs));
        if (data.etaMinutes != null) ui.say(`Ordered. ${data.shipping?.name || 'Standard'} delivery, about ${Math.round(data.etaMinutes)} min.`);
        break;
      }

      case EVENTS.DELIVERY_ARRIVED:
        ui.incident(type, id, data);
        this.#robotTo(id, 'dock');
        ui.say('Parts are here. Grabbing the crate from the dock.');
        break;

      case EVENTS.TECH_DISPATCHED: {
        const card = ui.incident(type, id, data);
        const machineId = this.incidents.get(id)?.machineId || card?.machineId;
        const t = data.technician || {};
        if (machineId && !this.techs.has(id)) {
          call(world, 'technicianArrive', machineId, { name: t.name || 'Tech', color: t.color || '#88c0d0' });
          this.techs.set(id, machineId);
          this.#robotTo(id, machineId); // brings the part over
        }
        break;
      }

      case EVENTS.TECH_REPAIRING:
        ui.incident(type, id, data);
        call(world, 'technicianWork', true, this.#techMachine(id));
        break;

      case EVENTS.PART_REPLACED: {
        const card = ui.incident(type, id, data);
        const machineId = data.machineId || this.incidents.get(id)?.machineId || card?.machineId;
        if (machineId) {
          call(world, 'partReplaced', machineId);
          ui.floatText(machineId, 'PART REPLACED', 'info');
        }
        call(world, 'technicianWork', false, machineId || this.#techMachine(id));
        break;
      }

      case EVENTS.ESCROW_RELEASED: {
        const card = ui.incident(type, id, data);
        ui.escrowReleased(id, data.escrow, card); // "Paid Ana 1.20 USDC onchain ↗"
        this.#techLeave(id);
        break;
      }

      default:
        if (id) ui.incident(type, id, data);
    }
  }

  // ─── Machine selection ───────────────────────────────────────────────
  /** A machine was clicked in 3D (from 'world') or its popover opened from the UI. null = popover closed. */
  selectMachine(machineId, { from } = {}) {
    if (!machineId || !MACHINE[machineId]) {
      if (machineId == null) {
        call(this.world, 'focusMachine', null);
        this.selected = null;
      }
      return;
    }
    if (from === 'world') this.ui.openMachine(machineId); // the UI already opened it otherwise
    call(this.world, 'focusMachine', machineId);
    this.selected = machineId;
    this.#loadHistory(machineId);
  }

  // ─── Internals ───────────────────────────────────────────────────────
  #applySim(sim, { floats }) {
    this.sim = sim;
    for (const [id, m] of Object.entries(sim.machines || {})) {
      if (!m) continue;
      call(this.world, 'setMachineStatus', id, m.status, Boolean(m.degraded));
      if (floats) this.#statusFloat(id, m);
      this.prev.set(id, { status: m.status, degraded: Boolean(m.degraded) });
    }
    call(this.world, 'setLineRunning', Boolean(sim.lineRunning));
    if (sim.clock) call(this.world, 'setClock', sim.clock); // optional World extra
    this.ui.updateSim(sim);
  }

  // Floating text when a machine changes state between two ticks.
  #statusFloat(id, m) {
    const prev = this.prev.get(id);
    if (!prev) return;
    const cost = MACHINE[id]?.downtimeCostPerMin || 0;
    if (prev.status !== m.status) {
      if (m.status === 'down') this.ui.floatText(id, `DOWN -$${cost}/min`, 'bad');
      else if (m.status === 'running') this.ui.floatText(id, 'RUNNING', 'good');
      else if (m.status === 'maintenance') this.ui.floatText(id, prev.status === 'down' ? 'REPAIRING' : `MAINTENANCE -$${cost}/min`, 'maint');
    } else if (!prev.degraded && m.degraded && m.status === 'running') {
      const def = MACHINE[id];
      const part = def?.components.find((c) => m.components?.[c.id]?.status === 'warn');
      this.ui.floatText(id, part ? `WARN ${part.name.toUpperCase()}` : 'WARNING', 'warn');
    }
  }

  async #reloadState() {
    const seq = ++this.loadSeq;
    try {
      const state = await this.api('GET', '/state');
      if (seq === this.loadSeq) this.applyState(state);
    } catch (err) {
      console.warn('[director] state reload failed', err);
    }
  }

  // Seed the inspector's sparklines with the server's recent history.
  #seedHistory() {
    for (const m of MACHINES) this.#loadHistory(m.id);
  }

  async #loadHistory(machineId) {
    if (this.historyLoaded.has(machineId)) return;
    this.historyLoaded.add(machineId);
    const seq = this.loadSeq;
    try {
      const history = await this.api('GET', `/sim/history/${encodeURIComponent(machineId)}`);
      if (seq !== this.loadSeq) return; // a preset loaded meanwhile
      const list = Array.isArray(history) ? history : history?.history;
      if (Array.isArray(list)) this.ui.loadHistory(machineId, list);
    } catch {
      this.historyLoaded.delete(machineId);
    }
  }

  /** Robot walks somewhere on behalf of an incident. */
  #robotTo(incidentId, place, { keepOpen } = {}) {
    if (!place) return;
    const inc = this.incidents.get(incidentId);
    if (inc) {
      inc.place = place;
      if (!keepOpen) inc.open = true;
    }
    call(this.world, 'robotGoTo', place);
  }

  /** An incident ended: the robot goes to the next open one, or home. */
  #release(incidentId) {
    const inc = this.incidents.get(incidentId);
    this.incidents.delete(incidentId);
    this.#techLeave(incidentId);
    const next = [...this.incidents.values()].filter((i) => i.open && i.place && i.place !== 'home').pop();
    if (inc || !next) call(this.world, 'robotGoTo', next?.place || 'home');
    this.#syncThinking();
  }

  /** "?" over the robot while it is unsure or waiting for a human. */
  #syncThinking() {
    const unsure = [...this.incidents.values()].some((i) => i.unsure);
    call(this.world, 'robotThinking', unsure || this.ui.needsHuman());
  }

  #techMachine(incidentId) {
    return this.techs.get(incidentId) ?? this.incidents.get(incidentId)?.machineId;
  }

  /** That incident's technician (if any) stops working and walks out. */
  #techLeave(incidentId) {
    if (!this.techs.has(incidentId)) return;
    const machineId = this.techs.get(incidentId);
    this.techs.delete(incidentId);
    call(this.world, 'technicianWork', false, machineId);
    call(this.world, 'technicianLeave', machineId);
  }

  /** Preset reset: trucks, crates and technicians gone, robot home, nothing pending. */
  #clearFloor() {
    for (const id of [...this.techs.keys()]) this.#techLeave(id);
    this.incidents.clear();
    call(this.world, 'reset'); // optional World extra: clears transient actors at once
    call(this.world, 'robotThinking', false);
    call(this.world, 'robotGoTo', 'home');
  }
}
