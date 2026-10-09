// Terminal log in the bottom-right corner: the plant log, the same lines the
// decision model reads, plus a few client-side lines (payments, escrow links).
// Tabs: ALL · ALERTS · AGENT. Small by default; expand with the button or L.
// Autoscrolls unless the user scrolled up.

import './ui-shell.css';
import { LOG_LEVELS, MACHINES } from '../../../shared/contract.js';

const MAX_ROWS = 400;
const RANK = Object.fromEntries(LOG_LEVELS.map((l, i) => [l, i]));
const MACHINE_NAMES = Object.fromEntries(MACHINES.map((m) => [m.id, m.name]));
const PART_NAMES = Object.fromEntries(MACHINES.flatMap((m) => m.components.map((c) => [`${m.id}/${c.id}`, c.name])));
const FILTERS = [
  { id: 'all', label: 'ALL', tip: 'Every line' },
  { id: 'alerts', label: 'ALERTS', tip: 'Warnings, errors and faults only' },
  { id: 'agent', label: 'AGENT', tip: 'Only what Wrench-bot did' },
];
const PREFS_KEY = 'wrenchbot.term.v1';

const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');

function readPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
    return p && typeof p === 'object' ? p : {};
  } catch {
    return {};
  }
}

export class PlantLog {
  /** opts.onSelect(machineId): called when a line's machine name is clicked. */
  constructor(root, { onSelect } = {}) {
    this.onSelect = onSelect;
    this.items = []; // { entry, row }
    this.ids = new Set();
    this.unseen = 0;
    this.unread = 0; // alert lines that arrived while minimized
    this.clock = '--:--';
    this.localSeq = 0;
    const prefs = readPrefs();
    this.filter = FILTERS.some((f) => f.id === prefs.filter) ? prefs.filter : 'all';

    this.el = el(`<section class="term" aria-label="Plant log">
      <header class="term-head">
        <button class="term-title" data-a="min" title="Minimize / restore the log"><i class="term-led"></i><span>plant.log</span><b class="term-unread" data-k="unread" hidden></b></button>
        <div class="term-tabs" role="group" aria-label="Filter">
          ${FILTERS.map((f) => `<button class="term-tab" data-f="${f.id}" aria-pressed="false" title="${f.tip}">${f.label}</button>`).join('')}
        </div>
        <button class="term-btn" data-a="size" title="Bigger / smaller (L)" aria-label="Toggle log size"><i class="term-ico-size"></i></button>
        <button class="term-btn" data-a="min" title="Minimize" aria-label="Minimize log"><i class="term-ico-min"></i></button>
      </header>
      <div class="term-body" data-k="body" role="log" aria-live="polite">
        <div class="term-list" data-k="list"></div>
        <div class="term-empty" data-k="empty">waiting for the shift to start…</div>
        <div class="term-cursor" aria-hidden="true"><span>wrench-bot@plant:~$</span><i></i></div>
      </div>
      <button class="term-jump" data-a="jump" hidden></button>
    </section>`);

    this.body = this.el.querySelector('[data-k=body]');
    this.list = this.el.querySelector('[data-k=list]');
    this.empty = this.el.querySelector('[data-k=empty]');
    this.jump = this.el.querySelector('[data-a=jump]');
    this.unreadEl = this.el.querySelector('[data-k=unread]');

    this.el.addEventListener('click', (e) => {
      const f = e.target.closest('[data-f]');
      if (f) return this.setFilter(f.dataset.f);
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'size') this.toggleSize();
      else if (a === 'min') this.setMinimized(!this.minimized);
      else if (a === 'jump') this.#toBottom();
      const m = e.target.closest('[data-machine]');
      if (m && this.onSelect) this.onSelect(m.dataset.machine);
    });
    this.body.addEventListener('scroll', () => {
      if (this.#atBottom()) this.#clearUnseen();
    }, { passive: true });

    root.append(this.el);
    this.setFilter(this.filter, { save: false });
    this.setSize(prefs.size === 'large' ? 'large' : 'small', { save: false });
    this.setMinimized(Boolean(prefs.min), { save: false });
    this.#refresh();
  }

  get size() {
    return this.el.classList.contains('is-large') ? 'large' : 'small';
  }

  get minimized() {
    return this.el.classList.contains('is-min');
  }

  /** Current sim clock, used to stamp client-side lines. */
  setClock(clock) {
    if (clock) this.clock = clock;
  }

  /** Replace everything (e.g. after a preset load or on connect). Entries oldest first. */
  load(entries) {
    this.items = [];
    this.ids.clear();
    this.list.textContent = '';
    this.#clearUnseen();
    this.#setUnread(0);
    const frag = document.createDocumentFragment();
    const list = Array.isArray(entries) ? entries.slice(-MAX_ROWS) : [];
    for (const entry of list) {
      const item = this.#make(entry, false);
      if (item) frag.append(item.row);
    }
    this.list.append(frag);
    this.#refresh();
    this.#toBottom();
  }

