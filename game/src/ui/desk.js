// Manager's Desk: the spending rules Wrench-bot must follow.
// Built once; policy updates patch values in place and never touch a control
// the user is currently dragging or saving.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const money0 = (n) => `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
const pct = (p) => `${Math.round((Number(p) || 0) * 100)}%`;

const SLIDERS = [
  { key: 'autoApproveLimit', label: 'AUTO-APPROVE LIMIT', min: 0, max: 300, step: 5, fmt: money0, help: 'Orders above this wait for your OK.' },
  { key: 'monthlyBudget', label: 'MONTHLY BUDGET', min: 100, max: 3000, step: 50, fmt: money0, help: null },
  { key: 'confidenceThreshold', label: 'CONFIDENCE NEEDED', min: 0.5, max: 0.95, step: 0.05, fmt: pct, help: 'If the diagnosis or the listing pick is less sure than this, it asks you.' },
];

export class Desk {
  constructor(root, { api, toast } = {}) {
    this.root = root;
    this.api = api;
    this.toast = toast || (() => {});
    this.policy = null;
    this.busy = new Set(); // control keys the user is touching right now
    this.merchants = new Set();
    this.flagged = new Set(); // untrusted stores that blocked an order
    this.storesSig = '';

    root.innerHTML = `<div class="dk">
      <div class="dk-rule" data-k="rule">Loading the spending rules…</div>
      ${SLIDERS.map((s) => `<div class="dk-field">
        <div class="dk-top"><span>${s.label}</span><b data-v="${s.key}">-</b></div>
        <input type="range" min="${s.min}" max="${s.max}" step="${s.step}" data-k="${s.key}" aria-label="${s.label}">
        ${s.key === 'monthlyBudget'
          ? '<div class="dk-budget"><div class="bar" data-k="budgetbar"><i style="width:0%"></i></div></div><small data-k="spent"></small>'
          : `<small>${s.help}</small>`}
      </div>`).join('')}
      <label class="dk-toggle">
        <input type="checkbox" data-k="predictiveMaintenance"><span class="sw"></span>
        <span class="lbl">Predictive maintenance<small>Order a spare when a WARN lasts 3 game-min, before the machine stops.</small></span>
      </label>
      <div class="dk-sec" data-k="storesTitle">TRUSTED STORES</div>
      <div class="dk-stores" data-k="stores"><div class="muted">No stores yet.</div></div>
    </div>`;
    this.el = Object.fromEntries([...root.querySelectorAll('[data-k]')].map((n) => [n.dataset.k, n]));

    for (const s of SLIDERS) {
      const input = this.el[s.key];
      const release = () => setTimeout(() => this.#release(s.key), 400);
      input.addEventListener('pointerdown', () => {
        this.busy.add(s.key);
        window.addEventListener('pointerup', release, { once: true });
      });
      input.addEventListener('input', () => {
        this.busy.add(s.key);
        this.#label(s.key, Number(input.value));
        this.#ruleText({ ...this.policy, [s.key]: Number(input.value) });
      });
      input.addEventListener('change', () => this.#save({ [s.key]: Number(input.value) }, s.key));
    }
    const pm = this.el.predictiveMaintenance;
    pm.addEventListener('change', () => this.#save({ predictiveMaintenance: pm.checked }, 'predictiveMaintenance'));
    this.el.stores.addEventListener('change', (e) => {
      if (!e.target.matches('input[type=checkbox]')) return;
      const allowed = [...this.el.stores.querySelectorAll('input[type=checkbox]')].filter((c) => c.checked).map((c) => c.value);
      this.#save({ allowedMerchants: allowed }, 'stores');
    });
  }

  setPolicy(policy) {
    if (!policy) return;
    this.policy = { ...policy };
    for (const m of policy.allowedMerchants || []) this.merchants.add(m);
    for (const s of SLIDERS) {
      if (this.busy.has(s.key)) continue;
      const v = Number(policy[s.key]);
      if (!Number.isFinite(v)) continue;
      this.el[s.key].value = String(v);
      this.#label(s.key, v);
    }
    if (!this.busy.has('predictiveMaintenance')) this.el.predictiveMaintenance.checked = Boolean(policy.predictiveMaintenance);
    this.#budget(policy);
    this.#ruleText(policy);
    this.#renderStores();
  }

  /** Stores seen in STATE.merchants, the catalog or a search. */
  addMerchants(names = []) {
    let changed = false;
    for (const n of names || []) {
      if (n && typeof n === 'string' && !this.merchants.has(n)) {
        this.merchants.add(n);
        changed = true;
      }
    }
    if (changed) this.#renderStores();
  }

  /** Mark a store as the reason an order was blocked (highlighted until trusted). */
  flagMerchant(name) {
    if (!name) return;
    this.merchants.add(name);
    this.flagged.add(name);
    this.storesSig = '';
    this.#renderStores();
  }

  /** Draw attention to the store list (OPEN DESK from an incident). */
  highlightStores() {
    const box = this.el.stores;
    box.classList.remove('dk-flash');
    void box.offsetWidth;
    box.classList.add('dk-flash');
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  reset() {
    this.flagged.clear();
    this.storesSig = '';
  }

  // ─── Internals ────────────────────────────────────────────────────────
  async #save(patch, key) {
    this.busy.add(key);
    try {
      const policy = await this.api('PUT', '/policy', patch);
      this.busy.delete(key);
      this.setPolicy(policy && typeof policy === 'object' && 'monthlyBudget' in policy ? policy : { ...this.policy, ...patch });
    } catch (err) {
      this.busy.delete(key);
      this.toast(`Could not save the rule: ${err.message}`, 'bad', 'ERROR');
      if (this.policy) this.setPolicy(this.policy);
    }
  }

  #release(key) {
    // The change event saves; if the value never changed, just stop guarding it.
    if (!this.el[key] || String(this.el[key].value) === String(this.policy?.[key])) {
      this.busy.delete(key);
      if (this.policy) this.setPolicy(this.policy);
    }
  }

  #label(key, v) {
    const s = SLIDERS.find((x) => x.key === key);
    const el = this.root.querySelector(`[data-v=${key}]`);
    if (s && el) el.textContent = s.fmt(v);
  }

  #budget(p) {
    const budget = Number(p.monthlyBudget) || 0;
    const spent = Number(p.spent) || 0;
    const remaining = p.remaining != null ? Number(p.remaining) : Math.max(0, budget - spent);
    const frac = budget > 0 ? Math.max(0, Math.min(1, remaining / budget)) : 0;
    const bar = this.el.budgetbar;
    bar.querySelector('i').style.width = `${(frac * 100).toFixed(1)}%`;
    bar.classList.toggle('low', frac < 0.3 && remaining > 0);
    bar.classList.toggle('out', remaining <= 0.005);
    this.el.spent.innerHTML = `${money(spent)} spent · <span class="${frac < 0.3 ? 'warntxt' : 'goodtxt'}">${money(remaining)} left</span> this month`;
  }

