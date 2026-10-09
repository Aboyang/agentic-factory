// Top bar: one slim line in the top-left corner.
//   shift clock + line lamp · scenario · money · budget · sim speed · onchain treasury · menu
// Numbers roll smoothly between 1 s ticks; everything else is plain text updates.

import './ui-shell.css';
import { MACHINES } from '../../../shared/contract.js';
import { api as netApi } from '../net.js';

const SPEEDS = [1, 2, 4, 8];
const MACHINE_NAMES = Object.fromEntries(MACHINES.map((m) => [m.id, m.name]));

const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const esc = (s = '') => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');

/** $1,234 / $12.3k / $93.15 (cents only when asked and small). */
export function usd(v, cents = false) {
  const n = num(v);
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a >= 100000) return `${sign}$${Math.round(a / 1000)}k`;
  if (a >= 10000) return `${sign}$${(a / 1000).toFixed(1)}k`;
  if (cents && a < 1000) return `${sign}$${a.toFixed(2)}`;
  return `${sign}$${Math.round(a).toLocaleString('en-US')}`;
}

/** 8.00 (USDC amounts), or a dash when unknown. */
export function usdc(v) {
  return v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(2);
}

/** Mode badges, shared with the scenario picker and the menu. mode = { mockReap, mockAi, enrolled }. */
export function modeBadges(mode) {
  if (!mode) return '';
  const b = (cls, text, tip) => `<span class="mode-badge ${cls}" title="${esc(tip)}">${text}</span>`;
  return [
    mode.mockReap
      ? b('is-muted', 'Reap offline', 'No Reap API key: checkouts are simulated locally.')
      : b('is-good', 'Reap sandbox', 'Real checkouts in the Reap Agentic Payments sandbox.'),
    mode.mockAi
      ? b('is-muted', 'AI mock', 'Decisions come from the built-in heuristic (no model key).')
      : b('is-accent', 'AI live', 'A live decision model reads the sensors and the plant log.'),
    mode.enrolled
      ? b('is-good', 'Card enrolled', 'A payment card is stored with Reap for the agent.')
      : b(mode.mockReap ? 'is-muted' : 'is-warn', 'No card', 'No payment card stored with Reap yet.'),
  ].join('');
}

const KPIS = [
  { key: 'revenue', label: 'Revenue', cls: 'is-rev', fmt: (n) => usd(n), tip: 'Revenue this shift: $5 per unit. The line makes 12 units a minute, only while every machine runs.' },
  { key: 'downtimeCost', label: 'Downtime', cls: 'is-bad', fmt: (n) => (n >= 0.5 ? `−${usd(n)}` : '$0'), tip: 'Cost of stopped machines: each one bills its downtime cost per minute until it runs again.' },
  { key: 'partsSpend', label: 'Parts', cls: 'is-parts', fmt: (n) => usd(n, true), tip: 'Spent on replacement parts this shift.' },
];

// A number that eases toward its target between ticks.
class Roll {
  constructor(node, fmt) {
    this.node = node;
    this.fmt = fmt;
    this.shown = 0;
    this.from = 0;
    this.to = 0;
    this.t0 = 0;
    this.dur = 0;
    this.text = null;
    this.render();
  }
  set(v, animate) {
    v = num(v);
    if (v === this.to && !this.dur) return this.render();
    if (!animate || v < this.shown) {
      this.shown = this.to = v;
      this.dur = 0;
      return this.render();
    }
    this.from = this.shown;
    this.to = v;
    this.t0 = performance.now();
    this.dur = 850;
  }
  step(now) {
    if (!this.dur) return false;
    const k = Math.min(1, (now - this.t0) / this.dur);
    this.shown = this.from + (this.to - this.from) * k;
    this.render();
    if (k >= 1) this.dur = 0;
    return k < 1;
  }
  render() {
    const s = this.fmt(this.shown);
    if (s !== this.text) {
      this.text = s;
      this.node.textContent = s;
    }
  }
}

