// Delivery trucks and the crates they drop at the loading dock.
// A truck reverses in from off-screen (ease-out) so it docks exactly
// `etaSeconds` after spawn, slides a crate onto the dock, then drives away.
// Crates stay on the dock until a technician carries one to the machine; the
// world removes it when the part is replaced.

import * as THREE from 'three';
import { C, lam, glow, glowMat, box, boxC, cyl, lerp, clamp, easeOutCubic, easeInQuad, smooth } from './palette.js';
import { LAYOUT } from './environment.js';

const Y = LAYOUT.ground;
const DOCK_ROOT_X = LAYOUT.dock.x + 0.12 + 3.0; // rear bumper just touching the dock
const START_X = 42;
const LEAVE_X = 52;
const Z = LAYOUT.dock.zc;
const DRIVE_IN = 3.0; // seconds of visible approach
const UNLOAD = 2.1; // docked time
const LEAVE = 2.8;

export class Crate {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    const g = this.group;
    const wood = lam(C.wood);
    const dark = lam(C.woodDark);
    box(g, 0.76, 0.66, 0.76, wood, 0, 0, 0);
    for (const [x, z] of [[-0.36, -0.36], [0.36, -0.36], [-0.36, 0.36], [0.36, 0.36]]) box(g, 0.1, 0.68, 0.1, dark, x, 0, z);
    box(g, 0.8, 0.06, 0.12, dark, 0, 0.62, 0);
    box(g, 0.8, 0.08, 0.8, dark, 0, 0.3, 0, false); // band
    box(g, 0.3, 0.2, 0.02, lam(C.f1), 0.12, 0.38, 0.39, false); // shipping label
    box(g, 0.28, 0.02, 0.2, lam(C.s2), -0.15, 0.68, 0.1, false);
    g.traverse((o) => (o.castShadow = true));
    scene.add(g);
    this.state = 'unloading'; // unloading | ready | carried | placed
    this.slot = 0;
    this.claimed = false;
    this.machineId = null;
    this.born = 0;
  }

  dispose() {
    this.group.removeFromParent();
  }
}

class Truck {
  constructor(scene, schedule) {
    this.group = new THREE.Group();
    this.group.position.set(START_X, Y, Z);
    this.group.visible = false;
    scene.add(this.group);
    Object.assign(this, schedule);
    this.lastX = START_X;
    this.unloaded = false;
    this.#build();
  }

  #build() {
    const g = this.group;
    box(g, 5.9, 0.3, 1.5, lam(C.n0), -0.05, 0.45, 0);
    // box trailer
    box(g, 4.2, 2.2, 2.0, lam(C.s1), -0.9, 0.75, 0);
    box(g, 4.22, 0.24, 2.02, lam(C.f3), -0.9, 1.25, 0);
    box(g, 4.24, 0.07, 2.04, lam(C.s2), -0.9, 2.95, 0);
    box(g, 0.9, 0.62, 2.03, lam(C.orange), -0.4, 1.8, 0, false); // parcel logo
    box(g, 0.5, 0.06, 2.04, lam(C.n0), -0.4, 2.1, 0, false);
    // cab
    const cab = lam(C.orange);
    box(g, 1.6, 1.75, 1.95, cab, 2.1, 0.6, 0);
    box(g, 1.62, 0.08, 1.97, lam('#b46f58'), 2.1, 2.35, 0);
    const glass = lam(C.glass);
    box(g, 0.04, 0.6, 1.7, glass, 2.92, 1.55, 0, false);
    box(g, 0.7, 0.55, 1.97, glass, 2.25, 1.6, 0, false);
    box(g, 0.05, 0.5, 1.2, lam(C.n0), 2.92, 0.75, 0, false);
    box(g, 0.16, 0.22, 2.02, lam(C.n1), 2.92, 0.45, 0);
    for (const z of [-0.75, 0.75]) box(g, 0.04, 0.2, 0.26, glow('#fff3c4'), 2.95, 0.92, z, false, false);
    for (const z of [-1.08, 1.08]) box(g, 0.08, 0.28, 0.06, lam(C.n0), 2.6, 1.7, z, false);
    // amber marker / hazard lights on the trailer roof corners
    this.hazard = glowMat('#6b4c12');
    for (const [x, z] of [[-2.9, -0.92], [-2.9, 0.92], [1.05, -0.92], [1.05, 0.92]]) box(g, 0.14, 0.09, 0.14, this.hazard, x, 3.02, z, false, false);
    this.hazOn = new THREE.Color('#ffc64d');
    this.hazOff = new THREE.Color('#6b4c12');
    // wheels
    this.wheels = [];
    for (const x of [-2.35, -1.45, 2.2]) {
      for (const z of [-0.86, 0.86]) {
        const w = new THREE.Group();
        w.position.set(x, 0.42, z);
        g.add(w);
        cyl(w, 0.42, 0.32, lam(C.rubber), 0, 0, 0, 'z', 10);
        boxC(w, 0.44, 0.08, 0.34, lam(C.steel), 0, 0, 0, false);
        this.wheels.push(w);
      }
    }
    g.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
  }

  dispose() {
    this.group.removeFromParent();
  }
}

export class TruckFleet {
  constructor(scene, fx, dockDoor) {
    this.scene = scene;
    this.fx = fx;
    this.door = dockDoor;
    this.trucks = [];
    this.crates = [];
    this.clock = 0;
    this.lastSpawn = { at: -10, eta: -1 };
  }

