"""Build data for the "Newton's cradles" story: how long each company takes to earn $1 million of profit.

Source: SEC EDGAR XBRL company facts (data.sec.gov/api/xbrl/companyfacts), us-gaap NetIncomeLoss
(net income attributable to the parent company), in US dollars, from each company's own 10-K and 10-Q filings.

Trailing twelve months (TTM) ending at the latest reported quarter:
    TTM = latest fiscal-year total + latest year-to-date total - the same year-to-date period a year earlier.
If the latest report is a 10-K, TTM is that fiscal year. Each TTM is cross-checked against the sum of four
discrete quarters where the filings give them, and every input (with accession numbers) goes to build_log.txt.

Seconds to earn $1M = 1,000,000 / (TTM net income / seconds in the TTM window). The window length is the
real number of days between the start and end dates (52/53-week years differ).

Two extras for the story:
  * decade.csv: the same twelve-month net income for each of the "giants", for the window ending ten years
    before their latest one, from the same filings API, as first reported.
  * pair.json: two companies with almost the same profit pace but very different market values. Market value
    = shares outstanding on the cover of the latest 10-Q/10-K (dei:EntityCommonStockSharesOutstanding) x the
    last close on or before AS_OF from Yahoo Finance's chart API.

Run from the site root:
    SEC_USER_AGENT="your name you@example.com" python3 pipeline/build_cradles.py
"""
import csv, datetime as dt, hashlib, json, os, sys, time, urllib.request

OUT = "stories/cradles/data"
CACHE = os.environ.get("CRADLE_CACHE", "/tmp/cradle-cache")
UA_SEC = os.environ.get("SEC_USER_AGENT", "market-viz research pipeline admin@example.com")
AS_OF = os.environ.get("AS_OF", dt.date.today().isoformat())  # ignore filings made after this date
os.makedirs(CACHE, exist_ok=True)
os.makedirs(OUT, exist_ok=True)
LOG = []

# (ticker, display name, group). Groups drive the scroll steps; the order inside a group does not matter.
COMPANIES = [
    # The biggest US-listed earners
    ("NVDA", "Nvidia", "giants"), ("AAPL", "Apple", "giants"), ("GOOGL", "Alphabet", "giants"),
    ("MSFT", "Microsoft", "giants"), ("AMZN", "Amazon", "giants"), ("META", "Meta", "giants"),
    ("JPM", "JPMorgan Chase", "giants"), ("BRK-B", "Berkshire Hathaway", "giants"),
    # Names everyone knows
    ("V", "Visa", "brands"), ("WMT", "Walmart", "brands"), ("LLY", "Eli Lilly", "brands"),
    ("KO", "Coca-Cola", "brands"), ("COST", "Costco", "brands"), ("MCD", "McDonald's", "brands"),
    ("NFLX", "Netflix", "brands"), ("TSLA", "Tesla", "brands"), ("HSY", "Hershey", "brands"),
    ("DAL", "Delta Air Lines", "brands"),
    ("CMG", "Chipotle", "brands"), ("DPZ", "Domino's", "brands"),
    # Small and particular
    ("CROX", "Crocs", "small"), ("WDFC", "WD-40", "small"), ("BBW", "Build-A-Bear", "small"),
    ("NATH", "Nathan's Famous", "small"),
    # Candidates expected to be losing money (checked, not assumed)
    ("INTC", "Intel", "losses"), ("BA", "Boeing", "losses"), ("RIVN", "Rivian", "losses"),
    ("PTON", "Peloton", "losses"), ("MRNA", "Moderna", "losses"), ("LCID", "Lucid", "losses"),
    ("SNAP", "Snap", "losses"),
]
# Checked and left out, with the reason shown on the page:
PAIR = ("TSLA", "DAL")  # similar profit, very different market value; checked below
YEARS_BACK = 10
UA_PLAIN = "market-viz-research/0.1 (data pipeline)"
# Companies that have dropped off SEC's ticker list but whose last filings are still used, with why.
CIK_FALLBACK = {"NATH": 69733}
DEREGISTERED = {
    "NATH": "Nathan's Famous filed a Form 15 on November 5, 2026, ending its SEC registration, so it has left "
            "SEC's ticker list. Its last reported twelve months (to June 28, 2026) are still used.",
}
EXCLUDED = {
    "BYND": "Beyond Meat: its trailing-twelve-month net income built from year-to-date figures differs by "
            "$10.8 million from the sum of its four reported quarters, so the figure is ambiguous.",
}
# Candidates for the loss group that turned out to be profitable go here instead.
PROFIT_GROUP = {"BA": "brands", "PTON": "small"}
TAGS = ["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"]


def log(msg):
    print(msg)
    LOG.append(msg)


