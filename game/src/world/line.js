// The production line: one belt through all four machines. Raw blanks drop
// from the conveyor hopper, the sorter kicks bad blanks into its reject tote,
// the arm fits an orange cap, the packer boxes them, boxes stack on a pallet.
// Everything moves only while the line runs (setRunning).

import * as THREE from 'three';
import { C, lam, box, boxC, cyl, canvasTex, smooth } from './palette.js';

export const BELT = { x0: -8.6, x1: 8.6, top: 0.78, z: 0 };
const SPAWN_X = -6; // under the hopper
const SPACING = 1.9; // belt units between blanks
const SPEED = 1.15; // belt units per second
const STAGE = { sorter: -1.75, arm: 2, packer: 6 };
const PALLET = { x: 9.75, z: 0, top: 0.2 };
const BIN = { x: -1.8, z: -1.3, y: 0.18 };

export class ProductionLine {
  constructor(scene, fx) {
    this.fx = fx;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.running = true;
    this.speed = 0; // eased belt speed
    this.dist = 0; // total belt travel
    this.lastSpawn = 0;
    this.spawned = 0;
    this.time = 0;
    this.kickAt = -10; // line time of the last reject kick (sorter animates from it)
    this.#frame();
    this.#items();
    this.#output();
    // Start with a busy belt.
    for (let i = 0; i < 160; i++) this.update(0.1, true);
  }

