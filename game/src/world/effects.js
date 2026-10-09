// Pooled particles (sparks, smoke, confetti, poofs) drawn with two
// InstancedMeshes (glowing chips + soft low-poly puffs), plus expanding floor
// rings. Capped pools, no allocations per frame.

import * as THREE from 'three';
import { boxGeo } from './palette.js';

const puffGeo = new THREE.IcosahedronGeometry(0.62, 1);

const KINDS = {
  spark: { glow: true, size: [0.1, 0.16], life: [0.3, 0.65], grav: -13, drag: 0.6, bounce: 0.35, colors: ['#fff6c8', '#ffd36b', '#ff9a4a', '#ffffff'] },
  smoke: { glow: false, size: [0.22, 0.32], grow: 2.2, life: [1.6, 2.4], grav: 0.35, drag: 0.7, colors: ['#8c93a0', '#a6adb8', '#7a8290'] },
  soot: { glow: false, size: [0.22, 0.3], grow: 2.0, life: [1.4, 2.0], grav: 0.4, drag: 0.7, colors: ['#3f444f', '#4c525e', '#353a44'] },
  confetti: { glow: true, flat: true, size: [0.16, 0.24], life: [1.4, 2.2], grav: -5.5, drag: 1.1, bounce: 0.2, spin: 9, colors: ['#7fd860', '#ffd04a', '#5cc8f0', '#b98cf0', '#ff8a4c', '#ff5566', '#ffffff'] },
  poof: { glow: false, size: [0.18, 0.28], grow: 1.2, life: [0.45, 0.75], grav: 0.6, drag: 3.2, colors: ['#d8dee9', '#c0c8d6', '#e5e9f0'] },
  twinkle: { glow: true, size: [0.1, 0.16], life: [0.5, 0.9], grav: 0, drag: 1, colors: ['#ffffff', '#fff3b0', '#a3f0ff'] },
  dust: { glow: false, size: [0.14, 0.22], grow: 1.5, life: [0.5, 0.9], grav: 0.2, drag: 2.5, colors: ['#5b5f6a', '#4f535d'] },
};

const rand = (a, b) => a + Math.random() * (b - a);

