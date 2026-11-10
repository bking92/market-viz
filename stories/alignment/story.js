import { scroller } from "../../assets/js/scroller.js";

const svg = d3.select("#chart");
const css = getComputedStyle(document.documentElement);
const C = {
  brand: css.getPropertyValue("--brand").trim(),
  soft: css.getPropertyValue("--brand-soft").trim(),
  loss: css.getPropertyValue("--loss").trim(),
  lossText: css.getPropertyValue("--loss-text").trim(),
  ink: css.getPropertyValue("--ink").trim(),
  inkSoft: css.getPropertyValue("--ink-soft").trim(),
  rule: css.getPropertyValue("--rule").trim(),
  paper: css.getPropertyValue("--paper").trim(),
  citron: css.getPropertyValue("--citron").trim(),
  grey: "#a39a8a",
};

const [prices, quarters, meta] = await Promise.all([
  d3.csv("data/prices.csv", (d) => ({ date: d3.timeParse("%Y-%m-%d")(d.date), close: +d.close })),
  d3.csv("data/quarters.csv", d3.autoType),
  d3.json("data/meta.json"),
]);

// ---------------------------------------------------------------- text
const parse = d3.timeParse("%Y-%m-%d");
const longDate = d3.timeFormat("%B %-d, %Y");
const monthYear = d3.timeFormat("%B %Y");
const usd = d3.format("$.2f");
const pct0 = d3.format(".0%");
const bn = (v) => `$${d3.format(".1f")(v)} billion`;
const fill = (k, v) => document.querySelectorAll(`[data-fill="${k}"]`).forEach((el) => (el.textContent = v));
const q0 = quarters[0], qN = quarters[quarters.length - 1], qY = quarters[quarters.length - 5];
const ev = meta.events;
const evBy = Object.fromEntries(ev.map((e) => [e.src || "cost", e]));
const S = meta.stars;
fill("last-date", longDate(parse(meta.last.date)));
fill("m-first", d3.format(",")(q0.members));
fill("m-last", d3.format(",")(qN.members));
fill("m-yoy", pct0(qN.members / qY.members - 1));
fill("ipo", usd(meta.ipo_price));
fill("low", usd(meta.low.close));
fill("low-date", monthYear(parse(meta.low.date)));
fill("peak", usd(meta.peak_2026.close));
fill("peak-date", longDate(parse(meta.peak_2026.date)).replace(/, \d{4}$/, ""));
fill("peak-value", bn(meta.peak_2026.value_bn));
fill("last", usd(meta.last.close));
fill("last-value", bn(meta.last.value_bn));
fill("star-drop", pct0(-evBy.h3815_cut.change));
fill("cost-drop", pct0(-evBy.cost.change));
const P = meta.per100;
fill("care", usd(P.care));
fill("running", usd(P.running));
fill("equip", usd(P.equipment));
fill("profit", usd(P.operating_profit));
fill("net", usd(P.net_profit));
fill("ind-2026", `${S.share_4plus.industry["2026"]}%`);
fill("ind-2027", `${S.share_4plus.industry["2027"]}%`);
fill("n-quarters", quarters.length);
fill("shares-peak", `${d3.format(",")(meta.peak_2026.shares)} on ${longDate(parse(meta.peak_2026.shares_as_of))}`);
fill("shares-last", `${d3.format(",")(meta.last.shares)} on ${longDate(parse(meta.last.shares_as_of))}`);

// ---------------------------------------------------------------- geometry helpers
function starPath(cx, cy, R) {
  const r = R * 0.4;
  const pts = d3.range(10).map((i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r : R;
    return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)];
  });
  return "M" + pts.map((p) => p.map((v) => v.toFixed(2)).join(",")).join("L") + "Z";
}
let clipId = 0;
// A star filled from the left to `frac` (0..1). Returns the group; the fill rect can be transitioned later.
function star(g, cx, cy, R, frac, { cls = "star-fill", stroke = true } = {}) {
  const id = `clip-${clipId++}`;
  const s = g.append("g").attr("class", "star");
  s.append("clipPath").attr("id", id).append("path").attr("d", starPath(cx, cy, R));
  s.append("rect").attr("class", "fill " + cls).attr("clip-path", `url(#${id})`)
    .attr("x", cx - R).attr("y", cy - R).attr("height", 2 * R).attr("width", 2 * R * frac);
  if (stroke) s.append("path").attr("class", "star-bg").attr("d", starPath(cx, cy, R)).attr("stroke-linejoin", "round");
  s.datum({ cx, R });
  return s;
}

