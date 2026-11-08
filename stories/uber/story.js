import { scroller } from "../../assets/js/scroller.js";

const svg = d3.select("#chart");
const tip = d3.select("#tooltip");
const css = getComputedStyle(document.documentElement);
const C = {
  m: css.getPropertyValue("--mobility").trim() || "#1f3cff",
  d: css.getPropertyValue("--delivery").trim() || "#e8590c",
  o: css.getPropertyValue("--other").trim() || "#a39a8a",
  soft: css.getPropertyValue("--brand-soft").trim(),
  ink: css.getPropertyValue("--ink").trim(),
  paper: css.getPropertyValue("--paper").trim(),
};
const NAMES = { m: "Rides", d: "Delivery", o: "Freight and other" };

const [rows, meta] = await Promise.all([
  d3.csv("data/quarters.csv", d3.autoType),
  d3.json("data/meta.json"),
]);

// ---------- derived series ----------
const qLabel = (p) => `${["January to March", "April to June", "July to September", "October to December"][+p[5] - 1]} ${p.slice(0, 4)}`;
const qShort = (p) => `Q${p[5]} ${p.slice(0, 4)}`;
const qDate = (p) => new Date(+p.slice(0, 4), (+p[5] - 1) * 3 + 1, 15);
const money = (m) => (m >= 1000 ? `$${d3.format(".1f")(m / 1000)} billion` : `$${d3.format(",")(m)} million`);
const usd = d3.format("$.2f");
const pct = d3.format(".0%");

const mix = rows.filter((r) => r.gb_total && r.gb_mobility).map((r) => ({
  p: r.period, t: qDate(r.period), m: r.gb_mobility, d: r.gb_delivery,
  o: r.gb_total - r.gb_mobility - r.gb_delivery, total: r.gb_total,
}));
const last = rows[rows.length - 1];
const L = last.period;
const per20 = (num, den) => (num === "" || num == null || !den ? null : (20 * num) / den);
const keep = rows.filter((r) => r.rev_total && r.rev_first_reported === 0 && r.gb_mobility).map((r) => ({
  p: r.period, t: qDate(r.period), m: per20(r.rev_mobility, r.gb_mobility), d: per20(r.rev_delivery, r.gb_delivery),
}));
const ebitdaRows = rows.filter((r) => r.ebitda_mobility !== null && r.ebitda_mobility !== "" && r.gb_mobility);
const profitE = ebitdaRows.map((r) => ({ p: r.period, t: qDate(r.period), m: per20(r.ebitda_mobility, r.gb_mobility), d: per20(r.ebitda_delivery, r.gb_delivery) }));
const profitO = rows.filter((r) => r.oi_mobility !== null && r.oi_mobility !== "").map((r) => ({ p: r.period, t: qDate(r.period), m: per20(r.oi_mobility, r.gb_mobility), d: per20(r.oi_delivery, r.gb_delivery) }));
const geo = rows.filter((r) => r.rev_uscan).map((r) => {
  const tot = r.rev_uscan + r.rev_latam + r.rev_emea + r.rev_apac;
  return { p: r.period, t: qDate(r.period), us: r.rev_uscan / tot, la: r.rev_latam / tot, em: r.rev_emea / tot, ap: r.rev_apac / tot, orig: r.rev_first_reported === 1 };
});

// ---------- text fills ----------
const fill = (k, v) => document.querySelectorAll(`[data-fill="${k}"]`).forEach((el) => (el.textContent = v));
const q0 = mix[0];
fill("first-label", qLabel(q0.p).replace("January to March", "early"));
fill("last-label", qLabel(L));
fill("q0-total", money(q0.total));
fill("q0-m", `${money(q0.m)}, ${pct(q0.m / q0.total)},`);
fill("q0-d", money(q0.d));
const cv = mix.find((r) => r.p === "2020Q2"), cvPrev = mix.find((r) => r.p === "2019Q2");
fill("cv-m", money(cv.m));
fill("cv-m-drop", pct(1 - cv.m / cvPrev.m));
fill("cv-d", money(cv.d));
let run = 0, best = 0;
for (const r of mix) { run = r.d > r.m ? run + 1 : 0; best = Math.max(best, run); }
fill("d-ahead", best);
const tie = mix.find((r) => r.m === r.d);
fill("tie-sentence", tie
  ? `In ${qLabel(tie.p)} the two were dead level: $${d3.format(",")(tie.m)} million each.`
  : "");
