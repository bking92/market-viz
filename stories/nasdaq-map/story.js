// "If the Nasdaq-100 were the lower 48". Reads only data/map.json, which pipeline/build_nasdaq_map.py writes.
import { scroller } from "../../assets/js/scroller.js";

const d3 = window.d3;
const parse = d3.timeParse("%Y-%m-%d");
const fmtDate = (s) => d3.timeFormat("%b %-d, %Y")(parse(s));
const fmtShort = (s) => d3.timeFormat("%b %-d")(parse(s));
const pct = (v, p = 1) => `${d3.format(`.${p}f`)(Math.abs(v * 100))}%`;
const usd = (bn) => (Math.abs(bn) >= 1000 ? `$${d3.format(".2f")(Math.abs(bn) / 1000)} trillion` : `$${d3.format(".0f")(Math.abs(bn))} billion`);

const { meta, companies, shrunk } = await d3.json("data/map.json");
const D = meta.dates, P = meta.peak_index, L = meta.last_index;
const total = meta.total_cap_bn;
const [bx0, by0, bx1, by1] = meta.conus_bounds;
const pad = 8;
const viewBox = `${bx0 - pad} ${by0 - 70} ${bx1 - bx0 + 2 * pad} ${by1 - by0 + 70 + pad}`;
const tip = d3.select("#tooltip");

// ---------- words that come from the data ----------
const states = meta.state_shares; // [{name, share}] share of the lower 48's area
function equivalent(share) {
  // Closest single state, or the closest pair of states, by area.
  let best = { err: Infinity };
  for (const s of states) {
    const e = Math.abs(s.share - share) / share;
    if (e < best.err) best = { err: e, names: [s.name], area: s.share };
  }
  if (best.err > 0.08) {
    for (let i = 0; i < states.length; i++) for (let j = i + 1; j < states.length; j++) {
      const a = states[i].share + states[j].share, e = Math.abs(a - share) / share;
      if (e < best.err) best = { err: e, names: [states[i].name, states[j].name], area: a };
    }
  }
  const diff = best.area / share - 1;
  const how = Math.abs(diff) < 0.03 ? "about the size of" : diff > 0 ? "a little smaller than" : "a little bigger than";
  return { text: `${how} ${best.names.join(" and ")}`, names: best.names };
}
const byPeak = companies; // already sorted by peak value
const top10 = d3.sum(byPeak.slice(0, 10), (c) => c.share_peak);
const lost = total[P] - total[L];
const change = companies.map((c) => ({ c, d: c.cap[L] - c.cap[P] }));
const losers = change.slice().sort((a, b) => a.d - b.d).slice(0, 5);
const gainers = change.filter((x) => x.d > 0);
const c0eq = equivalent(byPeak[0].share_peak);
const lostEq = equivalent(lost / total[P]);
const fills = {
  "peak-date": fmtDate(D[P]), "last-date": fmtDate(D[L]), "last-date-short": fmtShort(D[L]),
  n: String(meta.n_companies), "members-note": meta.live_members_note, "xc-n": d3.format(",")(meta.crosscheck.compared),
  "peak-total": usd(total[P]), "peak-total-short": usd(total[P]),
  "c0-name": byPeak[0].name.replace(/ (Corporation|Inc\.|Corp\.)$/, ""), "c0-share": pct(byPeak[0].share_peak),
  "c0-equiv": c0eq.text,
  "top10-share": pct(top10, 0), "rest-n": String(companies.length - 10),
  "lost-total": usd(lost), "lost-pct": pct(lost / total[P]),
  "top-losers": losers.map((x) => `${x.c.t} (${usd(x.d)})`).join(", "),
  "gainers-n": String(gainers.length).replace(/^./, (s) => s.toUpperCase()),
  "lost-equiv": lostEq.text,
};
document.querySelectorAll("[data-fill]").forEach((el) => { if (fills[el.dataset.fill] != null) el.textContent = fills[el.dataset.fill]; });
document.getElementById("gaps").textContent = [meta.live_gaps, ...meta.gaps.map((g) => `${g.ticker}: ${g.why}.`)].filter(Boolean).join(" ");

