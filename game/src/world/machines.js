// Low-poly machine models with a stack light (andon tower) each. No real
// lights (point lights are expensive per pixel): lamps are self-lit, with a
// glow sprite and a soft floor ring for down / degraded / maintenance.
// Visual states (SIM_SPEC §7):
//   running      animated, green lamp (process motion follows the belt)
//   degraded     amber lamp, occasional grey smoke, machine-specific wobble
//   down         red blinking lamp, animation frozen, sparks, shake
//   maintenance  blue lamp, still
// Process motion (arm pick-and-place, press, diverter) is synced to the belt
// phase so it lines up with the blanks passing through.

import * as THREE from 'three';
import { C, LAMP, matSet, box, boxC, cyl, cylGeo, boxGeo, glowMat, softGlowTexture, ringGlowTexture, clamp, smooth, lerp } from './palette.js';

export const TOWER_TOP = 4.15;
const SEGMENTS = ['green', 'amber', 'red', 'blue']; // bottom → top
const DIM = { green: '#24332a', amber: '#3b3426', red: '#3b272b', blue: '#242f40' };
const hitMat = new THREE.MeshBasicMaterial({ visible: false });
const HIT = { w: 3.7, h: 4.7, d: 3.8 }; // generous invisible click target
const HOVER = new THREE.Color(0.13, 0.18, 0.26);
const BLACK = new THREE.Color(0, 0, 0);
const tmpV = new THREE.Vector3();

const ALIASES = { running: 'running', down: 'down', maintenance: 'maintenance', ok: 'running', broken: 'down', repairing: 'maintenance' };
export const normStatus = (s) => ALIASES[s] || null;

export class MachineView {
  constructor(def, fx, line) {
    this.def = def;
    this.id = def.id;
    this.fx = fx;
    this.line = line;
    this.x = Number(def.pos?.[0]) || 0;
    this.z = Number(def.pos?.[1]) || 0;
    this.group = new THREE.Group();
    this.group.position.set(this.x, 0, this.z);
    this.group.name = `machine:${def.id}`;
    this.mats = matSet();
    box(this.group, 2.9, 0.06, 3.1, this.mats('#2c3341'), 0, 0, 0, false, true); // plinth
    this.spec = (BUILDERS[def.id] || generic)(this.group, this.mats, this);
    this.#tower(this.spec.tower);
    // soft ring on the floor: red when down, amber when degraded, blue in maintenance
    this.halo = new THREE.Mesh(new THREE.PlaneGeometry(6.2, 6.2), new THREE.MeshBasicMaterial({ map: ringGlowTexture(), color: LAMP.red, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }));
    this.halo.rotation.x = -Math.PI / 2;
    this.halo.position.y = 0.075;
    this.halo.renderOrder = 1;
    this.halo.visible = false;
    this.group.add(this.halo);
    this.hit = new THREE.Mesh(boxGeo(HIT.w, HIT.h, HIT.d), hitMat);
    this.hit.position.y = HIT.h / 2;
    this.hit.userData.machineId = def.id;
    this.group.add(this.hit);

    this.status = 'running';
    this.degraded = false;
    this.seen = false; // first status from the server: no fanfare
    this.T = Math.random() * 10; // local animation clock (frozen when stopped)
    this.idle = 0; // 0 = processing, 1 = starved (line stopped)
    this.sparkT = 0;
    this.smokeT = 1 + Math.random() * 2;
    this.sootT = 0.5;
    this.seed = Math.random() * 10;
    this.ctx = { T: 0, t: 0, dt: 0, idle: 0, degraded: false, line, mx: this.x };
    this.#lamp(0);
  }

