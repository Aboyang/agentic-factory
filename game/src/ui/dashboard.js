// Manager dashboard: every purchase, payout, approval, block and agent decision,
// across all scenarios (the server's ledger, see LEDGER in shared/contract.js).
//   open()            GET /api/ledger → full history (called by UI.js when the modal opens)
//   setLedger(l)      STATE.ledger { totals, entries } (merged, not replaced)
//   add(entry)        EVENTS.LEDGER_ENTRY → appears at once, highlighted
// Tabs: PURCHASES | AGENT ACTIVITY | PAYOUTS. Renders into the modal body UI.js gives it.

import { MACHINES } from '../../../shared/contract.js';
import './dashboard.css';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);
const money = (n) => `$${num(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usdc = (n) => {
  const v = num(n);
  const small = v > 0 && v < 0.1; // scaled testnet payouts, e.g. 0.012 USDC
  return `${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: small ? 6 : 2 })} USDC`;
};
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');
const MAX = 1000;
const FRESH_MS = 3200;

const svg = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  purchase: svg('<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2.5 3.5h3l2.4 11.2a1.6 1.6 0 0 0 1.6 1.3h8.3a1.6 1.6 0 0 0 1.6-1.2L21 8H6.4"/>'),
  payout: svg('<circle cx="12" cy="12" r="9"/><path d="M15 9.2c-.6-.9-1.7-1.4-3-1.4-1.7 0-3 .9-3 2.1 0 2.8 6 1.4 6 4.2 0 1.2-1.3 2.1-3 2.1-1.3 0-2.5-.5-3.1-1.4M12 6v1.8M12 16.2V18"/>'),
  decision: svg('<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 4v4M9 13.5h.01M15 13.5h.01"/>'),
  approval: svg('<path d="M20 6 9 17l-5-5"/>'),
  blocked: svg('<circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>'),
  failed: svg('<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>'),
  incident: svg('<path d="M12 3.5 2.5 20h19L12 3.5z"/><path d="M12 10v4.5"/><path d="M12 17.5h.01"/>'),
  resolved: svg('<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.7 2.7L16.5 9.5"/>'),
  other: svg('<circle cx="12" cy="12" r="2"/>'),
};
const TYPES = {
  purchase: { label: 'Purchase', tone: 'good' },
  payout: { label: 'Payout', tone: 'accent' },
  decision: { label: 'Decision', tone: 'agent' },
  approval: { label: 'Approval', tone: 'info' },
  blocked: { label: 'Blocked', tone: 'bad' },
  failed: { label: 'Failed', tone: 'bad' },
  incident: { label: 'Incident', tone: 'warn' },
  resolved: { label: 'Resolved', tone: 'good' },
};
const TABS = [
  { id: 'purchases', label: 'Purchases' },
  { id: 'activity', label: 'Agent activity' },
  { id: 'payouts', label: 'Payouts' },
];
const ZERO = { partsSpend: 0, laborUsd: 0, laborUsdc: 0, orders: 0, autoApproved: 0, managerApproved: 0, blocked: 0, failed: 0, incidents: 0, resolved: 0, avgMinutesToFix: null };

const isPurchaseRow = (e) => e.type === 'purchase' || e.type === 'blocked' || e.type === 'failed';
const typeOf = (e) => (TYPES[e?.type] ? e.type : 'other');

function providerName(p) {
  const s = String(p || '').toLowerCase();
  if (!s) return '';
  if (s === 'mock' || s === 'heuristic') return 'built-in heuristic';
  if (s.includes('decision')) return 'Decisions API';
  if (s.includes('gpt') || s.includes('openai')) return 'GPT model';
  return String(p);
}

function confidencePct(c) {
  if (c == null || c === '' || !Number.isFinite(Number(c))) return '';
  const v = Number(c);
  return `${Math.round(v <= 1 ? v * 100 : v)}%`;
}

function partText(e) {
  const p = e.part;
  const name = p && typeof p === 'object' ? p.name || p.title || p.id : p;
  return String(name || '');
}

function minutesToFix(e, byIncident) {
  const direct = e.minutesToFix ?? e.minutes ?? e.durationMinutes;
  if (Number.isFinite(Number(direct)) && direct !== null && direct !== '') return Number(direct);
  const start = e.incidentId ? byIncident.get(e.incidentId) : null;
  if (start && Number.isFinite(Number(e.t)) && Number.isFinite(Number(start.t)) && Number(e.t) >= Number(start.t)) return Number(e.t) - Number(start.t);
  return null;
}

/** Totals from a list of entries (used when the server sent none, and for live entries since). */
function computeTotals(list) {
  const t = { ...ZERO };
  const starts = new Map();
  for (const e of list) if (e?.type === 'incident' && e.incidentId && !starts.has(e.incidentId)) starts.set(e.incidentId, e);
  const fixes = [];
  for (const e of list) {
    if (!e) continue;
    if (e.type === 'purchase') {
      t.orders += 1;
      t.partsSpend += num(e.amount);
      if (e.approval === 'manager') t.managerApproved += 1;
      else t.autoApproved += 1;
    } else if (e.type === 'payout') {
      if (String(e.currency || 'USDC').toUpperCase() === 'USD') t.laborUsd += num(e.amount);
      else {
        t.laborUsdc += num(e.amountUsdc ?? e.amount);
        t.laborUsd += num(e.jobUsd ?? e.amountUsd);
      }
    } else if (e.type === 'blocked') t.blocked += 1;
    else if (e.type === 'failed') t.failed += 1;
    else if (e.type === 'incident') t.incidents += 1;
    else if (e.type === 'resolved') {
      t.resolved += 1;
      const m = minutesToFix(e, starts);
      if (m != null) fixes.push(m);
    }
  }
  t.avgMinutesToFix = fixes.length ? fixes.reduce((a, b) => a + b, 0) / fixes.length : null;
  t.fixCount = fixes.length;
  return t;
}

function addTotals(base, extra) {
  const out = { ...ZERO, ...base };
  for (const k of Object.keys(ZERO)) if (k !== 'avgMinutesToFix') out[k] = num(base?.[k]) + num(extra?.[k]);
  const a = base?.avgMinutesToFix;
  const b = extra?.avgMinutesToFix;
  if (a != null && Number.isFinite(Number(a)) && b != null && extra.fixCount) {
    const n = Math.max(1, num(base.resolved));
    out.avgMinutesToFix = (Number(a) * n + b * extra.fixCount) / (n + extra.fixCount);
  } else out.avgMinutesToFix = a != null && Number.isFinite(Number(a)) ? Number(a) : b;
  return out;
}

function timeText(at) {
  const d = at ? new Date(at) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`;
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export class Dashboard {
  /**
   * @param root          the modal body element
   * @param opts.api      (method, path, body) => Promise
   * @param opts.toast    (text, kind, label) => void
   */
  constructor(root, { api, machines = MACHINES, toast } = {}) {
    this.root = root;
    this.api = api;
    this.toast = toast || (() => {});
    this.machineNames = new Map(machines.map((m) => [m.id, m.name]));
    this.list = []; // oldest → newest
    this.ids = new Set();
    this.base = null; // server totals
    this.baseIds = new Set(); // entries those totals already include
    this.fresh = new Map(); // id → time it arrived live
    this.liveSince = null; // ids received while a fetch is in flight
    this.tab = 'purchases';
    this.typeFilter = 'all';
    this.machineFilter = 'all';
    this.visible = false;
    this.loading = false;
    this.error = '';
    this.seq = 0;
    this.raf = 0;

    root.classList.add('dsh-body');
    root.innerHTML = `<div class="dsh">
      <div class="dsh-cards" data-k="cards"></div>
      <div class="dsh-bar">
        <div class="dsh-tabs" role="tablist" data-k="tabs"></div>
        <div class="dsh-tools">
          <span class="dsh-live" title="New entries appear here as they happen"><i></i>Live</span>
          <button class="small ghost" data-a="csv" title="Download the purchases as a CSV file">Export CSV</button>
          <button class="small ghost dsh-clear" data-a="clear" title="Delete the whole history on the server">Clear history</button>
        </div>
      </div>
      <div class="dsh-note hidden" data-k="note"></div>
      <div class="dsh-pane" data-k="pane"></div>
    </div>`;
    this.el = {
      cards: root.querySelector('[data-k=cards]'),
      tabs: root.querySelector('[data-k=tabs]'),
      note: root.querySelector('[data-k=note]'),
      pane: root.querySelector('[data-k=pane]'),
    };
    root.addEventListener('click', (e) => this.#onClick(e));
  }

  // ─── Data in ─────────────────────────────────────────────────────────
  /** STATE.ledger or the GET /api/ledger body: { entries, totals }. full = replace the list. */
  setLedger(ledger, { full = false } = {}) {
    if (!ledger || typeof ledger !== 'object') return;
    const entries = Array.isArray(ledger.entries) ? ledger.entries.filter((e) => e && typeof e === 'object') : [];
    const totals = ledger.totals && typeof ledger.totals === 'object' ? ledger.totals : null;
    const cleared = !entries.length && totals && !num(totals.orders) && !num(totals.incidents) && !num(totals.blocked) && !num(totals.laborUsdc);
    if (full || cleared) {
      const keep = full && this.liveSince ? this.list.filter((e) => this.liveSince.has(e.id)) : [];
      this.list = [];
      this.ids.clear();
      for (const e of entries) this.#push(e);
      for (const e of keep) this.#push(e);
    } else {
      for (const e of entries) this.#push(e);
    }
    this.#trim();
    if (totals) {
      this.base = totals;
      this.baseIds = new Set(this.ids);
      // Live entries that arrived during a fetch are not in those totals yet.
      if (full && this.liveSince) for (const id of this.liveSince) if (!entries.some((e) => e.id === id)) this.baseIds.delete(id);
    } else if (full) {
      this.base = null;
      this.baseIds = new Set();
    }
    this.#schedule();
  }

  /** EVENTS.LEDGER_ENTRY */
  add(entry) {
    if (!entry || typeof entry !== 'object') return;
    const id = this.#push(entry);
    this.#trim();
    if (this.liveSince) this.liveSince.add(id);
    if (this.visible) {
      this.fresh.set(id, performance.now());
      setTimeout(() => this.fresh.delete(id), FRESH_MS);
    }
    this.#schedule();
  }

  /** SSE 'ledger.cleared': another tab cleared the history on the server. */
  cleared() {
    this.seq++; // drop a fetch still in flight
    this.loading = false;
    this.liveSince = null;
    this.list = [];
    this.ids.clear();
    this.fresh.clear();
    this.base = { ...ZERO };
    this.baseIds = new Set();
    this.#schedule();
  }

  // ─── Visibility (UI.js) ──────────────────────────────────────────────
  open() {
    this.visible = true;
    this.#render();
    this.refresh();
  }

  close() {
    this.visible = false;
    this.fresh.clear();
  }

  async refresh() {
    if (!this.api) return;
    const seq = ++this.seq;
    this.loading = true;
    this.error = '';
    this.liveSince = new Set();
    this.#schedule();
    try {
      const res = await this.api('GET', '/ledger');
      if (seq !== this.seq) return;
      this.setLedger(Array.isArray(res) ? { entries: res } : res || {}, { full: true });
    } catch (err) {
      if (seq !== this.seq) return;
      this.error = `Could not load the full history (${err?.message || 'network error'}). Showing what this page has seen.`;
    } finally {
      if (seq === this.seq) {
        this.loading = false;
        this.liveSince = null;
        this.#schedule();
      }
    }
  }

  // ─── Internals ───────────────────────────────────────────────────────
  #push(raw) {
    const e = { ...raw };
    if (e.id == null || e.id === '') e.id = `local-${e.at || ''}-${e.type || ''}-${e.title || ''}`;
    e.id = String(e.id);
    if (this.ids.has(e.id)) {
      const i = this.list.findIndex((x) => x.id === e.id);
      if (i >= 0) this.list[i] = e;
    } else {
      this.ids.add(e.id);
      this.list.push(e);
    }
    return e.id;
  }

  #trim() {
    if (this.list.length <= MAX) return;
    for (const e of this.list.splice(0, this.list.length - MAX)) this.ids.delete(e.id);
  }

  #totals() {
    if (!this.base) return computeTotals(this.list);
    const extra = this.list.filter((e) => !this.baseIds.has(e.id));
    if (!extra.length) return { ...ZERO, ...this.base };
    // Average time-to-fix of new entries needs their incident starts, which may be older.
    const t = computeTotals(extra);
    if (t.resolved) {
      const starts = new Map();
      for (const e of this.list) if (e.type === 'incident' && e.incidentId && !starts.has(e.incidentId)) starts.set(e.incidentId, e);
      const fixes = extra.filter((e) => e.type === 'resolved').map((e) => minutesToFix(e, starts)).filter((m) => m != null);
      t.fixCount = fixes.length;
      t.avgMinutesToFix = fixes.length ? fixes.reduce((a, b) => a + b, 0) / fixes.length : null;
    }
    return addTotals(this.base, t);
  }

  #schedule() {
    if (!this.visible || this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (this.visible) this.#render();
    });
  }

  #render() {
    const newest = this.list.slice().reverse();
    const purchases = newest.filter(isPurchaseRow);
    const payouts = newest.filter((e) => e.type === 'payout');
    this.#renderCards(this.#totals());
    const counts = { purchases: purchases.length, activity: newest.length, payouts: payouts.length };
    this.el.tabs.innerHTML = TABS.map((t) => `<button role="tab" class="dsh-tab${this.tab === t.id ? ' on' : ''}" data-tab="${t.id}" aria-selected="${this.tab === t.id}">${esc(t.label)}<span class="dsh-count">${counts[t.id]}</span></button>`).join('');
    const note = this.error || (this.loading && !this.list.length ? 'Loading the history…' : '');
    this.el.note.textContent = note;
    this.el.note.classList.toggle('hidden', !note);
    this.el.note.classList.toggle('is-err', Boolean(this.error));
    this.root.querySelector('[data-a=csv]').disabled = !purchases.length;
    this.root.querySelector('[data-a=clear]').disabled = !this.list.length;
    const pane = this.el.pane;
    if (this.tab === 'activity') pane.innerHTML = this.#activity(newest);
    else if (this.tab === 'payouts') pane.innerHTML = this.#payouts(payouts);
    else pane.innerHTML = this.#purchases(purchases);
  }

  #renderCards(t) {
    const approvals = num(t.autoApproved) + num(t.managerApproved) + num(t.blocked);
    const share = (n) => (approvals ? `${((num(n) / approvals) * 100).toFixed(1)}%` : '0%');
    const avg = t.avgMinutesToFix != null && Number.isFinite(Number(t.avgMinutesToFix)) ? Number(t.avgMinutesToFix) : null;
    const card = (label, value, sub, cls = '') => `<div class="dsh-card ${cls}"><span class="dsh-card-l">${label}</span><b class="dsh-card-v">${value}</b><small>${sub}</small></div>`;
    this.el.cards.innerHTML = [
      card('Parts spend', esc(money(t.partsSpend)), `${num(t.orders)} order${num(t.orders) === 1 ? '' : 's'} placed`, 'is-parts'),
      card('Technician payouts', esc(usdc(t.laborUsdc)), num(t.laborUsd) ? `${esc(money(t.laborUsd))} labor in USD` : 'Paid onchain to technicians', 'is-labor'),
      card('Orders', String(num(t.orders)), num(t.failed) ? `<span class="badtxt">${num(t.failed)} failed checkout${num(t.failed) === 1 ? '' : 's'}</span>` : 'No failed checkouts'),
      `<div class="dsh-card dsh-card-wide"><span class="dsh-card-l">Who approved</span>
        <div class="dsh-split" aria-hidden="true"><i class="s-auto" style="width:${share(t.autoApproved)}"></i><i class="s-mgr" style="width:${share(t.managerApproved)}"></i><i class="s-blk" style="width:${share(t.blocked)}"></i></div>
        <div class="dsh-legend"><span><i class="s-auto"></i>Auto <b>${num(t.autoApproved)}</b></span><span><i class="s-mgr"></i>Manager <b>${num(t.managerApproved)}</b></span><span><i class="s-blk"></i>Blocked <b>${num(t.blocked)}</b></span></div>
      </div>`,
      card('Incidents resolved', `${num(t.resolved)}<span class="dsh-of"> / ${num(t.incidents)}</span>`, num(t.incidents) ? `${Math.max(0, num(t.incidents) - num(t.resolved))} still open or stopped` : 'No incidents yet'),
      card('Avg time to fix', avg == null ? '—' : `${avg < 10 ? avg.toFixed(1) : Math.round(avg)}<span class="dsh-of"> min</span>`, 'Game minutes, fault to running'),
    ].join('');
  }

  #machine(e) {
    return this.machineNames.get(e.machineId) || e.machineId || '';
  }

  #rowCls(e) {
    return this.fresh.has(e.id) ? ' dsh-new' : '';
  }

  #purchases(rows) {
    if (!rows.length) {
      return this.#empty(ICON.purchase, 'No purchases yet', 'When Wrench-bot buys a replacement part, on its own or with your OK, the order shows up here with the store, the price and how it was paid.');
    }
    const body = rows.map((e) => {
      const bad = e.type !== 'purchase';
      const qty = num(e.qty) > 1 ? ` <span class="dsh-qty">×${num(e.qty)}</span>` : '';
      const part = partText(e) || e.title || '';
      const amount = e.amount != null && e.amount !== '' ? `${esc(money(e.amount))}${String(e.currency || '').toUpperCase() === 'USDC' ? '<small> USDC</small>' : ''}` : '<span class="muted">—</span>';
      const rail = e.rail === 'kwal' ? '<span class="dsh-badge b-kwal">Kwal vault</span>' : e.rail === 'reap' ? '<span class="dsh-badge b-reap">Reap card</span>' : '<span class="muted">—</span>';
      let appr;
      if (e.type === 'failed') appr = '<span class="chip bad">Failed</span>';
      else if (e.type === 'blocked' || e.approval === 'blocked') appr = '<span class="chip bad">Blocked</span>';
      else if (e.approval === 'manager') appr = '<span class="chip info">Manager</span>';
      else appr = '<span class="chip good">Auto</span>';
      const why = bad && e.detail ? `<small class="dsh-why">${esc(e.detail)}</small>` : '';
      return `<tr class="${bad ? 'is-bad' : ''}${this.#rowCls(e)}">
        <td class="dsh-time">${esc(timeText(e.at))}${e.clock ? `<small>shift ${esc(e.clock)}</small>` : ''}</td>
        <td>${esc(e.preset?.name || '')}</td>
        <td>${esc(this.#machine(e))}</td>
        <td class="dsh-part"><span>${esc(part)}${qty}</span>${why}</td>
        <td>${esc(e.merchant || '')}</td>
        <td class="dsh-num${bad ? ' dsh-strike' : ''}">${amount}</td>
        <td>${rail}</td>
        <td>${appr}${e.simulated ? ' <span class="dsh-demo" title="Payment simulated (offline or judge demo)">demo</span>' : ''}</td>
        <td class="dsh-mono">${esc(e.orderId || '')}</td>
      </tr>`;
    }).join('');
    return `<div class="dsh-table-wrap"><table class="dsh-table">
      <thead><tr><th>Time</th><th>Scenario</th><th>Machine</th><th>Part</th><th>Store</th><th class="dsh-num">Amount</th><th>Paid with</th><th>Approval</th><th>Order</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
  }

  #activity(all) {
    if (!all.length) {
      return this.#empty(ICON.decision, 'Nothing logged yet', 'Start a scenario. Every step Wrench-bot takes (diagnoses, policy decisions, purchases, blocks, payouts) lands here, newest first.');
    }
    const typeCounts = new Map();
    const machineCounts = new Map();
    for (const e of all) {
      const ty = typeOf(e);
      typeCounts.set(ty, (typeCounts.get(ty) || 0) + 1);
      if (e.machineId) machineCounts.set(e.machineId, (machineCounts.get(e.machineId) || 0) + 1);
    }
    if (this.typeFilter !== 'all' && !typeCounts.has(this.typeFilter)) this.typeFilter = 'all';
    if (this.machineFilter !== 'all' && !machineCounts.has(this.machineFilter)) this.machineFilter = 'all';
    const chip = (kind, value, label, n, on) => `<button class="dsh-fchip${on ? ' on' : ''}" data-f="${kind}" data-v="${esc(value)}" aria-pressed="${on}">${esc(label)}<span>${n}</span></button>`;
    const typeOrder = [...Object.keys(TYPES), 'other'].filter((k) => typeCounts.has(k));
    const types = [chip('type', 'all', 'All', all.length, this.typeFilter === 'all'), ...typeOrder.map((k) => chip('type', k, TYPES[k]?.label || 'Other', typeCounts.get(k), this.typeFilter === k))].join('');
    const machines = machineCounts.size
      ? [chip('machine', 'all', 'All machines', all.length, this.machineFilter === 'all'), ...[...machineCounts.keys()].map((id) => chip('machine', id, this.machineNames.get(id) || id, machineCounts.get(id), this.machineFilter === id))].join('')
      : '';
    const shown = all.filter((e) => (this.typeFilter === 'all' || typeOf(e) === this.typeFilter) && (this.machineFilter === 'all' || e.machineId === this.machineFilter));
    const items = shown.map((e) => {
      const ty = typeOf(e);
      const meta = [
        timeText(e.at),
        e.clock ? `shift ${e.clock}` : '',
        e.preset?.name || '',
        this.#machine(e),
        e.amount != null && e.amount !== '' ? (e.type === 'payout' ? usdc(e.amountUsdc ?? e.amount) : money(e.amount)) : '',
      ].filter(Boolean).map((s) => `<span>${esc(s)}</span>`).join('');
      const conf = confidencePct(e.confidence);
      const prov = providerName(e.provider);
      const tags = [
        conf ? `<span class="dsh-tag">${esc(conf)} confident</span>` : '',
        prov ? `<span class="dsh-tag">${esc(prov)}</span>` : '',
        e.simulated ? '<span class="dsh-demo">demo</span>' : '',
      ].join('');
      const tx = safeUrl(e.txUrl);
      return `<li class="dsh-ev t-${TYPES[ty]?.tone || 'muted'}${this.#rowCls(e)}">
        <span class="dsh-ev-ico" title="${esc(TYPES[ty]?.label || e.type || '')}">${ICON[ty] || ICON.other}</span>
        <div class="dsh-ev-main">
          <div class="dsh-ev-title"><b>${esc(e.title || TYPES[ty]?.label || 'Event')}</b>${tags}${tx ? ` <a href="${esc(tx)}" target="_blank" rel="noopener noreferrer">tx ↗</a>` : ''}</div>
          ${e.detail ? `<div class="dsh-ev-detail">${esc(e.detail)}</div>` : ''}
          <div class="dsh-ev-meta">${meta}</div>
        </div>
      </li>`;
    }).join('');
    return `<div class="dsh-filters">
        <div class="dsh-frow">${types}</div>
        ${machines ? `<div class="dsh-frow">${machines}</div>` : ''}
      </div>
      ${shown.length ? `<ol class="dsh-timeline">${items}</ol>` : '<div class="dsh-empty small"><p>Nothing matches these filters.</p></div>'}`;
  }

  #payouts(rows) {
    if (!rows.length) {
      return this.#empty(ICON.payout, 'No technician payouts yet', 'Every repair ends with a USDC payout to the technician who fitted the part: onchain on Ink Sepolia when the treasury is set up, simulated otherwise.');
    }
    const body = rows.map((e) => {
      const tx = safeUrl(e.txUrl);
      const onchain = Boolean(e.onchain) && !e.simulated;
      return `<tr class="${this.#rowCls(e).trim()}">
        <td class="dsh-time">${esc(timeText(e.at))}${e.clock ? `<small>shift ${esc(e.clock)}</small>` : ''}</td>
        <td>${esc(e.title || 'Technician payout')}${e.detail ? `<small>${esc(e.detail)}</small>` : ''}</td>
        <td>${esc(e.preset?.name || '')}</td>
        <td>${esc(this.#machine(e))}</td>
        <td class="dsh-num">${esc(usdc(e.amountUsdc ?? e.amount))}</td>
        <td>${onchain ? '<span class="dsh-badge b-chain">Onchain</span>' : '<span class="dsh-badge b-sim">Simulated</span>'}</td>
        <td>${tx ? `<a class="dsh-mono" href="${esc(tx)}" target="_blank" rel="noopener noreferrer" title="${esc(e.txHash || tx)}">${esc(e.txHash ? `${String(e.txHash).slice(0, 10)}…` : 'View')} ↗</a>` : '<span class="muted">—</span>'}</td>
      </tr>`;
    }).join('');
    return `<div class="dsh-table-wrap"><table class="dsh-table">
      <thead><tr><th>Time</th><th>Payout</th><th>Scenario</th><th>Machine</th><th class="dsh-num">Amount</th><th>Status</th><th>Transaction</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
  }

  #empty(icon, title, text) {
    return `<div class="dsh-empty"><span class="dsh-empty-ico">${icon}</span><b>${esc(title)}</b><p>${esc(text)}</p></div>`;
  }

  #exportCsv() {
    const rows = this.list.filter(isPurchaseRow);
    if (!rows.length) return;
    const head = ['time', 'shift_clock', 'scenario', 'machine', 'part', 'qty', 'store', 'amount', 'currency', 'rail', 'approval', 'status', 'order_id', 'simulated', 'detail'];
    const lines = rows.map((e) => [
      e.at || '', e.clock || '', e.preset?.name || '', this.#machine(e), partText(e) || e.title || '', e.qty ?? '', e.merchant || '',
      e.amount ?? '', e.currency || '', e.rail || '', e.type === 'purchase' ? e.approval || 'auto' : e.type, e.type, e.orderId || '',
      e.simulated ? 'yes' : 'no', e.detail || '',
    ].map(csvCell).join(','));
    const blob = new Blob([`${head.join(',')}\n${lines.join('\n')}\n`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wrenchbot-purchases-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async #clear() {
    if (!this.list.length) return;
    let ok = false;
    try {
      ok = window.confirm('Clear the whole history? Every purchase, payout and agent decision is deleted from the server. This cannot be undone.');
    } catch {
      ok = false;
    }
    if (!ok) return;
    const btn = this.root.querySelector('[data-a=clear]');
    if (btn) btn.disabled = true;
    try {
      const res = await this.api('POST', '/ledger/clear');
      this.seq++; // drop a fetch still in flight
      this.loading = false;
      this.liveSince = null;
      this.list = [];
      this.ids.clear();
      this.fresh.clear();
      this.base = null;
      this.baseIds = new Set();
      this.error = '';
      if (res && typeof res === 'object' && (Array.isArray(res.entries) || res.totals)) this.setLedger(res, { full: true });
      this.toast('History cleared.', 'good', 'DASHBOARD');
    } catch (err) {
      this.toast(`Could not clear the history: ${err?.message || 'network error'}`, 'bad', 'ERROR');
    }
    this.#schedule();
  }

  #onClick(e) {
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      this.tab = tab.dataset.tab;
      this.#render();
      return;
    }
    const f = e.target.closest('[data-f]');
    if (f) {
      if (f.dataset.f === 'type') this.typeFilter = f.dataset.v;
      else this.machineFilter = f.dataset.v;
      this.#render();
      return;
    }
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'csv') this.#exportCsv();
    else if (a === 'clear') this.#clear();
  }
}
