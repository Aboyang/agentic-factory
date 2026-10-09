// Agent popup (opened from an agent chip): what Wrench-bot is doing and why.
// One card per incident, laid out as the pipeline it runs:
//   Diagnose → Source → Quote → Approve → Ship → Repair → Verify
// Plus the scenario brief, an idle "watch list" (parts in WARN), history of
// fixed incidents, chip data for the top-centre status chips (chips()), and the
// approval modal (ApprovalModal, exported below).

import { MACHINES } from '../../../shared/contract.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const money0 = (n) => `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
const pct = (p) => `${Math.round((Number(p) || 0) * 100)}%`;
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const mins = (m) => {
  const v = Math.max(0, Number(m) || 0);
  return v < 1 ? '<1 min' : `${Math.round(v)} min`;
};

export const STEPS = [
  { key: 'diagnosing', label: 'Diagnose' },
  { key: 'sourcing', label: 'Source' },
  { key: 'quoting', label: 'Quote' },
  { key: 'approval', label: 'Approve' },
  { key: 'shipping', label: 'Ship' },
  { key: 'repairing', label: 'Repair' },
  { key: 'verifying', label: 'Verify' },
];
const STEP_INDEX = Object.fromEntries(STEPS.map((s, i) => [s.key, i]));
// Agent chip wording per step: "Robot Arm · Diagnosing… 1/7".
const STEP_VERB = {
  diagnosing: 'Diagnosing',
  sourcing: 'Finding the part',
  quoting: 'Getting a quote',
  approval: 'Paying',
  shipping: 'Part on the way',
  repairing: 'Repairing',
  verifying: 'Verifying',
};
const TECH_TRAVEL_MIN = 2;
const VERIFY_MIN = 2;
const PREDICTIVE_AFTER_MIN = 3;
const RESOLVED_LINGER_MS = 7000;
const STORE_KEY = 'wrenchbot.agent.v1';

// What the manager can do about each error code.
const ERROR_HINTS = {
  BLOCKED: { text: 'Trust the store in the Manager\'s Desk, then retry.', desk: true },
  CHECKOUT_EXPIRED: { text: 'The order was rejected or expired. The machine stays down until you retry.' },
  CHECKOUT_FAILED: { text: 'The payment did not go through. Retry to quote again.' },
  CHECKOUT_TIMEOUT: { text: 'No answer from the payment page. Retry to start a new checkout.' },
  NO_PARTS: { text: 'No listing matched the part spec. Refresh the catalog or retry.' },
  NO_QUOTE: { text: 'No store could fill the order right now. Retry in a moment.' },
  NO_CARD: { text: 'No card is enrolled with Reap yet. Run the enrollment, then retry.' },
  GAVE_UP: { text: 'Three repairs did not clear the fault. Retry to start a fresh diagnosis.' },
};