// ---------------------------------------------------------------- scenes
// Every scene draws into its own <g>; render(step) fades scenes in and out and sets each scene's state.
let W = 0, H = 0, narrow = false;
const scenes = {};
let current = -1;

function layout() {
  const box = svg.node().getBoundingClientRect();
  W = Math.max(300, box.width);
  H = Math.max(300, box.height);
  narrow = W < 560;
  svg.attr("viewBox", `0 0 ${W} ${H}`);
  svg.selectAll("*").remove();
  for (const name of ["stars", "dots", "price", "fall", "waffle", "history", "share", "timeline"]) {
    scenes[name] = svg.append("g").attr("class", `scene ${name}`).style("opacity", 0).style("display", "none");
  }
  drawStars(); drawDots(); drawPrice(); drawFall(); drawWaffle(); drawHistory(); drawShare(); drawTimeline();
}

// ---- 1. the five-star grade
function drawStars() {
  const g = scenes.stars;
  const R = Math.min(W / 11.5, H / 5);
  const gap = R * 2.15;
  const x0 = W / 2 - 2 * gap, cy = H * 0.42;
  g.selectAll(".star").remove();
  const stars = d3.range(5).map((i) => star(g, x0 + i * gap, cy, R, i < 4 ? 1 : 0));
  // The half that goes: drawn under star 4's right half, in tomato, faded out when the grade drops.
  const s4 = stars[3].datum();
  const lost = star(g, s4.cx, cy, R, 1, { cls: "star-lost", stroke: false }).attr("class", "lost").style("opacity", 0);
  lost.select("rect").attr("x", s4.cx).attr("width", R);
  lost.lower();
  g.append("text").attr("class", "big grade").attr("x", W / 2).attr("y", cy + R * 1.9).attr("text-anchor", "middle").text("4.0");
  g.append("text").attr("class", "mid sub").attr("x", W / 2).attr("y", cy + R * 1.9 + 28).attr("text-anchor", "middle")
    .text(narrow ? "California HMO, H3815" : "Alignment's California HMO (contract H3815)");
  g.append("text").attr("class", "mid year").attr("x", W / 2).attr("y", cy - R * 1.6).attr("text-anchor", "middle")
    .style("font-style", "italic").text("Rating for 2026");
  scenes.stars.node().__stars = stars;
}
function setGrade(half) {
  const g = scenes.stars, stars = g.node().__stars;
  const s4 = stars[3].datum();
  stars[3].select("rect.fill").transition().duration(half ? 1400 : 600).ease(d3.easeCubicInOut).attr("width", half ? s4.R : 2 * s4.R);
  g.select(".lost").interrupt().style("opacity", half ? 1 : 0).transition().delay(half ? 600 : 0).duration(half ? 1600 : 0).style("opacity", half ? 0.25 : 0);
  g.select(".grade").text(half ? "3.5" : "4.0").attr("class", "big grade").style("fill", half ? C.lossText : C.ink);
  g.select(".year").text(half ? "Rating for 2027" : "Rating for 2026");
}

// ---- 2. members as dots
function drawDots() {
  const g = scenes.dots;
  const n = Math.round(qN.members / 1000);
  const top = narrow ? 70 : 84;
  const availH = H - top - 20, availW = W - 20;
  let cols = Math.ceil(Math.sqrt((n * availW) / availH));
  let cell = Math.min(availW / cols, availH / Math.ceil(n / cols));
  cols = Math.floor(availW / cell);
  const rows = Math.ceil(n / cols);
  const x0 = (W - cols * cell) / 2, y0 = top;
  const h3815 = Math.round(n * S.h3815_share_of_members);
  const data = d3.range(n).map((i) => ({ i, x: x0 + (i % cols) * cell + cell / 2, y: y0 + Math.floor(i / cols) * cell + cell / 2, plan: i < h3815 }));
  g.selectAll("circle").data(data).join("circle").attr("cx", (d) => d.x).attr("cy", (d) => d.y).attr("r", cell * 0.36).attr("fill", C.brand).style("opacity", 0);
  g.append("text").attr("class", "big count").attr("x", x0).attr("y", 34);
  g.append("text").attr("class", "mid when").attr("x", x0).attr("y", 58).style("font-style", "italic");
  g.node().__rows = rows;
}
let dotTimer = null;
function setDots(mode) {
  const g = scenes.dots;
  if (dotTimer) dotTimer.stop();
  const dots = g.selectAll("circle");
  const say = (q) => {
    g.select(".count").text(`${d3.format(",")(q.members)} members`);
    const [y, k] = [q.period.slice(0, 4), q.period[5]];
    g.select(".when").text(`${["March", "June", "September", "December"][k - 1]} ${y}`);
  };
  if (mode === "grow") {
    dots.attr("fill", C.brand);
    let qi = 0;
    const show = (q) => dots.style("opacity", (d) => (d.i < Math.round(q.members / 1000) ? 1 : 0));
    show(quarters[0]); say(quarters[0]);
    dotTimer = d3.interval(() => {
      qi += 1;
      if (qi >= quarters.length) { dotTimer.stop(); return; }
      show(quarters[qi]); say(quarters[qi]);
    }, 160);
  } else {
    say(qN);
    dots.style("opacity", 1).transition().duration(700).delay((d) => d.i * 1.5)
      .attr("fill", (d) => (mode === "plan" && !d.plan ? C.soft : C.brand));
  }
}