// ---------- a map renderer, used twice (scrolly and explore) ----------
function makeMap(svgSel, opts = {}) {
  const svg = d3.select(svgSel).attr("viewBox", viewBox).attr("preserveAspectRatio", "xMidYMid meet");
  const fontFor = (c) => Math.min(24, Math.sqrt(c.share_peak) * 62);
  const labelled = companies.filter((c) => fontFor(c) >= 6.5 && (c.bbox[2] - c.bbox[0]) > c.t.length * fontFor(c) * 0.7);
  const labelledSet = new Set(labelled.map((c) => c.t));
  const defs = svg.append("defs");
  const id = svgSel.slice(1);
  defs.selectAll("clipPath").data(companies).join("clipPath").attr("id", (c, i) => `${id}-clip-${i}`)
    .append("path").attr("d", (c) => c.path);
  const gDrain = svg.append("g");
  const patch = gDrain.selectAll("g").data(companies).join("g").attr("class", "patch-g");
  patch.append("g").attr("clip-path", (c, i) => `url(#${id}-clip-${i})`).call((g) => {
    g.append("rect").attr("class", "kept").attr("x", (c) => c.bbox[0] - 1).attr("width", (c) => c.bbox[2] - c.bbox[0] + 2);
    g.append("rect").attr("class", "gone").attr("x", (c) => c.bbox[0] - 1).attr("width", (c) => c.bbox[2] - c.bbox[0] + 2);
  });
  patch.append("path").attr("class", "patch").attr("d", (c) => c.path).attr("fill", "none");
  const gShrink = svg.append("g").style("opacity", 0);
  const shrinkPaths = gShrink.selectAll("path.patch").data(companies).join("path").attr("class", "patch").attr("fill", "#b9ae9c");
  const shrinkLabels = gShrink.selectAll("text").data(companies).join("text").attr("class", "tick-label")
    .style("font-size", (c) => `${fontFor(c)}px`).text((c) => c.t)
    .style("display", (c) => (labelledSet.has(c.t) ? null : "none"));
  const ghost = svg.append("path").attr("class", "ghost").attr("d", meta.conus_path).style("opacity", 0);
  const gRef = svg.append("g");
  const gLabels = svg.append("g");
  const dateLabel = svg.append("text").attr("class", "date-label").attr("x", bx0).attr("y", by0 - 34);
  const dateSub = svg.append("text").attr("class", "date-sub").attr("x", bx0).attr("y", by0 - 12);

  const labels = gLabels.selectAll("text").data(labelled).join("text").attr("class", "tick-label")
    .attr("x", (c) => c.label[0]).attr("y", (c) => c.label[1]).style("font-size", (c) => `${fontFor(c)}px`).text((c) => c.t);

  // hover
  const hover = (sel, kFn) => sel.on("mousemove", (ev, c) => {
    const k = kFn(); const ch = c.cap[k] / c.cap[P] - 1;
    tip.style("opacity", 1).style("left", `${ev.clientX + 14}px`).style("top", `${ev.clientY + 14}px`)
      .html(`<b>${c.name}</b><br>${pct(c.share_peak, 2)} of the land at the peak<br>${usd(c.cap[P])} on ${fmtShort(D[P])}, ${usd(c.cap[k])} on ${fmtShort(D[k])} (${ch >= 0 ? "+" : "−"}${pct(ch)})`);
  }).on("mouseleave", () => tip.style("opacity", 0));

  const state = { k: P, mode: "drain" };
  hover(patch, () => state.k); hover(shrinkPaths, () => state.k);

  function setDate(k, dur = 0) {
    state.k = k;
    const t = d3.transition().duration(dur).ease(d3.easeLinear);
    patch.select(".kept").transition(t).attr("y", (c) => c.drain[k]).attr("height", (c) => c.bbox[3] - c.drain[k] + 1);
    patch.select(".gone").transition(t).attr("y", (c) => c.bbox[1] - 1).attr("height", (c) => Math.max(0, c.drain[k] - c.bbox[1] + 1));
    patch.select(".gone").style("opacity", k === P ? 0 : 0.85);
    dateLabel.text(fmtDate(D[k]));
    const ch = total[k] / total[P] - 1;
    dateSub.text(k === P ? `${usd(total[k])}, the peak` : `${usd(total[k])}, ${ch < 0 ? "down" : "up"} ${pct(ch)} from the peak`);
    if (state.mode === "shrink") drawShrink(k, dur);
  }
  function drawShrink(k, dur) {
    const s = shrunk[k]; if (!s) return;
    shrinkPaths.transition().duration(dur).attr("d", (c, i) => s.paths[i]);
    shrinkLabels.filter((c, i) => s.labels[i]).transition().duration(dur)
      .attr("x", (c) => s.labels[companies.indexOf(c)][0]).attr("y", (c) => s.labels[companies.indexOf(c)][1]);
  }
  function setMode(mode, dur = 600) {
    state.mode = mode;
    gDrain.transition().duration(dur).style("opacity", mode === "drain" ? 1 : 0);
    gShrink.transition().duration(dur).style("opacity", mode === "shrink" ? 1 : 0);
    ghost.transition().duration(dur).style("opacity", mode === "shrink" ? 1 : 0);
    gLabels.transition().duration(dur).style("opacity", mode === "drain" ? 1 : 0);
    gDrain.style("pointer-events", mode === "drain" ? null : "none");
    if (mode === "shrink") drawShrink(state.k, 0);
  }
  function highlight(set) {
    patch.classed("lit", (c) => set && set.has(c.t)).classed("dim", (c) => set && !set.has(c.t));
    labels.classed("dark-label", (c) => set && !set.has(c.t));
  }
  function showStates(names) {
    const sel = names ? meta.states_paths.filter((s) => names.includes(s.name)) : [];
    gRef.selectAll("g").data(sel, (s) => s.name).join(
      (enter) => enter.append("g").call((g) => {
        g.append("path").attr("class", "state-ref").attr("d", (s) => s.path);
        g.append("path").attr("class", "state-ref-inner").attr("d", (s) => s.path);
      }),
      (update) => update, (exit) => exit.remove());
  }
  setDate(P); setMode("drain", 0);
  return { setDate, setMode, highlight, showStates, state };
}

