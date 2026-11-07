// Newton's cradle renderer: one canvas, many cradles.
// Each cradle strikes once per `interval` seconds of real time (the time the company takes to earn $1M).
// The page runs a shared clock that can be sped up; motion is a pendulum, so between strikes an end ball
// swings out and back with angle = A·sin(π·f), f = fraction of the time between strikes.
// When a ball moves more than a sliver per frame it is drawn with true motion blur (several sub-frame
// samples); when it strikes many times per frame it is drawn as its time-averaged smear.

const AMP = 0.5;            // swing amplitude in radians (about 29°)
const L = 7;                // string length, in ball radii
const DEPTH = { x: 0.25, y: -1.3 }; // offset of the back rail, in ball radii (a slightly raised 3/4 view)
const BALLS = 5;

function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

// ---------- sprites ----------
const spriteCache = new Map();
function ballSprite(rPx, dpr) {
  const key = `${Math.round(rPx * dpr * 4)}`;
  if (spriteCache.has(key)) return spriteCache.get(key);
  const R = rPx * dpr, pad = 2, S = Math.ceil(R * 2 + pad * 2);
  const c = document.createElement("canvas"); c.width = c.height = S;
  const g = c.getContext("2d");
  g.translate(S / 2, S / 2);
  g.save();
  g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.clip();
  // A polished steel sphere reflects the room: bright ceiling and window up top, the warm paper walls
  // in the middle, a dark horizon line, then the cobalt base and its shadow, all bent by the curvature.
  let lg = g.createLinearGradient(0, -R, 0, R);
  lg.addColorStop(0, "#ffffff"); lg.addColorStop(0.2, "#ecebe7"); lg.addColorStop(0.46, "#b9b6b0");
  lg.addColorStop(0.62, "#8f8c87"); lg.addColorStop(1, "#c9c7c2");
  g.fillStyle = lg; g.fillRect(-R, -R, 2 * R, 2 * R);
  // the base, seen in the lower part: a cobalt band squeezed toward the rim
  g.save(); g.beginPath(); g.ellipse(0, R * 1.22, R * 1.2, R * 0.92, 0, 0, Math.PI * 2); g.clip();
  lg = g.createLinearGradient(0, R * 0.3, 0, R);
  lg.addColorStop(0, "#121a52"); lg.addColorStop(0.25, "#2034c8"); lg.addColorStop(0.7, "#3a55ff"); lg.addColorStop(1, "#9aa8ff");
  g.fillStyle = lg; g.fillRect(-R, 0, 2 * R, R);
  g.restore();
  // a soft dark horizon just above it
  g.save(); g.beginPath(); g.ellipse(0, R * 1.22, R * 1.2, R * 0.92, 0, Math.PI * 1.02, Math.PI * 1.98);
  g.strokeStyle = "rgba(30,26,24,0.6)"; g.lineWidth = R * 0.09; g.filter = `blur(${Math.max(0.5, R * 0.02)}px)`; g.stroke(); g.restore();
  // window highlight
  g.save(); g.translate(-R * 0.34, -R * 0.44); g.rotate(-0.55); g.scale(1, 0.6);
  let rg = g.createRadialGradient(0, 0, 0, 0, 0, R * 0.46);
  rg.addColorStop(0, "rgba(255,255,255,1)"); rg.addColorStop(0.45, "rgba(255,255,255,0.75)"); rg.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = rg; g.beginPath(); g.arc(0, 0, R * 0.46, 0, Math.PI * 2); g.fill(); g.restore();
  // roundness: falloff toward the rim (Fresnel-ish dark edge), cooler on the shadow side
  rg = g.createRadialGradient(-R * 0.2, -R * 0.25, R * 0.3, 0, 0, R * 1.0);
  rg.addColorStop(0, "rgba(0,0,0,0)"); rg.addColorStop(0.75, "rgba(10,10,20,0.08)"); rg.addColorStop(1, "rgba(10,10,25,0.55)");
  g.fillStyle = rg; g.fillRect(-R, -R, 2 * R, 2 * R);
  // bounce light from the paper on the lower right rim
  rg = g.createRadialGradient(R * 0.6, R * 0.55, 0, R * 0.6, R * 0.55, R * 0.45);
  rg.addColorStop(0, "rgba(255,248,230,0.35)"); rg.addColorStop(1, "rgba(255,248,230,0)");
  g.fillStyle = rg; g.fillRect(-R, -R, 2 * R, 2 * R);
  g.restore();
  g.beginPath(); g.arc(0, 0, R - 0.5, 0, Math.PI * 2); g.strokeStyle = "rgba(20,18,30,0.35)"; g.lineWidth = 1; g.stroke();
  const s = { canvas: c, size: S };
  spriteCache.set(key, s);
  return s;
}

