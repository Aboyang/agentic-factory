// Static factory building plus the few props that animate: procurement
// terminal screen, loading-dock roll-up door, staff door, wall clock and the
// robot's charging pad. Layout constants live in LAYOUT so the actors agree on
// where things are.

import * as THREE from 'three';
import { C, LAMP, lam, glow, glowMat, box, boxC, cyl, canvasTex, boxGeo, clamp, softGlowTexture } from './palette.js';

export const FOG = '#1f2430'; // yard fades into this (scene background + fog)

export const LAYOUT = {
  floor: { x0: -11.9, x1: 12.3, z0: -4.9, z1: 7.9 },
  ground: -0.9, // outside yard level (truck bed = dock floor)
  home: { x: 0, z: 5.0 },
  terminal: { x: -9.3, z: 3.3, yaw: Math.atan2(1, 0.55) },
  dock: { x: 12.15, z0: 4.2, z1: 7.4, zc: 5.8 },
  robotDock: { x: 8.9, z: 2.95 },
  crateSlots: [[9.6, 5.25], [9.6, 6.4], [8.65, 6.4], [8.65, 5.25]],
  staffDoor: { x: 6.6, z: 7.75 },
  // technician route from the street, up the steps, through the staff door
  techEntry: [[6.6, -0.9, 11.2], [6.6, -0.9, 9.15], [6.6, -0.6, 8.65], [6.6, -0.3, 8.15], [6.6, 0, 7.6], [6.6, 0, 6.8]],
  aisleZ: 3.4,
  zone: { x0: -9.45, x1: 10.65, z0: -1.9, z1: 1.9 },
};

export function buildEnvironment(scene) {
  const env = new THREE.Group();
  scene.add(env);
  slabAndYard(env);
  walls(env);
  markings(env);
  props(env);
  const terminal = new Terminal(env);
  const dockDoor = new DockDoor(env);
  const staffDoor = new StaffDoor(env);
  const clock = new WallClock(env);
  const pad = new ChargePad(env);
  return { group: env, terminal, dockDoor, staffDoor, clock, pad };
}

