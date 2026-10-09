// Title screen: "WRENCH-BOT FACTORY" and one card per scenario preset.
// Cards are buttons (keyboard: arrows move, Enter starts, Esc closes when allowed).

import './ui-shell.css';
import { MACHINES, PRESETS } from '../../../shared/contract.js';
import { modeBadges, usd } from './hud.js';

const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};
const esc = (s = '') => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const MACHINE_NAMES = Object.fromEntries(MACHINES.map((m) => [m.id, m.name]));

const PAL = {
  k: '#11141a', h: '#d8dee9', e: '#88c0d0', b: '#ebcb8b', a: '#4c566a', r: '#bf616a', g: '#a3be8c', w: '#c8d0dc',
};

// Wrench-bot, 23×18. Same colors as the 3D robot: yellow body, grey head, cyan visor.
const BOT = [
  '........rr.............',
  '........aa.............',
  '...kkkkkkkkkkkk........',
  '...khhhhhhhhhhk........',
  '...khkkkkkkkkhk..w.w...',
  '...khkeekkeekhk..www...',
  '...khkkkkkkkkhk...w....',
  '...khhhhhhhhhhk...w....',
  '....kkkkkkkkkk....w....',
  '..kkkbbbbbbbbkkk..w....',
  '.kbbkbbbbbbbbkbbk.w....',
  '.kbbkbkkkkkkbkbbkkwk...',
  '.kbbkbkgkrkkbkbbkkwk...',
  '.kkkkbkkkkkkbkkkk.w....',
  '....kbbbbbbbbk...www...',
  '....kkkkkkkkkk...w.w...',
  '.....kak..kak..........',
  '....kkkk..kkkk.........',
];

// 10×10 card icons: a = main color, b = second color.
const ICONS = {
  bolt: ['.....aaa..', '....aaa...', '...aaa....', '..aaa.....', '.aaaaaaa..', '....aaa...', '...aaa....', '..aaa.....', '.aa.......', 'a.........'],
  battery: ['..........', '..........', 'aaaaaaaa..', 'a......a..', 'a.bb...aaa', 'a.bb...aaa', 'a......a..', 'aaaaaaaa..', '..........', '..........'],
  gear: ['....aa....', '.a.aaaa.a.', '..aaaaaa..', '.aaa..aaa.', 'aaa....aaa', 'aaa....aaa', '.aaa..aaa.', '..aaaaaa..', '.a.aaaa.a.', '....aa....'],
  coin: ['..aaaaaa..', '.aaaabaaa.', 'aaabbbbaaa', 'aaabaaaaaa', 'aaaabbaaaa', 'aaaaaabaaa', 'aaabbbbaaa', '.aaaabaaa.', '..aaaaaa..', '..........'],
  lock: ['...aaaa...', '..a....a..', '..a....a..', '..a....a..', '.bbbbbbbb.', '.bbbbbbbb.', '.bbbaabbb.', '.bbbaabbb.', '.bbbbbbbb.', '..........'],
  wrench: ['......a.a.', '......a.a.', '......aaa.', '.....aaa..', '....aaa...', '...aaa....', '..aaa.....', '.aaa......', 'aaa.......', '.a........'],
};

// Presentation per preset id. Unknown presets still render with a neutral look.
const LOOK = {
  'first-failure': { icon: 'bolt', tag: 'Auto-buy', a: '#ebcb8b', b: '#ebcb8b', color: 'var(--warn)' },
  brownout: { icon: 'battery', tag: 'Root cause', a: '#d8dee9', b: '#bf616a', color: 'var(--bad)' },
  predictive: { icon: 'gear', tag: 'Predictive', a: '#88c0d0', b: '#88c0d0', color: 'var(--accent)' },
  'budget-crunch': { icon: 'coin', tag: 'Budget', a: '#ebcb8b', b: '#11141a', color: 'var(--warn)' },
  untrusted: { icon: 'lock', tag: 'Allowlist', a: '#d8dee9', b: '#bf616a', color: 'var(--bad)' },
  sandbox: { icon: 'wrench', tag: 'Free play', a: '#a3be8c', b: '#a3be8c', color: 'var(--good)' },
};
const DEFAULT_LOOK = { icon: 'wrench', tag: 'Scenario', a: '#d8dee9', b: '#d8dee9', color: 'var(--accent)' };

const STEPS = ['Read sensors', 'Read the plant log', 'Diagnose', 'Buy on Reap', 'Pay a technician', 'Verify'];

