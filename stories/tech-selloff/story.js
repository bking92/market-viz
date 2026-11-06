// Tech selloff story. Reads only the CSVs in ./data, which the pipeline writes.
// If constituent market-cap data is missing, those steps say so instead of drawing anything.
import { scroller } from "../../assets/js/scroller.js";

const d3 = window.d3;
const fmtDate = d3.timeFormat("%b %-d, %Y");
const fmtShort = d3.timeFormat("%b %-d");
const fmtLevel = d3.format(",.2f");
const fmtPct = (v) => `${d3.format(".1f")(Math.abs(v * 100))}%`;
const fmtUsdS = (v) => (Math.abs(v) >= 1e12 ? `$${d3.format(".2f")(v / 1e12)}T` : `$${d3.format(".0f")(v / 1e9)}B`); // phone labels
const fmtUsd = (v) => (Math.abs(v) >= 1e12 ? `$${d3.format(".2f")(v / 1e12)} trillion` : `$${d3.format(".0f")(v / 1e9)} billion`);

// Size the drawing to the box CSS gives it, so text stays legible on phones.
const box = document.getElementById("chart").getBoundingClientRect();
const W = Math.round(box.width), H = Math.round(box.height);
const narrow = W < 640;
const M = narrow ? { top: 36, right: 78, bottom: 34, left: 46 } : { top: 60, right: 150, bottom: 50, left: 70 };
const labelW = narrow ? 96 : 150;
const svg = d3.select("#chart").attr("viewBox", `0 0 ${W} ${H}`);
const tip = d3.select("#tooltip");

const [ndxRaw, mcapRaw, metaRaw, dailyRaw] = await Promise.all([
  d3.csv("data/ndx_close.csv"),
  d3.csv("data/constituent_mcap.csv").catch(() => null),
  d3.json("data/meta.json").catch(() => null),
  d3.csv("data/constituent_daily.csv").catch(() => null),
]);

// ---------- Index series and drawdown ----------
const ndx = ndxRaw.map((d) => ({ date: d3.timeParse("%Y-%m-%d")(d.date), close: +d.close }));
let runMax = -Infinity, runMaxDate = null;
for (const d of ndx) {
  if (d.close >= runMax) { runMax = d.close; runMaxDate = d.date; }
  d.high = runMax; d.highDate = runMaxDate; d.dd = d.close / runMax - 1;
}
const peak = ndx.reduce((a, b) => (b.close > a.close ? b : a));
const last = ndx[ndx.length - 1];
const worst = ndx.reduce((a, b) => (b.dd < a.dd ? b : a));
const daysSince = ndx.filter((d) => d.date > peak.date).length;

const fills = {
  "first-date": fmtDate(ndx[0].date),
  "last-date": fmtDate(last.date),
  "peak-date": fmtDate(peak.date),
  "peak-close": fmtLevel(peak.close),
  "last-close": fmtLevel(last.close),
  "last-dd": fmtPct(last.close / peak.close - 1),
  "days-since": String(daysSince),
  "worst-date": fmtDate(worst.date),
  "worst-dd": fmtPct(worst.dd),
  "worst-ref": fmtDate(worst.highDate),
  "ndx-source-note": metaRaw?.ndx_source_note ?? "",
  "worst-sentence": worst.dd < last.close / peak.close - 1
    ? `October isn't even the deepest hole of this window. On ${fmtDate(worst.date)}, the index sat ${fmtPct(worst.dd)} below its high from ${fmtDate(worst.highDate)}.`
    : `This is the deepest hole of the window so far.`,
  "members-note": metaRaw?.members_note ?? "",
  "fred-note": metaRaw?.fred_note ?? "",
};

// ---------- Constituent market caps (optional until the pipeline has run) ----------
const mcap = mcapRaw?.length
  ? mcapRaw.map((d) => ({ ...d, peak: +d.mcap_peak, latest: +d.mcap_latest }))
      .sort((a, b) => b.peak - a.peak)
  : null;
if (mcap) {
  const totalPeak = d3.sum(mcap, (d) => d.peak);
  const unit = [10e9, 25e9, 50e9, 100e9].find((u) => totalPeak / u <= 900);
  fills.unit = fmtUsd(unit);
  mcap.unit = unit;
  const totalLatest = d3.sum(mcap, (d) => d.latest);
  fills["mcap-change"] = fmtPct(totalLatest / totalPeak - 1);
  fills["total-lost"] = fmtUsd(totalPeak - totalLatest);
}

