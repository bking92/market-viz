"""Build the S&P 500 picker data for the "Newton's cradles" story.

Same method as build_cradles.py (imported from it): us-gaap net income over each company's latest twelve
reported months, from its own 10-K and 10-Q filings, cross-checked against the sum of four quarters.

Membership: the holdings of the SPDR S&P 500 ETF Trust (SPY), State Street's daily holdings file, which
tracks the index. Two share classes of one company (Alphabet, Fox, News Corp) count once. Tickers are matched
to SEC CIKs with SEC's company_tickers.json.

Unlike the main build, a company whose figures fail a check is left out (and listed in sp500_meta.json)
instead of stopping the build.

Net income per tag comes from the company-concept API (one small file per company and tag) rather than
the full company-facts file.

Run from the site root:
    SEC_USER_AGENT="your name you@example.com" python3 pipeline/build_cradles_sp500.py
"""
import csv, datetime as dt, hashlib, json, os, re, sys, time, urllib.error, urllib.request

sys.path.insert(0, os.path.dirname(__file__))
import build_cradles as bc  # noqa: E402

OUT = bc.OUT
SPY_URL = "https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us/holdings-daily-us-en-spy.xlsx"
SEC_TICKER = {"BRK.B": "BRK-B", "BF.B": "BF-B"}
WIKI_URL = "https://en.wikipedia.org/w/index.php?title=List_of_S%26P_500_companies&action=raw"
log = bc.log


def fetch_or_none(url):
    """Like bc.fetch, but a 404 (company never used this tag) returns None."""
    p = os.path.join(bc.CACHE, hashlib.sha1(url.encode()).hexdigest())
    if os.path.exists(p):
        body = open(p, "rb").read()
        return None if body == b"404" else body
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": bc.UA_SEC, "Accept-Encoding": "identity"})
            body = urllib.request.urlopen(req, timeout=60).read()
            open(p, "wb").write(body)
            time.sleep(0.12)
            return body
        except urllib.error.HTTPError as e:
            if e.code == 404:
                open(p, "wb").write(b"404")
                time.sleep(0.12)
                return None
            log(f"GET {url} failed (attempt {attempt + 1}): {e}")
        except Exception as e:  # noqa: BLE001
            log(f"GET {url} failed (attempt {attempt + 1}): {e}")
        time.sleep(2 ** attempt)
    sys.exit(f"could not fetch {url}")


def spy_holdings():
    import openpyxl
    p = os.path.join(bc.CACHE, "spy-holdings.xlsx")
    if not os.path.exists(p):
        req = urllib.request.Request(SPY_URL, headers={"User-Agent": bc.UA_PLAIN})
        open(p, "wb").write(urllib.request.urlopen(req, timeout=60).read())
        log(f"GET {SPY_URL}")
    rows = list(openpyxl.load_workbook(p, read_only=True).active.iter_rows(values_only=True))
    as_of = next(r[1] for r in rows if r[0] == "Holdings:").replace("As of ", "")
    head = next(i for i, r in enumerate(rows) if r[0] == "Name" and r[1] == "Ticker")
    out = []
    for r in rows[head + 1:]:
        if not r[0] or not r[1] or not r[1].replace(".", "").isalpha() or r[5] is None:
            continue
        out.append((r[1].strip(), r[0].strip(), r[4]))
    return dt.datetime.strptime(as_of, "%d-%b-%Y").date().isoformat(), out


def wiki_names():
    """Readable company names by CIK, for display only (SPY and SEC give names in capitals)."""
    raw = bc.fetch(WIKI_URL, ua=bc.UA_PLAIN).decode()
    names = {}
    for block in raw.split("\n|-\n"):
        cells = [c.strip() for c in block.split("\n") if c.startswith("||")]
        if len(cells) < 7 or not re.fullmatch(r"\|\|\s*\d{10}", cells[6]):
            continue
        name = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", cells[1][2:]).strip()
        name = re.sub(r"\s*\((?:Class|Series) [^)]*\)$", "", name)
        names[int(cells[6][2:])] = name
    return names


