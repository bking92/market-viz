// "A million dollars, click by click". Reads only ./data, which pipeline/build_cradles.py writes.
import { scroller } from "../../assets/js/scroller.js";
import { CradleScene, fmtInterval } from "./cradle.js";

const d3 = window.d3;
const [raw, meta] = await Promise.all([d3.csv("data/companies.csv"), d3.json("data/meta.json")]);
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
const fmtDate = (s) => d3.timeFormat("%b %-d, %Y")(d3.timeParse("%Y-%m-%d")(s));
const list = (a) => (a.length < 2 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);
const UNIT = 1e4; // dollars per strike after the first step
const every = (r) => r.interval * UNIT / 1e6; // seconds between $10k strikes
const perSecAt = (r, speed) => speed / every(r);

const lastBrand = brands[brands.length - 1];
const moved = rows.filter((r) => r.listed_as === "losses" && r.group !== "losses");
const fills = {
  "fastest": fastest.name,
  "fastest-interval": fmtInterval(fastest.interval),
  "fastest-rate": `$${d3.format(",.0f")(fastest.per_second)}`,
  "giants-n": String(giants.length),
  "fastest-unit": fmtInterval(every(fastest)),
  "giants-max": `${Math.ceil(d3.max(giants, every))} seconds`,
  "giants-note": `${giants[giants.length - 1].name}, the slowest of this group, strikes every ${fmtInterval(every(giants[giants.length - 1]))}.`,
  "brands-note": `${brands[0].name} strikes every ${fmtInterval(every(brands[0]))}. ${lastBrand.name} strikes once every ${fmtInterval(every(lastBrand))}.`,
  "slowest-unit": fmtInterval(every(slowest)),
  "fastest-hour": d3.format(",.0f")(perSecAt(fastest, 3600)),
  "slowest": slowest.name,
  "slowest-interval": fmtInterval(slowest.interval),
  "slowest-hour": fmtInterval(every(slowest) / 3600),
  "ratio": usd(1e6 * slowest.interval / fastest.interval),
  "loss-note": `${losers[0].name} lost ${usd(losers[0].net_income)}: a million dollars gone every ${fmtInterval(losers[0].lossInterval)}. ` +
    `${list(losers.slice(1).map((r) => r.name))} lost money too.` +
    (moved.length ? ` I expected ${list(moved.map((r) => r.name))} to be here as well, but ${moved.length > 1 ? "they" : "it"} made a profit over these twelve months, so ${moved.length > 1 ? "they swing" : "it swings"} with the rest.` : ""),
  "as-of": fmtDate(meta.as_of),
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
const scene = new CradleScene(document.getElementById("stage"), rows, { onStrike, maxR: 30, unit: UNIT });
const clock = document.getElementById("clock");
const speedText = { 1: "Real time", 3600: "Each second here is <b>one hour</b>", 86400: "Each second here is <b>one day</b>" };
const unitText = (u) => (u >= 1e6 ? "each strike is <b>$1 million</b>" : "each strike is <b>$10,000</b>");
const tk = (a) => a.map((r) => r.ticker);
const STEPS = [
  { show: [fastest.ticker], speed: 1, unit: UNIT },
  { show: tk(giants), speed: 1, unit: UNIT },
  { show: tk(brands), speed: 1, unit: UNIT },
  { show: tk([...giants, ...brands]), speed: 3600, unit: UNIT },
  { show: tk(small), speed: 3600, unit: UNIT },
  { show: tk(small), speed: 86400, unit: UNIT },
  { show: tk(losers), speed: 86400, unit: UNIT },
];
function go(i) {
  const s = STEPS[Math.max(0, Math.min(i, STEPS.length - 1))];
  scene.layout(s.show);
  scene.setSpeed(s.speed);
  scene.setUnit(s.unit);
  clock.innerHTML = `${speedText[s.speed]}, ${unitText(s.unit)}`;
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
explore.setSpeed(3600, true);
window.addEventListener("resize", () => { sizeAll(); });
for (const b of document.querySelectorAll(".speeds button")) {
  b.addEventListener("click", () => {
    for (const o of document.querySelectorAll(".speeds button")) o.setAttribute("aria-pressed", String(o === b));
    explore.setSpeed(+b.dataset.speed);
  });
}

// ---------- method: gaps and the table ----------
const brk = rows.find((r) => r.ticker === "BRK-B");
const gaps = [];
for (const [, why] of Object.entries(meta.excluded || {})) gaps.push(`${why} I left it out.`);
if (brk) gaps.push(`Berkshire Hathaway's net income includes gains and losses on the stocks it owns, whether or not it sold them, so its pace moves with the stock market as much as with its businesses. Its latest filing in the data covers the twelve months to ${fmtDate(brk.period_end)}.`);
gaps.push("Only companies that file 10-K and 10-Q reports with the SEC are included, so companies that report elsewhere or on other forms, such as TSMC with its annual 20-F, aren't here. Net income includes one-off items such as write-downs and gains on sales, which can make a single year look better or worse than the business underneath.");
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