function drawSprite(canvas, rows, colors) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = colors[row[x]];
      if (!c) continue;
      ctx.fillStyle = c;
      ctx.fillRect(x, y, 1, 1);
    }
  });
}

/** What makes a preset distinct (from shared/contract.js), shown at the bottom of its card. */
function presetFacts(id) {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) return [];
  const facts = [];
  const targets = new Set([...(p.script || []).map((s) => s.target), ...Object.keys(p.initial || {})]);
  const machines = [...new Set([...targets].map((t) => t.split('/')[0]))].map((m) => MACHINE_NAMES[m] || m);
  facts.push(machines.length ? machines.join(' + ') : 'All machines');
  const pol = p.policy || {};
  if (pol.spent && pol.monthlyBudget != null) facts.push(`${usd(pol.monthlyBudget - pol.spent)} of ${usd(pol.monthlyBudget)} left`);
  if (pol.allowedMerchants) facts.push(`${pol.allowedMerchants.length} trusted stores`);
  if (pol.predictiveMaintenance) facts.push('predictive on');
  if (p.wear > 0) facts.push('natural wear');
  return facts.slice(0, 2);
}

export class ScenarioPicker {
  constructor(root, { presets, onPick } = {}) {
    this.onPick = onPick;
    this.busy = false;
    this.picked = false;
    this.closable = false;
    this.lastFocus = null;

    this.el = el(`<div class="scn-overlay scn-hidden" role="dialog" aria-modal="true" aria-labelledby="scn-title" aria-hidden="true">
      <div class="scn-inner">
        <header class="scn-head">
          <canvas class="scn-bot" width="${BOT[0].length}" height="${BOT.length}" aria-hidden="true"></canvas>
          <div class="scn-titles">
            <h1 class="scn-title" id="scn-title"><span class="scn-t1">WRENCH-BOT</span><span class="scn-t2">FACTORY</span></h1>
            <p class="scn-sub">An AI maintenance agent that reads the plant's sensors and logs, finds the broken part,
              and buys the replacement through <b>Reap</b> &mdash; within the spending rules you set.</p>
          </div>
        </header>
        <ol class="scn-steps" aria-label="How Wrench-bot works">
          ${STEPS.map((s) => `<li>${s}</li>`).join('')}
        </ol>
        <div class="scn-label"><span>Choose a scenario</span><em>Each one starts a fresh shift at 08:00</em></div>
        <div class="scn-grid" data-k="grid"></div>
        <div class="scn-error" data-k="error" role="alert" hidden></div>
        <footer class="scn-foot">
          <div class="hud-badges" data-k="badges"></div>
          <span class="scn-keys">Arrows move &middot; Enter starts<span data-k="escHint"> &middot; Esc goes back</span></span>
          <button class="scn-close" data-a="close">Back to the shift</button>
        </footer>
      </div>
    </div>`);
    this.grid = this.el.querySelector('[data-k=grid]');
    this.errorBox = this.el.querySelector('[data-k=error]');
    this.badges = this.el.querySelector('[data-k=badges]');
    this.closeBtn = this.el.querySelector('[data-a=close]');
    this.escHint = this.el.querySelector('[data-k=escHint]');
    this.bot = this.el.querySelector('.scn-bot');
    drawSprite(this.bot, BOT, PAL);

    this.grid.addEventListener('click', (e) => {
      const card = e.target.closest('.scn-card');
      if (card) this.#pick(card.dataset.id, card);
    });
    this.closeBtn.addEventListener('click', () => this.hide());
    this.el.addEventListener('keydown', (e) => this.#onKey(e));

    this.setPresets(presets);
    root.append(this.el);
  }

  /** Replace the cards (e.g. when STATE arrives after construction). */
  setPresets(presets) {
    const list = presets?.length ? presets : PRESETS.map(({ id, name, tagline, teaches }) => ({ id, name, tagline, teaches }));
    const key = JSON.stringify(list.map((p) => [p.id, p.name, p.tagline, p.teaches]));
    if (key === this.presetsKey) return; // STATE repeats on every reconnect: keep focus and DOM
    this.presetsKey = key;
    this.presets = list;
    this.grid.innerHTML = '';
    list.forEach((p) => {
      const look = LOOK[p.id] || DEFAULT_LOOK;
      const facts = presetFacts(p.id);
      const card = el(`<button class="scn-card" data-id="${esc(p.id)}" style="--scn-c: ${look.color}">
        <span class="scn-card-top">
          <canvas class="scn-icon" width="10" height="10" aria-hidden="true"></canvas>
          <span class="scn-name">${esc(p.name)}</span>
          <span class="scn-tag">${esc(look.tag)}</span>
        </span>
        <span class="scn-tagline">${esc(p.tagline || '')}</span>
        ${p.teaches ? `<span class="scn-teaches"><b>Teaches</b>${esc(p.teaches)}</span>` : ''}
        <span class="scn-card-foot">
          <span class="scn-facts">${facts.map(esc).join(' &middot; ')}</span>
          <span class="scn-go">Start <i></i></span>
        </span>
      </button>`);
      drawSprite(card.querySelector('.scn-icon'), ICONS[look.icon] || ICONS.wrench, { a: look.a, b: look.b });
      this.grid.append(card);
    });
  }

  /** opts.closable: show "BACK TO SHIFT" (default: after a scenario was picked once). */
  show(opts = {}) {
    this.closable = opts.closable ?? this.picked;
    this.closeBtn.hidden = !this.closable;
    this.escHint.hidden = !this.closable;
    this.#error('');
    if (!this.el.classList.contains('scn-hidden')) return;
    this.lastFocus = document.activeElement;
    this.el.classList.remove('scn-hidden');
    this.el.setAttribute('aria-hidden', 'false');
    this.blink = setInterval(() => this.#blinkBot(), 3200);
    requestAnimationFrame(() => this.grid.querySelector('.scn-card')?.focus({ preventScroll: true }));
  }

  hide() {
    if (this.el.classList.contains('scn-hidden')) return;
    this.el.classList.add('scn-hidden');
    this.el.setAttribute('aria-hidden', 'true');
    clearInterval(this.blink);
    if (this.el.contains(document.activeElement)) document.activeElement.blur();
    if (this.lastFocus?.isConnected && this.lastFocus !== document.body) this.lastFocus.focus?.({ preventScroll: true });
    this.lastFocus = null;
  }

  get visible() {
    return !this.el.classList.contains('scn-hidden');
  }

  setMode(mode) {
    this.badges.innerHTML = modeBadges(mode);
  }

  // ─── Internals ────────────────────────────────────────────────────────
  async #pick(id, card) {
    if (this.busy || !id) return;
    this.busy = true;
    this.#error('');
    this.grid.classList.add('is-busy');
    card.classList.add('is-loading');
    const go = card.querySelector('.scn-go');
    const goHtml = go.innerHTML;
    go.textContent = 'Loading…';
    try {
      await this.onPick?.(id);
      this.picked = true;
      this.hide();
    } catch (err) {
      const name = this.presets.find((p) => p.id === id)?.name || id;
      this.#error(`Could not start "${name}": ${err?.message || err}. Is the server running?`);
      card.focus({ preventScroll: true });
    } finally {
      this.busy = false;
      this.grid.classList.remove('is-busy');
      card.classList.remove('is-loading');
      go.innerHTML = goHtml;
    }
  }

  #error(msg) {
    this.errorBox.textContent = msg;
    this.errorBox.hidden = !msg;
  }