export class AgentPanel {
  /**
   * @param root      container element
   * @param opts.api  (method, path, body) => Promise
   * @param opts.onInspect(machineId)   open that machine's popover
   * @param opts.onOpenDesk()           open the Manager's Desk modal
   * @param opts.onApproval(checkoutId) reopen the approval modal
   * @param opts.toast(text, kind, label)
   * @param opts.onClose()              ✕ in the header
   * @param opts.onChange()             cards changed (the UI refreshes the agent chips)
   */
  constructor(root, { api, machines = MACHINES, onInspect, onOpenDesk, onApproval, toast, onClose, onChange } = {}) {
    this.root = root;
    this.api = api;
    this.machines = machines;
    this.onInspect = onInspect || (() => {});
    this.onOpenDesk = onOpenDesk || (() => {});
    this.onApproval = onApproval || (() => {});
    this.toast = toast || (() => {});
    this.onClose = onClose || (() => {});
    this.onChange = onChange || (() => {});

    this.incidents = new Map(); // id → card model
    this.tabs = []; // ids shown as tabs (open or lingering)
    this.history = []; // resolved, newest first
    this.selected = null;
    this.sim = null;
    this.policy = null;
    this.mode = null;
    this.preset = null;
    this.briefOpen = true;
    this.briefTouched = false;
    this.warnSince = new Map(); // 'machine/part' → game t when WARN started
    this.lastT = null;

    root.innerHTML = `<div class="ap panel">
      <div class="ap-head">
        <div class="ap-avatar" aria-hidden="true"><i></i><i></i></div>
        <div class="ap-who"><div class="title">WRENCH-BOT</div><div class="ap-state" data-k="state">Connecting…</div></div>
        <span class="chip" data-k="ai">AI</span>
        <button class="pop-x" data-a="close" aria-label="Close" title="Close (Esc)">✕</button>
      </div>
      <div class="ap-brief" data-k="brief"></div>
      <div class="ap-tabs" data-k="tabs"></div>
      <div class="ap-scroll" data-k="scroll">
        <div class="ap-body" data-k="body"></div>
        <div class="ap-history" data-k="history"></div>
      </div>
    </div>`;
    this.el = Object.fromEntries([...root.querySelectorAll('[data-k]')].map((n) => [n.dataset.k, n]));
    root.addEventListener('click', (e) => this.#onClick(e));
    this.render();
  }

  // ─── Inputs from UI.js ───────────────────────────────────────────────
  machine(id) {
    return this.machines.find((m) => m.id === id);
  }

  setMode(mode) {
    this.mode = mode || null;
    const ai = this.el.ai;
    if (!mode) return;
    ai.textContent = mode.mockAi ? 'AI offline' : 'AI live';
    ai.className = `chip ${mode.mockAi ? '' : 'agent'}`;
    ai.title = mode.mockAi ? 'Decision model runs the offline heuristic (MOCK_AI)' : 'Decision model calls a live LLM';
  }

  setPolicy(policy) {
    if (!policy) return;
    this.policy = policy;
    this.render();
  }

  setPreset(preset) {
    if (!preset) return;
    this.preset = { ...this.preset, ...preset };
    this.#renderBrief();
  }

  /** Called every tick with the sim snapshot: downtime per incident, warn timers, progress bars. */
  updateSim(sim) {
    if (!sim) return;
    const prevT = this.lastT;
    this.sim = sim;
    this.lastT = sim.t;
    const dt = prevT == null ? 0 : sim.t - prevT;

    // Downtime accrued by each open incident's machine.
    if (dt > 0 && dt < 60) {
      for (const inc of this.incidents.values()) {
        if (!isActive(inc)) continue;
        const status = sim.machines?.[inc.machineId]?.status;
        if (status && status !== 'running') {
          inc.downMin += dt;
          inc.downCost += dt * (this.machine(inc.machineId)?.downtimeCostPerMin || 0);
        }
      }
    }

    // When did each part enter WARN (for the predictive countdown).
    const seen = new Set();
    for (const [mid, m] of Object.entries(sim.machines || {})) {
      for (const [cid, c] of Object.entries(m.components || {})) {
        if (c.status !== 'warn') continue;
        const key = `${mid}/${cid}`;
        seen.add(key);
        if (!this.warnSince.has(key)) this.warnSince.set(key, sim.t);
      }
    }
    for (const key of [...this.warnSince.keys()]) if (!seen.has(key)) this.warnSince.delete(key);

    if (this.#openCount() === 0) this.#renderBody();
    else this.#tickProgress();
    this.#renderState();
    this.#persist();
    this.onChange();
  }

  /** Factory reset: drop every card. */
  reset() {
    for (const inc of this.incidents.values()) clearTimeout(inc.lingerTimer);
    this.incidents.clear();
    this.tabs = [];
    this.history = [];
    this.selected = null;
    this.warnSince.clear();
    this.lastT = null;
    this.briefTouched = false;
    this.briefOpen = true;
    try {
      sessionStorage.removeItem(STORE_KEY);
    } catch {}
    this.render();
  }

  /**
   * Sync with the incidents in a STATE payload (boot, SSE reconnect, page reload).
   * Cards saved in sessionStorage are restored so a reload keeps the diagnosis,
   * listings and any approval that is still waiting.
   */
  loadIncidents(list = [], sim = this.sim) {
    const byId = new Map((list || []).filter((i) => i?.id).map((i) => [i.id, i]));
    const saved = this.#restore();

    // Cards we hold that finished while we weren't listening.
    for (const [id, inc] of [...this.incidents]) {
      if (inc.status === 'resolved') continue;
      const s = byId.get(id);
      if (!s || s.status === 'cancelled') this.#remove(id);
      else if (s.status === 'resolved') {
        Object.assign(inc, { status: 'resolved', step: 'done', attention: false, error: null });
        inc.summary ||= { spent: s.spent, attempts: s.attempts, downtimeMin: s.downtimeMin, kind: s.kind };
        if (inc.approval) inc.approval.pending = false;
        this.#addHistory(inc);
        this.#linger(inc);
      }
    }

    for (const i of byId.values()) {
      if (!['open', 'error', 'blocked'].includes(i.status) || this.incidents.has(i.id)) continue;
      const prev = saved?.cards?.find((c) => c.id === i.id);
      const inc = prev ? { ...this.#model(i), ...prev, lingerTimer: null, toggled: prev.toggled || {} } : this.#model(i);
      inc.status = i.status;
      if (i.step && i.step !== 'done') inc.step = i.step;
      if (inc.approval?.pending && i.step !== 'approval') inc.approval.pending = false;
      if (i.status !== 'open') {
        inc.error = inc.error || {
          code: i.error?.code || (i.status === 'blocked' ? 'BLOCKED' : 'ERROR'),
          message: i.error?.message || 'Stopped. Waiting for the manager.',
          retryable: true,
          step: inc.step,
        };
        inc.attention = true;
      } else {
        inc.error = null;
        inc.attention = Boolean(inc.approval?.pending);
      }
      if (!prev && inc.kind === 'breakdown' && sim && Number.isFinite(Number(i.startedAt))) {
        inc.downMin = Math.max(0, sim.t - Number(i.startedAt));
        inc.downCost = inc.downMin * (this.machine(inc.machineId)?.downtimeCostPerMin || 0);
      }
      this.incidents.set(i.id, inc);
      if (!this.tabs.includes(i.id)) this.tabs.push(i.id);
    }

    // History: incidents the server resolved this shift (it clears them on every preset),
    // using the richer saved copy when this browser saw them happen.
    const resolved = [...byId.values()]
      .filter((i) => i.status === 'resolved' && !this.history.some((h) => h.id === i.id))
      .sort((a, b) => (Number(a.endedAt) || 0) - (Number(b.endedAt) || 0));
    for (const i of resolved) {
      const prev = saved?.history?.find((h) => h.id === i.id);
      this.#addHistory(prev || {
        ...this.#model(i),
        status: 'resolved',
        step: 'done',
        summary: { spent: i.spent, attempts: i.attempts, downtimeMin: i.downtimeMin, kind: i.kind },
      });
    }
    if ((!this.selected || !this.incidents.has(this.selected)) && this.tabs.length) {
      this.selected = this.tabs.find((x) => this.incidents.get(x)?.attention) || this.tabs[this.tabs.length - 1];
    }
    if (this.tabs.length && !this.briefTouched) this.briefOpen = false;
    this.render();
  }

  /** Stores that blocked an order still waiting for the manager. */
  blockedMerchants() {
    return [...this.incidents.values()]
      .filter((i) => i.status === 'blocked')
      .map((i) => i.quote?.merchant || i.results?.chosen?.merchant)
      .filter(Boolean);
  }

  /** Approvals still waiting for the manager (to reopen the modal after a reload). */
  pendingApprovals() {
    return [...this.incidents.values()]
      .filter((i) => i.status === 'open' && i.approval?.pending && i.approval.checkoutId)
      .map((i) => ({ incidentId: i.id, data: i.approval }));
  }

  /** Is any incident waiting for a human (approval, blocked, error)? */
  needsHuman() {
    return [...this.incidents.values()].some((i) => i.attention && i.status !== 'resolved' && i.status !== 'cancelled');
  }

  get(id) {
    return this.incidents.get(id);
  }

  /** Show one incident's card (an agent chip was clicked). */
  focus(id) {
    if (!id || !this.incidents.has(id)) return;
    this.selected = id;
    this.render();
  }

  /** One entry per incident on screen (open, stopped, or just fixed): drives the agent chips. */
  chips() {
    return this.tabs
      .map((id) => this.incidents.get(id))
      .filter(Boolean)
      .map((inc) => {
        const failed = inc.status === 'error' || inc.status === 'blocked';
        const done = inc.status === 'resolved';
        const idx = done ? STEPS.length : Math.min(STEPS.length - 1, STEP_INDEX[inc.step] ?? 0);
        let label;
        let tone = 'busy';
        if (done) {
          label = inc.kind === 'predictive' ? 'Caught early' : 'Fixed';
          tone = 'good';
        } else if (failed) {
          label = inc.status === 'blocked' ? 'Blocked, needs you' : 'Stopped, needs you';
          tone = 'bad';
        } else if (inc.approval?.pending) {
          label = 'Needs your OK';
          tone = 'attn';
        } else {
          label = `${STEP_VERB[inc.step] || 'Working'}… ${idx + 1}/${STEPS.length}`;
          if (inc.attention) tone = 'attn';
        }
        return { id: inc.id, machineId: inc.machineId, machineName: inc.machineName, kind: inc.kind, status: inc.status, step: idx, total: STEPS.length, failed, done, tone, label, title: inc.title };
      });
  }

  // ─── Incident events (from director.js) ──────────────────────────────
  /** Apply one server event to its incident card. Returns the card model (or null). */
  apply(type, id, data = {}) {
    if (type === 'incident.created') return this.#created(data.incident || {}, id);
    if (!id) return null;
    let inc = this.incidents.get(id);
    if (!inc) {
      if (type === 'incident.cancelled' || type === 'incident.resolved') return null;
      // Event for an incident we never saw (page opened mid-incident): make a stub.
      inc = this.#created({ id }, id);
    }
    const t = this.sim?.t ?? null;
    // Any progress after an error means the incident was retried.
    if ((inc.status === 'error' || inc.status === 'blocked') && !['incident.error', 'incident.cancelled', 'policy.decision', 'checkout.failed'].includes(type)) {
      inc.status = 'open';
      inc.error = null;
      inc.attention = false;
    }

    switch (type) {
      case 'incident.cancelled':
        this.#remove(id);
        return inc;

      case 'agent.thinking':
        inc.thinking = data.text || '';
        inc.thinkingStep = inc.step;
        if (inc.step === 'verifying' && inc.replaced && /still|again|wasn.t|re-diagnos/i.test(inc.thinking)) inc.verifyFailed = inc.thinking;
        break;

      case 'agent.diagnosis': {
        const attempt = Number(data.attempt) || 1;
        if (attempt > inc.attempt && inc.diagnosis && inc.replaced) {
          inc.ruledOut.push({ name: inc.diagnosis.component, attempt: inc.attempt });
        }
        if (attempt === 1 && attempt <= inc.attempt) inc.ruledOut = []; // retried from scratch
        inc.attempt = attempt;
        this.#resetDownstream(inc);
        inc.diagnosis = { ...data };
        inc.step = 'diagnosing';
        break;
      }

      case 'agent.searching':
        inc.searching = { query: data.query, part: data.part };
        inc.step = 'sourcing';
        break;

      case 'catalog.results':
        inc.results = { ...data };
        if (data.chosen) inc.step = 'quoting';
        break;

      case 'procurement.quote':
        inc.quote = data.quote || null;
        inc.step = 'quoting';
        break;

      case 'policy.decision':
        inc.verdict = { ...data };
        inc.step = 'approval';
        if (data.action === 'ESCALATE' || data.action === 'BLOCK') inc.attention = true;
        break;

      case 'checkout.approval_required':
        inc.approval = { ...data, pending: true, startT: t };
        inc.step = 'approval';
        inc.attention = true;
        this.selected = id;
        break;

      case 'checkout.completed': {
        const amount = data.finalAmount?.amount ?? inc.quote?.total ?? 0;
        inc.order = { orderId: data.orderId, amount, currency: data.finalAmount?.currency || inc.quote?.currency || 'USD', checkoutId: data.checkoutId, rail: data.rail || null };
        inc.spent += Number(amount) || 0;
        if (inc.approval) inc.approval.pending = false;
        inc.attention = false;
        inc.step = 'shipping';
        break;
      }

      case 'checkout.failed':
        inc.checkoutFailed = { ...data };
        if (inc.approval) inc.approval.pending = false;
        inc.step = 'approval';
        break;

      case 'delivery.dispatched':
        inc.delivery = { etaMinutes: Number(data.etaMinutes ?? (data.etaSeconds != null ? data.etaSeconds / 60 : 6)) || 6, shipping: data.shipping, startT: t, arrived: false };
        inc.step = 'shipping';
        break;

      case 'delivery.arrived':
        if (!inc.delivery) inc.delivery = { etaMinutes: 0, startT: t };
        inc.delivery.arrived = true;
        inc.step = 'repairing';
        break;

      case 'technician.dispatched':
        inc.tech = { technician: data.technician || {}, escrow: data.escrow || null, startT: t };
        inc.step = 'repairing';
        break;

      case 'technician.repairing':
        inc.repair = { minutes: Number(data.minutes) || 4, componentId: data.componentId, startT: t };
        inc.step = 'repairing';
        break;

      case 'part.replaced':
        inc.replaced = true;
        inc.verifyStartT = t;
        inc.step = 'verifying';
        break;

      case 'escrow.released':
        if (inc.tech) inc.tech.escrow = data.escrow || inc.tech.escrow;
        inc.escrowReleased = true;
        if (inc.step !== 'verifying' && inc.replaced) inc.step = 'verifying';
        break;

      case 'incident.resolved':
        inc.status = 'resolved';
        inc.step = 'done';
        inc.summary = data.summary || {};
        inc.attention = false;
        inc.resolvedT = t;
        this.#addHistory(inc);
        this.#linger(inc);
        break;

      case 'incident.error':
        inc.status = data.code === 'BLOCKED' ? 'blocked' : 'error';
        inc.error = { code: data.code || 'ERROR', message: data.message || 'Something went wrong', retryable: data.retryable !== false, step: inc.step };
        inc.attention = true;
        this.selected = id;
        break;

      default:
        return inc;
    }
    this.render();
    return inc;
  }

  // ─── Internals ────────────────────────────────────────────────────────
  #model(i) {
    const m = this.machine(i.machineId);
    return {
      id: i.id,
      kind: i.kind === 'predictive' ? 'predictive' : 'breakdown',
      machineId: i.machineId,
      machineName: m?.name || i.machineId || 'Machine',
      title: i.title || `${m?.name || 'Machine'} needs attention`,
      codes: i.codes || [],
      status: i.status || 'open',
      step: i.step && i.step !== 'done' ? i.step : 'diagnosing',
      attempt: Number(i.attempts) || 0,
      spent: Number(i.spent) || 0,
      thinking: '',
      diagnosis: null,
      ruledOut: [],
      searching: null,
      results: null,
      quote: null,
      verdict: null,
      approval: null,
      order: null,
      checkoutFailed: null,
      delivery: null,
      tech: null,
      repair: null,
      replaced: false,
      escrowReleased: false,
      verifyStartT: null,
      verifyFailed: null,
      error: null,
      summary: null,
      attention: false,
      downMin: 0,
      downCost: 0,
      toggled: {},
      lingerTimer: null,
    };
  }

