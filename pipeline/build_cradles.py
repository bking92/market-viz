"""Build data for the "Newton's cradles" story: how long each company takes to earn $1 million of profit.

Source: SEC EDGAR XBRL company facts (data.sec.gov/api/xbrl/companyfacts), us-gaap NetIncomeLoss
(net income attributable to the parent company), in US dollars, from each company's own 10-K and 10-Q filings.

Trailing twelve months (TTM) ending at the latest reported quarter:
    TTM = latest fiscal-year total + latest year-to-date total - the same year-to-date period a year earlier.
If the latest report is a 10-K, TTM is that fiscal year. Each TTM is cross-checked against the sum of four
discrete quarters where the filings give them, and every input (with accession numbers) goes to build_log.txt.

Seconds to earn $1M = 1,000,000 / (TTM net income / seconds in the TTM window). The window length is the
real number of days between the start and end dates (52/53-week years differ).

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


def fetch(url):
    p = os.path.join(CACHE, hashlib.sha1(url.encode()).hexdigest())
    if os.path.exists(p):
        return open(p, "rb").read()
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA_SEC, "Accept-Encoding": "identity"})
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


def facts_for(cf, tag):
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
        if k not in best or f["filed"] > best[k]["filed"]:
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
    for tk, name, group in COMPANIES:
        if tk in EXCLUDED:
            log(f"{tk}: excluded. {EXCLUDED[tk]}")
            continue
        cik = cik_of.get(tk)
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
    with open(f"{OUT}/companies.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    meta = dict(excluded=EXCLUDED, as_of=AS_OF, built=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"), n=len(rows),
                source="SEC EDGAR XBRL company facts API, https://data.sec.gov/api/xbrl/companyfacts/")
    json.dump(meta, open(f"{OUT}/meta.json", "w"), indent=1)
    open(f"{OUT}/build_log.txt", "w").write("\n".join(LOG) + "\n")


if __name__ == "__main__":
    main()