def fetch(url, ua=None):
    p = os.path.join(CACHE, hashlib.sha1(url.encode()).hexdigest())
    if os.path.exists(p):
        return open(p, "rb").read()
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": ua or UA_SEC, "Accept-Encoding": "identity"})
            body = urllib.request.urlopen(req, timeout=60).read()
            open(p, "wb").write(body)
            log(f"GET {url} -> {len(body)} bytes")
            time.sleep(0.15)  # SEC fair-access limit is 10 requests a second
            return body
        except Exception as e:  # noqa: BLE001
            log(f"GET {url} failed (attempt {attempt + 1}): {e}")
            time.sleep(2 ** attempt)
    sys.exit(f"could not fetch {url}")


def d(s):
    return dt.date.fromisoformat(s)


def days(f):
    return (d(f["end"]) - d(f["start"])).days + 1


def facts_for(cf, tag, first=False):
    node = cf["facts"].get("us-gaap", {}).get(tag, {}).get("units", {}).get("USD")
    if not node:
        return None
    # Only the company's own periodic reports, filed by AS_OF. For each (start, end), keep the most
    # recently filed value, so restatements win over first reports.
    best = {}
    for f in node:
        if f.get("form") not in ("10-K", "10-Q", "10-K/A", "10-Q/A") or "start" not in f:
            continue
        if f["filed"] > AS_OF:
            continue
        k = (f["start"], f["end"])
        if k not in best or (f["filed"] < best[k]["filed"] if first else f["filed"] > best[k]["filed"]):
            best[k] = f
    return list(best.values())


def near(a, b, tol=10):
    return abs((d(a) - d(b)).days) <= tol


def ttm(facts):
    """Return dict with value, start, end, method and the inputs used."""
    annual = [f for f in facts if 350 <= days(f) <= 380]
    latest_end = max(f["end"] for f in facts)
    latest_annual = max(annual, key=lambda f: f["end"])
    if latest_annual["end"] == latest_end:
        how = ("fiscal year (latest report is the annual report)" if latest_annual["form"].startswith("10-K")
               else "twelve months as reported in the latest 10-Q")
        return dict(value=latest_annual["val"], start=latest_annual["start"], end=latest_annual["end"],
                    method=how, inputs=[latest_annual])
    # year-to-date: the longest period ending at latest_end that starts after the last fiscal year ended
    ytd = [f for f in facts if f["end"] == latest_end and d(f["start"]) > d(latest_annual["end"])
           and days(f) < 350]
    ytd = max(ytd, key=days)
    # same period a year earlier
    prior = [f for f in facts if near(f["end"], (d(latest_end) - dt.timedelta(days=364)).isoformat())
             and abs(days(f) - days(ytd)) <= 8 and f is not ytd]
    if not prior:
        raise ValueError("no prior-year year-to-date figure")
    prior = min(prior, key=lambda f: abs((d(f["end"]) - (d(latest_end) - dt.timedelta(days=364))).days))
    if not near(prior["start"], latest_annual["start"], 10):
        raise ValueError(f"prior YTD {prior['start']} does not start with fiscal year {latest_annual['start']}")
    value = latest_annual["val"] + ytd["val"] - prior["val"]
    return dict(value=value, start=(d(prior["end"]) + dt.timedelta(days=1)).isoformat(), end=latest_end,
                method="trailing twelve months: fiscal year + this year to date − last year to date",
                inputs=[latest_annual, ytd, prior])


def four_quarters(facts, end):
    """Cross-check: sum the four discrete quarters ending at `end`, deriving Q4 as FY minus 9 months."""
    q = {f["end"]: f for f in facts if 85 <= days(f) <= 98}
    for f in facts:  # fill Q4s
        if 350 <= days(f) <= 380 and f["end"] not in q:
            nine = [g for g in facts if g["start"] == f["start"] and 265 <= days(g) <= 285]
            if nine:
                q[f["end"]] = dict(val=f["val"] - nine[0]["val"], start=nine[0]["end"], end=f["end"])
    ends = sorted(e for e in q if e <= end)[-4:]
    if len(ends) < 4 or ends[-1] != end:
        return None
    if (d(ends[-1]) - d(ends[0])).days > 290:
        return None
    return sum(q[e]["val"] for e in ends)