// ---------- drawing one cradle ----------
// (cx, top) is the front rail's centre in CSS px; r is ball radius in CSS px.
const HALF = 9.3, BASE_Y = 9.3, CORNER = 1.6;

// A chrome rod along any path: dark body, a lighter core, a thin highlight up and to the left.
function chrome(g, path, w, alpha) {
  g.save(); g.globalAlpha = alpha; g.lineCap = "round"; g.lineJoin = "round";
  g.strokeStyle = "#4a4b50"; g.lineWidth = w; path(0, 0); g.stroke();
  g.strokeStyle = "#a9aaae"; g.lineWidth = w * 0.62; path(-w * 0.1, -w * 0.1); g.stroke();
  g.strokeStyle = "#f4f4f2"; g.lineWidth = Math.max(0.6, w * 0.2); path(-w * 0.2, -w * 0.2); g.stroke();
  g.restore();
}
// The frame is an upside-down U with rounded shoulders.
function uPath(g, cx, top, r, ox, oy, footY) {
  const h = HALF * r, c = CORNER * r;
  return (dx, dy) => {
    g.beginPath();
    g.moveTo(cx - h + ox + dx, footY + dy);
    g.lineTo(cx - h + ox + dx, top + oy + c + dy);
    g.arcTo(cx - h + ox + dx, top + oy + dy, cx - h + c + ox + dx, top + oy + dy, c);
    g.lineTo(cx + h - c + ox + dx, top + oy + dy);
    g.arcTo(cx + h + ox + dx, top + oy + dy, cx + h + ox + dx, top + oy + c + dy, c);
    g.lineTo(cx + h + ox + dx, footY + dy);
  };
}

function roundRect(g, x, y, w, h, rad) {
  g.beginPath(); g.moveTo(x + rad, y); g.arcTo(x + w, y, x + w, y + h, rad); g.arcTo(x + w, y + h, x, y + h, rad);
  g.arcTo(x, y + h, x, y, rad); g.arcTo(x, y, x + w, y, rad); g.closePath();
}

