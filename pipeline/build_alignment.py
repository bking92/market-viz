"""Build data for the Alignment Healthcare story: half a star.

Sources (all downloaded by this script; nothing is typed in by hand except the short quoted passages in
QUOTES, and the build stops if any of those passages is missing from the document it names)
  * Alignment Healthcare's quarterly earnings releases (SEC Form 8-K, Exhibit 99.1), Q1 2021 to Q3 2026:
    health plan membership and medical benefits ratio, each with the sentence it came from.
  * SEC EDGAR XBRL company facts (data.sec.gov): quarterly revenue (checked against the releases), the
    nine-month 2026 income statement used for "out of every $100", and shares outstanding from 10-Q covers.
  * Alignment's 8-K of Oct 8, 2026 (2027 Star Ratings), its Jan 2026 J.P. Morgan conference deck (8-K
    exhibit), its Q3 2026 10-Q (whistleblower lawsuit), the March 2021 IPO closing 8-K.
  * CMS's 2027 Star Ratings fact sheet, KFF's Medicare Advantage glossary (quality bonus) and MedPAC's
    June 2019 report, chapter 8 (rebate shares by star rating).
  * Daily closing prices from Yahoo Finance's chart API (split-adjusted close; ALHC has never split).

Checks (written to build_log.txt; the build stops if any fails)
  1. Every quarter from Q1 2021 has exactly one release, with membership and medical benefits ratio.
  2. Revenue printed in each release matches XBRL revenue for that quarter to within $0.1 million.
  3. Nine-month 2026 income statement adds up: revenue = medical + SG&A + D&A + operating income.
  4. Prices: no gaps longer than 5 calendar days outside known market holidays, and two closes quoted in
     press coverage match (Jun 9, 2026 $19.20; Sep 15, 2026 $10.37).
  5. Every quoted passage is found verbatim (after whitespace clean-up) in its downloaded source.

Run from the site root:
    SEC_USER_AGENT="your name you@example.com" python3 pipeline/build_alignment.py
"""
import csv, datetime as dt, html, io, json, os, re, sys, time, urllib.request

OUT = "stories/alignment/data"
CACHE = os.environ.get("ALHC_CACHE", "/tmp/alhc-cache")
os.makedirs(OUT, exist_ok=True)
os.makedirs(CACHE, exist_ok=True)
CIK = "1832466"
LOG = []


def log(*a):
    s = " ".join(str(x) for x in a)
    LOG.append(s)
    print(s)


def fail(msg):
    log("FAIL:", msg)
    write_log()
    sys.exit(1)


def write_log():
    with open(os.path.join(OUT, "build_log.txt"), "w") as f:
        f.write("\n".join(LOG) + "\n")


def get(url, name=None, sec=False):
    """Download once into the cache. SEC asks for a contact User-Agent; others get a plain client name."""
    path = os.path.join(CACHE, name or re.sub(r"[^A-Za-z0-9._-]", "_", url)[-150:])
    if os.path.exists(path) and os.path.getsize(path) > 0:
        log("cached", url)
        return open(path, "rb").read()
    ua = os.environ.get("SEC_USER_AGENT") if sec else "market-viz research pipeline"
    if sec and not ua:
        sys.exit("Set SEC_USER_AGENT (name and contact email, as SEC asks).")
    for k in range(5):
        time.sleep(0.4 + 3 * k)
        try:
            data = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": ua}), timeout=60).read()
            open(path, "wb").write(data)
            log("GET", url, len(data), "bytes")
            return data
        except Exception as e:  # SEC and Yahoo both rate-limit; back off and retry
            log("retry", url, e)
    fail("could not download " + url)


def text_of(raw, kind="html"):
    if kind == "pdf":
        import logging, pypdf
        logging.getLogger("pypdf").setLevel(logging.ERROR)
        r = pypdf.PdfReader(io.BytesIO(raw))
        t = " ".join(p.extract_text() or "" for p in r.pages)
    else:
        t = raw.decode("utf-8", "ignore")
        t = re.sub(r"<(script|style)\b.*?</\1>", " ", t, flags=re.S | re.I)
        t = re.sub(r"<[^>]+>", " ", t)
        t = html.unescape(t)
    t = t.replace(" ", " ").replace("’", "'").replace("“", '"').replace("”", '"')
    return re.sub(r"\s+", " ", t)


def sec_url(acc, doc):
    return f"https://www.sec.gov/Archives/edgar/data/{CIK}/{acc.replace('-', '')}/{doc}"


