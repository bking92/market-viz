// "How fast do companies make a buck?". Reads only ./data, which pipeline/build_cradles.py writes.
import { scroller } from "../../assets/js/scroller.js";
import { CradleScene, fmtInterval, fmtRate } from "./cradle.js";

const d3 = window.d3;
const [raw, meta, decadeRaw, pairRaw] = await Promise.all([
  d3.csv("data/companies.csv"), d3.json("data/meta.json"), d3.csv("data/decade.csv"), d3.json("data/pair.json"),
]);
await document.fonts.ready;

const rows = raw.map((r) => {
  const ps = +r.per_second;
  return {
    ...r, per_second: ps, net_income: +r.net_income, days: +r.days,
    interval: ps > 0 ? +r.seconds_per_million : 0,     // seconds per $1M of profit
    lossInterval: ps < 0 ? 1e6 / -ps : 0,              // seconds per $1M of loss
  };
});
const winners = rows.filter((r) => r.interval > 0).sort((a, b) => a.interval - b.interval);
const losers = rows.filter((r) => r.interval === 0).sort((a, b) => a.per_second - b.per_second);
const byGroup = (g) => winners.filter((r) => r.group === g);
const giants = byGroup("giants"), brands = byGroup("brands"), small = byGroup("small");
const fastest = winners[0], slowest = winners[winners.length - 1];

const usd = (v) => {
  const a = Math.abs(v);
  if (a >= 1e9) return `$${d3.format(".1f")(a / 1e9)} billion`;
  if (a >= 1e6) return `$${d3.format(".0f")(a / 1e6)} million`;
  return `$${d3.format(",.0f")(a)}`;
};
const usdBig = (v) => (v >= 1e12 ? `$${d3.format(".2f")(v / 1e12)} trillion` : `$${d3.format(".1f")(v / 1e9)} billion`);
const fmtDate = (s) => d3.timeFormat("%b %-d, %Y")(d3.timeParse("%Y-%m-%d")(s));
const list = (a) => (a.length < 2 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);
const UNIT = 1e4; // dollars per strike after the first step
const every = (r) => r.interval * UNIT / 1e6; // seconds between $10k strikes
const perSecAt = (r, speed) => speed / every(r);

const lastBrand = brands[brands.length - 1];
const year = (s) => s.slice(0, 4);
const monthYear = (s) => d3.timeFormat("%B %Y")(d3.timeParse("%Y-%m-%d")(s));

// Ten years ago: the same giants, each shown twice, then and now (extra cradles with their own keys).
const byTicker = new Map(rows.map((r) => [r.ticker, r]));
const decade = decadeRaw.map((r) => ({ ...r, net_income: +r.net_income, per_second: +r.per_second, interval: +r.seconds_per_million }));
const pairsThenNow = [];
for (const t of decade) {
  const now = byTicker.get(t.ticker);
  pairsThenNow.push({ ...t, ticker: `${t.ticker}~then`, name: `${t.name}, ${year(t.period_end)}`, lossInterval: 0 });
  pairsThenNow.push({ ...now, ticker: `${t.ticker}~now`, name: `${now.name}, ${year(now.period_end)}` });
}
const speedups = decade.map((t) => ({ t, now: byTicker.get(t.ticker), x: byTicker.get(t.ticker).per_second / t.per_second }))
  .sort((a, b) => b.x - a.x);
// Only the biggest and the smallest change in pace go on stage; the rest are in the table at the end.
const extremes = [speedups[0], speedups[speedups.length - 1]].map((s) => s.t.ticker);
const decadeShown = pairsThenNow.filter((r) => extremes.includes(r.ticker.split("~")[0]))
  .sort((a, b) => extremes.indexOf(a.ticker.split("~")[0]) - extremes.indexOf(b.ticker.split("~")[0]));
const alpha = decade.find((t) => t.ticker === fastest.ticker);

// Same profit pace, very different price tags.
const pair = pairRaw.companies.map((c) => ({ ...byTicker.get(c.ticker), ...c, ticker: `${c.ticker}~pair`,
  name: byTicker.get(c.ticker).name, note: `worth ${usdBig(c.market_value)}` }))
  .sort((a, b) => b.market_value - a.market_value);