// ─── Floor, yard ─────────────────────────────────────────────────────────────
function slabAndYard(g) {
  const F = LAYOUT.floor;
  const W = F.x1 - F.x0;
  const D = F.z1 - F.z0;
  // Smooth concrete tiles, 2×2 units, slight per-tile variation, thin seams.
  const tex = canvasTex(512, 512, (ctx) => {
    const shades = ['#a2aab7', '#a5adba', '#9ea6b3', '#a8b0bc'];
    for (let ty = 0; ty < 4; ty++) {
      for (let tx = 0; tx < 4; tx++) {
        ctx.fillStyle = shades[(tx * 7 + ty * 3 + tx * ty) % 4];
        ctx.fillRect(tx * 128, ty * 128, 128, 128);
      }
    }
    // faint speckle (deterministic)
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = rnd() < 0.5 ? 'rgba(70,78,94,0.10)' : 'rgba(255,255,255,0.10)';
      const r = 1 + rnd() * 2.5;
      ctx.beginPath();
      ctx.arc(rnd() * 512, rnd() * 512, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#838c9b';
    for (let i = 0; i < 4; i++) {
      ctx.fillRect(i * 128, 0, 3, 512);
      ctx.fillRect(0, i * 128, 512, 3);
    }
  }, [W / 8, D / 8], 1);
  const top = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.82, metalness: 0 });
  const side = lam('#6d778b');
  const slab = new THREE.Mesh(boxGeo(W, 0.9, D), [side, side, top, side, side, side]);
  slab.position.set((F.x0 + F.x1) / 2, -0.45, (F.z0 + F.z1) / 2);
  slab.receiveShadow = true;
  g.add(slab);
  // dark kerb band at the base of the slab
  box(g, W + 0.04, 0.18, 0.04, lam(C.n1), slab.position.x, -0.9, F.z1 + 0.01, false, false);

  // Yard: a large plane with a soft radial gradient that fades into the fog.
  const yardTex = canvasTex(256, 256, (ctx) => {
    const grad = ctx.createRadialGradient(128, 128, 6, 128, 128, 128);
    grad.addColorStop(0, '#3b4354');
    grad.addColorStop(0.3, '#2d3443');
    grad.addColorStop(0.75, '#232935');
    grad.addColorStop(1, FOG);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);
  }, [1, 1], 1);
  yardTex.wrapS = yardTex.wrapT = THREE.ClampToEdgeWrapping;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(220, 220), new THREE.MeshStandardMaterial({ map: yardTex, roughness: 0.95, metalness: 0 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(4, -0.905, 4);
  ground.receiveShadow = true;
  g.add(ground);
  const apron = new THREE.Mesh(new THREE.PlaneGeometry(70, 6.8), lam(C.asphalt));
  apron.rotation.x = -Math.PI / 2;
  apron.position.set(F.x1 + 35, -0.9, LAYOUT.dock.zc);
  apron.receiveShadow = true;
  g.add(apron);
  const lineM = lam('#b8a46a');
  for (const z of [LAYOUT.dock.z0 - 0.1, LAYOUT.dock.z1 + 0.1]) box(g, 7, 0.01, 0.1, lineM, F.x1 + 3.6, -0.9, z, false);
  for (let x = F.x1 + 9; x < 60; x += 2.4) box(g, 1.2, 0.01, 0.1, lam('#4c566a'), x, -0.9, LAYOUT.dock.zc, false);
  // bollards + yard light by the dock
  const yel = lam(C.yellow);
  for (const z of [LAYOUT.dock.z0 - 0.55, LAYOUT.dock.z1 + 0.55]) {
    box(g, 0.22, 0.8, 0.22, yel, F.x1 + 0.45, -0.9, z);
    box(g, 0.24, 0.1, 0.24, lam(C.n0), F.x1 + 0.45, -0.6, z, false);
  }
  box(g, 0.14, 4.6, 0.14, lam(C.n3), F.x1 + 0.6, -0.9, 2.6);
  box(g, 0.7, 0.12, 0.3, lam(C.n1), F.x1 + 0.35, 3.7, 2.6);
  box(g, 0.5, 0.04, 0.2, glow('#fff4d0'), F.x1 + 0.35, 3.66, 2.6, false, false);
}

// ─── Walls ──────────────────────────────────────────────────────────────────
function walls(g) {
  const F = LAYOUT.floor;
  const H = 5;
  const ribs = (len) => new THREE.MeshStandardMaterial({
    roughness: 0.6,
    metalness: 0.15,
    map: canvasTex(4, 1, (ctx) => {
      ['#8a95aa', '#8a95aa', '#78849b', '#9aa4b7'].forEach((c, i) => {
        ctx.fillStyle = c;
        ctx.fillRect(i, 0, 1, 1);
      });
    }, [len / 0.6, 1]),
  });
  const concrete = lam('#7c8599');
  const trim = lam(C.n1);
  const zb = F.z0; // back wall outer face
  const xl = F.x0; // left wall outer face
  const backLen = F.x1 - F.x0;
  const leftLen = F.z1 - F.z0;

  // back wall (z = -4.6 inner face)
  box(g, backLen, 1.2, 0.3, concrete, (F.x0 + F.x1) / 2, 0, zb + 0.15);
  box(g, backLen, H - 1.2, 0.3, ribs(backLen), (F.x0 + F.x1) / 2, 1.2, zb + 0.15);
  box(g, backLen, 0.16, 0.42, trim, (F.x0 + F.x1) / 2, H, zb + 0.18);
  box(g, backLen, 0.08, 0.06, lam(C.yellow), (F.x0 + F.x1) / 2, 1.16, zb + 0.32, false); // safety band
  // left wall (x = -11.6 inner face)
  box(g, 0.3, 1.2, leftLen, concrete, xl + 0.15, 0, (F.z0 + F.z1) / 2);
  box(g, 0.3, H - 1.2, leftLen, ribs(leftLen), xl + 0.15, 1.2, (F.z0 + F.z1) / 2);
  box(g, 0.42, 0.16, leftLen, trim, xl + 0.18, H, (F.z0 + F.z1) / 2);
  box(g, 0.06, 0.08, leftLen, lam(C.yellow), xl + 0.32, 1.16, (F.z0 + F.z1) / 2, false);

  // pilasters
  const pil = lam('#5d6880');
  for (const x of [-6, -2, 2, 6, 10]) box(g, 0.42, H, 0.24, pil, x, 0, zb + 0.42);
  for (const z of [-1.2, 2.8]) box(g, 0.24, H, 0.42, pil, xl + 0.42, 0, z);

  // windows on the back wall
  for (const x of [-8, -4, 4, 8]) backWindow(g, x, 3.25, zb + 0.3);
  sideWindow(g, xl + 0.3, 3.25, 0.8);

  // pipes along the top
  const pipe = lam(C.f2);
  cyl(g, 0.1, backLen, pipe, (F.x0 + F.x1) / 2, 4.45, zb + 0.55, 'x', 6);
  cyl(g, 0.08, backLen, lam(C.yellow), (F.x0 + F.x1) / 2, 4.15, zb + 0.5, 'x', 6);
  cyl(g, 0.1, leftLen, pipe, xl + 0.55, 4.45, (F.z0 + F.z1) / 2, 'z', 6);
  for (const x of [-10.8, -4, 3, 10.4]) box(g, 0.08, 0.5, 0.3, trim, x, 4.0, zb + 0.45, false);

  // near walls: cut low (dollhouse style) so the floor stays visible
  const cut = lam('#7c8599');
  const cap = lam(C.n1);
  const D = LAYOUT.dock;
  const sd = LAYOUT.staffDoor;
  const lowH = 0.5;
  const frontSeg = (a, b) => {
    box(g, b - a, lowH, 0.3, cut, (a + b) / 2, 0, F.z1 - 0.15);
    box(g, b - a, 0.06, 0.32, cap, (a + b) / 2, lowH, F.z1 - 0.15, false);
  };
  frontSeg(F.x0, sd.x - 0.7);
  frontSeg(sd.x + 0.7, F.x1);
  const rightSeg = (a, b) => {
    box(g, 0.3, lowH, b - a, cut, F.x1 - 0.15, 0, (a + b) / 2);
    box(g, 0.32, 0.06, b - a, cap, F.x1 - 0.15, lowH, (a + b) / 2, false);
  };
  rightSeg(F.z0, D.z0 - 0.15);
  rightSeg(D.z1 + 0.15, F.z1);
}

function backWindow(g, x, y, z) {
  const frame = lam(C.n0);
  box(g, 2.3, 1.7, 0.12, frame, x, y - 0.85, z + 0.02);
  const top = glow('#d9efff');
  const bot = glow('#a7d3f2');
  for (const dx of [-0.53, 0.53]) {
    boxC(g, 0.98, 0.72, 0.04, top, x + dx, y + 0.39, z + 0.1, false, false);
    boxC(g, 0.98, 0.72, 0.04, bot, x + dx, y - 0.39, z + 0.1, false, false);
  }
  box(g, 2.5, 0.1, 0.26, lam(C.s0), x, y - 0.95, z + 0.1);
}

function sideWindow(g, x, y, z) {
  box(g, 0.12, 1.7, 2.3, lam(C.n0), x + 0.02, y - 0.85, z);
  for (const dz of [-0.53, 0.53]) {
    boxC(g, 0.04, 0.72, 0.98, glow('#d9efff'), x + 0.1, y + 0.39, z + dz, false, false);
    boxC(g, 0.04, 0.72, 0.98, glow('#a7d3f2'), x + 0.1, y - 0.39, z + dz, false, false);
  }
  box(g, 0.26, 0.1, 2.5, lam(C.s0), x + 0.1, y - 0.95, z);
}

// ─── Floor markings ─────────────────────────────────────────────────────────
function markings(g) {
  const Z = LAYOUT.zone;
  const blocks = [];
  hazardRect(g, Z.x0, Z.z0, Z.x1, Z.z1, 0.3, blocks);
  const D = LAYOUT.dock;
  hazardRect(g, 8.0, D.z0 - 0.15, LAYOUT.floor.x1 - 0.3, D.z1 + 0.15, 0.22, blocks, ['right']);
  const inst = new THREE.InstancedMesh(boxGeo(1, 1, 1), lam(C.yellow), blocks.length);
  const m = new THREE.Matrix4();
  blocks.forEach((b, i) => {
    m.makeScale(b.w, 0.022, b.d);
    m.setPosition(b.x, 0.016, b.z);
    inst.setMatrixAt(i, m);
  });
  inst.receiveShadow = true;
  g.add(inst);

  // walkway edge lines
  const line = lam('#e3c45c');
  box(g, 14.0, 0.012, 0.1, line, -2.0, 0, 6.55, false);
  box(g, 0.1, 0.012, 2.6, line, -9.0, 0, 5.25, false);
  // terminal mat
  const t = LAYOUT.terminal;
  const mat = box(g, 2.3, 0.02, 2.0, lam('#2b3442'), t.x + 0.45, 0, t.z + 0.25, false);
  mat.rotation.y = t.yaw;
  // stencil arrows on the aisle, pointing toward the dock
  const arrow = lam('#7f8a9e');
  for (const x of [-4, 2]) {
    box(g, 0.9, 0.012, 0.12, arrow, x, 0, 4.9, false);
    const a1 = box(g, 0.4, 0.012, 0.1, arrow, x + 0.33, 0, 4.78, false);
    a1.rotation.y = -0.7;
    const a2 = box(g, 0.4, 0.012, 0.1, arrow, x + 0.33, 0, 5.02, false);
    a2.rotation.y = 0.7;
  }
}

// Black strip with yellow blocks every 0.8 (instanced later). `skip` omits sides.
function hazardRect(g, x0, z0, x1, z1, w, blocks, skip = []) {
  const black = lam('#1e2128');
  const sides = [
    ['front', x0, z1, x1, z1], ['back', x0, z0, x1, z0],
    ['left', x0, z0, x0, z1], ['right', x1, z0, x1, z1],
  ];
  for (const [name, ax, az, bx, bz] of sides) {
    if (skip.includes(name)) continue;
    const horiz = az === bz;
    const len = horiz ? bx - ax + w : bz - az + w;
    box(g, horiz ? len : w, 0.014, horiz ? w : len, black, (ax + bx) / 2, 0, (az + bz) / 2, false);
    const n = Math.floor(len / 0.8);
    for (let i = 0; i < n; i++) {
      const s = -len / 2 + 0.2 + i * 0.8 + 0.2;
      blocks.push(horiz
        ? { x: (ax + bx) / 2 + s, z: az, w: 0.4, d: w }
        : { x: ax, z: (az + bz) / 2 + s, w, d: 0.4 });
    }
  }
}

// ─── Props ──────────────────────────────────────────────────────────────────
function props(g) {
  racking(g, -11.25, -4.05);
  rawPallet(g, -10.5, -2.2);
  forklift(g, 10.2, -3.1);
  lockers(g);
  // fire extinguisher + sign on the left wall
  const xl = LAYOUT.floor.x0 + 0.3;
  box(g, 0.22, 0.55, 0.22, lam(C.red), xl + 0.14, 0.55, 1.9);
  box(g, 0.1, 0.12, 0.12, lam(C.n0), xl + 0.14, 1.1, 1.9, false);
  box(g, 0.04, 0.36, 0.36, glow('#d65b5b'), xl + 0.03, 1.55, 1.9, false, false);
  // electrical panel with conduit
  box(g, 0.2, 1.2, 0.9, lam('#c3cad6'), xl + 0.1, 1.1, -2.6);
  box(g, 0.03, 0.26, 0.3, lam(C.yellow), xl + 0.21, 1.9, -2.6, false);
  box(g, 0.03, 0.06, 0.06, glow(LAMP.green), xl + 0.21, 1.25, -2.3, false, false);
  cyl(g, 0.07, 2.1, lam(C.f2), xl + 0.55, 3.4, -2.6, 'y', 6); // conduit up to the pipe
  // cones by the dock
  for (const [x, z] of [[11.55, 3.75], [11.55, 7.75]]) {
    box(g, 0.34, 0.06, 0.34, lam(C.n0), x, 0, z, false);
    box(g, 0.22, 0.2, 0.22, lam(C.orange), x, 0.06, z);
    box(g, 0.14, 0.18, 0.14, lam(C.s2), x, 0.26, z);
    box(g, 0.08, 0.1, 0.08, lam(C.orange), x, 0.44, z);
  }
  // bin next to the terminal
  box(g, 0.45, 0.6, 0.45, lam('#3f5a52'), -10.9, 0, 1.4);
  box(g, 0.5, 0.06, 0.5, lam(C.n0), -10.9, 0.6, 1.4, false);
}

function racking(g, x0, z) {
  const up = lam(C.orange);
  const beam = lam(C.f3);
  const deck = lam(C.n2);
  const span = 2.9;
  for (const x of [x0, x0 + span / 2, x0 + span]) for (const dz of [-0.4, 0.4]) box(g, 0.1, 3.1, 0.1, up, x, 0, z + dz);
  const levels = [0.95, 1.95, 2.9];
  for (const y of levels) {
    for (const dz of [-0.4, 0.4]) box(g, span + 0.1, 0.12, 0.08, beam, x0 + span / 2, y, z + dz);
    box(g, span, 0.04, 0.8, deck, x0 + span / 2, y + 0.12, z, false);
  }
  // stock on the shelves (spare parts — mostly empty, which is the point)
  const cb = lam(C.cardboard);
  const bin = lam(C.f3);
  const crate = lam(C.wood);
  const stock = [
    [0.25, 0, 0.6, 0.5, cb], [1.0, 0, 0.5, 0.4, bin], [2.2, 0, 0.7, 0.6, crate],
    [0.35, 1, 0.5, 0.35, bin], [0.95, 1, 0.5, 0.35, bin], [2.4, 1, 0.55, 0.45, cb],
    [0.5, 2, 0.6, 0.45, cb], [1.7, 2, 0.45, 0.3, bin],
  ];
  for (const [dx, lvl, w, h, m] of stock) box(g, w, h, 0.62, m, x0 + 0.1 + dx, levels[lvl] + 0.16, z);
  // floor level: pallet with a wrapped load
  box(g, 1.2, 0.14, 0.9, lam(C.woodDark), x0 + 0.75, 0, z);
  box(g, 1.1, 0.7, 0.8, lam('#cfd6e0'), x0 + 0.75, 0.14, z);
}

function rawPallet(g, x, z) {
  box(g, 1.3, 0.14, 1.1, lam(C.woodDark), x, 0, z);
  box(g, 1.3, 0.05, 1.1, lam(C.wood), x, 0.14, z);
  const raw = lam(C.f2);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < (i === 2 && j === 1 ? 1 : 2); k++) {
    box(g, 0.38, 0.3, 0.38, raw, x - 0.42 + i * 0.42, 0.19 + k * 0.3, z - 0.22 + j * 0.44);
  }
}