  #tower([tx, tz]) {
    const g = this.group;
    const m = this.mats;
    cyl(g, 0.06, 2.6, m(C.n3), tx, 1.3, tz, 'y', 8);
    cyl(g, 0.2, 0.08, m(C.n1), tx, 2.64, tz, 'y', 10);
    this.lamps = {};
    this.lampColors = {};
    this.lampY = {};
    let y = 2.68;
    for (const key of SEGMENTS) {
      const mat = glowMat(DIM[key]);
      const lamp = cyl(g, 0.25, 0.3, mat, tx, y + 0.18, tz, 'y', 10);
      lamp.castShadow = false;
      cyl(g, 0.27, 0.04, m(C.n0), tx, y + 0.01, tz, 'y', 10).castShadow = false;
      this.lamps[key] = mat;
      this.lampY[key] = y + 0.18;
      this.lampMesh = this.lampMesh || {};
      this.lampMesh[key] = lamp;
      this.lampColors[key] = { on: new THREE.Color(LAMP[key]), off: new THREE.Color(DIM[key]) };
      y += 0.35;
    }
    cyl(g, 0.27, 0.07, m(C.n0), tx, y + 0.02, tz, 'y', 10);
    this.towerXZ = [tx, tz];
    // halo around the lit lamp (cheap stand-in for bloom)
    this.flare = new THREE.Sprite(new THREE.SpriteMaterial({ map: softGlowTexture(), color: LAMP.green, transparent: true, depthWrite: false, toneMapped: false }));
    this.flare.scale.setScalar(1.8);
    this.flare.position.set(tx, this.lampY.green, tz);
    this.flare.renderOrder = 2;
    g.add(this.flare);
  }

  setStatus(status, degraded) {
    const s = normStatus(status);
    if (!s) return;
    const d = s === 'running' && !!degraded;
    if (s === this.status && d === this.degraded) {
      this.seen = true;
      return;
    }
    const prev = this.status;
    this.status = s;
    this.degraded = d;
    if (s !== 'running') this.spec.freeze?.(s);
    if (!this.seen) {
      this.seen = true;
      return;
    }
    const top = this.group.position;
    if (s === 'down' && prev !== 'down') {
      this.spec.sparkPoint(tmpV);
      this.fx.burst('spark', tmpV.x, tmpV.y, tmpV.z, 16, { speed: 1.3 });
      this.fx.burst('soot', tmpV.x, tmpV.y + 0.2, tmpV.z, 3);
      this.fx.ring(top.x, top.z, LAMP.red, { from: 0.5, to: 2.6, dur: 0.6 });
      this.sparkT = 0.3;
    } else if (s === 'running' && prev !== 'running') {
      this.fx.ring(top.x, top.z, LAMP.green, { from: 0.6, to: 2.8, dur: 0.8 });
      this.fx.burst('twinkle', top.x, 2.4, top.z, 8);
    } else if (s === 'maintenance' && prev !== 'maintenance') {
      this.fx.ring(top.x, top.z, LAMP.blue, { from: 0.6, to: 2.4, dur: 0.7 });
    } else if (d && s === 'running') {
      this.smokeT = 0.2;
    }
  }

  setHover(on) {
    for (const mat of this.mats.all()) mat.emissive.copy(on ? HOVER : BLACK);
  }

  #lamp(t) {
    const s = this.status;
    let lit = 'green';
    let on = true;
    let halo = 0;
    let flare = 0.45;
    if (s === 'down') {
      lit = 'red';
      on = (t * 2.2) % 1 < 0.55;
      halo = on ? 1 : 0.5;
      flare = on ? 1 : 0.12;
    } else if (s === 'maintenance') {
      lit = 'blue';
      halo = 0.55 + Math.sin(t * 2) * 0.08;
      flare = 0.8;
    } else if (this.degraded) {
      lit = 'amber';
      halo = 0.68 + Math.sin(t * 3) * 0.14;
      flare = 0.8 + Math.sin(t * 3) * 0.15;
    }
    this.halo.visible = halo > 0;
    if (halo > 0) {
      this.halo.material.color.copy(this.lampColors[lit].on);
      this.halo.material.opacity = halo;
    }
    for (const key of SEGMENTS) {
      const hot = key === lit && on;
      this.lamps[key].color.copy(hot ? this.lampColors[key].on : this.lampColors[key].off);
      this.lampMesh[key].scale.set(hot ? 1.1 : 1, 1, hot ? 1.1 : 1);
    }
    this.flare.material.color.copy(this.lampColors[lit].on);
    this.flare.material.opacity = flare;
    this.flare.position.y = this.lampY[lit];
    this.flare.scale.setScalar(s === 'down' ? 2.3 : s === 'running' && !this.degraded ? 1.4 : 1.9);
  }

  update(dt, t) {
    const s = this.status;
    const running = s === 'running';
    if (running) this.T += dt * (this.degraded ? 0.85 : 1);
    const flowing = running && this.line.moving;
    this.idle += ((flowing ? 0 : 1) - this.idle) * Math.min(1, dt * 3);
    if (running) {
      const c = this.ctx;
      c.T = this.T;
      c.t = t;
      c.dt = dt;
      c.idle = this.idle;
      c.degraded = this.degraded;
      this.spec.animate(c);
    }
    this.#lamp(t);

    // shake in short bursts while down
    const p = this.group.position;
    if (s === 'down') {
      const k = (t + this.seed) % 1.6;
      const a = k < 0.45 ? 0.08 * (1 - k / 0.45) : 0;
      p.x = this.x + Math.sin(t * 71) * a;
      p.z = this.z + Math.cos(t * 59) * a * 0.6;
      this.sparkT -= dt;
      if (this.sparkT <= 0) {
        this.spec.sparkPoint(tmpV);
        this.fx.burst('spark', tmpV.x, tmpV.y, tmpV.z, 3 + ((Math.random() * 5) | 0));
        this.sparkT = 0.12 + Math.random() * 0.75;
      }
      this.sootT -= dt;
      if (this.sootT <= 0) {
        this.fx.emit('soot', this.x + this.spec.smoke[0], this.spec.smoke[1], this.z + this.spec.smoke[2]);
        this.sootT = 1.4 + Math.random() * 1.4;
      }
    } else if (p.x !== this.x || p.z !== this.z) {
      p.x = this.x;
      p.z = this.z;
    }
    if (running && this.degraded) {
      this.smokeT -= dt;
      if (this.smokeT <= 0) {
        this.fx.emit('smoke', this.x + this.spec.smoke[0], this.spec.smoke[1], this.z + this.spec.smoke[2]);
        if (Math.random() < 0.4) this.fx.emit('smoke', this.x + this.spec.smoke[0], this.spec.smoke[1] + 0.1, this.z + this.spec.smoke[2]);
        this.smokeT = 1.2 + Math.random() * 1.8;
      }
    }
  }

  // world position of the top of the machine (for labels)
  topPosition(out) {
    return out.set(this.x, TOWER_TOP + 0.15, this.z);
  }
}

