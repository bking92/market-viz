// Who ate whom: media and telecom M&A as a fish tank.
// Reads only data/tank.json, written by pipeline/build_fish_tank.py.
// Story time (tau) is a decimal year. Sizes, species, births and deaths are pure functions of tau;
// swimming is a d3-force simulation running on wall-clock time so fish keep moving during pauses.

const PLAY_SECONDS = 120;     // the whole span, not counting pauses
const CHASE = 0.45;           // years of story time a predator spends closing in on its prey
const POP = 0.4;              // years of story time a split takes to pop and spread
const SWIM_IN = 0.5;          // years for a newcomer to swim in, or a leaver to swim out
const MIN_PX = 11;            // canvas pixels: the smallest fish drawn

const fmt$ = (v) => v >= 1e12 ? `$${(v / 1e12).toFixed(2)} trillion` : v >= 1e9 ? `$${(v / 1e9).toFixed(v >= 1e11 ? 0 : 1)} billion` : `$${(v / 1e6).toFixed(0)} million`;
const fmtDate = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
const fmtMonth = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { year: "numeric", month: "long", timeZone: "UTC" });
function yr(d) {
  const t = new Date(d + "T00:00:00Z");
  const y = t.getUTCFullYear();
  const start = Date.UTC(y, 0, 1), end = Date.UTC(y + 1, 0, 1);
  return y + (t - start) / (end - start);
}
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; }

import { sprite, areaFactor, Aquarium, fishColour, HR, COLOURS, glowOf } from "./pixel.js";
const AREA = { guppy: areaFactor("guppy"), adult: areaFactor("adult"), predator: areaFactor("predator") };

const res = await fetch("data/tank.json");
const D = await res.json();