const shortName = (n) => n.replace(/,? New York Shares$/, "").replace(/,? (Inc\.?|Corporation|Corp\.?|Co\.|Holdings|N\.V\.|PLC|Ltd\.?)(,? Class [A-C])?$/, "").replace(/,? Class [A-C]$/, "").replace(/ Holding$/, "");
const rowLabel = (c) => (narrow ? c.ticker : shortName(c.name)); // phones get tickers so labels fit

// ---------- The last two trading days, company by company ----------
let tail = null;
if (mcap && dailyRaw?.length) {
  const byTicker = d3.group(dailyRaw, (d) => d.ticker);
  const dates = [...new Set(dailyRaw.map((d) => d.date))].sort();
  const [d0, d1, d2] = dates.slice(-3); // the close before, then the last two days
  const moves = [];
  for (const c of mcap) {
    const rows = new Map((byTicker.get(c.ticker) ?? []).map((r) => [r.date, r]));
    for (const [a, b] of [[d0, d1], [d1, d2]]) {
      if (!rows.has(a) || !rows.has(b)) continue;
      moves.push({ c, date: b, usd: rows.get(b).mcap - rows.get(a).mcap, pct: rows.get(b).close / rows.get(a).close - 1 });
    }
  }
  const parse = d3.timeParse("%Y-%m-%d");
  const ndxOn = (iso) => ndx.find((p) => +p.date === +parse(iso));
  const ndxMove = (a, b) => ndxOn(b).close / ndxOn(a).close - 1;
  const lost = -d3.sum(moves, (m) => m.usd);
  tail = { dates: [d1, d2].map(parse), moves: moves.filter((m) => m.usd < 0).sort((a, b) => a.usd - b.usd).slice(0, 10) };
  fills["tail-lost"] = fmtUsd(lost);
  fills["tail-dates"] = `${fmtShort(tail.dates[0])} and ${fmtShort(tail.dates[1])}`;
  fills["tail-share"] = d3.format(".0%")(lost / (d3.sum(mcap, (d) => d.peak) - d3.sum(mcap, (d) => d.latest)));
  fills["lede-tail"] = `, and ${fills["tail-share"]} of the market value lost went in the last two trading days`;
  fills["tail-moves"] = `${fmtPct(ndxMove(d0, d1))} and then ${fmtPct(ndxMove(d1, d2))}`;
  // Name the three biggest, and say when one fell on the day it filed its quarterly report with the SEC.
  fills["tail-story"] = tail.moves.slice(0, 3).map((m) => {
    const filed = m.c.shares_filed === m.date ? `, the day it filed its quarterly report with the SEC` : "";
    return `${shortName(m.c.name)} fell ${fmtPct(m.pct)} on ${fmtShort(parse(m.date))}${filed}, taking ${fmtUsd(-m.usd)} with it.`;
  }).join(" ");
}
document.querySelectorAll("[data-fill]").forEach((el) => { el.textContent = fills[el.dataset.fill] ?? el.textContent; });
const changesEl = document.getElementById("changes");
if (changesEl) {
  const ch = metaRaw?.membership_changes ?? [];
  changesEl.innerHTML = "";
  if (!ch.length) changesEl.textContent = "none.";
  ch.forEach((c, i) => {
    const what = [c.add ? `${c.add[1]} (${c.add[0]}) added` : null, c.remove ? `${c.remove} removed` : null].filter(Boolean).join(", ");
    changesEl.append(`${what}, effective ${fmtDate(d3.timeParse("%Y-%m-%d")(c.date))} (`);
    const a = document.createElement("a"); a.href = c.source; a.textContent = new URL(c.source).hostname.replace("www.", "");
    changesEl.append(a, i < ch.length - 1 ? "); " : ").");
  });
}
document.getElementById("gaps").textContent = metaRaw?.gaps ??
  (mcap ? "Nothing outstanding." : "Company-level market values have not been pulled yet, so the last three steps show a note instead of a chart.");
if (!mcap) document.querySelectorAll('[data-needs="mcap"]').forEach((el) => {
  if (el.tagName === "LI") el.remove();
});

// ---------- Scales and layers ----------
const x = d3.scaleTime().domain(d3.extent(ndx, (d) => d.date)).range([M.left, W - M.right]);
const yLevel = d3.scaleLinear().domain([d3.min(ndx, (d) => d.close) * 0.985, peak.close * 1.01]).range([H - M.bottom, M.top]);
const yDD = d3.scaleLinear().domain([Math.min(-0.1, worst.dd * 1.15), 0]).range([H - M.bottom, M.top]);

