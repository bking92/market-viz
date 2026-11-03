// Pixel-art drawing for the fish tank: fish sprites, the aquarium scene, bubbles and crumbs.
// Everything is drawn into a small canvas (one canvas pixel = P screen pixels) and scaled up
// with image-rendering: pixelated, so every fish shares one pixel grid whatever its size.
// Nothing here touches the data: story.js decides who is where and how big; this only draws.

// One colour per company. Each entry is [hue, saturation, lightness shift]; ramps run
// outline, dark, mid, light, shine. Hues near the water's blue-green are left out.
export const COLOURS = [
  [4, 78, 0], [28, 92, 2], [48, 95, 6], [88, 62, 0], [135, 55, -4], [160, 70, -6],
  [228, 70, 4], [258, 62, 4], [285, 58, 2], [318, 66, 4], [345, 78, 6], [22, 45, -12],
  [0, 0, 6], [62, 75, -14], [38, 55, 22], [300, 30, -10],
];
const hsl = (h, s, l) => { l = Math.max(4, Math.min(96, l)); s /= 100; l /= 100; const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l); const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))); return "#" + [f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, "0")).join(""); };
const rampCache = new Map();
export function ramp(ci, shark = false) {
  const key = ci + "|" + shark; if (rampCache.has(key)) return rampCache.get(key);
  const [h, s, dl] = COLOURS[ci % COLOURS.length];
  const r = shark
    ? [hsl(h, s * 0.7, 9), hsl(h, s * 0.8, 26 + dl * 0.5), hsl(h, s * 0.8, 42 + dl * 0.5), hsl(h, s * 0.7, 60), hsl(h, s * 0.3, 92)]
    : [hsl(h, s * 0.7, 11), hsl(h, s, 32 + dl), hsl(h, s, 50 + dl), hsl(h, s, 66 + dl), hsl(h, s * 0.9, 88)];
  rampCache.set(key, r); return r;
}
const EYE_WHITE = "#ffffff", PUPIL = "#120e0a", TOOTH = "#ffffff";
export const HR = { guppy: 0.66, adult: 0.62, predator: 0.66 }; // sprite height / length