for (const p of pair) { p.interval = byTicker.get(p.ticker.split("~")[0]).interval; p.lossInterval = 0; }
const fills = {
  "fastest": fastest.name,
  "fastest-interval": fmtInterval(fastest.interval),
  "fastest-rate": `$${d3.format(",.0f")(fastest.per_second)}`,
  "giants-n": String(giants.length),
  "fastest-unit": fmtInterval(every(fastest)),
  "giants-max": `${Math.ceil(d3.max(giants, every))} seconds`,
  "giants-note": `${giants[giants.length - 1].name}, the slowest of this group, strikes every ${fmtInterval(every(giants[giants.length - 1]))}.`,
  "last-brand": lastBrand.name,
  "slowest-unit": fmtInterval(every(slowest)),
  "slowest": slowest.name,
  "slowest-interval": fmtInterval(slowest.interval),
  "ratio": usd(1e6 * slowest.interval / fastest.interval),
  "loss-note": `${losers[0].name} lost ${usd(losers[0].net_income)}: $10,000 gone every ${fmtInterval(losers[0].lossInterval * UNIT / 1e6)}. ` +
    `${list(losers.slice(1).map((r) => r.name))} lost money too.`,
  "as-of": fmtDate(meta.as_of),
  "decade-lead": "Here are the two that changed most and least over the last decade.",
  "decade-note": `${speedups[0].t.name} sped up the most: from one strike every ${fmtInterval(speedups[0].t.interval * UNIT / 1e6)} to one every ${fmtInterval(every(speedups[0].now))}, ${d3.format(",.0f")(speedups[0].x)} times as fast. ` +
    `${speedups[speedups.length - 1].t.name} changed the least, and still makes money ${d3.format(".1f")(speedups[speedups.length - 1].x)} times as fast: one strike every ${fmtInterval(speedups[speedups.length - 1].t.interval * UNIT / 1e6)} then, every ${fmtInterval(every(speedups[speedups.length - 1].now))} now. The table at the end has the rest of the top earners.`,
  "pair-a": pair[0].name, "pair-b": pair[1].name,
  "pair-pace": `${pair[0].name} makes $10,000 every ${fmtInterval(every(pair[0]))}, ${pair[1].name} every ${fmtInterval(every(pair[1]))}.`,
  "pair-values": `At the close on ${fmtDate(pair[0].close_date)}, the stock market valued ${pair[0].name} at ${usdBig(pair[0].market_value)} and ${pair[1].name} at ${usdBig(pair[1].market_value)}: ${d3.format(".0f")(pairRaw.value_ratio)} times as much for the same pace of profit.`,
};
for (const el of document.querySelectorAll("[data-fill]")) if (fills[el.dataset.fill] !== undefined) el.textContent = fills[el.dataset.fill];

// Live "since you opened this page" counters (real time, unaffected by the clock speed).
const t0 = performance.now();
const liveEls = document.querySelectorAll("[data-live]");
setInterval(() => {
  const s = (performance.now() - t0) / 1000;
  for (const el of liveEls) el.textContent = `$${d3.format(",.0f")(fastest.per_second * s)}`;
}, 100);

// ---------- sound: a short metallic tick, off until the reader turns it on ----------
let audio = null, soundOn = false, lastTick = 0;
function tick(gain = 0.25) {
  if (!soundOn || !audio) return;
  const now = audio.currentTime;
  if (now - lastTick < 0.06) return; // never a buzz
  lastTick = now;
  const len = Math.floor(audio.sampleRate * 0.03), buf = audio.createBuffer(1, len, audio.sampleRate), ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.08));
  const src = audio.createBufferSource(); src.buffer = buf;
  const bp = audio.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 3200 + Math.random() * 600; bp.Q.value = 6;
  const g = audio.createGain(); g.gain.value = gain;
  src.connect(bp).connect(g).connect(audio.destination); src.start();
}
const soundBtn = document.getElementById("sound");
soundBtn.addEventListener("click", () => {
  soundOn = !soundOn;
  if (soundOn && !audio) audio = new (window.AudioContext || window.webkitAudioContext)();
  soundBtn.textContent = soundOn ? "Sound on" : "Sound off";
  soundBtn.setAttribute("aria-pressed", String(soundOn));
});
// only cradles striking slower than a few times a second click audibly
const onStrike = (it, n) => { if (n === 1 && scene.strikeEvery(it.d) / scene.speed > 0.25) tick(); };