const lm = mix[mix.length - 1];
fill("last-total", money(lm.total));
fill("last-m-share", pct(lm.m / lm.total));
fill("last-d-share", pct(lm.d / lm.total));
fill("last-trips", `${d3.format(".2f")(last.trips_m / 1000)} billion`);
const useOI = last.oi_mobility !== "" && last.oi_mobility !== null;
const ride = { rev: per20(last.rev_mobility, last.gb_mobility), prof: per20(useOI ? last.oi_mobility : last.ebitda_mobility, last.gb_mobility) };
const order = { rev: per20(last.rev_delivery, last.gb_delivery), prof: per20(useOI ? last.oi_delivery : last.ebitda_delivery, last.gb_delivery) };
fill("ride-rev", usd(ride.rev)); fill("ride-profit", usd(ride.prof));
fill("order-rev", usd(order.rev)); fill("order-profit", usd(order.prof));
fill("corp-cost", money(-(useOI ? last.oi_corporate : last.ebitda_corporate)));
const k0 = keep[0], kL = keep[keep.length - 1];
fill("keep-sentence", `In ${qLabel(k0.p)} Uber kept ${usd(k0.m)} of every $20 ride and ${usd(k0.d)} of every $20 order. Now it's ${usd(kL.m)} and ${usd(kL.d)}.`);
const worst = profitE.reduce((a, b) => (b.d < a.d ? b : a));
fill("eats-worst", usd(-worst.d)); fill("eats-worst-q", qLabel(worst.p));
const turn = profitE.find((r) => r.d > 0);
fill("eats-turn", turn ? `It first made money on delivery in ${qLabel(turn.p)}: ${usd(turn.d)} per $20. By ${qLabel(L)} it was making ${usd(order.prof)}.` : "");
fill("ride-first", usd(profitE[0].m)); fill("ride-first-q", qLabel(profitE[0].p)); fill("ride-last", usd(ride.prof));
fill("ebitda-last", qLabel(profitE[profitE.length - 1].p));
const gFirst = geo.find((g) => !g.orig) || geo[0], gLast = geo[geo.length - 1];
fill("geo-us-first", pct(gFirst.us)); fill("geo-first-q", qLabel(gFirst.p));
fill("geo-us-last", pct(gLast.us)); fill("geo-last-q", qLabel(gLast.p));
const gq = meta.geo_quotes;
fill("countries-first", gq[0].countries); fill("countries-last", `“${gq[gq.length - 1].countries}”`);

// ---------- layout ----------
let W = 600, H = 400;
const M = { t: 34, r: 92, b: 34, l: 50 };
function size() {
  const n = svg.node().getBoundingClientRect();
  W = Math.max(300, n.width); H = Math.max(280, n.height);
  M.r = W < 520 ? 74 : 150;
  M.l = W < 520 ? 40 : 52;
  svg.attr("viewBox", `0 0 ${W} ${H}`);
}
size();
const root = svg.append("g");
const x = d3.scaleTime();
const y = d3.scaleLinear();

