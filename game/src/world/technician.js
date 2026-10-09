// Technicians: walk in from the street through the staff door to the machine
// (Wrench-bot brings the delivered crate), work on it (arm swing + sparks),
// then walk back out.

import * as THREE from 'three';
import { C, lam, box, boxC, clamp, angleDelta, safeColor } from './palette.js';
import { LAYOUT } from './environment.js';

const tmp = new THREE.Vector3();
const ENTRY = LAYOUT.techEntry.map(([x, y, z]) => new THREE.Vector3(x, y, z));
const INSIDE = ENTRY[ENTRY.length - 1];

class Technician {
  constructor(scene, fx, machine, tech) {
    this.scene = scene;
    this.fx = fx;
    this.machine = machine; // MachineView
    this.machineId = machine.id;
    this.name = tech?.name || 'Technician';
    this.root = new THREE.Group();
    this.root.name = `tech:${this.name}`;
    scene.add(this.root);
    this.#build(safeColor(tech?.color, C.yellow));
    this.root.position.copy(ENTRY[0]);
    this.root.scale.setScalar(0.01);
    this.yaw = Math.PI;
    this.wantYaw = Math.PI;
    this.phase = 0;
    this.time = 0;
    this.working = false;
    this.cheerUntil = 0;
    this.leaving = false;
    this.gone = false;
    this.work = { x: machine.x + 1.0, z: machine.z + 2.0 };
    this.#plan();
  }