// ---- 3 and 4. the share price, all of it and then 2026
const priceX = d3.scaleTime(), priceY = d3.scaleLinear();
function drawPrice() {
  const g = scenes.price;
  const m = { l: 44, r: narrow ? 14 : 30, t: 30, b: 34 };
  priceX.range([m.l, W - m.r]);
  priceY.domain([0, 28]).range([H - m.b, m.t]);
  g.append("g").attr("class", "axis y").attr("transform", `translate(${m.l},0)`);
  g.append("g").attr("class", "axis x").attr("transform", `translate(0,${H - m.b})`);
  g.append("line").attr("class", "ipo").attr("x1", m.l).attr("x2", W - m.r).attr("y1", priceY(meta.ipo_price)).attr("y2", priceY(meta.ipo_price));
  g.append("text").attr("class", "ipo-label").attr("y", priceY(meta.ipo_price) - 6).attr("text-anchor", "middle").text(`IPO price, ${usd(meta.ipo_price)}`);
  g.append("path").attr("class", "price");
  g.append("g").attr("class", "drops");
  g.append("g").attr("class", "notes");
}
function setPrice(mode) {
  const g = scenes.price;
  const zoom = mode === "2026";
  const data = zoom ? prices.filter((d) => d.date >= new Date(2026, 0, 1)) : prices;
  priceX.domain(d3.extent(data, (d) => d.date));
  const t = svg.transition().duration(900).ease(d3.easeCubicInOut);
  const line = d3.line().x((d) => priceX(d.date)).y((d) => priceY(d.close));
  g.select(".axis.y").transition(t).call(d3.axisLeft(priceY).ticks(5).tickFormat((v) => `$${v}`).tickSize(-(W - 80))).call((a) => a.select(".domain").remove())
    .call((a) => a.selectAll(".tick line").attr("stroke", C.rule));
  const ticks = zoom ? d3.timeMonth.every(narrow ? 2 : 1) : d3.timeYear.every(1);
  g.select(".axis.x").transition(t).call(d3.axisBottom(priceX).ticks(ticks).tickFormat(zoom ? d3.timeFormat("%b") : d3.timeFormat("%Y")).tickSizeOuter(0));
  // IPO label sits over the stretch where the price is furthest below $18.
  const lowPt = d3.least(data.filter((d) => priceX(d.date) > priceX.range()[0] + 60 && priceX(d.date) < priceX.range()[1] - 60), (d) => d.close);
  g.select(".ipo-label").style("display", zoom && narrow ? "none" : null).transition(t).attr("x", priceX(lowPt.date));
  const path = g.select(".price");
  if (path.attr("d") && path.datum() && path.datum().length !== data.length) {
    path.datum(data).attr("d", line);
  } else {
    path.datum(data).attr("d", line);
  }
  // Drops: the close before and the close after, joined, in tomato.
  const P = new Map(prices.map((d) => [d3.timeFormat("%Y-%m-%d")(d.date), d]));
  const drops = zoom ? ev.map((e) => {
    const iA = prices.findIndex((d) => +d.date === +parse(e.date));
    const end = prices.findIndex((d) => +d.date === +parse(e.end));
    return { e, pts: prices.slice(iA - 1, end + 1) };
  }) : [];
  g.select(".drops").selectAll("path").data(drops).join("path").attr("class", "drop").attr("d", (d) => line(d.pts))
    .style("opacity", 0).transition().delay(900).duration(500).style("opacity", 1);
  const notes = g.select(".notes");
  notes.selectAll("*").remove();
  const pk = prices.find((d) => +d.date === +parse(meta.peak_2026.date));
  const ls = prices[prices.length - 1];
  const low = prices.find((d) => +d.date === +parse(meta.low.date));
  const note = (d, text, dx, dy, cls = "note", anchor = "start") => {
    notes.append("circle").attr("class", "dot-ink").attr("cx", priceX(d.date)).attr("cy", priceY(d.close)).attr("r", 3.5);
    notes.append("text").attr("class", cls).attr("x", priceX(d.date) + dx).attr("y", priceY(d.close) + dy).attr("text-anchor", anchor).text(text);
  };
  notes.style("opacity", 0).transition().delay(900).duration(400).style("opacity", 1);
  note(pk, `${usd(pk.close)}, ${d3.timeFormat("%b %-d")(pk.date)}`, zoom ? 8 : -8, -8, "note-strong", zoom ? "start" : "end");
  note(ls, usd(ls.close), -6, 22, "note-strong", "end");
  if (!zoom) note(low, `${usd(low.close)}, ${d3.timeFormat("%b %Y")(low.date)}`, 0, 22, "note", "middle");
  if (zoom) {
    // Number each drop on the chart; the labels sit beside the tomato marks.
    drops.forEach((d, i) => {
      const a = d.pts[0], b = d.pts[d.pts.length - 1];
      const short = { lawsuit: "Lawsuit", q2_beat: "Q2 call", cost: "Costs", h3815_cut: "Half a star", q3_lower: "Forecast cut" }[d.e.src || "cost"];
      const off = { h3815_cut: [-10, 48, "end"], q3_lower: narrow ? [-10, 80, "end"] : [8, -78, "start"] }[d.e.src] || [6, 4, "start"];
      const lx = priceX(b.date) + off[0], ly = (priceY(a.close) + priceY(b.close)) / 2 + off[1];
      if (off[1] !== 4) notes.append("line").attr("class", "leader").attr("x1", priceX(b.date)).attr("x2", priceX(b.date)).attr("y1", ly + (off[1] < 0 ? 22 : -14)).attr("y2", (priceY(a.close) + priceY(b.close)) / 2 + (off[1] < 0 ? -8 : 8));
      const txt = notes.append("text").attr("x", lx).attr("y", ly).attr("text-anchor", off[2]).attr("class", d.e.src === "h3815_cut" ? "lbl-loss" : "note");
      txt.append("tspan").text(short);
      txt.append("tspan").attr("x", lx).attr("dy", 15).attr("class", "lbl-loss").text(pct0(d.e.change).replace("-", "−"));
    });
  }
}