// Local point helper for specs without moving spark sources.
function fixedPoint(mv, [x, y, z]) {
  return (out) => out.set(mv.x + x, y, mv.z + z);
}

// Per-machine LED that can blink (MeshBasic so it reads as light).
function led(g, color, x, y, z, w = 0.09, h = 0.09, d = 0.04) {
  const mat = glowMat(color);
  const mesh = box(g, w, h, d, mat, x, y, z, false, false);
  return { mesh, mat, on: new THREE.Color(color), off: new THREE.Color(color).multiplyScalar(0.18) };
}
const setLed = (l, on) => l.mat.color.copy(on ? l.on : l.off);

// ─── Conveyor drive: infeed hopper + stepper drive + control box ────────────
function conveyor(g, m, mv) {
  const steel = m(C.n3);
  const frame = m(C.n1);
  for (const [x, z] of [[-0.77, -0.77], [0.77, -0.77], [-0.77, 0.77], [0.77, 0.77]]) box(g, 0.12, 2.3, 0.12, steel, x, 0, z);
  box(g, 1.62, 0.1, 0.1, frame, 0, 1.72, 0.75);
  box(g, 1.62, 0.1, 0.1, frame, 0, 1.72, -0.75);
  // feed hopper: open bin on a tapered throat, full of raw blanks
  const binM = m(C.yellow);
  const throat = new THREE.Mesh(cylGeo(0.98, 0.36, 0.55, 4, false), m('#c9ad72'));
  throat.rotation.y = Math.PI / 4;
  throat.position.y = 1.86;
  throat.castShadow = true;
  g.add(throat);
  box(g, 1.46, 0.6, 0.08, binM, 0, 2.1, 0.69);
  box(g, 1.46, 0.6, 0.08, binM, 0, 2.1, -0.69);
  box(g, 0.08, 0.6, 1.3, binM, 0.69, 2.1, 0);
  box(g, 0.08, 0.6, 1.3, binM, -0.69, 2.1, 0);
  box(g, 1.5, 0.06, 0.1, m(C.n1), 0, 2.7, 0.7, false);
  box(g, 1.5, 0.06, 0.1, m(C.n1), 0, 2.7, -0.7, false);
  box(g, 1.3, 0.04, 1.3, m(C.n0), 0, 2.36, 0, false);
  const blank = m(C.f2);
  for (const [x, z, y] of [[-0.35, -0.35, 0], [0.05, -0.38, 0], [0.38, -0.3, 0], [-0.38, 0.05, 0], [0.0, 0.0, 0.08], [0.36, 0.08, 0], [-0.3, 0.38, 0], [0.1, 0.36, 0], [0.4, 0.4, 0]]) {
    const b = box(g, 0.3, 0.24, 0.3, blank, x, 2.4 + y, z, false);
    b.rotation.y = (x + z) * 2;
  }
  box(g, 0.5, 0.42, 0.5, steel, 0, 1.18, 0); // outlet chute

  // stepper drive on the front
  const motor = new THREE.Group();
  motor.position.set(0.55, 0.5, 1.0);
  g.add(motor);
  box(motor, 0.5, 0.22, 0.5, frame, 0, -0.5, 0);
  cyl(motor, 0.28, 0.7, m(C.f3), 0, 0, 0, 'z', 8);
  cyl(motor, 0.3, 0.06, m(C.n1), 0, 0, 0.37, 'z', 8);
  box(motor, 0.22, 0.14, 0.26, m(C.n0), 0, 0.26, -0.05);
  const fan = new THREE.Group();
  fan.position.set(0, 0, 0.42);
  motor.add(fan);
  boxC(fan, 0.48, 0.08, 0.03, m(C.s0), 0, 0, 0);
  boxC(fan, 0.08, 0.48, 0.03, m(C.s0), 0, 0, 0);
  box(g, 0.55, 0.62, 0.14, m(C.orange), 0.55, 0.2, 0.66); // belt guard

  // control box: driver board + main fuse
  box(g, 0.62, 1.12, 0.4, m(C.s0), -0.72, 0.15, 1.05);
  box(g, 0.02, 0.9, 0.02, m(C.n3), -0.72, 0.25, 1.26, false);
  box(g, 0.24, 0.14, 0.03, m(C.n0), -0.84, 0.55, 1.26, false); // fuse window
  for (const dx of [-0.3, 0.3]) box(g, 0.06, 0.15, 0.06, steel, -0.72 + dx * 0.8, 0, 1.05);
  const ledRun = led(g, LAMP.green, -0.86, 1.02, 1.27);
  const ledStep = led(g, LAMP.amber, -0.6, 1.02, 1.27);

  return {
    tower: [1.15, -1.15],
    smoke: [0.55, 0.85, 1.0],
    sparkPoint: fixedPoint(mv, [0.55, 0.55, 1.45]),
    animate(c) {
      let rate = 16 * (1 - c.idle * 0.85);
      if (c.degraded) rate *= 0.55 + 0.45 * Math.sign(Math.sin(c.t * 4.3)); // stuttering stepper
      fan.rotation.z -= rate * c.dt;
      setLed(ledRun, true);
      setLed(ledStep, (c.T * 6) % 1 < 0.5 && c.idle < 0.5);
    },
    freeze(s) {
      setLed(ledRun, s === 'maintenance');
      setLed(ledStep, false);
    },
  };
}