function frame(title) {
  root.selectAll("*").remove();
  root.append("text").attr("class", "title").attr("x", M.l).attr("y", 16).text(title);
  x.domain([qDate("2018Q1"), qDate(L)]).range([M.l, W - M.r]);
}
function axes(yfmt, ticks = 5) {
  const xa = root.append("g").attr("class", "axis").attr("transform", `translate(0,${H - M.b})`)
    .call(d3.axisBottom(x).ticks(d3.timeYear.every(W < 520 ? 2 : 1)).tickFormat(d3.timeFormat("%Y")).tickSizeOuter(0));
  xa.select(".domain").remove();
  root.append("g").attr("class", "axis").attr("transform", `translate(${M.l},0)`)
    .call(d3.axisLeft(y).ticks(ticks).tickFormat(yfmt).tickSize(-(W - M.l - M.r)))
    .call((g) => g.select(".domain").remove())
    .call((g) => g.selectAll(".tick line").attr("stroke-opacity", 0.6));
}
function hover(series, fmt) {
  // Crosshair + tooltip over a time chart. series: [{key, name, data:[{t,p,..}]}]
  const line = root.append("line").attr("class", "hover-line").attr("y1", M.t).attr("y2", H - M.b).style("opacity", 0);
  const all = series[0].data;
  root.append("rect").attr("x", M.l).attr("y", M.t).attr("width", W - M.l - M.r).attr("height", H - M.t - M.b)
    .attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const [mx] = d3.pointer(ev);
      const t = x.invert(mx);
      const i = d3.bisector((d) => d.t).center(all, t);
      const r = all[i];
      line.attr("x1", x(r.t)).attr("x2", x(r.t)).style("opacity", 1);
      const lines = series.map((s) => { const v = s.data.find((d) => d.p === r.p); return v && v[s.key] != null ? `${s.name}: ${fmt(v[s.key], v)}` : null; }).filter(Boolean);
      tip.html(`<b>${qShort(r.p)}</b><br>${lines.join("<br>")}`).style("opacity", 1)
        .style("left", `${Math.min(ev.clientX + 14, window.innerWidth - 190)}px`).style("top", `${ev.clientY + 14}px`);
    })
    .on("pointerleave", () => { line.style("opacity", 0); tip.style("opacity", 0); });
}

// ---------- the mix (stacked area) ----------
function drawMix(share, mark) {
  frame(share ? "Share of what people spent through Uber" : "What people spent through Uber each quarter");
  const keys = ["m", "d", "o"];
  const data = mix.map((r) => share ? { ...r, m: r.m / r.total, d: r.d / r.total, o: r.o / r.total } : r);
  y.domain([0, share ? 1 : d3.max(mix, (r) => r.total) * 1.05]).range([H - M.b, M.t]);
  axes(share ? d3.format(".0%") : (v) => `$${v / 1000}B`, share ? 4 : 5);
  const stack = d3.stack().keys(keys)(data);
  const area = d3.area().x((d) => x(d.data.t)).y0((d) => y(d[0])).y1((d) => y(d[1])).curve(d3.curveMonotoneX);
  root.append("g").selectAll("path").data(stack).join("path")
    .attr("d", area).attr("fill", (s) => C[s.key]).attr("stroke", C.paper).attr("stroke-width", 2);
  // direct labels at the right edge
  const lastS = stack.map((s) => ({ k: s.key, v: s[s.length - 1] }));
  let prevY = Infinity;
  for (const s of lastS) {
    const narrow = W < 520;
    const yy = Math.min(prevY - (narrow ? 30 : 15), y((s.v[0] + s.v[1]) / 2));
    prevY = yy;
    const val = share ? pct(s.v[1] - s.v[0]) : `$${d3.format(".1f")((s.v[1] - s.v[0]) / 1000)}B`;
    const t = root.append("text").attr("class", "series-label").attr("x", W - M.r + 6).attr("y", yy + 4).style("fill", C.ink);
    if (narrow) {
      // phones: name on one line, value under it
      t.append("tspan").text(NAMES[s.k].split(" ")[0]);
      t.append("tspan").attr("x", W - M.r + 6).attr("dy", 15).style("font-weight", 400).text(val);
    } else t.text(`${NAMES[s.k]} ${val}`);
  }
  if (mark) {
    const r = data.find((d) => d.p === mark);
    const cx = x(r.t);
    root.append("line").attr("class", "zero").attr("x1", cx).attr("x2", cx).attr("y1", M.t + 4).attr("y2", H - M.b);
    root.append("text").attr("class", "note-strong").attr("x", cx + (cx > W / 2 ? -6 : 6)).attr("y", M.t + 14)
      .attr("text-anchor", cx > W / 2 ? "end" : "start").text(qShort(mark));
  }
  hover(keys.map((k) => ({ key: k, name: NAMES[k], data })),
    (v, row) => (share ? pct(v) : money(v)));
}