# ---------------------------------------------------------------- filings index
sub = json.loads(get(f"https://data.sec.gov/submissions/CIK{int(CIK):010d}.json", "submissions.json", sec=True))
r = sub["filings"]["recent"]
filings = list(zip(r["form"], r["filingDate"], r["accessionNumber"], r["primaryDocument"], r["items"]))
earn = sorted([(d, a) for f, d, a, p, it in filings if f == "8-K" and "2.02" in it.split(",")])


def exhibit_991(acc):
    idx = json.loads(get(sec_url(acc, "index.json"), f"idx_{acc}.json", sec=True))
    names = [i["name"] for i in idx["directory"]["item"]]
    hits = [n for n in names if re.search(r"(ex|exh)[-_]?99[-_.]?1|dex991|99_1", n, re.I) and n.endswith(".htm")]
    if len(hits) != 1:
        fail(f"{acc}: expected one Exhibit 99.1, found {hits} in {names}")
    return hits[0]


def quarter_of(filed):
    y, m = int(filed[:4]), int(filed[5:7])
    if m <= 3:
        return f"{y - 1}Q4"
    return f"{y}Q{(m - 1) // 3}"


# ---------------------------------------------------------------- quarterly releases
MEMBERS = re.compile(r"[Hh]ealth plan membership (?:at the end of the quarter was|as of Dec\.? 31, \d{4},? was) approximately ([\d,]+)")
REVENUE = re.compile(r"Total revenues? (?:was|were) \$ ?([\d,.]+) (million|billion)")
MBR = re.compile(r"Medical benefits? ratio (?:based on adjusted gross profit )?was ([\d.]+) ?%")
quarters = {}
for filed, acc in earn:
    if filed < "2021-05-01":
        continue
    doc = exhibit_991(acc)
    t = text_of(get(sec_url(acc, doc), f"{acc}_{doc}", sec=True))
    q = quarter_of(filed)
    m1, m2, m3 = MEMBERS.search(t), REVENUE.search(t), MBR.search(t)
    if not (m1 and m2 and m3):
        fail(f"{q} release {doc}: members={bool(m1)} revenue={bool(m2)} mbr={bool(m3)}")
    rev = float(m2.group(1).replace(",", "")) * (1000 if m2.group(2) == "billion" else 1)
    if q in quarters:
        fail(f"two releases for {q}")
    quarters[q] = dict(period=q, filed=filed, members=int(m1.group(1).replace(",", "")), revenue_release=rev,
                       mbr=float(m3.group(1)), source=sec_url(acc, doc),
                       members_quote=m1.group(0), mbr_quote=m3.group(0))
    log(f"{q} filed {filed}: members {quarters[q]['members']:,}, revenue ${rev:,.1f}M, MBR {m3.group(1)}%")

periods = sorted(quarters)
expect = [f"{y}Q{k}" for y in range(2021, 2027) for k in range(1, 5)]
expect = [p for p in expect if periods[0] <= p <= periods[-1]]
if periods != expect:
    fail(f"missing quarters: {sorted(set(expect) - set(periods))}")
log(f"check 1 ok: {len(periods)} quarters, {periods[0]} to {periods[-1]}")