  #build(hatColor) {
    const r = this.root;
    const pants = lam(C.n1);
    const boot = lam(C.n0);
    this.legs = [-0.13, 0.13].map((x) => {
      const p = new THREE.Group();
      p.position.set(x, 0.7, 0);
      r.add(p);
      boxC(p, 0.2, 0.14, 0.3, boot, 0, -0.63, 0.03);
      boxC(p, 0.18, 0.56, 0.2, pants, 0, -0.28, 0);
      return p;
    });
    this.body = new THREE.Group();
    r.add(this.body);
    const b = this.body;
    box(b, 0.56, 0.62, 0.34, lam(C.orange), 0, 0.68, 0);
    box(b, 0.58, 0.07, 0.36, lam(C.yellow), 0, 0.9, 0, false);
    box(b, 0.58, 0.08, 0.36, lam(C.n1), 0, 0.68, 0, false);
    box(b, 0.3, 0.06, 0.3, lam(C.f3), 0, 1.3, 0, false);
    this.head = new THREE.Group();
    this.head.position.y = 1.33;
    b.add(this.head);
    const h = this.head;
    box(h, 0.36, 0.36, 0.34, lam(C.skin), 0, 0, 0);
    for (const x of [-0.08, 0.08]) box(h, 0.06, 0.06, 0.02, lam(C.n0), x, 0.17, 0.17, false);
    const hat = lam(hatColor);
    box(h, 0.42, 0.15, 0.4, hat, 0, 0.32, 0);
    box(h, 0.5, 0.04, 0.52, hat, 0, 0.3, 0.03);
    box(h, 0.08, 0.04, 0.42, lam(C.s2), 0, 0.47, 0, false);
    const sleeve = lam(C.f3);
    const glove = lam(C.n3);
    this.arms = [-0.36, 0.36].map((x) => {
      const a = new THREE.Group();
      a.position.set(x, 1.25, 0);
      b.add(a);
      boxC(a, 0.15, 0.48, 0.17, sleeve, 0, -0.24, 0);
      boxC(a, 0.15, 0.13, 0.17, glove, 0, -0.54, 0);
      return a;
    });
    // right-hand tool (shown while working)
    this.tool = new THREE.Group();
    this.tool.position.set(0, -0.6, 0.08);
    boxC(this.tool, 0.08, 0.08, 0.36, lam('#c3cad6'), 0, 0, 0.12);
    boxC(this.tool, 0.16, 0.12, 0.1, lam(C.red), 0, 0, -0.04);
    this.tool.visible = false;
    this.arms[1].add(this.tool);
    // toolbox in the left hand
    this.toolbox = new THREE.Group();
    this.toolbox.position.set(0, -0.72, 0.02);
    box(this.toolbox, 0.42, 0.22, 0.2, lam(C.red), 0, -0.11, 0);
    box(this.toolbox, 0.3, 0.06, 0.04, lam(C.n0), 0, 0.11, 0, false);
    this.arms[0].add(this.toolbox);
    r.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
  }

  #plan() {
    // in through the door, down to the aisle, along it (clear of the robot's pad), up to the machine
    const pts = ENTRY.slice(1).map((v) => v.clone());
    pts.push(new THREE.Vector3(INSIDE.x, 0, LAYOUT.aisleZ));
    pts.push(new THREE.Vector3(this.work.x, 0, LAYOUT.aisleZ));
    pts.push(new THREE.Vector3(this.work.x, 0, this.work.z));
    this.path = pts;
    this.wp = 0;
    // whole walk takes ~2.2 s (the sim gives technicians 2 game-minutes of travel)
    this.speed = clamp(this.#length(ENTRY[0]) / 2.2, 3.0, 7.5);
  }

  #length(from) {
    let len = 0;
    let prev = from;
    for (let i = this.wp; i < this.path.length; i++) {
      len += prev.distanceTo(this.path[i]);
      prev = this.path[i];
    }
    return len;
  }

  get arrived() {
    return !this.leaving && this.wp >= this.path.length;
  }

  setWork(on) {
    this.working = !!on;
  }

  cheer() {
    this.working = false;
    this.cheerUntil = this.time + 1.1;
  }

  leave() {
    if (this.leaving) return;
    this.leaving = true;
    this.working = false;
    if (this.toolbox.parent !== this.arms[0]) {
      this.arms[0].add(this.toolbox);
      this.toolbox.position.set(0, -0.72, 0.02);
      this.toolbox.rotation.set(0, 0, 0);
    }
    const p = this.root.position;
    const pts = [];
    if (p.z < 7.0) {
      if (p.z < LAYOUT.aisleZ - 0.3) pts.push(new THREE.Vector3(p.x, 0, LAYOUT.aisleZ));
      if (p.z < LAYOUT.aisleZ + 0.5) pts.push(new THREE.Vector3(INSIDE.x, 0, LAYOUT.aisleZ));
      pts.push(INSIDE.clone());
      for (let i = ENTRY.length - 2; i >= 0; i--) pts.push(ENTRY[i].clone());
    } else {
      for (let i = ENTRY.length - 1; i >= 0; i--) if (ENTRY[i].z > p.z) pts.push(ENTRY[i].clone());
      if (!pts.length) pts.push(ENTRY[0].clone());
    }
    this.path = pts;
    this.wp = 0;
    this.speed = clamp(this.#length(p) / 2.6, 3.0, 7.0);
  }

  #reached(i) {
    if (!this.leaving && i === this.path.length - 1) {
      this.wantYaw = Math.PI;
      // toolbox down next to the tech
      this.scene.attach(this.toolbox);
      this.toolbox.position.set(this.work.x + 0.6, 0.22, this.work.z + 0.15);
      this.toolbox.rotation.set(0, 0.4, 0);
    }
  }

  update(dt, t) {
    this.time += dt;
    const r = this.root;
    // fade in at the street, shrink out when gone
    const atEnd = this.leaving && this.wp >= this.path.length;
    const s = r.scale.x + (atEnd ? -dt * 4 : dt * 5);
    r.scale.setScalar(clamp(s, 0.01, 1));
    if (atEnd && r.scale.x <= 0.02) {
      this.gone = true;
      return;
    }

    let moving = false;
    if (this.wp < this.path.length) {
      const target = this.path[this.wp];
      tmp.subVectors(target, r.position);
      const flat = Math.hypot(tmp.x, tmp.z);
      const dist = tmp.length();
      const hurry = this.working && !this.leaving ? 1.6 : 1;
      const step = this.speed * hurry * dt;
      if (dist <= step || dist < 0.01) {
        r.position.copy(target);
        this.#reached(this.wp);
        this.wp++;
      } else {
        r.position.addScaledVector(tmp, step / dist);
        moving = true;
      }
      if (flat > 0.05) this.wantYaw = Math.atan2(tmp.x, tmp.z);
    }
    this.yaw += angleDelta(this.yaw, this.wantYaw) * Math.min(1, dt * 10);
    r.rotation.y = this.yaw;

    const [legL, legR] = this.legs;
    const [armL, armR] = this.arms;
    const b = this.body;
    const atWork = this.arrived && !moving;
    this.tool.visible = atWork && this.working;
    if (moving) {
      this.phase += dt * (5 + this.speed * 1.5);
      const sw = Math.sin(this.phase);
      legL.rotation.x = sw * 0.6;
      legR.rotation.x = -sw * 0.6;
      b.position.y = Math.abs(Math.cos(this.phase)) * 0.05;
      b.rotation.x = 0.05;
      armL.rotation.set(-sw * 0.25, 0, 0.08); // toolbox swings a little
      armR.rotation.set(-sw * 0.6, 0, 0);
    } else {
      legL.rotation.x *= 0.7;
      legR.rotation.x *= 0.7;
      if (atWork && this.working) {
        // crouched, hammering at the machine
        b.position.y = -0.1;
        b.rotation.x = 0.28;
        legL.rotation.x = -0.35;
        legR.rotation.x = 0.25;
        const swing = Math.sin(t * 15);
        armR.rotation.set(-1.5 + swing * 0.55, 0, 0);
        armL.rotation.set(-1.1, 0, 0.1);
        if (swing > 0.92 && Math.random() < 0.6) {
          this.tool.getWorldPosition(tmp);
          this.fx.burst('spark', tmp.x, tmp.y, tmp.z - 0.25, 2 + ((Math.random() * 3) | 0), { speed: 0.8 });
        }
      } else if (this.time < this.cheerUntil) {
        b.position.y = Math.abs(Math.sin(t * 9)) * 0.12;
        b.rotation.x = 0;
        armL.rotation.set(-2.9, 0, 0.2);
        armR.rotation.set(-2.9, 0, -0.2);
      } else {
        b.position.y = Math.sin(t * 2) * 0.015;
        b.rotation.x *= 0.8;
        armL.rotation.set(0.05, 0, 0.08);
        armR.rotation.set(-0.05, 0, 0);
      }
    }
  }

  dispose() {
    if (this.toolbox.parent && this.toolbox.parent !== this.arms[0]) this.toolbox.removeFromParent();
    this.root.removeFromParent();
  }
}