function forklift(g, x, z) {
  const f = new THREE.Group();
  f.position.set(x, 0, z);
  f.rotation.y = 0.35;
  g.add(f);
  const body = lam(C.yellow);
  const dark = lam(C.n0);
  box(f, 1.3, 0.62, 0.95, body, 0.1, 0.25, 0);
  box(f, 0.35, 0.75, 0.95, lam(C.n2), 0.85, 0.2, 0); // counterweight
  box(f, 0.45, 0.12, 0.5, dark, 0.25, 0.87, 0); // seat
  box(f, 0.12, 0.45, 0.45, dark, 0.48, 0.9, 0);
  for (const [dx, dz] of [[-0.45, -0.45], [-0.45, 0.45], [0.75, -0.45], [0.75, 0.45]]) box(f, 0.07, 1.45, 0.07, dark, dx, 0.87, dz);
  box(f, 1.35, 0.07, 1.0, dark, 0.15, 2.3, 0);
  box(f, 0.07, 0.35, 0.07, dark, -0.25, 0.87, 0); // steering column
  box(f, 0.3, 0.04, 0.3, dark, -0.25, 1.2, 0);
  for (const dz of [-0.3, 0.3]) box(f, 0.08, 2.1, 0.08, lam(C.n3), -0.62, 0.05, dz);
  box(f, 0.1, 0.3, 0.7, lam(C.n3), -0.66, 0.15, 0);
  for (const dz of [-0.22, 0.22]) box(f, 0.9, 0.05, 0.12, lam(C.steel), -1.1, 0.06, dz);
  for (const [dx, dz] of [[-0.35, -0.5], [-0.35, 0.5], [0.65, -0.5], [0.65, 0.5]]) cyl(f, 0.22, 0.18, lam(C.rubber), dx, 0.22, dz, 'z', 8);
}