export class Effects {
  constructor(scene, { maxGlow = 320, maxSolid = 200 } = {}) {
    this.scene = scene;
    this.meshes = {
      glow: new THREE.InstancedMesh(boxGeo(1, 1, 1), new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }), maxGlow),
      solid: new THREE.InstancedMesh(puffGeo, new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95, metalness: 0, transparent: true, opacity: 0.85, depthWrite: false }), maxSolid),
    };
    this.pools = { glow: [], solid: [] };
    this.cursor = { glow: 0, solid: 0 };
    const white = new THREE.Color('#ffffff');
    for (const key of ['glow', 'solid']) {
      const m = this.meshes[key];
      m.frustumCulled = false;
      m.count = 0;
      for (let i = 0; i < m.instanceMatrix.count; i++) {
        m.setColorAt(i, white);
        this.pools[key].push({ on: false, k: null, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0, vr: 0, life: 0, max: 1, size: 0.1, color: new THREE.Color() });
      }
      scene.add(m);
    }
    this.colorCache = {};
    for (const [k, def] of Object.entries(KINDS)) this.colorCache[k] = def.colors.map((c) => new THREE.Color(c));
    this.dummy = new THREE.Object3D();
    this.#rings(scene);
  }

  #rings(scene) {
    this.rings = [];
    const geo = new THREE.RingGeometry(0.88, 1, 64);
    geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 6; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.renderOrder = 2;
      scene.add(m);
      this.rings.push({ m, t: 0, dur: 1, from: 0.4, to: 3 });
    }
  }

  #slot(key) {
    const pool = this.pools[key];
    for (let n = 0; n < pool.length; n++) {
      const i = (this.cursor[key] + n) % pool.length;
      if (!pool[i].on) {
        this.cursor[key] = (i + 1) % pool.length;
        return pool[i];
      }
    }
    return null; // capped
  }

  // opts: { spread, speed, vy, vx, vz, color }
  emit(kind, x, y, z, opts = {}) {
    const def = KINDS[kind];
    if (!def) return;
    const p = this.#slot(def.glow ? 'glow' : 'solid');
    if (!p) return;
    const s = opts.speed ?? 1;
    const spread = opts.spread ?? 0.05;
    p.on = true;
    p.k = kind;
    p.x = x + rand(-spread, spread);
    p.y = y + rand(-spread, spread) * 0.5;
    p.z = z + rand(-spread, spread);
    switch (kind) {
      case 'spark':
        p.vx = rand(-2.2, 2.2) * s; p.vy = rand(1.5, 4.2) * s; p.vz = rand(-2.2, 2.2) * s;
        break;
      case 'smoke':
      case 'soot':
        p.vx = rand(-0.15, 0.15); p.vy = rand(0.5, 0.9) * s; p.vz = rand(-0.15, 0.15);
        break;
      case 'confetti':
        p.vx = rand(-2.6, 2.6) * s; p.vy = rand(3.2, 6.2) * s; p.vz = rand(-2.6, 2.6) * s;
        break;
      case 'poof': {
        const a = Math.random() * Math.PI * 2;
        const r = rand(1.2, 2.2) * s;
        p.vx = Math.cos(a) * r; p.vy = rand(0.3, 1.2); p.vz = Math.sin(a) * r;
        break;
      }
      case 'dust':
        p.vx = rand(-0.6, 0.6); p.vy = rand(0.2, 0.7); p.vz = rand(-0.6, 0.6);
        break;
      default:
        p.vx = rand(-0.6, 0.6) * s; p.vy = rand(0.3, 1.4) * s; p.vz = rand(-0.6, 0.6) * s;
    }
    if (opts.vx !== undefined) p.vx += opts.vx;
    if (opts.vy !== undefined) p.vy += opts.vy;
    if (opts.vz !== undefined) p.vz += opts.vz;
    p.rx = Math.random() * 3; p.ry = Math.random() * 3; p.rz = Math.random() * 3;
    p.vr = (def.spin || 2) * rand(-1, 1);
    p.max = p.life = rand(def.life[0], def.life[1]);
    p.size = rand(def.size[0], def.size[1]) * (opts.scale ?? 1);
    const cols = this.colorCache[kind];
    if (opts.color) p.color.set(opts.color);
    else p.color.copy(cols[(Math.random() * cols.length) | 0]);
  }

  burst(kind, x, y, z, n, opts) {
    for (let i = 0; i < n; i++) this.emit(kind, x, y, z, opts);
  }

  ring(x, z, color = '#a3be8c', { from = 0.4, to = 3, dur = 0.8, y = 0.04 } = {}) {
    const r = this.rings.find((r) => !r.m.visible) || this.rings[0];
    r.m.visible = true;
    r.m.position.set(x, y, z);
    r.m.material.color.set(color);
    Object.assign(r, { t: 0, dur, from, to });
  }

  clear() {
    for (const key of ['glow', 'solid']) for (const p of this.pools[key]) p.on = false;
    for (const r of this.rings) r.m.visible = false;
  }

  update(dt) {
    const d = this.dummy;
    for (const key of ['glow', 'solid']) {
      const mesh = this.meshes[key];
      let n = 0;
      for (const p of this.pools[key]) {
        if (!p.on) continue;
        p.life -= dt;
        if (p.life <= 0) {
          p.on = false;
          continue;
        }
        const def = KINDS[p.k];
        p.vy += def.grav * dt;
        const drag = Math.max(0, 1 - def.drag * dt);
        p.vx *= drag; p.vy *= def.grav > 0 ? 1 : drag; p.vz *= drag;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        if (def.bounce && p.y < 0.03 && p.vy < 0) {
          p.y = 0.03;
          p.vy = -p.vy * def.bounce;
          p.vx *= 0.5; p.vz *= 0.5;
          p.vr *= 0.5;
        }
        p.rx += p.vr * dt; p.rz += p.vr * 0.7 * dt;
        const k = p.life / p.max; // 1 → 0
        let s = p.size;
        if (def.grow) s *= (1 + def.grow * (1 - k)) * Math.min(1, k * 3);
        else s *= Math.min(1, k * 2.5);
        d.position.set(p.x, p.y, p.z);
        d.rotation.set(p.rx, p.ry, p.rz);
        if (def.flat) d.scale.set(s, s * 0.22, s * 0.75);
        else d.scale.setScalar(s);
        d.updateMatrix();
        mesh.setMatrixAt(n, d.matrix);
        mesh.setColorAt(n, p.color);
        n++;
      }
      mesh.count = n;
      if (n) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor.needsUpdate = true;
      }
    }
    for (const r of this.rings) {
      if (!r.m.visible) continue;
      r.t += dt;
      const k = r.t / r.dur;
      if (k >= 1) {
        r.m.visible = false;
        continue;
      }
      const e = 1 - (1 - k) * (1 - k);
      r.m.scale.setScalar(r.from + (r.to - r.from) * e);
      r.m.material.opacity = (1 - k) * 0.9;
    }
  }
}