# ---------------------------------------------------------------- XBRL
facts = json.loads(get(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{int(CIK):010d}.json", "companyfacts.json", sec=True))["facts"]
G = facts["us-gaap"]


def frame_val(tag, frame):
    vals = {x["val"] for x in G[tag]["units"]["USD"] if x.get("frame") == frame}
    return vals.pop() if len(vals) == 1 else None


def fy_val(tag, start, end):
    vals = {x["val"] for x in G[tag]["units"]["USD"] if x.get("start") == start and x["end"] == end}
    if len(vals) != 1:
        fail(f"{tag} {start}..{end}: {vals}")
    return vals.pop()


checked = 0
for p in periods:
    y, k = p[:4], p[5]
    v = frame_val("Revenues", f"CY{y}Q{k}")
    if v is None and k == "4":  # Q4 isn't filed on its own: full year minus nine months
        fy = frame_val("Revenues", f"CY{y}")
        nine = fy_val("Revenues", f"{y}-01-01", f"{y}-09-30") if fy is not None else None
        v = fy - nine if fy is not None else None
    if v is None:
        log(f"{p}: no XBRL revenue to check against")
        continue
    quarters[p]["revenue"] = round(v / 1e6, 1)
    diff = abs(v / 1e6 - quarters[p]["revenue_release"])
    if diff > 0.1 + 0.0005 * v / 1e6:  # releases round to 0.1M, or to 0.01B for big numbers
        fail(f"{p}: release revenue {quarters[p]['revenue_release']} vs XBRL {v / 1e6:.1f}")
    checked += 1
log(f"check 2 ok: release revenue matches XBRL in {checked} quarters")

S, E = "2026-01-01", "2026-09-30"
nine = {k: fy_val(k, S, E) / 1e6 for k in ["Revenues", "OperatingExpenses", "SellingGeneralAndAdministrativeExpense",
                                           "DepreciationDepletionAndAmortization", "OperatingIncomeLoss", "NetIncomeLoss",
                                           "PremiumsEarnedNet"]}
medical = nine["OperatingExpenses"] - nine["SellingGeneralAndAdministrativeExpense"] - nine["DepreciationDepletionAndAmortization"]
total = medical + nine["SellingGeneralAndAdministrativeExpense"] + nine["DepreciationDepletionAndAmortization"] + nine["OperatingIncomeLoss"]
if abs(total - nine["Revenues"]) > 0.5:
    fail(f"nine-month statement does not add up: {total} vs {nine['Revenues']}")
per100 = {
    "care": 100 * medical / nine["Revenues"],
    "running": 100 * nine["SellingGeneralAndAdministrativeExpense"] / nine["Revenues"],
    "equipment": 100 * nine["DepreciationDepletionAndAmortization"] / nine["Revenues"],
    "operating_profit": 100 * nine["OperatingIncomeLoss"] / nine["Revenues"],
    "net_profit": 100 * nine["NetIncomeLoss"] / nine["Revenues"],
    "premiums": 100 * nine["PremiumsEarnedNet"] / nine["Revenues"],
}
log("check 3 ok: nine months 2026, revenue $%.1fM; per $100: %s" % (nine["Revenues"], {k: round(v, 2) for k, v in per100.items()}))

shares = sorted({(x["end"], x["val"], x.get("accn")) for x in facts["dei"]["EntityCommonStockSharesOutstanding"]["units"]["shares"]})
log("shares outstanding on recent covers:", shares[-3:])

# ---------------------------------------------------------------- prices
p1, p2 = 1616716800, int(time.time())  # Mar 26, 2021 (first trade) to now
yraw = get(f"https://query1.finance.yahoo.com/v8/finance/chart/ALHC?period1={p1}&period2={p2}&interval=1d&events=split",
           f"yahoo_{dt.date.today()}.json")
y = json.loads(yraw)["chart"]["result"][0]
if y.get("events", {}).get("splits"):
    fail("ALHC has split; adjust the price logic")
prices = []
for t, c in zip(y["timestamp"], y["indicators"]["quote"][0]["close"]):
    if c is None:
        continue
    d = dt.datetime.fromtimestamp(t + y["meta"]["gmtoffset"], dt.timezone.utc).date()
    prices.append((d, round(c, 2)))
gaps = [(a[0], b[0]) for a, b in zip(prices, prices[1:]) if (b[0] - a[0]).days > 5]
for a, b in gaps:
    log("price gap", a, b)
if gaps:
    fail("price series has gaps")
PRESS = {dt.date(2026, 6, 9): 19.20, dt.date(2026, 9, 15): 10.37}
P = dict(prices)
for d, v in PRESS.items():
    if abs(P.get(d, -1) - v) > 0.005:
        fail(f"close on {d}: Yahoo {P.get(d)} vs press {v}")
log(f"check 4 ok: {len(prices)} closes {prices[0][0]} to {prices[-1][0]}; press spot checks match")

# ---------------------------------------------------------------- quoted passages
D8K_STARS = sec_url("0001628280-26-065470", "alhc-20261008.htm")
JPM26 = None
for f, d, a, p, it in filings:
    if f == "8-K" and d == "2026-01-12":
        idx = json.loads(get(sec_url(a, "index.json"), f"idx_{a}.json", sec=True))
        JPM26 = sec_url(a, [i["name"] for i in idx["directory"]["item"] if "deck" in i["name"].lower()][0])
Q3_10Q = sec_url("0001628280-26-068247", "alhc-20260930.htm")
IPO_8K = sec_url("0001193125-21-100476", "d292883dex991.htm")
CMS_FACT = "https://www.cms.gov/files/document/fact-sheet-2027-ma-part-d-star-ratings-october-8-2026.pdf"
KFF = "https://www.kff.org/medicare/medicare-advantage-glossary/"
MEDPAC = "https://www.medpac.gov/wp-content/uploads/import_data/scrape_files/docs/default-source/reports/jun19_ch8_medpac_reporttocongress_sec.pdf"
Q2_REL = quarters["2026Q2"]["source"]
Q3_REL = quarters["2026Q3"]["source"]

QUOTES = {
    "h3815_cut": (D8K_STARS, "expects that its California HMO health plan contract (H3815) will have a 3.5-Star Rating for rating year 2027"),
    "h3815_share": (D8K_STARS, "H3815, which had a 4.0-Star Rating for rating year 2026, serves approximately 75% of the Company's health plan membership"),
    "others_4": (D8K_STARS, "Alignment expects to retain a 4.0-Star or higher rating in each of its six other eligible plans"),
    "no_rev_2627": (D8K_STARS, "The rating year 2027 Stars results are not expected to impact the Company's revenue for fiscal years 2026 or 2027"),
    "hits_2028": (D8K_STARS, "The change in Star Ratings performance for rating year 2027 will impact the Company's quality bonus payments for fiscal year 2028"),
    "appeal": (D8K_STARS, "expects to commence litigation challenging certain Star Ratings measures and methodologies"),
    "cutpoints": (D8K_STARS, "the decline in Stars performance was driven primarily by higher industry cut points"),
    "new_members": (D8K_STARS, "with approximately 50% of Alignment's membership having joined the Company within the last two years"),
    "ninth_year": (JPM26, "CA HMO: 4 star-rated plan and nineth consecutive year rated 4 stars or greater"),
    "all_100": (JPM26, "100% of Alignment's members are in plans rated 4 stars or above, versus 65% for the industry"),
    "share_series": (JPM26, "94% 92% 100% 100% 74% 79% 66% 65% 2023 2024 2025 2026"),
    "cms_71": (CMS_FACT, "approximately 71% of MA-PD enrollees are currently in contracts that will have four or more stars in 2027"),
    "cms_my": (CMS_FACT, "beginning with the 2029 Star Ratings (measurement year 2027)"),
    "kff_qbp": (KFF, "The Affordable Care Act requires CMS to increase the benchmark for plans that are part of contracts that have at least a 4-star rating, on a 5-star scale. The increase in the benchmark is 5 percentage points in most counties and 10 percentage points in double bonus counties."),
    "medpac_rebate": (MEDPAC, "The rebate amount for plans at 4.5 and 5 stars is 70 percent of the bid–benchmark difference; at 3.5 and 4"),
    "medpac_rebate2": (MEDPAC, "65 percent of the difference; and below 3.5 stars, 50 percent of the difference"),
    "lawsuit": (Q3_10Q, "On July 7, 2026, a former executive officer filed a lawsuit against the Company and certain officers in the U.S. District Court for the Central District of California alleging whistleblower retaliation"),
    "lawsuit_merit": (Q3_10Q, "The Company believes the claims are without merit and intends to defend the matter vigorously"),
    "ipo": (IPO_8K, "closing of its initial public offering of 27,200,000 shares of its common stock at $18.00 per share"),
    "q2_beat": (Q2_REL, "Raises the midpoint of all full-year guidance metrics"),
    "q3_lower": (Q3_REL, "lowers full-year 2026 adjusted gross profit and adjusted EBITDA guidance"),
    "q3_trend": (Q3_REL, "while medical trends ran higher than expected"),
}
texts = {}
for k, (url, q) in QUOTES.items():
    if url not in texts:
        kind = "pdf" if url.endswith(".pdf") else "html"
        texts[url] = text_of(get(url, sec=url.startswith("https://www.sec.gov")), kind)
    norm = lambda s: re.sub(r"\s+", " ", s).strip()
    if norm(q) not in texts[url]:
        fail(f"quote {k} not found in {url}")
log(f"check 5 ok: {len(QUOTES)} quoted passages found in their sources")


# ---------------------------------------------------------------- events on the price chart
# Each event: the trading day the price moved, why, and where that comes from. Press reports are
# secondary; the move itself is always computed from the price series.
EVENTS = [
    dict(date="2026-07-08", label="Whistleblower lawsuit", src="lawsuit",
         note="A former executive sued on July 7, alleging retaliation after he reported concerns about the accounting. Alignment says the claims are without merit."),
    dict(date="2026-07-31", label="After second-quarter results", src="q2_beat",
         note="Results beat forecasts, but on the call managers said they would reinvest some of the gains, according to StockStory.",
         press="https://markets.financialcontent.com/stocks/article/stockstory-2026-7-31-alignment-healthcare-alhc-stock-trades-down-here-is-why"),
    dict(date="2026-09-15", label="Rising costs", src=None, days=2,
         note="At an investor conference on Sept. 15, executives talked about higher hospital and nursing-home costs, the Orange County Business Journal reported.",
         press="https://www.ocbj.com/oc-homepage/alignment-shares-tumble-on-rising-medical-costs/"),
    dict(date="2026-10-09", label="Half a star", src="h3815_cut",
         note="Medicare's 2027 ratings, released Oct. 8 after the close, cut the main California plan to 3.5 stars."),
    dict(date="2026-10-30", label="Lower forecast", src="q3_lower",
         note="Third-quarter results on Oct. 29, after the close: medical costs ran higher than expected and profit guidance came down."),
]
dates = [d for d, _ in prices]
for e in EVENTS:
    d = dt.date.fromisoformat(e["date"])
    i = dates.index(d)
    n = e.get("days", 1)
    e["before"], e["after"] = prices[i - 1][1], prices[i + n - 1][1]
    e["end"] = str(prices[i + n - 1][0])
    e["change"] = round(e["after"] / e["before"] - 1, 4)
    e["source_url"] = QUOTES[e["src"]][0] if e["src"] else None
    log(f"event {e['date']} ({n} day): {e['before']} -> {e['after']} ({e['change']:+.1%}) {e['label']}")

# ---------------------------------------------------------------- headline numbers
y26 = [(d, c) for d, c in prices if d.year == 2026]
peak = max(y26, key=lambda x: x[1])
last = prices[-1]
low_all = min(prices, key=lambda x: x[1])


def shares_on(d):
    """Shares outstanding from the latest 10-Q/10-K cover dated on or before d."""
    best = [s for s in shares if s[0] <= str(d)]
    return best[-1]


sp, sl = shares_on(peak[0]), shares_on(last[0])
mv_peak, mv_last = peak[1] * sp[1] / 1e9, last[1] * sl[1] / 1e9
log(f"2026 peak {peak}, value ${mv_peak:.2f}B on {sp[1]:,} shares (cover {sp[0]}); last {last}, ${mv_last:.2f}B on {sl[1]:,} (cover {sl[0]})")

meta = dict(
    built=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
    ipo_price=18.00, first_close=dict(date=str(prices[0][0]), close=prices[0][1]),
    low=dict(date=str(low_all[0]), close=low_all[1]),
    peak_2026=dict(date=str(peak[0]), close=peak[1], shares=sp[1], shares_as_of=sp[0], value_bn=round(mv_peak, 3)),
    last=dict(date=str(last[0]), close=last[1], shares=sl[1], shares_as_of=sl[0], value_bn=round(mv_last, 3)),
    nine_months_2026=dict({k: round(v, 1) for k, v in nine.items()}, medical=round(medical, 1)),
    per100={k: round(v, 3) for k, v in per100.items()},
    stars=dict(
        h3815_years_4plus=9, h3815_years=[2018, 2026], h3815_2027=3.5, h3815_share_of_members=0.75,
        share_4plus=dict(alignment={"2023": 94, "2024": 92, "2025": 100, "2026": 100},
                         industry={"2023": 74, "2024": 79, "2025": 66, "2026": 65, "2027": 71}),
        alignment_2027_max=25,
        bonus_points=5, bonus_points_double=10,
    ),
    events=EVENTS,
    quotes={k: dict(url=u, text=q) for k, (u, q) in QUOTES.items()},
    sources=dict(xbrl=f"https://data.sec.gov/api/xbrl/companyfacts/CIK{int(CIK):010d}.json",
                 prices="https://query1.finance.yahoo.com/v8/finance/chart/ALHC",
                 jpm2026=JPM26, stars_8k=D8K_STARS, q3_10q=Q3_10Q, cms=CMS_FACT, kff=KFF, medpac=MEDPAC, ipo=IPO_8K),
)
with open(os.path.join(OUT, "meta.json"), "w") as f:
    json.dump(meta, f, indent=1)
with open(os.path.join(OUT, "quarters.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["period", "members", "revenue_musd", "mbr_pct", "release_filed", "source"])
    for p in periods:
        q = quarters[p]
        w.writerow([p, q["members"], q.get("revenue", q["revenue_release"]), q["mbr"], q["filed"], q["source"]])
with open(os.path.join(OUT, "prices.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["date", "close"])
    w.writerows([(str(d), f"{c:.2f}") for d, c in prices])
log("wrote meta.json, quarters.csv, prices.csv")
write_log()