function drawFrameBack(g, cx, top, r, alpha) {
  const dx = DEPTH.x * r, dy = DEPTH.y * r, baseY = top + BASE_Y * r;
  const bw = 10.6 * r, bh = 1.35 * r, depthY = -dy * 1.5; // the base's top face is depthY tall on screen
  g.save(); g.globalAlpha = alpha;
  // soft shadow of the whole thing on the paper
  const shY = baseY + bh + 0.2 * r;
  let rg = g.createRadialGradient(cx, shY, 0, cx, shY, bw * 1.05);
  rg.addColorStop(0, "rgba(30,25,15,0.28)"); rg.addColorStop(0.7, "rgba(30,25,15,0.1)"); rg.addColorStop(1, "rgba(30,25,15,0)");
  g.save(); g.translate(cx, shY); g.scale(1, 0.09); g.translate(-cx, -shY); g.fillStyle = rg; g.beginPath(); g.arc(cx, shY, bw * 1.05, 0, Math.PI * 2); g.fill(); g.restore();
  // base: one rounded slab. Top face first, then the front face over it.
  const topY = baseY - depthY;
  roundRect(g, cx - bw, topY, 2 * bw, depthY + bh, Math.min(r * 0.9, (depthY + bh) / 2));
  let gr = g.createLinearGradient(0, topY, 0, baseY);
  gr.addColorStop(0, "#2a44f2"); gr.addColorStop(1, "#3d58ff");
  g.fillStyle = gr; g.fill();
  roundRect(g, cx - bw, baseY, 2 * bw, bh, Math.min(r * 0.5, bh / 2));
  gr = g.createLinearGradient(0, baseY, 0, baseY + bh);
  gr.addColorStop(0, "#1f3cff"); gr.addColorStop(0.6, "#1a31d6"); gr.addColorStop(1, "#111f8e");
  g.fillStyle = gr; g.fill();
  // lacquer: the edge between top and front catches the light
  gr = g.createLinearGradient(cx - bw, 0, cx + bw, 0);
  gr.addColorStop(0, "rgba(255,255,255,0)"); gr.addColorStop(0.3, "rgba(255,255,255,0.55)"); gr.addColorStop(0.55, "rgba(255,255,255,0.15)"); gr.addColorStop(1, "rgba(255,255,255,0)");
  g.strokeStyle = gr; g.lineWidth = Math.max(0.7, r * 0.08);
  g.beginPath(); g.moveTo(cx - bw + r * 0.5, baseY + 0.5); g.lineTo(cx + bw - r * 0.5, baseY + 0.5); g.stroke();
  // a broad soft sheen on the top face
  rg = g.createRadialGradient(cx - bw * 0.35, topY + depthY * 0.4, 0, cx - bw * 0.35, topY + depthY * 0.4, bw * 0.7);
  rg.addColorStop(0, "rgba(255,255,255,0.16)"); rg.addColorStop(1, "rgba(255,255,255,0)");
  g.save(); roundRect(g, cx - bw, topY, 2 * bw, depthY, r * 0.6); g.clip(); g.fillStyle = rg; g.fillRect(cx - bw, topY, 2 * bw, depthY); g.restore();
  g.restore();
  // back half of the frame
  const w = Math.max(1.2, 0.34 * r);
  chrome(g, uPath(g, cx, top, r, dx, dy, baseY + dy * 0.9), w * 0.92, alpha * 0.92);
}

function drawFrameFront(g, cx, top, r, alpha) {
  const baseY = top + BASE_Y * r, w = Math.max(1.4, 0.38 * r);
  // feet: small dark collars where the rods meet the base
  g.save(); g.globalAlpha = alpha; g.fillStyle = "#14161f";
  for (const x of [cx - HALF * r, cx + HALF * r]) { g.beginPath(); g.ellipse(x, baseY - 0.25 * r, w * 1.1, w * 0.42, 0, 0, Math.PI * 2); g.fill(); }
  g.restore();
  chrome(g, uPath(g, cx, top, r, 0, 0, baseY - 0.25 * r), w, alpha);
}

function ballPos(cx, top, r, i, theta) {
  const px = cx + (i - (BALLS - 1) / 2) * 2 * r + DEPTH.x * r / 2, py = top + DEPTH.y * r / 2;
  return { px, py, x: px + L * r * Math.sin(theta), y: py + L * r * Math.cos(theta) };
}

function drawShadow(g, cx, top, r, i, theta, alpha) {
  const b = ballPos(cx, top, r, i, theta);
  const lift = 1 - Math.cos(theta); // 0 at rest
  const sx = b.x + 0.3 * r, sy = top + BASE_Y * r + DEPTH.y * r * 0.75;
  const w = r * (1.15 + lift * 3), h = r * (0.32 + lift * 0.6);
  const rg = g.createRadialGradient(sx, sy, 0, sx, sy, w);
  const a = 0.42 * alpha * (1 - lift * 3.2);
  rg.addColorStop(0, `rgba(5,8,40,${Math.max(0, a)})`); rg.addColorStop(1, "rgba(5,8,40,0)");
  g.save(); g.translate(sx, sy); g.scale(1, h / w); g.translate(-sx, -sy);
  g.fillStyle = rg; g.beginPath(); g.arc(sx, sy, w, 0, Math.PI * 2); g.fill(); g.restore();
}

