// Wrench-bot: hops between places, bobs while idle, types at the terminal,
// scans machines with an eye beam, carries crates overhead and shows a "?"
// thought bubble while thinking.

import * as THREE from 'three';
import { C, lam, box, boxC, glowMat, clamp, angleDelta, easeOutBack, smooth } from './palette.js';

const tmpA = new THREE.Vector3();
const camRight = new THREE.Vector3();
const CARRY_POS = new THREE.Vector3(0, 1.47, 0); // crate sits on the head (robot-local)
const COL = {
  tipThink: new THREE.Color('#ffd75e'), tipThinkOff: new THREE.Color('#5c4a1a'),
  tip: new THREE.Color(C.red), tipBlink: new THREE.Color('#ff7a85'),
  chest: new THREE.Color(C.f1), chestOff: new THREE.Color('#3c6a78'),
};

export class Robot {
  constructor(scene, camera, start) {
    this.scene = scene;
    this.camera = camera;
    this.root = new THREE.Group();
    this.root.name = 'robot';
    scene.add(this.root);
    this.#build();
    this.#question();
    this.#scanBeam();

    this.root.scale.setScalar(1.25);
    this.root.position.set(start.x, 0, start.z);
    this.target = new THREE.Vector3(start.x, 0, start.z); // current waypoint
    this.queue = []; // waypoints after the current one
    this.yaw = start.yaw ?? 0;
    this.targetYaw = this.yaw;
    this.speed = 4;
    this.walkPhase = 0;
    this.moving = false;
    this.place = { kind: 'home', id: 'home' };
    this.arrivedAt = 0;
    this.time = 0;
    this.thinking = false;
    this.qk = 0; // "?" pop animation
    this.look = 0;
    this.lookTarget = 0;
    this.nextLook = 3;
    this.blinkAt = 2;
    this.scanUntil = 0;
    this.scanSpot = null; // { x, z } of the machine being scanned
    this.carrying = null; // Crate held overhead
    this.crateAnim = null;
    this.onArrive = null; // (place) => void
  }