// ---------- the $20 bills ----------
function drawBills(which) {
  frame(`Where $20 goes, ${qShort(L)} averages`);
  const items = [{ name: "A $20 ride", c: C.m, ...ride }, { name: "A $20 food or grocery order", c: C.d, ...order }].slice(0, which);
  const bw = Math.min(W - 40, 560), bh = Math.min(bw / 2.35, (H - 60) / 2 - 64);
  const x0 = (W - bw) / 2;
  const s = d3.scaleLinear().domain([0, 20]).range([0, bw]);
  items.forEach((it, i) => {
    const y0 = 44 + i * (bh + 84);
    const g = root.append("g").attr("transform", `translate(${x0},${y0})`);
    g.append("text").attr("class", "bill-big").attr("x", 0).attr("y", 0).text(it.name);
    const by = 10;
    g.append("rect").attr("x", 0).attr("y", by).attr("width", bw).attr("height", bh).attr("fill", C.paper);
    // Uber's revenue share sits at the right end of the bill; profit is the solid part of it.
    g.append("rect").attr("x", s(20 - it.rev)).attr("y", by).attr("width", s(it.rev)).attr("height", bh).attr("fill", it.c).attr("fill-opacity", 0.28);
    g.append("rect").attr("x", s(20 - it.prof)).attr("y", by).attr("width", s(it.prof)).attr("height", bh).attr("fill", it.c);
    g.append("rect").attr("class", "bill-edge").attr("x", 0).attr("y", by).attr("width", bw).attr("height", bh).attr("rx", 6);
    g.append("text").attr("x", 12).attr("y", by + 28).attr("class", "bill-big").text(usd(20 - it.rev));
    g.append("text").attr("x", 12).attr("y", by + 48).attr("class", "bill-label").text(W < 520 ? "to the driver or shop," : "to the driver, courier or shop,");
    g.append("text").attr("x", 12).attr("y", by + 66).attr("class", "bill-label").text("plus taxes, tolls and fees");
    const rx = s(20 - it.rev);
    g.append("text").attr("x", rx - 8).attr("y", by + bh + 20).attr("text-anchor", "end").attr("class", "bill-label")
      .text(`Uber's revenue ${usd(it.rev)}`);
    g.append("line").attr("x1", rx).attr("x2", rx).attr("y1", by + bh).attr("y2", by + bh + 26).attr("stroke", C.ink);
    g.append("text").attr("x", bw).attr("y", by + bh + 38).attr("text-anchor", "end").attr("class", "bill-label")
      .text(`of which profit ${usd(it.prof)}`);
  });
}

