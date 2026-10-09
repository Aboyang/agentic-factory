// Shared colours, cached geometries/materials and small helpers.
// Clean low-poly look: slightly bevelled boxes (RoundedBoxGeometry, cached and
// shared), MeshStandardMaterial everywhere, smooth (linear + mipmapped) textures.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

// Nord-based palette, lifted and saturated so machines read clearly against
// the floor under ACES tone mapping.
export const C = {
  n0: '#2f3542', n1: '#3d4556', n2: '#4a5367', n3: '#5b667d',
  s0: '#dfe4ec', s1: '#eaeef4', s2: '#f4f6f9',
  f0: '#8fcfc8', f1: '#7cc7dc', f2: '#7ea6d6', f3: '#4f7fc4',
  red: '#e0525f', orange: '#f0874e', yellow: '#f5c445', green: '#78c25f', purple: '#a77fd0',
  bg: '#1a1f2b', ink: '#242933', steel: '#a9b2c0', glass: '#a8d4ec', sky: '#c6dbe6',
  wood: '#c98d58', woodDark: '#94633d', cardboard: '#d2a868', tape: '#efdcaa',
  skin: '#efc6a0', ground: '#272d39', asphalt: '#30363f', rubber: '#22252c',
};

// Lamp colours (emissive, not tone mapped, so they read as light sources).
export const LAMP = { green: '#5dff6e', amber: '#ffb52e', red: '#ff3448', blue: '#3fa4ff', off: '#20242d' };

// ─── Geometry ────────────────────────────────────────────────────────────────
const geoCache = new Map();

// Plain box (textured surfaces, hit boxes, instancing, voxel glyphs).
export function boxGeo(w, h, d) {
  const k = `b${w}|${h}|${d}`;
  let g = geoCache.get(k);
  if (!g) geoCache.set(k, (g = new THREE.BoxGeometry(w, h, d)));
  return g;
}

// Slightly bevelled box with smooth normals.
export function rboxGeo(w, h, d) {
  const min = Math.min(w, h, d);
  const r = Math.min(0.06, min * 0.22);
  const k = `r${w}|${h}|${d}`;
  let g = geoCache.get(k);
  if (!g) geoCache.set(k, (g = new RoundedBoxGeometry(w, h, d, 1, r)));
  return g;
}

function geoFor(w, h, d, mat) {
  if (Math.min(w, h, d) < 0.05) return boxGeo(w, h, d);
  if (mat && (Array.isArray(mat) || mat.map)) return boxGeo(w, h, d); // keep UVs exact
  return rboxGeo(w, h, d);
}

// Cylinders get enough segments to look round (4 or fewer = deliberate prism).
export function cylGeo(rt, rb, h, seg = 8, open = false) {
  const s = seg <= 4 ? seg : Math.max(seg * 2, 18);
  const k = `c${rt}|${rb}|${h}|${s}|${open}`;
  let g = geoCache.get(k);
  if (!g) geoCache.set(k, (g = new THREE.CylinderGeometry(rt, rb, h, s, 1, open)));
  return g;
}

// ─── Materials ───────────────────────────────────────────────────────────────
const METALS = new Set([C.steel, '#c3cad6']);
function std(color, opts) {
  const metal = METALS.has(color);
  return new THREE.MeshStandardMaterial({ color, roughness: metal ? 0.42 : 0.68, metalness: metal ? 0.35 : 0.02, ...opts });
}

const lamCache = new Map();
// Shared matte material (name kept from the voxel version).
export function lam(color) {
  let m = lamCache.get(color);
  if (!m) lamCache.set(color, (m = std(color)));
  return m;
}

const glowCache = new Map();
// Shared self-lit material (screens, windows, LEDs). Not tone mapped: stays bright.
export function glow(color) {
  let m = glowCache.get(color);
  if (!m) glowCache.set(color, (m = glowMat(color)));
  return m;
}

// Unshared self-lit material (for colours that animate).
export function glowMat(color, opts = {}) {
  return new THREE.MeshBasicMaterial({ color, toneMapped: false, ...opts });
}