function lockers(g) {
  const xl = LAYOUT.floor.x0 + 0.3;
  const m = [lam(C.f3), lam('#56769d')];
  for (let i = 0; i < 4; i++) {
    const z = 4.65 + i * 0.56;
    box(g, 0.5, 2.0, 0.54, m[i % 2], xl + 0.25, 0, z);
    box(g, 0.02, 0.14, 0.3, lam(C.n1), xl + 0.51, 1.6, z, false);
    box(g, 0.03, 0.12, 0.04, lam(C.s0), xl + 0.51, 1.0, z + 0.18, false);
  }
  box(g, 0.4, 0.08, 2.2, lam(C.wood), xl + 0.9, 0.42, 5.5); // bench
  for (const dz of [-0.9, 0.9]) box(g, 0.3, 0.42, 0.08, lam(C.n1), xl + 0.9, 0, 5.5 + dz);
}

// ─── Procurement terminal ───────────────────────────────────────────────────
const SCREEN_RES = 6; // screen canvas supersampling (drawn in 40×26 logical px)
class Terminal {
  constructor(g) {
    const T = LAYOUT.terminal;
    this.group = new THREE.Group();
    this.group.position.set(T.x, 0, T.z);
    this.group.rotation.y = T.yaw;
    g.add(this.group);
    const t = this.group;
    box(t, 1.1, 0.95, 0.65, lam(C.f3), 0, 0, -0.05);
    box(t, 1.12, 0.12, 0.67, lam(C.n1), 0, 0, -0.05, false);
    box(t, 0.7, 0.4, 0.02, lam('#526f96'), 0, 0.3, 0.28, false);
    box(t, 1.25, 0.07, 0.8, lam(C.s0), 0, 0.95, 0);
    box(t, 0.72, 0.04, 0.24, lam(C.n1), -0.05, 1.02, 0.16);
    box(t, 0.12, 0.45, 0.12, lam(C.n1), 0, 1.02, -0.22);
    // payment card reader (Reap)
    box(t, 0.22, 0.09, 0.3, lam(C.n0), 0.46, 1.02, 0.12);
    this.payLed = box(t, 0.08, 0.03, 0.08, glowMat(LAMP.green), 0.46, 1.11, 0.04, false, false);
    this.ledIdle = new THREE.Color(LAMP.green);
    this.ledBusy = new THREE.Color(LAMP.amber);
    // monitor
    const mon = new THREE.Group();
    mon.position.set(0, 1.78, -0.2);
    mon.rotation.x = -0.12;
    t.add(mon);
    boxC(mon, 1.18, 0.82, 0.12, lam(C.n0), 0, 0, 0);
    this.canvas = document.createElement('canvas');
    this.canvas.width = 40 * SCREEN_RES;
    this.canvas.height = 26 * SCREEN_RES;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.04, 0.68), new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false }));
    screen.position.z = 0.065;
    mon.add(screen);
    // lit header sign
    boxC(mon, 1.18, 0.16, 0.14, glow(C.f1), 0, 0.52, 0, false, false);
    // soft screen glow on the floor mat (stands in for a light)
    this.glow = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 2.2), new THREE.MeshBasicMaterial({ map: softGlowTexture(), color: '#88d0e0', transparent: true, opacity: 0.2, depthWrite: false, toneMapped: false }));
    this.glow.rotation.x = -Math.PI / 2;
    this.glow.position.set(0, 0.04, 0.75);
    this.glow.renderOrder = 1;
    t.add(this.glow);
    this.active = false;
    this.k = 0; // 0 idle → 1 busy
    this.frame = 0;
    this.acc = 1;
    this.#draw(0);
  }

  // A pixel-art shop UI: product rows, a moving highlight, a checkout bar.
  #draw(t) {
    const c = this.ctx;
    c.setTransform(SCREEN_RES, 0, 0, SCREEN_RES, 0, 0);
    const W = 40;
    const H = 26;
    c.fillStyle = '#0e1822';
    c.fillRect(0, 0, W, H);
    if (!this.active) {
      c.fillStyle = '#88c0d0';
      c.fillRect(0, 0, W, 3);
      // cart icon
      c.fillStyle = '#5e81ac';
      c.fillRect(14, 9, 12, 6);
      c.fillRect(12, 8, 3, 1);
      c.fillStyle = '#88c0d0';
      c.fillRect(15, 17, 2, 2);
      c.fillRect(23, 17, 2, 2);
      if (Math.floor(t * 2) % 2) {
        c.fillStyle = '#a3be8c';
        c.fillRect(18, 21, 4, 1);
      }
      return;
    }
    c.fillStyle = '#88c0d0';
    c.fillRect(0, 0, W, 3);
    c.fillStyle = '#0e1822';
    c.fillRect(2, 1, 8, 1);
    const sel = Math.floor(t * 1.6) % 4;
    const cols = ['#d08770', '#ebcb8b', '#b48ead', '#81a1c1'];
    for (let i = 0; i < 4; i++) {
      const y = 5 + i * 4;
      if (i === sel) {
        c.fillStyle = '#26445a';
        c.fillRect(1, y - 1, W - 2, 4);
      }
      c.fillStyle = cols[i];
      c.fillRect(2, y, 3, 2);
      c.fillStyle = i === sel ? '#eceff4' : '#7b8799';
      c.fillRect(7, y, 10 + ((i * 7) % 9), 1);
      c.fillStyle = '#4c566a';
      c.fillRect(7, y + 1, 6 + ((i * 5) % 7), 1);
      c.fillStyle = '#a3be8c';
      c.fillRect(32, y, 6, 2);
    }
    // checkout progress
    const p = (t * 0.35) % 1;
    c.fillStyle = '#2e3440';
    c.fillRect(2, 22, W - 4, 3);
    c.fillStyle = '#a3be8c';
    c.fillRect(2, 22, Math.round((W - 4) * p), 3);
  }

  update(dt, t, busy) {
    if (busy !== this.active) {
      this.active = busy;
      this.acc = 1;
    }
    this.k += ((busy ? 1 : 0) - this.k) * Math.min(1, dt * 4);
    this.glow.material.opacity = 0.18 + this.k * 0.4;
    this.acc += dt;
    if (this.acc >= (busy ? 0.1 : 0.5)) {
      this.acc = 0;
      this.#draw(t);
      this.tex.needsUpdate = true;
    }
    this.payLed.material.color.copy(busy && Math.floor(t * 4) % 2 ? this.ledBusy : this.ledIdle);
  }
}