// ---- 5. the fall, drop by drop
function drawFall() {
  const g = scenes.fall;
  const m = { l: narrow ? 98 : 190, r: 46, t: 40, b: 30 };
  const items = ev.map((e) => ({ label: { lawsuit: "Lawsuit (Jul 8)", q2_beat: "After Q2 call (Jul 31)", cost: "Cost warning (Sep 15–16)", h3815_cut: "Half a star (Oct 9)", q3_lower: "Forecast cut (Oct 30)" }[e.src || "cost"], d: e.before - e.after, star: e.src === "h3815_cut" }));
  const evSum = d3.sum(items, (d) => d.d);
  items.push({ label: "All other days", d: meta.peak_2026.close - meta.last.close - evSum, other: true });
  let run = meta.peak_2026.close;
  for (const it of items) { it.from = run; run -= it.d; it.to = run; }
  const x = d3.scaleLinear().domain([0, meta.peak_2026.close]).range([m.l, W - m.r]);
  const y = d3.scaleBand().domain(d3.range(items.length + 2)).range([m.t, H - m.b]).padding(0.28);
  g.append("text").attr("class", "note").attr("x", m.l).attr("y", m.t - 14).text(narrow ? "Share price from the July high" : "From the July 6 high of " + usd(meta.peak_2026.close) + ", one drop at a time");
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(5).tickFormat((v) => `$${v}`)).call((a) => a.select(".domain").remove());
  const rowOf = (i) => y(i + 1);
  g.append("rect").attr("x", x(0)).attr("width", x(meta.peak_2026.close) - x(0)).attr("y", y(0)).attr("height", y.bandwidth()).attr("fill", C.brand);
  g.append("text").attr("x", m.l - 8).attr("y", y(0) + y.bandwidth() / 2 + 4).attr("text-anchor", "end").attr("class", "lbl-ink").text("July 6 high");
  const rows = g.selectAll(".row").data(items).join("g").attr("class", "row");
  rows.append("rect").attr("x", (d) => x(d.to)).attr("width", (d) => x(d.from) - x(d.to)).attr("y", (d, i) => rowOf(i)).attr("height", y.bandwidth())
    .attr("fill", (d) => (d.other ? C.grey : C.loss)).attr("stroke", (d) => (d.star ? C.ink : "none")).attr("stroke-width", 2);
  rows.append("text").attr("x", m.l - 8).attr("y", (d, i) => rowOf(i) + y.bandwidth() / 2 + 4).attr("text-anchor", "end")
    .attr("class", (d) => (d.star ? "lbl-loss" : "lbl-ink")).text((d) => (narrow ? d.label.replace(/ \(.*\)/, "") : d.label));
  rows.append("text").attr("x", (d) => x(d.from) + 6).attr("y", (d, i) => rowOf(i) + y.bandwidth() / 2 + 4).attr("class", "note").text((d) => `−${usd(d.d)}`);
  const ny = y(items.length + 1);
  g.append("rect").attr("x", x(0)).attr("width", x(meta.last.close) - x(0)).attr("y", ny).attr("height", y.bandwidth()).attr("fill", C.ink);
  g.append("text").attr("x", m.l - 8).attr("y", ny + y.bandwidth() / 2 + 4).attr("text-anchor", "end").attr("class", "lbl-ink").text("Nov 6");
  g.append("text").attr("x", x(meta.last.close) + 6).attr("y", ny + y.bandwidth() / 2 + 4).attr("class", "note-strong").text(usd(meta.last.close));
  g.selectAll(".row rect").each(function () { this.__w = +this.getAttribute("width"); });
}
function setFall() {
  scenes.fall.selectAll(".row").style("opacity", 0).transition().delay((d, i) => 250 + i * 260).duration(300).style("opacity", 1);
}