export class Hud {
  /**
   * @param root              container
   * @param opts.api          (method, path, body) => Promise
   * @param opts.onScenarios  open the scenario picker
   * @param opts.onMenu       toggle the ☰ menu (gets the button element)
   */
  constructor(root, { api, onScenarios, onMenu } = {}) {
    this.api = api || netApi;
    this.onScenarios = onScenarios;
    this.onMenu = onMenu;
    this.sim = null;
    this.policy = null;
    this.treasury = null;
    this.want = null; // optimistic { speed, paused, until } until the server confirms
    this.raf = 0;

    this.el = el(`<header class="tb" aria-label="Plant status">
      <div class="tb-seg tb-time" data-k="line">
        <i class="tb-lamp" aria-hidden="true"></i>
        <span class="tb-clock" data-k="clock">08:00</span>
        <span class="tb-state" data-k="state"></span>
      </div>
      <button class="tb-seg tb-scn" data-a="scenarios" title="Pick another scenario (restarts the shift)">
        <span class="tb-scn-name" data-k="preset">Pick a scenario</span><i class="tb-chev" aria-hidden="true"></i>
      </button>
      <div class="tb-seg tb-money">
        ${KPIS.map((k) => `<span class="tb-kpi ${k.cls}" data-kpi="${k.key}" title="${esc(k.tip)}"><span class="tb-k">${k.label}</span><b class="tb-v" data-v></b></span>`).join('')}
      </div>
      <div class="tb-seg tb-budget" data-k="budget">
        <span class="tb-k">Budget</span>
        <span class="tb-meter" data-k="meter"><i data-k="budgetBar"></i></span>
        <b class="tb-v" data-k="budgetLeft">—</b><span class="tb-k tb-left">left</span>
      </div>
      <div class="tb-seg tb-speed" data-k="speedRow" role="group" aria-label="Simulation speed">
        <button class="tb-sp tb-sp-pause" data-a="pause" title="Pause / resume (Space)" aria-label="Pause"><i class="tb-ico is-pause"></i></button>
        ${SPEEDS.map((s, i) => `<button class="tb-sp" data-speed="${s}" title="${s} game-minute${s > 1 ? 's' : ''} per second (key ${i + 1})" aria-pressed="false">${s}×</button>`).join('')}
      </div>
      <div class="tb-seg tb-treasury" data-k="treasury" hidden>
        <a class="tb-tr" data-k="vault" target="_blank" rel="noopener noreferrer"><span class="tb-k">Vault</span> <b class="tb-v" data-k="vaultV">—</b><span class="tb-unit"> USDC</span></a>
        <span class="tb-dot" aria-hidden="true">·</span>
        <a class="tb-tr" data-k="wallet" target="_blank" rel="noopener noreferrer"><span class="tb-k">Treasury</span> <b class="tb-v" data-k="walletV">—</b><span class="tb-unit"> USDC</span></a>
        <a class="tb-chain" data-k="chain" target="_blank" rel="noopener noreferrer" title="Ink Sepolia testnet (chain 763373): open the block explorer"><i></i><span>Ink Sepolia</span> <span aria-hidden="true">↗</span></a>
      </div>
      <button class="tb-seg tb-menu" data-a="menu" aria-haspopup="menu" aria-expanded="false" title="Menu (M)">
        <i class="tb-burger" aria-hidden="true"><b></b><b></b><b></b></i><span class="tb-menu-t">Menu</span><i class="tb-badge" data-k="menuBadge" hidden></i>
      </button>
    </header>`);

    this.k = {};
    for (const n of this.el.querySelectorAll('[data-k]')) this.k[n.dataset.k] = n;
    this.kpi = {};
    this.rolls = {};
    for (const def of KPIS) {
      const box = this.el.querySelector(`[data-kpi="${def.key}"]`);
      this.kpi[def.key] = box;
      this.rolls[def.key] = new Roll(box.querySelector('[data-v]'), def.fmt);
    }
    this.pauseBtn = this.el.querySelector('[data-a=pause]');
    this.speedBtns = [...this.el.querySelectorAll('[data-speed]')];
    this.menuBtn = this.el.querySelector('[data-a=menu]');

    this.el.addEventListener('click', (e) => this.#onClick(e));
    this.onKey = (e) => this.#onKey(e);
    window.addEventListener('keydown', this.onKey);

    root.append(this.el);
    this.#renderSpeed();
    this.#renderBudget();
  }

  /** Called every tick. Either argument may be omitted to keep the last one. */
  update(sim, policy) {
    if (policy) this.policy = policy;
    if (sim) {
      const prev = this.sim;
      const reset = !prev || num(sim.t) < num(prev.t) || sim.preset?.id !== prev.preset?.id;
      this.sim = sim;
      this.#renderSim(prev, reset);
    }
    this.#renderBudget();
  }

  setMode(mode) {
    this.mode = mode;
  }

  /**
   * Onchain balances (STATE.treasury / TREASURY_UPDATED). Hidden when absent or not configured.
   * t = { onchain, usdc, vaultUsdc, eth, explorer: { treasury, vault }, kwal: { enabled, step, state } }
   */
  setTreasury(t) {
    const box = this.k.treasury;
    if (!t || typeof t !== 'object' || t.onchain === false) {
      this.treasury = null;
      box.hidden = true;
      return;
    }
    const prev = this.treasury;
    this.treasury = t;
    box.hidden = false;
    this.#flash(this.k.vaultV, usdc(t.vaultUsdc), prev?.vaultUsdc, t.vaultUsdc);
    this.#flash(this.k.walletV, usdc(t.usdc), prev?.usdc, t.usdc);
    const ex = t.explorer || {};
    this.#link(this.k.vault, ex.vault || ex.treasury);
    this.#link(this.k.wallet, ex.treasury || ex.vault);
    this.#link(this.k.chain, ex.treasury || ex.vault);
    const kwal = t.kwal?.state || t.kwal?.step;
    this.k.vault.title = `Kwal vault${t.vaultAddress ? ` ${t.vaultAddress}` : ''}: Wrench-bot pays within-limit orders from here.${kwal ? ` Kwal: ${kwal}.` : ''}`;
    this.k.wallet.title = `Factory treasury wallet${t.address ? ` ${t.address}` : ''}: pays technicians in USDC.${t.eth != null ? ` Gas: ${Number(t.eth).toFixed(4)} ETH.` : ''}`;
    box.classList.toggle('is-pending', Boolean(t.kwal?.enabled) && kwal && kwal !== 'ready');
  }

  /** The ☰ button (the UI anchors the dropdown under it). */
  get menuButton() {
    return this.menuBtn;
  }

  setMenuOpen(on) {
    this.menuBtn.classList.toggle('is-on', Boolean(on));
    this.menuBtn.setAttribute('aria-expanded', String(Boolean(on)));
  }

  /** Red dot on the menu button (e.g. the Manager's Desk wants attention). */
  setMenuBadge(on) {
    this.k.menuBadge.hidden = !on;
  }

  destroy() {
    window.removeEventListener('keydown', this.onKey);
    cancelAnimationFrame(this.raf);
    this.el.remove();
  }

  // ─── Rendering ─────────────────────────────────────────────────────────
  #renderSim(prev, reset) {
    const s = this.sim;
    const clock = String(s.clock || '08:00');
    if (this.k.clock.textContent !== clock) this.k.clock.textContent = clock;
    this.el.classList.toggle('is-paused', !!s.paused);

    const name = s.preset?.name || 'Pick a scenario';
    if (this.k.preset.textContent !== name) this.k.preset.textContent = name;

    this.#renderLine();
    this.#renderSpeed();

    // Money rolls toward the new values; a preset reset snaps it.
    const kp = s.kpis || {};
    const animate = !reset && !reducedMotion();
    for (const def of KPIS) this.rolls[def.key].set(kp[def.key], animate);
    const before = num(prev?.kpis?.downtimeCost);
    this.kpi.downtimeCost.classList.toggle('is-bleeding', !reset && num(kp.downtimeCost) > before + 1e-6);
    this.kpi.downtimeCost.classList.toggle('is-zero', num(kp.downtimeCost) < 0.5);
    this.kpi.revenue.title = `${KPIS[0].tip} Units: ${Math.round(num(kp.unitsProduced)).toLocaleString('en-US')} · uptime ${num(kp.uptimePct).toFixed(1)}%.`;
    if (animate) this.#animate();
  }