  #created(incident, envelopeId) {
    const id = incident.id || envelopeId;
    if (!id) return null;
    const existing = this.incidents.get(id);
    if (existing) {
      // Repeated INCIDENT_CREATED: refresh the fields, keep progress.
      Object.assign(existing, {
        title: incident.title || existing.title,
        codes: incident.codes || existing.codes,
        kind: incident.kind || existing.kind,
        machineId: incident.machineId || existing.machineId,
        machineName: this.machine(incident.machineId)?.name || existing.machineName,
      });
      this.render();
      return existing;
    }
    const inc = this.#model({ ...incident, id });
    this.incidents.set(id, inc);
    if (!this.tabs.includes(id)) this.tabs.push(id);
    this.selected = id;
    if (!this.briefTouched) this.briefOpen = false;
    this.render();
    return inc;
  }

  #resetDownstream(inc) {
    Object.assign(inc, {
      searching: null, results: null, quote: null, verdict: null, approval: null, order: null, checkoutFailed: null,
      delivery: null, tech: null, repair: null, replaced: false, escrowReleased: false, verifyStartT: null, verifyFailed: null,
      error: null, toggled: {},
    });
  }

  // A fixed incident stays on screen for a few seconds, then folds into the history list.
  #linger(inc) {
    clearTimeout(inc.lingerTimer);
    inc.lingerTimer = setTimeout(() => {
      if (this.incidents.has(inc.id)) this.#remove(inc.id);
    }, RESOLVED_LINGER_MS);
  }

  #addHistory(inc) {
    this.history = [{ ...inc, lingerTimer: null }, ...this.history.filter((h) => h.id !== inc.id)].slice(0, 6);
  }

  #remove(id) {
    const inc = this.incidents.get(id);
    if (inc) clearTimeout(inc.lingerTimer);
    this.incidents.delete(id);
    this.tabs = this.tabs.filter((x) => x !== id);
    if (this.selected === id) {
      const attn = this.tabs.find((x) => this.incidents.get(x)?.attention);
      this.selected = attn || this.tabs[this.tabs.length - 1] || null;
    }
    this.render();
  }

  #openCount() {
    return this.tabs.length;
  }

  #onClick(e) {
    const t = e.target.closest('[data-a],[data-tab],[data-step]');
    if (!t || !this.root.contains(t)) return;
    if (t.dataset.tab) {
      // Switch cards only: opening the machine popover here would close this popup.
      this.selected = t.dataset.tab;
      this.render();
      return;
    }
    if (t.dataset.step) {
      const inc = this.incidents.get(this.selected);
      if (!inc) return;
      const k = t.dataset.step;
      inc.toggled[k] = !this.#expanded(inc, k);
      this.#renderBody();
      return;
    }
    const a = t.dataset.a;
    const inc = this.incidents.get(t.dataset.id || this.selected);
    if (a === 'close') {
      this.onClose();
    } else if (a === 'brief') {
      this.briefOpen = !this.briefOpen;
      this.briefTouched = true;
      this.#renderBrief();
    } else if (a === 'inspect') {
      const mid = t.dataset.m || inc?.machineId;
      if (mid) this.onInspect(mid);
    } else if (a === 'desk') {
      this.onOpenDesk();
    } else if (a === 'approval' && t.dataset.co) {
      this.onApproval(t.dataset.co);
    } else if (a === 'retry' && inc) {
      this.#retry(inc, t);
    }
  }

  async #retry(inc, btn) {
    btn.disabled = true;
    btn.textContent = 'Retrying…';
    try {
      await this.api('POST', `/incidents/${encodeURIComponent(inc.id)}/retry`);
      inc.status = 'open';
      inc.error = null;
      inc.attention = false;
      inc.thinking = 'Retrying…';
      this.render();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Retry';
      this.toast(`Retry failed: ${err.message}`, 'bad', 'ERROR');
    }
  }

  // ─── Rendering ───────────────────────────────────────────────────────
  render() {
    this.#renderState();
    this.#renderBrief();
    this.#renderTabs();
    this.#renderBody();
    this.#renderHistory();
    this.#persist();
    this.onChange();
  }

  // ─── Reload-proofing (sessionStorage; best effort) ───────────────────
  #persist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        const strip = (inc) => ({ ...inc, lingerTimer: null });
        sessionStorage.setItem(STORE_KEY, JSON.stringify({
          presetId: this.sim?.preset?.id ?? null,
          t: this.sim?.t ?? 0,
          cards: [...this.incidents.values()].filter((i) => i.status !== 'resolved').map(strip),
          history: this.history.map(strip),
        }));
      } catch {}
    }, 500);
  }

  #restore() {
    try {
      const data = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null');
      return data && typeof data === 'object' ? data : null;
    } catch {
      return null;
    }
  }

  #renderState() {
    const open = [...this.incidents.values()].filter(isActive);
    const human = open.filter((i) => i.attention).length;
    let text;
    let cls = '';
    if (!this.sim) text = 'Connecting…';
    else if (human) { text = human === 1 ? 'Needs your OK' : `Needs you (${human})`; cls = 'warn'; }
    else if (open.length === 1) text = `Fixing the ${open[0].machineName}`;
    else if (open.length) text = `On ${open.length} incidents`;
    else if (this.sim.paused) text = 'Shift paused';
    else text = 'Watching the plant';
    const el = this.el.state;
    if (el.textContent !== text) el.textContent = text;
    el.className = `ap-state ${cls}`;
    this.root.querySelector('.ap-avatar')?.classList.toggle('busy', open.length > 0);
  }

  #renderBrief() {
    const p = this.preset;
    const el = this.el.brief;
    if (!p?.name) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = `<button class="ap-brief-h" data-a="brief" aria-expanded="${this.briefOpen}">
        <span class="chip info">Scenario</span><b>${esc(p.name)}</b><i>${this.briefOpen ? '−' : '+'}</i>
      </button>
      ${this.briefOpen ? `<div class="ap-brief-b">
        ${p.tagline ? `<div class="ap-tagline">${esc(p.tagline)}</div>` : ''}
        ${p.teaches ? `<div class="ap-teaches"><span>Watch for</span>${esc(p.teaches)}</div>` : ''}
      </div>` : ''}`;
  }

  #renderTabs() {
    const el = this.el.tabs;
    if (this.tabs.length < 2) {
      el.innerHTML = '';
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    el.innerHTML = this.tabs
      .map((id) => {
        const inc = this.incidents.get(id);
        if (!inc) return '';
        const state = inc.status === 'resolved' ? 'Fixed' : inc.attention ? 'Needs you' : stepLabel(inc.step);
        return `<button class="ap-tab ${id === this.selected ? 'on' : ''} ${inc.attention ? 'attn' : ''} ${inc.status === 'resolved' ? 'done' : ''}" data-tab="${esc(id)}">
          <i class="k-${inc.kind}"></i><span>${esc(inc.machineName)}</span><small>${esc(state)}</small>
        </button>`;
      })
      .join('');
  }

  #renderBody() {
    const el = this.el.body;
    const inc = this.incidents.get(this.selected) || this.incidents.get(this.tabs[this.tabs.length - 1]);
    if (!inc) {
      el.innerHTML = this.#idle();
      return;
    }
    this.selected = inc.id;
    // Keep the scroll position when re-rendering the same card.
    const scroll = this.el.scroll;
    const keep = scroll.dataset.card === inc.id ? scroll.scrollTop : 0;
    el.innerHTML = this.#card(inc);
    scroll.dataset.card = inc.id;
    scroll.scrollTop = keep;
    this.#tickProgress();
  }

  #renderHistory() {
    const el = this.el.history;
    if (!this.history.length) {
      el.innerHTML = '';
      return;
    }
    const rows = this.history.filter((h) => !this.incidents.has(h.id));
    if (!rows.length) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = `<div class="ap-sub">Fixed this shift</div>${rows
      .map((inc) => {
        const s = inc.summary || {};
        const tries = Number(s.attempts) || inc.attempt || 1;
        const down = s.downtimeMin ?? inc.downMin;
        return `<div class="ap-hist" data-a="inspect" data-m="${esc(inc.machineId)}" title="${esc(inc.title)}">
          <span class="chip ${inc.kind === 'predictive' ? 'warn' : 'good'}">${inc.kind === 'predictive' ? 'Caught' : 'Fixed'}</span>
          <span class="nm">${esc(inc.machineName)}</span>
          <small>${mins(down)} · ${money(s.spent ?? inc.spent)}${tries > 1 ? ` · ${tries} tries` : ''}</small>
        </div>`;
      })
      .join('')}`;
  }

  // Nothing open: show what the agent is watching.
  #idle() {
    const sim = this.sim;
    if (!sim) return `<div class="ap-idle"><div class="ap-wait">Waiting for the plant…</div></div>`;
    const predictive = Boolean(this.policy?.predictiveMaintenance);
    const warns = [];
    for (const [key, since] of this.warnSince) {
      const [mid, cid] = key.split('/');
      const m = this.machine(mid);
      const c = m?.components.find((x) => x.id === cid);
      if (!c) continue;
      const running = sim.machines?.[mid]?.status === 'running';
      warns.push({ m, c, minutes: Math.max(0, sim.t - since), running, signal: worstSignal(c, sim.machines?.[mid]?.components?.[cid]) });
    }
    const down = Object.entries(sim.machines || {}).filter(([, m]) => m.status === 'down');

    const lines = warns
      .sort((a, b) => b.minutes - a.minutes)
      .map((w) => {
        const left = PREDICTIVE_AFTER_MIN - w.minutes;
        const act = !w.running
          ? 'machine stopped'
          : predictive
            ? left > 0 ? `orders a spare in ${Math.ceil(left)} min` : 'ordering a spare…'
            : 'predictive OFF: waits for a fault';
        return `<div class="ap-watch" data-a="inspect" data-m="${esc(w.m.id)}">
          <span class="chip warn">Warn</span>
          <div class="grow"><div>${esc(w.m.name)} · ${esc(w.c.name)}</div>
          <small>${w.signal ? `${esc(w.signal)} · ` : ''}${mins(w.minutes)} · ${esc(act)}</small></div>
        </div>`;
      })
      .join('');

    let headline;
    if (down.length) headline = `<div class="ap-idle-h bad">${esc(down.map(([id]) => this.machine(id)?.name || id).join(', '))} stopped. Opening an incident…</div>`;
    else if (warns.length) headline = `<div class="ap-idle-h warn">${warns.length === 1 ? 'One part is' : `${warns.length} parts are`} drifting toward failure.</div>`;
    else if (sim.paused && sim.t === 0) headline = `<div class="ap-idle-h">Pick a scenario to start the shift.</div>`;
    else headline = `<div class="ap-idle-h good">All machines nominal.</div>`;

    return `<div class="ap-idle">
      ${headline}
      <div class="ap-idle-p">Wrench-bot reads the same plant log and sensor signals you see. It never sees a part's hidden health.</div>
      ${lines ? `<div class="ap-sub">Watch list</div>${lines}` : ''}
      <div class="ap-rules">
        <div><span class="chip ${predictive ? 'good' : ''}">${predictive ? 'On' : 'Off'}</span> Predictive maintenance${predictive ? ': acts on a warning that lasts 3 min' : ': acts only when a machine stops'}</div>
        ${this.policy ? `<div><span class="chip">Auto</span> Buys alone up to ${money0(this.policy.autoApproveLimit)} at ${pct(this.policy.confidenceThreshold)}+ sure</div>` : ''}
      </div>
    </div>`;
  }

  #activeIndex(inc) {
    if (inc.status === 'resolved' || inc.step === 'done') return STEPS.length;
    return STEP_INDEX[inc.step] ?? 0;
  }

  #expanded(inc, key) {
    if (key in inc.toggled) return inc.toggled[key];
    const idx = STEP_INDEX[key];
    const active = this.#activeIndex(inc);
    if (inc.status === 'resolved') return false;
    if (idx > active) return false;
    if (inc.status === 'error' || inc.status === 'blocked') return idx === active;
    if (idx === active) return true;
    if (key === 'diagnosing' && active <= STEP_INDEX.approval) return true;
    return idx === active - 1;
  }

  #card(inc) {
    const active = this.#activeIndex(inc);
    const failed = inc.status === 'error' || inc.status === 'blocked';

    const strip = STEPS.map((s, i) => {
      const cls = i < active ? 'done' : i === active ? (failed ? 'fail' : 'on') : '';
      return `<i class="${cls}" title="${s.label}"></i>`;
    }).join('');

    const statusChip = inc.status === 'resolved'
      ? '<span class="chip good">Fixed</span>'
      : failed ? `<span class="chip bad">${inc.status === 'blocked' ? 'Blocked' : 'Stopped'}</span>`
        : inc.attention ? '<span class="chip warn ap-blink">Needs you</span>'
          : `<span class="chip info">${esc(stepLabel(inc.step))}</span>`;

    // Only show the latest remark while the pipeline is still on the step it was made in.
    const waiting = !failed && inc.status === 'open' && inc.approval?.pending;
    const thinking = inc.thinking && inc.status !== 'resolved' && !failed && (inc.thinkingStep == null || inc.thinkingStep === inc.step)
      ? `<div class="ap-thinking"><span>&gt;</span> ${esc(inc.thinking)}</div>` : '';

    const steps = STEPS.map((s, i) => this.#step(inc, s, i, active, failed)).join('');

    return `<article class="ap-card k-${inc.kind} ${inc.status}">
      <header class="ap-card-h">
        <div class="ap-chips">
          <span class="chip ${inc.kind === 'predictive' ? 'warn' : 'bad'}">${inc.kind === 'predictive' ? 'Predictive' : 'Breakdown'}</span>
          ${statusChip}
          ${inc.attempt > 1 ? `<span class="chip">Try ${inc.attempt}/3</span>` : ''}
        </div>
        <div class="ap-title" data-a="inspect" title="Show this machine's signals">${esc(inc.title)}</div>
        <div class="ap-meta"><span data-live="mline">${this.#machineLine(inc)}</span><span data-live="down">${this.#downText(inc)}</span></div>
        <div class="ap-strip" title="${esc(stepLabel(inc.step))}">${strip}</div>
      </header>
      ${inc.status === 'resolved' ? this.#resolved(inc) : ''}
      ${failed && inc.error ? this.#error(inc) : ''}
      ${waiting ? this.#cta(inc) : thinking}
      <ol class="ap-steps">${steps}</ol>
    </article>`;
  }

  #machineLine(inc) {
    const status = this.sim?.machines?.[inc.machineId]?.status;
    const cost = this.machine(inc.machineId)?.downtimeCostPerMin || 0;
    if (status === 'down') return `<b class="badtxt">${esc(inc.machineName)} down</b> <span class="badtxt">−${money0(cost)}/min</span>`;
    if (status === 'maintenance') return `<b class="mainttxt">${esc(inc.machineName)} locked out</b> <span class="mainttxt">−${money0(cost)}/min</span>`;
    if (status === 'running') return `<b class="goodtxt">${esc(inc.machineName)} running</b>`;
    return `<b>${esc(inc.machineName)}</b>`;
  }

  #downText(inc) {
    if (!inc.downMin) return inc.kind === 'predictive' && inc.status !== 'resolved' ? 'still producing' : '';
    return `down ${mins(inc.downMin)} · −${money0(inc.downCost)}`;
  }

  #step(inc, s, i, active, failed) {
    const state = i < active ? 'done' : i === active ? (failed ? 'fail' : 'on') : 'todo';
    const open = state !== 'todo' && this.#expanded(inc, s.key);
    const summary = state === 'todo' ? '' : this.#summary(inc, s.key);
    const body = open ? this.#stepBody(inc, s.key) : '';
    return `<li class="ap-step ${state} ${open ? 'open' : ''}">
      <button class="ap-step-h" data-step="${s.key}" ${state === 'todo' ? 'disabled' : ''}>
        <i class="mk"></i><b>${s.label}</b><span>${summary}</span>
      </button>
      ${body ? `<div class="ap-step-b">${body}</div>` : ''}
    </li>`;
  }

  #summary(inc, key) {
    switch (key) {
      case 'diagnosing':
        return inc.diagnosis ? `${esc(inc.diagnosis.component)} · ${pct(inc.diagnosis.confidence)}` : 'reading signals…';
      case 'sourcing': {
        const c = inc.results?.chosen;
        if (c) return `${esc(c.merchant)} · ${money(c.price)}`;
        if (inc.results) return '<span class="badtxt">nothing found</span>';
        return 'searching Reap…';
      }
      case 'quoting':
        return inc.quote ? `${money(inc.quote.total)} total` : 'asking for a quote…';
      case 'approval': {
        const v = inc.verdict;
        if (inc.checkoutFailed) return `<span class="badtxt">${esc(inc.checkoutFailed.status === 'EXPIRED' ? 'rejected' : (inc.checkoutFailed.status || 'failed').toLowerCase())}</span>`;
        if (inc.order) return `<span class="goodtxt">${v?.action === 'ESCALATE' ? 'approved by you' : 'auto-approved'}</span>${inc.order.rail ? ` · ${esc(railText(inc.order.rail))}` : ''}`;
        if (inc.approval?.pending) return '<span class="warntxt">waiting for you</span>';
        if (v?.action === 'BLOCK') return '<span class="badtxt">blocked</span>';
        if (v?.action === 'ESCALATE') return '<span class="warntxt">needs you</span>';
        if (v?.action === 'AUTO') return 'paying…';
        return 'checking policy…';
      }
      case 'shipping':
        if (inc.delivery?.arrived) return 'at the dock';
        if (inc.delivery) return `${esc(inc.delivery.shipping?.name || 'Standard')} · <span data-live="eta-ship"></span>`;
        return 'booking…';
      case 'repairing':
        if (inc.replaced && inc.escrowReleased) return `${esc(inc.tech?.technician?.name || 'Tech')} · paid${inc.tech?.escrow?.onchain ? ' onchain' : ''}`;
        if (inc.replaced) return `${esc(inc.tech?.technician?.name || 'Tech')} · part replaced`;
        if (inc.repair) return `${esc(inc.tech?.technician?.name || 'Tech')} · replacing`;
        if (inc.tech) return `${esc(inc.tech.technician?.name || 'Tech')} · on the way`;
        return 'calling a technician…';
      case 'verifying':
        if (inc.status === 'resolved') return '<span class="goodtxt">healthy</span>';
        if (inc.verifyFailed) return '<span class="badtxt">still faulting</span>';
        return 'watching signals…';
      default:
        return '';
    }
  }

  #stepBody(inc, key) {
    switch (key) {
      case 'diagnosing': return this.#diagnosis(inc);
      case 'sourcing': return this.#listings(inc);
      case 'quoting': return this.#quote(inc);
      case 'approval': return this.#approval(inc);
      case 'shipping': return this.#shipping(inc);
      case 'repairing': return this.#repair(inc);
      case 'verifying': return this.#verify(inc);
      default: return '';
    }
  }

  #diagnosis(inc) {
    const d = inc.diagnosis;
    const ruled = inc.ruledOut.length
      ? `<div class="ap-ruled">${inc.ruledOut.map((r) => `<div><s>${esc(r.name)}</s> <em>replaced on try ${r.attempt}, fault came back</em></div>`).join('')}</div>`
      : '';
    if (!d) return `${ruled}<div class="ap-wait">Reading the plant log and live signals of the ${esc(inc.machineName)}…</div>`;
    const prior = d.prior && typeof d.prior === 'object' ? d.prior : null;
    const probs = Object.entries(d.probabilities || {})
      .map(([k, v]) => [k, Number(v) || 0])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    const bars = probs
      .map(([name, p]) => {
        const r = prior ? Number(prior[name]) || 0 : null;
        return `<div class="ap-prob ${name === d.component ? 'top' : ''}">
        <span class="nm" title="${esc(name)}">${esc(name)}</span>
        <div class="bars">
          <div class="bar" title="Model: ${pct(p)}"><i style="width:${(clamp01(p) * 100).toFixed(1)}%"></i></div>
          ${r != null ? `<div class="bar prior" title="Fault-code rule: ${pct(r)}"><i style="width:${(clamp01(r) * 100).toFixed(1)}%"></i></div>` : ''}
        </div>
        <b>${pct(p)}${r != null ? `<em>${pct(r)}</em>` : ''}</b>
      </div>`;
      })
      .join('');
    const legend = prior
      ? `<div class="ap-legend"><span><i class="k-model"></i>${esc(providerName(d.provider))}</span><span><i class="k-prior"></i>fault-code rule</span></div>`
      : '';
    const evidence = (Array.isArray(d.evidence) ? d.evidence : []).slice(0, 4)
      .map((line) => `<li class="${evidenceClass(line)}">${esc(line)}</li>`)
      .join('');
    const threshold = this.policy?.confidenceThreshold;
    const unsure = threshold != null && Number(d.confidence) < threshold;
    return `${ruled}
      ${legend}<div class="ap-probs">${bars}</div>
      ${evidence ? `<div class="ap-sub">Evidence from the log</div><ul class="ap-evidence">${evidence}</ul>` : ''}
      ${d.explanation ? `<div class="ap-say">${esc(d.explanation)}</div>` : ''}
      <div class="ap-src">${esc(d.provider || 'model')} · ${pct(d.confidence)} sure${unsure ? ` <span class="warntxt">(below your ${pct(threshold)} bar)</span>` : ''} · <a data-a="inspect">view signals</a></div>`;
  }

  #listings(inc) {
    const r = inc.results;
    if (!r) {
      return inc.searching
        ? `<div class="ap-wait">Searching Reap for "${esc(inc.searching.query || inc.searching.part)}"…</div>`
        : '<div class="ap-wait">Looking up the part…</div>';
    }
    const offers = Array.isArray(r.offers) ? r.offers.slice(0, 5) : [];
    if (!offers.length) return `<div class="ap-wait badtxt">No listing matched "${esc(r.query || r.part?.name)}".</div>`;
    const trusted = this.policy?.allowedMerchants || null;
    const rows = offers
      .map((o) => {
        const p = Number(r.probabilities?.[o.productId] ?? 0);
        const chosen = r.chosen && (o.variantId === r.chosen.variantId);
        const untrusted = trusted && !trusted.includes(o.merchant);
        return `<div class="ap-offer ${chosen ? 'chosen' : ''}">
          ${o.image ? `<img src="${esc(o.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('i'),{className:'noimg'}))">` : '<i class="noimg"></i>'}
          <div class="grow">
            <div class="nm" title="${esc(o.name)}">${esc(o.name)}</div>
            <small>${esc(o.merchant)}${untrusted ? ' <span class="warntxt">(not trusted)</span>' : ''} · ${money(o.price)}${o.qty > 1 ? ` ×${o.qty}` : ''}</small>
            <div class="bar thin"><i style="width:${(clamp01(p) * 100).toFixed(1)}%"></i></div>
          </div>
          <b>${chosen ? '<span class="pick">Pick</span>' : ''}<em>${pct(p)}</em></b>
        </div>`;
      })
      .join('');
    const src = r.source === 'live' ? 'live Reap search' : r.source === 'fallback' ? 'verified fallback' : 'offline cache';
    return `<div class="ap-q">${esc(r.part?.name || '')}${r.part?.qty > 1 ? ` ×${r.part.qty}` : ''} <small>"${esc(r.query || '')}" · ${esc(src)}${r.provider ? ` · ${esc(r.provider)}` : ''}</small></div>${rows}`;
  }

  #quote(inc) {
    const q = inc.quote;
    if (!q) return `<div class="ap-wait">${inc.thinking && /quote/i.test(inc.thinking) ? esc(inc.thinking) : 'Asking the store for a live quote…'}</div>`;
    const items = (q.items || []).map((it) => `${esc(it.name)}${it.qty > 1 ? ` ×${it.qty}` : ''}`).join(', ');
    return `<div class="ap-receipt">
      <div class="ap-q">${esc(q.merchant)}<small>${items ? ` · ${items}` : ''}</small></div>
      <div class="row"><span>Items</span><b>${money(q.subtotal)}</b></div>
      <div class="row"><span>Shipping${q.shipping?.name ? ` (${esc(q.shipping.name)})` : ''}</span><b>${money(q.shipping?.amount)}</b></div>
      <div class="row"><span>Tax</span><b>${money(q.tax)}</b></div>
      <div class="row total"><span>Total</span><b>${money(q.total)} <small>${esc(q.currency || 'USD')}</small></b></div>
    </div>`;
  }

  #approval(inc) {
    const v = inc.verdict;
    if (!v) return '<div class="ap-wait">Checking the spending rules…</div>';
    const cls = { AUTO: 'good', ESCALATE: 'warn', BLOCK: 'bad' }[v.action] || 'warn';
    const label = { AUTO: 'Within limits: auto-buy', ESCALATE: 'Asks the manager', BLOCK: 'Blocked by policy' }[v.action] || v.action;
    const reasons = (v.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('');
    let after = '';
    if (inc.approval?.pending) {
      after = `<div class="ap-ask">Waiting for your decision on ${money(inc.approval.total)}.
        <button class="small accent" data-a="approval" data-co="${esc(inc.approval.checkoutId)}">Review</button></div>`;
    } else if (inc.order) {
      after = `<div class="ap-paid"><span class="chip good">Paid</span> ${money(inc.order.amount)}${inc.order.rail ? ` · ${esc(railText(inc.order.rail))}` : ''} · order ${esc(inc.order.orderId || '-')}</div>`;
    } else if (inc.checkoutFailed) {
      after = `<div class="ap-paid bad"><span class="chip bad">${esc(inc.checkoutFailed.status || 'FAILED')}</span> ${esc(inc.checkoutFailed.reason || 'Checkout failed')}</div>`;
    } else if (v.action === 'AUTO') {
      after = '<div class="ap-wait">Paying…</div>';
    }
    const desk = v.action === 'BLOCK' ? ' <a data-a="desk">open desk</a>' : '';
    return `<div class="ap-verdict ${cls}">
        <div class="ap-verdict-h"><b>${label}</b><span>${money(v.total)} · ${pct(v.confidence)} sure${desk}</span></div>
        ${reasons ? `<ul>${reasons}</ul>` : ''}
      </div>${after}`;
  }

  #shipping(inc) {
    const d = inc.delivery;
    if (!d) return '<div class="ap-wait">Booking the delivery…</div>';
    if (d.arrived) return '<div class="ap-line"><span class="chip good">Delivered</span> Crate at the loading dock.</div>';
    return `<div class="ap-line">${esc(d.shipping?.name || 'Standard')} shipping${d.shipping?.amount != null ? ` (${money(d.shipping.amount)})` : ''}, ETA ${mins(d.etaMinutes)} game time</div>
      ${progress('ship')}`;
  }

  #repair(inc) {
    const t = inc.tech;
    if (!t) return '<div class="ap-wait">Picking a technician for the job…</div>';
    const tech = t.technician || {};
    const esc0 = t.escrow;
    let escrow = '';
    if (esc0 && inc.escrowReleased) {
      const p = escrowPaid(esc0, tech.name);
      escrow = `<div class="ap-line"><span class="chip good">Paid</span> ${esc(p.text)}${p.href ? ` <a href="${esc(p.href)}" target="_blank" rel="noopener noreferrer">onchain ↗</a>` : ''}${p.note ? ` <span class="muted">(${esc(p.note)})</span>` : ''}</div>`;
    } else if (esc0) {
      escrow = `<div class="ap-line"><span class="chip agent">Escrow</span> ${esc(usdcAmount(esc0.amountUsdc ?? esc0.amount))} ${esc(esc0.currency || 'USDC')} locked until the fix is done</div>`;
    }
    let phase;
    if (inc.replaced) phase = '<div class="ap-line goodtxt">Part replaced.</div>';
    else if (inc.repair) phase = `<div class="ap-line">Lockout, replacing the part</div>${progress('repair')}`;
    else phase = `<div class="ap-line">Walking to the ${esc(inc.machineName)}</div>${progress('travel')}`;
    return `<div class="ap-tech">
        <i style="background:${esc(safeColor(tech.color))}"></i>
        <div><b>${esc(tech.name || 'Technician')}</b> ${tech.rating ? `<small>${esc(tech.rating)}/5</small>` : ''}<br>
        <small>${esc((tech.skills || []).join(', '))}${tech.rate ? ` · ${money0(tech.rate)}/job` : ''}</small></div>
      </div>${escrow}${phase}`;
  }

  #verify(inc) {
    if (inc.status === 'resolved') return '<div class="ap-line goodtxt">No fault codes. Signals back in range.</div>';
    if (inc.verifyFailed) return `<div class="ap-line badtxt">${esc(inc.verifyFailed)}</div>`;
    return `<div class="ap-line">Watching the signals after the swap</div>${progress('verify')}`;
  }

  // Approval waiting: the one thing the manager has to do, at the top of the card.
  #cta(inc) {
    const a = inc.approval;
    const reason = (a.reasons || inc.verdict?.reasons || [])[0];
    return `<div class="ap-cta">
      <div><span class="chip warn">Your call</span> ${inc.verdict?.action === 'AUTO' ? 'Confirm' : 'Approve'} ${money(a.total)}${inc.quote?.merchant ? ` at ${esc(inc.quote.merchant)}` : ''}?</div>
      ${reason ? `<div class="ap-hint">${esc(reason)}</div>` : ''}
      <div class="ap-btns"><button class="small accent" data-a="approval" data-co="${esc(a.checkoutId)}">Review order</button></div>
    </div>`;
  }

  #error(inc) {
    const e = inc.error;
    const hint = ERROR_HINTS[e.code];
    return `<div class="ap-error">
      <div><span class="chip bad">${esc(e.code)}</span> ${esc(e.message)}</div>
      ${hint ? `<div class="ap-hint">${esc(hint.text)}</div>` : ''}
      <div class="ap-btns">
        ${e.retryable ? `<button class="small good" data-a="retry" data-id="${esc(inc.id)}">Retry</button>` : ''}
        ${hint?.desk ? '<button class="small ghost" data-a="desk">Open Manager\'s Desk</button>' : ''}
      </div>
    </div>`;
  }

  #resolved(inc) {
    const s = inc.summary || {};
    const parts = Number(s.spent ?? inc.spent) || 0;
    const labor = Number(s.labor ?? inc.tech?.technician?.rate) || 0;
    const downMin = s.downtimeMin != null ? Number(s.downtimeMin) : inc.downMin;
    const costMin = this.machine(inc.machineId)?.downtimeCostPerMin || 0;
    const downCost = s.downtimeMin != null ? Number(s.downtimeMin) * costMin : inc.downCost;
    const tries = Number(s.attempts) || inc.attempt || 1;
    const approval = s.approval === 'AUTO' ? 'auto-approved' : s.approval === 'ESCALATE' ? 'approved by you' : '';
    return `<div class="ap-done">
      <div class="ap-done-h">${inc.kind === 'predictive' ? 'Caught early' : 'Back online'}</div>
      ${s.component ? `<div class="ap-done-c">${inc.kind === 'predictive' ? 'Replaced' : 'Root cause'}: <b>${esc(s.component)}</b>${inc.ruledOut.length ? ` <span class="muted">(after ruling out ${esc(inc.ruledOut.map((r) => r.name).join(', '))})</span>` : ''}</div>` : ''}
      <div class="ap-done-g">
        <span>Parts</span><b>${money(parts)}</b>
        <span>Labor</span><b>${labor ? money(labor) : '-'}</b>
        <span>Downtime</span><b>${mins(downMin)}${downCost ? ` · ${money0(downCost)}` : ''}</b>
        <span>Total cost</span><b class="tot">${money(parts + labor + downCost)}</b>
      </div>
      <small>${tries > 1 ? `${tries} tries · ` : ''}${approval}${s.orderId ? ` · order ${esc(s.orderId)}` : ''}${s.technician ? ` · ${esc(s.technician)}` : ''}</small>
    </div>`;
  }

  // Progress bars driven by game time (respects speed and pause).
  #tickProgress() {
    const inc = this.incidents.get(this.selected);
    const t = this.sim?.t;
    if (!inc) return;
    const down = this.el.body.querySelector('[data-live=down]');
    if (down) down.textContent = this.#downText(inc);
    const mline = this.el.body.querySelector('[data-live=mline]');
    if (mline) {
      const html = this.#machineLine(inc);
      if (mline.innerHTML !== html) mline.innerHTML = html;
    }
    if (t == null) return;
    const set = (name, start, total) => {
      const box = this.el.body.querySelector(`[data-prog=${name}]`);
      if (!box || start == null || !total) return null;
      const done = clamp01((t - start) / total);
      box.querySelector('i').style.width = `${(done * 100).toFixed(1)}%`;
      const left = Math.max(0, total - (t - start));
      const label = box.parentElement.querySelector(`[data-left=${name}]`);
      if (label) label.textContent = left > 0 ? `${left < 1 ? '<1' : Math.ceil(left)} min left` : 'any moment';
      return left;
    };
    const d = inc.delivery;
    const shipLeft = d && !d.arrived ? set('ship', d.startT, d.etaMinutes) : null;
    const eta = this.el.body.querySelector('[data-live=eta-ship]');
    if (eta) eta.textContent = shipLeft == null ? '' : shipLeft > 0 ? `${Math.ceil(shipLeft)} min` : 'arriving';
    if (inc.tech && !inc.repair) set('travel', inc.tech.startT, TECH_TRAVEL_MIN);
    if (inc.repair && !inc.replaced) set('repair', inc.repair.startT, inc.repair.minutes);
    if (inc.replaced && inc.status !== 'resolved') set('verify', inc.verifyStartT, VERIFY_MIN);
  }
}