const gAxisX = svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - M.bottom})`);
const gAxisY = svg.append("g").attr("class", "axis").attr("transform", `translate(${M.left},0)`);
const gLine = svg.append("g");
const gGrid = svg.append("g");
const gNotes = svg.append("g");

const clip = svg.append("clipPath").attr("id", "reveal").append("rect").attr("x", 0).attr("y", 0).attr("height", H).attr("width", 0);
const lossArea = gLine.append("path").attr("fill", "var(--loss)").attr("opacity", 0).attr("clip-path", "url(#reveal)");
const highLine = gLine.append("path").attr("fill", "none").attr("stroke", "var(--ink-soft)").attr("stroke-dasharray", "3 4").attr("stroke-width", 1).attr("opacity", 0).attr("clip-path", "url(#reveal)");
const line = gLine.append("path").attr("fill", "none").attr("stroke", "var(--brand)").attr("stroke-width", 2).attr("stroke-linejoin", "round").attr("clip-path", "url(#reveal)");

function drawAxes(mode, t) {
  gAxisX.transition(t).call(d3.axisBottom(x).ticks(narrow ? 3 : d3.timeMonth.every(1)).tickFormat(d3.timeFormat("%B")).tickSizeOuter(0));
  const yAxis = mode === "dd"
    ? d3.axisLeft(yDD).ticks(5).tickFormat((v) => (v === 0 ? "at high" : `−${d3.format(".0f")(Math.abs(v * 100))}%`))
    : d3.axisLeft(yLevel).ticks(6).tickFormat(d3.format(","));
  gAxisY.transition(t).call(yAxis.tickSizeOuter(0));
  gAxisY.selectAll(".domain").remove();
}

function note(sel, cls, xPos, yPos, text, anchor = "start") {
  sel.append("text").attr("class", cls).attr("x", xPos).attr("y", yPos).attr("text-anchor", anchor).text(text);
}

// ---------- Steps ----------
function showLine(on) {
  for (const s of [gAxisX, gAxisY, gLine]) s.transition().duration(500).attr("opacity", on ? 1 : 0);
  gGrid.transition().duration(500).attr("opacity", on ? 0 : 1);
}

function stepLevel(step) {
  const t = svg.transition().duration(900);
  showLine(true);
  drawAxes("level", t);
  const lineGen = d3.line().x((d) => x(d.date)).y((d) => yLevel(d.close));
  line.transition(t).attr("d", lineGen(ndx));
  const after = ndx.filter((d) => d.date >= peak.date);
  highLine.transition(t).attr("opacity", step >= 1 ? 1 : 0)
    .attr("d", d3.line().x((d) => x(d.date)).y(() => yLevel(peak.close))(after));
  lossArea.transition(t).attr("opacity", step >= 1 ? 0.85 : 0)
    .attr("d", d3.area().x((d) => x(d.date)).y0(() => yLevel(peak.close)).y1((d) => yLevel(d.close))(after));
  clip.transition(t).attr("width", step === 0 ? x(peak.date) + 2 : W);

  gNotes.selectAll("*").remove();
  gNotes.append("circle").attr("cx", x(peak.date)).attr("cy", yLevel(peak.close)).attr("r", 5).attr("fill", "var(--brand)").attr("stroke", "var(--paper)").attr("stroke-width", 2);
  note(gNotes, "note-strong", x(peak.date), yLevel(peak.close) - 16, `${fmtLevel(peak.close)} on ${fmtShort(peak.date)}`, "end");
  if (step >= 1) {
    gNotes.append("circle").attr("cx", x(last.date)).attr("cy", yLevel(last.close)).attr("r", 5).attr("fill", "var(--loss)").attr("stroke", "var(--paper)").attr("stroke-width", 2);
    const lx = narrow ? x(last.date) - 10 : x(last.date) + 12, la = narrow ? "end" : "start";
    note(gNotes, "note-strong", lx, yLevel(last.close) + (narrow ? 22 : 5), fmtLevel(last.close), la);
    note(gNotes, "note", lx, yLevel(last.close) + (narrow ? 40 : 23), `−${fmtPct(last.close / peak.close - 1)} from peak`, la);
  }
  gNotes.attr("opacity", 0).transition().delay(step === 0 ? 700 : 300).duration(400).attr("opacity", 1);
}

function stepDrawdown() {
  const t = svg.transition().duration(1100);
  showLine(true);
  drawAxes("dd", t);
  clip.transition(t).attr("width", W);
  line.transition(t).attr("d", d3.line().x((d) => x(d.date)).y((d) => yDD(d.dd))(ndx));
  highLine.transition(t).attr("opacity", 1).attr("d", d3.line().x((d) => x(d.date)).y(() => yDD(0))(ndx));
  lossArea.transition(t).attr("opacity", 0.85).attr("d", d3.area().x((d) => x(d.date)).y0(() => yDD(0)).y1((d) => yDD(d.dd))(ndx));
  gNotes.selectAll("*").remove();
  for (const d of [worst, last]) {
    gNotes.append("circle").attr("cx", x(d.date)).attr("cy", yDD(d.dd)).attr("r", 5).attr("fill", "var(--loss)").attr("stroke", "var(--paper)").attr("stroke-width", 2);
  }
  note(gNotes, "note-strong", x(worst.date), yDD(worst.dd) + 24, `−${fmtPct(worst.dd)} on ${fmtShort(worst.date)}`, "middle");
  const lx = narrow ? x(last.date) - 10 : x(last.date) + 12, la = narrow ? "end" : "start";
  note(gNotes, "note-strong", lx, yDD(last.dd) + (narrow ? 22 : 5), `−${fmtPct(last.dd)}`, la);
  note(gNotes, "note", lx, yDD(last.dd) + (narrow ? 40 : 23), fmtShort(last.date), la);
  gNotes.attr("opacity", 0).transition().delay(700).duration(400).attr("opacity", 1);
}

// Unit grid: each square is `unit` dollars of peak market value.
function stepGrid(phase) {
  showLine(false);
  gNotes.selectAll("*").remove();
  if (!mcap) {
    gGrid.selectAll("*").remove();
    const lines = ["This step needs company market values", "at the peak and the latest close.", "They haven't been pulled yet,", "so nothing is drawn here."];
    lines.forEach((l, i) => note(gGrid, "pending", W / 2, H / 2 + (i - 1.5) * 26, l, "middle"));
    return;
  }
  gGrid.selectAll(".pending").remove();
  const unit = mcap.unit;
  // One record per square, assigned to companies in order of peak value.
  if (!stepGrid.cells) {
    stepGrid.cells = [];
    for (const c of mcap) {
      const n = Math.round(c.peak / unit);
      const lost = Math.max(0, Math.round((c.peak - c.latest) / unit));
      for (let i = 0; i < n; i++) stepGrid.cells.push({ c, i, lost: i >= n - lost });
    }
  }
  const cells = stepGrid.cells;
  const cols = narrow ? 20 : 40, size = Math.min((W - M.left - M.right) / cols, (H - M.top - M.bottom) / Math.ceil(cells.length / cols)) ;
  const gap = 2, s = size - gap;

  // Phase 2 layout: lost squares only, one row per top loser.
  const losers = mcap.map((c) => ({ c, lost: Math.max(0, Math.round((c.peak - c.latest) / unit)) }))
    .filter((d) => d.lost > 0).sort((a, b) => b.lost - a.lost);
  const top = losers.slice(0, 10);
  const rowOf = new Map(top.map((d, r) => [d.c.ticker, r]));
  const rest = { r: top.length };
  const counters = new Map();
  const rowH = (H - M.top - M.bottom) / (top.length + 1);
  const pos = (d, k) => {
    if (phase < 2) return [M.left + (k % cols) * size, M.top + Math.floor(k / cols) * size];
    if (!d.lost) return [W / 2, H + 40];
    const r = rowOf.has(d.c.ticker) ? rowOf.get(d.c.ticker) : rest.r;
    const j = counters.get(r) ?? 0; counters.set(r, j + 1);
    return [M.left + labelW + j * Math.min(size, 14), M.top + r * rowH];
  };
  counters.clear();
  const xy = cells.map((d, k) => pos(d, k));
  const sel = gGrid.selectAll("rect.cell").data(cells);
  sel.join("rect").attr("class", "cell")
    .on("mousemove", (ev, d) => tip.style("opacity", 1).style("left", `${ev.clientX + 12}px`).style("top", `${ev.clientY + 12}px`)
      .text(`${d.c.name} (${d.c.ticker}): ${fmtUsd(d.c.peak)} at peak, ${fmtUsd(d.c.latest)} latest`))
    .on("mouseleave", () => tip.style("opacity", 0))
    .transition().duration(900).delay((d, k) => (phase === 1 && d.lost ? (k % 50) * 6 : 0))
    .attr("x", (d, k) => xy[k][0]).attr("y", (d, k) => xy[k][1])
    .attr("width", phase < 2 ? s : Math.min(s, 12)).attr("height", phase < 2 ? s : Math.min(s, 12))
    .attr("fill", (d) => (phase >= 1 && d.lost ? "var(--loss)" : "var(--brand)"))
    .attr("opacity", (d) => (phase >= 2 && !d.lost ? 0 : phase === 1 && !d.lost ? 0.25 : 1));

  gGrid.selectAll("text.lbl").remove();
  if (phase === 2) {
    top.forEach((d, r) => {
      note(gGrid, "note-strong lbl", M.left + labelW - 10, M.top + r * rowH + 11, rowLabel(d.c), "end");
      note(gGrid, "note lbl", M.left + labelW + d.lost * Math.min(size, 14) + 6, M.top + r * rowH + 11, `−${(narrow ? fmtUsdS : fmtUsd)(d.c.peak - d.c.latest)}`);
    });
    const others = mcap.filter((c) => !rowOf.has(c.ticker));
    const restLoss = d3.sum(others, (c) => c.peak - c.latest);
    const restGross = d3.sum(others, (c) => Math.max(0, c.peak - c.latest));
    note(gGrid, "note-strong lbl", M.left + labelW - 10, M.top + rest.r * rowH + 11, "Everyone else", "end");
    const restN = counters.get(rest.r) ?? 0;
    note(gGrid, "note lbl", M.left + labelW + restN * Math.min(size, 14) + 6, M.top + rest.r * rowH + 11,
      narrow ? `−${fmtUsdS(restGross)}`
        : `−${fmtUsd(restGross)} from the losers, ${restLoss >= 0 ? "−" : "+"}${fmtUsd(Math.abs(restLoss))} net of gainers`);
  } else {
    const totalLost = d3.sum(mcap, (c) => c.peak - c.latest);
    note(gGrid, "note-strong lbl", M.left, M.top - 18, phase === 0
      ? (narrow ? `${fmtUsdS(d3.sum(mcap, (c) => c.peak))} at the peak. One square = ${fmtUsdS(unit)}.` : `${fmtUsd(d3.sum(mcap, (c) => c.peak))} at the peak. One square = ${fmtUsd(unit)}.`)
      : `${fmtUsd(totalLost)} gone, net of gainers.`);
  }
}

// The last step: the biggest single-day losses on the final two trading days, as bars.
const gBars = svg.append("g");
function stepTail(on) {
  if (!on || !tail) { gBars.transition().duration(400).attr("opacity", 0); return; }
  showLine(false);
  gNotes.selectAll("*").remove();
  gGrid.transition().duration(500).attr("opacity", 0);
  gBars.attr("opacity", 1);
  const rows = tail.moves;
  // Wide: name to the left of each bar. Narrow: name and amount on a line above the bar.
  const left = narrow ? M.left - 30 : M.left + labelW + 40;
  const xb = d3.scaleLinear().domain([0, -rows[0].usd]).range([0, W - left - (narrow ? 16 : M.right)]);
  const rowH = Math.min(narrow ? 46 : 44, (H - M.top - M.bottom) / rows.length);
  const barH = narrow ? 12 : Math.min(18, rowH * 0.55);
  const amt = (d) => `−${fmtUsd(-d.usd)} (−${fmtPct(d.pct)}, ${fmtShort(d3.timeParse("%Y-%m-%d")(d.date))})`;
  const g = gBars.selectAll("g.row").data(rows, (d) => d.c.ticker + d.date).join((enter) => {
    const e = enter.append("g").attr("class", "row");
    e.append("rect").attr("fill", "var(--loss)").attr("width", 0);
    e.append("text").attr("class", "note-strong who");
    e.append("text").attr("class", "note amt");
    return e;
  });
  g.attr("transform", (d, i) => `translate(0,${M.top + i * rowH})`);
  g.select("rect").attr("x", left).attr("y", narrow ? 18 : 0).attr("height", barH)
    .transition().duration(900).delay((d, i) => i * 80).attr("width", (d) => xb(-d.usd));
  if (narrow) { // name above the bar, amount at the end of the bar (inside it when the bar is long)
    const short = (d) => `−${fmtUsd(-d.usd)}, ${fmtShort(d3.timeParse("%Y-%m-%d")(d.date))}`;
    g.select(".who").attr("x", left).attr("y", 13).attr("text-anchor", "start").text((d) => shortName(d.c.name));
    g.select(".amt").attr("y", 18 + barH - 1).attr("text-anchor", "start").attr("x", (d) => left + xb(-d.usd) + 6).style("fill", null).text(short)
      .each(function (d) {
        if (left + xb(-d.usd) + 6 + this.getComputedTextLength() > W - 4)
          d3.select(this).attr("x", left + xb(-d.usd) - 6).attr("text-anchor", "end").style("fill", "var(--paper)");
      });
  } else {
    g.select(".who").attr("x", left - 10).attr("y", 13).attr("text-anchor", "end").text((d) => shortName(d.c.name));
    g.select(".amt").attr("y", 13).attr("text-anchor", "start").attr("x", (d) => left + xb(-d.usd) + 8).style("fill", null).text(amt)
      .each(function (d) { // a long bar leaves no room on the right: write the amount inside the bar instead
        if (left + xb(-d.usd) + 8 + this.getComputedTextLength() > W - 4)
          d3.select(this).attr("x", left + xb(-d.usd) - 8).attr("text-anchor", "end").style("fill", "var(--paper)");
      });
  }
  g.select(".amt").attr("opacity", 0).transition().delay((d, i) => 600 + i * 80).duration(300).attr("opacity", 1);
}

const steps = [() => stepLevel(0), () => stepLevel(1), stepDrawdown, () => stepGrid(0), () => stepGrid(1), () => stepGrid(2), () => stepTail(true)];
stepLevel(0);
scroller(document.querySelectorAll(".step"), (i) => { if (i !== 6) stepTail(false); steps[i]?.(); });

// ---------- Hover layer on the line steps ----------
const hover = svg.append("g").attr("opacity", 0);
hover.append("line").attr("stroke", "var(--ink-soft)").attr("y1", M.top).attr("y2", H - M.bottom);
svg.append("rect").attr("x", M.left).attr("y", M.top).attr("width", W - M.left - M.right).attr("height", H - M.top - M.bottom)
  .attr("fill", "transparent")
  .on("mousemove", (ev) => {
    if (+gLine.attr("opacity") === 0) return;
    const [mx] = d3.pointer(ev);
    const d = ndx[d3.bisectCenter(ndx.map((p) => +p.date), +x.invert(mx))];
    hover.attr("opacity", 1).select("line").attr("x1", x(d.date)).attr("x2", x(d.date));
    tip.style("opacity", 1).style("left", `${ev.clientX + 14}px`).style("top", `${ev.clientY + 14}px`)
      .text(`${fmtDate(d.date)}: ${fmtLevel(d.close)} (${d.dd === 0 ? "a new high" : `−${fmtPct(d.dd)} from ${fmtShort(d.highDate)} high`})`);
  })
  .on("mouseleave", () => { hover.attr("opacity", 0); tip.style("opacity", 0); });

// ---------- Data table (show your work) ----------
const table = d3.select("#table").append("table");
table.append("thead").append("tr").selectAll("th").data(["Date", "Close", "Highest so far", "Drawdown"]).join("th").text((d) => d);
table.append("tbody").selectAll("tr").data(ndx.slice().reverse()).join("tr").selectAll("td")
  .data((d) => [fmtDate(d.date), fmtLevel(d.close), fmtLevel(d.high), d.dd === 0 ? "0.0%" : `−${fmtPct(d.dd)}`]).join("td").text((d) => d);

// ---------- Company table (show your work) ----------
if (mcap) {
  const fmtB = (v) => d3.format(",.1f")(v / 1e9);
  const t2 = d3.select("#mcap-table").append("table");
  t2.append("thead").append("tr").selectAll("th")
    .data(["Ticker", "Shares", "Filed", `Close ${fmtShort(peak.date)}`, `Close ${fmtShort(last.date)}`, "Value at peak ($bn)", "Latest ($bn)", "Change"])
    .join("th").text((d) => d);
  t2.append("tbody").selectAll("tr").data(mcap).join("tr").attr("title", (d) => d.name).selectAll("td")
    .data((d) => [d.ticker, d3.format(",")(+d.shares), d.shares_filed, fmtLevel(+d.close_peak), fmtLevel(+d.close_latest), fmtB(d.peak), fmtB(d.latest),
      `${d.latest >= d.peak ? "+" : "−"}${fmtPct(d.latest / d.peak - 1)}`])
    .join("td").text((d) => d);
}
