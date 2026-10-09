// Live spare-parts list: the best Reap listing for every part on every machine.
// Data comes from GET /api/state (catalog) and CATALOG_UPDATED events.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export class CatalogPanel {
  constructor(root, { api, toast } = {}) {
    this.root = root;
    this.api = api;
    this.toast = toast || (() => {});
    this.catalog = null;
    this.trusted = null;
    root.innerHTML = `<div class="catp">
      <div class="cat-head">
        <div><span class="chip" data-k="src">CATALOG</span> <small data-k="updated"></small></div>
        <button class="small ghost" data-k="refresh">REFRESH</button>
      </div>
      <div data-k="body"><div class="cat-loading">Loading the catalog…</div></div>
    </div>`;
    this.el = Object.fromEntries([...root.querySelectorAll('[data-k]')].map((n) => [n.dataset.k, n]));
    this.el.refresh.addEventListener('click', () => this.#refresh());
  }

  setTrusted(list) {
    this.trusted = Array.isArray(list) ? list : null;
    if (this.catalog) this.setCatalog(this.catalog);
  }

  /** Merchant names that appear as a best listing. */
  merchants() {
    const out = new Set();
    for (const m of this.catalog?.machines || []) for (const c of m.components || []) if (c.best?.merchant) out.add(c.best.merchant);
    return [...out];
  }

  setCatalog(cat) {
    if (!cat || !Array.isArray(cat.machines)) return;
    this.catalog = cat;
    const rows = cat.machines.flatMap((m) => m.components || []);
    const sources = rows.map((c) => c.source).filter(Boolean);
    const live = sources.filter((s) => s === 'live').length;
    const src = this.el.src;
    if (!sources.length) {
      src.textContent = 'CATALOG';
      src.className = 'chip';
    } else if (live >= sources.length / 2) {
      src.textContent = 'LIVE REAP';
      src.className = 'chip good';
    } else {
      src.textContent = 'OFFLINE CACHE';
      src.className = 'chip warn';
    }
    src.title = `${live}/${sources.length} parts priced from live Reap search`;
    const at = cat.updatedAt ? new Date(cat.updatedAt) : null;
    this.el.updated.textContent = cat.warming ? 'refreshing…' : at && !Number.isNaN(at.getTime()) ? `prices as of ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}` : '';
    this.el.refresh.disabled = Boolean(cat.warming);

    const trusted = this.trusted;
    this.el.body.innerHTML =
      (cat.warming ? '<div class="cat-loading">Refreshing prices from Reap…</div>' : '') +
      cat.machines
        .map(
          (m) => `<div class="cat-machine">${esc(m.name)}</div>` +
            (m.components || [])
              .map((c) => {
                const b = c.best;
                const untrusted = b && trusted && !trusted.includes(b.merchant);
                const sub = b
                  ? `${esc(b.merchant)}${untrusted ? ' <span class="untrusted">(not trusted)</span>' : ''} · ${Number(c.optionCount) || 1} option${Number(c.optionCount) === 1 ? '' : 's'}`
                  : c.status === 'none' ? 'no listing found' : 'searching…';
                return `<div class="cat-row ${esc(c.status || 'pending')}" title="${esc(b?.name || c.name)}">
                  ${b?.image ? `<img src="${esc(b.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('i'),{className:'noimg'}))">` : '<i class="noimg"></i>'}
                  <div class="grow"><div class="nm">${esc(c.name)}${Number(c.qty) > 1 ? ` ×${Number(c.qty)}` : ''}</div><small>${sub}</small></div>
                  ${b ? `<span class="price">${money(b.price)}</span>` : ''}
                </div>`;
              })
              .join(''),
        )
        .join('');
  }

  async #refresh() {
    this.el.refresh.disabled = true;
    try {
      await this.api('POST', '/catalog/refresh');
      this.toast('Refreshing prices from Reap…', 'info', 'CATALOG');
    } catch (err) {
      this.el.refresh.disabled = false;
      this.toast(`Refresh failed: ${err.message}`, 'bad', 'ERROR');
    }
  }
}
