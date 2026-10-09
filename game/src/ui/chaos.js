// Chaos: break a part on purpose. This only changes the simulation; the agent
// still has to notice the failure from signals and the plant log.

import { MACHINES } from '../../../shared/contract.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (v, digits = 1) => (Number.isFinite(Number(v)) ? Number(v).toFixed(digits) : '-');

const STATUS_CHIP = { ok: ['good', 'OK'], warn: ['warn', 'WARN'], fault: ['bad', 'FAULT'] };

export class Chaos {
  constructor(root, { api, machines = MACHINES, toast } = {}) {
    this.root = root;
    this.api = api;
    this.machines = machines;
    this.toast = toast || (() => {});
    this.sim = null;
    this.cooldown = false;
    this.mode = 'sudden';

    root.innerHTML = `<div class="cz">
      <div class="cz-row"><span>MACHINE</span>
        <select data-k="machine" aria-label="Machine">${machines.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select>
      </div>
      <div class="cz-row"><span>PART</span>
        <div class="cz-part"><select data-k="part" aria-label="Part"></select><span class="chip" data-k="pstatus">-</span></div>
        <div class="cz-signals" data-k="signals"></div>
      </div>
      <div class="cz-row"><span>FAILURE</span>
        <div class="cz-modes" data-k="modes">
          <label class="on"><input type="radio" name="cz-mode" value="sudden" checked><b>SUDDEN</b>Dies now. The machine stops.</label>
          <label><input type="radio" name="cz-mode" value="gradual"><b>GRADUAL</b>Wears out over 12 min. WARN lines first.</label>
        </div>
      </div>
      <button class="cz-break" data-k="break">BREAK IT</button>
      <div class="cz-note" data-k="note"></div>
    </div>`;
    this.el = Object.fromEntries([...root.querySelectorAll('[data-k]')].map((n) => [n.dataset.k, n]));

    this.el.machine.addEventListener('change', () => this.#fillParts());
    this.el.part.addEventListener('change', () => this.#refresh());
    this.el.modes.addEventListener('change', (e) => {
      if (e.target.name !== 'cz-mode') return;
      this.mode = e.target.value;
      for (const l of this.el.modes.querySelectorAll('label')) l.classList.toggle('on', l.querySelector('input').checked);
      this.#refresh();
    });
    this.el.break.addEventListener('click', () => this.#break());
    this.#fillParts();
  }

  updateSim(sim) {
    if (!sim) return;
    this.sim = sim;
    this.#refresh();
  }

  #fillParts() {
    const m = this.machines.find((x) => x.id === this.el.machine.value) || this.machines[0];
    this.el.part.innerHTML = (m?.components || []).map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    this.#refresh();
  }

  #selected() {
    const m = this.machines.find((x) => x.id === this.el.machine.value);
    const c = m?.components.find((x) => x.id === this.el.part.value);
    return { m, c };
  }

  #refresh() {
    const { m, c } = this.#selected();
    if (!m || !c) return;
    const live = this.sim?.machines?.[m.id]?.components?.[c.id];
    const status = live?.status || 'ok';
    const [cls, label] = STATUS_CHIP[status] || ['', status.toUpperCase()];
    this.el.pstatus.className = `chip ${this.sim ? cls : ''}`;
    this.el.pstatus.textContent = this.sim ? label : '-';

    const sig = (c.signals || [])
      .map((s) => {
        const v = live?.readings?.[s.key];
        return `${esc(s.label)} <b>${v == null ? '-' : fmt(v, s.digits)}</b> ${esc(s.unit)} <span class="muted">(fail ${fmt(s.fail, s.digits)})</span>`;
      })
      .join('<br>');
    const effects = (c.effects || [])
      .map((e) => m.components.find((x) => x.id === e.target)?.name)
      .filter(Boolean);
    this.el.signals.innerHTML = `${sig}${effects.length ? `<br><span class="warntxt">Also drags down: ${esc([...new Set(effects)].join(', '))}</span>` : ''}`;

    const dead = status === 'fault';
    const busy = this.cooldown;
    this.el.break.disabled = dead || busy;
    this.el.break.textContent = dead ? 'ALREADY FAILED' : busy ? 'BREAKING…' : this.mode === 'gradual' ? `WEAR OUT ${c.name.toUpperCase()}` : `BREAK ${c.name.toUpperCase()}`;
    this.el.note.textContent = this.mode === 'gradual'
      ? `Code ${c.code}. Click the machine to watch its signals drift; with predictive maintenance on, Wrench-bot can order the spare before the ${m.name} stops.`
      : `Code ${c.code}: "${c.fault}". The ${m.name} stops (-$${m.downtimeCostPerMin}/min) until the part is replaced.`;
  }

  async #break() {
    const { m, c } = this.#selected();
    if (!m || !c || this.cooldown) return;
    this.cooldown = true;
    this.#refresh();
    try {
      await this.api('POST', '/sim/fault', { machineId: m.id, componentId: c.id, mode: this.mode });
      this.toast(
        this.mode === 'gradual' ? `${m.name}: the ${c.name} starts wearing out.` : `${m.name}: the ${c.name} just failed.`,
        this.mode === 'gradual' ? 'warn' : 'bad',
        'CHAOS',
      );
    } catch (err) {
      // 409 { error: 'One failure at a time: …', code: 'BUSY' } while a failure is in progress.
      const msg = String(err?.message || err || 'unknown error');
      if (err?.code === 'BUSY' || err?.status === 409 || /one failure at a time/i.test(msg)) this.toast(msg, 'warn', 'BUSY');
      else this.toast(`Chaos failed: ${msg}`, 'bad', 'ERROR');
    } finally {
      setTimeout(() => {
        this.cooldown = false;
        this.#refresh();
      }, 1200);
    }
  }
}
