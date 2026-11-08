"""Build data for the Uber story: what riders and eaters spend, what Uber keeps, and how the mix shifted.

Sources
  * Uber's quarterly earnings releases (SEC Form 8-K, Exhibit 99.1), Q2 2019 to Q3 2026, and the S-1/A of
    April 26, 2019. www.sec.gov refuses scripted downloads from this environment, so the tables were read
    page by page and copied into data/raw/releases_transcribed.csv and data/raw/releases_compact.txt, one line
    per table per quarter column, each line naming its source file. Nothing in those files is computed.
  * SEC EDGAR XBRL company facts (data.sec.gov) for Uber's total quarterly revenue, used only as a check.

Checks (all written to build_log.txt; the build stops if any fails)
  1. Inside every table, the segments add up to the printed total.
  2. Every quarter appears in two releases (its own and the next year's). Where both print the same table,
     the numbers must match, unless the later release is a known restatement (see RESTATED).
  3. Total revenue for each quarter matches SEC's XBRL figure where XBRL has a discrete quarter.

Choices
  * Where a later release restated a quarter, the later (restated) figure is used.
  * Rides is Mobility and Eats is Delivery: Uber renamed the segments in Q2 2020.
  * Revenue for Q3 2018 to Q3 2019 is only available as first reported, before Uber's Q4 2020 change in how
    it presents payments to drivers; those quarters are flagged and not used for take rates.

Run from the site root:
    SEC_USER_AGENT="your name you@example.com" python3 pipeline/build_uber.py
"""
import csv, datetime as dt, json, os, sys, urllib.request
from collections import defaultdict

OUT = "stories/uber/data"
RAW = os.path.join(OUT, "raw")
CACHE = os.environ.get("UBER_CACHE", "/tmp/uber-cache")
os.makedirs(CACHE, exist_ok=True)
LOG = []
BASE = "https://www.sec.gov/Archives/edgar/data/1543151/"
ACCESSION = {  # source file -> accession folder, for the links on the page
    "uberq219earningspressrelea.htm": "000154315119000006", "uberq319earningspressr.htm": "000154315119000014",
    "uberq419earningspressrelea.htm": "000154315120000005", "uberq120earningspressr.htm": "000154315120000020",
    "uberq220earningspressr.htm": "000154315120000027", "uberq320earningspressr.htm": "000162828020015770",
    "uberq420earningspressrelea.htm": "000154315121000008", "uberq121earningspressrelea.htm": "000154315121000024",
    "uberq221earningspressrelea.htm": "000154315121000035", "uberq321earningspressrelea.htm": "000154315121000043",
    "uberq421earningspressrelea.htm": "000154315122000004", "uberq122earningspressrelea.htm": "000154315122000012",
    "uberq222earningspressrelea.htm": "000154315122000021", "uberq322earningspressrelea.htm": "000154315122000029",
    "uberq422earningspressrelea.htm": "000154315123000004", "uberq123earningspressrelea.htm": "000154315123000013",
    "uberq223earningspressrelea.htm": "000154315123000021", "uberq323earningspressrelea.htm": "000154315123000036",
    "uberq423earningspressrelea.htm": "000154315124000008", "uberq124earningspressrelea.htm": "000154315124000017",
    "uberq224earningspressrelea.htm": "000154315124000024", "uberq324earningspressrelea.htm": "000154315124000033",
    "uberq424earningspressrelea.htm": "000154315125000004", "uberq125earningspressrelea.htm": "000154315125000012",
    "uberq225earningspressrelea.htm": "000154315125000020", "uberq325earningspressrelea.htm": "000154315125000030",
    "uberq425earningspressrelea.htm": "000154315126000011", "uberq126earningspressrelea.htm": "000154315126000019",
    "uberq226earningspressrelea.htm": "000154315126000027", "uberq326earningspressrelea.htm": "000154315126000039",
    "d647752ds1a.htm": "000119312519120759",
    "fy2019q410kfinancialst.htm": "000154315120000010", "uber-20211231.htm": "000154315122000008",
    "uber-20231231.htm": "000154315124000012", "uber-20251231.htm": "000154315126000015",
}
# Quarters whose revenue a later release restated. Value = why.
RESTATED = {
    ("2019Q4", "rev"): "Q4 2020 release recast 2019 revenue (change in presenting cumulative payments to drivers).",
    ("2020Q1", "rev"): "Q1 2021 release recast 2020 revenue for the same policy change.",
    ("2020Q2", "rev"): "Q2 2021 release recast 2020 revenue for the same policy change.",
    ("2020Q3", "rev"): "Q3 2021 release recast 2020 revenue for the same policy change.",
    ("2020Q1", "trips"): "Releases differ: Q1 2021 prints 1,661 million trips for Q1 2020, Q1 2020 printed 1,658. Later used.",
    ("2020Q3", "trips"): "Releases differ: Q3 2021 prints 1,184 million trips for Q3 2020, Q3 2020 printed 1,150. Later used.",
    ("2019Q4", "geo_rev"): "Regional revenue recast with total revenue.",
}
FIELDS = {"gb": ["Mobility", "Delivery", "Freight", "Total"], "rev": ["Mobility", "Delivery", "Freight", "Total"],
          "rev_orig": ["Mobility", "Delivery", "Freight", "Total"],
          "seg_ebitda": ["Mobility", "Delivery", "Freight", "Corporate", "Total"],
          "seg_oi": ["Mobility", "Delivery", "Freight", "Corporate", "Total"],
          "geo_rev": ["USCAN", "LatAm", "EMEA", "APAC", "Total"],
          "trips": ["Total"], "mapcs": ["Total"], "gb_total": ["Total"], "gb_rides_eats": ["Mobility", "Delivery"]}