function drawBall(g, cx, top, r, i, theta, alpha, dpr) {
  const b = ballPos(cx, top, r, i, theta);
  const dx = DEPTH.x * r / 2, dy = DEPTH.y * r / 2;
  // two strings to each ball, a V from front rail and back rail, meeting at the top of the ball
  const ax = b.x - r * 0.92 * Math.sin(theta), ay = b.y - r * 0.92 * Math.cos(theta);
  g.globalAlpha = alpha * 0.8;
  g.strokeStyle = "#3a3632"; g.lineWidth = Math.max(0.6, r * 0.05);
  g.beginPath(); g.moveTo(b.px - dx, b.py - dy); g.lineTo(ax, ay); g.lineTo(b.px + dx, b.py + dy); g.stroke();
  g.globalAlpha = alpha;
  const s = ballSprite(r, dpr);
  g.drawImage(s.canvas, b.x - s.size / dpr / 2, b.y - s.size / dpr / 2, s.size / dpr, s.size / dpr);
  // the small cap where the strings meet
  g.fillStyle = "#2b2824"; g.beginPath(); g.arc(ax, ay, Math.max(0.8, r * 0.1), 0, Math.PI * 2); g.fill();
  g.globalAlpha = 1;
}

// angles of the two end balls at strike-phase u (u counts strikes; strikes happen at integers)
function angles(u) {
  const k = Math.floor(u), f = u - k;
  const a = AMP * Math.sin(Math.PI * f);
  return (((k % 2) + 2) % 2 === 0) ? [0, a] : [-a, 0];
}

export function fmtUnit(u) { return u >= 1e6 ? `$${u / 1e6}M` : `$${u / 1e3}k`; }

export function fmtInterval(s) {
  if (s < 10) return `${s.toFixed(1)} seconds`;
  if (s < 60) return `${s.toFixed(0)} seconds`;
  if (s < 3600) { const m = Math.floor(s / 60), x = Math.round(s - m * 60); return x === 60 ? `${m + 1} min` : `${m} min ${x} s`; }
  if (s < 86400) { const h = Math.floor(s / 3600), m = Math.round((s - h * 3600) / 60); return m === 60 ? `${h + 1} hr` : `${h} hr ${m} min`; }
  return `${(s / 86400).toFixed(1)} days`;
}


// ---------- a broken cradle, for companies losing money ----------
// Deterministic per company: the front rail has snapped, the right-hand post leans out, the balls that lost
// their strings lie on the base (one has rolled off), and now and then a ball is wound up around the bar.
function rng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) { h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
}

function contactShadow(g, x, y, w, h, alpha) {
  const rg = g.createRadialGradient(x, y, 0, x, y, w);
  rg.addColorStop(0, `rgba(5,8,40,${0.5 * alpha})`); rg.addColorStop(1, "rgba(5,8,40,0)");
  g.save(); g.translate(x, y); g.scale(1, h / w); g.translate(-x, -y);
  g.fillStyle = rg; g.beginPath(); g.arc(x, y, w, 0, Math.PI * 2); g.fill(); g.restore();
}

function sprite(g, x, y, r, alpha, dpr) {
  const s = ballSprite(r, dpr);
  g.globalAlpha = alpha;
  g.drawImage(s.canvas, x - s.size / dpr / 2, y - s.size / dpr / 2, s.size / dpr, s.size / dpr);
  g.globalAlpha = 1;
}