def main():
    names = wiki_names()
    log(f"Wikipedia list of S&P 500 companies: {len(names)} names by CIK (display only)")
    spy_date, holdings = spy_holdings()
    log(f"SPY holdings as of {spy_date}: {len(holdings)} lines")
    tickers = json.loads(bc.fetch("https://www.sec.gov/files/company_tickers.json"))
    cik_of = {v["ticker"]: v["cik_str"] for v in tickers.values()}
    rows, skipped, seen = [], {}, {}
    for tk, spy_name, weight in holdings:
        cik = cik_of.get(SEC_TICKER.get(tk, tk).replace(".", "-"))
        if cik is None:
            skipped[tk] = "ticker not in SEC's ticker list"
            log(f"{tk}: not in SEC ticker list, skipped")
            continue
        if cik in seen:
            log(f"{tk}: second share class of {seen[cik]}, counted once")
            continue
        seen[cik] = tk
        res, errs = None, []
        for tag in bc.TAGS:
            body = fetch_or_none(f"https://data.sec.gov/api/xbrl/companyconcept/CIK{cik:010d}/us-gaap/{tag}.json")
            if body is None:
                continue
            concept = json.loads(body)
            cf = {"facts": {"us-gaap": {tag: concept}}, "entityName": concept["entityName"]}
            facts = bc.facts_for(cf, tag)
            if not facts:
                continue
            latest = max(f["end"] for f in facts)
            if (bc.d(bc.AS_OF) - bc.d(latest)).days > 200:
                errs.append(f"{tag}: latest period ends {latest}, too old")
                continue
            try:
                res = bc.ttm(facts)
                res["tag"] = tag
                res["check"] = bc.four_quarters(facts, res["end"])
                name = concept["entityName"]
                break
            except (ValueError, KeyError) as e:
                errs.append(f"{tag}: {e or type(e).__name__}")
        if res is None:
            skipped[tk] = f"no usable twelve-month net income ({'; '.join(errs) or 'no net income tag'})"
            log(f"{tk}: {skipped[tk]}")
            continue
        span = (bc.d(res["end"]) - bc.d(res["start"])).days + 1
        log(f"{tk} ({name}, CIK {cik}): {res['tag']}, {res['method']}")
        for f in res["inputs"]:
            log(f"    {f['start']}..{f['end']} {f['val']:>18,} USD  {f['form']} filed {f['filed']} accn {f['accn']}")
        log(f"    TTM {res['start']}..{res['end']} ({span} days) = {res['value']:,} USD")
        if res["check"] is not None:
            diff = res["check"] - res["value"]
            log(f"    check, sum of four quarters = {res['check']:,} (difference {diff:,})")
            if abs(diff) > max(2e6, abs(res["value"]) * 0.005):
                skipped[tk] = f"twelve-month total and four-quarter sum disagree by ${abs(diff):,.0f}"
                log(f"    left out: {skipped[tk]}")
                continue
        else:
            log("    check: four discrete quarters not available in the filings")
        rows.append(dict(ticker=tk, name=name, display_name=names.get(cik, ""), cik=cik, tag=res["tag"], period_start=res["start"],
                         period_end=res["end"], days=span, net_income=res["value"],
                         per_second=round(res["value"] / (span * 86400), 4),
                         sources=" ".join(sorted({f["accn"] for f in res["inputs"]}))))
    rows.sort(key=lambda r: -r["per_second"])
    with open(f"{OUT}/sp500.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    def short(why):
        if "disagree" in why or "does not start" in why:
            return "figures don't reconcile"
        if "too old" in why:
            return "SEC's data doesn't have a recent enough quarter yet"
        return "no usable net income figure in SEC's data"
    reasons = {tk: short(why) for tk, why in skipped.items()}
    meta = dict(as_of=bc.AS_OF, skipped_reason=reasons, holdings_as_of=spy_date, n=len(rows), skipped=skipped,
                membership="SPDR S&P 500 ETF Trust (SPY) daily holdings, State Street",
                source="SEC EDGAR XBRL company-concept API, https://data.sec.gov/api/xbrl/companyconcept/")
    json.dump(meta, open(f"{OUT}/sp500_meta.json", "w"), indent=1)
    open(f"{OUT}/sp500_log.txt", "w").write("\n".join(bc.LOG) + "\n")
    log(f"{len(rows)} companies written, {len(skipped)} left out")


if __name__ == "__main__":
    main()