  #blinkBot() {
    drawSprite(this.bot, BOT, { ...PAL, e: PAL.k });
    setTimeout(() => drawSprite(this.bot, BOT, PAL), 140);
  }

  #onKey(e) {
    if (e.key === 'Escape') {
      if (this.closable && !this.busy) {
        e.preventDefault();
        this.hide();
      }
      return;
    }
    if (e.key === 'Tab') return this.#trapTab(e);
    const dirs = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: 'up', ArrowDown: 'down' };
    if (!(e.key in dirs)) return;
    const cards = [...this.grid.querySelectorAll('.scn-card')];
    const i = cards.indexOf(document.activeElement);
    if (!cards.length) return;
    e.preventDefault();
    if (i < 0) return cards[0].focus();
    // Columns = cards sharing the first card's row.
    const top = cards[0].offsetTop;
    const cols = Math.max(1, cards.filter((c) => c.offsetTop === top).length);
    const d = dirs[e.key];
    const step = d === 'up' ? -cols : d === 'down' ? cols : d;
    const j = Math.min(cards.length - 1, Math.max(0, i + step));
    cards[j].focus();
  }

  #trapTab(e) {
    const f = [...this.el.querySelectorAll('button:not([hidden])')].filter((b) => b.offsetParent !== null);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}