export class TechCrew {
  constructor(scene, fx) {
    this.scene = scene;
    this.fx = fx;
    this.active = new Map(); // machineId → Technician
    this.leaving = [];
  }

  arrive(machine, tech) {
    const cur = this.active.get(machine.id);
    if (cur && !cur.leaving) return cur; // repeated event
    const t = new Technician(this.scene, this.fx, machine, tech);
    this.active.set(machine.id, t);
    return t;
  }

  #pick(machineId, prefer) {
    if (machineId != null) return this.active.get(machineId) || null;
    const list = [...this.active.values()];
    if (!list.length) return null;
    return list.find(prefer) || list[list.length - 1];
  }

  work(on, machineId) {
    const t = this.#pick(machineId, (x) => x.working !== !!on);
    t?.setWork(on);
  }

  leave(machineId) {
    const t = this.#pick(machineId, (x) => !x.working);
    if (!t) return;
    t.leave();
    this.active.delete(t.machineId);
    this.leaving.push(t);
  }

  // Part installed: the tech cheers.
  replaced(machineId) {
    this.active.get(machineId)?.cheer();
  }

  positions(out = []) {
    out.length = 0;
    for (const t of this.active.values()) out.push(t.root.position);
    for (const t of this.leaving) out.push(t.root.position);
    return out;
  }

  get(machineId) {
    return this.active.get(machineId) || null;
  }

  any() {
    return this.active.values().next().value || null;
  }

  reset() {
    for (const t of this.active.values()) t.dispose();
    for (const t of this.leaving) t.dispose();
    this.active.clear();
    this.leaving = [];
  }

  update(dt, t) {
    for (const tech of this.active.values()) tech.update(dt, t);
    for (const tech of this.leaving) tech.update(dt, t);
    if (this.leaving.some((x) => x.gone)) {
      for (const x of this.leaving) if (x.gone) x.dispose();
      this.leaving = this.leaving.filter((x) => !x.gone);
    }
  }
}