// ---------- lines over time ----------
function drawLines(title, sets, yfmt, note) {
  frame(title);
  const vals = sets.flatMap((s) => s.data.map((d) => d[s.key])).filter((v) => v != null);
  y.domain([Math.min(0, d3.min(vals)) * 1.1, d3.max(vals) * 1.12]).nice().range([H - M.b, M.t]);
  axes(yfmt);
  root.append("line").attr("class", "zero").attr("x1", M.l).attr("x2", W - M.r).attr("y1", y(0)).attr("y2", y(0));
  for (const s of sets) {
    const ln = d3.line().defined((d) => d[s.key] != null).x((d) => x(d.t)).y((d) => y(d[s.key]));
    root.append("path").attr("d", ln(s.data)).attr("fill", "none").attr("stroke", C[s.key]).attr("stroke-width", 2.5)
      .attr("stroke-dasharray", s.dash ? "4 4" : null);
    if (s.label) {
      const e = s.data[s.data.length - 1];
      root.append("text").attr("class", "series-label").attr("x", W - M.r + 6).attr("y", y(e[s.key]) + 4 + (s.dy || 0))
        .style("fill", C.ink).text(`${s.label} ${yfmt(e[s.key])}`);
    }
  }
  if (note) note();
  // hover walks every quarter any series covers
  const allP = [...new Set(sets.flatMap((s) => s.data.map((d) => d.p)))].sort().map((p) => ({ p, t: qDate(p) }));
  // (the first entry only supplies the quarters to snap to; it has no values, so it prints no line)
  hover([{ key: "none", name: "", data: allP }, ...sets.map((s) => ({ key: s.key, name: s.name, data: s.data }))], (v) => usd(v));
}
function annotate(p, text, yv, dy = -10) {
  const cx = x(qDate(p)), cy = y(yv);
  root.append("circle").attr("cx", cx).attr("cy", cy).attr("r", 4).attr("fill", "none").attr("stroke", C.ink);
  root.append("text").attr("class", "note").attr("x", cx).attr("y", cy + dy).attr("text-anchor", cx > W * 0.6 ? "end" : "middle").text(text);
}

function drawGeo() {
  frame("Uber's revenue by region, share of total");
  const keys = [["us", "US and Canada", C.m], ["em", "Europe, Middle East, Africa", C.soft], ["la", "Latin America", C.o], ["ap", "Asia Pacific", "#14134a"]];
  x.domain([geo[0].t, geo[geo.length - 1].t]);
  y.domain([0, 1]).range([H - M.b, M.t]);
  axes(d3.format(".0%"), 4);
  const stack = d3.stack().keys(keys.map((k) => k[0]))(geo);
  const area = d3.area().x((d) => x(d.data.t)).y0((d) => y(d[0])).y1((d) => y(d[1])).curve(d3.curveMonotoneX);
  root.append("g").selectAll("path").data(stack).join("path").attr("d", area)
    .attr("fill", (s, i) => keys[i][2]).attr("stroke", C.paper).attr("stroke-width", 2);
  let prevY = Infinity;
  stack.forEach((s, i) => {
    const v = s[s.length - 1];
    const yy = Math.min(prevY - 15, y((v[0] + v[1]) / 2));
    prevY = yy;
    root.append("text").attr("class", "series-label").attr("x", W - M.r + 6).attr("y", yy + 4).style("fill", C.ink)
      .text(W < 520 ? keys[i][1].split(/[ ,]/)[0] : keys[i][1].replace("Europe, Middle East, Africa", "EMEA"));
  });
  const cut = geo.find((g) => !g.orig);
  if (cut && cut !== geo[0]) {
    const cx = x(cut.t);
    root.append("line").attr("class", "hover-line").attr("x1", cx).attr("x2", cx).attr("y1", M.t).attr("y2", H - M.b);
    root.append("text").attr("class", "note").attr("x", cx - 4).attr("y", M.t - 4).attr("text-anchor", "end").text("as first reported");
  }
  hover(keys.map(([k, n]) => ({ key: k, name: n, data: geo })), (v) => pct(v));
}