function tri(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

// Classify one point of a unit fish (length 1, facing right, centred on 0,0).
// Returns 0 empty, 1 body, 2 fin, 3 tail, 4 eye white, 5 pupil, 6 dark mark, 7 tooth, 8 belly (sharks).
function part(sp, u, v, wig, open) {
  if (sp === "guppy") {
    const mouthU = 0.4;
    if (open && u > mouthU - 0.1 && Math.abs(v - 0.03) < (u - (mouthU - 0.12)) * 0.75) return 0;
    if ((u - 0.27) ** 2 + (v + 0.05) ** 2 < 0.028 ** 2) return 5;
    if ((u - 0.265) ** 2 + (v + 0.05) ** 2 < 0.06 ** 2) return 4;
    if (((u - 0.1) / 0.3) ** 2 + (v / 0.2) ** 2 <= 1) return 1;
    const tu = -0.16 - u;
    if (tu > 0 && u >= -0.5) {
      const vv = v - wig * tu * 0.9;
      if (Math.abs(vv) <= 0.075 + tu * 1.0 && (tu / 0.34) ** 2 + (vv / 0.31) ** 2 <= 1) return 3;
    }
    if (Math.abs(u - 0.04) < 0.11 && v < 0 && v > -(0.2 + 0.08 * (1 - Math.abs(u - 0.04) / 0.11))) return 2;
    return 0;
  }
  if (sp === "adult") {
    const hh = (u, k) => (u < -0.37 || u > 0.49 ? -1 : k * Math.pow(Math.max(0, 1 - ((u - 0.06) / 0.43) ** 2), 0.62));
    const top = hh(u, 0.2), bot = hh(u, 0.17);
    const mouthU = 0.48;
    if (open && u > mouthU - 0.1 && Math.abs(v - 0.03) < (u - (mouthU - 0.12)) * 0.7) return 0;
    if ((u - 0.345) ** 2 + (v + 0.05) ** 2 < 0.022 ** 2) return 5;
    if ((u - 0.34) ** 2 + (v + 0.05) ** 2 < 0.048 ** 2) return 4;
    if (top >= 0 && v >= -top && v <= bot) {
      if (Math.abs(u - 0.24) < 0.012 && Math.abs(v) < bot * 0.8) return 6;              // gill line
      return 1;
    }
    const tu = -0.34 - u;
    if (tu > 0 && u >= -0.5) {
      const vv = v - wig * tu * 1.3;
      if (Math.abs(vv) <= 0.035 + tu * 1.3 && !(tu > 0.07 && Math.abs(vv) < (tu - 0.07) * 1.5)) return 3;
    }
    if (u > -0.2 && u < 0.2 && v < 0) { const t = (u + 0.2) / 0.4; if (v > -hh(u, 0.2) - 0.11 * Math.sin(Math.PI * Math.pow(t, 0.8))) return 2; }
    if (u > -0.02 && u < 0.12 && v > 0 && v < hh(u, 0.17) + 0.07 * (1 - (u + 0.02) / 0.14)) return 2;
    return 0;
  }
  // predator: a shark
  const hh = (u, k) => (u < -0.42 || u > 0.5 ? -1 : k * Math.pow(Math.max(0, 1 - ((u - 0.03) / 0.47) ** 2), 0.8));
  const top = hh(u, 0.12), bot = hh(u, 0.105);
  if (open && u > 0.3 && v > 0.0 && v < 0.012 + (u - 0.3) * 0.55) {
    if (Math.abs(v - 0.008 - (u - 0.3) * 0.0) < 0.016 && Math.floor(u * 60) % 2 === 0) return 7; // top teeth
    return 0;
  }
  if ((u - 0.33) ** 2 + (v + 0.035) ** 2 < 0.02 ** 2) return 5;
  if (top >= 0 && v >= -top && v <= bot) {
    if (u > 0.33 && u < 0.47 && Math.abs(v - (0.045 + (0.47 - u) * 0.12)) < 0.01 && !open) return 6; // mouth line
    if ([0.2, 0.165, 0.13].some((g) => Math.abs(u - g) < 0.009) && v > -0.05 && v < 0.05) return 6; // gills
    return v > 0.012 ? 8 : 1;
  }
  const w = wig * 0.6;
  if (tri(u, v, 0.15, -top * 0 - hh(0.15, 0.12) + 0.01, -0.07, -hh(-0.07, 0.12) + 0.01, -0.1, -0.31)) return 2; // dorsal
  if (tri(u, v, 0.14, hh(0.14, 0.105) - 0.01, 0.03, hh(0.03, 0.105) - 0.01, -0.06, 0.24)) return 2;           // pectoral
  if (u < -0.36) {
    const vv = v - w * (-0.36 - u) * 2;
    if (tri(u, vv, -0.35, -0.03, -0.42, 0.03, -0.5, -0.3)) return 3; // upper lobe
    if (tri(u, vv, -0.37, 0.0, -0.42, 0.03, -0.48, 0.19)) return 3;  // lower lobe
  }
  return 0;
}

const cache = new Map();
// A sprite: an offscreen canvas with the fish drawn in pixels, outline included.
export function sprite(sp, ci, len, frame, opts = {}) {
  const { ghost = false, open = false, dir = 1, flip = false, pattern = 0 } = opts;
  const key = `${sp}|${ci}|${len}|${frame}|${+ghost}|${+open}|${dir}|${+flip}|${pattern}`;
  let c = cache.get(key);
  if (c) return c;
  if (cache.size > 4000) cache.clear();
  const R = ramp(ci, sp === "predator");
  const w = len + 2, h = Math.max(3, Math.ceil(len * HR[sp])) + 2;
  const wig = Math.sin((frame / 6) * Math.PI * 2) * 0.22;
  const grid = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const u = (x + 0.5 - w / 2) / len, v = (y + 0.5 - h / 2) / len;
    grid[y * w + x] = part(sp, u, v, wig, open);
  }
  // Column extents of the body, for shading back to belly.
  const colTop = new Int16Array(w).fill(-1), colBot = new Int16Array(w).fill(-1);
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) { const g = grid[y * w + x]; if (g === 1 || g === 8 || g === 4 || g === 5 || g === 6) { if (colTop[x] < 0) colTop[x] = y; colBot[x] = y; } }
  c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(w, h);
  const put = (x, y, hex) => {
    const X = dir < 0 ? w - 1 - x : x, Y = flip ? h - 1 - y : y;
    const i = (Y * w + X) * 4;
    img.data[i] = parseInt(hex.slice(1, 3), 16); img.data[i + 1] = parseInt(hex.slice(3, 5), 16); img.data[i + 2] = parseInt(hex.slice(5, 7), 16); img.data[i + 3] = 255;
  };
  const filled = (x, y) => x >= 0 && y >= 0 && x < w && y < h && grid[y * w + x] > 0;
  const detail = len >= 18;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const g = grid[y * w + x];
    if (!g) {
      if (filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1)) put(x, y, R[0]);
      continue;
    }
    if (ghost && g !== 5 && (x + y) % 2) continue;
    if (g === 5) { put(x, y, PUPIL); continue; }
    if (g === 4) { put(x, y, EYE_WHITE); continue; }
    if (g === 7) { put(x, y, TOOTH); continue; }
    if (g === 6) { put(x, y, R[0]); continue; }
    if (g === 2 || g === 3) {
      const ray = detail && (sp === "guppy" ? (x + (y >> 1)) % 3 === 0 : x % 3 === 0);
      put(x, y, ray ? R[1] : sp === "guppy" ? R[3] : R[2]);
      if (sp === "guppy" && detail && g === 3 && (x * 7 + y * 3) % 11 === 0) put(x, y, R[4]);
      continue;
    }
    const t = colBot[x] > colTop[x] ? (y - colTop[x]) / (colBot[x] - colTop[x]) : 0.5;
    if (sp === "predator") {
      if (g === 8) put(x, y, R[4]);
      else put(x, y, t < 0.2 ? R[1] : R[2]);
      if (g === 1 && detail && t > 0.25 && t < 0.4 && x > w * 0.45 && x < w * 0.8) put(x, y, R[3]);
      continue;
    }
    let s = t < 0.22 ? 1 : t < 0.68 ? 2 : 3;
    // Each company gets its own markings so look-alike fish can be told apart.
    if (sp === "adult" && detail && s === 2) {
      if (pattern === 0 && [0.42, 0.56, 0.7].some((k) => Math.abs(x / w - k) < 0.02)) s = 1;          // stripes
      if (pattern === 1 && (x * 3 + y * 5) % 9 === 0) s = 1;                                               // freckles
      if (pattern === 2 && Math.abs(x / w - 0.5) < 0.07) s = 4;                                            // pale band
      if (pattern === 3 && t > 0.45) s = 3;                                                                // two-tone
    }
    put(x, y, R[s]);
    if (detail && t > 0.24 && t < 0.36 && x > w * 0.5 && x < w * 0.75) put(x, y, R[4]);                     // shine
    if (sp === "guppy" && detail && s === 2 && (x * 5 + y * 3) % 13 === 0) put(x, y, R[3]);                   // spots
  }
  ctx.putImageData(img, 0, 0);
  cache.set(key, c);
  return c;
}