// ---- 6 and 7. out of every $100
function drawWaffle() {
  const g = scenes.waffle;
  const top = narrow ? 64 : 76;
  const extraCols = 3; // room on the right for the five bonus squares
  const s = Math.min((W - 30) / (10 + extraCols), (H - top - 20) / 10);
  const x0 = (W - s * (10 + extraCols)) / 2, y0 = top;
  // Fill squares in order, row by row from the top: care, running, equipment, profit. Fractions split a square.
  const parts = [["care", P.care, C.brand], ["running", P.running, C.grey], ["equipment", P.equipment, C.rule], ["profit", P.operating_profit, C.citron]];
  const cells = [];
  let pos = 0;
  for (const [k, v, col] of parts) {
    let left = v;
    while (left > 1e-9) {
      const cell = Math.floor(pos + 1e-9), inCell = pos - cell;
      const take = Math.min(left, 1 - inCell);
      cells.push({ k, col, cell, from: inCell, w: take });
      pos += take; left -= take;
    }
  }
  const cx = (c) => x0 + (c % 10) * s, cy = (c) => y0 + Math.floor(c / 10) * s;
  g.selectAll("rect.part").data(cells).join("rect").attr("class", "part").attr("x", (d) => cx(d.cell) + d.from * (s - 2) + 1).attr("y", (d) => cy(d.cell) + 1)
    .attr("width", (d) => d.w * (s - 2)).attr("height", s - 2).attr("fill", (d) => d.col);
  g.selectAll("rect.grid").data(d3.range(100)).join("rect").attr("class", "grid").attr("x", (c) => cx(c) + 1).attr("y", (c) => cy(c) + 1)
    .attr("width", s - 2).attr("height", s - 2).attr("fill", "none").attr("stroke", C.paper).attr("stroke-width", 1.2);
  // Profit squares get an ink outline so the citron reads on cream.
  const profitCells = cells.filter((d) => d.k === "profit");
  g.selectAll("rect.edge").data(profitCells).join("rect").attr("class", "edge").attr("x", (d) => cx(d.cell) + d.from * (s - 2) + 1).attr("y", (d) => cy(d.cell) + 1)
    .attr("width", (d) => d.w * (s - 2)).attr("height", s - 2).attr("fill", "none").attr("stroke", C.ink).attr("stroke-width", 1);
  g.append("text").attr("class", "big").attr("x", x0).attr("y", 34).text("Out of every $100");
  g.append("text").attr("class", "mid").attr("x", x0).attr("y", 58).style("font-style", "italic").text("January to September 2026");
  // Bonus: five dashed squares beside the grid, level with the profit sliver.
  const bx = x0 + 10 * s + s * 0.6, by = cy(99);
  const bonus = g.append("g").attr("class", "bonus-g").style("opacity", 0);
  bonus.selectAll("rect").data(d3.range(5)).join("rect").attr("class", "bonus").attr("x", bx).attr("y", (i) => by - i * s + 1)
    .attr("width", s - 3).attr("height", s - 3);
  bonus.append("text").attr("class", "lbl-loss").attr("x", bx).attr("y", by - 4 * s - 24).text("5 points");
  bonus.append("text").attr("class", "note").attr("x", bx).attr("y", by - 4 * s - 8).text(narrow ? "bonus" : "the four-star bonus");
}
function setWaffle(bonus) {
  scenes.waffle.select(".bonus-g").transition().duration(600).style("opacity", bonus ? 1 : 0);
}