function stringLine(g, pts, r, alpha) {
  g.save(); g.globalAlpha = alpha * 0.8; g.strokeStyle = "#3a3632"; g.lineWidth = Math.max(0.6, r * 0.05); g.lineCap = "round";
  g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
  if (pts.length === 3) g.quadraticCurveTo(pts[1][0], pts[1][1], pts[2][0], pts[2][1]);
  else for (const p of pts.slice(1)) g.lineTo(p[0], p[1]);
  g.stroke(); g.restore();
}

function drawBroken(g, cx, top, r, a, dpr, seed) {
  const R = rng(seed), h = HALF * r, c = CORNER * r, baseY = top + BASE_Y * r;
  const depthY = -DEPTH.y * r * 1.5, topY = baseY - depthY, footY = baseY - 0.25 * r;
  const bw = 10.6 * r, bh = 1.35 * r, w = Math.max(1.4, 0.38 * r);
  drawFrameBack(g, cx, top, r, a);
  // a crack across the base's top face and down its front
  g.save(); g.globalAlpha = a * 0.75; g.strokeStyle = "#0b1250"; g.lineWidth = Math.max(0.8, r * 0.07); g.lineJoin = "miter";
  const kx = cx + (R() * 6 - 3) * r;
  g.beginPath(); g.moveTo(kx - 1.2 * r, topY + 0.15 * r);
  g.lineTo(kx - 0.5 * r, topY + depthY * 0.35); g.lineTo(kx - 0.9 * r, topY + depthY * 0.6); g.lineTo(kx - 0.2 * r, baseY);
  g.lineTo(kx - 0.45 * r, baseY + bh * 0.5); g.lineTo(kx - 0.1 * r, baseY + bh); g.stroke(); g.restore();

  const breakX = cx + (R() * 3.5 - 1.5) * r;       // where the front rail snapped
  const pivots = [];
  for (let i = 0; i < BALLS; i++) pivots.push(ballPos(cx, top, r, i, 0));
  const dx = DEPTH.x * r / 2, dy = DEPTH.y * r / 2;
  // balls that lost their front string: on the base, spaced out, one off the edge onto the paper
  const fallen = pivots.map((b, i) => i).filter((i) => pivots[i].px - dx > breakX);
  const slots = [];
  fallen.forEach((i, k) => {
    if (k === fallen.length - 1 && fallen.length > 1) {
      slots.push({ i, floor: true, x: cx + bw + r * (1.4 + R() * 0.8), y: baseY + bh + 0.25 * r - r });
    } else {
      let x;
      for (let t = 0; t < 20; t++) { x = cx + (R() * 2 - 1) * (bw - 1.6 * r); if (slots.every((s) => Math.abs(s.x - x) > 2.2 * r)) break; }
      slots.push({ i, floor: false, x, y: topY + depthY * (0.35 + R() * 0.45) - r * 0.95 });
    }
  });
  // shadows first
  for (const s of slots) contactShadow(g, s.x + 0.2 * r, s.y + r * 0.92, r * 1.05, r * 0.28, a);
  // strings: snapped stubs hanging from the back rail, tails lying next to the fallen balls
  for (const s of slots) {
    const b = pivots[s.i], bx = b.px + dx, by = b.py + dy, len = (1.6 + R() * 2.2) * r, sway = (R() - 0.5) * 1.6 * r;
    stringLine(g, [[bx, by], [bx + sway, by + len * 0.6], [bx + sway * 0.4, by + len]], r, a);
    const ang = R() * Math.PI * 2;
    stringLine(g, [[s.x, s.y - r * 0.9], [s.x + Math.cos(ang) * 1.5 * r, s.y - r * 0.9 + Math.sin(ang) * 0.5 * r], [s.x + Math.cos(ang) * 2.6 * r, s.y - r * 0.3]], r, a);
  }
  // balls still on both rails: most hang straight, one may be wound up around the bar
  const hanging = pivots.map((b, i) => i).filter((i) => !fallen.includes(i));
  const wound = hanging.length > 1 && R() < 0.75 ? hanging[Math.floor(R() * hanging.length)] : -1;
  for (const i of hanging) {
    const b = pivots[i];
    if (i === wound) {
      const y = b.py + 1.45 * r;
      // loops of string around the bar, then a short drop to the ball
      g.save(); g.globalAlpha = a * 0.9; g.strokeStyle = "#3a3632"; g.lineWidth = Math.max(0.7, r * 0.07);
      for (let k = 0; k < 4; k++) { g.beginPath(); g.ellipse(b.px - 0.45 * r + k * 0.3 * r, b.py - 0.05 * r, 0.3 * r, 0.55 * r, 0.35, 0, Math.PI * 2); g.stroke(); }
      g.restore();
      stringLine(g, [[b.px - dx, b.py - dy], [b.px, y - r * 0.9], [b.px + dx, b.py + dy]], r, a);
      sprite(g, b.px, y, r, a, dpr);
    } else {
      const th = (R() - 0.5) * 0.08;
      drawShadow(g, cx, top, r, i, th, a);
      drawBall(g, cx, top, r, i, th, a, dpr);
    }
  }
  for (const s of slots) sprite(g, s.x, s.y, r, a, dpr);
  // front frame: left half intact up to the break; right post leans out with a drooping stub of rail
  g.save(); g.globalAlpha = a; g.fillStyle = "#14161f";
  for (const x of [cx - h, cx + h]) { g.beginPath(); g.ellipse(x, footY, w * 1.1, w * 0.42, 0, 0, Math.PI * 2); g.fill(); }
  g.restore();
  chrome(g, (ox, oy) => {
    g.beginPath(); g.moveTo(cx - h + ox, footY + oy); g.lineTo(cx - h + ox, top + c + oy);
    g.arcTo(cx - h + ox, top + oy, cx - h + c + ox, top + oy, c); g.lineTo(breakX + ox, top + oy + 0.15 * r);
  }, w, a);
  const tilt = 0.18 + R() * 0.12, Lp = footY - (top + c);
  const tx = cx + h + Math.sin(tilt) * Lp, ty = footY - Math.cos(tilt) * Lp;
  const stub = Math.max(1.5 * r, cx + h - breakX - 1.2 * r) * 0.75;
  chrome(g, (ox, oy) => {
    g.beginPath(); g.moveTo(cx + h + ox, footY + oy); g.lineTo(tx + ox, ty + oy);
    g.quadraticCurveTo(tx + ox, ty - c + oy, tx - c + ox, ty - c * 0.55 + oy);
    g.lineTo(tx - c - stub + ox, ty + stub * 0.45 + oy);
  }, w, a);
}