  /** Append one entry (LOG_ENTRY event). Duplicate ids are ignored. */
  add(entry) {
    const stick = this.#atBottom();
    const item = this.#make(entry, true);
    if (!item) return;
    this.list.append(item.row);
    while (this.items.length > MAX_ROWS) {
      const old = this.items.shift();
      old.row.remove();
      if (old.entry.id != null) this.ids.delete(old.entry.id);
    }
    this.#refresh();
    if (this.minimized && RANK[item.entry.level] >= RANK.WARN) this.#setUnread(this.unread + 1, RANK[item.entry.level] >= RANK.ERROR);
    if (item.row.hidden) return;
    if (stick || this.minimized) this.#toBottom();
    else {
      this.unseen++;
      this.jump.textContent = `${this.unseen} new ↓`;
      this.jump.hidden = false;
      this.jump.classList.toggle('is-alert', this.jump.classList.contains('is-alert') || RANK[item.entry.level] >= RANK.ERROR);
    }
  }

  /**
   * A client-side line (payment rail, onchain escrow link…).
   * note = { level, machineId, componentId, code, message, href, linkText }
   */
  note(note = {}) {
    if (!note.message) return;
    this.add({ ...note, id: `local-${++this.localSeq}`, clock: note.clock || this.clock, local: true });
  }

  clear() {
    this.load([]);
  }

  setFilter(f, { save = true } = {}) {
    if (!FILTERS.some((x) => x.id === f)) return;
    this.filter = f;
    for (const b of this.el.querySelectorAll('[data-f]')) {
      const on = b.dataset.f === f;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    for (const it of this.items) it.row.hidden = !this.#match(it.entry);
    this.#clearUnseen();
    this.#refresh();
    this.#toBottom();
    if (save) this.#save();
  }

  setSize(size, { save = true } = {}) {
    this.el.classList.toggle('is-large', size === 'large');
    const btn = this.el.querySelector('[data-a=size]');
    btn.title = size === 'large' ? 'Smaller (L)' : 'Bigger (L)';
    if (size === 'large' && this.minimized) this.setMinimized(false, { save: false });
    this.#toBottom();
    if (save) this.#save();
  }

  toggleSize() {
    if (this.minimized) return this.setMinimized(false);
    this.setSize(this.size === 'large' ? 'small' : 'large');
  }

  setMinimized(on, { save = true } = {}) {
    this.el.classList.toggle('is-min', Boolean(on));
    if (!on) {
      this.#setUnread(0);
      this.#toBottom();
    }
    if (save) this.#save();
  }

  // ─── Internals ────────────────────────────────────────────────────────
  #make(entry, fresh) {
    if (!entry || typeof entry !== 'object') return null;
    if (entry.id != null) {
      if (this.ids.has(entry.id)) return null;
      this.ids.add(entry.id);
    }
    const level = RANK[entry.level] != null ? entry.level : 'INFO';
    const mName = MACHINE_NAMES[entry.machineId] || '';
    const part = PART_NAMES[`${entry.machineId}/${entry.componentId}`];
    const row = document.createElement('div');
    row.className = `term-row lv-${level}${fresh ? ' is-new' : ''}${entry.local ? ' is-local' : ''}`;
    row.innerHTML = '<span class="tl-t"></span> <span class="tl-lv"></span> <span class="tl-code"></span><span class="tl-m"></span> <span class="tl-msg"></span>';
    const [t, lv, code, m, msg] = row.querySelectorAll('span');
    t.textContent = entry.clock || '--:--';
    lv.textContent = level;
    code.textContent = entry.code ? `${entry.code} ` : '';
    if (mName) {
      m.textContent = mName;
      m.dataset.machine = entry.machineId;
      m.title = `${mName}${part ? ` · ${part}` : ''} (click to inspect)`;
    } else m.remove();
    msg.textContent = entry.message || '';
    if (part) msg.title = part;
    const href = safeUrl(entry.href);
    if (href) {
      const a = document.createElement('a');
      a.className = 'tl-link';
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = entry.linkText || 'open ↗';
      msg.append(' ', a);
    }
    const item = { entry: { ...entry, level }, row };
    row.hidden = !this.#match(item.entry);
    this.items.push(item);
    if (fresh) setTimeout(() => row.classList.remove('is-new'), 1600);
    return item;
  }

  #match(e) {
    if (this.filter === 'alerts') return RANK[e.level] >= RANK.WARN;
    if (this.filter === 'agent') return e.level === 'AGENT';
    return true;
  }

  #refresh() {
    let shown = 0;
    for (const it of this.items) if (!it.row.hidden) shown++;
    this.empty.hidden = shown > 0;
    this.empty.textContent = this.items.length ? 'nothing matches this filter' : 'waiting for the shift to start…';
  }

  #setUnread(n, alert = false) {
    this.unread = n;
    this.unreadEl.hidden = !n;
    this.unreadEl.textContent = n > 99 ? '99+' : String(n);
    if (!n) this.el.classList.remove('is-alerting');
    else if (alert) this.el.classList.add('is-alerting');
  }

  #save() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ filter: this.filter, size: this.size, min: this.minimized }));
    } catch {}
  }

  #atBottom() {
    const b = this.body;
    return b.scrollTop + b.clientHeight >= b.scrollHeight - 24;
  }

  #toBottom() {
    this.body.scrollTop = this.body.scrollHeight;
    this.#clearUnseen();
  }

  #clearUnseen() {
    this.unseen = 0;
    this.jump.hidden = true;
    this.jump.classList.remove('is-alert');
  }
}