// ---------- static text ----------
document.querySelectorAll("[data-fill]").forEach((el) => {
  const k = el.dataset.fill;
  if (k === "first-date") el.textContent = fmtMonth(D.first_date);
  else if (k === "last-date") el.textContent = fmtMonth(D.last_date);
  else if (D.text && D.text[k] != null) el.textContent = D.text[k];
});
document.getElementById("value-method").textContent = D.text.value_method;
document.getElementById("species-method").textContent = D.text.species_method;
const srcById = Object.fromEntries(D.sources.map((s) => [s.id, s]));
d3.select("#sources").selectAll("li").data(D.sources.filter((s) => s.list !== false)).join("li")
  .html((s) => `${s.label}${s.url ? ` <a href="${s.url}">${s.url.replace(/^https?:\/\//, "").slice(0, 70)}</a>` : ""}${s.note ? `. ${s.note}` : ""}`);
d3.select("#gaps").selectAll("p").data(D.gaps).join("p").text((g) => g);

// ---------- model ----------
const T0 = yr(D.first_date), T1 = yr(D.last_date);
const fish = D.fish.map((f) => ({
  ...f,
  tBorn: f.born ? yr(f.born) : -Infinity,
  tDied: f.died ? yr(f.died) : Infinity,
  pts: f.series.map((p) => ({ ...p, t: yr(p.d) })).sort((a, b) => a.t - b.t),
  names: f.names.map(([d, n]) => ({ t: d ? yr(d) : -Infinity, n })),
  tPred: f.predator_from ? yr(f.predator_from) : Infinity,
}));
const byId = Object.fromEntries(fish.map((f) => [f.id, f]));
const FAST_POP = 0.2;                     // a piece that pops off one fish to be eaten by another pops faster
const LINK = 0.3;                         // ...and is eaten this long after the pop
const popDur = (e) => (e.id.endsWith("_pop") ? FAST_POP : POP);
const events = D.events.map((e) => {
  const t = yr(e.date);
  let tv = t;                                   // when the event finishes on screen
  if (e.type === "eat" && e.linked) tv = t + LINK;
  if (e.type === "exit" && e.after_pop) tv = t + POP * 0.45 + SWIM_IN;
  return { ...e, t, tv };
}).sort((a, b) => a.tv - b.tv);
const pauses = events.filter((e) => e.pause);
// Pacing: story time slows down around every smaller deal so it can be read, and speeds up through
// quiet years. Total swimming time stays PLAY_SECONDS (pauses come on top).
const minors = events.filter((e) => !e.pause && e.minor);
const STRETCH = PLAY_SECONDS / 90;                      // timings below were tuned for 90 s; scale them with the total
const EXTRA = 0.8 * STRETCH, SIG = 0.22;                         // wall seconds added per smaller deal, spread over ±SIG years
const EXTRA_STOP = 2.5 * STRETCH, SIG_STOP = 0.2;                  // ...and in the run-up to each big stop, so the chase is watchable
const BASE = (PLAY_SECONDS - EXTRA * minors.length - EXTRA_STOP * pauses.length) / (T1 - T0);   // wall seconds per quiet year
const bump = (t, c, extra, sig) => (extra / (sig * Math.sqrt(Math.PI))) * Math.exp(-(((t - c) / sig) ** 2));
const secPerYear = (t) => BASE + minors.reduce((a, e) => a + bump(t, e.t, EXTRA, SIG), 0) + pauses.reduce((a, e) => a + bump(t, e.tv - 0.15, EXTRA_STOP, SIG_STOP), 0);
const deflator = D.deflator; // by year: multiply a dollar value of that year to get today's dollars

// How each fish enters and leaves, read off the events.
for (const f of fish) { f.enter = null; f.leave = null; }
for (const e of events) {
  if (e.type === "eat") e.targets.forEach((id) => (byId[id].leave = { kind: "eaten", e }));
  if (e.type === "split") {
    if (!e.children.includes(e.actor)) byId[e.actor].leave = { kind: "popped", e };
    e.children.filter((id) => id !== e.actor).forEach((id) => (byId[id].enter = { kind: "popped", e }));
  }
  if (e.type === "enter") byId[e.actor].enter = { kind: "swim", e };
  if (e.type === "exit") byId[e.actor].leave = { kind: "swim", e };
}
for (const f of fish) if (f.outside && !f.piece && f.leave) f.enter = { kind: "outside", e: f.leave.e };

// Give every company its own colour, never shared with a fish in the tank at the same time.
{
  const span = (f) => [Math.max(T0, f.tBorn === -Infinity ? (f.pts[0] ? f.pts[0].t : T0) : f.tBorn) - 0.5, Math.min(T1, f.tDied) + 0.5];
  const used = new Array(COLOURS.length).fill(0), placed = [];
  for (const f of fish.slice().sort((a, b) => span(a)[0] - span(b)[0] || hash(a.id) - hash(b.id))) {
    const [a, b] = span(f);
    const clash = new Set(placed.filter((g) => g.s[0] < b && a < g.s[1]).map((g) => g.f.ci));
    let best = 0, score = Infinity;
    COLOURS.forEach((_, i) => { const sc = (clash.has(i) ? 1000 : 0) + used[i]; if (sc < score) { score = sc; best = i; } });
    f.ci = best; used[best]++; placed.push({ f, s: [a, b] });
  }
}
function nameAt(f, t) { let n = f.names[0].n; for (const x of f.names) if (x.t <= t) n = x.n; return n; }
const showDate = (e) => e.precision === "month" ? fmtMonth(e.date) : e.precision === "year" ? e.date.slice(0, 4) : fmtDate(e.date);
function valueAt(f, t) {
  const p = f.pts;
  if (!p.length) return null;
  if (t <= p[0].t) return { v: p[0].v, kind: p[0].kind, src: p[0].src, d: p[0].d, held: t < p[0].t - 0.02 };
  if (t >= p[p.length - 1].t) { const q = p[p.length - 1]; return { v: q.v, kind: q.kind, src: q.src, d: q.d, held: t > q.t + 0.02 }; }
  let i = d3.bisector((x) => x.t).right(p, t) - 1;
  const a = p[i], b = p[i + 1];
  const w = (t - a.t) / (b.t - a.t);
  return { v: Math.exp(Math.log(a.v) * (1 - w) + Math.log(b.v) * w), kind: a.kind === b.kind ? a.kind : (w < 0.5 ? a.kind : b.kind), src: a.src, d: a.d, held: false };
}
function speciesAt(f, t, v) {
  if (t >= f.tPred) return "predator";
  const real = v * (deflator[Math.floor(t)] || deflator[Math.floor(T1)]);
  return real >= D.thresholds.adult_real ? "adult" : "guppy";
}

// ---------- layout ----------
const box = document.getElementById("tank");
const aq = new Aquarium(document.getElementById("tank-px"));
const svg = d3.select("#tank-over");
let W = 0, H = 0, P = 3, kArea = 1, sandY = 0;
const yearText = svg.append("text").attr("class", "year");
const gLabels = svg.append("g");
function resize() {
  W = box.clientWidth; H = box.clientHeight;   // inside the border
  P = clamp(Math.round(W / 300), 2, 4);         // screen pixels per art pixel
  aq.resize(W, H, P);
  sandY = aq.sandTop * P;
  svg.attr("viewBox", `0 0 ${W} ${H}`);
  kArea = (0.15 * W * H) / D.max_total;   // the most crowded moment fills about a seventh of the tank
  const fs = Math.min(H * 0.16, 100);
  yearText.attr("x", 16).attr("y", 10 + fs).attr("font-size", fs);
  drawTimeline();
}
function lenFor(v, species) { return Math.max(MIN_PX * P, Math.sqrt((v * kArea) / AREA[species])); }
// Spread home spots evenly over the water (a Halton sequence over the fish's index), not by sector.
const halton = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
function home(f) {
  const i = fish.indexOf(f) + 1;
  return { x: W * (0.08 + 0.84 * halton(i, 2)), y: 12 + (sandY - 30) * (0.08 + 0.84 * halton(i, 3)) };
}

// ---------- simulation ----------
const nodes = new Map();
let lastLive = new Map();
const sim = d3.forceSimulation([]).alphaDecay(0).alphaTarget(0.3).velocityDecay(0.35)
  .force("x", d3.forceX((n) => n.tx).strength((n) => n.pull))
  .force("y", d3.forceY((n) => n.ty).strength((n) => n.pull))
  .force("collide", d3.forceCollide((n) => (n.solid ? n.L * 0.42 + 6 : 0)).strength(0.6).iterations(3))
  .stop();

let tau = T0, playing = true, pausedOn = null, pauseStarted = 0, lastWall = null, nextPause = 0;

function frame(wall) {
  const dt = lastWall == null ? 0 : Math.min(0.1, (wall - lastWall) / 1000);
  lastWall = wall;
  if (playing && !pausedOn) {
    tau = Math.min(T1, tau + dt / secPerYear(tau));
    const p = pauses[nextPause];
    if (p && tau >= p.tv + 0.04) { pausedOn = p; pauseStarted = wall; nextPause++; showPause(p); setPlayLabel(); }
    if (tau >= T1) { playing = false; setPlayLabel(); showEnd(); }
  }
  if (pausedOn) {
    const need = readSeconds(pausedOn) * 1000;
    const prog = clamp((wall - pauseStarted) / need, 0, 1);
    d3.select("#caption .resume i").style("width", `${prog * 100}%`);
    if (prog >= 1 && playing) resume();
  }
  step(wall / 1000);
  requestAnimationFrame(frame);
}

function step(wallS) {
  const live = new Map(); // id -> render spec
  for (const f of fish) {
    let tStart = f.tBorn, tEnd = f.tDied;
    if (f.enter && f.enter.kind === "popped") tStart = f.enter.e.t + popDur(f.enter.e) * 0.45;
    if (f.enter && f.enter.kind === "outside") tStart = f.enter.e.tv - CHASE - 0.3;
    if (f.leave && f.leave.kind === "popped") tEnd = f.leave.e.t + popDur(f.leave.e) * 0.5;
    if (f.leave && (f.leave.kind === "eaten" || f.leave.kind === "swim")) tEnd = f.leave.e.tv;
    if (tau < tStart || tau >= tEnd) continue;
    const val = valueAt(f, tau);
    if (!val) continue;
    const species = speciesAt(f, tau, val.v);
    live.set(f.id, { f, val, species, L: lenFor(val.v, species) });
  }
  // Sync simulation nodes.
  for (const [id, n] of nodes) if (!live.has(id)) nodes.delete(id);
  for (const [id, s] of live) {
    if (nodes.has(id)) continue;
    const h = home(s.f);
    const n = { id, x: h.x, y: h.y, vx: 0, vy: 0, dir: hash(id) > 0.5 ? 1 : -1, L: s.L, scale: 1 };
    const en = s.f.enter;
    if (en && en.kind === "popped" && nodes.has(en.e.actor)) {
      const par = nodes.get(en.e.actor);
      const a = hash(id + "a") * Math.PI * 2;
      Object.assign(n, { x: par.x + Math.cos(a) * 4, y: par.y + Math.sin(a) * 4, vx: Math.cos(a) * 6, vy: Math.sin(a) * 6 });
    } else if ((en && en.kind === "swim" && tau < en.e.t + SWIM_IN) || (en && en.kind === "outside")) {
      n.x = hash(id + "side") > 0.5 ? W + 120 : -120; n.dir = n.x < 0 ? 1 : -1;
    }
    nodes.set(id, n);
  }
  // Targets, chases, exits.
  for (const n of nodes.values()) n.chompNow = 0;
  for (const [id, s] of live) {
    const n = nodes.get(id), f = s.f, h = home(f);
    const ph = hash(id + "p") * 6.28, sp = 0.18 + 0.12 * hash(id + "s");
    n.tx = h.x + W * 0.09 * Math.sin(wallS * sp + ph); n.ty = h.y + H * 0.06 * Math.sin(wallS * sp * 1.3 + ph * 2);
    n.tx = clamp(n.tx, s.L * 0.5, W - s.L * 0.5); n.ty = clamp(n.ty, s.L * 0.3 + 8, sandY - 6 - s.L * 0.3);
    n.pull = 0.02; n.solid = true; n.L = s.L; n.scale = 1; n.flip = false; n.alpha = 1; n.transit = false;
    const lv = f.leave;
    if (lv && lv.kind === "eaten") {
      const span = lv.e.linked ? LINK - FAST_POP * 0.5 : CHASE;
      const p = (tau - (lv.e.tv - span)) / span;
      const pred = nodes.get(lv.e.actor);
      if (p > 0 && pred) {
        const mouth = pred.x + pred.dir * pred.L * 0.42;
        n.tx = mouth; n.ty = pred.y; n.pull = 0.02 + 0.25 * smooth(0, 0.8, p); n.solid = false;
        n.scale = 1 - smooth(0.7, 1, p); pred.hunting = id; pred.chompNow = Math.max(pred.chompNow, p); n.eatenBy = lv.e.actor;
      }
    }
    if (lv && lv.kind === "swim") {
      const p = (tau - (lv.e.tv - SWIM_IN)) / SWIM_IN;
      if (p > 0) { n.tx = n.x > W / 2 ? W + 300 : -300; n.pull = 0.05; n.solid = false; n.transit = true; }
    }
    if (lv && lv.kind === "popped") {
      const p = (tau - lv.e.t) / popDur(lv.e);
      if (p >= 0) { n.popping = p; n.solid = false; n.pull = 0.2; n.tx = n.x; n.ty = n.y; }
    } else n.popping = null;
    const en = f.enter;
    if (en && en.kind === "popped") { const d = popDur(en.e); const p = (tau - en.e.t - d * 0.45) / (d * 0.55); n.scale *= smooth(0, 1, p); }
    if (en && en.kind === "swim" && tau < en.e.t + SWIM_IN) { n.pull = 0.04; n.transit = true; }
    if (en && en.kind === "outside") { n.transit = true; if (!(lv && tau > lv.e.tv - CHASE)) n.pull = 0.05; }
    for (const e of events) if (e.type === "distress" && e.actor === id && tau >= e.t && tau < yr(e.until)) n.flip = true;
    if (f.outside) n.solid = false;
  }
  // Predators steer toward the fish they are about to eat.
  for (const [id, n] of nodes) {
    if (n.hunting && nodes.has(n.hunting)) { const prey = nodes.get(n.hunting); n.tx = n.tx * 0.5 + prey.x * 0.5; n.ty = n.ty * 0.5 + prey.y * 0.5; }
    n.hunting = null; n.chomp = n.chompNow;
  }
  for (const n of nodes.values()) { if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) { const h = home(byId[n.id]); n.x = h.x; n.y = h.y; n.vx = n.vy = 0; } }
  sim.nodes([...nodes.values()]);
  sim.tick();
  for (const n of nodes.values()) {
    if (Math.abs(n.vx) > 0.25) n.dir = n.vx > 0 ? 1 : -1;
    if (!n.transit && !n.eatenBy) { const half = (n.L || 0) * 0.5 * (n.scale ?? 1) + 2; if (half * 2 < W) n.x = clamp(n.x, half, W - half); }
    const s = live.get(n.id);
    if (s) n.L = s.L;
  }
  lastLive = live;
  render(live);
}

let lastRender = null;
function render(live) {
  const now = performance.now() / 1000, dt = lastRender == null ? 0 : Math.min(0.1, now - lastRender);
  lastRender = now;
  yearText.text(Math.floor(pausedOn ? pausedOn.t : tau)); // a pause shows the year the deal closed
  const specs = [...live.values()].filter((s) => nodes.has(s.f.id));
  const ctx = aq.ctx;
  ctx.drawImage(aq.bg, 0, 0);
  aq.rays(now);
  aq.weedsDraw(now, false);
  // Big fish swim behind small ones.
  const order = specs.slice().sort((a, b) => b.L * nodes.get(b.f.id).scale - a.L * nodes.get(a.f.id).scale);
  // During a stop, the fish in the story glow and the rest of the tank dims.
  const inScene = new Set(pausedOn ? [pausedOn.actor, ...(pausedOn.targets || []), ...(pausedOn.children || [])] : []);
  const dim = pausedOn ? 0.42 * smooth(0, 600, performance.now() - pauseShownAt) : 0;
  const drawn = [];
  for (const s of order) if (!inScene.has(s.f.id)) drawFish(s); else drawn.push(s);
  if (dim > 0) { ctx.fillStyle = `rgba(10,38,56,${dim.toFixed(3)})`; ctx.fillRect(0, 0, aq.w, aq.h); }
  for (const s of drawn) drawFish(s, dim > 0);
  function drawFish(s, glow) {
    const n = nodes.get(s.f.id);
    const pop = n.popping;
    if (pop != null && pop >= 0.45) return;
    const len = Math.round((s.L * n.scale) / P);
    if (len < 3) return;
    const speed = Math.hypot(n.vx, n.vy);
    n.phase = (n.phase ?? hash(s.f.id) * 6) + dt * (1.6 + Math.min(4, speed * 0.6)) * (len < 20 ? 1.4 : 1);
    const chomping = n.chomp > 0.45 && n.chomp < 1;
    const open = chomping && Math.floor(now * 7) % 2 === 0;
    const img = sprite(s.species, s.f.ci, len, Math.floor(n.phase) % 6, { ghost: s.val.kind === "estimate" || s.val.kind === "deal", open, dir: n.dir, flip: n.flip, pattern: Math.floor(hash(s.f.id + "pat") * 4) });
    const bob = Math.round(Math.sin(now * 1.3 + hash(s.f.id + "b") * 6) * 0.6);
    const X = Math.round(n.x / P - img.width / 2), Y = Math.round(n.y / P - img.height / 2) + bob;
    if (glow) { const g = glowOf(img); ctx.globalAlpha = 0.65 + 0.35 * Math.sin(now * 4); ctx.drawImage(g, X - 2, Y - 2); ctx.globalAlpha = 1; }
    ctx.drawImage(img, X, Y);
    if (Math.random() < dt * 0.25 && len >= 10) aq.addBubble(n.x / P + n.dir * len * 0.5, n.y / P - 1, 1);
    // A fish about to vanish down a throat leaves crumbs.
    if (n.eatenBy && n.scale < 0.35 && !n.crumbed) { n.crumbed = true; sfx("chomp", len); aq.burst(n.x / P, n.y / P, fishColour(s.f.ci), 8 + Math.min(16, len / 3), 14); }
  }
  // Splits: the fish swells inside a bubble, then the bubble bursts.
  for (const s of specs) {
    const n = nodes.get(s.f.id), p = n.popping;
    if (p == null) continue;
    const r = Math.round(((s.L / P) * 0.55) * (p < 0.45 ? 1 + 0.35 * (p / 0.45) : 1.35));
    if (p < 0.45) { aq.ring(Math.round(n.x / P), Math.round(n.y / P), r, "rgba(240,253,255,0.95)"); aq.ring(Math.round(n.x / P), Math.round(n.y / P), r + 1, "rgba(30,80,110,0.35)"); }
    else if (!n.burst) { n.burst = true; sfx("pop", r); aq.burst(n.x / P, n.y / P, "#f0fdff", 26, 30 + r); for (let i = 0; i < 6; i++) aq.addBubble(n.x / P + (Math.random() - 0.5) * r, n.y / P + (Math.random() - 0.5) * r, i % 2 ? 3 : 1); }
  }
  aq.weedsDraw(now, true);
  aq.particles(now, dt);

  // Labels on fish big enough to carry one, plus anyone in the current scene.
  const focus = new Set(pausedOn ? [pausedOn.actor, ...(pausedOn.targets || []), ...(pausedOn.children || [])] : []);
  const labelled = specs.filter((s) => { const n = nodes.get(s.f.id); return n.scale > 0.6 && n.popping == null && (s.L >= 48 || focus.has(s.f.id)); });
  // Place names biggest fish first; a name that would sit on another tries above its fish, else it is skipped.
  const boxes = [], placed = [];
  for (const s of labelled.sort((a, b) => (focus.has(b.f.id) - focus.has(a.f.id)) || b.L - a.L)) {
    const n = nodes.get(s.f.id), name = nameAt(s.f, tau), fs = s.L < 70 ? 11.5 : 13;
    const w = name.length * fs * 0.56 + 6, h = fs + 2, x = clamp(n.x, w / 2 + 2, W - w / 2 - 2);
    const below = n.y + s.L * { guppy: 0.2, adult: 0.2, predator: 0.12 }[s.species] + 14, above = n.y - s.L * { guppy: 0.24, adult: 0.26, predator: 0.2 }[s.species] - 4;
    const fits = (y) => !boxes.some((b) => Math.abs(b.x - x) < (b.w + w) / 2 && Math.abs(b.y - y) < (b.h + h) / 2);
    const y = fits(below) ? below : fits(above) && above > fs + 4 ? above : null;
    if (y == null) continue;
    boxes.push({ x, y, w, h }); placed.push({ s, x, y, name, small: fs < 13 });
  }
  gLabels.selectAll("text").data(placed, (d) => d.s.f.id).join("text")
    .attr("class", (d) => `fish-label${d.small ? " small" : ""}`)
    .attr("x", (d) => d.x).attr("y", (d) => d.y).text((d) => d.name);
  drawPlayhead();
}

box.addEventListener("mousemove", (ev) => {
  const r = box.getBoundingClientRect(), mx = ev.clientX - r.left - box.clientLeft, my = ev.clientY - r.top - box.clientTop;
  let best = null;
  for (const s of lastLive.values()) { const n = nodes.get(s.f.id); if (!n) continue; if (Math.abs(mx - n.x) < s.L * 0.5 && Math.abs(my - n.y) < s.L * HR[s.species] * 0.45 && (!best || s.L < best.L)) best = s; }
  if (best) tip(ev, best); else d3.select("#tooltip").style("opacity", 0);
});
box.addEventListener("mouseleave", () => d3.select("#tooltip").style("opacity", 0));
// What a fish has done so far: who it ate, what it split from or into, and who ate it.
const yearOf = (e) => Math.floor(e.t);
const dealOf = (e) => (e.value ? `, a ${fmt$(e.value)} deal` : "");
function historyLines(f, upTo) {
  const out = [];
  for (const e of events) {
    if (e.t > upTo) break;
    if (e.type === "eat" && e.actor === f.id) out.push(`Ate ${e.targets.map((id) => nameAt(byId[id], e.t - 0.01)).join(" and ")} in ${yearOf(e)}${dealOf(e)}`);
    if (e.type === "eat" && e.targets.includes(f.id)) out.push(`Eaten by ${nameAt(byId[e.actor], e.t)} in ${yearOf(e)}${dealOf(e)}`);
    if (e.type === "split" && e.actor === f.id) out.push(`Split in ${yearOf(e)}: ${e.children.filter((id) => id !== f.id).map((id) => nameAt(byId[id], e.t + 0.01)).join(", ")} swam off`);
    if (e.type === "split" && e.actor !== f.id && e.children.includes(f.id)) out.push(`Split off from ${nameAt(byId[e.actor], e.t - 0.01)} in ${yearOf(e)}`);
  }
  return out;
}
function historyHtml(f, upTo) {
  const h = historyLines(f, upTo);
  if (!h.length) return "";
  const shown = h.slice(-5);
  return `<span class="tip-history">${h.length > 5 ? `<span>…and ${h.length - 5} earlier</span>` : ""}${shown.map((x) => `<span>${x}</span>`).join("")}</span>`;
}
function tip(ev, s) {
  const v = s.val;
  const how = { market: "stock market value", float: "value of shares held by outside investors, from an annual report", deal: "price paid in a deal", estimate: "published estimate, no stock price" }[v.kind];
  const t = d3.select("#tooltip").style("opacity", 1)
    .html(`<b>${nameAt(s.f, tau)}</b><br>${fmt$(v.v)}<br>${how}${v.held ? `, last known ${fmtMonth(v.d)}` : ""}${historyHtml(s.f, tau)}`);
  // Keep the box on screen: flip it to the left of the finger near the right edge, and above near the bottom.
  const r = t.node().getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = window.innerHeight;
  let x = ev.clientX + 14, y = ev.clientY + 10;
  if (x + r.width > vw - 8) x = Math.max(8, ev.clientX - 14 - r.width);
  if (y + r.height > vh - 8) y = Math.max(8, ev.clientY - 10 - r.height);
  t.style("left", `${x}px`).style("top", `${y}px`);
  clearTimeout(tip.timer); tip.timer = setTimeout(() => t.style("opacity", 0), 4000);
}

// ---------- caption ----------
const cap = d3.select("#caption");
function readSeconds(e) { const words = (e.headline + " " + e.text).split(/\s+/).length; return clamp(words / 3.2, 7, 16); }
function showIntro() { cap.html(`<p class="when">${fmtMonth(D.first_date)}</p><p>${D.text.intro}</p>`); }
let pauseShownAt = 0;
function showPause(e) {
  pauseShownAt = performance.now();
  cap.html(`<p class="when">${showDate(e)}</p><h2>${e.headline}</h2>${e.text.split("\n").map((p) => `<p>${p}</p>`).join("")}<span class="resume"><i></i></span><button type="button" id="go" class="go">Keep going</button>`);
  cap.select("#go").style("font-family", "var(--label)").style("background", "none").style("border", 0).style("border-bottom", "1px solid var(--ink)").style("padding", 0).style("cursor", "pointer").on("click", resume);
}
// The smaller deals stay listed, newest first, so one that went by quickly can still be read.
function showMinor() {
  if (pausedOn || tau >= T1) return;
  const recent = minors.filter((e) => e.t <= tau && e.t > tau - 3).slice(-3).reverse();
  let box = cap.select(".minors");
  if (!recent.length) { box.remove(); return; }
  if (box.empty()) box = cap.append("div").attr("class", "minors");
  box.selectAll("p").data(recent, (e) => e.id).join("p").attr("class", (e, i) => `minor${i ? " older" : ""}`)
    .text((e) => `${Math.floor(e.t)}: ${e.minor}`);
}
function showEnd() { cap.html(`<p class="when">${fmtMonth(D.last_date)}</p><h2>${D.text.end_headline}</h2><p>${D.text.end}</p>`); }
function resume() { pausedOn = null; playing = true; setPlayLabel(); cap.html(""); }
setInterval(showMinor, 400);

// ---------- controls ----------
// ---------- sound (off until the reader turns it on) ----------
let audio = null, soundOn = false;
function sfx(kind, size) {
  if (!soundOn || !audio || document.hidden) return;
  const t = audio.currentTime, big = clamp(size / 40, 0, 1);
  const blip = (type, f0, f1, start, dur, vol) => {
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t + start); o.frequency.exponentialRampToValueAtTime(f1, t + start + dur);
    g.gain.setValueAtTime(vol, t + start); g.gain.exponentialRampToValueAtTime(0.001, t + start + dur);
    o.connect(g).connect(audio.destination); o.start(t + start); o.stop(t + start + dur + 0.02);
  };
  if (kind === "chomp") { const f = 170 - 80 * big; blip("square", f, f * 0.45, 0, 0.07, 0.07); blip("square", f * 0.9, f * 0.4, 0.11, 0.07, 0.06); }
  if (kind === "pop") { blip("sine", 500 - 200 * big, 1500, 0, 0.07, 0.16); blip("triangle", 1800, 2600, 0.05, 0.04, 0.05); }
}
d3.select("#sound").on("click", function () {
  soundOn = !soundOn;
  if (soundOn && !audio) audio = new (window.AudioContext || window.webkitAudioContext)();
  if (audio) audio.resume();
  d3.select(this).text(soundOn ? "Sound on" : "Sound off").attr("aria-pressed", soundOn);
  if (soundOn) sfx("pop", 10);
});

// ---------- share the current moment ----------
d3.select("#share").on("click", async function () {
  const u = new URL(location.href); u.search = "";
  if (pausedOn) u.searchParams.set("pause", pauses.indexOf(pausedOn)); else u.searchParams.set("t", tau.toFixed(2));
  const url = u.toString(), btn = d3.select(this), was = "Share this moment";
  try {
    if (navigator.share && matchMedia("(pointer: coarse)").matches) { await navigator.share({ title: document.title, url }); return; }
    await navigator.clipboard.writeText(url); btn.text("Link copied");
  } catch (e) { if (e && e.name === "AbortError") return; window.prompt("Copy this link:", url); }
  setTimeout(() => btn.text(was), 2200);
});

const tl = d3.select("#timeline");
let tx = d3.scaleLinear();
function drawTimeline() {
  const w = tl.node().getBoundingClientRect().width;
  tx = d3.scaleLinear().domain([T0, T1]).range([4, w - 4]);
  tl.attr("viewBox", `0 0 ${w} 28`);
  tl.selectAll("*").remove();
  tl.append("line").attr("class", "track").attr("x1", tx(T0)).attr("x2", tx(T1)).attr("y1", 10).attr("y2", 10);
  tl.append("line").attr("class", "done").attr("x1", tx(T0)).attr("y1", 10).attr("y2", 10);
  tl.selectAll("line.tick").data(pauses).join("line").attr("class", "tick").attr("x1", (e) => tx(e.tv)).attr("x2", (e) => tx(e.tv)).attr("y1", 5).attr("y2", 15);
  const decades = [2000, 2010, 2020].filter((y) => y > T0 && y < T1);
  const startLabel = tx(decades[0] ?? T1) - tx(T0) > 40 ? [Math.ceil(T0)] : [];
  tl.selectAll("text").data([...startLabel, ...decades]).join("text").attr("x", (y) => tx(y)).attr("y", 27).attr("text-anchor", (y) => (y === Math.ceil(T0) ? "start" : "middle")).text((y) => y);
}
function drawPlayhead() { tl.select("line.done").attr("x2", tx(tau)); }
tl.on("click", (ev) => {
  const [x] = d3.pointer(ev);
  jump(clamp(tx.invert(x), T0, T1));
});
function jump(t) {
  tau = t; pausedOn = null; nodes.clear(); cap.html("");
  nextPause = pauses.findIndex((e) => e.tv + 0.04 > tau); if (nextPause < 0) nextPause = pauses.length;
  if (!playing) { playing = true; setPlayLabel(); }
}
function setPlayLabel() { d3.select("#play").text(playing && !pausedOn ? "Pause" : "Play"); }
d3.select("#play").on("click", () => {
  if (tau >= T1) { jump(T0); showIntro(); return; }
  if (pausedOn) { resume(); return; }   // during a stop, the button means keep going
  playing = !playing; setPlayLabel();
});
d3.select("#replay").on("click", () => { jump(T0); showIntro(); });
document.addEventListener("keydown", (e) => { if (e.code === "Space" && e.target === document.body) { e.preventDefault(); d3.select("#play").dispatch("click"); } });

// Key: one of each species and the hollow outline, drawn with the same sprites.
const keyImg = (sp, ghost) => { const c = sprite(sp, 6, 24, 1, { ghost }); return `<img src="${c.toDataURL()}" width="${c.width * 2}" height="${c.height * 2}" alt="" style="image-rendering:pixelated;vertical-align:middle">`; };
d3.select("#key").html([["guppy", false, "worth under " + D.text.adult_short], ["adult", false, "grown up"], ["predator", false, "predator"], ["adult", true, "no stock price, sized by a deal or estimate"]].map(([sp, g, label]) => `<span class="key-item">${keyImg(sp, g)} ${label}</span>`).join(" ") + ``);

// ---------- who ended up inside whom ----------
// Follow every "eat" to the end: a fish still in the tank at the close is the root of everything it
// swallowed, and of everything its prey had swallowed before.
function drawTree() {
  const eatsBy = d3.group(events.filter((e) => e.type === "eat"), (e) => e.actor);
  const icon = (f, t) => { const v = valueAt(f, t); const c = sprite(v ? speciesAt(f, t, v.v) : "adult", f.ci, 22, 1, { ghost: v && (v.kind === "estimate" || v.kind === "deal") }); return `<img src="${c.toDataURL()}" width="${c.width * 2}" height="${c.height * 2}" alt="">`; };
  const was = (f, t) => { const now = nameAt(f, t); const old = [...new Set(f.names.filter((x) => x.t <= t).map((x) => x.n))].filter((n) => n !== now); return old.length ? ` <i>(was ${old.join(", then ")})</i>` : ""; };
  const node = (f, t, seen) => {
    const kids = (eatsBy.get(f.id) || []).filter((e) => e.t <= T1).flatMap((e) => e.targets.map((id) => ({ e, f: byId[id] }))).filter((k) => !seen.has(k.f.id));
    kids.forEach((k) => seen.add(k.f.id));
    return `<ul>${kids.map((k) => `<li><span class="who">${icon(k.f, k.e.t - 0.02)}<span><b>${nameAt(k.f, k.e.t - 0.01)}</b>${was(k.f, k.e.t - 0.01)} <i>${yearOf(k.e)}${k.e.value ? `, ${fmt$(k.e.value)}` : ""}</i></span></span>${node(k.f, k.e.t, seen)}</li>`).join("")}</ul>`;
  };
  const alive = fish.filter((f) => !f.outside && (!f.leave || f.leave.e.t > T1) && f.tDied > T1 && (eatsBy.get(f.id) || []).length)
    .map((f) => ({ f, v: valueAt(f, T1) })).sort((a, b) => (b.v ? b.v.v : 0) - (a.v ? a.v.v : 0));
  d3.select("#tree-chart").html(alive.map(({ f, v }) => `<div class="tree-root"><span class="who root">${icon(f, T1)}<span><b>${nameAt(f, T1)}</b>${was(f, T1)} <i>${v ? fmt$(v.v) + " now" : ""}</i></span></span>${node(f, T1, new Set([f.id]))}</div>`).join(""));
}
drawTree();

// ---------- tables ----------
function table(sel, cols, rows) {
  const t = d3.select(sel).append("table");
  t.append("thead").append("tr").selectAll("th").data(cols).join("th").text((c) => c[0]);
  t.append("tbody").selectAll("tr").data(rows).join("tr").selectAll("td").data((r) => cols.map((c) => c[1](r))).join("td").html((x) => x);
}
const srcLink = (id) => { const s = srcById[id]; return s ? (s.url ? `<a href="${s.url}">${s.short || s.label}</a>` : s.short || s.label) : id; };
// The tables are built after the tank is swimming, so they never hold up the first frame.
function buildTables() {
  d3.select("#event-table").append("p").text("* Date of the SEC filing that records the deal closing or the stock being delisted, usually the closing day or within a few days of it.");
  table("#event-table", [["Date", (e) => showDate(e) + (e.precision === "filing" ? "*" : "")], ["What happened", (e) => e.minor || e.headline], ["Deal value", (e) => (e.value ? fmt$(e.value) : "")], ["In today's dollars", (e) => (e.value_real ? fmt$(e.value_real) : "")], ["Source", (e) => [...new Set(e.src)].map(srcLink).join(", ")]], events.filter((e) => e.minor || e.headline));
  // Every dated value is in data/values.csv; on the page, one company at a time.
  const vt = d3.select("#value-table");
  const total = fish.reduce((a, f) => a + f.pts.length, 0);
  vt.append("p").html(`${total.toLocaleString("en-US")} values in all, downloadable as <a href="data/values.csv">values.csv</a>. Pick a company to see its values here: `)
    .append("select").attr("id", "value-pick").attr("aria-label", "Company")
    .on("change", function () { draw(this.value); })
    .selectAll("option").data(fish.slice().sort((a, b) => a.names[a.names.length - 1].n.localeCompare(b.names[b.names.length - 1].n))).join("option")
    .attr("value", (f) => f.id).text((f) => f.names.map((x) => x.n).filter((n, i, a) => a.indexOf(n) === i).join(" / "));
  const holder = vt.append("div");
  function draw(id) {
    holder.selectAll("*").remove();
    const f = byId[id];
    table(holder.node(), [["Name then", (p) => nameAt(f, p.t)], ["Date", (p) => p.d], ["Value", (p) => fmt$(p.v)], ["Kind", (p) => p.kind], ["Source", (p) => srcLink(p.src)]], f.pts);
  }
  draw(d3.select("#value-pick").property("value"));
}
(window.requestIdleCallback || ((cb) => setTimeout(cb, 300)))(buildTables);

window.addEventListener("resize", resize);
resize();
showIntro();
requestAnimationFrame((w) => { frame(w); requestAnimationFrame(() => box.classList.remove("loading")); });
// Hooks for screenshots: ?t=2001.05 jumps to a moment and holds there.
const q = new URLSearchParams(location.search);
if (q.has("t")) { jump(+q.get("t")); playing = false; setPlayLabel(); }
if (q.has("pause")) { const e = pauses[+q.get("pause")]; if (e) jump(e.tv - 0.25); }
window.__tank = { nodes, jump, get tau() { return tau; }, pause: () => { playing = false; setPlayLabel(); } };