// ─── Loading dock roll-up door ──────────────────────────────────────────────
class DockDoor {
  constructor(g) {
    const D = LAYOUT.dock;
    const span = D.z1 - D.z0;
    const H = 3.3;
    this.H = H;
    const postM = lam(C.yellow);
    const band = lam('#1e2128');
    for (const z of [D.z0 - 0.13, D.z1 + 0.13]) {
      box(g, 0.32, H, 0.26, postM, D.x, 0, z);
      for (let y = 0.25; y < H; y += 0.7) box(g, 0.34, 0.25, 0.28, band, D.x, y, z, false);
    }
    box(g, 0.6, 0.55, span + 0.6, lam(C.n3), D.x + 0.05, H, D.zc);
    box(g, 0.62, 0.08, span + 0.62, lam(C.n0), D.x + 0.05, H + 0.55, D.zc, false);
    const slats = canvasTex(1, 4, (ctx) => {
      ['#81a1c1', '#81a1c1', '#6c8cae', '#9bb6d0'].forEach((c, i) => {
        ctx.fillStyle = c;
        ctx.fillRect(0, i, 1, 1);
      });
    }, [1, H / 0.3]);
    this.shutter = new THREE.Mesh(boxGeo(0.08, H, span), new THREE.MeshStandardMaterial({ map: slats, roughness: 0.55, metalness: 0.25 }));
    this.shutter.castShadow = true;
    this.shutter.position.set(D.x, H / 2, D.zc);
    g.add(this.shutter);
    this.bar = boxC(g, 0.14, 0.1, span, lam(C.n0), D.x, 0.05, D.zc);
    // bumpers + leveler
    for (const z of [D.z0 + 0.35, D.z1 - 0.35]) box(g, 0.2, 0.42, 0.3, lam(C.rubber), D.x + 0.25, -0.65, z);
    box(g, 0.9, 0.025, span - 0.3, lam(C.steel), D.x - 0.6, 0, D.zc, false);
    // dock signal light (red = keep out, green = truck docked)
    this.signal = box(g, 0.08, 0.22, 0.16, glowMat(LAMP.red), D.x - 0.18, 2.1, D.z0 - 0.13, false, false);
    this.open = 0;
    this.target = 0;
    this.docked = false;
  }