// ---------- the scene ----------
export class CradleScene {
  constructor(canvas, items, opts = {}) {
    this.canvas = canvas; this.g = canvas.getContext("2d");
    this.items = items.map((d) => ({ d, x: 0, y: 0, r: 0, a: 0, tx: 0, ty: 0, tr: 0, ta: 0, lastK: null }));
    this.logSpeed = 0; this.targetLogSpeed = 0;
    this.sim = 0; // simulated seconds since start
    this.onStrike = opts.onStrike || null;
    this.maxR = opts.maxR || 26;
    this.label = opts.label !== false;
    this.offset = 0.5; // every cradle starts with its ball pulled back, released together
    this.unit = opts.unit || 1e6; // dollars of profit per strike
    for (const it of this.items) it.u = this.offset;
    this.resize();
    new ResizeObserver(() => { this.resize(); this.layout(this.visible || [], true); }).observe(canvas);
    this.last = performance.now();
    const tick = (t) => { this.frame(t); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5), b = this.canvas.getBoundingClientRect();
    this.dpr = dpr; this.W = b.width; this.H = b.height;
    this.canvas.width = Math.round(b.width * dpr); this.canvas.height = Math.round(b.height * dpr);
  }
  setSpeed(s, instant = false) { this.targetLogSpeed = Math.log(s); if (instant) this.logSpeed = this.targetLogSpeed; }
  get speed() { return Math.exp(this.logSpeed); }
  // show the cradles for these tickers, in this order, in a grid that fits the canvas
  layout(tickers, instant = false, forceCols = null) {
    this.visible = tickers;
    const n = tickers.length, W = this.W, H = this.H;
    if (!n || !W) return;
    let best = null;
    const extra = tickers.some((t) => this.items.find((it) => it.d.ticker === t)?.d.note) ? 26 : 0;
    for (let cols = forceCols ? Math.min(forceCols, n) : 1; cols <= (forceCols ? Math.min(forceCols, n) : n); cols++) {
      const rows = Math.ceil(n / cols);
      const labelH = 46 + extra;
      const r = Math.min(W / cols / 23.5, (H / rows - labelH) / 13.4, this.maxR);
      if (!best || r > best.r) best = { cols, rows, r };
    }
    const { cols, rows, r } = best;
    const cellW = W / cols, labelH = Math.max(40, Math.min(58, r * 2.4)) + extra, cellH = r * 13.4 + labelH;
    const y0 = Math.max(0, (H - rows * cellH) / 2);
    const idx = new Map(tickers.map((t, i) => [t, i]));
    for (const it of this.items) {
      const i = idx.get(it.d.ticker);
      if (i === undefined) { it.ta = 0; if (instant) it.a = 0; continue; }
      const row = Math.floor(i / cols), inRow = Math.min(cols, n - row * cols);
      const xOff = (W - inRow * cellW) / 2;
      it.tx = xOff + (i % cols + 0.5) * cellW - DEPTH.x * r * 0.4; it.ty = y0 + row * cellH + r * 2; it.tr = r; it.ta = 1;
      it.labelSize = Math.max(13, Math.min(22, r * 0.95)); it.cellW = cellW;
      if (instant || it.a < 0.02) { it.x = it.tx; it.y = it.ty; it.r = it.tr; }
      if (instant) it.a = 1;
    }
  }
  setUnit(u) { this.unit = u; }
  // real seconds between strikes for this cradle at the current dollars-per-strike
  strikeEvery(d) { return d.interval * this.unit / 1e6; }
  frame(t) {
    const dt = Math.min(0.1, (t - this.last) / 1000); this.last = t;
    const k = 1 - Math.exp(-dt / 0.45);
    const prevSpeed = this.speed;
    this.logSpeed += (this.targetLogSpeed - this.logSpeed) * k;
    if (Math.abs(this.targetLogSpeed - this.logSpeed) < 1e-3) this.logSpeed = this.targetLogSpeed;
    this.sim += dt * (prevSpeed + this.speed) / 2;
    const g = this.g, dpr = this.dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, this.W, this.H);
    const kp = 1 - Math.exp(-dt / 0.3);
    for (const it of this.items) {
      it.x += (it.tx - it.x) * kp; it.y += (it.ty - it.y) * kp; it.r += (it.tr - it.r) * kp;
      it.a += (it.ta - it.a) * (1 - Math.exp(-dt / 0.25));
      if (it.d.interval > 0) it.u += dt * (prevSpeed + this.speed) / 2 / this.strikeEvery(it.d);
      if (it.a < 0.01) continue;
      this.drawCradle(it, dt);
    }
  }
  drawCradle(it, dt) {
    const g = this.g, { x: cx, y: top, r, a } = it, dpr = this.dpr, d = it.d;
    if (!(d.interval > 0)) { drawBroken(g, cx, top, r, a, dpr, d.ticker); if (this.label) this.drawLabel(it); return; }
    drawFrameBack(g, cx, top, r, a);
    const moving = d.interval > 0;
    const shutter = dt * 0.6; // seconds of simulated-clock exposure, as a share of the frame
    let samples = [[0, 0]]; // list of [left angle, right angle]
    let smear = false;
    if (moving) {
      const u = it.u, du = shutter * this.speed / this.strikeEvery(d);
      if (du > 1.5) {
        // many strikes per frame: draw where the ball spends its time, evenly over one full cycle
        smear = true; samples = [];
        const n = 14; for (let i = 0; i < n; i++) samples.push(angles((i + 0.5) / n * 2));
      } else {
        const travel = du * Math.PI * AMP * L; // approx. distance in radii covered during the shutter
        const n = Math.max(1, Math.min(10, Math.ceil(travel / 0.35)));
        samples = []; for (let i = 0; i < n; i++) samples.push(angles(u - du * (i / Math.max(1, n - 1))));
      }
      const kNow = Math.floor(u);
      if (it.lastK !== null && kNow !== it.lastK && this.onStrike && it.ta > 0.5) this.onStrike(it, kNow - it.lastK);
      it.lastK = kNow;
    }
    // shadows (averaged over samples)
    const sa = a / samples.length;
    for (const [l, rr] of samples) { drawShadow(g, cx, top, r, 0, l, sa); drawShadow(g, cx, top, r, BALLS - 1, rr, sa); }
    for (let i = 1; i < BALLS - 1; i++) drawShadow(g, cx, top, r, i, 0, a);
    // middle balls are still
    for (let i = 1; i < BALLS - 1; i++) drawBall(g, cx, top, r, i, 0, a, dpr);
    // end balls: each sample drawn faintly; a sample at rest is the same pixels each time, so it stays solid
    const ends = [[0, 0], [BALLS - 1, 1]];
    for (const [bi, side] of ends) {
      const angs = samples.map((s) => s[side]);
      const still = angs.every((v) => Math.abs(v) < 1e-4);
      if (still) { drawBall(g, cx, top, r, bi, 0, a, dpr); continue; }
      const w = smear ? 0.16 : 1 / angs.length * 1.25;
      // draw the resting copy solid if it spends a lot of time there (smear), then the moving copies
      if (smear) drawBall(g, cx, top, r, bi, 0, a * 0.55, dpr);
      for (const v of angs) drawBall(g, cx, top, r, bi, v, Math.min(1, a * w), dpr);
    }
    drawFrameFront(g, cx, top, r, a);
    if (this.label) this.drawLabel(it);
  }
  drawLabel(it) {
    const g = this.g, { x, y, r, a, d } = it;
    const amt = fmtUnit(this.unit), k = this.unit / 1e6;
    const sub = d.interval > 0 ? `${amt} every ${fmtInterval(d.interval * k)}` : `lost ${amt} every ${fmtInterval(d.lossInterval * k)}`;
    // shrink both lines together until they fit the cell
    let fs = it.labelSize || 14;
    const maxW = (it.cellW || 1e9) * 0.94;
    for (; fs > 8; fs -= 0.5) {
      g.font = `600 ${fs * 1.08}px Newsreader, Georgia, serif`; const w1 = g.measureText(d.name).width;
      g.font = `400 ${fs * 0.82}px "Libre Franklin", Arial, sans-serif`; const w2 = g.measureText(sub).width;
      if (Math.max(w1, w2) <= maxW) break;
    }
    const ly = y + 11.1 * r + fs * 0.9;
    g.globalAlpha = a; g.textAlign = "center"; g.textBaseline = "alphabetic";
    g.fillStyle = css("--ink"); g.font = `600 ${fs * 1.08}px Newsreader, Georgia, serif`;
    g.fillText(d.name, x, ly);
    g.font = `400 ${fs * 0.82}px "Libre Franklin", Arial, sans-serif`;
    g.fillStyle = d.interval > 0 ? css("--ink-soft") : css("--loss-text");
    g.fillText(sub, x, ly + fs * 1.15);
    if (d.note) { g.fillStyle = css("--brand"); g.font = `600 ${fs * 0.95}px "Libre Franklin", Arial, sans-serif`; g.fillText(d.note, x, ly + fs * 2.45); }
    g.globalAlpha = 1;
  }
}