// Fraction of len*len that a species' body covers, so value maps to area the same for every species.
export function areaFactor(sp) {
  const len = 200, w = len + 2, h = Math.ceil(len * HR[sp]) + 2;
  let n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) if (part(sp, (x + 0.5 - w / 2) / len, (y + 0.5 - h / 2) / len, 0, false)) n++;
  return n / (len * len);
}

// ---------- the aquarium ----------
const WATER = ["#a8e6ee", "#78cfe0", "#4fb2cf", "#3593b8", "#26769c", "#1c5c80", "#164a69"];
const SAND = ["#f0dca4", "#dcc185", "#c4a366", "#a5854d"];
const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]].map((r) => r.map((x) => (x + 0.5) / 16));
const rnd = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; };
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

export class Aquarium {
  constructor(canvas) { this.cv = canvas; this.ctx = canvas.getContext("2d"); this.bubbles = []; this.bits = []; this.lastBubble = 0; }
  resize(W, H, P) {
    this.P = P; this.w = Math.ceil(W / P); this.h = Math.ceil(H / P);
    this.cv.width = this.w; this.cv.height = this.h;
    this.cv.style.width = `${this.w * P}px`; this.cv.style.height = `${this.h * P}px`;
    this.ctx.imageSmoothingEnabled = false;
    this.sandTop = this.h - Math.max(10, Math.round(this.h * 0.08));
    this.bg = this.paintBackground();
    const n = Math.max(4, Math.round(this.w / 55));
    this.weeds = d3.range(n).map((i) => ({ x: Math.round(((i + 0.3 + rnd(i + "wx") * 0.5) / n) * this.w), hgt: Math.round(this.h * (0.1 + 0.22 * rnd(i + "wh"))), ph: rnd(i + "wp") * 6, kind: rnd(i + "wk") > 0.4 ? 0 : 1 }));
    this.bubbler = Math.round(this.w * 0.88);
  }
  paintBackground() {
    const { w, h, sandTop } = this;
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const ctx = c.getContext("2d"); const img = ctx.createImageData(w, h); const d = img.data;
    const water = WATER.map(hex), sand = SAND.map(hex);
    const edge = (x) => sandTop + Math.round(Math.sin(x * 0.07) * 1.4 + Math.sin(x * 0.19 + 1) * 0.8);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let col;
      if (y < edge(x)) {
        const f = (y / sandTop) * (water.length - 1), i = Math.min(water.length - 2, Math.floor(f));
        col = f - i > BAYER[y % 4][x % 4] ? water[i + 1] : water[i];
      } else {
        const f = ((y - edge(x)) / (h - sandTop + 2)) * 2.2, i = Math.min(2, Math.floor(f));
        col = f - i > BAYER[y % 4][x % 4] ? sand[i + 1] : sand[i];
        const r = rnd(x * 977 + y * 131);
        if (r < 0.05) col = sand[3]; else if (r > 0.97) col = [255, 247, 222];
        if (y === edge(x)) col = sand[0];
      }
      const k = (y * w + x) * 4; d[k] = col[0]; d[k + 1] = col[1]; d[k + 2] = col[2]; d[k + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    // Rocks and pebbles on the sand.
    const blob = (cx, cy, rx, ry, cols) => {
      for (let y = -ry - 1; y <= ry + 1; y++) for (let x = -rx - 1; x <= rx + 1; x++) {
        const q = (x / rx) ** 2 + (y / ry) ** 2;
        if (q > 1.25) continue;
        const shade = q > 1 ? cols[0] : y < -ry * 0.35 && x < rx * 0.3 ? cols[3] : y > ry * 0.3 ? cols[1] : cols[2];
        if (cy + y > h - 1) continue;
        ctx.fillStyle = shade; ctx.fillRect(cx + x, cy + y, 1, 1);
      }
    };
    const rock = ["#2b2b33", "#4f5260", "#727789", "#9da3b3"], pink = ["#3a1f28", "#9b4f66", "#c97a90", "#efb3c3"];
    const nRocks = Math.max(3, Math.round(w / 70));
    for (let i = 0; i < nRocks; i++) {
      const cx = Math.round(((i + 0.2 + rnd(i + "rx") * 0.6) / nRocks) * w), s = 3 + Math.round(rnd(i + "rs") * Math.min(9, h * 0.04));
      blob(cx, sandTop + 1, s + 2, s, rock);
      blob(cx + s + 1, sandTop + 2, Math.ceil(s / 2) + 1, Math.ceil(s / 2), rock);
    }
    for (let i = 0; i < w / 9; i++) {
      const cx = Math.round(rnd(i + "px") * w), cy = sandTop + 2 + Math.round(rnd(i + "py") * (h - sandTop - 3));
      blob(cx, cy, 1, 1, rnd(i + "pc") > 0.7 ? pink : rock);
    }
    // A small coral branch.
    const cxC = Math.round(w * 0.32), base = sandTop + 1, ch = Math.round(h * 0.09);
    ctx.fillStyle = pink[0];
    for (let y = 0; y < ch; y++) { ctx.fillRect(cxC - 1, base - y, 3, 1); if (y > ch * 0.4) { const o = Math.round((y - ch * 0.4) * 0.6); ctx.fillRect(cxC - 1 - o, base - y, 3, 1); ctx.fillRect(cxC - 1 + o, base - y, 3, 1); } }
    ctx.fillStyle = pink[2];
    for (let y = 0; y < ch; y++) { ctx.fillRect(cxC, base - y, 1, 1); if (y > ch * 0.4) { const o = Math.round((y - ch * 0.4) * 0.6); ctx.fillRect(cxC - o, base - y, 1, 1); ctx.fillRect(cxC + o, base - y, 1, 1); } }
    return c;
  }
  // Light rays from the surface, drifting slowly.
  rays(t) {
    const { ctx, w, sandTop } = this;
    for (let k = 0; k < 4; k++) {
      const x0 = ((k * 0.29 + 0.1 + 0.04 * Math.sin(t * 0.13 + k)) % 1) * w * 1.3 - w * 0.15, wid = 6 + 5 * ((k * 7) % 3);
      for (let y = 0; y < sandTop; y++) {
        const a = 0.13 * (1 - y / sandTop);
        if (a < 0.02 || (y > sandTop * 0.5 && y % 2)) continue;
        ctx.fillStyle = `rgba(255,255,240,${a.toFixed(3)})`;
        ctx.fillRect(Math.round(x0 + y * 0.45), y, wid, 1);
      }
    }
    // Ripple line at the surface.
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    for (let x = 0; x < w; x += 1) if (Math.sin(x * 0.35 + t * 2.2) + Math.sin(x * 0.11 - t * 1.3) > 1.1) ctx.fillRect(x, 0, 1, 1);
  }
  weedsDraw(t, front) {
    const { ctx, sandTop } = this;
    for (const wd of this.weeds) {
      if ((wd.kind === 1) !== front) continue;
      const hgt = front ? Math.round(wd.hgt * 0.45) : wd.hgt;
      const cols = wd.kind ? ["#0e3a22", "#2f7d3c", "#5fb04a"] : ["#0f3320", "#1f6a3a", "#3f9a4d"];
      for (let y = 0; y < hgt; y++) {
        const k = y / hgt;
        const x = wd.x + Math.round(Math.sin(t * 1.1 + wd.ph - y * 0.12) * 3.5 * k);
        const yy = sandTop + 1 - y;
        ctx.fillStyle = cols[0]; ctx.fillRect(x - 1, yy, 4, 1);
        ctx.fillStyle = cols[1]; ctx.fillRect(x, yy, 2, 1);
        if (y % 6 === 3 && k < 0.92) { const s = (y / 6) % 2 ? 1 : -1; ctx.fillStyle = cols[0]; ctx.fillRect(s > 0 ? x + 2 : x - 4, yy, 3, 2); ctx.fillStyle = cols[2]; ctx.fillRect(s > 0 ? x + 2 : x - 3, yy, 2, 1); }
      }
    }
  }
  addBubble(x, y, r = 1) { this.bubbles.push({ x, y, r, ph: Math.random() * 6, v: 9 + Math.random() * 6 }); }
  burst(x, y, color, n = 10, speed = 18) {
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2 + Math.random() * 0.4; this.bits.push({ x, y, vx: Math.cos(a) * speed * (0.6 + Math.random() * 0.6), vy: Math.sin(a) * speed * (0.6 + Math.random() * 0.6), life: 0.6 + Math.random() * 0.4, color }); }
  }
  bubbleSprite(x, y, r) {
    const { ctx } = this; x = Math.round(x); y = Math.round(y);
    ctx.fillStyle = "rgba(235,252,255,0.9)";
    if (r <= 1) { ctx.fillRect(x, y - 1, 1, 1); ctx.fillRect(x - 1, y, 1, 1); ctx.fillRect(x + 1, y, 1, 1); ctx.fillRect(x, y + 1, 1, 1); return; }
    this.ring(x, y, r, "rgba(235,252,255,0.9)");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(x - Math.ceil(r / 2), y - Math.ceil(r / 2), 1, 1);
  }
  ring(cx, cy, r, color) {
    const { ctx } = this; ctx.fillStyle = color;
    let x = r, y = 0, err = 1 - r;
    while (x >= y) {
      for (const [a, b] of [[x, y], [y, x], [-y, x], [-x, y], [-x, -y], [-y, -x], [y, -x], [x, -y]]) ctx.fillRect(cx + a, cy + b, 1, 1);
      y++; if (err < 0) err += 2 * y + 1; else { x--; err += 2 * (y - x) + 1; }
    }
  }
  disc(cx, cy, r, color) { const { ctx } = this; ctx.fillStyle = color; for (let y = -r; y <= r; y++) { const half = Math.floor(Math.sqrt(r * r - y * y)); ctx.fillRect(cx - half, cy + y, half * 2 + 1, 1); } }
  // Advance and draw bubbles and crumbs.
  particles(t, dt) {
    if (t - this.lastBubble > 0.38) { this.lastBubble = t; this.addBubble(this.bubbler + Math.round(Math.random() * 3), this.sandTop, Math.random() > 0.8 ? 3 : 1); }
    this.bubbles = this.bubbles.filter((b) => b.y > 1);
    for (const b of this.bubbles) { b.y -= b.v * dt; b.x += Math.sin(t * 4 + b.ph) * 0.15; this.bubbleSprite(b.x, b.y, b.r); }
    this.bits = this.bits.filter((b) => b.life > 0);
    for (const b of this.bits) {
      b.life -= dt; b.x += b.vx * dt; b.y += b.vy * dt; b.vx *= 0.92; b.vy = b.vy * 0.92 + 4 * dt;
      this.ctx.fillStyle = b.color; this.ctx.fillRect(Math.round(b.x), Math.round(b.y), 1, 1);
    }
  }
}
export const fishColour = (ci) => ramp(ci)[2];

// A soft light outline around a sprite, for the fish in the current scene.
const glows = new WeakMap();
export function glowOf(img) {
  let g = glows.get(img);
  if (g) return g;
  g = document.createElement("canvas"); g.width = img.width + 4; g.height = img.height + 4;
  const c = g.getContext("2d");
  for (const [dx, dy] of [[0, 2], [4, 2], [2, 0], [2, 4], [1, 1], [3, 1], [1, 3], [3, 3]]) c.drawImage(img, dx, dy);
  c.globalCompositeOperation = "source-in"; c.fillStyle = "#fff6c8"; c.fillRect(0, 0, g.width, g.height);
  glows.set(img, g); return g;
}
