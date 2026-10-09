// DOM overlay facade (docs/UI_SPEC.md). The 3D world fills the window; by
// default only the essentials float over it:
//   top bar (top-left) · terminal log (bottom-right) · agent chips (top-centre,
//   only while incidents are open) · hint chips over degraded / down machines ·
//   speech bubble · floating texts · approval modal (pops by itself).
// Everything else is a popup, one at a time (Esc / ✕ / click outside closes it):
//   machine popover (right) · agent popup (left) · ☰ menu → Scenarios,
//   Manager's Desk, Chaos, Spare parts (centred modals).
// director.js calls the methods below; panels never talk to the world directly.

import { MACHINES, PRESETS } from '../../../shared/contract.js';
import { Hud, modeBadges } from './hud.js';
import { ScenarioPicker } from './scenarios.js';
import { PlantLog } from './plantlog.js';
import { Inspector, warnCode } from './inspector.js';
import { AgentPanel, ApprovalModal, escrowPaid, railText } from './agentpanel.js';
import { Desk } from './desk.js';
import { Chaos } from './chaos.js';
import { CatalogPanel } from './catalogpanel.js';

const $ = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const svg = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  wrench: svg('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3.5 17.5a2.1 2.1 0 0 0 3 3l5.8-5.8a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.6-.4-.4-2.6z"/>'),
  warn: svg('<path d="M12 3.5 2.5 20h19L12 3.5z"/><path d="M12 10v4.5"/><path d="M12 17.5h.01"/>'),
  x: svg('<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>'),
  play: svg('<path d="M7 4.5v15l12.5-7.5z"/>'),
  bot: svg('<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 4v4M9 13.5h.01M15 13.5h.01"/>'),
  sliders: svg('<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>'),
  bolt: svg('<path d="M13 2.5 4.5 14H11l-1 7.5L18.5 10H12z"/>'),
  box: svg('<path d="M21 7.5 12 3 3 7.5v9L12 21l9-4.5z"/><path d="m3 7.5 9 4.5 9-4.5M12 12v9"/>'),
};

const MODALS = {
  desk: { title: "Manager's Desk", sub: 'The spending rules Wrench-bot must follow.' },
  chaos: { title: 'Chaos', sub: 'Break a part on purpose. Wrench-bot is not told: it has to notice.' },
  parts: { title: 'Spare parts', sub: 'The best live listing for every part, from Reap.' },
};
const MENU = [
  { id: 'scenarios', label: 'Scenarios', sub: 'Restart the shift with another situation', icon: 'play' },
  { id: 'agent', label: 'Wrench-bot', sub: 'What the agent is doing and why', icon: 'bot' },
  { id: 'desk', label: "Manager's Desk", sub: 'Spending limit, budget, trusted stores', icon: 'sliders' },
  { id: 'chaos', label: 'Chaos', sub: 'Break a part on purpose', icon: 'bolt' },
  { id: 'parts', label: 'Spare parts', sub: 'Live prices from Reap', icon: 'box' },
];
const FLOAT_MS = 2600;
const EXPLORED_KEY = 'wrenchbot.explored';
const TOAST_LEVEL = { bad: 'ERROR', warn: 'WARN', agent: 'AGENT', good: 'INFO', info: 'INFO' };

/** Run a panel call without letting one broken panel take the whole UI down. */
function safe(label, fn) {
  try {
    return fn();
  } catch (err) {
    console.error(`[ui] ${label} failed`, err);
    return undefined;
  }
}

