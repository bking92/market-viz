#!/usr/bin/env python3
"""Builds the data files for stories/tech-selloff/ from primary sources.

Run from the site/ folder:  python3 pipeline/build_tech_selloff.py --start 2026-01-01
Needs network access to: query1.finance.yahoo.com (prices), fred.stlouisfed.org (cross-check),
www.sec.gov + data.sec.gov (QQQ N-PORT member list, cover-page shares outstanding), api.openfigi.com (CUSIP to ticker).

It writes:
  stories/tech-selloff/data/ndx_close.csv          date,close,source
  stories/tech-selloff/data/constituent_mcap.csv   ticker,name,cik,shares,shares_filed,close_peak,close_latest,mcap_peak,mcap_latest
  stories/tech-selloff/data/constituent_daily.csv  ticker,date,close,mcap (peak to latest)
  stories/tech-selloff/data/meta.json              source notes and known gaps shown on the page
  stories/tech-selloff/data/build_log.txt          every request made and every check run

Rules: no value is ever filled in by hand. If a source fails or two sources disagree, the script
records it in build_log.txt and the gap in meta.json, and leaves the value out.
"""
import argparse, csv, datetime as dt, json, os, sys, time, urllib.request

OUT = "stories/tech-selloff/data"
UA_BROWSER = "Mozilla/5.0 (market-viz data pipeline)"
UA_SEC = os.environ.get("SEC_USER_AGENT", "market-viz research contact@example.com")  # SEC asks for a contact UA
log_lines = []


def log(msg):
    print(msg)
    log_lines.append(msg)