// ---------- the scrolly stage ----------
const scene = new CradleScene(document.getElementById("stage"), [...rows, ...pairsThenNow, ...pair], { onStrike, maxR: 30, unit: UNIT });
const clock = document.getElementById("clock");
const unitText = (u) => (u >= 1e6 ? "each strike is <b>$1 million</b>" : "each strike is <b>$10,000</b>");
const tk = (a) => a.map((r) => r.ticker);
const STEPS = [
  { show: [fastest.ticker], speed: 1, unit: UNIT },
  { show: tk(giants), speed: 1, unit: UNIT },
  { show: tk(decadeShown), speed: 1, unit: UNIT, cols: () => 2 },
  { show: tk(brands), speed: 1, unit: UNIT },
  { show: tk(pair), speed: 1, unit: UNIT, cols: () => 2 },
  { show: tk(small), speed: 1, unit: UNIT },
  { show: tk(losers), speed: 1, unit: UNIT },
];
function go(i) {
  const s = STEPS[Math.max(0, Math.min(i, STEPS.length - 1))];
  scene.layout(s.show, false, s.cols ? s.cols() : null);
  scene.setSpeed(s.speed);
  scene.setUnit(s.unit);
  clock.innerHTML = `Real time, ${unitText(s.unit)}`;
}
go(0);
scene.setSpeed(1, true);
scroller(document.querySelectorAll(".scrolly .step"), (i) => go(i));

// ---------- explore: everyone ----------
const all = document.getElementById("all");
const order = [...winners, ...losers];
const narrow = () => window.innerWidth < 640;
function sizeAll() {
  const cols = narrow() ? 2 : window.innerWidth < 1000 ? 4 : 6;
  const w = all.getBoundingClientRect().width, r = Math.min(26, w / cols / 23.5);
  const rows_ = Math.ceil(order.length / cols);
  all.style.height = `${rows_ * (r * 13.4 + Math.max(40, Math.min(58, r * 2.4))) + 10}px`;
  return cols;
}
sizeAll();
const explore = new CradleScene(all, rows, { unit: UNIT, onStrike: (it, n) => { if (n === 1 && explore.strikeEvery(it.d) / explore.speed > 0.25) tick(0.12); } });
explore.layout(tk(order), true);

window.addEventListener("resize", () => { sizeAll(); });

// ---------- method: gaps and the table ----------
const brk = rows.find((r) => r.ticker === "BRK-B");
const gaps = [];
for (const [, why] of Object.entries(meta.excluded || {})) gaps.push(`${why} I left it out.`);
if (brk) gaps.push(`Berkshire Hathaway's net income includes gains and losses on the stocks it owns, whether or not it sold them, so its pace moves with the stock market as much as with its businesses. Its latest filing in the data covers the twelve months to ${fmtDate(brk.period_end)}.`);
gaps.push("Only companies that file 10-K and 10-Q reports with the SEC are included, so companies that report elsewhere or on other forms, such as TSMC with its annual 20-F, aren't here. Net income includes one-off items such as write-downs and gains on sales, which can make a single year look better or worse than the business underneath.");
for (const [, why] of Object.entries(meta.deregistered || {})) gaps.push(why);
for (const [, why] of Object.entries(meta.decade_skipped || {})) gaps.push(`In the ten-years-ago comparison: ${why}`);
document.getElementById("gaps").textContent = gaps.join(" ");

const cols = [
  ["Company", (r) => r.name],
  ["Twelve months", (r) => `${fmtDate(r.period_start)} to ${fmtDate(r.period_end)}`],
  ["Net income", (r) => `${r.net_income < 0 ? "−" : ""}$${d3.format(",.0f")(Math.abs(r.net_income) / 1e6)}M`],
  ["Per second", (r) => `${r.per_second < 0 ? "−" : ""}$${d3.format(",.2f")(Math.abs(r.per_second))}`],
  ["Time per $1M", (r) => (r.interval ? fmtInterval(r.interval) : `loses $1M every ${fmtInterval(r.lossInterval)}`)],
  ["Basis", (r) => r.method],
  ["SEC filings (accession)", (r) => r.sources.split(" ").map((a) => `<a href="https://www.sec.gov/Archives/edgar/data/${r.cik}/${a.replace(/-/g, "")}/">${a}</a>`).join("<br>")],
];
const table = d3.select("#table").append("table");
table.append("thead").append("tr").selectAll("th").data(cols).join("th").text((c) => c[0]);
table.append("tbody").selectAll("tr").data(order).join("tr")
  .selectAll("td").data((r) => cols.map((c) => c[1](r))).join("td").html((v) => v);

const t2 = d3.select("#decade-table").append("table");
const cols2 = cols.filter((c) => c[0] !== "Basis");
t2.append("thead").append("tr").selectAll("th").data(cols2).join("th").text((c) => c[0]);
t2.append("tbody").selectAll("tr").data(decade).join("tr")
  .selectAll("td").data((r) => cols2.map((c) => c[1](r))).join("td").html((v) => v);