// ─── Sorter: scanner gantry, diverter paddle, reject tote, relay cabinet ────
function sorter(g, m, mv) {
  const frame = m(C.f1);
  for (const x of [-0.6, 0.6]) for (const z of [-0.85, 0.85]) box(g, 0.2, 2.0, 0.2, frame, x, 0, z);
  box(g, 1.6, 0.4, 2.0, m(C.f3), 0, 2.0, 0);
  box(g, 1.64, 0.06, 2.04, m(C.f1), 0, 2.4, 0);
  box(g, 0.9, 0.08, 1.2, m(C.n1), -0.1, 2.46, 0); // scanner electronics
  box(g, 0.14, 0.1, 0.04, glowMat('#ff5a64'), -0.4, 2.12, 1.01, false, false);
  box(g, 0.36, 0.28, 0.36, m(C.n1), -0.2, 1.72, 0);
  const beamMat = glowMat('#ff5a64');
  const beamOn = new THREE.Color('#ff7a80');
  const beamDim = new THREE.Color('#a8323c');
  box(g, 0.18, 0.04, 0.18, beamMat, -0.2, 1.68, 0, false, false);
  const beam = boxC(g, 0.05, 0.9, 0.05, beamMat, -0.2, 1.23, 0, false, false);

  // diverter paddle on the front rail
  const pivot = new THREE.Group();
  pivot.position.set(0.62, 0.95, 0.68);
  g.add(pivot);
  cyl(pivot, 0.08, 0.34, m(C.n1), 0, 0, 0, 'y', 6);
  boxC(pivot, 0.85, 0.26, 0.06, m(C.yellow), -0.43, 0, 0);
  box(g, 0.5, 0.12, 0.12, m(C.s0), 0.85, 0.89, 0.86); // pneumatic cylinder

  // reject tote (contents are animated by the line)
  const tote = m(C.f3);
  box(g, 0.84, 0.18, 0.66, tote, 0.2, 0, -1.3);
  box(g, 0.84, 0.32, 0.05, tote, 0.2, 0.18, -1.3 + 0.31);
  box(g, 0.84, 0.32, 0.05, tote, 0.2, 0.18, -1.3 - 0.31);
  box(g, 0.05, 0.32, 0.66, tote, 0.2 + 0.4, 0.18, -1.3);
  box(g, 0.05, 0.32, 0.66, tote, 0.2 - 0.4, 0.18, -1.3);
  const chute = box(g, 0.6, 0.04, 0.55, m(C.steel), 0.2, 0.58, -0.82, false);
  chute.rotation.x = 0.5;

  // relay cabinet
  box(g, 0.75, 1.0, 0.36, m(C.n3), -0.35, 0.15, 1.12);
  box(g, 0.65, 0.85, 0.03, m(C.n2), -0.35, 0.22, 1.31, false);
  box(g, 0.05, 0.15, 0.36, m(C.n1), -0.35 - 0.3, 0, 1.12);
  box(g, 0.05, 0.15, 0.36, m(C.n1), -0.35 + 0.3, 0, 1.12);
  const leds = [led(g, LAMP.amber, -0.55, 0.98, 1.33), led(g, LAMP.green, -0.42, 0.98, 1.33), led(g, LAMP.amber, -0.29, 0.98, 1.33)];

  return {
    tower: [-1.15, -1.15],
    smoke: [-0.35, 1.2, 1.1],
    sparkPoint: fixedPoint(mv, [-0.35, 0.75, 1.36]),
    animate(c) {
      const age = c.line.time - c.line.kickAt;
      const k = age < 0.12 ? age / 0.12 : age < 0.3 ? 1 : age < 0.55 ? 1 - (age - 0.3) / 0.25 : 0;
      pivot.rotation.y = -1.0 * smooth(k);
      const ph = c.line.phaseAt(mv.x - 0.2);
      const hot = c.idle < 0.5 && (ph < 0.07 || ph > 0.95);
      let flicker = 1;
      if (c.degraded && Math.sin(c.t * 23) > 0.4) flicker = 0; // weak sensor signal
      beam.visible = flicker > 0;
      beamMat.color.copy(hot ? beamOn : beamDim);
      beam.scale.x = hot ? 1.8 : 1;
      leds.forEach((l, i) => setLed(l, ((c.T * (1.3 + i * 0.7)) % 1) < 0.5));
    },
    freeze(s) {
      beam.visible = false;
      leds.forEach((l, i) => setLed(l, s === 'maintenance' && i === 1));
    },
  };
}