// ---- 8. nine years of four stars, then half
function drawHistory() {
  const g = scenes.history;
  const years = d3.range(2018, 2028);
  const perRow = narrow ? 5 : 10;
  const R = Math.min(W / (perRow * 2.45), H / (narrow ? 7 : 5.5));
  const gap = R * 2.4;
  const x0 = W / 2 - ((perRow - 1) * gap) / 2;
  const rows = Math.ceil(years.length / perRow);
  const y0 = H / 2 - ((rows - 1) * R * 3.4) / 2;
  years.forEach((yr, i) => {
    const cx = x0 + (i % perRow) * gap, cy = y0 + Math.floor(i / perRow) * R * 3.4;
    const last = yr === 2027;
    const s = star(g, cx, cy, R, last ? 0.5 : 1);
    s.style("opacity", 0).attr("data-i", i);
    g.append("text").attr("class", last ? "lbl-loss yr" : "lbl-ink yr").attr("x", cx).attr("y", cy + R * 1.55).attr("text-anchor", "middle").style("opacity", 0).attr("data-i", i)
      .text(yr);
  });
  g.append("text").attr("class", "mid").attr("x", W / 2).attr("y", narrow ? 30 : 40).attr("text-anchor", "middle").style("font-style", "italic")
    .text(narrow ? "California HMO: 4 stars or more?" : "Was the California HMO rated four stars or more?");
}
function setHistory() {
  scenes.history.selectAll("[data-i]").style("opacity", 0).transition().delay(function () { return 200 + this.getAttribute("data-i") * 180; }).duration(250).style("opacity", 1);
}

// ---- 9. share of members in four-star plans
function drawShare() {
  const g = scenes.share;
  const m = { l: 44, r: narrow ? 90 : 120, t: 40, b: 34 };
  const yrs = [2023, 2024, 2025, 2026, 2027];
  const x = d3.scalePoint().domain(yrs).range([m.l + 10, W - m.r]);
  const y = d3.scaleLinear().domain([0, 100]).range([H - m.b, m.t]);
  g.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickFormat((v) => `${v}%`).tickSize(-(W - m.l - m.r + 10)))
    .call((a) => a.select(".domain").remove()).call((a) => a.selectAll(".tick line").attr("stroke", C.rule));
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickSize(0)).call((a) => a.select(".domain").remove());
  const ind = yrs.map((yr) => ({ yr, v: S.share_4plus.industry[yr] }));
  const al = yrs.slice(0, 4).map((yr) => ({ yr, v: S.share_4plus.alignment[yr] }));
  const alLast = { yr: 2027, v: S.alignment_2027_max };
  const line = d3.line().x((d) => x(d.yr)).y((d) => y(d.v));
  g.append("path").attr("d", line(ind)).attr("fill", "none").attr("stroke", C.grey).attr("stroke-width", 2.5);
  g.append("path").attr("d", line(al)).attr("fill", "none").attr("stroke", C.brand).attr("stroke-width", 3.5);
  g.append("path").attr("class", "al-drop").attr("d", line([al[3], alLast])).attr("fill", "none").attr("stroke", C.loss).attr("stroke-width", 3.5).attr("stroke-dasharray", "6 5");
  // "At most": a bar from zero to 25% under the last point.
  g.append("line").attr("x1", x(2027)).attr("x2", x(2027)).attr("y1", y(0)).attr("y2", y(alLast.v)).attr("stroke", C.loss).attr("stroke-width", 1).attr("stroke-dasharray", "2 3");
  for (const d of [...ind]) g.append("circle").attr("cx", x(d.yr)).attr("cy", y(d.v)).attr("r", 3.5).attr("fill", C.grey);
  for (const d of [...al]) g.append("circle").attr("cx", x(d.yr)).attr("cy", y(d.v)).attr("r", 4.5).attr("fill", C.brand);
  g.append("circle").attr("cx", x(2027)).attr("cy", y(alLast.v)).attr("r", 5).attr("fill", C.paper).attr("stroke", C.loss).attr("stroke-width", 2);
  g.append("text").attr("class", "lbl-brand").attr("x", (x(2025) + x(2026)) / 2).attr("y", y(100) + 20).attr("text-anchor", "middle").text("Alignment 100%");
  g.append("text").attr("class", "note").attr("x", x(2027) + 10).attr("y", y(71) + 4).text("Industry 71%");
  g.append("text").attr("class", "lbl-loss").attr("x", x(2027) + 10).attr("y", y(alLast.v) + 4).text("Alignment");
  g.append("text").attr("class", "lbl-loss").attr("x", x(2027) + 10).attr("y", y(alLast.v) + 20).text(`≤${alLast.v}%`);
  g.append("text").attr("class", "mid").attr("x", m.l).attr("y", 22).style("font-style", "italic").text(narrow ? "Members in 4-star-or-better plans" : "Share of members in plans rated four stars or more");
}