// ─── Approval modal ───────────────────────────────────────────────────────
// Pops by itself when Wrench-bot needs the manager (the one essential action).
// Live Reap: every checkout needs one tap on Reap's hosted page, even within
// limits, so the copy depends on the policy verdict. Mock Reap: APPROVE / REJECT
// buttons stand in for that page (POST /api/mock/approve/:checkoutId).
// Esc is routed by UI.js (hide()).
export class ApprovalModal {
  constructor(root, { api, toast, machines = MACHINES } = {}) {
    this.root = root;
    this.api = api;
    this.toast = toast || (() => {});
    this.machines = machines;
    this.queue = new Map(); // checkoutId → { incidentId, data, inc, startT }
    this.current = null;
    this.hiddenByUser = false;
    this.mock = false;
    this.sim = null;
    root.className = 'ap-modal-back hidden';
    root.addEventListener('click', (e) => this.#onClick(e));
  }

  get visible() {
    return !this.root.classList.contains('hidden');
  }

  setMode(mode) {
    this.mock = Boolean(mode?.mockReap);
    if (this.current) this.#render();
  }

  open(incidentId, data = {}, inc = null) {
    if (!data.checkoutId) return;
    this.queue.set(data.checkoutId, { incidentId, data, inc, startT: data.startT ?? this.sim?.t ?? null });
    this.hiddenByUser = false;
    this.show(data.checkoutId);
  }

  has(checkoutId) {
    return this.queue.has(checkoutId);
  }

  show(checkoutId) {
    const id = checkoutId && this.queue.has(checkoutId) ? checkoutId : this.queue.keys().next().value;
    if (!id) return this.#close();
    this.current = id;
    this.#render();
    this.root.classList.remove('hidden');
    this.root.querySelector('[data-a=yes],[data-a=link]')?.focus();
  }

  /** User dismissed it (live mode keeps waiting for Reap). */
  hide() {
    this.hiddenByUser = true;
    this.root.classList.add('hidden');
  }

  /** The checkout finished (completed / failed / incident gone). */
  resolve(checkoutId) {
    if (!checkoutId) return;
    this.queue.delete(checkoutId);
    if (this.current === checkoutId) {
      this.current = null;
      if (this.queue.size && !this.hiddenByUser) this.show();
      else this.#close();
    }
  }

  /** Drop every approval that belongs to an incident. */
  dropIncident(incidentId) {
    for (const [co, q] of this.queue) if (q.incidentId === incidentId) this.resolve(co);
  }

  clear() {
    this.queue.clear();
    this.#close();
  }

  updateSim(sim) {
    this.sim = sim;
    if (!this.current || this.root.classList.contains('hidden')) return;
    const q = this.queue.get(this.current);
    const el = this.root.querySelector('[data-k=wait]');
    if (!q || !el) return;
    const html = this.#waitText(q);
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  #close() {
    this.current = null;
    this.root.classList.add('hidden');
    this.root.innerHTML = '';
  }

  #waitText(q) {
    const machineId = q.inc?.machineId;
    const m = this.machines.find((x) => x.id === machineId);
    const status = this.sim?.machines?.[machineId]?.status;
    if (!m) return '';
    if (status === 'running') return `The ${esc(m.name)} is still running, so there is time to decide.`;
    const waited = q.startT != null && this.sim ? Math.max(0, this.sim.t - q.startT) : 0;
    return `The ${esc(m.name)} is down: <b class="badtxt">−${money0(m.downtimeCostPerMin)}/min</b> while you decide${waited >= 1 ? ` (waited ${Math.round(waited)} min, ${money0(waited * m.downtimeCostPerMin)})` : ''}.`;
  }

