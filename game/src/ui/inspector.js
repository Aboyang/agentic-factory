// Machine popover content: one machine at a time. A row per part with its most
// abnormal reading; click a row to expand it in place into every signal with a
// threshold bar and a sparkline. This is the same data the decision model gets
// (signals + log), never the hidden part health.
// update() runs every tick for every machine (history keeps accumulating while
// the popover is closed); it only touches text, styles and canvases.

import './ui-shell.css';
import { MACHINES } from '../../../shared/contract.js';
import { usd } from './hud.js';

const HIST = 90; // samples kept per signal (one per tick)
const OVER = 1.15; // gauges show up to 15% past the fail threshold (engine caps there)

const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};
const esc = (s = '') => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const short = (x, digits) => String(Number(Number(x).toFixed(digits)));

// Signal maths, same definitions as the engine (SIM_SPEC §2).
const span = (s) => s.fail - s.nominal || 1e-9;
const fracOf = (s, v) => (v - s.nominal) / span(s);
const warnFrac = (s) => (s.warn - s.nominal) / span(s);
const statusOf = (s, v) => {
  const f = fracOf(s, v);
  return f >= 0.97 ? 'fault' : f >= warnFrac(s) ? 'warn' : 'ok';
};
const SEV = { ok: 0, warn: 1, fault: 2 };
const SEV_NAME = ['ok', 'warn', 'fault'];

const CHIP = {
  running: { text: 'Running', cls: 'is-running' },
  degraded: { text: 'Degraded', cls: 'is-degraded' },
  down: { text: 'Down', cls: 'is-down' },
  maintenance: { text: 'In repair', cls: 'is-maint' },
  none: { text: 'No data', cls: 'is-none' },
};
const PART_TEXT = { ok: 'OK', warn: 'Warning', fault: 'Fault' };
const COLORS = { ok: '#a3be8c', warn: '#ebcb8b', fault: '#e07c86' };

function machineState(m) {
  if (!m) return 'none';
  if (m.status === 'down') return 'down';
  if (m.status === 'maintenance') return 'maintenance';
  return m.degraded ? 'degraded' : 'running';
}
export const warnCode = (code = '') => code.replace(/^E/, 'W');

const STATE_CLASSES = ['is-running', 'is-degraded', 'is-down', 'is-maint', 'is-none', 'is-ok', 'is-warn', 'is-fault'];
function setClass(node, cls) {
  if (node.dataset.cls === cls) return;
  node.classList.remove(...STATE_CLASSES);
  if (cls) node.classList.add(cls);
  node.dataset.cls = cls;
}
const setText = (node, text) => {
  if (node.textContent !== text) node.textContent = text;
};