// ---- 10. look back two years, bite two years ahead
function drawTimeline() {
  const g = scenes.timeline;
  const yrs = [2025, 2026, 2027, 2028];
  const m = { l: narrow ? 30 : 60, r: narrow ? 30 : 60 };
  const x = d3.scaleLinear().domain([2025, 2029]).range([m.l, W - m.r]);
  const y = H * 0.5;
  g.append("line").attr("x1", x(2025)).attr("x2", x(2029)).attr("y1", y).attr("y2", y).attr("stroke", C.ink).attr("stroke-width", 1.5);
  yrs.forEach((yr) => {
    g.append("rect").attr("x", x(yr) + 2).attr("width", x(yr + 1) - x(yr) - 4).attr("y", y - 10).attr("height", 20)
      .attr("fill", yr === 2025 ? C.brand : yr === 2028 ? C.loss : C.rule).attr("class", `yr-${yr}`);
    g.append("text").attr("class", "mid").attr("x", (x(yr) + x(yr + 1)) / 2).attr("y", y + 38).attr("text-anchor", "middle").text(yr);
  });
  const sR = narrow ? 18 : 24, sy = y - 70;
  const oct8 = 2026 + (d3.timeDay.count(new Date(2026, 0, 1), new Date(2026, 9, 8)) / 365);
  star(g, x(oct8), sy, sR, 0.5);
  g.append("line").attr("class", "leader").attr("x1", x(oct8)).attr("x2", x(oct8)).attr("y1", sy + sR).attr("y2", y - 10);
  g.append("text").attr("class", "lbl-ink").attr("x", x(oct8)).attr("y", y - 108).attr("text-anchor", "middle").text("Oct 8, 2026: grades out");
  // Arcs: from the measured year to the grade, from the grade to the payment year.
  const arc = (xa, ya, xb, yb, col) => {
    const cx = xa < xb ? Math.min(xa, xb) + Math.abs(xb - xa) * (ya > yb ? 0.15 : 0.85) : xa;
    const cy = Math.min(ya, yb) - 30;
    g.append("path").attr("d", `M${xa},${ya} Q${cx},${cy} ${xb},${yb}`).attr("fill", "none").attr("stroke", col).attr("stroke-width", 2)
      .attr("marker-end", `url(#arrow-${col === C.brand ? "b" : "l"})`).attr("class", "arc");
  };
  const defs = g.append("defs");
  for (const [k, col] of [["b", C.brand], ["l", C.loss]]) {
    defs.append("marker").attr("id", `arrow-${k}`).attr("viewBox", "0 0 10 10").attr("refX", 8).attr("refY", 5).attr("markerWidth", 7).attr("markerHeight", 7).attr("orient", "auto-start-reverse")
      .append("path").attr("d", "M0,0L10,5L0,10Z").attr("fill", col);
  }
  arc(x(2025.5), y - 14, x(oct8) - sR * 1.1, sy, C.brand);
  arc(x(oct8) + sR * 1.1, sy, x(2028.5), y - 14, C.loss);
  g.append("text").attr("class", "lbl-brand").attr("x", x(2025.5)).attr("y", y + 60).attr("text-anchor", "middle").text(narrow ? "Care measured" : "Care is measured");
  g.append("text").attr("class", "lbl-loss").attr("x", x(2028.5)).attr("y", y + 60).attr("text-anchor", "middle").text(narrow ? "Bonus lost" : "Bonus would be paid");
  g.append("text").attr("class", "note").attr("x", (x(2026) + x(2028)) / 2).attr("y", y + (narrow ? 84 : 110)).attr("text-anchor", "middle").text(narrow ? "2026–27 revenue: no change" : "2026 and 2027 revenue: no change, Alignment says");
}

// ---------------------------------------------------------------- steps
const STEPS = [
  ["stars", () => setGrade(false)],
  ["stars", () => setGrade(true)],
  ["dots", () => setDots("grow")],
  ["dots", () => setDots("plan")],
  ["price", () => setPrice("all")],
  ["price", () => setPrice("2026")],
  ["fall", () => setFall()],
  ["waffle", () => setWaffle(false)],
  ["waffle", () => setWaffle(true)],
  ["history", () => setHistory()],
  ["share", () => {}],
  ["timeline", () => {}],
];
function render(i) {
  current = i;
  const [name, fn] = STEPS[i];
  for (const [k, g] of Object.entries(scenes)) {
    if (k === name) g.style("display", null).transition().duration(450).style("opacity", 1);
    else if (g.style("display") !== "none") g.transition().duration(250).style("opacity", 0).on("end", function () { d3.select(this).style("display", "none"); });
  }
  fn();
}