  #render() {
    const q = this.queue.get(this.current);
    if (!q) return this.#close();
    const { data, inc } = q;
    const quote = inc?.quote;
    const reasonsList = (data.reasons?.length ? data.reasons : inc?.verdict?.reasons) || [];
    // AUTO = within the manager's limits; live Reap still wants one tap on its page.
    const action = inc?.verdict?.action || (reasonsList.length ? 'ESCALATE' : 'AUTO');
    const within = action === 'AUTO';
    const items = (quote?.items || []).map((it) => `<div class="ap-m-item">
        ${it.image ? `<img src="${esc(it.image)}" alt="" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('i'),{className:'noimg'}))">` : '<i class="noimg"></i>'}
        <div><div class="nm">${esc(it.name)}</div><small>${it.qty > 1 ? `${it.qty} × ` : ''}${it.price != null ? money(it.price) : ''}${quote.merchant ? ` · ${esc(quote.merchant)}` : ''}</small></div>
      </div>`).join('');
    const reasons = within ? '' : reasonsList.map((r) => `<li>${esc(r)}</li>`).join('');
    const d = inc?.diagnosis;
    const more = this.queue.size - 1;
    const total = data.total ?? quote?.total;
    const headline = within ? 'Within your limits — confirm on Reap (one tap)' : 'Needs your decision';
    const sub = within
      ? 'This order passed every spending rule. Reap asks for one tap on its page before it charges the card.'
      : 'Wrench-bot stopped before paying: this order is outside the rules you set.';
    this.root.innerHTML = `<div class="ap-modal ${within ? 'is-within' : 'is-escalate'}" role="dialog" aria-modal="true" aria-labelledby="ap-m-title">
      <div class="ap-m-h"><span class="chip ${within ? 'good' : 'warn'}">${within ? 'Within limits' : 'Approval needed'}</span>${more > 0 ? `<small>${more} more waiting</small>` : ''}<button class="pop-x" data-a="hide" aria-label="Close" title="Later (Esc)">✕</button></div>
      <h2 class="ap-m-title" id="ap-m-title">${headline}</h2>
      <p class="ap-m-sub">${sub}</p>
      <div class="ap-m-for">${inc ? esc(inc.title) : 'Wrench-bot wants to place an order.'}</div>
      ${items ? `<div class="ap-m-items">${items}</div>` : ''}
      <div class="ap-m-total"><span>Total</span><b>${money(total)}</b><small>${esc(quote?.currency || 'USD')} incl. shipping + tax</small></div>
      ${reasons ? `<div class="ap-sub">Why it asks you</div><ul class="ap-m-reasons">${reasons}</ul>` : ''}
      ${d ? `<div class="ap-m-diag">Diagnosis: <b>${esc(d.component)}</b> at ${pct(d.confidence)} confidence${inc.attempt > 1 ? ` (try ${inc.attempt})` : ''}</div>` : ''}
      <div class="ap-m-wait" data-k="wait">${this.#waitText(q)}</div>
      <div class="ap-m-btns">
        ${this.mock
          ? `<button class="good" data-a="yes">Approve ${money(total)}</button><button class="bad" data-a="no">Reject</button>`
          : `<a class="btn good" data-a="link" href="${esc(safeUrl(data.approvalUrl))}" target="_blank" rel="noopener noreferrer">${within ? 'Confirm on Reap ↗' : 'Open Reap to decide ↗'}</a><button class="ghost" data-a="hide">Later</button>`}
      </div>
      <small class="ap-m-foot">${this.mock
        ? 'Offline mode: these buttons stand in for Reap\'s hosted approval page.'
        : 'Reap sandbox: on Reap\'s page choose SMS or email and enter the code <b>456789</b>. The order continues by itself once Reap confirms.'}</small>
    </div>`;
  }

  async #onClick(e) {
    if (e.target === this.root) {
      this.hide();
      return;
    }
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a || a === 'link') return;
    if (a === 'hide') return this.hide();
    const co = this.current;
    if (!co) return;
    const approve = a === 'yes';
    for (const b of this.root.querySelectorAll('button')) b.disabled = true;
    try {
      await this.api('POST', `/mock/approve/${encodeURIComponent(co)}`, { approve });
      this.toast(approve ? 'Approved. Wrench-bot is placing the order.' : 'Rejected. The machine stays down.', approve ? 'good' : 'warn', approve ? 'APPROVED' : 'REJECTED');
      this.resolve(co);
    } catch (err) {
      for (const b of this.root.querySelectorAll('button')) b.disabled = false;
      this.toast(`Could not send the decision: ${err.message}`, 'bad', 'ERROR');
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function isActive(inc) {
  return inc.status !== 'resolved' && inc.status !== 'cancelled';
}

function stepLabel(step) {
  if (step === 'done') return 'Done';
  return STEPS.find((s) => s.key === step)?.label || 'Working';
}

function progress(name) {
  return `<div class="ap-prog"><div class="bar thin" data-prog="${name}"><i style="width:0%"></i></div><small data-left="${name}"></small></div>`;
}

function evidenceClass(line) {
  const s = String(line);
  if (/^\s*(FAULT|ERROR)\b|\(limit\b/i.test(s)) return 'bad';
  if (/^\s*WARN\b|\(warn\b|falling|rising|dropping|climbing/i.test(s)) return 'warn';
  return '';
}

function worstSignal(def, reading) {
  if (!def?.signals || !reading?.readings) return '';
  let best = null;
  for (const s of def.signals) {
    const v = reading.readings[s.key];
    if (v == null) continue;
    const span = s.fail - s.nominal;
    const sev = span ? (v - s.nominal) / span : 0;
    if (!best || sev > best.sev) best = { s, v, sev };
  }
  if (!best) return '';
  const { s, v } = best;
  return `${s.label} ${Number(v).toFixed(s.digits ?? 1)} ${s.unit}`;
}

function safeColor(c) {
  return /^#[0-9a-f]{3,8}$/i.test(String(c || '')) ? c : '#88c0d0';
}

function safeUrl(u) {
  return /^https?:\/\//i.test(String(u || '')) ? u : '#';
}

function usdcAmount(n) {
  return Number.isFinite(Number(n)) ? Number(n).toFixed(2) : String(n ?? '');
}

/** CHECKOUT_COMPLETED rail → how the order was paid. */
export function railText(rail) {
  if (rail === 'kwal') return 'Paid from Kwal vault (USDC)';
  if (rail === 'reap') return 'Paid by Reap card';
  return '';
}

/**
 * ESCROW_RELEASED → "Paid Ana 1.20 USDC onchain" (+ explorer link) or "… (simulated: reason)".
 * @returns {{ text, href, note, onchain }}
 */
export function escrowPaid(escrow = {}, name) {
  const who = name || 'the technician';
  const amount = `${usdcAmount(escrow.amountUsdc ?? escrow.amount)} ${escrow.currency && escrow.currency !== 'USD' ? escrow.currency : 'USDC'}`;
  const href = escrow.onchain && /^https?:\/\//i.test(String(escrow.txUrl || '')) ? escrow.txUrl : '';
  if (escrow.onchain) return { text: `Paid ${who} ${amount}`, href, note: href ? '' : 'onchain', onchain: true };
  return { text: `Paid ${who} ${amount}`, href: '', note: `simulated${escrow.simulatedReason ? `: ${escrow.simulatedReason}` : ''}`, onchain: false };
}

function providerName(p) {
  const s = String(p || '').toLowerCase();
  if (!s || s === 'mock') return 'model (offline)';
  if (s.includes('decision')) return 'Decisions API';
  if (s.includes('gpt') || s.includes('openai')) return 'GPT model';
  return p;
}