LONG_TABLES = {"gross_bookings": "gb", "revenue": "rev", "segment_operating_income": "seg_oi",
               "adjusted_ebitda_total": None, "trips": "trips", "mapcs": "mapcs"}


def log(msg):
    print(msg)
    LOG.append(msg)


def qkey(p):
    return int(p[:4]) * 4 + int(p[5]) - 1


def release_quarter(src):
    """The quarter a release reports on, from its file name (uberq326... -> 2026Q3)."""
    if src.startswith("d647752"):
        return "2019Q1"
    q, yy = src[5], src[6:8]
    return f"20{yy}Q{q}"


def read_raw():
    rows = []  # (src, period, table, [values])
    with open(os.path.join(RAW, "releases_compact.txt")) as f:
        for line in f:
            if not line.strip() or line.startswith("#"):
                continue
            src, period, table, *vals = line.split()
            assert table in FIELDS and len(vals) == len(FIELDS[table]), line
            rows.append((src, period, table, [int(v) for v in vals]))
    # the long-format file (Q1-Q3 2026 releases)
    grouped = defaultdict(dict)
    with open(os.path.join(RAW, "releases_transcribed.csv")) as f:
        for r in csv.DictReader(f):
            t = LONG_TABLES.get(r["table"])
            if not t:
                continue
            label = r["row"].split(" (")[0]
            label = {"Corporate G&A and Platform R&D": "Corporate", "Non-GAAP Operating Income": "Total",
                     "Trips": "Total", "MAPCs": "Total"}.get(label, label)
            grouped[(r["source_file"], r["period"], t)][label] = int(r["value"])
    for (src, period, t), d in grouped.items():
        rows.append((src, period, t, [d[k] for k in FIELDS[t]]))
    return rows


def check_sums(rows):
    bad = 0
    for src, period, table, vals in rows:
        if table in ("trips", "mapcs", "gb_total", "gb_rides_eats"):
            continue
        parts, total = vals[:-1], vals[-1]
        if sum(parts) != total:
            # Before Q4 2020 the segment tables also had small "Other Bets"/"ATG" rows that are not kept here.
            gap = total - sum(parts)
            if release_quarter(src) <= "2022Q1" and table in ("gb", "rev", "rev_orig", "seg_ebitda"):
                log(f"  note {src} {period} {table}: segments shown sum to {sum(parts)}, total {total}; "
                    f"gap {gap} is the small 'Other Bets'/'ATG'/'All Other' rows")
                continue
            log(f"FAIL sum {src} {period} {table}: {parts} -> {sum(parts)} != {total}")
            bad += 1
    log(f"check 1 (segments add to totals): {'ok' if not bad else str(bad) + ' failures'}")
    return bad


def merge(rows):
    """For each (period, table), keep the figure from the latest release; check earlier copies agree."""
    by = defaultdict(list)
    for src, period, table, vals in rows:
        t = "rev" if table == "rev_orig" else table
        by[(period, t)].append((release_quarter(src), src, table, vals))
    out, bad = {}, 0
    for key, copies in sorted(by.items()):
        copies.sort()
        latest = copies[-1]
        for c in copies[:-1]:
            if c[3] != latest[3] and c[2] == latest[2]:
                if key in RESTATED:
                    log(f"  restated {key}: {c[1]} {c[3]} -> {latest[1]} {latest[3]} ({RESTATED[key]})")
                else:
                    log(f"FAIL mismatch {key}: {c[1]} {c[3]} vs {latest[1]} {latest[3]}")
                    bad += 1
            elif c[2] != latest[2]:
                log(f"  {key}: {c[1]} has first-reported revenue {c[3]}; later restated to {latest[3]} by {latest[1]}")
        out[key] = {"src": latest[1], "orig": latest[2] == "rev_orig", "vals": latest[3],
                    "n_sources": len({c[1] for c in copies})}
    log(f"check 2 (overlapping releases agree): {'ok' if not bad else str(bad) + ' failures'}")
    return out, bad