  #build() {
    const r = this.root;
    const yellow = lam(C.yellow);
    const dark = lam(C.n1);
    // feet
    this.feet = [-0.17, 0.17].map((x) => {
      const f = new THREE.Group();
      f.position.set(x, 0, 0);
      r.add(f);
      box(f, 0.22, 0.13, 0.32, dark, 0, 0, 0.02);
      box(f, 0.12, 0.2, 0.12, lam(C.n3), 0, 0.12, 0);
      return f;
    });
    this.body = new THREE.Group();
    r.add(this.body);
    const b = this.body;
    box(b, 0.74, 0.62, 0.56, yellow, 0, 0.3, 0);
    box(b, 0.46, 0.3, 0.03, lam(C.orange), 0, 0.42, 0.28, false);
    this.chest = box(b, 0.1, 0.1, 0.03, glowMat(C.f1), 0.15, 0.76, 0.285, false, false);
    box(b, 0.46, 0.44, 0.14, lam(C.n3), 0, 0.38, -0.34);
    box(b, 0.18, 0.1, 0.18, dark, 0, 0.92, 0);
    // head
    this.head = new THREE.Group();
    this.head.position.y = 1.0;
    b.add(this.head);
    const h = this.head;
    box(h, 0.66, 0.46, 0.52, lam(C.s1), 0, 0, 0);
    box(h, 0.54, 0.27, 0.03, lam(C.n0), 0, 0.1, 0.26, false);
    this.eyeMat = glowMat('#8fe3ff');
    this.eyes = new THREE.Group();
    this.eyes.position.set(0, 0.235, 0.285);
    h.add(this.eyes);
    boxC(this.eyes, 0.1, 0.12, 0.03, this.eyeMat, -0.13, 0, 0, false, false);
    boxC(this.eyes, 0.1, 0.12, 0.03, this.eyeMat, 0.13, 0, 0, false, false);
    for (const x of [-0.35, 0.35]) box(h, 0.06, 0.16, 0.18, lam(C.orange), x, 0.14, 0);
    box(h, 0.05, 0.22, 0.05, lam(C.n3), 0, 0.46, 0);
    this.tipMat = glowMat(C.red);
    box(h, 0.12, 0.12, 0.12, this.tipMat, 0, 0.68, 0, false, false);
    // arms (pivot at the shoulder)
    const armM = lam('#d9b672');
    this.arms = [-0.45, 0.45].map((x) => {
      const a = new THREE.Group();
      a.position.set(x, 0.86, 0);
      b.add(a);
      boxC(a, 0.14, 0.4, 0.14, armM, 0, -0.2, 0);
      boxC(a, 0.17, 0.15, 0.17, lam(C.n3), 0, -0.45, 0);
      return a;
    });
    // the wrench
    const w = new THREE.Group();
    w.position.set(0, -0.47, 0.06);
    this.arms[1].add(w);
    const steel = lam('#c3cad6');
    boxC(w, 0.07, 0.07, 0.42, steel, 0, 0, 0.2);
    boxC(w, 0.24, 0.08, 0.08, steel, 0, 0, 0.43);
    boxC(w, 0.06, 0.08, 0.14, steel, -0.09, 0, 0.52);
    boxC(w, 0.06, 0.08, 0.14, steel, 0.09, 0, 0.52);
    r.traverse((o) => {
      if (o.isMesh && o.material.isMeshStandardMaterial) o.castShadow = true;
    });
  }

  // "?" thought bubble: a camera-facing sprite drawn on a canvas (smooth at any zoom).
  #question() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(20,24,32,0.35)';
    g.beginPath();
    g.arc(132, 124, 104, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ffd34d';
    g.strokeStyle = '#1d2129';
    g.lineWidth = 12;
    g.beginPath();
    g.arc(128, 118, 100, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.beginPath(); // little tail
    g.moveTo(92, 200);
    g.lineTo(70, 248);
    g.lineTo(130, 214);
    g.closePath();
    g.fill();
    g.stroke();
    g.fillStyle = '#ffd34d';
    g.beginPath();
    g.arc(128, 118, 92, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#1d2129';
    g.font = '900 150px system-ui, -apple-system, "Segoe UI", Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('?', 128, 126);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, toneMapped: false }));
    sprite.scale.setScalar(0.95);
    sprite.renderOrder = 10;
    this.q = new THREE.Group();
    this.q.add(sprite);
    this.q.visible = false;
    this.scene.add(this.q);
  }

  #scanBeam() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    const mat = glowMat('#8fe3ff', { transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
    this.beam = new THREE.Mesh(geo, mat);
    this.beam.frustumCulled = false;
    this.beam.visible = false;
    this.beam.renderOrder = 3;
    this.scene.add(this.beam);
  }

  // place = { kind: 'home'|'terminal'|'dock'|'machine', id, scan?: {x, z} }
  // via = optional [[x, z], ...] waypoints walked through on the way
  goTo(x, z, yaw, place, via = null) {
    const pts = [...(via || []).map(([vx, vz]) => new THREE.Vector3(vx, 0, vz)), new THREE.Vector3(x, 0, z)];
    let dist = 0;
    let prev = this.root.position;
    for (const v of pts) {
      dist += Math.hypot(v.x - prev.x, v.z - prev.z);
      prev = v;
    }
    this.target.copy(pts.shift());
    this.queue = pts;
    this.targetYaw = yaw;
    // long trips are brisker so every walk takes ≲ 2 s (the agent waits ≤ 2.5 s)
    this.speed = clamp(dist / 1.7, 3.5, 9.5);
    this.place = place;
    this.scanSpot = place.scan || null;
    if (dist < 0.05) {
      this.root.position.x = x;
      this.root.position.z = z;
      this.queue.length = 0;
      this.#arrive();
    }
  }

  teleport(x, z, yaw, place) {
    this.root.position.set(x, 0, z);
    this.target.set(x, 0, z);
    this.queue.length = 0;
    this.yaw = this.targetYaw = yaw;
    this.place = place;
    this.scanSpot = place.scan || null;
    this.moving = false;
  }

  setThinking(on) {
    on = !!on;
    if (on === this.thinking) return;
    this.thinking = on;
    if (on) this.qk = 0;
  }

  #arrive() {
    this.moving = false;
    this.arrivedAt = this.time;
    if (this.place.kind === 'machine') this.scanUntil = this.time + 2.4;
    this.onArrive?.(this.place);
  }

  // Lift a crate onto the head.
  pickUp(crate) {
    if (!crate || this.carrying) return;
    this.carrying = crate;
    crate.state = 'carried';
    this.root.attach(crate.group);
    crate.group.rotation.set(0, 0, 0);
    this.crateAnim = { crate, local: true, from: crate.group.position.clone(), to: CARRY_POS.clone(), t: 0, dur: 0.4, done: null };
  }

  // Put the held crate down at a floor position; `done(crate)` once it lands.
  drop(x, z, done) {
    const c = this.carrying;
    if (!c) return null;
    this.carrying = null;
    this.scene.attach(c.group);
    c.group.rotation.set(0, this.yaw, 0);
    this.crateAnim = { crate: c, local: false, from: c.group.position.clone(), to: new THREE.Vector3(x, 0, z), t: 0, dur: 0.4, done };
    return c;
  }

  // The world removed this crate (part installed, reset).
  forget(crate) {
    if (this.carrying === crate) this.carrying = null;
    if (this.crateAnim?.crate === crate) this.crateAnim = null;
  }

  clearCarry() {
    this.carrying = null;
    this.crateAnim = null;
  }

  get busy() {
    return !!this.crateAnim;
  }

  get atHome() {
    return !this.moving && this.place.kind === 'home';
  }

  get atTerminal() {
    return !this.moving && this.place.kind === 'terminal';
  }

  update(dt, t) {
    this.time += dt;
    const p = this.root.position;
    let dx = this.target.x - p.x;
    let dz = this.target.z - p.z;
    let dist = Math.hypot(dx, dz);
    if (dist < 0.25 && this.queue.length) {
      // round the corner onto the next waypoint
      this.target.copy(this.queue.shift());
      dx = this.target.x - p.x;
      dz = this.target.z - p.z;
      dist = Math.hypot(dx, dz);
    }
    const wasMoving = this.moving;
    if (dist > 0.02) {
      this.moving = true;
      const last = !this.queue.length;
      const v = this.speed * (last && dist < 0.6 ? Math.max(0.4, dist / 0.6) : 1);
      const step = Math.min(dist, v * dt);
      p.x += (dx / dist) * step;
      p.z += (dz / dist) * step;
      const want = Math.atan2(dx, dz);
      this.yaw += angleDelta(this.yaw, want) * Math.min(1, dt * 12);
      this.walkPhase += dt * (6 + this.speed * 1.4);
    } else {
      if (wasMoving) this.#arrive();
      this.yaw += angleDelta(this.yaw, this.targetYaw) * Math.min(1, dt * 8);
    }
    this.root.rotation.y = this.yaw;

    const [armL, armR] = this.arms;
    const [footL, footR] = this.feet;
    const b = this.body;
    const head = this.head;
    let headTilt = 0;
    let headPitch = 0;
    let eyesUp = 0;

    const holding = !!this.carrying || (this.crateAnim && this.crateAnim.local);
    if (this.moving) {
      const s = Math.sin(this.walkPhase);
      b.position.y = Math.abs(s) * (holding ? 0.07 : 0.13);
      b.rotation.x = 0.12;
      footL.position.z = s * 0.14;
      footR.position.z = -s * 0.14;
      footL.position.y = Math.max(0, s) * 0.08;
      footR.position.y = Math.max(0, -s) * 0.08;
      armL.rotation.set(s * 0.7, 0, 0);
      armR.rotation.set(-s * 0.7, 0, 0);
      this.look *= 0.9;
      if (holding) {
        armL.rotation.set(-3.0, 0, 0.22);
        armR.rotation.set(-3.0, 0, -0.22);
      }
    } else {
      b.position.y = Math.sin(t * 2.4) * 0.03;
      b.rotation.x *= 0.85;
      footL.position.set(-0.17, 0, 0);
      footR.position.set(0.17, 0, 0);
      const kind = this.place.kind;
      const sway = Math.sin(t * 1.6) * 0.06;
      if (holding) {
        armL.rotation.set(-3.0, 0, 0.22);
        armR.rotation.set(-3.0, 0, -0.22);
      } else if (this.thinking) {
        armL.rotation.set(sway, 0, 0.05);
        armR.rotation.set(-2.55 + Math.sin(t * 11) * 0.12, 0, 0.45); // scratching its head
        headTilt = 0.2;
        eyesUp = 0.03;
      } else if (kind === 'terminal') {
        armL.rotation.set(-1.25 + Math.sin(t * 17) * 0.12, 0, -0.1);
        armR.rotation.set(-1.25 + Math.sin(t * 17 + 2) * 0.12, 0, 0.1);
        headPitch = 0.12;
      } else if (kind === 'machine' && this.time < this.scanUntil) {
        armL.rotation.set(sway, 0, 0);
        armR.rotation.set(-1.1, 0, 0);
        b.rotation.x = 0.1;
      } else {
        armL.rotation.set(sway, 0, 0.04);
        armR.rotation.set(-sway, 0, -0.04);
      }
      // idle look-around
      if (!this.thinking && kind !== 'terminal' && this.time > this.nextLook) {
        this.lookTarget = this.lookTarget === 0 ? (Math.random() - 0.5) * 1.1 : 0;
        this.nextLook = this.time + 1.5 + Math.random() * 3;
      }
    }
    this.look += ((this.thinking ? 0 : this.lookTarget) - this.look) * Math.min(1, dt * 4);
    head.rotation.set(headPitch, this.moving ? 0 : this.look, headTilt);
    this.eyes.position.y = 0.235 + eyesUp;

    // blink
    if (this.time > this.blinkAt) {
      this.eyes.scale.y = 0.15;
      if (this.time > this.blinkAt + 0.12) {
        this.eyes.scale.y = 1;
        this.blinkAt = this.time + 2 + Math.random() * 3;
      }
    }
    // antenna + chest light
    this.tipMat.color.copy(this.thinking ? ((t * 4) % 1 < 0.5 ? COL.tipThink : COL.tipThinkOff) : (t % 2 < 0.15 ? COL.tipBlink : COL.tip));
    this.chest.material.color.copy((t * 1.5) % 1 < 0.5 ? COL.chest : COL.chestOff);

    this.#updateCrate(dt);
    this.#updateQuestion(dt, t);
    this.#updateBeam(t);
  }

  #updateCrate(dt) {
    const a = this.crateAnim;
    if (!a) return;
    a.t += dt;
    const k = smooth(Math.min(1, a.t / a.dur));
    const g = a.crate.group;
    g.position.lerpVectors(a.from, a.to, k);
    g.position.y += Math.sin(k * Math.PI) * 0.25;
    if (a.t >= a.dur) {
      this.crateAnim = null;
      a.done?.(a.crate);
    }
  }

  #updateQuestion(dt, t) {
    const q = this.q;
    this.qk = clamp(this.qk + (this.thinking ? dt * 3 : -dt * 5), 0, 1);
    q.visible = this.qk > 0.01;
    if (!q.visible) return;
    camRight.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const p = this.root.position;
    const lift = this.carrying ? 0.7 : 0;
    q.position.set(p.x, 2.75 + lift + Math.sin(t * 3) * 0.06 + this.body.position.y, p.z).addScaledVector(camRight, 0.55);
    q.scale.setScalar(this.thinking ? easeOutBack(this.qk) : smooth(this.qk));
  }

  #updateBeam(t) {
    const spot = this.scanSpot;
    const on = !!spot && !this.moving && this.place.kind === 'machine' && (this.thinking || this.time < this.scanUntil);
    this.beam.visible = on;
    if (!on) return;
    this.head.updateWorldMatrix(true, false);
    tmpA.set(0, 0.235, 0.3);
    this.head.localToWorld(tmpA);
    const sx = spot.x + Math.sin(t * 2.6) * 0.95;
    const z = spot.z + 1.3;
    const pos = this.beam.geometry.attributes.position;
    pos.setXYZ(0, tmpA.x, tmpA.y, tmpA.z);
    pos.setXYZ(1, sx, 0.35, z);
    pos.setXYZ(2, sx, 2.3, z);
    pos.needsUpdate = true;
    this.beam.material.opacity = 0.22 + Math.sin(t * 20) * 0.05;
  }

  // label anchor (above the antenna, ignores the hop so bubbles don't jitter)
  topPosition(out) {
    return out.set(this.root.position.x, this.carrying ? 3.05 : 2.4, this.root.position.z);
  }
}