def get(url, ua=UA_BROWSER, as_json=True, tries=4):
    req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept": "*/*"})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read()
            log(f"GET {url} -> {len(body)} bytes")
            return json.loads(body) if as_json else body.decode()
        except Exception as e:  # noqa: BLE001
            log(f"GET {url} failed (attempt {attempt + 1}): {e}")
            time.sleep(5 * 2 ** attempt)  # Yahoo answers 429 when hit too fast
    return None


def yahoo_daily(symbol, start):
    p1 = int(dt.datetime.combine(start, dt.time()).replace(tzinfo=dt.timezone.utc).timestamp())
    p2 = int(time.time()) + 86400
    sym = urllib.request.quote(symbol)
    data = get(f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?period1={p1}&period2={p2}&interval=1d&events=split")
    try:
        res = data["chart"]["result"][0]
        tz = dt.timezone(dt.timedelta(seconds=res["meta"]["gmtoffset"]))
        closes = res["indicators"]["quote"][0]["close"]
        out = {}
        for ts, c in zip(res["timestamp"], closes):
            if c is not None:
                out[dt.datetime.fromtimestamp(ts, tz).date()] = round(c, 2)
        splits = [(dt.datetime.fromtimestamp(v["date"], tz).date(), v["numerator"], v["denominator"])
                  for v in res.get("events", {}).get("splits", {}).values()]
        yahoo_daily.splits[symbol] = sorted(splits)
        return out
    except Exception as e:  # noqa: BLE001
        log(f"Yahoo parse failed for {symbol}: {e}")
        return {}


yahoo_daily.splits = {}


def fred_ndx():
    body = get("https://fred.stlouisfed.org/graph/fredgraph.csv?id=NASDAQ100&cosd=2025-12-01", ua=UA_SEC, as_json=False, tries=6)  # FRED drops browser-style UAs
    out = {}
    if body:
        for row in list(csv.reader(body.splitlines()))[1:]:
            if len(row) == 2 and row[1] not in (".", ""):
                out[dt.date.fromisoformat(row[0])] = float(row[1])
    return out


QQQ_CIK = 1067839  # Invesco QQQ Trust, Series 1: tracks the Nasdaq-100 and files N-PORT holdings with the SEC


def nasdaq100_members():
    """Nasdaq-100 members from the latest public N-PORT filing of the Invesco QQQ Trust.

    api.nasdaq.com is not reachable from the pipeline's environment, so membership comes from SEC
    EDGAR instead. N-PORT lists CUSIPs, not tickers; OpenFIGI's public mapping API turns each CUSIP
    into its US ticker. Returns (members, as_of_date, accession).
    """
    import xml.etree.ElementTree as ET
    sub = get(f"https://data.sec.gov/submissions/CIK{QQQ_CIK:010d}.json", ua=UA_SEC)
    try:
        r = sub["filings"]["recent"]
        i = next(k for k, f in enumerate(r["form"]) if f == "NPORT-P")
        acc, asof = r["accessionNumber"][i], r["reportDate"][i]
    except Exception as e:  # noqa: BLE001
        log(f"QQQ N-PORT lookup failed: {e}")
        return [], None, None
    xml = get(f"https://www.sec.gov/Archives/edgar/data/{QQQ_CIK}/{acc.replace('-', '')}/primary_doc.xml",
              ua=UA_SEC, as_json=False)
    if not xml:
        return [], None, None
    root = ET.fromstring(xml)
    ns = {"n": root.tag.split("}")[0].strip("{")}
    holdings = []
    for sec in root.findall(".//n:invstOrSec", ns):
        if sec.findtext("n:assetCat", namespaces=ns) != "EC":
            continue
        isin = sec.find(".//n:isin", ns)
        holdings.append((sec.findtext("n:cusip", namespaces=ns), sec.findtext("n:title", namespaces=ns),
                         isin.attrib["value"] if isin is not None else None))
    log(f"QQQ N-PORT {acc} (holdings as of {asof}): {len(holdings)} equity lines")
    def figi(jobs):
        body = json.dumps(jobs).encode()
        req = urllib.request.Request("https://api.openfigi.com/v3/mapping", data=body,
                                     headers={"Content-Type": "application/json", "User-Agent": UA_BROWSER})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                res = json.loads(resp.read())
            log(f"POST openfigi mapping ({len(jobs)} ids) -> ok")
        except Exception as e:  # noqa: BLE001
            log(f"POST openfigi mapping failed: {e}")
            res = [{}] * len(jobs)
        time.sleep(2.5)  # 25 requests/minute limit without a key
        return [(m.get("data") or [{}])[0].get("ticker") for m in res]

    members, unmatched, delisted = [], [], []
    for k in range(0, len(holdings), 10):  # 10 jobs per request without a key
        batch = holdings[k:k + 10]
        tick = figi([{"idType": "ID_CUSIP", "idValue": c, "exchCode": "US"} for c, _, _ in batch])
        for (cusip, title, isin), t in zip(batch, tick):
            if t:
                members.append((t.replace("/", "."), title, cusip))
            else:
                unmatched.append((cusip, title, isin))
    retry = [u for u in unmatched if u[2]]
    for k in range(0, len(retry), 10):  # second pass by ISIN (foreign issuers, odd CUSIPs)
        batch = retry[k:k + 10]
        tick = figi([{"idType": "ID_ISIN", "idValue": i, "exchCode": "US"} for _, _, i in batch])
        for (cusip, title, isin), t in zip(batch, tick):
            if t:
                members.append((t.replace("/", "."), title, cusip))
                log(f"Matched {title} by ISIN {isin} -> {t}")
            else:
                log(f"No US ticker for {title} (CUSIP {cusip}, ISIN {isin}); no longer listed in the US")
                delisted.append(title)
    for cusip, title, isin in unmatched:
        if not isin:
            log(f"No US ticker for {title} (CUSIP {cusip}, no ISIN)")
            delisted.append(title)
    nasdaq100_members.delisted = delisted
    return members, asof, acc


# Nasdaq-100 changes announced after the N-PORT holdings date. Each one is applied only if it took effect
# after that date and on or before the peak close, so the member list matches the index on the peak day.
MEMBERSHIP_CHANGES = [
    {"date": "2026-07-07", "add": ("SPCX", "Space Exploration Technologies Corp."), "remove": None,
     "source": "https://ir.nasdaq.com/news-releases/news-release-details/space-exploration-technologies-corporation-join-nasdaq-100"},
    {"date": "2026-08-04", "add": None, "remove": "EA", "remove_name": "Electronic Arts Inc.",
     "source": "https://www.marketscreener.com/news/electronic-arts-inc-nasdaqgm-ea-dropped-from-nasdaq-100-index-ce7f50ddd889f622"},
    {"date": "2026-10-09", "add": ("MRNA", "Moderna, Inc."), "remove": "WBD", "remove_name": "Warner Bros. Discovery, Inc.",
     "source": "https://ir.nasdaq.com/news-releases/news-release-details/moderna-inc-join-nasdaq-100-indexr-beginning-october-9-2026"},
]

COVER_FORMS = ("10-Q", "10-K", "20-F", "40-F")


def cover_shares(cik):
    """Sum every dei:EntityCommonStockSharesOutstanding fact on the cover of the latest 10-Q/10-K/20-F/40-F.

    SEC's companyfacts API drops facts that carry a share-class dimension, so companies with more than
    one class (Alphabet, Meta, Comcast...) show no current value there. The cover page of the filing
    itself tags each class, so this reads the inline XBRL directly.
    """
    import re
    sub = get(f"https://data.sec.gov/submissions/CIK{cik:010d}.json", ua=UA_SEC)
    try:
        r = sub["filings"]["recent"]
        i = next(k for k, f in enumerate(r["form"]) if f in COVER_FORMS)
    except Exception:  # noqa: BLE001
        return None, None, "no 10-Q/10-K/20-F/40-F on file"
    acc, doc, form, filed = r["accessionNumber"][i], r["primaryDocument"][i], r["form"][i], r["filingDate"][i]
    html = get(f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc.replace('-', '')}/{doc}", ua=UA_SEC, as_json=False)
    if not html:
        return None, None, f"could not read {form} {acc}"
    vals = {}
    for m in re.finditer(r'<ix:nonFraction([^>]*name="dei:EntityCommonStockSharesOutstanding"[^>]*)>(.*?)</ix:nonFraction>',
                         html, re.S | re.I):
        attrs, inner = m.group(1), re.sub(r"<[^>]+>", "", m.group(2)).strip()
        ctx = re.search(r'contextRef="([^"]+)"', attrs).group(1)
        # Combined filings (Exelon, AEP...) also tag each subsidiary registrant's shares, which the parent
        # owns. Those facts carry dei:LegalEntityAxis; keep only the parent's.
        cdef = re.search(r'<xbrli:context id="' + re.escape(ctx) + r'">(.*?)</xbrli:context>', html, re.S)
        if cdef and "dei:LegalEntityAxis" in cdef.group(1):
            continue
        scale = int((re.search(r'scale="(-?\d+)"', attrs) or [None, "0"])[1])
        fmt = (re.search(r'format="([^"]+)"', attrs) or [None, ""])[1]
        digits = re.sub(r"[^0-9.,]", "", inner)
        if "numcommadecimal" in fmt.replace("-", ""):
            digits = digits.replace(".", "").replace(",", ".")
        else:
            digits = digits.replace(",", "")
        if not digits or "zerodash" in fmt:
            continue
        vals[ctx] = round(float(digits) * 10 ** scale)
    if not vals:
        return None, None, f"no tagged share count on the cover of {form} {acc}"
    total, note = sum(vals.values()), f"{len(vals)} class(es) on the cover of {form} filed {filed} ({acc})"
    if form == "20-F":  # Yahoo quotes the US depositary share, which can stand for several ordinary shares
        import html as htmllib
        text = htmllib.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html[:400000])))[:60000]
        m = re.search(r"[Dd]epositary [Ss]hares?.{0,120}?represent\w* (\w+)", text)
        words = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "eight": 8, "ten": 10}
        if m:
            ratio = words.get(m.group(1).lower()) or (int(m.group(1)) if m.group(1).isdigit() else None)
            if not ratio:
                return None, None, f"could not read the ADS ratio on {form} {acc}: '{m.group(0)}'"
            total = round(total / ratio)
            note += f"; divided by {ratio} ordinary shares per ADS ('{m.group(0)}')"
    return total, filed, note


def sec_shares(cik):
    """Latest dei:EntityCommonStockSharesOutstanding, summed across share classes on the same filing."""
    data = get(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json", ua=UA_SEC)
    try:
        facts = data["facts"]["dei"]["EntityCommonStockSharesOutstanding"]["units"]["shares"]
    except Exception:  # noqa: BLE001
        return None, None, "no dei:EntityCommonStockSharesOutstanding"
    latest_filed = max(f["filed"] for f in facts)
    rows = [f for f in facts if f["filed"] == latest_filed]
    by_class = {}
    for f in rows:  # one fact per class (frames differ); dedupe identical values per end date
        by_class[(f.get("frame"), f["val"])] = f
    total = sum(f["val"] for f in by_class.values())
    asof = max(f["end"] for f in rows)
    return total, asof, f"{len(by_class)} class value(s) from filing {latest_filed}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2026-01-01")
    args = ap.parse_args()
    start = dt.date.fromisoformat(args.start)
    os.makedirs(OUT, exist_ok=True)
    gaps = []

    # 1. Index closes, with FRED as an independent cross-check.
    ndx = yahoo_daily("^NDX", start)
    if not ndx:
        sys.exit("Could not fetch ^NDX from Yahoo; leaving existing files untouched. See build_log.txt.")
    fred = fred_ndx()
    overlap = [d for d in ndx if d in fred]
    fred_note = "FRED could not be reached on this run, so the closes were not cross-checked."
    if overlap:
        worst = max(overlap, key=lambda d: abs(ndx[d] - fred[d]))
        diff = abs(ndx[worst] - fred[worst])
        log(f"Cross-check vs FRED NASDAQ100: {len(overlap)} common days, largest gap {diff:.2f} on {worst}")
        missing_fred = [d for d in ndx if d not in fred]
        fred_note = (f"On the {len(overlap)} days both sources cover, the largest difference is {diff:.2f} points ({worst}). "
                     f"FRED's series ends on {max(fred)}" + (f", so {', '.join(map(str, missing_fred[-3:]))} could not be checked." if missing_fred else "."))
        bad = [d for d in overlap if abs(ndx[d] - fred[d]) > 0.5]
        if bad:
            gaps.append(f"Yahoo and FRED disagree by more than 0.5 points on {len(bad)} day(s): {', '.join(map(str, bad[:5]))}.")
    else:
        log("FRED cross-check unavailable")
        gaps.append("Index closes could not be cross-checked against FRED.")
    with open(f"{OUT}/ndx_close.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "close", "source"])
        for d in sorted(ndx):
            w.writerow([d.isoformat(), f"{ndx[d]:.2f}", "yahoo_finance_chart_api"])
    days = sorted(ndx)
    peak_day = max(days, key=lambda d: ndx[d])
    last_day = days[-1]
    log(f"Peak close {ndx[peak_day]} on {peak_day}; latest {ndx[last_day]} on {last_day}")

    # 2. Members, shares, and market value at the peak and latest close.
    members, members_asof, members_acc = nasdaq100_members()
    n_nport = len(members)
    changes_used = []
    for ch in MEMBERSHIP_CHANGES:
        if members_asof and members_asof < ch["date"] <= peak_day.isoformat():
            if ch["remove"]:
                members = [m for m in members if m[0] != ch["remove"]]
            if ch["add"]:
                members.append((ch["add"][0], ch["add"][1], None))
            changes_used.append(ch)
            log(f"Applied index change effective {ch['date']}: +{ch['add'] and ch['add'][0]} -{ch['remove']} ({ch['source']})")
        else:
            log(f"Not applied (outside {members_asof}..{peak_day}): change effective {ch['date']} +{ch['add'] and ch['add'][0]} -{ch['remove']}")
            if members_asof and ch["date"] > peak_day.isoformat():
                gaps.append(f"Index change after the peak not reflected (the member list is the one in force on {peak_day}): "
                            f"{ch['add'][0] if ch['add'] else 'nothing'} replaced {ch['remove'] or 'nothing'} on {ch['date']}.")
    removed_before_peak = {ch.get("remove_name") for ch in changes_used}
    for title in getattr(nasdaq100_members, "delisted", []):
        if title in removed_before_peak:
            log(f"{title}: left the index before the peak, so its missing listing doesn't matter")
            continue
        gaps.append(f"{title} was in the N-PORT holdings but no longer has a US listing, so it has no latest close and is left out.")
    tickers_json = get("https://www.sec.gov/files/company_tickers.json", ua=UA_SEC) or {}
    cik_of = {v["ticker"].upper().replace("-", "."): int(v["cik_str"]) for v in tickers_json.values()}
    rows, seen_cik, missing, daily, split_notes, stale = [], set(), [], [], [], []
    for sym, name, _cusip in members:
        cik = cik_of.get(sym.upper().replace("-", "."))
        if cik is None:
            missing.append(f"{sym} (no SEC CIK; likely a foreign filer)")
            continue
        if cik in seen_cik:
            log(f"{sym}: same company as an earlier ticker (CIK {cik}); counted once")
            continue
        px = yahoo_daily(sym, start)
        if peak_day not in px or last_day not in px:
            missing.append(f"{sym} (no close on {peak_day} or {last_day})")
            continue
        shares, asof, note = cover_shares(cik)
        cf_shares, cf_asof, _ = sec_shares(cik)
        if shares and cf_shares and cf_asof and cf_asof >= str(dt.date.today() - dt.timedelta(days=200)):
            gap = abs(shares - cf_shares) / shares
            if gap > 0.05:
                log(f"{sym}: cover total {shares:,} vs companyfacts {cf_shares:,} ({gap:.0%} apart); using cover")
        if not shares:
            missing.append(f"{sym} ({note})")
            continue
        # Yahoo's closes are adjusted for every split, so a split after the share count was taken
        # means the filed count must be scaled up to match the prices.
        for sp_date, num, den in yahoo_daily.splits.get(sym, []):
            if sp_date.isoformat() > asof and num and den:
                shares = round(shares * num / den)
                note += f"; scaled {num}:{den} for the split on {sp_date}, after this filing"
                split_notes.append(f"{sym} ({num}-for-{den} on {sp_date})")
        if asof < (last_day - dt.timedelta(days=150)).isoformat():
            stale.append(f"{sym} ({asof})")
        seen_cik.add(cik)
        log(f"{sym}: shares {shares:,} as of {asof} [{note}]")
        for d in days:
            if peak_day <= d <= last_day and d in px:
                daily.append([sym, d.isoformat(), px[d], round(px[d] * shares)])
        rows.append([sym, name, cik, shares, asof, px[peak_day], px[last_day],
                     round(px[peak_day] * shares), round(px[last_day] * shares)])
        time.sleep(0.6)  # stay well under SEC's 10 requests/second and Yahoo's rate limit
    if stale:
        gaps.append("Share counts more than 150 days old, because these companies file annual reports only "
                    "(20-F/40-F) or have no newer filing; issuance or buybacks since then are not captured: "
                    + ", ".join(stale) + ".")
    if missing:
        gaps.append(f"{len(missing)} member(s) left out of the market-value steps: " + "; ".join(missing) + ".")
    if rows:
        with open(f"{OUT}/constituent_mcap.csv", "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["ticker", "name", "cik", "shares", "shares_filed", "close_peak", "close_latest", "mcap_peak", "mcap_latest"])
            w.writerows(rows)
        # Daily closes from the peak to the latest day, with market value at today's share count.
        with open(f"{OUT}/constituent_daily.csv", "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["ticker", "date", "close", "mcap"])
            w.writerows(daily)

    meta = {
        "ndx_source_note": f"Pulled from the Yahoo Finance chart API on {dt.date.today()}, {len(days)} trading days.",
        "fred_note": fred_note,
        "peak_date": peak_day.isoformat(), "latest_date": last_day.isoformat(),
        "members_note": (f"Members start from the {n_nport} US-listed stock lines in the Invesco QQQ Trust's N-PORT filing "
                         f"{members_acc} (holdings as of {members_asof}), tickers matched by CUSIP or ISIN through OpenFIGI, "
                         f"then adjusted for the index changes listed below that took effect by the peak on {peak_day}. "
                         f"Share counts are the sum of every class tagged on the cover of each company's latest 10-Q, 10-K, "
                         f"20-F or 40-F (20-F counts converted to US depositary shares where the cover gives a ratio).")
                        if members else "Member list unavailable.",
        "membership_changes": changes_used,
        "split_adjustments": split_notes,
        "gaps": " ".join(gaps) if gaps else "Nothing outstanding.",
    }
    with open(f"{OUT}/meta.json", "w") as f:
        json.dump(meta, f, indent=2)
    with open(f"{OUT}/build_log.txt", "w") as f:
        f.write("\n".join(log_lines) + "\n")


if __name__ == "__main__":
    main()