  setOpen(on) {
    this.target = on ? 1 : 0;
  }

  setDocked(on) {
    if (on === this.docked) return;
    this.docked = on;
    this.signal.material.color.set(on ? LAMP.green : LAMP.red);
  }

  update(dt) {
    const d = this.target - this.open;
    this.open += clamp(d, -dt * 1.1, dt * 1.1);
    const h = this.H * (1 - this.open * 0.93);
    this.shutter.scale.y = h / this.H;
    this.shutter.position.y = this.H - h / 2;
    this.bar.position.y = this.H - h + 0.05;
  }
}

// ─── Staff entrance ─────────────────────────────────────────────────────────
class StaffDoor {
  constructor(g) {
    const S = LAYOUT.staffDoor;
    const F = LAYOUT.floor;
    const frame = lam(C.n3);
    box(g, 0.16, 2.55, 0.36, frame, S.x - 0.72, 0, S.z);
    box(g, 0.16, 2.55, 0.36, frame, S.x + 0.72, 0, S.z);
    box(g, 1.6, 0.22, 0.36, frame, S.x, 2.55, S.z);
    box(g, 0.66, 0.26, 0.1, lam(C.n0), S.x, 2.8, S.z + 0.05, false);
    box(g, 0.56, 0.18, 0.04, glow('#7fd67a'), S.x, 2.84, S.z + 0.1, false, false);
    this.pivot = new THREE.Group();
    this.pivot.position.set(S.x - 0.62, 0, S.z);
    g.add(this.pivot);
    box(this.pivot, 1.22, 2.42, 0.07, lam(C.f3), 0.61, 0.02, 0);
    box(this.pivot, 0.42, 0.5, 0.09, glow('#a7d3f2'), 0.61, 1.45, 0, false, false);
    box(this.pivot, 0.06, 0.06, 0.16, lam(C.s0), 1.05, 1.05, 0, false);
    // steps down to the street + railing
    const step = lam('#4a5263');
    box(g, 1.5, 0.6, 0.5, step, S.x, -0.9, F.z1 + 0.25);
    box(g, 1.5, 0.3, 0.5, step, S.x, -0.9, F.z1 + 0.75);
    const rail = lam(C.yellow);
    box(g, 0.07, 1.0, 0.07, rail, S.x + 0.82, -0.3, F.z1 + 0.1);
    box(g, 0.07, 1.0, 0.07, rail, S.x + 0.82, -0.9, F.z1 + 1.0);
    const r = box(g, 0.06, 0.06, 1.15, rail, S.x + 0.82, 0.38, F.z1 + 0.55, false);
    r.rotation.x = 0.59;
    this.open = 0;
  }