// ─── Robot arm: fits a cap from the feeder tray onto each blank ─────────────
const L1 = 1.1;
const L2 = 1.0;
const PHI_TABLE = Math.atan2(1.05, 0.05);
// [phase, yaw, reach, height, grip]
const ARM_KEYS = [
  [0.0, 0, 1.05, 0.26, 0],
  [0.12, 0, 0.8, 0.85, 0],
  [0.36, PHI_TABLE, 0.8, 0.85, 0],
  [0.46, PHI_TABLE, 1.05, 0.09, 0],
  [0.54, PHI_TABLE, 1.05, 0.09, 1],
  [0.64, PHI_TABLE, 0.8, 0.85, 1],
  [0.86, 0, 0.8, 0.85, 1],
  [0.96, 0, 1.05, 0.26, 1],
  [1.0, 0, 1.05, 0.26, 0],
];
const READY = [0.55, 0.78, 0.95, 0];

function arm(g, m, mv) {
  const PZ = -1.05;
  const link = m(C.orange);
  const joint = m(C.n1);
  const cap = m(C.yellow);
  const dark = m(C.n1);
  // cap feeder table
  box(g, 0.82, 0.08, 0.75, m(C.steel), 1.05, 0.72, -1.0);
  for (const [dx, dz] of [[-0.35, -0.3], [0.35, -0.3], [-0.35, 0.3], [0.35, 0.3]]) box(g, 0.07, 0.72, 0.07, dark, 1.05 + dx, 0, -1.0 + dz);
  box(g, 0.56, 0.08, 0.46, m(C.n0), 1.05, 0.8, -1.0);
  for (const [dx, dz] of [[-0.12, -0.1], [0.12, -0.1], [-0.12, 0.12], [0.12, 0.12]]) box(g, 0.16, 0.08, 0.16, cap, 1.05 + dx, 0.88, -1.0 + dz, false);
  // pedestal
  box(g, 0.9, 0.12, 0.9, dark, 0, 0, PZ);
  cyl(g, 0.3, 0.85, m(C.purple), 0, 0.545, PZ, 'y', 8);
  box(g, 0.5, 0.18, 0.12, m(C.n0), 0, 0.12, PZ + 0.45); // cable duct
  const turret = new THREE.Group();
  turret.position.set(0, 0.97, PZ);
  g.add(turret);
  cyl(turret, 0.36, 0.28, m('#9a7a96'), 0, 0.14, 0, 'y', 8);
  const shoulder = new THREE.Group();
  shoulder.position.y = 0.32;
  turret.add(shoulder);
  cyl(shoulder, 0.19, 0.46, joint, 0, 0, 0, 'x', 8);
  boxC(shoulder, 0.3, L1, 0.3, link, 0, L1 / 2, 0);
  const elbow = new THREE.Group();
  elbow.position.y = L1;
  shoulder.add(elbow);
  cyl(elbow, 0.16, 0.38, joint, 0, 0, 0, 'x', 8);
  boxC(elbow, 0.24, L2, 0.24, link, 0, L2 / 2, 0);
  const wrist = new THREE.Group();
  wrist.position.y = L2;
  elbow.add(wrist);
  boxC(wrist, 0.26, 0.14, 0.26, dark, 0, 0.07, 0);
  const f1 = boxC(wrist, 0.06, 0.24, 0.16, m(C.n3), 0.1, 0.26, 0);
  const f2 = boxC(wrist, 0.06, 0.24, 0.16, m(C.n3), -0.1, 0.26, 0);
  const held = boxC(wrist, 0.16, 0.08, 0.16, cap, 0, 0.34, 0);
  held.visible = false;

  const pose = { yaw: 0, r: 0, h: 0, grip: 0 };
  function sample(p) {
    let i = 1;
    while (i < ARM_KEYS.length - 1 && ARM_KEYS[i][0] < p) i++;
    const a = ARM_KEYS[i - 1];
    const b = ARM_KEYS[i];
    const k = smooth((p - a[0]) / Math.max(1e-6, b[0] - a[0]));
    pose.yaw = lerp(a[1], b[1], k);
    pose.r = lerp(a[2], b[2], k);
    pose.h = lerp(a[3], b[3], k);
    pose.grip = b[4] === a[4] ? a[4] : lerp(a[4], b[4], k);
  }
  function apply(yaw, r, h, grip, jitter) {
    const d = Math.min(Math.hypot(r, h), L1 + L2 - 0.02);
    const psi = Math.atan2(r, h);
    const delta = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
    const gamma = Math.acos(clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1));
    const a = psi - delta + jitter;
    const b = Math.PI - gamma - jitter * 0.6;
    turret.rotation.y = yaw;
    shoulder.rotation.x = a;
    elbow.rotation.x = b;
    wrist.rotation.x = Math.PI - a - b;
    const open = 0.06 + 0.05 * (1 - grip);
    f1.position.x = open + 0.04;
    f2.position.x = -open - 0.04;
  }
  apply(READY[0], READY[1], READY[2], 0, 0);

  return {
    tower: [-1.15, -1.15],
    smoke: [0, 1.25, PZ],
    sparkPoint: (out) => wrist.getWorldPosition(out),
    animate(c) {
      sample(c.line.phaseAt(mv.x));
      const w = smooth(c.idle);
      const sway = Math.sin(c.T * 0.9) * 0.15;
      const yaw = lerp(pose.yaw, READY[0] + sway, w);
      const r = lerp(pose.r, READY[1], w);
      const h = lerp(pose.h, READY[2], w);
      const grip = lerp(pose.grip, 0, w);
      held.visible = w < 0.5 && pose.grip > 0.5;
      // a failing servo/rail shows up as position error: visible twitching
      const jitter = c.degraded ? 0.13 * Math.sin(c.t * 31) * (Math.sin(c.t * 2.3) > 0.1 ? 1 : 0.25) : 0;
      apply(yaw, r, h, grip, jitter);
    },
  };
}