  spawn(etaSeconds) {
    let eta = Number(etaSeconds);
    if (!Number.isFinite(eta) || eta <= 0) eta = 3;
    eta = clamp(eta, 0.5, 900);
    // the same delivery event handled twice in the same instant is ignored
    if (this.clock - this.lastSpawn.at < 0.15 && Math.abs(eta - this.lastSpawn.eta) < 0.05) return;
    this.lastSpawn = { at: this.clock, eta };
    let arriveAt = this.clock + eta;
    const busy = this.trucks.reduce((m, t) => Math.max(m, t.clearAt), -Infinity);
    if (arriveAt < busy + 1.4) arriveAt = busy + 1.4; // one truck at the dock at a time
    const driveIn = Math.min(DRIVE_IN, arriveAt - this.clock);
    const departAt = arriveAt + UNLOAD;
    this.trucks.push(new Truck(this.scene, {
      startAt: arriveAt - driveIn,
      driveIn,
      arriveAt,
      departAt,
      clearAt: departAt + 1.0,
      goneAt: departAt + LEAVE,
    }));
  }

  #freeSlot() {
    const used = new Set(this.crates.filter((c) => c.state === 'unloading' || c.state === 'ready').map((c) => c.slot));
    for (let i = 0; i < LAYOUT.crateSlots.length; i++) if (!used.has(i)) return i;
    return 0;
  }

  #unload(truck) {
    const c = new Crate(this.scene);
    c.slot = this.#freeSlot();
    c.born = this.clock;
    const [sx, sz] = LAYOUT.crateSlots[c.slot];
    const stacked = this.crates.some((o) => o !== c && (o.state === 'unloading' || o.state === 'ready') && o.slot === c.slot);
    c.from = new THREE.Vector3(LAYOUT.dock.x + 0.6, 0, Z);
    c.to = new THREE.Vector3(sx, stacked ? 0.68 : 0, sz);
    c.t = 0;
    c.group.position.copy(c.from);
    this.crates.push(c);
    truck.unloaded = true;
  }

  // Oldest unclaimed crate on the dock (or still sliding out).
  claimCrate() {
    const c = this.crates.find((c) => !c.claimed && (c.state === 'ready' || c.state === 'unloading'));
    if (c) c.claimed = true;
    return c || null;
  }

  // The dock crate that would arrive next (if a truck is inbound but has not unloaded yet).
  get inbound() {
    return this.trucks.some((t) => !t.unloaded);
  }

  // A delivery is on screen: a truck approaching / at the dock, or a crate sliding out.
  get busy() {
    const now = this.clock;
    return this.trucks.some((t) => now >= t.arriveAt - 3.6 && now < t.departAt + 0.8) || this.crates.some((c) => c.state === 'unloading');
  }

  releaseCrate(c) {
    if (c) c.claimed = false;
  }

  removeCrate(c, poof = true) {
    const i = this.crates.indexOf(c);
    if (i < 0) return;
    this.crates.splice(i, 1);
    if (poof) {
      const p = new THREE.Vector3();
      c.group.getWorldPosition(p);
      this.fx.burst('poof', p.x, p.y + 0.4, p.z, 8, { speed: 0.6 });
    }
    c.dispose();
  }

  reset() {
    for (const t of this.trucks) t.dispose();
    for (const c of this.crates) c.dispose();
    this.trucks = [];
    this.crates = [];
    this.door.setOpen(false);
    this.door.setDocked(false);
  }

  update(dt, t) {
    this.clock += dt;
    const now = this.clock;
    let wantOpen = false;
    let docked = false;
    for (const tr of this.trucks) {
      let x = START_X;
      if (now < tr.startAt) {
        tr.group.visible = false;
      } else if (now < tr.arriveAt) {
        tr.group.visible = true;
        x = lerp(START_X, DOCK_ROOT_X, easeOutCubic((now - tr.startAt) / Math.max(0.01, tr.driveIn)));
        if (tr.arriveAt - now < 1.8) wantOpen = true;
      } else if (now < tr.departAt) {
        tr.group.visible = true;
        x = DOCK_ROOT_X;
        wantOpen = true;
        docked = true;
        if (!tr.unloaded && now >= tr.arriveAt + 0.25) this.#unload(tr);
      } else if (now < tr.goneAt) {
        tr.group.visible = true;
        if (!tr.unloaded) this.#unload(tr);
        const k = (now - tr.departAt) / LEAVE;
        x = lerp(DOCK_ROOT_X, LEAVE_X, easeInQuad(k));
        if (k < 0.3) wantOpen = true;
        if (Math.random() < 0.25) this.fx.emit('dust', x - 2.4, Y + 0.15, Z + (Math.random() < 0.5 ? -0.9 : 0.9));
      } else {
        tr.done = true;
      }
      tr.group.position.x = x;
      const moved = x - tr.lastX;
      tr.lastX = x;
      for (const w of tr.wheels) w.rotation.z -= moved / 0.42;
      const reversing = now >= tr.startAt && now < tr.arriveAt;
      tr.hazard.color.copy(reversing && (t * 3) % 1 < 0.5 ? tr.hazOn : tr.hazOff);
    }
    for (const tr of this.trucks) if (tr.done) tr.dispose();
    if (this.trucks.some((tr) => tr.done)) this.trucks = this.trucks.filter((tr) => !tr.done);

    // crates sliding out of the trailer onto the dock
    for (const c of this.crates) {
      if (c.state !== 'unloading') continue;
      c.t += dt;
      const k = clamp(c.t / 0.9, 0, 1);
      c.group.position.lerpVectors(c.from, c.to, smooth(k));
      c.group.position.y += Math.sin(k * Math.PI) * 0.3;
      wantOpen = true;
      if (k >= 1) {
        c.state = 'ready';
        this.fx.burst('dust', c.to.x, 0.05, c.to.z, 5);
      }
    }
    this.door.setOpen(wantOpen);
    this.door.setDocked(docked);
  }
}