  #ruleText(p) {
    if (!p) return;
    this.el.rule.innerHTML = `Wrench-bot pays on its own when the order is at most <b>${money0(p.autoApproveLimit)}</b>,
      it is at least <b>${pct(p.confidenceThreshold)}</b> sure, the store is trusted and the budget covers it.
      Anything else comes to you.`;
  }

  #renderStores() {
    const allowed = new Set(this.policy?.allowedMerchants || []);
    const list = [...this.merchants].sort((a, b) => a.localeCompare(b));
    const sig = JSON.stringify([list, [...allowed].sort(), [...this.flagged]]);
    if (sig === this.storesSig || this.busy.has('stores')) return;
    this.storesSig = sig;
    for (const f of [...this.flagged]) if (allowed.has(f)) this.flagged.delete(f);
    this.el.storesTitle.textContent = `TRUSTED STORES · ${[...allowed].filter((m) => list.includes(m)).length}/${list.length}`;
    if (!list.length) {
      this.el.stores.innerHTML = '<div class="muted">No stores yet.</div>';
      return;
    }
    this.el.stores.innerHTML = list
      .map((m) => {
        const on = allowed.has(m);
        const flag = this.flagged.has(m) && !on;
        return `<label class="dk-store ${on ? '' : 'off'} ${flag ? 'flag' : ''}">
          <input type="checkbox" value="${esc(m)}" ${on ? 'checked' : ''}>
          <span>${esc(m)}</span>
          ${flag ? '<span class="chip bad">BLOCKED AN ORDER</span>' : on ? '<span class="chip good">TRUSTED</span>' : ''}
        </label>`;
      })
      .join('');
  }
}