def sec_revenue():
    """Discrete-quarter total revenue from SEC XBRL company facts (frames like CY2024Q3)."""
    p = os.path.join(CACHE, "CIK0001543151.json")
    if not os.path.exists(p):
        ua = os.environ.get("SEC_USER_AGENT")
        if not ua:
            sys.exit("Set SEC_USER_AGENT (name and contact email, as SEC asks) or put the file at " + p)
        req = urllib.request.Request("https://data.sec.gov/api/xbrl/companyfacts/CIK0001543151.json",
                                     headers={"User-Agent": ua})
        with urllib.request.urlopen(req, timeout=60) as r, open(p, "wb") as f:
            f.write(r.read())
    facts = json.load(open(p))["facts"]["us-gaap"]
    q = {}
    for x in facts["Revenues"]["units"]["USD"]:
        fr = x.get("frame", "")
        if len(fr) == 8 and fr[6] == "Q":
            q[fr[2:6] + fr[6:]] = round(x["val"] / 1e6)
    annual = {}
    for x in facts["Revenues"]["units"]["USD"]:
        fr = x.get("frame", "")
        if len(fr) == 6:
            annual[fr[2:]] = round(x["val"] / 1e6)
    return q, annual


def main():
    rows = read_raw()
    log(f"Built {dt.datetime.now(dt.timezone.utc):%Y-%m-%d %H:%M} UTC from {len(rows)} transcribed table-columns "
        f"in {len({r[0] for r in rows})} documents")
    bad = check_sums(rows)
    merged, bad2 = merge(rows)
    bad += bad2
    xq, xa = sec_revenue()
    n = 0
    for (period, t), d in sorted(merged.items()):
        if t == "rev" and period in xq:
            n += 1
            if d["vals"][-1] != xq[period]:
                if d["orig"]:
                    log(f"  {period} revenue {d['vals'][-1]} (first reported) vs XBRL {xq[period]} (restated) - expected")
                else:
                    log(f"FAIL {period} revenue {d['vals'][-1]} vs XBRL {xq[period]}")
                    bad += 1
    log(f"check 3 (revenue vs SEC XBRL, {n} quarters with discrete XBRL values): {'ok' if not bad else 'see above'}")
    # Annual check for quarters XBRL only has as Q4-inclusive years: sum four quarters vs the 10-K year.
    for y in range(2020, 2026):
        qs = [merged.get((f"{y}Q{i}", "rev")) for i in range(1, 5)]
        if all(qs) and not any(q["orig"] for q in qs):
            s = sum(q["vals"][-1] for q in qs)
            ok = s == xa.get(str(y))
            log(f"  {y}: four quarters sum to {s}, 10-K says {xa.get(str(y))} {'ok' if ok else 'MISMATCH'}")
            if not ok:
                bad += 1
    if bad:
        sys.exit(f"{bad} checks failed; see log")

    periods = sorted({p for p, _ in merged}, key=qkey)
    cols = ["period", "gb_mobility", "gb_delivery", "gb_freight", "gb_total",
            "rev_mobility", "rev_delivery", "rev_freight", "rev_total", "rev_first_reported",
            "ebitda_mobility", "ebitda_delivery", "ebitda_freight", "ebitda_corporate", "ebitda_total",
            "oi_mobility", "oi_delivery", "oi_freight", "oi_corporate", "oi_total",
            "rev_uscan", "rev_latam", "rev_emea", "rev_apac", "trips_m", "mapcs_m", "sources"]
    table = []
    for p in periods:
        r = {c: "" for c in cols}
        r["period"] = p
        srcs = set()

        def put(t, names):
            d = merged.get((p, t))
            if d:
                srcs.add(d["src"])
                for k, v in zip(names, d["vals"]):
                    if k:
                        r[k] = v
            return d
        put("gb", ["gb_mobility", "gb_delivery", "gb_freight", "gb_total"])
        put("gb_total", ["gb_total"])
        put("gb_rides_eats", ["gb_mobility", "gb_delivery"])
        d = put("rev", ["rev_mobility", "rev_delivery", "rev_freight", "rev_total"])
        if d:
            r["rev_first_reported"] = int(d["orig"])
        put("seg_ebitda", ["ebitda_mobility", "ebitda_delivery", "ebitda_freight", "ebitda_corporate", "ebitda_total"])
        put("seg_oi", ["oi_mobility", "oi_delivery", "oi_freight", "oi_corporate", "oi_total"])
        put("geo_rev", ["rev_uscan", "rev_latam", "rev_emea", "rev_apac", None])
        put("trips", ["trips_m"])
        put("mapcs", ["mapcs_m"])
        r["sources"] = " ".join(sorted(srcs))
        table.append(r)
    with open(os.path.join(OUT, "quarters.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(table)
    geo = list(csv.DictReader(open(os.path.join(RAW, "geo_quotes.csv"))))
    meta = {
        "built": f"{dt.datetime.now(dt.timezone.utc):%Y-%m-%d %H:%M} UTC",
        "first": periods[0], "last": periods[-1],
        "documents": {k: BASE + v + "/" + k for k, v in ACCESSION.items()},
        "xbrl": "https://data.sec.gov/api/xbrl/companyfacts/CIK0001543151.json",
        "restated": {f"{p} {t}": why for (p, t), why in RESTATED.items()},
        "geo_quotes": geo,
    }
    json.dump(meta, open(os.path.join(OUT, "meta.json"), "w"), indent=1)
    open(os.path.join(OUT, "build_log.txt"), "w").write("\n".join(LOG) + "\n")
    print(f"wrote {len(table)} quarters")


if __name__ == "__main__":
    main()