d3.select("#pair-data").text(pairRaw.companies.map((c) =>
  `${byTicker.get(c.ticker).name}: ${d3.format(",")(c.shares)} shares outstanding as of ${fmtDate(c.shares_as_of)} (cover of its ${c.shares_form}, accession ${c.shares_accn}) × $${d3.format(",.2f")(c.close)} close on ${fmtDate(c.close_date)} = ${usdBig(c.market_value)}.`).join(" "));

// ---------- try your own: any S&P 500 company, any dollars per strike ----------
// Reads data/sp500.csv, which pipeline/build_cradles_sp500.py writes with the same method as the story.
{
  const [spRaw, spMeta] = await Promise.all([d3.csv("data/sp500.csv"), d3.json("data/sp500_meta.json")]);
  const sp = spRaw.map((r) => {
    const ps = +r.per_second, story = byTicker.get(r.ticker);
    return { ...r, name: story ? story.name : (r.display_name || r.name), per_second: ps, net_income: +r.net_income, cik: +r.cik,
      interval: ps > 0 ? 1e6 / ps : 0, lossInterval: ps < 0 ? 1e6 / -ps : 0, inStory: !!story };
  }).sort((a, b) => d3.ascending(a.name, b.name));
  const AMOUNTS = [];
  for (let e = 0; e <= 7; e++) for (const m of [1, 2, 5]) if (m * 10 ** e <= 1e7) AMOUNTS.push(m * 10 ** e);
  const amtLabel = (u) => (u >= 1e6 ? `$${u / 1e6} million` : `$${d3.format(",")(u)}`);
  const key = (r) => `${r.name} (${r.ticker})`;
  const byKey = new Map(sp.map((r) => [key(r).toLowerCase(), r]));
  const byTk = new Map(sp.map((r) => [r.ticker.toLowerCase(), r]));

  const input = document.getElementById("pick-co"), range = document.getElementById("pick-amt");
  range.max = String(AMOUNTS.length - 1);
  range.value = String(AMOUNTS.indexOf(UNIT));
  const stage = document.getElementById("pick-stage"), out = document.getElementById("pick-amt-out"), text = document.getElementById("pick-text");
  const pickScene = new CradleScene(stage, sp, { unit: UNIT, maxR: 30,
    onStrike: (it, n) => { if (n === 1 && pickScene.strikeEvery(it.d) > 0.25) tick(0.2); } });
  // a shared link carries ?co=TICKER&each=DOLLARS#pick
  const q = new URLSearchParams(location.search);
  const shared = q.get("co") && byTk.get(q.get("co").toLowerCase());
  let cur = shared || sp.find((r) => r.ticker === "AAPL") || sp[0];
  input.value = key(cur);
  if (q.get("each") && AMOUNTS.includes(+q.get("each"))) range.value = String(AMOUNTS.indexOf(+q.get("each")));

  function render() {
    const u = AMOUNTS[+range.value];
    out.textContent = amtLabel(u);
    range.setAttribute("aria-valuetext", amtLabel(u));
    pickScene.setUnit(u);
    pickScene.layout([cur.ticker], false, 1);
    const sec = (cur.interval || cur.lossInterval) * u / 1e6;
    const pace = sec < 1 ? `${fmtRate(1 / sec)} times a second` : `once every ${fmtInterval(sec)}`;
    const window_ = `the twelve months to ${fmtDate(cur.period_end)}`;
    text.innerHTML = cur.interval > 0
      ? `${cur.name} made ${usd(cur.net_income)} in ${window_}. At ${amtLabel(u)} a strike, its cradle strikes <b>${pace}</b>.`
      : `${cur.name} lost ${usd(cur.net_income)} in ${window_}, so its cradle is broken: it loses ${amtLabel(u)} ${pace}.`;
  }
  // suggestions: tickers that start with what was typed first, then names that contain it
  const listEl = document.getElementById("pick-list");
  let matches = [], hi = -1;
  function search(v) {
    v = v.trim().toLowerCase();
    if (!v) return [];
    const tk = sp.filter((r) => r.ticker.toLowerCase().startsWith(v)).sort((a, b) => a.ticker.length - b.ticker.length);
    const nm = sp.filter((r) => !tk.includes(r) && r.name.toLowerCase().split(/[\s.,&'-]+/).some((w) => w.startsWith(v)));
    nm.sort((a, b) => b.name.toLowerCase().startsWith(v) - a.name.toLowerCase().startsWith(v));
    const any = sp.filter((r) => !tk.includes(r) && !nm.includes(r) && r.name.toLowerCase().includes(v));
    return [...tk, ...nm, ...any].slice(0, 6);
  }
  function showList() {
    listEl.replaceChildren(...matches.map((r, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option"); li.id = `pick-opt-${i}`; li.setAttribute("aria-selected", String(i === hi));
      li.append(r.name); const t = document.createElement("span"); t.textContent = r.ticker; li.append(t);
      li.addEventListener("pointerdown", (e) => { e.preventDefault(); pickRow(r); });
      return li;
    }));
    listEl.hidden = !matches.length;
    input.setAttribute("aria-expanded", String(matches.length > 0));
    if (hi >= 0) input.setAttribute("aria-activedescendant", `pick-opt-${hi}`); else input.removeAttribute("aria-activedescendant");
  }
  function hideList() { matches = []; hi = -1; showList(); }
  function pickRow(r) { cur = r; input.value = key(r); hideList(); render(); input.blur(); }
  input.addEventListener("input", () => {
    matches = search(input.value); hi = matches.length ? 0 : -1; showList();
    // on a phone the keyboard covers the lower half: once, move the box near the top so the list shows
    const box = input.getBoundingClientRect();
    if (matches.length && window.visualViewport && box.bottom + 160 > visualViewport.height) {
      window.scrollBy({ top: box.top - 70, behavior: "smooth" });
    }
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && matches.length) { hi = (hi + 1) % matches.length; showList(); e.preventDefault(); }
    else if (e.key === "ArrowUp" && matches.length) { hi = (hi - 1 + matches.length) % matches.length; showList(); e.preventDefault(); }
    else if (e.key === "Enter") { const r = matches[hi] || byKey.get(input.value.trim().toLowerCase()) || byTk.get(input.value.trim().toLowerCase()); if (r) pickRow(r); e.preventDefault(); }
    else if (e.key === "Escape") { hideList(); input.value = key(cur); }
  });
  input.addEventListener("focus", () => { input.select(); });
  input.addEventListener("blur", () => { setTimeout(() => { hideList(); if (!input.value.trim()) input.value = key(cur); }, 150); });
  range.addEventListener("input", render);
  render();
  if (shared || location.hash === "#pick") requestAnimationFrame(() => document.getElementById("pick").scrollIntoView());

  const shareBtn = document.getElementById("pick-share"), shareNote = document.getElementById("pick-share-note");
  shareBtn.addEventListener("click", async () => {
    const u = AMOUNTS[+range.value];
    const url = `${location.origin}${location.pathname}?co=${encodeURIComponent(cur.ticker)}&each=${u}#pick`;
    const sec = (cur.interval || cur.lossInterval) * u / 1e6;
    const pace = sec < 1 ? `${fmtRate(1 / sec)} times a second` : `once every ${fmtInterval(sec)}`;
    const text = cur.interval > 0 ? `${cur.name} makes ${amtLabel(u)} ${pace}.` : `${cur.name} loses ${amtLabel(u)} ${pace}.`;
    // 1) the phone's share sheet where there is one; 2) the clipboard; 3) show the link to copy by hand
    if (navigator.share) {
      try { await navigator.share({ title: document.title, text, url }); return; }
      catch (e) { if (e && e.name === "AbortError") return; }
    }
    const copied = await copyText(url);
    shareNote.replaceChildren(copied ? "Link copied: " : "Your link: ");
    const a = document.createElement("a"); a.href = url; a.textContent = url; shareNote.append(a);
  });
  async function copyText(t) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await Promise.race([navigator.clipboard.writeText(t), new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 1500))]);
        return true;
      }
    } catch (e) { /* fall through to the old way */ }
    const ta = document.createElement("textarea");
    ta.value = t; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px";
    document.body.append(ta); ta.select(); ta.setSelectionRange(0, t.length);
    let ok = false; try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }
  for (const el of [input, range]) el.addEventListener("input", () => { shareNote.textContent = ""; });

  const groups = d3.groups(Object.entries(spMeta.skipped_reason || {}), ([, why]) => why);
  const nLeft = d3.sum(groups, ([, g]) => g.length);
  d3.select("#sp500-note").text(
    `The picker at the end covers ${sp.length} companies in the S&P 500, as listed in the holdings of the SPDR S&P 500 ETF Trust (SPY) on ${fmtDate(spMeta.holdings_as_of)}, with the same twelve-month net income method and checks as the rest of the story. ` +
    (nLeft ? `${nLeft} are left out. ` + groups.map(([why, g]) => `${list(g.map(([t]) => t))}: ${why}.`).join(" ") + " The reasons are spelled out in sp500_log.txt." : ""));
}