export class UI {
  /**
   * @param root        the #ui element
   * @param opts.world  World (screenPos only: bubble, floating texts, hint chips)
   * @param opts.api    (method, path, body) => Promise
   */
  constructor(root, { world, api, machines = MACHINES } = {}) {
    this.root = root;
    this.world = world;
    this.api = api;
    this.machines = machines;
    this.state = null;
    this.sim = null;
    this.policy = null;
    this.mode = null;
    this.presets = PRESETS.map(({ id, name, tagline, teaches }) => ({ id, name, tagline, teaches }));
    this.onSelectMachine = null; // set by the director: (machineId | null, opts) => void
    this.floats = [];
    this.bubbleState = null;
    this.ready = false;
    this.open = null; // the one popup on screen: machine | agent | menu | desk | chaos | parts
    this.machineId = null;
    this.pickedAt = -Infinity;
    this.flags = new Set(); // menu items that want attention (desk)
    this.chipsSig = '';
    try {
      this.explored = localStorage.getItem(EXPLORED_KEY) === '1';
    } catch {
      this.explored = false;
    }

    // ─── Layers (all position: fixed over the world) ───
    root.append(
      (this.hintLayer = $('<div class="hint-layer"></div>')),
      (this.floatLayer = $('<div class="float-layer" aria-hidden="true"></div>')),
      (this.bubble = $('<div class="bubble hidden" role="status" aria-live="polite"><span class="who">Wrench-bot</span><span class="txt"></span></div>')),
      (this.slotHud = $('<div class="slot-hud"></div>')),
      (this.chipsEl = $('<div class="ac-chips" aria-label="What Wrench-bot is doing"></div>')),
      (this.slotLog = $('<div class="slot-log"></div>')),
      (this.firstHint = $('<div class="first-hint hidden">Click any machine to see its sensors</div>')),
      (this.machinePop = $('<aside class="pop pop-machine hidden" aria-label="Machine details"></aside>')),
      (this.agentPop = $('<aside class="pop pop-agent hidden" aria-label="Wrench-bot"></aside>')),
      (this.menuEl = $(`<nav class="menu hidden" aria-label="Menu">
        ${MENU.map((m) => `<button class="menu-item" data-m="${m.id}">
          <span class="menu-ico">${ICON[m.icon]}</span>
          <span class="menu-txt"><b>${esc(m.label)}</b><small>${esc(m.sub)}</small></span>
          <i class="menu-badge" hidden></i>
        </button>`).join('')}
        <div class="menu-foot">
          <div class="menu-modes" data-k="modes"></div>
          <div class="menu-keys"><kbd>M</kbd> menu <kbd>L</kbd> log size <kbd>Space</kbd> pause <kbd>Esc</kbd> close</div>
        </div>
      </nav>`)),
    );
    this.modals = {};
    for (const [id, m] of Object.entries(MODALS)) {
      const back = $(`<div class="mdl-back hidden" data-modal="${id}">
        <div class="mdl mdl-${id}" role="dialog" aria-modal="true" aria-label="${esc(m.title)}">
          <header class="mdl-head"><div><h2>${esc(m.title)}</h2><p>${esc(m.sub)}</p></div><button class="pop-x" data-a="close" aria-label="Close" title="Close (Esc)">✕</button></header>
          <div class="mdl-body"></div>
        </div>
      </div>`);
      back.addEventListener('click', (e) => {
        if (e.target === back || e.target.closest('.mdl-head [data-a=close]')) this.closePopup();
      });
      this.modals[id] = { back, body: back.querySelector('.mdl-body') };
      root.append(back);
    }
    root.append(
      (this.toasts = $('<div class="toasts" aria-live="polite"></div>')),
      (this.modalRoot = $('<div></div>')),
      (this.overlay = $('<div class="slot-overlay"></div>')),
      (this.conn = $('<div class="conn hidden">Connection lost · reconnecting…</div>')),
    );

    // Hint chips: one per machine, shown only while it is degraded or down.
    this.hints = new Map();
    for (const m of machines) {
      const b = $(`<button class="hint hidden" data-m="${esc(m.id)}"><span class="hint-ico"></span><span class="hint-t"></span></button>`);
      b.addEventListener('click', () => this.inspect(m.id));
      this.hintLayer.append(b);
      this.hints.set(m.id, { el: b, kind: null, text: '', visible: false });
    }

    const toast = (text, kind, label) => this.toast(text, kind, label);

    // ─── Panels ───
    this.hud = safe('hud', () => new Hud(this.slotHud, {
      api,
      onScenarios: () => this.showScenarios({ closable: true }),
      onMenu: () => this.togglePopup('menu'),
    }));
    this.log = safe('plantlog', () => new PlantLog(this.slotLog, { onSelect: (id) => this.inspect(id) }));
    this.inspector = safe('inspector', () => new Inspector(this.machinePop, { machines, onClose: () => this.closePopup() }));
    this.picker = safe('scenarios', () => new ScenarioPicker(this.overlay, { presets: this.presets, onPick: (id) => this.#pick(id) }));
    this.agent = new AgentPanel(this.agentPop, {
      api,
      machines,
      toast,
      onInspect: (id) => this.inspect(id),
      onOpenDesk: () => {
        this.openPopup('desk');
        this.desk.highlightStores();
      },
      onApproval: (checkoutId) => this.modal.show(checkoutId),
      onClose: () => this.closePopup(),
      onChange: () => this.#renderChips(),
    });
    this.modal = new ApprovalModal(this.modalRoot, { api, toast, machines });
    this.desk = new Desk(this.modals.desk.body, { api, toast });
    this.chaos = new Chaos(this.modals.chaos.body, { api, machines, toast });
    this.catalog = new CatalogPanel(this.modals.parts.body, { api, toast });

    // ─── Input ───
    this.menuEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-m]');
      if (b) this.#menuPick(b.dataset.m);
    });
    this.chipsEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-id]');
      if (b) this.openAgent(b.dataset.id);
    });
    window.addEventListener('keydown', (e) => this.#onKey(e));
    // Click outside: the menu closes on any press elsewhere; popovers close on a
    // click on empty floor (a machine click switches the popover instead).
    document.addEventListener('pointerdown', (e) => {
      if (this.open !== 'menu') return;
      if (this.menuEl.contains(e.target) || this.hud?.menuButton?.contains(e.target)) return;
      this.closePopup();
    }, true);
    const worldEl = document.getElementById('world');
    if (worldEl) {
      let down = null;
      worldEl.addEventListener('pointerdown', (e) => {
        down = { x: e.clientX, y: e.clientY };
      });
      worldEl.addEventListener('click', (e) => {
        const moved = down ? Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 : false;
        if (moved || performance.now() - this.pickedAt < 120) return;
        if (this.open === 'machine' || this.open === 'agent') this.closePopup();
      });
    }

    this.#loop();
  }

  // ─── State from the server ───────────────────────────────────────────
  /** Full STATE payload (GET /api/state or the SSE STATE event). */
  setState(state) {
    if (!state || typeof state !== 'object') return;
    this.state = state;
    if (Array.isArray(state.presets) && state.presets.length) {
      this.presets = state.presets;
      safe('picker.setPresets', () => this.picker?.setPresets?.(state.presets));
    }
    if (state.mode) this.setMode(state.mode);
    if (state.policy) this.setPolicy(state.policy);
    if ('treasury' in state) this.setTreasury(state.treasury);
    if (state.catalog) this.setCatalog(state.catalog);
    safe('desk.addMerchants', () => this.desk.addMerchants(state.merchants || []));
    if (Array.isArray(state.logs)) this.loadLogs(state.logs);
    safe('agent.loadIncidents', () => this.agent.loadIncidents(state.incidents || [], state.sim));
    for (const m of this.agent.blockedMerchants()) this.flagMerchant(m);
    // Approvals still waiting after a reload: put the modal back.
    for (const { incidentId, data } of this.agent.pendingApprovals()) {
      if (!this.modal.has(data.checkoutId)) this.modal.open(incidentId, data, this.agent.get(incidentId));
    }
    const pid = state.sim?.preset?.id;
    if (pid) this.setPreset(this.presets.find((p) => p.id === pid) || state.sim.preset);
    if (state.sim) this.updateSim(state.sim);
    this.#ready();
  }

  setMode(mode) {
    this.mode = mode;
    safe('hud.setMode', () => this.hud?.setMode(mode));
    safe('picker.setMode', () => this.picker?.setMode(mode));
    const modes = this.menuEl.querySelector('[data-k=modes]');
    if (modes) modes.innerHTML = modeBadges(mode);
    this.agent.setMode(mode);
    this.modal.setMode(mode);
  }

  setPolicy(policy) {
    if (!policy) return;
    this.policy = policy;
    safe('hud.update', () => this.hud?.update(this.sim || null, policy));
    safe('desk', () => this.desk.setPolicy(policy));
    safe('agent', () => this.agent.setPolicy(policy));
    safe('catalog', () => this.catalog.setTrusted(policy.allowedMerchants));
  }

  /** Onchain balances (STATE.treasury, TREASURY_UPDATED). Null-safe. */
  setTreasury(treasury) {
    safe('hud.setTreasury', () => this.hud?.setTreasury(treasury || null));
  }

  setCatalog(catalog) {
    safe('catalog', () => this.catalog.setCatalog(catalog));
    safe('desk.addMerchants', () => this.desk.addMerchants(this.catalog.merchants()));
  }

  /** Every tick. */
  updateSim(sim) {
    if (!sim) return;
    this.sim = sim;
    safe('hud.update', () => this.hud?.update(sim, this.policy || undefined));
    safe('log.setClock', () => this.log?.setClock(sim.clock));
    safe('inspector.update', () => this.inspector?.update(sim));
    safe('agent.updateSim', () => this.agent.updateSim(sim));
    safe('modal.updateSim', () => this.modal.updateSim(sim));
    safe('chaos.updateSim', () => this.chaos.updateSim(sim));
    safe('hints', () => this.#updateHints(sim));
    this.firstHint.classList.toggle('hidden', this.explored || Boolean(sim.paused && !sim.t) || this.scenariosVisible);
    this.#ready();
  }

  // ─── Plant log ───────────────────────────────────────────────────────
  loadLogs(entries) {
    safe('log.load', () => this.log?.load(entries || []));
  }

  addLog(entry) {
    if (!entry) return;
    safe('log.add', () => this.log?.add(entry));
  }

  /** A client-side line in the terminal log. opts = { level, machineId, componentId, code, href, linkText } */
  note(text, opts = {}) {
    if (!text) return;
    safe('log.note', () => this.log?.note({ level: 'AGENT', ...opts, message: text }));
  }

  /** CHECKOUT_COMPLETED: "Paid from Kwal vault (USDC): $93.15, order …" in the log. */
  paid(incidentId, data = {}, card = null) {
    const amount = data.finalAmount?.amount ?? card?.order?.amount;
    const how = railText(data.rail) || 'Paid';
    this.note(`${how}: ${money(amount)}${data.orderId ? `, order ${data.orderId}` : ''}`, {
      code: data.rail === 'kwal' ? 'KWAL' : data.rail === 'reap' ? 'REAP' : 'ORDER',
      machineId: card?.machineId,
    });
  }

  /** ESCROW_RELEASED: "Paid Ana 1.20 USDC onchain ↗" (explorer link) or "(simulated: …)". */
  escrowReleased(incidentId, escrow = {}, card = null) {
    const p = escrowPaid(escrow || {}, card?.tech?.technician?.name);
    this.note(`${p.text}${p.href ? '' : p.note ? ` (${p.note})` : ''}`, {
      code: 'ESCROW',
      machineId: card?.machineId,
      href: p.href,
      linkText: 'onchain ↗',
    });
  }

  // ─── Scenarios ───────────────────────────────────────────────────────
  showScenarios(opts) {
    this.closePopup();
    safe('picker.show', () => this.picker?.show(opts));
  }

  hideScenarios() {
    safe('picker.hide', () => this.picker?.hide());
  }

  get scenariosVisible() {
    return Boolean(this.picker?.visible);
  }

  setPreset(preset) {
    if (!preset) return;
    const full = this.presets.find((p) => p.id === preset.id) || {};
    this.agent.setPreset({ ...full, ...preset });
  }

  /** A preset was loaded: wipe every incident-related panel. */
  resetForPreset(preset) {
    safe('agent.reset', () => this.agent.reset());
    this.modal.clear();
    safe('desk.reset', () => this.desk.reset());
    this.clearFloats();
    this.hideBubble();
    safe('inspector.reset', () => this.inspector?.reset());
    this.setPreset(preset);
    this.#flag('desk', false);
  }

  // ─── Incidents ───────────────────────────────────────────────────────
  /** Route one incident-scoped event to the agent panel. Returns the card model. */
  incident(type, incidentId, data) {
    return safe(`agent ${type}`, () => this.agent.apply(type, incidentId, data || {})) || null;
  }

  needsHuman() {
    return this.agent.needsHuman();
  }

  openApproval(incidentId, data) {
    this.modal.open(incidentId, data, this.agent.get(incidentId));
  }

  closeApproval(checkoutId) {
    this.modal.resolve(checkoutId);
  }

  dropApprovals(incidentId) {
    this.modal.dropIncident(incidentId);
  }

  flagMerchant(name) {
    safe('desk.flagMerchant', () => this.desk.flagMerchant(name));
    this.#flag('desk', true);
  }

  addMerchants(names) {
    safe('desk.addMerchants', () => this.desk.addMerchants(names));
  }

  // ─── Popups (one at a time) ──────────────────────────────────────────
  /** Show a machine's popover from a UI element (hint chip, log line, agent popup). */
  inspect(machineId) {
    if (!machineId || !this.machines.some((m) => m.id === machineId)) return;
    this.openMachine(machineId);
    this.onSelectMachine?.(machineId, { from: 'ui' });
  }

  /** Open the machine popover (the director calls this for 3D clicks). */
  openMachine(machineId) {
    if (!this.inspector || !machineId) return;
    this.pickedAt = performance.now();
    this.machineId = machineId;
    safe('inspector.select', () => this.inspector.select(machineId));
    if (this.open !== 'machine') this.openPopup('machine');
    if (!this.explored) {
      this.explored = true;
      this.firstHint.classList.add('hidden');
      try {
        localStorage.setItem(EXPLORED_KEY, '1');
      } catch {}
    }
  }

  /** Open the agent popup, on one incident if given. */
  openAgent(incidentId) {
    if (incidentId) safe('agent.focus', () => this.agent.focus(incidentId));
    this.openPopup('agent');
  }

  openPopup(name) {
    if (this.open === name) return;
    this.closePopup();
    this.open = name;
    this.root.dataset.open = name; // CSS: the terminal log slides left of the machine popover
    if (name === 'machine') {
      this.machinePop.classList.remove('hidden');
      safe('inspector.setVisible', () => this.inspector?.setVisible(true));
    } else if (name === 'agent') {
      this.agentPop.classList.remove('hidden');
    } else if (name === 'menu') {
      const btn = this.hud?.menuButton;
      const r = btn?.getBoundingClientRect();
      if (r) {
        this.menuEl.style.top = `${Math.round(r.bottom + 8)}px`;
        this.menuEl.style.left = `${Math.round(clamp(r.right - 300, 12, innerWidth - 312))}px`;
      }
      this.menuEl.classList.remove('hidden');
      safe('hud.setMenuOpen', () => this.hud?.setMenuOpen(true));
      requestAnimationFrame(() => this.menuEl.querySelector('.menu-item')?.focus({ preventScroll: true }));
    } else if (this.modals[name]) {
      this.modals[name].back.classList.remove('hidden');
      if (name === 'desk') this.#flag('desk', false);
      requestAnimationFrame(() => this.modals[name].back.querySelector('.pop-x')?.focus({ preventScroll: true }));
    }
  }

  closePopup() {
    const name = this.open;
    if (!name) return;
    this.open = null;
    delete this.root.dataset.open;
    if (name === 'machine') {
      this.machinePop.classList.add('hidden');
      safe('inspector.setVisible', () => this.inspector?.setVisible(false));
      this.machineId = null;
      this.onSelectMachine?.(null, { from: 'ui' });
    } else if (name === 'agent') {
      this.agentPop.classList.add('hidden');
    } else if (name === 'menu') {
      this.menuEl.classList.add('hidden');
      safe('hud.setMenuOpen', () => this.hud?.setMenuOpen(false));
    } else if (this.modals[name]) {
      this.modals[name].back.classList.add('hidden');
    }
  }

  togglePopup(name) {
    if (this.open === name) this.closePopup();
    else this.openPopup(name);
  }

  // ─── Feedback: bubble, floating texts, toasts ────────────────────────
  /** Speech bubble over the robot, typed out. */
  say(text, { ms } = {}) {
    const s = String(text ?? '').trim();
    if (!s) return;
    const life = ms ?? Math.min(9000, Math.max(3500, s.length * 55));
    this.bubbleState = { text: s, shown: 0, born: performance.now(), until: performance.now() + life };
    this.bubble.querySelector('.txt').textContent = '';
    this.bubble.classList.remove('hidden', 'fade');
  }

  hideBubble() {
    this.bubbleState = null;
    this.bubble.classList.add('hidden');
  }

  /** Text that rises over a machine: kind = bad | good | warn | info | maint. */
  floatText(machineId, text, kind = 'info') {
    if (!machineId || !text) return;
    const el = $(`<div class="float ${esc(kind)}"></div>`);
    el.textContent = text;
    el.style.opacity = '0';
    this.floatLayer.append(el);
    const stack = this.floats.filter((f) => f.machineId === machineId).length;
    this.floats.push({ el, machineId, born: performance.now(), stack });
  }

  clearFloats() {
    for (const f of this.floats) f.el.remove();
    this.floats = [];
  }

  /**
   * Toast (bottom-left) for things the manager should notice now: errors, the
   * result of their own actions. Also mirrored into the terminal log.
   * kind = info | good | warn | bad | agent; label = short chip text.
   */
  toast(text, kind = 'info', label) {
    if (!text) return;
    this.note(text, { level: TOAST_LEVEL[kind] || 'INFO', code: label || '' });
    const chipCls = { good: 'good', warn: 'warn', bad: 'bad', agent: 'agent', info: 'info' }[kind] || '';
    const el = $(`<div class="toast ${esc(kind)}">${label ? `<span class="chip ${chipCls}">${esc(label)}</span>` : ''}<span></span></div>`);
    el.lastElementChild.textContent = text;
    this.toasts.append(el);
    while (this.toasts.children.length > 3) this.toasts.firstElementChild.remove();
    const life = kind === 'bad' ? 7000 : 4500;
    setTimeout(() => el.classList.add('out'), life);
    setTimeout(() => el.remove(), life + 350);
    el.addEventListener('click', () => el.remove());
  }

  setConnected(ok) {
    this.conn.classList.toggle('hidden', Boolean(ok));
  }

  /** Boot screen error (server unreachable before the first state). */
  bootError(message) {
    const boot = document.getElementById('boot');
    if (!boot || this.ready) return;
    boot.classList.add('err');
    boot.innerHTML = `<div>Can't reach the plant<small>${esc(message)}<br>Retrying…</small></div>`;
  }

  loadHistory(machineId, history) {
    safe('inspector.loadHistory', () => this.inspector?.loadHistory(machineId, history));
  }

  // ─── Internals ───────────────────────────────────────────────────────
  async #pick(id) {
    // ScenarioPicker shows its own loading/error state and hides on success.
    // A request that never answers must not leave the picker stuck on "Loading…".
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('the server did not answer within 12 s')), 12000);
    });
    try {
      await Promise.race([this.api('POST', '/sim/preset', { id }), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  #menuPick(id) {
    if (id === 'scenarios') return this.showScenarios({ closable: true });
    if (id === 'agent') return this.openAgent();
    this.openPopup(id);
  }

  /** Red dot on a menu item (and the ☰ button) that wants attention. */
  #flag(id, on) {
    if (on && this.open === id) on = false;
    if (on) this.flags.add(id);
    else this.flags.delete(id);
    const badge = this.menuEl.querySelector(`[data-m=${id}] .menu-badge`);
    if (badge) badge.hidden = !this.flags.has(id);
    safe('hud.setMenuBadge', () => this.hud?.setMenuBadge(this.flags.size > 0));
  }

  #onKey(e) {
    if (e.key === 'Escape') {
      if (this.modal.visible) {
        e.preventDefault();
        this.modal.hide();
        return;
      }
      if (this.scenariosVisible) return; // the picker handles its own Esc
      if (this.open) {
        e.preventDefault();
        const was = this.open;
        this.closePopup();
        if (was === 'menu') this.hud?.menuButton?.focus({ preventScroll: true });
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.defaultPrevented) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (this.scenariosVisible || this.modal.visible) return;
    const k = e.key.toLowerCase();
    if (k === 'm') {
      e.preventDefault();
      this.togglePopup('menu');
    } else if (k === 'l') {
      e.preventDefault();
      safe('log.toggleSize', () => this.log?.toggleSize());
    }
  }

  #renderChips() {
    const chips = safe('agent.chips', () => this.agent?.chips()) || [];
    const sig = JSON.stringify(chips.map((c) => [c.id, c.label, c.tone, c.step, c.machineName, c.kind]));
    if (sig === this.chipsSig) return;
    this.chipsSig = sig;
    this.chipsEl.innerHTML = chips
      .map((c) => {
        const dots = Array.from({ length: c.total }, (_, i) => {
          const cls = c.done || i < c.step ? 'done' : i === c.step ? (c.failed ? 'fail' : 'on') : '';
          return `<i class="${cls}"></i>`;
        }).join('');
        return `<button class="ac-chip t-${c.tone} k-${esc(c.kind)}" data-id="${esc(c.id)}" title="${esc(c.title)}. Click for details.">
          <span class="ac-ico">${ICON.wrench}</span>
          <span class="ac-main"><span class="ac-line"><b>${esc(c.machineName)}</b><span class="ac-sep">·</span><span class="ac-label">${esc(c.label)}</span></span>
          <span class="ac-dots" aria-hidden="true">${dots}</span></span>
        </button>`;
      })
      .join('');
  }

  #updateHints(sim) {
    for (const def of this.machines) {
      const h = this.hints.get(def.id);
      if (!h) continue;
      const m = sim.machines?.[def.id];
      let kind = null;
      let text = '';
      let tip = '';
      if (m?.status === 'down') {
        const codes = m.activeCodes || [];
        kind = 'bad';
        text = codes.length ? `${codes[0]}${codes.length > 1 ? ` +${codes.length - 1}` : ''}` : 'DOWN';
        tip = `${def.name} is down${codes.length ? ` (${codes.join(', ')})` : ''}. Click for its sensors.`;
      } else if (m?.degraded && m.status === 'running') {
        const warns = def.components.filter((c) => m.components?.[c.id]?.status === 'warn');
        kind = 'warn';
        text = warns.length ? `${warnCode(warns[0].code)}${warns.length > 1 ? ` +${warns.length - 1}` : ''}` : 'WARN';
        tip = `${def.name}: ${warns.map((c) => c.name).join(', ') || 'a part'} drifting toward failure. Click for its sensors.`;
      }
      const visible = Boolean(kind);
      if (h.kind !== kind || h.text !== text || h.visible !== visible) {
        h.kind = kind;
        h.text = text;
        h.visible = visible;
        h.el.className = `hint${kind ? ` is-${kind}` : ''}${visible ? '' : ' hidden'}`;
        h.el.querySelector('.hint-ico').innerHTML = kind === 'bad' ? ICON.x : kind === 'warn' ? ICON.warn : '';
        h.el.querySelector('.hint-t').textContent = text;
        h.el.title = tip;
        h.el.setAttribute('aria-label', tip);
      }
    }
  }

  #ready() {
    if (this.ready) return;
    this.ready = true;
    const boot = document.getElementById('boot');
    if (boot) {
      boot.classList.add('out');
      setTimeout(() => boot.remove(), 400);
    }
  }

  // Per frame: bubble follows the robot, floating texts rise, hint chips track machines.
  #loop() {
    const frame = (now) => {
      requestAnimationFrame(frame);
      const rect = this.#stageRect();
      safe('bubble', () => this.#bubbleFrame(now, rect));
      safe('floats', () => this.#floatFrame(now, rect));
      safe('hintsFrame', () => this.#hintFrame(rect));
    };
    requestAnimationFrame(frame);
  }

  #stageRect() {
    const w = document.getElementById('world');
    const r = w?.getBoundingClientRect();
    return r && r.width > 0 ? r : { left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight };
  }

  #bubbleFrame(now, rect) {
    const b = this.bubbleState;
    if (!b) return;
    if (now > b.until) {
      this.bubble.classList.add('fade');
      if (now > b.until + 250) this.hideBubble();
      return;
    }
    // Typewriter: ~70 characters per second.
    const n = Math.min(b.text.length, Math.ceil((now - b.born) / 14));
    if (n !== b.shown) {
      b.shown = n;
      this.bubble.querySelector('.txt').textContent = b.text.slice(0, n);
    }
    const p = this.world?.screenPos?.('robot');
    if (!p) {
      this.bubble.style.visibility = 'hidden';
      return;
    }
    this.bubble.style.visibility = '';
    const w = this.bubble.offsetWidth;
    const h = this.bubble.offsetHeight;
    const x = Math.max(rect.left + 8, Math.min(rect.right - w - 8, p.x - w / 2));
    const y = Math.max(rect.top + 64, Math.min(rect.bottom - h - 8, p.y - h - 18));
    this.bubble.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    const tail = Math.max(16, Math.min(w - 16, p.x - x));
    this.bubble.style.setProperty('--tail', `${Math.round(tail)}px`);
  }

  #floatFrame(now, rect) {
    if (!this.floats.length) return;
    // Floats rise toward the top bar; keep them out from under the agent chips (top-centre).
    const chips = this.chipsEl.childElementCount ? this.chipsEl.getBoundingClientRect() : null;
    this.floats = this.floats.filter((f) => {
      const k = (now - f.born) / FLOAT_MS;
      if (k >= 1) {
        f.el.remove();
        return false;
      }
      const p = this.world?.screenPos?.(f.machineId);
      if (!p) {
        f.el.style.opacity = '0';
        return true;
      }
      const w = f.el.offsetWidth;
      const rise = 46 * Math.min(1, k * 1.6);
      const lift = this.hints.get(f.machineId)?.visible ? 36 : 0;
      const x = Math.max(rect.left + 4, Math.min(rect.right - w - 4, p.x - w / 2));
      const underChips = chips && chips.height > 0 && x < chips.right && x + w > chips.left;
      const y = Math.max(underChips ? chips.bottom + 6 : rect.top + 60, p.y - 34 - lift - rise - f.stack * 30);
      f.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      f.el.style.opacity = String(k < 0.08 ? k / 0.08 : k > 0.75 ? (1 - k) / 0.25 : 1);
      return true;
    });
  }

  #hintFrame(rect) {
    for (const [id, h] of this.hints) {
      if (!h.visible) continue;
      const p = this.world?.screenPos?.(id);
      if (!p) {
        h.el.style.visibility = 'hidden';
        continue;
      }
      h.el.style.visibility = '';
      const w = h.el.offsetWidth;
      const hh = h.el.offsetHeight;
      const x = clamp(p.x - w / 2, rect.left + 6, rect.right - w - 6);
      const y = clamp(p.y - hh - 12, rect.top + 6, rect.bottom - hh - 6);
      h.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    }
  }
}