  update(dt, positions) {
    const S = LAYOUT.staffDoor;
    let want = 0;
    for (const p of positions) {
      if (Math.hypot(p.x - S.x, p.z - S.z) < 1.7) want = 1;
    }
    this.open += clamp(want - this.open, -dt * 3, dt * 4);
    this.pivot.rotation.y = this.open * 1.45;
  }
}

// ─── Wall clock (shows the shift clock when the director feeds it) ──────────
class WallClock {
  constructor(g) {
    const z = LAYOUT.floor.z0 + 0.32;
    const c = new THREE.Group();
    c.position.set(0, 3.45, z);
    g.add(c);
    cyl(c, 0.58, 0.1, lam(C.n0), 0, 0, 0.05, 'z', 12);
    cyl(c, 0.5, 0.1, lam(C.s2), 0, 0, 0.08, 'z', 12);
    const mark = lam(C.n1);
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      boxC(c, 0.06, 0.12, 0.04, mark, Math.sin(a) * 0.4, Math.cos(a) * 0.4, 0.15, false);
    }
    const hand = (len, w, color) => {
      const p = new THREE.Group();
      p.position.z = 0.17;
      boxC(p, w, len, 0.03, lam(color), 0, len / 2 - 0.04, 0, false);
      c.add(p);
      return p;
    };
    this.hour = hand(0.26, 0.07, C.n0);
    this.minute = hand(0.38, 0.05, C.n1);
    boxC(c, 0.08, 0.08, 0.05, lam(C.red), 0, 0, 0.2, false);
    this.minutes = 8 * 60;
    this.fed = false;
    this.set(this.minutes);
  }

  set(minutesOfDay) {
    const m = ((minutesOfDay % 720) + 720) % 720;
    this.minute.rotation.z = -((m % 60) / 60) * Math.PI * 2;
    this.hour.rotation.z = -(m / 720) * Math.PI * 2;
  }

  feed(clock) {
    const match = /^(\d{1,2}):(\d{2})/.exec(String(clock ?? ''));
    if (!match) return;
    this.fed = true;
    this.minutes = Number(match[1]) * 60 + Number(match[2]);
    this.set(this.minutes);
  }

  update(dt) {
    if (this.fed) return;
    this.minutes += dt; // 1 game-minute per second until the sim feeds us
    this.set(this.minutes);
  }
}