def main():
    tickers = json.loads(fetch("https://www.sec.gov/files/company_tickers.json"))
    cik_of = {v["ticker"]: v["cik_str"] for v in tickers.values()}
    title_of = {v["ticker"]: v["title"] for v in tickers.values()}
    rows = []
    kept = {}
    for tk, name, group in COMPANIES:
        if tk in EXCLUDED:
            log(f"{tk}: excluded. {EXCLUDED[tk]}")
            continue
        cik = cik_of.get(tk) or CIK_FALLBACK.get(tk)
        if tk not in cik_of and cik:
            log(f"{tk}: not in SEC's current ticker list; using CIK {cik} from CIK_FALLBACK")
        if cik is None:
            log(f"{tk}: not in SEC ticker list, skipped")
            continue
        cf = json.loads(fetch(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json"))
        res = None
        for tag in TAGS:
            facts = facts_for(cf, tag)
            if not facts:
                continue
            latest = max(f["end"] for f in facts)
            if (d(AS_OF) - d(latest)).days > 200:
                log(f"{tk}: {tag} latest period ends {latest}, too old; trying next tag")
                continue
            try:
                res = ttm(facts)
                res["tag"] = tag
                res["check"] = four_quarters(facts, res["end"])
                break
            except ValueError as e:
                log(f"{tk}: {tag}: {e}")
        if res is None:
            log(f"{tk}: no usable net income series, skipped")
            continue
        kept[tk] = dict(cf=cf, facts=facts, res=res, cik=cik, name=name, group=group)
        span_days = (d(res["end"]) - d(res["start"])).days + 1
        secs = span_days * 86400
        per_sec = res["value"] / secs
        to_million = 1e6 / per_sec if res["value"] > 0 else None
        log(f"{tk} ({cf['entityName']}, CIK {cik}): tag {res['tag']}, {res['method']}")
        for f in res["inputs"]:
            log(f"    {f['start']}..{f['end']} {f['val']:>18,} USD  {f['form']} filed {f['filed']} accn {f['accn']}")
        log(f"    TTM {res['start']}..{res['end']} ({span_days} days) = {res['value']:,} USD")
        if res["check"] is not None:
            diff = res["check"] - res["value"]
            log(f"    check, sum of four quarters = {res['check']:,} (difference {diff:,})")
            if abs(diff) > max(2e6, abs(res["value"]) * 0.005):
                sys.exit(f"{tk}: TTM and four-quarter sum disagree")
        else:
            log("    check: four discrete quarters not available in the filings")
        log(f"    = {per_sec:,.2f} USD per second" + (f"; $1M every {to_million:,.1f} s" if to_million else "; loss"))
        listed_group = group
        if res["value"] <= 0:
            group = "losses"
        elif group == "losses":
            group = PROFIT_GROUP.get(tk, "brands")
            log(f"    expected a loss but it is profitable: moved to group {group}")
        rows.append(dict(ticker=tk, name=name, sec_name=cf["entityName"], cik=cik, group=group,
                         listed_as=listed_group,
                         tag=res["tag"], period_start=res["start"], period_end=res["end"], days=span_days,
                         net_income=res["value"], per_second=round(per_sec, 4),
                         seconds_per_million=round(to_million, 3) if to_million else "",
                         basis="FY" if res["method"].startswith("fiscal") else "TTM", method=res["method"],
                         sources=" ".join(sorted({f["accn"] for f in res["inputs"]})),
                         latest_filed=max(f["filed"] for f in res["inputs"])))
    rows.sort(key=lambda r: -r["per_second"])
    decade_skipped = decade(rows, kept)
    pair(rows, kept)
    with open(f"{OUT}/companies.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    meta = dict(deregistered=DEREGISTERED, decade_skipped=decade_skipped, excluded=EXCLUDED, as_of=AS_OF, built=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"), n=len(rows),
                source="SEC EDGAR XBRL company facts API, https://data.sec.gov/api/xbrl/companyfacts/")
    json.dump(meta, open(f"{OUT}/meta.json", "w"), indent=1)
    open(f"{OUT}/build_log.txt", "w").write("\n".join(LOG) + "\n")



def decade(rows, kept):
    """Twelve-month net income for each giant, for the window ending YEARS_BACK years before its latest."""
    out, skipped = [], {}
    log(f"\n--- {YEARS_BACK} years earlier ---")
    for r in rows:
        if r["group"] != "giants":
            continue
        k = kept[r["ticker"]]
        target = d(r["period_end"]) - dt.timedelta(days=round(365.25 * YEARS_BACK))
        # As first reported: later restatements (e.g. new accounting rules applied to old years) would mix
        # restated annual figures with quarters that were never restated.
        first = facts_for(k["cf"], r["tag"], first=True)
        # Only filings made within five months of the window's end: what was known at the time.
        sub = [f for f in first if d(f["end"]) <= target + dt.timedelta(days=20)
               and d(f["filed"]) <= target + dt.timedelta(days=150)]
        try:
            res = ttm(sub)
        except (ValueError, KeyError) as e:
            log(f"{r['ticker']}: no {YEARS_BACK}-year-earlier figure ({e}); left out")
            skipped[r["ticker"]] = f"{r['name']}: no usable figure from {YEARS_BACK} years earlier in its filings."
            continue
        if abs((d(res["end"]) - target).days) > 45:
            log(f"{r['ticker']}: nearest window ends {res['end']}, too far from {target}; left out")
            continue
        days_ = (d(res["end"]) - d(res["start"])).days + 1
        ps = res["value"] / (days_ * 86400)
        log(f"{r['ticker']}: {res['method']}")
        for f in res["inputs"]:
            log(f"    {f['start']}..{f['end']} {f['val']:>18,} USD  {f['form']} filed {f['filed']} accn {f['accn']}")
        chk = four_quarters(sub, res["end"])
        log(f"    TTM {res['start']}..{res['end']} ({days_} days) = {res['value']:,} USD"
            + (f"; four-quarter sum {chk:,}" if chk is not None else "; four discrete quarters not available"))
        if chk is not None and abs(chk - res["value"]) > max(2e6, abs(res["value"]) * 0.005):
            log(f"    disagrees with the four-quarter sum by {chk - res['value']:,}: ambiguous, left out")
            skipped[r["ticker"]] = (f"{r['name']}: the filings from then don't add up. Its twelve months to "
                                    f"{res['end']} come to ${res['value'] / 1e9:.2f} billion from the year totals but "
                                    f"${chk / 1e9:.2f} billion from the four quarters, so it is left out.")
            continue
        log(f"    = {ps:,.2f} USD per second" + (f"; $1M every {1e6 / ps:,.1f} s" if ps > 0 else "; loss"))
        out.append(dict(ticker=r["ticker"], name=r["name"], period_start=res["start"], period_end=res["end"],
                        days=days_, net_income=res["value"], per_second=round(ps, 4),
                        seconds_per_million=round(1e6 / ps, 3) if ps > 0 else "",
                        sources=" ".join(sorted({f["accn"] for f in res["inputs"]})), cik=r["cik"]))
    with open(f"{OUT}/decade.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(out[0]))
        w.writeheader()
        w.writerows(out)
    return skipped


def last_close(ticker):
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?range=1mo&interval=1d"
    j = json.loads(fetch(url, ua=UA_PLAIN))["chart"]["result"][0]
    best = None
    for ts, c in zip(j["timestamp"], j["indicators"]["quote"][0]["close"]):
        day = dt.datetime.fromtimestamp(ts + j["meta"]["gmtoffset"], dt.timezone.utc).date().isoformat()
        if c is not None and day <= AS_OF:
            best = (day, round(c, 2))
    log(f"{ticker}: last close on or before {AS_OF}: {best[1]} on {best[0]} ({url})")
    return best


def pair(rows, kept):
    log("\n--- pair: similar profit, different market value ---")
    out = []
    for tk in PAIR:
        k = kept[tk]
        r = next(x for x in rows if x["ticker"] == tk)
        sh = k["cf"]["facts"]["dei"]["EntityCommonStockSharesOutstanding"]["units"]["shares"]
        sh = [f for f in sh if f["filed"] <= AS_OF]
        last = max(f["end"] for f in sh)
        cur = [f for f in sh if f["end"] == last]
        latest_filed = max(f["filed"] for f in cur)
        cur = [f for f in cur if f["filed"] == latest_filed]
        if len(cur) != 1:
            sys.exit(f"{tk}: expected one share class on the cover, found {len(cur)}")
        f = cur[0]
        day, close = last_close(tk)
        mv = f["val"] * close
        log(f"{tk}: {f['val']:,} shares as of {f['end']} ({f['form']} filed {f['filed']}, accn {f['accn']})"
            f" x {close} = {mv:,.0f} USD")
        out.append(dict(ticker=tk, name=r["name"], net_income=r["net_income"], per_second=r["per_second"],
                        period_end=r["period_end"], shares=f["val"], shares_as_of=f["end"], shares_accn=f["accn"],
                        shares_form=f["form"], close=close, close_date=day, market_value=round(mv), cik=r["cik"]))
    a, b = out
    gap = abs(a["net_income"] / b["net_income"] - 1)
    ratio = max(a["market_value"], b["market_value"]) / min(a["market_value"], b["market_value"])
    log(f"profit gap {gap:.1%}, market value ratio {ratio:.1f}x")
    if gap > 0.1:
        sys.exit("pair: profits are not within 10% of each other; pick another pair")
    json.dump(dict(companies=out, profit_gap=round(gap, 4), value_ratio=round(ratio, 2),
                   price_source="Yahoo Finance chart API, daily close"), open(f"{OUT}/pair.json", "w"), indent=1)


if __name__ == "__main__":
    main()