export class Inspector {
  /**
   * @param root          container (the popover body)
   * @param opts.machines MACHINES (signals with thresholds)
   * @param opts.onClose  ✕ clicked
   */
  constructor(root, { machines, onClose } = {}) {
    this.root = root;
    this.defs = Array.isArray(machines) && machines.length ? machines : MACHINES;
    this.byId = new Map(this.defs.map((m) => [m.id, m]));
    this.onClose = onClose;
    this.sim = null;
    this.lastT = null;
    this.presetId = undefined;
    this.hist = new Map(); // machineId → { ts: [t], vals: Map('part/key' → [value]) }
    this.since = new Map(); // 'machine/part' → { status, t } when the part entered its status
    this.expanded = new Map(); // machineId → Set(partId) the user opened
    this.selected = null;
    this.detail = null;
    this.visible = false;

    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-a=close]')) return this.onClose?.();
      const row = e.target.closest('[data-part]');
      if (row) this.#toggle(row.dataset.part);
    });
  }

  /** Called every tick with the sim snapshot. */
  update(sim) {
    if (!sim || typeof sim !== 'object' || !sim.machines) return;
    const t = num(sim.t);
    const presetId = sim.preset?.id;
    if (this.lastT != null && (t < this.lastT || presetId !== this.presetId)) this.reset();
    this.presetId = presetId;
    this.lastT = t;
    this.sim = sim;
    for (const def of this.defs) {
      const m = sim.machines[def.id];
      if (!m) continue;
      const h = this.#hist(def.id);
      if (!h.ts.length || t > h.ts[h.ts.length - 1]) this.#push(h, def, t, (cid, key) => m.components?.[cid]?.readings?.[key]);
      this.#trackSince(def, m, t);
    }
    if (this.visible) this.#render();
  }

  /** Show one machine (popover opened on it). Problem parts start expanded the first time. */
  select(machineId) {
    const def = this.byId.get(machineId);
    if (!def) return;
    if (!this.expanded.has(def.id)) {
      const m = this.sim?.machines?.[def.id];
      const worst = def.components
        .map((c) => ({ id: c.id, sev: SEV[m?.components?.[c.id]?.status] ?? 0 }))
        .sort((a, b) => b.sev - a.sev)[0];
      this.expanded.set(def.id, new Set(worst && worst.sev > 0 ? [worst.id] : []));
    }
    if (this.selected !== def.id || !this.detail) {
      this.selected = def.id;
      this.#build(def);
    }
    this.#render(true);
    this.root.scrollTop = 0;
  }

  /** The popover was shown / hidden: skip rendering while nobody looks. */
  setVisible(on) {
    this.visible = Boolean(on);
    if (this.visible && this.detail) requestAnimationFrame(() => this.#render(true));
  }

  /** Seed one machine's history from GET /api/sim/history/:id ([{ t, readings }], oldest first). */
  loadHistory(machineId, history) {
    const def = this.byId.get(machineId);
    if (!def || !Array.isArray(history)) return;
    const old = this.hist.get(machineId);
    const fresh = { ts: [], vals: new Map() };
    const samples = history.filter((s) => s && isNum(Number(s.t))).sort((a, b) => a.t - b.t);
    if (this.lastT != null) {
      // Ignore samples from a previous shift (history fetched before a preset reload).
      while (samples.length && Number(samples[samples.length - 1].t) > this.lastT) samples.pop();
    }
    for (const s of samples) this.#push(fresh, def, Number(s.t), (cid, key) => s.readings?.[cid]?.[key]);
    // Keep local samples newer than the server's history.
    const lastT = fresh.ts.length ? fresh.ts[fresh.ts.length - 1] : -Infinity;
    if (old) {
      old.ts.forEach((t, i) => {
        if (t > lastT) this.#push(fresh, def, t, (cid, key) => old.vals.get(`${cid}/${key}`)?.[i]);
      });
    }
    this.hist.set(machineId, fresh);
    if (this.selected === machineId && this.visible) this.#render(true);
  }

  /** Forget history (new shift). Called automatically when the clock goes back or the preset changes. */
  reset() {
    this.hist.clear();
    this.since.clear();
    this.expanded.clear();
    this.lastT = null;
    if (this.detail && this.visible) this.#render(true);
  }

  // ─── History ──────────────────────────────────────────────────────────
  #hist(id) {
    let h = this.hist.get(id);
    if (!h) this.hist.set(id, (h = { ts: [], vals: new Map() }));
    return h;
  }

  #push(h, def, t, get) {
    h.ts.push(t);
    if (h.ts.length > HIST) h.ts.shift();
    for (const c of def.components) {
      for (const s of c.signals) {
        const k = `${c.id}/${s.key}`;
        let arr = h.vals.get(k);
        if (!arr) h.vals.set(k, (arr = []));
        const v = get(c.id, s.key);
        arr.push(isNum(v) ? v : NaN);
        while (arr.length > h.ts.length) arr.shift();
      }
    }
  }

  #trackSince(def, m, t) {
    for (const c of def.components) {
      const st = m.components?.[c.id]?.status || 'ok';
      const k = `${def.id}/${c.id}`;
      const prev = this.since.get(k);
      if (!prev || prev.status !== st) this.since.set(k, { status: st, t });
    }
  }

  #toggle(partId) {
    const d = this.detail;
    if (!d) return;
    const set = this.expanded.get(d.def.id) || new Set();
    if (set.has(partId)) set.delete(partId);
    else set.add(partId);
    this.expanded.set(d.def.id, set);
    this.#render(true);
  }

  // ─── Build ────────────────────────────────────────────────────────────
  #build(def) {
    this.root.textContent = '';
    const node = el(`<section class="mp" aria-label="${esc(def.name)}">
      <header class="mp-head">
        <div class="mp-titles">
          <h2 class="mp-name">${esc(def.name)}</h2>
          <div class="mp-tags">
            <span class="mp-chip" data-k="chip">—</span>
            ${def.critical ? '<span class="mp-tag" title="Critical machine: Wrench-bot pays for express shipping">Critical</span>' : ''}
            <span class="mp-cost" data-k="cost" title="Every minute this machine is stopped costs ${usd(def.downtimeCostPerMin)}">${usd(def.downtimeCostPerMin)}/min when stopped</span>
          </div>
        </div>
        <button class="pop-x" data-a="close" aria-label="Close" title="Close (Esc)">✕</button>
      </header>
      <div class="mp-alarms" data-k="alarms"></div>
      <p class="mp-caption">Live sensor data — this is what Wrench-bot reads.</p>
      <div class="mp-parts"></div>
    </section>`);
    const partsEl = node.querySelector('.mp-parts');
    const d = { def, node, chip: node.querySelector('[data-k=chip]'), cost: node.querySelector('[data-k=cost]'), alarms: node.querySelector('[data-k=alarms]'), alarmsKey: null, parts: [] };

    def.components.forEach((c, index) => {
      const targets = this.#effectTargets(def, c);
      const pEl = el(`<div class="mp-part" data-c="${esc(c.id)}">
        <button class="mp-prow" data-part="${esc(c.id)}" aria-expanded="false" title="Show every sensor of the ${esc(c.name)}">
          <i class="mp-dot" aria-hidden="true"></i>
          <span class="mp-pname">${esc(c.name)}</span>
          <span class="mp-pread" data-k="read">—</span>
          <i class="mp-chev" aria-hidden="true"></i>
        </button>
        <div class="mp-pbody" hidden>
          <div class="mp-pmeta">
            <span class="mp-pstate" data-k="pstate">OK</span>
            <span class="mp-pcode" title="Fault code: ${esc(c.fault)}">${esc(c.code)} · ${esc(c.fault)}</span>
          </div>
          ${targets.length ? `<div class="mp-upstream" title="When this part degrades, these readings drift too: ${esc(targets.map((x) => `${x.part} ${x.label.toLowerCase()}`).join(', '))}">Also drags down: ${esc([...new Set(targets.map((x) => x.part))].join(', '))}</div>` : ''}
        </div>
      </div>`);
      const body = pEl.querySelector('.mp-pbody');
      const p = {
        def: c,
        index,
        el: pEl,
        row: pEl.querySelector('.mp-prow'),
        body,
        read: pEl.querySelector('[data-k=read]'),
        pstate: pEl.querySelector('[data-k=pstate]'),
        open: false,
        sigs: [],
      };
      for (const s of c.signals) {
        const falling = s.fail < s.nominal;
        const wf = clamp(warnFrac(s), 0, 1);
        const zOk = (wf / OVER) * 100;
        const zWarn = ((1 - wf) / OVER) * 100;
        const zFail = 100 - zOk - zWarn;
        const u = s.unit ? ` ${s.unit}` : '';
        const sEl = el(`<div class="mp-sig">
          <div class="mp-sline">
            <span class="mp-slabel">${esc(s.label)}</span>
            <span class="mp-sval"><b data-k="v">—</b> ${esc(s.unit)}</span>
          </div>
          <div class="mp-gauge" title="Nominal ${short(s.nominal, s.digits)}${u}. Warns ${falling ? 'below' : 'above'} ${short(s.warn, s.digits)}${u}, faults at ${short(s.fail, s.digits)}${u}.">
            <i class="mp-z is-ok" style="width:${zOk.toFixed(2)}%"></i><i class="mp-z is-warn" style="width:${zWarn.toFixed(2)}%"></i><i class="mp-z is-fail" style="width:${zFail.toFixed(2)}%"></i>
            <i class="mp-fill" data-k="fill"></i>
            <b class="mp-mark" data-k="mark"></b>
          </div>
          <div class="mp-sthr"><span>${falling ? 'lower is worse' : 'higher is worse'}</span><span>nominal ${short(s.nominal, s.digits)}</span><span class="is-warn">warn ${short(s.warn, s.digits)}</span><span class="is-fail">fail ${short(s.fail, s.digits)}${u}</span></div>
          <canvas class="mp-spark" height="34" aria-hidden="true"></canvas>
        </div>`);
        p.sigs.push({
          def: s,
          el: sEl,
          v: sEl.querySelector('[data-k=v]'),
          fill: sEl.querySelector('[data-k=fill]'),
          mark: sEl.querySelector('[data-k=mark]'),
          canvas: sEl.querySelector('canvas'),
          drawn: null,
        });
        body.append(sEl);
      }
      partsEl.append(pEl);
      d.parts.push(p);
    });
    this.root.append(node);
    this.detail = d;
  }

  // Parts whose readings this part pushes toward fail (contract `effects`).
  #effectTargets(def, c) {
    return (c.effects || [])
      .map((e) => {
        const tp = def.components.find((x) => x.id === e.target);
        const sig = tp?.signals.find((x) => x.key === e.signal);
        return tp && sig ? { part: tp.name, label: sig.label } : null;
      })
      .filter(Boolean);
  }

  // ─── Render ───────────────────────────────────────────────────────────
  #render(force = false) {
    const d = this.detail;
    if (!d) return;
    const def = d.def;
    const m = this.sim?.machines?.[def.id];
    const state = machineState(m);
    setText(d.chip, CHIP[state].text);
    setClass(d.chip, CHIP[state].cls);
    setClass(d.node, CHIP[state].cls);
    d.cost.classList.toggle('is-bleeding', state === 'down' || state === 'maintenance');
    this.#renderAlarms(d, m, state);

    const h = this.hist.get(def.id);
    const t = this.lastT ?? 0;
    const open = this.expanded.get(def.id) || new Set();

    for (const p of d.parts) {
      const comp = m?.components?.[p.def.id];
      const pst = comp?.status && SEV[comp.status] != null ? comp.status : m ? 'ok' : null;
      setClass(p.el, pst ? `is-${pst}` : '');
      // Problem parts float to the top (fault, then warn), contract order otherwise.
      const order = String((2 - (SEV[pst] ?? 0)) * 100 + p.index);
      if (p.el.style.order !== order) p.el.style.order = order;

      const isOpen = open.has(p.def.id);
      if (isOpen !== p.open) {
        p.open = isOpen;
        p.body.hidden = !isOpen;
        p.el.classList.toggle('is-open', isOpen);
        p.row.setAttribute('aria-expanded', String(isOpen));
      }

      // Each signal's status from its value, made consistent with the part's status:
      // the worst signal shows the part's status, none shows worse.
      const vals = p.sigs.map((s) => comp?.readings?.[s.def.key]);
      let worstI = -1;
      let worstF = -Infinity;
      vals.forEach((v, i) => {
        if (!isNum(v)) return;
        const f = fracOf(p.sigs[i].def, v);
        if (f > worstF) {
          worstF = f;
          worstI = i;
        }
      });
      const ws = p.sigs[worstI]?.def;
      setText(p.read, ws ? `${ws.label} ${vals[worstI].toFixed(ws.digits)}${ws.unit ? ` ${ws.unit}` : ''}` : '—');

      const since = this.since.get(`${def.id}/${p.def.id}`);
      const mins = since && pst && pst !== 'ok' ? Math.max(0, Math.round(t - since.t)) : null;
      setText(p.pstate, pst ? `${PART_TEXT[pst]}${mins != null ? ` for ${mins} min` : ''}` : '—');
      setClass(p.pstate, pst ? `is-${pst}` : '');
      if (!isOpen) continue;

      p.sigs.forEach((s, i) => {
        const v = vals[i];
        const sd = s.def;
        let st = 'ok';
        if (isNum(v)) {
          let sev = SEV[statusOf(sd, v)];
          if (pst) {
            sev = Math.min(sev, SEV[pst]);
            if (i === worstI) sev = SEV[pst];
          }
          st = SEV_NAME[sev];
          setText(s.v, v.toFixed(sd.digits));
          const pos = `${((clamp(fracOf(sd, v), 0, OVER) / OVER) * 100).toFixed(1)}%`;
          if (s.mark.style.left !== pos) {
            s.mark.style.left = pos;
            s.fill.style.width = pos;
          }
        } else {
          setText(s.v, '—');
          s.mark.style.left = '0%';
          s.fill.style.width = '0%';
        }
        setClass(s.el, `is-${st}`);
        this.#spark(s, h, p.def, st, force);
      });
    }
  }

  #renderAlarms(d, m, state) {
    const lines = [];
    if (!m) lines.push(['is-none', '', 'Waiting for sensor data…']);
    else {
      if (state === 'maintenance') lines.push(['is-maint', 'REPAIR', 'Planned stop: a technician is replacing a part']);
      for (const code of m.activeCodes || []) {
        const part = d.def.components.find((c) => c.code === code);
        lines.push(['is-fault', code, part ? `${part.fault} · ${part.name}` : 'Fault']);
      }
      for (const c of d.def.components) {
        if (m.components?.[c.id]?.status !== 'warn') continue;
        const since = this.since.get(`${d.def.id}/${c.id}`);
        const mins = since ? Math.max(0, Math.round((this.lastT ?? 0) - since.t)) : 0;
        lines.push(['is-warn', warnCode(c.code), `${c.name} drifting for ${mins} min`]);
      }
    }
    const key = lines.map((l) => l.join('|')).join('\n');
    if (key === d.alarmsKey) return;
    d.alarmsKey = key;
    d.alarms.hidden = !lines.length;
    d.alarms.innerHTML = lines
      .map(([cls, code, text]) => `<div class="mp-alarm ${cls}">${code ? `<b>${esc(code)}</b>` : ''}<span>${esc(text)}</span></div>`)
      .join('');
  }

  // Smooth sparkline: last HIST samples, right-aligned, real values (falling signals fall),
  // dotted warn / fail guides.
  #spark(s, h, part, status, force) {
    const cv = s.canvas;
    const cssW = Math.round(cv.clientWidth);
    if (!cssW) return; // not laid out yet
    const arr = h?.vals.get(`${part.id}/${s.def.key}`) || [];
    const lastT = h?.ts.length ? h.ts[h.ts.length - 1] : null;
    const sig = `${arr.length}|${lastT}|${status}|${cssW}`;
    if (!force && s.drawn === sig) return;
    s.drawn = sig;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssH = 34;
    if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) {
      cv.width = Math.round(cssW * dpr);
      cv.height = Math.round(cssH * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const sd = s.def;
    const lo = Math.min(sd.nominal, sd.fail);
    const hi = Math.max(sd.nominal, sd.fail);
    const pad = (hi - lo) * 0.12;
    const y0 = lo - pad;
    const yr = hi - lo + 2 * pad || 1;
    const top = 3;
    const H = cssH - 6;
    const y = (v) => top + (1 - (clamp(v, y0, y0 + yr) - y0) / yr) * H;

    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(235,203,139,0.45)';
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y(sd.warn)) + 0.5);
    ctx.lineTo(cssW, Math.round(y(sd.warn)) + 0.5);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(224,124,134,0.6)';
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y(sd.fail)) + 0.5);
    ctx.lineTo(cssW, Math.round(y(sd.fail)) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    if (!arr.length) return;
    const step = cssW / (HIST - 1);
    const x0 = cssW - (arr.length - 1) * step;
    const color = COLORS[status] || COLORS.ok;
    const yn = y(sd.nominal);
    // Area between the nominal line and the trace, then the trace.
    let started = false;
    let lastX = 0;
    let lastY = 0;
    ctx.beginPath();
    for (let i = 0; i < arr.length; i++) {
      if (!isNum(arr[i])) continue;
      const xx = x0 + i * step;
      const yy = y(arr[i]);
      if (!started) {
        ctx.moveTo(xx, yn);
        ctx.lineTo(xx, yy);
        started = true;
      } else ctx.lineTo(xx, yy);
      lastX = xx;
      lastY = yy;
    }
    if (!started) return;
    ctx.lineTo(lastX, yn);
    ctx.closePath();
    ctx.fillStyle = `${color}26`;
    ctx.fill();

    ctx.beginPath();
    started = false;
    for (let i = 0; i < arr.length; i++) {
      if (!isNum(arr[i])) {
        started = false;
        continue;
      }
      const xx = x0 + i * step;
      const yy = y(arr[i]);
      if (!started) ctx.moveTo(xx, yy);
      else ctx.lineTo(xx, yy);
      started = true;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.fillStyle = '#eceff4';
    ctx.beginPath();
    ctx.arc(lastX, lastY, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
}