// ---------- steps ----------
const STEPS = [
  () => drawMix(false, mix[0].p),
  () => drawMix(false, "2020Q2"),
  () => drawMix(true, tie ? tie.p : null),
  () => drawMix(true, null),
  () => drawBills(1),
  () => drawBills(2),
  () => drawLines("Uber's revenue from every $20 spent", [
    { key: "m", name: "Rides", label: "Rides", data: keep },
    { key: "d", name: "Delivery", label: "Delivery", data: keep },
  ], (v) => usd(v), () => {
    const q121 = keep.find((d) => d.p === "2021Q1");
    if (q121) annotate("2021Q1", "UK drivers' claims", q121.m, 18);
    const q222 = keep.find((d) => d.p === "2022Q2");
    if (q222) annotate("2022Q2", "UK change", q222.m, -10);
  }),
  () => drawLines("Profit per $20, by business line", [
    { key: "m", name: "Rides (adjusted EBITDA)", data: profitE },
    { key: "d", name: "Delivery (adjusted EBITDA)", data: profitE },
    { key: "m", name: "Rides (operating income)", label: "Rides", data: profitO, dash: true },
    { key: "d", name: "Delivery (operating income)", label: "Delivery", data: profitO, dash: true },
  ], (v) => usd(v)),
  () => drawGeo(),
];
let cur = 0;
scroller(document.querySelectorAll(".step"), (i) => { cur = i; STEPS[i](); });
STEPS[0]();
let rw = window.innerWidth;
window.addEventListener("resize", () => { if (window.innerWidth === rw) return; rw = window.innerWidth; size(); STEPS[cur](); });

// ---------- sources + table ----------
const src = d3.select("#sources");
const docs = Object.entries(meta.documents);
src.append("li").html(`Quarterly earnings releases (Form 8-K, Exhibit 99.1) on SEC EDGAR: ${docs.filter(([k]) => k.startsWith("uberq")).map(([k, u]) => `<a href="${u}">${k.replace(/uberq(\d)(\d\d).*/, "Q$1 20$2")}</a>`).join(", ")}.`);
src.append("li").html(`IPO prospectus (Form S-1/A, April 26, 2019): <a href="${meta.documents["d647752ds1a.htm"]}">first quarter of 2018</a>, second quarter of 2018 from the Q2 2019 release.`);
src.append("li").html(`Annual reports (10-K) for country counts: ${gq.slice(1).map((g) => { const f = g.filing.match(/\((.*)\)/)[1]; return `<a href="${meta.documents[f]}">${g.filing.split(" (")[0]}</a> (“${g.countries_text}”)`; }).join("; ")}.`);
src.append("li").html(`Revenue cross-check: SEC XBRL company facts, <a href="${meta.xbrl}">Uber Technologies (CIK 1543151)</a>.`);
const restated = Object.entries(meta.restated).map(([k, v]) => `${k}: ${v}`);
fill("check-summary", `All of them pass. Where a later release restated a quarter (${Object.keys(meta.restated).length} cases), the later figure is used.`);

const cols = [["period", "Quarter"], ["gb_mobility", "Rides bookings"], ["gb_delivery", "Delivery bookings"], ["gb_total", "All bookings"],
  ["rev_mobility", "Rides revenue"], ["rev_delivery", "Delivery revenue"], ["rev_total", "Revenue"],
  ["ebitda_mobility", "Rides adj. EBITDA"], ["ebitda_delivery", "Delivery adj. EBITDA"], ["oi_mobility", "Rides op. income"], ["oi_delivery", "Delivery op. income"], ["trips_m", "Trips (m)"], ["sources", "Release"]];
const tbl = d3.select("#table").append("table");
tbl.append("tr").selectAll("th").data(cols).join("th").text((c) => c[1]);
tbl.selectAll("tr.r").data(rows).join("tr").attr("class", "r").selectAll("td").data((r) => cols.map((c) => [c[0], r[c[0]]])).join("td")
  .html(([k, v]) => k === "sources" ? String(v).split(" ").map((f) => `<a href="${meta.documents[f]}">${f.replace(/uberq(\d)(\d\d).*/, "Q$1 20$2").replace("d647752ds1a.htm", "S-1")}</a>`).join(" ")
    : k === "period" ? qShort(v) : v === "" || v == null ? "" : d3.format(",")(v));