  #frame() {
    const g = this.group;
    const L = BELT.x1 - BELT.x0;
    const cx = (BELT.x0 + BELT.x1) / 2;
    this.beltTex = canvasTex(8, 8, (ctx) => {
      ctx.fillStyle = '#2c313b';
      ctx.fillRect(0, 0, 8, 8);
      ctx.fillStyle = '#4a5264';
      ctx.fillRect(0, 0, 0.8, 8);
      ctx.fillStyle = '#373d49';
      ctx.fillRect(4, 0, 0.6, 8);
    }, [L / 0.5, 1]);
    const beltMat = new THREE.MeshStandardMaterial({ map: this.beltTex, roughness: 0.85, metalness: 0 });
    box(g, L, 0.1, 1.1, beltMat, cx, BELT.top - 0.1, 0, false, true);
    const rail = lam(C.f2);
    box(g, L + 0.2, 0.16, 0.08, rail, cx, BELT.top - 0.12, 0.6);
    box(g, L + 0.2, 0.16, 0.08, rail, cx, BELT.top - 0.12, -0.6);
    box(g, L, 0.08, 0.9, lam(C.n1), cx, 0.5, 0, false, false); // under-tray
    const legM = lam(C.n3);
    for (const x of [-8.2, -4, 0, 4, 8.2]) {
      for (const z of [-0.48, 0.48]) {
        box(g, 0.12, BELT.top - 0.1, 0.12, legM, x, 0, z);
        box(g, 0.26, 0.04, 0.26, lam(C.n1), x, 0, z, false);
      }
      box(g, 0.08, 0.08, 0.96, legM, x, 0.22, 0, false);
    }
    this.rollers = [BELT.x0, BELT.x1].map((x) => cyl(g, 0.11, 1.12, lam(C.s0), x, BELT.top - 0.06, 0, 'z', 8));
    box(g, 0.22, 0.42, 1.26, lam(C.orange), BELT.x0 - 0.12, BELT.top - 0.3, 0); // tail guard
    // output chute to the pallet
    const chute = box(g, 0.7, 0.05, 1.0, lam(C.steel), BELT.x1 + 0.3, BELT.top - 0.12, 0);
    chute.rotation.z = -0.25;
  }

  #items() {
    this.items = [];
    const rawM = lam(C.f2);
    const rejM = lam('#b8735f');
    const capM = lam(C.yellow);
    const boxM = lam(C.cardboard);
    const tapeM = lam(C.tape);
    for (let i = 0; i < 14; i++) {
      const g = new THREE.Group();
      g.visible = false;
      const raw = boxC(g, 0.38, 0.3, 0.38, rawM, 0, 0.15, 0);
      const cap = boxC(g, 0.22, 0.1, 0.22, capM, 0, 0.35, 0);
      const boxed = new THREE.Group();
      boxC(boxed, 0.5, 0.42, 0.5, boxM, 0, 0.21, 0);
      boxC(boxed, 0.52, 0.06, 0.14, tapeM, 0, 0.43, 0, false);
      g.add(boxed);
      this.group.add(g);
      this.items.push({ g, raw, cap, boxed, rawM, rejM, on: false, state: 'belt', x: 0, at: 0, t: 0, reject: false, from: new THREE.Vector3(), to: new THREE.Vector3() });
    }
  }

  #output() {
    const g = this.group;
    // pallet
    const wood = lam(C.wood);
    box(g, 1.2, 0.06, 1.2, wood, PALLET.x, 0.14, PALLET.z);
    for (const dz of [-0.5, 0, 0.5]) box(g, 1.2, 0.14, 0.14, lam(C.woodDark), PALLET.x, 0, PALLET.z + dz);
    this.stack = [];
    const boxM = lam(C.cardboard);
    const tapeM = lam(C.tape);
    for (let i = 0; i < 12; i++) {
      const layer = Math.floor(i / 4);
      const w = i % 4;
      const s = new THREE.Group();
      boxC(s, 0.5, 0.42, 0.5, boxM, 0, 0.21, 0);
      boxC(s, 0.52, 0.06, 0.14, tapeM, 0, 0.43, 0, false);
      s.position.set(PALLET.x + ((w % 2) - 0.5) * 0.54, PALLET.top + layer * 0.44, PALLET.z + (Math.floor(w / 2) - 0.5) * 0.54);
      s.visible = false;
      s.traverse((o) => (o.castShadow = true));
      g.add(s);
      this.stack.push(s);
    }
    this.stackCount = 0;
    this.clearAt = -1;
    // reject tote contents (the tote itself belongs to the sorter model)
    this.bin = [];
    const rejM = lam('#b8735f');
    for (let i = 0; i < 5; i++) {
      const m = boxC(g, 0.3, 0.24, 0.3, rejM, BIN.x + ((i % 3) - 1) * 0.22, BIN.y + 0.12 + Math.floor(i / 3) * 0.16, BIN.z + (i % 2 ? 0.08 : -0.08));
      m.rotation.y = i * 0.7;
      m.visible = i < 2;
      this.bin.push(m);
    }
    this.binCount = 2;
  }

  setRunning(on) {
    this.running = !!on;
  }

  // 0 when a blank is exactly at x (machines sync their motion to this).
  phaseAt(x) {
    const p = (this.dist - (x - SPAWN_X)) / SPACING;
    return p - Math.floor(p);
  }

  get moving() {
    return this.speed > 0.05;
  }

  #spawn(spawnDist) {
    const it = this.items.find((i) => !i.on);
    if (!it) return;
    this.spawned++;
    it.on = true;
    it.state = 'belt';
    it.at = spawnDist;
    it.t = 0;
    it.reject = this.spawned % 7 === 3;
    it.raw.material = it.reject ? it.rejM : it.rawM;
    it.g.visible = true;
  }

  update(dt, silent = false) {
    this.time += dt;
    // ease the belt speed so starts/stops feel mechanical
    const target = this.running ? SPEED : 0;
    this.speed += (target - this.speed) * Math.min(1, dt * 5);
    if (Math.abs(this.speed - target) < 0.01) this.speed = target;
    const step = this.speed * dt;
    this.dist += step;
    this.beltTex.offset.x -= step / 0.5;
    for (const r of this.rollers) r.rotation.y -= step / 0.11;

    while (this.dist - this.lastSpawn >= SPACING) {
      this.lastSpawn += SPACING;
      this.#spawn(this.lastSpawn);
    }

    for (const it of this.items) {
      if (!it.on) continue;
      it.t += dt;
      if (it.state === 'belt') {
        it.x = SPAWN_X + (this.dist - it.at);
        const drop = Math.max(0, 1 - (this.dist - it.at) / 0.3); // falls out of the hopper chute
        it.g.position.set(it.x, BELT.top + drop * 0.55, BELT.z);
        const capped = it.x >= STAGE.arm;
        const boxed = it.x >= STAGE.packer;
        it.raw.visible = !boxed;
        it.cap.visible = capped && !boxed;
        it.boxed.visible = boxed;
        if (it.reject && it.x >= STAGE.sorter) {
          it.state = 'reject';
          it.t = 0;
          it.from.copy(it.g.position);
          it.to.set(BIN.x, BIN.y + 0.2, BIN.z);
          this.kickAt = this.time;
        } else if (it.x >= BELT.x1 - 0.25) {
          it.state = 'out';
          it.t = 0;
          it.from.copy(it.g.position);
          const s = this.stack[Math.min(this.stackCount, 11)].position;
          it.to.set(s.x, s.y, s.z);
        }
      } else if (it.state === 'reject') {
        const k = Math.min(1, it.t / 0.45);
        it.g.position.lerpVectors(it.from, it.to, smooth(k));
        it.g.position.y += Math.sin(k * Math.PI) * 0.25;
        it.g.rotation.y = k * 1.2;
        if (k >= 1) {
          it.on = false;
          it.g.visible = false;
          it.g.rotation.y = 0;
          this.binCount = Math.min(this.bin.length, this.binCount + 1);
          this.bin.forEach((m, i) => (m.visible = i < this.binCount));
        }
      } else if (it.state === 'out') {
        const k = Math.min(1, it.t / 0.45);
        it.g.position.lerpVectors(it.from, it.to, k);
        it.g.position.y += Math.sin(k * Math.PI) * 0.35;
        if (k >= 1) {
          it.on = false;
          it.g.visible = false;
          if (this.stackCount < 12) this.stack[this.stackCount].visible = true;
          this.stackCount++;
          if (this.stackCount >= 12 && this.clearAt < 0) this.clearAt = this.time + 0.9;
        }
      }
    }

    // A full pallet is wrapped and taken away.
    if (this.clearAt > 0 && this.time >= this.clearAt) {
      this.clearAt = -1;
      this.stackCount = 0;
      for (const s of this.stack) s.visible = false;
      if (!silent) this.fx?.burst('poof', PALLET.x, 0.6, PALLET.z, 10);
      // the tote gets emptied with the pallet
      this.binCount = 1;
      this.bin.forEach((m, i) => (m.visible = i < this.binCount));
    }
  }
}