// ---------- the scrolly ----------
const m1 = makeMap("#map");
let playTimer = null;
function play(from, to, ms = 4200) {
  if (playTimer) playTimer.stop();
  const n = to - from, step = ms / n;
  m1.setDate(from);
  playTimer = d3.interval((elapsed) => {
    const k = Math.min(to, from + Math.floor(elapsed / step) + 1);
    m1.setDate(k, step);
    if (k >= to) playTimer.stop();
  }, step);
}
const top10set = new Set(byPeak.slice(0, 10).map((c) => c.t));
const loserSet = new Set(losers.map((x) => x.c.t));
scroller(document.querySelectorAll(".scrolly .step"), (i) => {
  if (playTimer) playTimer.stop();
  if (i === 0) { m1.setMode("drain"); m1.setDate(P); m1.highlight(null); m1.showStates(null); }
  if (i === 1) { m1.setMode("drain"); m1.setDate(P); m1.highlight(new Set([byPeak[0].t])); m1.showStates(c0eq.names); }
  if (i === 2) { m1.setMode("drain"); m1.setDate(P); m1.highlight(top10set); m1.showStates(null); }
  if (i === 3) { m1.setMode("drain"); m1.highlight(null); m1.showStates(null); play(P, L); }
  if (i === 4) { m1.setMode("drain"); m1.setDate(L, 300); m1.highlight(loserSet); m1.showStates(null); }
  if (i === 5) { m1.highlight(null); m1.setDate(L); m1.setMode("shrink"); m1.showStates(null); }
});

// ---------- explore ----------
const m2 = makeMap("#map2");
const slider = document.getElementById("slider");
slider.min = P; slider.max = L; slider.value = L;
m2.setDate(L);
slider.addEventListener("input", () => m2.setDate(+slider.value, 120));
document.querySelectorAll("#controls button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("#controls button").forEach((x) => x.classList.toggle("on", x === b));
  m2.setMode(b.dataset.mode);
}));

// ---------- the table ----------
const rows = companies.map((c) => ({ t: c.t, name: c.name, share: c.share_peak, p: c.cap[P], l: c.cap[L] }));
const table = d3.select("#table").append("table");
table.append("thead").append("tr").selectAll("th")
  .data(["Company", "Ticker", "Share of land", `${fmtShort(D[P])} ($bn)`, `${fmtShort(D[L])} ($bn)`, "Change"]).join("th").text((d) => d);
table.append("tbody").selectAll("tr").data(rows).join("tr").selectAll("td")
  .data((r) => [r.name, r.t, pct(r.share, 2), d3.format(",.1f")(r.p), d3.format(",.1f")(r.l), `${r.l >= r.p ? "+" : "−"}${pct(r.l / r.p - 1)}`])
  .join("td").text((d) => d);