// Per-object material set: lets one machine glow on hover without touching
// the shared cache. `mats(color)` returns a standard material; `mats.all()`.
export function matSet() {
  const cache = new Map();
  const fn = (color) => {
    let m = cache.get(color);
    if (!m) cache.set(color, (m = std(color)));
    return m;
  };
  fn.all = () => cache.values();
  return fn;
}

function mesh(geo, mat, cast, receive) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}

// Box whose BOTTOM sits at y (handy for stacking).
export function box(parent, w, h, d, mat, x = 0, y = 0, z = 0, cast = true, receive = true) {
  const m = mesh(geoFor(w, h, d, mat), mat, cast, receive);
  m.position.set(x, y + h / 2, z);
  parent.add(m);
  return m;
}

// Box centred at (x, y, z).
export function boxC(parent, w, h, d, mat, x = 0, y = 0, z = 0, cast = true, receive = true) {
  const m = mesh(geoFor(w, h, d, mat), mat, cast, receive);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

// Cylinder centred at (x, y, z); axis 'y' (default), 'x' or 'z'.
export function cyl(parent, r, h, mat, x = 0, y = 0, z = 0, axis = 'y', seg = 8) {
  const m = mesh(cylGeo(r, r, h, seg), mat, true, true);
  if (axis === 'x') m.rotation.z = Math.PI / 2;
  if (axis === 'z') m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

// ─── Textures ────────────────────────────────────────────────────────────────
// Canvas texture. `draw(ctx, w, h)` works in logical units; the canvas is
// supersampled (about 256 px on the long side) so shapes stay crisp under
// linear filtering + mipmaps.
export function canvasTex(w, h, draw, repeat = [1, 1], scale = 0) {
  const s = scale || Math.max(1, Math.round(256 / Math.max(w, h)));
  const c = document.createElement('canvas');
  c.width = w * s;
  c.height = h * s;
  const ctx = c.getContext('2d');
  ctx.scale(s, s);
  draw(ctx, w, h);
  return smoothTex(new THREE.CanvasTexture(c), repeat);
}

export function smoothTex(t, repeat = [1, 1]) {
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  return t;
}

let softTex = null;
// Soft round glow (white centre → transparent), for lamp halos.
export function softGlowTexture() {
  if (softTex) return softTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  softTex = new THREE.CanvasTexture(c);
  return softTex;
}

let ringTex = null;
// Soft ring on the floor (transparent centre, bright band, fading edge).
export function ringGlowTexture() {
  if (ringTex) return ringTex;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,255,255,0.18)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.35)');
  grad.addColorStop(0.74, 'rgba(255,255,255,1)');
  grad.addColorStop(0.82, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  ringTex = new THREE.CanvasTexture(c);
  return ringTex;
}

// Voxel glyph from string rows ('#' = filled). Returns a Group centred on x,
// bottom at y=0, facing +z.
export function glyph(rows, px, mat, depth = px) {
  const g = new THREE.Group();
  const h = rows.length;
  const w = rows[0].length;
  const geo = boxGeo(px, px, depth);
  rows.forEach((row, j) => {
    for (let i = 0; i < w; i++) {
      if (row[i] !== '#') continue;
      const m = new THREE.Mesh(geo, mat);
      m.position.set((i - (w - 1) / 2) * px, (h - 1 - j) * px + px / 2, 0);
      g.add(m);
    }
  });
  return g;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, k) => a + (b - a) * k;
export const smooth = (k) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));
export const easeOutCubic = (k) => 1 - Math.pow(1 - clamp(k, 0, 1), 3);
export const easeInQuad = (k) => clamp(k, 0, 1) ** 2;
export const easeInOutCubic = (k) => {
  const x = clamp(k, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
export const easeOutBack = (k) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const x = clamp(k, 0, 1) - 1;
  return 1 + c3 * x * x * x + c1 * x * x;
};

// Shortest signed angle from a to b.
export function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// Accepts '#rgb', '#rrggbb', css names or numbers; falls back when invalid.
export function safeColor(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'number') return '#' + (value & 0xffffff).toString(16).padStart(6, '0');
  const s = String(value).trim();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s)) return s;
  const name = s.toLowerCase();
  if (THREE.Color.NAMES && name in THREE.Color.NAMES) return '#' + THREE.Color.NAMES[name].toString(16).padStart(6, '0');
  return fallback;
}