  #renderLine() {
    const s = this.sim;
    const machines = s.machines || {};
    const stopped = Object.entries(machines).filter(([, m]) => m && m.status !== 'running');
    let state = 'is-running';
    let text = '';
    let tip = 'Line running: every machine is up, 12 units a minute.';
    if (stopped.length) {
      const allMaint = stopped.every(([, x]) => x.status === 'maintenance');
      state = allMaint ? 'is-maint' : 'is-down';
      text = allMaint ? 'Repair' : 'Stopped';
      tip = `Line stopped. ${stopped
        .map(([mid, x]) => `${MACHINE_NAMES[mid] || mid}: ${x.status === 'maintenance' ? 'planned repair stop' : `down${x.activeCodes?.length ? ` (${x.activeCodes.join(', ')})` : ''}`}`)
        .join('; ')}. The line only runs when every machine runs.`;
    } else if (s.lineRunning === false) {
      state = 'is-down';
      text = 'Stopped';
      tip = 'The line is stopped.';
    } else if (s.paused) {
      state = 'is-paused';
      text = s.t > 0 ? 'Paused' : 'Ready';
      tip = 'The simulation is paused: nothing moves until you resume (Space) or pick a speed.';
    } else if (Object.values(machines).some((m) => m?.degraded)) {
      state = 'is-degraded';
      tip = 'The line runs, but a part is showing warning signs. Click the machine with the amber tag.';
    }
    const line = this.k.line;
    if (line.dataset.state !== state) {
      line.classList.remove('is-running', 'is-down', 'is-maint', 'is-degraded', 'is-paused');
      line.classList.add(state);
      line.dataset.state = state;
    }
    if (this.k.state.textContent !== text) this.k.state.textContent = text;
    line.title = `Shift clock (game time). ${tip}`;
  }

  #shown() {
    const s = this.sim;
    let speed = num(s?.speed) || 1;
    let paused = !!s?.paused;
    const w = this.want;
    if (w) {
      const confirmed = (w.speed == null || w.speed === speed) && w.paused === paused;
      if (confirmed || performance.now() > w.until) this.want = null;
      else {
        speed = w.speed ?? speed;
        paused = w.paused;
      }
    }
    return { speed, paused };
  }

  #renderSpeed() {
    const { speed, paused } = this.#shown();
    this.pauseBtn.classList.toggle('is-on', paused);
    this.pauseBtn.setAttribute('aria-label', paused ? 'Resume' : 'Pause');
    this.pauseBtn.title = paused ? 'Resume (Space)' : 'Pause (Space)';
    this.pauseBtn.firstElementChild.className = `tb-ico ${paused ? 'is-play' : 'is-pause'}`;
    for (const b of this.speedBtns) {
      const on = !paused && Number(b.dataset.speed) === speed;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }

  #renderBudget() {
    const p = this.policy;
    if (!p) return;
    const budget = num(p.monthlyBudget);
    const spent = num(p.spent);
    const left = p.remaining != null ? num(p.remaining) : Math.max(0, budget - spent);
    const frac = budget > 0 ? clamp(left / budget, 0, 1) : 0;
    const text = usd(left);
    if (this.k.budgetLeft.textContent !== text) this.k.budgetLeft.textContent = text;
    this.k.budgetBar.style.width = `${(frac * 100).toFixed(1)}%`;
    const cls = frac > 0.5 ? 'is-good' : frac > 0.2 ? 'is-warn' : 'is-bad';
    if (this.k.meter.dataset.cls !== cls) {
      this.k.meter.classList.remove('is-good', 'is-warn', 'is-bad');
      this.k.meter.classList.add(cls);
      this.k.meter.dataset.cls = cls;
    }
    const limit = p.autoApproveLimit != null ? ` Wrench-bot may buy alone up to ${usd(p.autoApproveLimit)} per order; above that you approve.` : '';
    this.k.budget.title = `Monthly parts budget: ${usd(left, true)} left (spent ${usd(spent, true)} of ${usd(budget)}).${limit}`;
  }

  #flash(node, text, before, after) {
    if (node.textContent === text) return;
    node.textContent = text;
    if (before == null || after == null || reducedMotion()) return;
    const cls = Number(after) > Number(before) ? 'is-up' : 'is-down';
    node.classList.remove('is-up', 'is-down');
    void node.offsetWidth; // restart the animation
    node.classList.add(cls);
  }

  #link(a, url) {
    const href = safeUrl(url);
    if (href) a.setAttribute('href', href);
    else a.removeAttribute('href');
  }

  #animate() {
    if (this.raf) return;
    const loop = (now) => {
      let busy = false;
      for (const r of Object.values(this.rolls)) busy = r.step(now) || busy;
      this.raf = busy ? requestAnimationFrame(loop) : 0;
    };
    this.raf = requestAnimationFrame(loop);
  }

  // ─── Input ────────────────────────────────────────────────────────────
  #onClick(e) {
    const b = e.target.closest('button');
    if (!b || !this.el.contains(b)) return;
    if (b.dataset.a === 'scenarios') this.onScenarios?.();
    else if (b.dataset.a === 'menu') this.onMenu?.(b);
    else if (b.dataset.a === 'pause') this.#act('pause');
    else if (b.dataset.speed) this.#act('speed', Number(b.dataset.speed));
  }

  #onKey(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(t.tagName))) return;
    if (document.querySelector('.scn-overlay:not(.scn-hidden)')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      this.#act('pause');
      return;
    }
    const i = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(e.code);
    if (i >= 0) this.#act('speed', SPEEDS[i]);
  }

  async #act(kind, speed) {
    if (!this.sim) return; // nothing loaded yet
    const until = performance.now() + 2500;
    let req;
    if (kind === 'pause') {
      const { paused } = this.#shown();
      this.want = { speed: null, paused: !paused, until };
      req = () => this.api('POST', paused ? '/sim/resume' : '/sim/pause');
    } else {
      this.want = { speed, paused: false, until };
      req = () => this.api('POST', '/sim/speed', { speed });
    }
    this.#renderSpeed();
    try {
      await req();
    } catch (err) {
      this.want = null;
      this.#renderSpeed();
      const row = this.k.speedRow;
      row.classList.remove('is-error');
      void row.offsetWidth; // restart the shake animation
      row.classList.add('is-error');
      row.title = `Speed change failed: ${err?.message || err}`;
      console.warn('[hud] speed change failed', err);
    }
  }
}