// ─── Packer: press cabinet, cooling fan, network switch, label scanner ──────
function packer(g, m, mv) {
  const body = m(C.green);
  const trim = m(C.s1);
  const steel = m(C.n3);
  box(g, 1.9, 2.1, 0.14, body, 0, 0, -0.93);
  box(g, 1.7, 1.3, 0.02, m('#262b35'), 0, 0.5, -0.85, false);
  box(g, 2.04, 0.22, 2.06, trim, 0, 2.1, 0);
  box(g, 0.18, 2.1, 0.18, body, -0.88, 0, 0.93);
  box(g, 0.18, 2.1, 0.18, body, 0.88, 0, 0.93);
  box(g, 1.6, 0.5, 0.14, body, 0, 0, 0.93);
  box(g, 1.6, 0.4, 0.14, body, 0, 1.7, 0.93);
  for (const sx of [-0.93, 0.93]) {
    box(g, 0.14, 0.62, 1.72, body, sx, 1.48, 0);
    box(g, 0.14, 0.5, 1.72, body, sx, 0, 0);
  }
  for (const x of [-0.4, 0.4]) box(g, 0.05, 1.2, 0.05, m(C.s0), x, 0.5, 0.97);
  box(g, 1.6, 0.06, 0.06, m(C.yellow), 0, 0.5, 1.0, false); // guard sill

  // press ram
  const press = new THREE.Group();
  g.add(press);
  boxC(press, 0.62, 0.16, 0.62, m(C.orange), 0, 0.08, 0);
  boxC(press, 0.12, 0.8, 0.12, m(C.s0), 0, 0.56, 0);
  cyl(g, 0.2, 0.45, m(C.s0), 0, 2.55, 0, 'y', 8);
  const UP = 1.62;
  const DOWN = 1.3;
  press.position.y = UP;

  // roof: cooling fan + network switch
  box(g, 0.72, 0.14, 0.72, m(C.n1), -0.45, 2.32, -0.45);
  const fan = new THREE.Group();
  fan.position.set(-0.45, 2.5, -0.45);
  g.add(fan);
  boxC(fan, 0.62, 0.03, 0.1, m(C.s0), 0, 0, 0);
  boxC(fan, 0.1, 0.03, 0.62, m(C.s0), 0, 0, 0);
  box(g, 0.56, 0.16, 0.34, m(C.n0), 0.45, 2.32, 0.55);
  const leds = [0, 1, 2, 3].map((i) => led(g, i % 2 ? LAMP.amber : LAMP.green, 0.27 + i * 0.12, 2.38, 0.73, 0.06, 0.05, 0.03));

  // tape roll on the exit side
  box(g, 0.06, 0.3, 0.06, steel, 1.03, 1.45, 0.3);
  const tape = cyl(g, 0.22, 0.12, m(C.tape), 1.08, 1.8, 0.3, 'z', 8);

  // label scanner at the exit
  box(g, 0.08, 1.55, 0.08, steel, 1.28, 0, -0.78);
  box(g, 0.22, 0.16, 0.36, m(C.n0), 1.28, 1.55, -0.6);
  const scanMat = glowMat('#ff5a64');
  const scan = boxC(g, 0.04, 0.72, 0.04, scanMat, 1.28, 1.19, -0.45, false, false);

  return {
    tower: [-1.15, -1.15],
    smoke: [-0.45, 2.55, -0.45],
    sparkPoint: fixedPoint(mv, [0.45, 2.45, 0.72]),
    animate(c) {
      const p = c.line.phaseAt(mv.x);
      const d = p < 0.5 ? p : p - 1;
      const stroke = smooth(1 - Math.abs(d) / 0.12) * (1 - c.idle);
      press.position.y = UP - (UP - DOWN) * stroke;
      let rate = 13;
      if (c.degraded) rate *= 0.35 + 0.3 * Math.sin(c.t * 1.7); // worn fan dragging
      fan.rotation.y += rate * c.dt;
      tape.rotation.z -= 2 * (1 - c.idle) * c.dt;
      leds.forEach((l, i) => setLed(l, Math.sin(c.T * (7 + i * 3.1) + i) > (c.degraded ? 0.6 : -0.2)));
      const ps = c.line.phaseAt(mv.x + 1.28);
      scan.visible = c.idle < 0.5 ? ps < 0.1 || ps > 0.9 || Math.sin(c.T * 30) > 0.6 : false;
    },
    freeze(s) {
      scan.visible = false;
      leds.forEach((l, i) => setLed(l, s === 'maintenance' && i === 0));
    },
  };
}

// Fallback for machine ids the world does not know yet.
function generic(g, m, mv) {
  box(g, 2.0, 1.6, 2.0, m(C.n3), 0, 0, 0);
  box(g, 1.6, 0.4, 1.6, m(C.f3), 0, 1.6, 0);
  const fan = new THREE.Group();
  fan.position.set(0, 2.05, 0);
  g.add(fan);
  boxC(fan, 1.0, 0.04, 0.14, m(C.s0), 0, 0, 0);
  return {
    tower: [1.15, -1.15],
    smoke: [0, 2.1, 0],
    sparkPoint: fixedPoint(mv, [0, 1.2, 1.05]),
    animate(c) {
      fan.rotation.y += 6 * c.dt;
    },
  };
}

const BUILDERS = { conveyor, sorter, arm, packer };