// ─── Robot charging pad ─────────────────────────────────────────────────────
class ChargePad {
  constructor(g) {
    const H = LAYOUT.home;
    box(g, 1.5, 0.04, 1.5, lam(C.n0), H.x, 0, H.z, false);
    this.mat = glowMat('#3b6f80');
    for (const [w, d, dx, dz] of [[1.5, 0.08, 0, -0.71], [1.5, 0.08, 0, 0.71], [0.08, 1.5, -0.71, 0], [0.08, 1.5, 0.71, 0]]) {
      box(g, w, 0.05, d, this.mat, H.x + dx, 0, H.z + dz, false, false);
    }
    const bolt = lam('#8c7a4e');
    for (const [dx, dz] of [[0.1, -0.35], [0.05, -0.2], [0, -0.05], [-0.05, 0.05], [0.1, 0.05], [0.05, 0.2], [0, 0.35]]) {
      box(g, 0.16, 0.05, 0.12, bolt, H.x + dx, 0, H.z + dz, false);
    }
    this.active = false;
    this.k = 0;
  }

  update(dt, t, docked) {
    this.k += ((docked ? 1 : 0) - this.k) * Math.min(1, dt * 3);
    const pulse = 0.5 + 0.5 * Math.sin(t * 3);
    const v = 0.25 + this.k * (0.45 + pulse * 0.3);
    this.mat.color.setRGB(0.25 * v + 0.05, 0.75 * v + 0.05, 0.9 * v + 0.05);
  }
}