layout();
render(0);
scroller(document.querySelectorAll(".step"), (i) => render(i));
let lastW = window.innerWidth;
window.addEventListener("resize", () => {
  if (Math.abs(window.innerWidth - lastW) < 2) return;
  lastW = window.innerWidth;
  layout();
  render(Math.max(0, current));
});

// ---------------------------------------------------------------- quotes, sources, table
const QUOTE_ORDER = ["h3815_cut", "h3815_share", "others_4", "cutpoints", "appeal", "no_rev_2627", "hits_2028", "ninth_year", "all_100", "share_series", "cms_71", "cms_my", "kff_qbp", "medpac_rebate", "medpac_rebate2", "lawsuit", "lawsuit_merit", "ipo", "q2_beat", "q3_trend", "q3_lower"];
const NAMES = {};
NAMES[meta.sources.stars_8k] = "Alignment 8-K, Oct 8, 2026";
NAMES[meta.sources.jpm2026] = "Alignment J.P. Morgan conference deck, 8-K exhibit, Jan 12, 2026";
NAMES[meta.sources.q3_10q] = "Alignment 10-Q for Q3 2026";
NAMES[meta.sources.cms] = "CMS fact sheet, 2027 Medicare Advantage and Part D Star Ratings, Oct 8, 2026";
NAMES[meta.sources.kff] = "KFF, Medicare Advantage glossary";
NAMES[meta.sources.medpac] = "MedPAC, June 2019 report to Congress, chapter 8";
NAMES[meta.sources.ipo] = "Alignment press release on its IPO closing, 8-K exhibit, Mar 30, 2021";
NAMES[quarters.find((q) => q.period === "2026Q2").source] = "Alignment Q2 2026 earnings release";
NAMES[qN.source] = "Alignment Q3 2026 earnings release";
const qs = d3.select("#quotes");
for (const k of QUOTE_ORDER) {
  const q = meta.quotes[k];
  const bq = qs.append("blockquote");
  bq.append("span").text(`“…${q.text}…” `);
  bq.append("a").attr("href", q.url).text(NAMES[q.url] || q.url);
}
const src = d3.select("#sources");
const list = [
  [meta.sources.stars_8k, NAMES[meta.sources.stars_8k]],
  [meta.sources.jpm2026, NAMES[meta.sources.jpm2026]],
  [meta.sources.q3_10q, NAMES[meta.sources.q3_10q]],
  ["", `Alignment's ${quarters.length} quarterly earnings releases, Q1 2021 to Q3 2026 (linked in the table below)`],
  [meta.sources.xbrl, "SEC EDGAR XBRL company facts for Alignment Healthcare (revenue, nine-month 2026 income statement, shares outstanding)"],
  [meta.sources.ipo, NAMES[meta.sources.ipo]],
  [meta.sources.cms, NAMES[meta.sources.cms]],
  [meta.sources.kff, NAMES[meta.sources.kff]],
  [meta.sources.medpac, NAMES[meta.sources.medpac]],
  [meta.sources.prices, "Yahoo Finance chart API, ALHC daily closes"],
  ["https://markets.financialcontent.com/stocks/article/stockstory-2026-7-31-alignment-healthcare-alhc-stock-trades-down-here-is-why", "StockStory, July 31, 2026, on the second-quarter call"],
  ["https://www.ocbj.com/oc-homepage/alignment-shares-tumble-on-rising-medical-costs/", "Orange County Business Journal, Sept. 21, 2026, on the Sept. 15 conference"],
];
src.selectAll("li").data(list).join("li").html(([u, t]) => (u ? `<a href="${u}">${t}</a>` : t));
src.append("li").text(`Built ${meta.built}.`);

const tbl = d3.select("#table").append("table");
tbl.append("thead").append("tr").selectAll("th").data(["Quarter", "Members", "Revenue ($M)", "Medical ratio", "Release"]).join("th").text((d) => d);
tbl.append("tbody").selectAll("tr").data(quarters).join("tr").selectAll("td")
  .data((q) => [q.period.replace(/(\d{4})Q(\d)/, "Q$2 $1"), d3.format(",")(q.members), d3.format(",.1f")(q.revenue_musd), `${q.mbr_pct}%`, `<a href="${q.source}">${q.release_filed}</a>`])
  .join("td").html((d) => d);
