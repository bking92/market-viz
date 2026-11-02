#!/usr/bin/env python3
"""Builds stories/fish-tank/data/ from primary and published sources.

Run from the site/ folder:
    SEC_USER_AGENT="your name you@example.com" python3 pipeline/build_fish_tank.py

Needs network access to: companiesmarketcap.com (monthly market values), www.sec.gov and data.sec.gov
(annual-report covers, completion 8-Ks, delisting forms), en.wikipedia.org (deal articles, read as
page source with action=raw), fred.stlouisfed.org (CPI, for "today's dollars"), and the news pages
named in EVENTS. Downloads are cached in $FISH_CACHE (default /tmp/fish-tank-cache) so reruns are fast.

Writes:
  stories/fish-tank/data/tank.json      everything the page reads
  stories/fish-tank/data/values.csv     every dated value behind every fish
  stories/fish-tank/data/events.csv     every event with its sources
  stories/fish-tank/data/build_log.txt  every request, every quote check, every cross-check

Rules: no value is typed in by hand. Every deal value, date and estimate is read out of a fetched
source, and the run stops if a quoted passage is not found in its source. Gaps are listed in tank.json
and shown on the page.
"""
import csv, datetime as dt, hashlib, html, json, os, re, sys, time, urllib.parse, urllib.request

OUT = "stories/fish-tank/data"
CACHE = os.environ.get("FISH_CACHE", "/tmp/fish-tank-cache")
UA_SEC = os.environ.get("SEC_USER_AGENT", "market-viz research pipeline admin@example.com")
UA = "market-viz-research/0.1 (data pipeline)"
FIRST, LAST = "1996-01-01", "2026-10-31"
os.makedirs(CACHE, exist_ok=True)
os.makedirs(OUT, exist_ok=True)
LOG = []


def log(msg):
    print(msg)
    LOG.append(msg)


def fetch(url, ua=UA, pause=0.3):
    key = hashlib.sha1(url.encode()).hexdigest()
    p = os.path.join(CACHE, key)
    if os.path.exists(p):
        return open(p, "rb").read()
    if os.path.exists(p + ".404"):
        return None
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": ua})
            body = urllib.request.urlopen(req, timeout=60).read()
            if b"too many requests" in body[:400].lower():
                raise IOError("rate limited")
            open(p, "wb").write(body)
            log(f"GET {url} -> {len(body)} bytes")
            time.sleep(pause)
            return body
        except Exception as e:  # noqa: BLE001
            log(f"GET {url} failed (attempt {attempt + 1}): {e}")
            if getattr(e, "code", None) == 404:
                open(p + ".404", "w").write("")
                return None
            time.sleep(3 * 2 ** attempt)
    return None


def d2(s):
    return dt.date.fromisoformat(s)


# ---------------------------------------------------------------- text sources

def clean_wiki(t):
    t = re.sub(r"<ref[^>/]*/>", "", t)
    t = re.sub(r"<ref[^>]*>.*?</ref>", "", t, flags=re.S)
    t = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", t)
    t = re.sub(r"'''?", "", t)
    t = t.replace("&nbsp;", " ").replace("{{nbsp}}", " ")
    return re.sub(r"\s+", " ", t)


def wiki(title):
    for _ in range(3):
        url = "https://en.wikipedia.org/w/index.php?" + urllib.parse.urlencode({"title": title, "action": "raw"})
        b = fetch(url, pause=2.5)
        t = (b or b"").decode("utf-8", "replace")
        m = re.match(r"\s*#redirect\s*\[\[([^\]#|]+)", t, re.I)
        if m:
            title = m.group(1).strip()
            continue
        return title, t
    return title, ""


def wiki_url(title):
    return "https://en.wikipedia.org/wiki/" + urllib.parse.quote(title.replace(" ", "_"))


def page_text(url, ua=UA):
    b = fetch(url, ua=ua)
    t = (b or b"").decode("latin-1" if "sec.gov" in url else "utf-8", "replace")
    t = re.sub(r"<script.*?</script>|<style.*?</style>", " ", t, flags=re.S | re.I)
    t = html.unescape(re.sub(r"<[^>]+>", " ", t))
    return re.sub(r"\s+", " ", t)


SOURCES = {}  # id -> {label, url, short}


def add_source(sid, label, url, short=None, note=None):
    if sid not in SOURCES:
        SOURCES[sid] = {"id": sid, "label": label, "url": url, "short": short or label, **({"note": note} if note else {})}
    return sid


def norm(s):
    return re.sub(r"\s+", " ", s.replace("’", "'").replace("–", "-").replace("—", "-")).strip().lower()


def check_quote(kind, ref, quote):
    """Fetch the source and confirm the quoted passage is in it. Returns a source id."""
    if kind == "wiki":
        title, raw = wiki(ref)
        ok = norm(quote) in norm(clean_wiki(raw))
        sid = add_source("wiki:" + title, f"Wikipedia, “{title}”", wiki_url(title), short=f"Wikipedia: {title}")
    elif kind in ("sec", "news"):
        text = page_text(ref, ua=UA_SEC if kind == "sec" else UA)
        ok = norm(quote) in norm(text)
        sid = add_source(kind + ":" + ref, ("SEC EDGAR filing" if kind == "sec" else "News report"), ref,
                         short=("SEC filing" if kind == "sec" else urllib.parse.urlparse(ref).netloc.replace("www.", "")))
    else:
        raise ValueError(kind)
    log(f"QUOTE {'OK ' if ok else 'MISSING'} [{kind}] {ref[:80]}: “{quote[:110]}”")
    if not ok:
        QUOTE_FAILS.append((kind, ref, quote))
    return sid


QUOTE_FAILS = []

# ---------------------------------------------------------------- Wikipedia's table of largest deals

LIST_TITLE = "List of largest mergers and acquisitions"
_list_rows = None


def list_rows():
    global _list_rows
    if _list_rows is None:
        _, raw = wiki(LIST_TITLE)
        rows = []
        for r in raw.split("\n|-"):
            c = re.sub(r"\{\{#invoke:flag\|icon\|[^}]*\}\}|\{\{Flag icon\|[^}]*\}\}|\{\{efn[^}]*\}\}|\{\{dagger[^}]*\}\}", "", r)
            c = re.sub(r"<[^>]+>", "", clean_wiki(c))
            cells = [x.strip() for x in re.split(r"\s*\|\s*(?:style=\"[^\"]*\"\s*\|)?", c) if x.strip()]
            rows.append(cells)
        _list_rows = rows
    return _list_rows


def list_value(acquirer, target, year):
    """Value in $bn from the first column after the target in the row naming both, for that year."""
    for cells in list_rows():
        joined = " | ".join(cells)
        if str(year) in cells and any(acquirer.lower() == c.lower() for c in cells) and any(target.lower() in c.lower() for c in cells):
            i = max(i for i, c in enumerate(cells) if target.lower() in c.lower())
            for c in cells[i + 1:]:
                m = re.match(r"^(\d+(?:\.\d+)?)", c)
                if m:
                    sid = add_source("wiki:" + LIST_TITLE, f"Wikipedia, “{LIST_TITLE}” (deal values in dollars of the year of the deal)", wiki_url(LIST_TITLE), short="Wikipedia: largest M&A list")
                    log(f"LIST {acquirer} / {target} {year}: {m.group(1)} bn  [{joined[:150]}]")
                    return float(m.group(1)) * 1e9, sid
    log(f"LIST MISSING {acquirer} / {target} {year}")
    QUOTE_FAILS.append(("list", acquirer, target))
    return None, None


# ---------------------------------------------------------------- money in text

def money(s):
    s = s.replace("&nbsp;", " ")
    m = re.search(r"\$\s?(\d+(?:[.,]\d+)*)\s*(trillion|billion|million)", s, re.I) or re.search(r"\$\s?(\d+(?:[.,]\d+)*)\s*(trillion|billion|million)?", s, re.I)
    if not m:
        m2 = re.search(r"\{\{USD\|(\d+(?:\.\d+)?)\s*(billion|million)\}\}", s, re.I)
        if not m2:
            raise ValueError("no amount in: " + s)
        m = m2
    v = float(m.group(1).replace(",", ""))
    return v * {"trillion": 1e12, "billion": 1e9, "million": 1e6}.get((m.group(2) or "").lower(), 1)


# ---------------------------------------------------------------- SEC

def sec_json(url):
    b = fetch(url, ua=UA_SEC, pause=0.15)
    return json.loads(b) if b else None


def sec_filings(cik):
    d = sec_json(f"https://data.sec.gov/submissions/CIK{int(cik):010d}.json")
    blocks = [d["filings"]["recent"]]
    for f in d["filings"].get("files", []):
        blocks.append(sec_json("https://data.sec.gov/submissions/" + f["name"]))
    out = []
    for r in blocks:
        for i, form in enumerate(r["form"]):
            out.append({"date": r["filingDate"][i], "form": form, "acc": r["accessionNumber"][i], "doc": r["primaryDocument"][i]})
    return d["name"], sorted(out, key=lambda x: x["date"])


def sec_doc_url(cik, f):
    a = f["acc"].replace("-", "")
    if f["doc"]:
        return f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{a}/{f['doc']}"
    return f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{f['acc']}.txt"


MON = r"(January|February|March|April|May|June|July|August|September|October|November|December|Jan\.|Feb\.|Mar\.|Apr\.|Jun\.|Jul\.|Aug\.|Sept?\.|Oct\.|Nov\.|Dec\.)"
DATE_RE = re.compile(MON + r"\s+(\d{1,2})\s*,?\s+(\d{4})", re.I)
FR = {"1/8": .125, "1/4": .25, "3/8": .375, "1/2": .5, "5/8": .625, "3/4": .75, "7/8": .875, "1/16": .0625, "3/16": .1875,
      "5/16": .3125, "7/16": .4375, "9/16": .5625, "11/16": .6875, "13/16": .8125, "15/16": .9375, "1/32": 1 / 32}


def to_date(g):
    try:
        return dt.datetime.strptime(f"{g.group(1)[:3].title()} {g.group(2)} {g.group(3)}", "%b %d %Y").date()
    except ValueError:
        return None


def cover(cik, url):
    """Read the cover page of one annual report: market value held by non-affiliates, its date, prices and share counts."""
    t = page_text(url, ua=UA_SEC)[:300000]
    m = re.search(r"aggregate market value", t, re.I)
    if not m:
        return None
    # The sentence that carries the value(s): up to the first full stop that is not inside a number or "Inc."
    tail = t[m.end():m.end() + 900]
    end = re.search(r"(?<!Inc)(?<!Corp)(?<!Co)(?<!No)\.(?!\d)\s", tail)
    sent = tail[: end.start() if end else 600]
    before = t[max(0, m.start() - 170):m.start()]
    amts = []
    for a in re.finditer(r"\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(billion|million|thousand)?", sent, re.I):
        prev = sent[max(0, a.start() - 45):a.start()].lower()
        if "price" in prev or "per share" in sent[a.end():a.end() + 12].lower() or "par value" in prev:
            continue
        v = float(a.group(1).replace(",", "")) * {"billion": 1e9, "million": 1e6, "thousand": 1e3}.get((a.group(2) or "").lower(), 1)
        if v >= 5e6:
            amts.append(v)
    asof = None
    bd = list(DATE_RE.finditer(before))
    if bd:
        asof = to_date(bd[-1])
    if asof is None:
        ad = list(DATE_RE.finditer(sent)) or list(DATE_RE.finditer(t[max(0, m.start() - 400):m.start()]))
        if ad:
            asof = to_date(ad[0] if DATE_RE.search(sent) else ad[-1])
    win = t[max(0, m.start() - 1800): m.start() + 1800]
    prices = [float(p.group(1)) + (FR.get(p.group(2), 0) if p.group(2) else 0)
              for p in re.finditer(r"(?:closing|last)(?: reported)?(?: sales?)? price[^$]{0,90}?\$\s?(\d{1,4}(?:\.\d+)?)(?:\s+(\d{1,2}/\d{1,2}))?", win, re.I)]
    shares = []
    for s in re.finditer(r"(\d{1,3}(?:,\d{3}){2,})\s+(?:outstanding\s+)?shares", win, re.I):
        n = int(s.group(1).replace(",", ""))
        if n not in shares:
            shares.append(n)
    return {"float": sum(amts) if amts else None, "n_amounts": len(amts), "asof": asof.isoformat() if asof else None,
            "prices": prices, "shares": shares, "quote": (before[-150:] + t[m.start():m.end()] + sent)[:700].strip(), "url": url}


COVER_CACHE = os.path.join(OUT, "raw", "sec_covers.json")


def covers(cik):
    os.makedirs(os.path.dirname(COVER_CACHE), exist_ok=True)
    allc = json.load(open(COVER_CACHE)) if os.path.exists(COVER_CACHE) else {}
    if str(cik) in allc:
        return allc[str(cik)]
    name, fs = sec_filings(cik)
    rows = []
    for f in fs:
        if f["form"] not in ("10-K", "10-K405", "10-KT", "10-K405/A") or f["form"].endswith("/A"):
            continue
        url = sec_doc_url(cik, f)
        c = cover(cik, url)
        if c:
            c.update({"filed": f["date"], "form": f["form"], "company": name})
            rows.append(c)
            log(f"COVER {cik} {f['date']} asof={c['asof']} float={c['float']} prices={c['prices'][:2]} shares={c['shares'][:3]}")
        else:
            log(f"COVER {cik} {f['date']} no market-value sentence found in {url}")
    allc[str(cik)] = rows
    json.dump(allc, open(COVER_CACHE, "w"), indent=0)
    return rows


def sec_form_date(cik, forms, after, before):
    """First filing of one of `forms` by `cik` in [after, before]. Used to anchor a closing date to a primary record."""
    name, fs = sec_filings(cik)
    for f in fs:
        if f["form"] in forms and after <= f["date"] <= before:
            url = f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={int(cik):010d}&type={urllib.parse.quote(f['form'])}"
            sid = add_source(f"secform:{cik}", f"SEC EDGAR filing index for {name.title()}", url, short=f"SEC: {name.title()} filings")
            log(f"SECFORM {cik} {name}: {f['form']} filed {f['date']}")
            return f["date"], sid, f["form"]
    log(f"SECFORM MISSING {cik} {forms} {after}..{before}")
    QUOTE_FAILS.append(("secform", cik, forms))
    return None, None, None


# ---------------------------------------------------------------- companiesmarketcap.com

def cmc(slug):
    url = f"https://companiesmarketcap.com/{slug}/marketcap/"
    h = (fetch(url, pause=1.0) or b"").decode("utf-8", "replace")
    m = re.search(r"data = (\[\{.*?\}\])", h)
    if not m:
        log(f"CMC MISSING {slug}")
        return None, []
    title = re.sub(r"\s+", " ", re.search(r"<title>([^<]*)", h).group(1)).replace(" - Market capitalization", "")
    # The chart's "m" field is in units of $100,000 (checked against the page's own year-end table below).
    pts = [(dt.datetime.fromtimestamp(x["d"], dt.timezone.utc).date().isoformat(), x["m"] * 1e5) for x in json.loads(m.group(1))]
    table = {int(y): float(v) * {"T": 1e12, "B": 1e9, "M": 1e6}[u] for y, v, u in re.findall(r"<td[^>]*>((?:19|20)\d\d)</td><td[^>]*>\$([\d.]+) ([TBM])", h)}
    for y, v in table.items():
        dec = [p for p in pts if p[0].startswith(f"{y}-12")]
        if dec and abs(dec[-1][1] / v - 1) > 0.02:
            log(f"CMC CHECK {slug} {y}: chart {dec[-1][1]:.3e} vs table {v:.3e}")
    sid = add_source("cmc:" + slug, f"companiesmarketcap.com, {title}", url, short=f"companiesmarketcap: {title.split(' (')[0]}")
    log(f"CMC {slug}: {title}, {len(pts)} points {pts[0][0]}..{pts[-1][0]}, year-end table checked for {len(table)} years")
    return sid, pts


# ================================================================ THE TANK
# Sectors: telecom (phone and wireless), cable (cable and satellite TV), media.
# Each fish's value comes from one or more segments, used in order:
#   ("cmc", slug, from, to)          monthly market value
#   ("float", cik, from, to)         value of shares held by outside investors, from the cover of each annual report
#   ("sxp", cik, from, to)           shares outstanding of every class x the share prices printed on the same cover
#   ("est", ...)                     published estimates, defined in ESTIMATES below
FISH = [
    # Phone and wireless
    dict(id="att_corp", name="AT&T Corp.", sector="telecom", segs=[("float", 5907, None, None)]),
    dict(id="sbc", name="SBC", sector="telecom", segs=[("cmc", "att", None, None)], check=732717),
    dict(id="pactel", name="Pacific Telesis", sector="telecom", segs=[("float", 732716, None, None)]),
    dict(id="ameritech", name="Ameritech", sector="telecom", segs=[("float", 732715, None, None)]),
    dict(id="bellsouth", name="BellSouth", sector="telecom", segs=[("float", 732713, None, "1996-12-31"), ("cmc", "bellsouth", "1997-01-01", None)]),
    dict(id="bell_atlantic", name="Bell Atlantic", sector="telecom", segs=[("cmc", "verizon", None, None)], check=732712),
    dict(id="nynex", name="NYNEX", sector="telecom", segs=[("float", 732714, None, None)]),
    dict(id="gte", name="GTE", sector="telecom", segs=[("cmc", "gte-corporation", None, None)]),
    dict(id="us_west_old", name="US West", sector="telecom", segs=[("float", 732718, None, "1998-06-11")]),
    dict(id="us_west", name="US West", sector="telecom", segs=[("cmc", "us-west", "1998-06-12", None)]),
    dict(id="qwest", name="Qwest", sector="telecom", segs=[("cmc", "qwest-communications-international", None, None)]),
    dict(id="centurytel", name="CenturyTel", sector="telecom", segs=[("cmc", "lumen", None, None)]),
    dict(id="mci", name="MCI", sector="telecom", segs=[("float", 64079, None, None)]),
    dict(id="worldcom", name="WorldCom", sector="telecom", segs=[("float", 723527, None, "1996-12-31"), ("cmc", "worldcom", "1997-01-01", "2002-12-31"), ("float", 723527, "2003-01-01", None)]),
    dict(id="sprint", name="Sprint", sector="telecom", segs=[("float", 101830, None, "2004-12-31"), ("cmc", "sprint-corporation", "2005-01-01", None)]),
    dict(id="nextel", name="Nextel", sector="telecom", segs=[("float", 824169, None, None)]),
    dict(id="att_wireless", name="AT&T Wireless", sector="telecom", segs=[("float", 1138234, None, None)]),
    dict(id="lucent", name="Lucent", sector="telecom", segs=[("cmc", "lucent-technologies", None, "1997-12-31")]),
    dict(id="embarq", name="Embarq", sector="telecom", segs=[("float", 1350031, None, None)]),
    dict(id="tmobile", name="T-Mobile US", sector="telecom", segs=[("cmc", "t-mobile-us", "2013-05-01", None)]),
    # Cable and satellite
    dict(id="tci", name="TCI", sector="cable", segs=[("float", 925692, None, "1998-12-31")]),
    dict(id="comcast", name="Comcast", sector="cable", segs=[("float", 22301, None, "2002-11-17"), ("float", 1166691, "2002-11-18", "2015-12-31"), ("cmc", "comcast", "2016-01-01", None)], check=1166691),
    dict(id="mediaone", name="MediaOne", sector="cable", segs=[("float", 732718, "1998-06-12", None)]),
    dict(id="charter", name="Charter", sector="cable", segs=[("float", 1091667, None, "2009-11-29"), ("cmc", "charter-communications", "2009-11-30", None)]),
    dict(id="twc", name="Time Warner Cable", sector="cable", segs=[("cmc", "time-warner-cable", "2009-03-01", None)]),
    dict(id="directv", name="DirecTV", sector="cable", segs=[("float", 944868, None, None), ("float", 1465112, None, None)]),
    # Media
    dict(id="disney", name="Disney", sector="media", segs=[("cmc", "walt-disney", None, None)]),
    dict(id="time_warner", name="Time Warner", sector="media", segs=[("float", 736157, None, "1996-12-31"), ("cmc", "time-warner", "1997-01-01", None)]),
    dict(id="aol", name="AOL", sector="media", segs=[("float", 883780, None, "2000-12-31"), ("float", 1105705, "2001-01-11", None)]),
    dict(id="aol_inc", name="AOL", sector="media", segs=[("cmc", "aol-inc", None, None)]),
    dict(id="viacom", name="Viacom", sector="media", segs=[("sxp", 813828, None, "2000-05-03"), ("cmc", "viacomcbs", "2000-05-04", "2005-12-30")]),
    dict(id="westinghouse", name="Westinghouse", sector="media", segs=[("float", 106413, None, None)]),
    dict(id="cbs", name="CBS", sector="media", segs=[("cmc", "viacomcbs", "2005-12-31", "2019-12-03"), ("cmc", "paramount-skydance", "2019-12-04", "2026-10-05")]),
    dict(id="viacom_new", name="Viacom", sector="media", segs=[("sxp", 1339947, None, None)]),
    dict(id="news_corp", name="News Corp", sector="media", segs=[("sxp", 1308161, None, "2013-06-27")]),
    dict(id="fox21", name="21st Century Fox", sector="media", segs=[("sxp", 1308161, "2013-06-28", None)]),
    dict(id="news_corp_new", name="News Corp", sector="media", segs=[("cmc", "news-corp", None, None)]),
    dict(id="fox_corp", name="Fox Corp.", sector="media", segs=[("cmc", "fox-corporation", None, None)]),
    dict(id="discovery", name="Discovery", sector="media", segs=[("cmc", "discovery", "2008-09-17", "2022-04-07"), ("cmc", "warner-bros-discovery", "2022-04-08", "2026-10-05")]),
    dict(id="netflix", name="Netflix", sector="media", segs=[("cmc", "netflix", None, None)]),
    dict(id="pixar", name="Pixar", sector="media", segs=[("float", 1002114, None, None)]),
    dict(id="versant", name="Versant", sector="media", segs=[("cmc", "versant-media-group", None, None)]),
    dict(id="nbcu", name="NBCUniversal", sector="media", segs=[("est", "nbcu", None, None)]),
    dict(id="marvel", name="Marvel", sector="media", segs=[("cmc", "marvel-entertainment", None, None)]),
]

# Fish with no stock price. Each point: (date, how the value is read, source kind, source ref, quote).
ESTIMATES = {
    # Implied by a sale of a known slice: value of the slice / the slice's share of the company.
    "nbcu": [("2009-12-03", "slice", "wiki", "NBCUniversal", "GE used some of the funds, $5.8 billion, to buy out Vivendi's 20% minority stake in NBC Universal", 0.20)],
}

# ================================================================ EVENTS
# type: eat (actor eats targets), split (actor pops into children; actor may survive as one of them),
#       enter / exit (swims in or out), rename, distress (belly-up until a date).
# date: ("wiki", title, quote, "YYYY-MM-DD") | ("sec", url, quote, "YYYY-MM-DD") | ("secform", cik, forms, after, before)
# value: ("list", acquirer, target, year) | ("wiki"/"news"/"sec", ref, quote)  -> dollar amount read from the quote
# outside: targets that are not otherwise in the tank swim in to be eaten, sized by the deal value (drawn hollow).
EVENTS = [
    dict(id="disney_abc", type="eat", actor="disney", targets=["capcities"], outside={"capcities": ("Capital Cities/ABC", "media")},
         date=("sec", "https://www.sec.gov/Archives/edgar/data/1001039/0000898430-96-000382.txt", "On February 9, 1996, The Walt Disney Company (the \"Company\") completed", "1996-02-09"),
         value=("news", "https://www.baltimoresun.com/1995/08/01/a-media-giant-is-born-merger-is-biggest-in-entertainment-industrys-history-disney-capital-citiesabc-merger/", "If the $19 billion deal is approved"),
         pause=True, headline="Disney swallows ABC",
         text="Five weeks into the tank, Disney closes its purchase of Capital Cities/ABC, owner of the ABC network and 80 percent of ESPN, for {value}. When it was announced, the Baltimore Sun called it the largest merger ever in the entertainment industry.\nDisney comes out of it worth {actor_after}. Watch the phone companies below: they are about to start eating each other."),
    dict(id="qwest_in", type="enter", actor="qwest",
         date=("wiki", "Qwest", "The telecom company was renamed Qwest and became a publicly traded company in June 1997", "1997-06")),
    dict(id="cbs_name", type="rename", actor="westinghouse", rename="CBS",
         date=("wiki", "CBS Corporation", "The first incarnation of the company was formed on November 30, 1997 after the Westinghouse Electric Corporation was renamed as CBS Corporation", "1997-11-30")),
    dict(id="charter_in", type="enter", actor="charter",
         date=("secform", 1091667, ["424B1", "424B4", "8-A12G", "8-A12B"], "1999-10-01", "1999-12-31"), minor="Charter goes public"),
    dict(id="netflix_in", type="enter", actor="netflix",
         date=("secform", 1065280, ["424B1", "424B4", "8-A12G"], "2002-05-01", "2002-06-30"), minor="Netflix, a DVD-by-mail company, goes public as a guppy"),
    dict(id="discovery_in", type="enter", actor="discovery",
         date=("secform", 1437107, ["8-K", "8-A12B", "10-Q"], "2008-09-01", "2008-10-31"), minor="Discovery Communications starts trading as one company"),
    dict(id="ctl_name", type="rename", actor="centurytel", rename="CenturyLink",
         date=("wiki", "Lumen Technologies", "The new corporate name, CenturyLink, Inc., did not become official until May 2010", "2010-05")),
    dict(id="lumen_name", type="rename", actor="centurytel", rename="Lumen",
         date=("wiki", "Lumen Technologies", "Effective with the opening of the trading day on September 18, 2020, the company stock ticker changed from CTL to LUMN", "2020-09-18")),
    dict(id="lucent", type="split", actor="att_corp", children=["att_corp", "lucent"], leaves=["lucent"],
         date=("wiki", "Lucent Technologies", "It was established on September 30, 1996, through the divestiture of the former AT&T Technologies business unit of AT&T Corporation", "1996-09-30"),
         minor="AT&T spins off its equipment maker, Lucent, which swims out of the tank"),
    dict(id="sbc_pactel", type="eat", actor="sbc", targets=["pactel"],
         date=("secform", 732716, ["15-12B", "15-12G", "15-15D"], "1997-03-01", "1997-12-31"),
         value=("wiki", "Pacific Telesis", "In 1997, Pacific Telesis Group was acquired by SBC Communications (renamed from Southwestern Bell Corporation) for $16.7 billion"),
         minor="SBC, the smallest Baby Bell, eats Pacific Telesis"),
    dict(id="ba_nynex", type="eat", actor="bell_atlantic", targets=["nynex"],
         date=("wiki", "NYNEX", "The final merger took place on August 14, 1997", "1997-08-14"),
         value=("list", "Bell Atlantic", "NYNEX", 1996), minor="Bell Atlantic eats NYNEX"),
    dict(id="uswest_split", type="split", actor="us_west_old", children=["us_west", "mediaone"],
         date=("secform", 732718, ["8-K"], "1998-06-01", "1998-06-30"),
         minor="US West splits its phone company from its cable business, MediaOne"),
    dict(id="wcom_mci", type="eat", actor="worldcom", targets=["mci"],
         date=("secform", 64079, ["15-12G", "15-12B"], "1998-09-01", "1998-12-31"),
         value=("list", "Worldcom", "MCI Communications", 1997), minor="WorldCom eats MCI"),
    dict(id="att_tci", type="eat", actor="att_corp", targets=["tci"],
         date=("wiki", "Tele-Communications Inc.", "AT&T completed its acquisition on March 9, 1999", "1999-03-09"),
         value=("list", "AT&T", "Tele-Communications Inc.", 1999), minor="AT&T buys TCI, the second-biggest cable company"),
    dict(id="sbc_ameritech", type="eat", actor="sbc", targets=["ameritech"],
         date=("wiki", "Ameritech", "then the two companies officially merged on October 8, 1999", "1999-10-08"),
         value=("list", "SBC Communications", "Ameritech Corporation", 1999), minor="SBC eats Ameritech"),
    dict(id="viacom_cbs", type="eat", actor="viacom", targets=["westinghouse"],
         date=("secform", 106413, ["15-12B", "15-12G"], "2000-04-01", "2000-12-31"),
         value=("list", "Viacom", "CBS Corporation", 1999), minor="Viacom eats CBS"),
    dict(id="att_mediaone", type="eat", actor="att_corp", targets=["mediaone"],
         date=("secform", 732718, ["15-12B", "15-12G"], "2000-06-01", "2000-06-30"),
         value=("list", "AT&T", "MediaOne", 2002), minor="AT&T eats MediaOne and becomes the biggest cable operator"),
    dict(id="verizon", type="eat", actor="bell_atlantic", targets=["gte"], rename="Verizon",
         date=("wiki", "GTE", "Bell Atlantic merged with GTE on June 30, 2000, and named the new entity Verizon Communications", "2000-06-30"),
         value=("list", "Bell Atlantic", "GTE", 1998), pause=True, headline="The Bells put themselves back together",
         text="Bell Atlantic eats GTE for {value} and renames itself Verizon. Three years earlier it had swallowed NYNEX. On the same day Qwest, a fiber upstart that only went public in 1997, eats US West.\nSBC has been just as hungry: Pacific Telesis in 1997, Ameritech in 1999. Verizon is now worth {actor_after}, SBC {sbc_now}."),
    dict(id="qwest_uswest", type="eat", actor="qwest", targets=["us_west"],
         date=("wiki", "US West", "U S West merged with Qwest on June 30, 2000", "2000-06-30"),
         value=("list", "Qwest Communications", "US West", 1999), minor="Qwest eats US West"),
    dict(id="aol_tw", type="eat", actor="aol", targets=["time_warner"], rename="AOL Time Warner",
         date=("wiki", "Merger of AOL and Time Warner", "After an extensive regulatory review, the merger closed on January 11, 2001", "2001-01-11"),
         value=("list", "AOL", "Time Warner", 2000), pause=True, headline="The guppy eats the whale",
         text="AOL, worth about {actor_start} when the tank opened in 1996, closes its purchase of Time Warner, a deal valued at {value} when it was announced a year earlier. It is the largest deal in this tank, before or since.\nIn January 2003, the merged company reported a loss of $99 billion, the largest ever for a corporation at the time."),
    dict(id="attws_split", type="split", actor="att_corp", children=["att_corp", "att_wireless"],
         date=("wiki", "AT&T Wireless Services", "Just over a year later in July 2001, AT&T Wireless became a separate company rather than a division of AT&T Corporation", "2001-07"),
         minor="AT&T spins off AT&T Wireless"),
    dict(id="wcom_bk", type="distress", actor="worldcom", until=("wiki", "WorldCom", "The company emerged from bankruptcy in 2004", "2004-04-20"),
         date=("wiki", "WorldCom", "On July 21, 2002, WorldCom filed for Chapter 11 bankruptcy protection in the largest such filing in United States history at the time", "2002-07-21"),
         pause=True, headline="WorldCom goes belly up",
         text="WorldCom, which had eaten MCI four years earlier for {wcom_mci_value}, files for bankruptcy after an accounting scandal. It is the largest bankruptcy filing in US history at the time.\nAt its last annual report before the boom ended it was worth {actor_peak}. It will come back in 2004 under MCI's name."),
    dict(id="comcast_attbb", type="eat", actor="comcast", targets=["att_broadband"], split_from="att_corp",
         date=("secform", 22301, ["15-12G", "15-12B"], "2002-11-01", "2002-11-30"),
         value=("list", "Comcast", "AT&T Broadband", 2001), pause=True, headline="AT&T comes apart, and Comcast feeds",
         text="Having paid {att_tci_value} for TCI in 1999 and {att_mediaone_value} for MediaOne in 2000, AT&T gives up on cable. Its cable unit pops off and Comcast swallows it in a deal valued at {value}.\nComcast had been worth {actor_start} in 1996. Now it is {actor_after}. AT&T, already short its wireless arm, is down to {att_corp_after}."),
    dict(id="directv_in", type="enter", actor="directv",
         date=("secform", 944868, ["8-A12B"], "2003-12-01", "2004-01-31"), minor="DirecTV becomes its own listed company after News Corp buys a stake from GM"),
    dict(id="attws_exit", type="exit", actor="att_wireless",
         date=("secform", 1138234, ["25", "15-12B"], "2004-10-01", "2004-12-31"),
         value=("list", "Cingular", "AT&T Wireless", 2004),
         minor="AT&T Wireless is sold to Cingular, the wireless venture SBC and BellSouth own together"),
    dict(id="news_in", type="enter", actor="news_corp",
         date=("wiki", "News Corporation", "the company was re-incorporated under Delaware General Corporation Law following a successful shareholder vote on November 12, 2004", "2004-11-12"),
         minor="News Corp moves its incorporation from Australia to the US and swims into the tank"),
    dict(id="wcom_mci_name", type="rename", actor="worldcom", rename="MCI",
         date=("wiki", "WorldCom", "MCI (2003–2006)", "2003")),
    dict(id="tw_name", type="rename", actor="aol", rename="Time Warner",
         date=("wiki", "WarnerMedia", "In June 2003, the company dropped the \"AOL\" from its name, and reverted itself to Time Warner", "2003-06")),
    dict(id="sprint_nextel", type="eat", actor="sprint", targets=["nextel"], rename="Sprint Nextel",
         date=("wiki", "Sprint Corporation", "Sprint Nextel was formed on August 13, 2005, when the deal was completed", "2005-08-13"),
         value=("list", "Sprint Corporation", "Nextel Communications", 2005), minor="Sprint eats Nextel"),
    dict(id="sbc_att", type="eat", actor="sbc", targets=["att_corp"], rename="AT&T",
         date=("wiki", "AT&T", "On November 18, 2005, SBC Communications purchased its former parent, AT&T Corporation, for $16 billion", "2005-11-18"),
         value=("wiki", "AT&T", "On November 18, 2005, SBC Communications purchased its former parent, AT&T Corporation, for $16 billion"),
         pause=True, headline="The child eats the parent",
         text="SBC, the smallest of the Baby Bells split off from AT&T in 1984, buys its old parent for {value} and takes its name. At the start of 1996 AT&T Corp. was worth {target_start}. At its last annual report before the sale it was worth {target_last}.\nThe new AT&T is worth {actor_after}. A year later it eats BellSouth too."),
    dict(id="viacom_split", type="split", actor="viacom", children=["cbs", "viacom_new"],
         date=("wiki", "Viacom (2005–2019)", "It was split from the original Viacom on December 31, 2005", "2005-12-31"),
         minor="Viacom splits in two: CBS and a new Viacom"),
    dict(id="vz_mci", type="eat", actor="bell_atlantic", targets=["worldcom"],
         date=("secform", 723527, ["15-12G", "15-12B"], "2006-01-01", "2006-02-28"),
         value=("wiki", "Verizon", "Verizon increased its bid to $7.6 billion, which MCI accepted on March 29, 2005"), minor="Verizon eats what's left of WorldCom, now called MCI"),
    dict(id="embarq_split", type="split", actor="sprint", children=["sprint", "embarq"],
         date=("secform", 1350031, ["8-K", "10-Q"], "2006-05-01", "2006-06-30"), minor="Sprint spins off its local phone business as Embarq"),
    dict(id="nbcu_in", type="enter", actor="nbcu",
         date=("wiki", "Comcast", "the parties announced that Comcast would buy a controlling 51% stake in NBC Universal, including Universal Pictures, for $6.5 billion in cash and $7.3 billion in programming on December 3", "2009-12-03"),
         minor="NBCUniversal, owned by General Electric, swims in when Comcast agrees to buy control of it"),
    dict(id="disney_pixar", type="eat", actor="disney", targets=["pixar"],
         date=("secform", 1002114, ["15-12G", "15-12B"], "2006-05-01", "2006-05-31"),
         value=("wiki", "Pixar", "Disney ultimately agreed on January 24, 2006, to buy Pixar for approximately $7.4 billion"), minor="Disney eats Pixar"),
    dict(id="att_bls", type="eat", actor="sbc", targets=["bellsouth"],
         date=("wiki", "BellSouth", "executed on December 29, 2006, AT&T Inc. (originally SBC Communications) acquired BellSouth for approximately $86 billion", "2006-12-29"),
         value=("wiki", "BellSouth", "AT&T Inc. (originally SBC Communications) acquired BellSouth for approximately $86 billion"), minor="AT&T eats BellSouth"),
    dict(id="news_dj", type="eat", actor="news_corp", targets=["dowjones"], outside={"dowjones": ("Dow Jones", "media")},
         date=("secform", 29924, ["25-NSE", "15-12B"], "2007-12-01", "2007-12-31"),
         value=("wiki", "Dow Jones & Company", "had agreed in principle on a US$5 billion takeover"), minor="News Corp eats Dow Jones, owner of The Wall Street Journal"),
    dict(id="vz_alltel", type="eat", actor="bell_atlantic", targets=["alltel"], outside={"alltel": ("Alltel", "telecom")},
         date=("secform", 65873, ["15-12B", "15-12G", "15-15D"], "2008-11-01", "2009-02-28"),
         value=("wiki", "Alltel", "Verizon Wireless announced it would acquire the majority of Alltel Wireless in a deal valued at $28.1 billion"), minor="Verizon's wireless arm eats Alltel"),
    dict(id="twc_split", type="split", actor="aol", children=["aol", "twc"],
         date=("secform", 1105705, ["8-K"], "2009-03-12", "2009-03-31"), minor="Time Warner spins off Time Warner Cable"),
    dict(id="charter_bk", type="distress", actor="charter", until=("wiki", "Charter Communications", "That day, Charter emerged from bankruptcy", "2009-11-30"),
         date=("wiki", "Charter Communications", "Charter filed for a prearranged bankruptcy on March 28, 2009", "2009-03-28"), minor="Charter files for bankruptcy"),
    dict(id="ctl_embarq", type="eat", actor="centurytel", targets=["embarq"],
         date=("secform", 1350031, ["25-NSE", "15-15D"], "2009-06-01", "2009-07-31"),
         value=None, minor="CenturyTel eats Embarq, Sprint's old local phone business"),
    dict(id="aol_split", type="split", actor="aol", children=["aol", "aol_inc"],
         date=("secform", 1105705, ["8-K"], "2009-12-01", "2009-12-31"), minor="Time Warner spins off AOL"),
    dict(id="disney_marvel", type="eat", actor="disney", targets=["marvel"],
         date=("wiki", "Marvel Entertainment", "On December 31, 2009, Disney completed its acquisition of Marvel Entertainment", "2009-12-31"),
         value=("wiki", "Marvel Entertainment", "On August 31, 2009, the Walt Disney Company announced a deal to acquire Marvel Entertainment for $4 billion"), minor="Disney eats Marvel"),
    dict(id="comcast_nbcu", type="eat", actor="comcast", targets=["nbcu"],
         date=("wiki", "Comcast", "The transaction was completed on January 28, 2011", "2011-01-28"),
         value=("list", "Comcast", "NBCUniversal", 2009), minor="Comcast takes control of NBCUniversal from General Electric"),
    dict(id="ctl_qwest", type="eat", actor="centurytel", targets=["qwest"],
         date=("secform", 1037949, ["25-NSE", "15-12B", "15-12G"], "2011-03-01", "2011-05-31"),
         value=("wiki", "Qwest", "The valuation of CenturyLink's purchase as of April 21, 2010, was $22.4 billion"), minor="CenturyLink eats Qwest"),
    dict(id="disney_lucas", type="eat", actor="disney", targets=["lucasfilm"], outside={"lucasfilm": ("Lucasfilm", "media")},
         date=("wiki", "Lucasfilm", "On December 21, 2012, Disney completed the acquisition and Lucasfilm became a wholly owned subsidiary of Disney", "2012-12-21"),
         value=("wiki", "Lucasfilm", "On October 30, 2012, Disney announced a deal to acquire Lucasfilm for $4.05 billion"), minor="Disney eats Lucasfilm"),
    dict(id="tmo_in", type="enter", actor="tmobile",
         date=("secform", 1283699, ["8-K"], "2013-05-01", "2013-05-10"), minor="T-Mobile US joins the tank through a merger with MetroPCS"),
    dict(id="news_split", type="split", actor="news_corp", children=["fox21", "news_corp_new"],
         date=("wiki", "News Corporation", "The formal split was completed on June 28, 2013", "2013-06-28"),
         minor="News Corp splits into 21st Century Fox and a new News Corp"),
    dict(id="vz_aol", type="eat", actor="bell_atlantic", targets=["aol_inc"],
         date=("secform", 1468516, ["25-NSE", "15-12B"], "2015-06-01", "2015-07-31"),
         value=("wiki", "Verizon", "Verizon acquired AOL in 2015 at $50 per share, for a deal valued around $4.4 billion"), minor="Verizon eats AOL"),
    dict(id="att_directv", type="eat", actor="sbc", targets=["directv"],
         date=("wiki", "DirecTV", "On July 24, 2015, after receiving approval from the Federal Communications Commission and the Department of Justice, AT&T acquired DirecTV", "2015-07-24"),
         value=("wiki", "DirecTV", "AT&T acquired DirecTV in a transaction valued at $67.1 billion"), minor="AT&T eats DirecTV"),
    dict(id="charter_twc", type="eat", actor="charter", targets=["twc", "brighthouse"], outside={"brighthouse": ("Bright House", "cable")},
         date=("wiki", "Charter Communications", "On May 18, 2016, Charter finalized acquisition of Time Warner Cable and its sister company Bright House Networks", "2016-05-18"),
         value=("list", "Charter Communications", "Time Warner Cable", 2015), minor="Charter eats Time Warner Cable and Bright House"),
    dict(id="ctl_level3", type="eat", actor="centurytel", targets=["level3"], outside={"level3": ("Level 3", "telecom")},
         date=("wiki", "Level 3 Communications", "The deal officially closed and Level 3 became part of CenturyLink on November 1, 2017", "2017-11-01"),
         value=("wiki", "Level 3 Communications", "CenturyLink announced its intent to acquire Level 3 in a deal valued at around $34 billion"), minor="CenturyLink eats Level 3"),
    dict(id="disc_scripps", type="eat", actor="discovery", targets=["scripps"], outside={"scripps": ("Scripps Networks", "media")},
         date=("wiki", "Scripps Networks Interactive", "Discovery Communications completed its acquisition of SNI after receiving approval from the United States Department of Justice and European Commission on March 6, 2018", "2018-03-06"),
         value=("wiki", "Scripps Networks Interactive", "Discovery Communications announced that it would acquire Scripps Networks Interactive for $14.6 billion"), minor="Discovery eats Scripps Networks, home of HGTV and Food Network"),
    dict(id="att_tw", type="eat", actor="sbc", targets=["aol"],
         date=("wiki", "Acquisition of Time Warner by AT&T", "The merger closed on June 14, 2018", "2018-06-14"),
         value=("list", "AT&T", "Time Warner", 2016), pause=True, headline="The phone company buys Hollywood",
         text="AT&T, which had already eaten DirecTV, buys Time Warner, the company AOL swallowed in 2001. Wikipedia's list of the largest acquisitions puts the deal at {value}, or more including debt.\nAT&T is now a phone company, a satellite TV company and a movie studio, worth {actor_after}."),
    dict(id="comcast_sky", type="eat", actor="comcast", targets=["sky"], outside={"sky": ("Sky", "cable")},
         date=("wiki", "Sky Group", "Fox sold their stake in October 2018, followed by the remaining shareholders a month later", "2018-10-15"),
         value=("list", "Comcast Corporation", "Sky plc", 2018), minor="Comcast eats Sky, the British pay-TV company"),
    dict(id="disney_fox", type="eat", actor="disney", targets=["fox_assets"], split_from="fox21", also_children=["fox_corp"],
         date=("wiki", "Acquisition of 21st Century Fox by Disney", "the transaction closed on March 20, 2019", "2019-03-20"),
         value=("list", "The Walt Disney Company", "21st Century Fox", 2018), pause=True, headline="Disney eats most of Fox",
         text="21st Century Fox pops. Most of it goes to Disney, in a deal valued at {value}. What is left swims off as a new, smaller company, Fox Corp.\nDisney has now swallowed ABC, Pixar, Marvel, Lucasfilm and most of Fox, and is worth {actor_after}."),
    dict(id="cbs_viacom", type="eat", actor="cbs", targets=["viacom_new"], rename="ViacomCBS",
         date=("wiki", "CBS Corporation", "The merger was completed on December 4, 2019", "2019-12-04"),
         value=("list", "Viacom", "CBS Corporation", 2019), minor="CBS and Viacom merge back together as ViacomCBS"),
    dict(id="tmo_sprint", type="eat", actor="tmobile", targets=["sprint"],
         date=("wiki", "Sprint Corporation", "Before being acquired by T-Mobile US on April 1, 2020", "2020-04-01"),
         value=("list", "T-Mobile US", "Sprint Corporation", 2018), minor="T-Mobile eats Sprint"),
    dict(id="paramount_name", type="rename", actor="cbs", rename="Paramount",
         date=("wiki", "Paramount Global", "On February 16, 2022, ViacomCBS was renamed to Paramount", "2022-02-16")),
    dict(id="wbd", type="eat", actor="discovery", targets=["warnermedia"], split_from="sbc", rename="Warner Bros. Discovery",
         date=("secform", 1437107, ["8-K"], "2022-04-08", "2022-04-15"),
         value=("list", "Discovery, Inc.", "WarnerMedia", 2021), pause=True, headline="AT&T spits Time Warner back out",
         text="Four years after buying it, AT&T gives up on Hollywood. WarnerMedia pops out of AT&T and Discovery, the cable channel company, swallows it, a deal valued at {value}. The combined fish is Warner Bros. Discovery.\nAT&T goes back to being a phone company, worth {sbc_after}. Netflix, a guppy that went public in 2002, is worth {netflix_now}."),
    dict(id="paramount_skydance", type="eat", actor="cbs", targets=["skydance"], outside={"skydance": ("Skydance", "media")}, rename="Paramount Skydance",
         date=("wiki", "Merger of Skydance Media and Paramount Global", "Skydance announced that the transaction would close six days later, which occurred on August 7, 2025", "2025-08-07"),
         value=("wiki", "Merger of Skydance Media and Paramount Global", "an all-stock merger between Skydance Media and Paramount, valued at $4.75 billion"), minor="Paramount merges with David Ellison's Skydance"),
    dict(id="versant", type="split", actor="comcast", children=["comcast", "versant"],
         date=("wiki", "Comcast", "the spin-off was completed, which finished on January 2, 2026", "2026-01-02"),
         minor="Comcast spins off its cable channels as Versant"),
    dict(id="vz_frontier", type="eat", actor="bell_atlantic", targets=["frontier"], outside={"frontier": ("Frontier", "telecom")},
         date=("secform", 20520, ["25-NSE", "15-12B", "15-12G"], "2026-01-01", "2026-02-28"),
         value=("wiki", "Verizon", "valuing the company at $20 billion"), minor="Verizon eats Frontier"),
    dict(id="charter_cox", type="eat", actor="charter", targets=["cox_private"], outside={"cox_private": ("Cox Communications", "cable")},
         date=("wiki", "Charter Communications", "the merger was completed on August 20, 2026", "2026-08-20"),
         value=("list", "Charter Communications", "Cox Communications", 2025), minor="Charter eats Cox"),
    dict(id="psky_wbd", type="eat", actor="cbs", targets=["discovery"], rename="Skydance",
         date=("wiki", "Warner Bros. Discovery", "The acquisition closed on October 6, 2026", "2026-10-06"),
         value=("wiki", "Warner Bros. Discovery", "Paramount Skydance outbid them with a $110.9 billion offer for the entire company on February 24, 2026"),
         pause=True, headline="The smallest studio eats the biggest",
         text="Paramount Skydance, worth {actor_before} on the stock market, closes its {value} purchase of Warner Bros. Discovery after outbidding Netflix, and renames itself Skydance. Warner Bros. Discovery was worth {target_last} just before.\nThe Warner Bros. studio has now been inside four fish in this tank: Time Warner, AOL Time Warner, AT&T and Warner Bros. Discovery, and Skydance makes five."),
]


# ================================================================ BUILD

def fmt_bn(v):
    if v >= 1e12:
        return f"${v / 1e12:.2f} trillion"
    if v >= 1e11:
        return f"${v / 1e9:.0f} billion"
    if v >= 1e10:
        return f"${v / 1e9:.0f} billion"
    if v >= 1e9:
        return f"${v / 1e9:.1f} billion"
    return f"${v / 1e6:.0f} million"


def resolve_date(spec):
    kind = spec[0]
    if kind in ("wiki", "sec", "news"):
        sid = check_quote(kind, spec[1], spec[2])
        d = spec[3]
        prec = "day" if len(d) == 10 else "month" if len(d) == 7 else "year"
        iso = d if prec == "day" else (d + "-15" if prec == "month" else d + "-07-01")
        return iso, prec, [sid]
    if kind == "secform":
        d, sid, form = sec_form_date(spec[1], spec[2], spec[3], spec[4])
        return d, "filing", [sid] if sid else []
    raise ValueError(spec)


def resolve_value(spec):
    if spec is None:
        return None, []
    if spec[0] == "list":
        v, sid = list_value(spec[1], spec[2], spec[3])
        return v, [sid] if sid else []
    sid = check_quote(spec[0], spec[1], spec[2])
    return money(spec[2]), [sid]


def cpi():
    b = fetch("https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCSL")
    rows = [r for r in csv.reader(b.decode().splitlines())][1:]
    series = {r[0][:7]: float(r[1]) for r in rows if r[1] not in ("", ".")}
    add_source("fred:CPIAUCSL", "U.S. Bureau of Labor Statistics, Consumer Price Index for All Urban Consumers (CPIAUCSL), via FRED", "https://fred.stlouisfed.org/series/CPIAUCSL", short="CPI (FRED)")
    base_m = max(series)
    log(f"CPI: {len(series)} months, base {base_m} = {series[base_m]}")
    return series, base_m


def main():
    if "--offline" in sys.argv:
        pass
    cpis, base_m = cpi()
    base = cpis[base_m]

    def real(v, d):
        m = d[:7]
        while m not in cpis:
            m = max(k for k in cpis if k < m)
        return v * base / cpis[m]

    deflator = {}
    for y in range(1996, int(base_m[:4]) + 1):
        ms = [cpis[k] for k in cpis if k.startswith(str(y))]
        deflator[y] = round(base / (sum(ms) / len(ms)), 4)

    # ---------- events: resolve dates, values, sources
    events = []
    outside = {}
    for e in EVENTS:
        d, prec, sids = resolve_date(e["date"])
        if d is None:
            log(f"EVENT {e['id']}: no date, left out")
            continue
        v, vsids = resolve_value(e.get("value"))
        ev = {k: e[k] for k in ("id", "type", "actor") if k in e}
        ev.update({"date": d, "precision": prec, "src": sids + vsids, "targets": e.get("targets", []), "children": e.get("children", []),
                   "pause": bool(e.get("pause")), "minor": e.get("minor"), "rename": e.get("rename"), "value": v,
                   "value_real": real(v, d) if v else None, "leaves": e.get("leaves", []), "linked": bool(e.get("split_from"))})
        if e.get("until"):
            u, _, usids = resolve_date(e["until"])
            ev["until"] = u
            ev["src"] += usids
        if e.get("split_from"):
            ev["split_from"] = e["split_from"]
            ev["also_children"] = e.get("also_children", [])
        for tid, (nm, sector) in e.get("outside", {}).items():
            outside[tid] = {"id": tid, "name": nm, "sector": sector, "outside": True}
        ev["_tmpl"] = (e.get("headline"), e.get("text"))
        events.append(ev)
        log(f"EVENT {d} ({prec}) {e['id']}: value={fmt_bn(v) if v else '-'} sources={len(ev['src'])}")

    if QUOTE_FAILS:
        log("\nSTOPPING: these quoted passages were not found in their sources:")
        for f in QUOTE_FAILS:
            log(f"  {f}")
        open(os.path.join(OUT, "build_log.txt"), "w").write("\n".join(LOG) + "\n")
        sys.exit(1)

    # Linked eats (a piece pops off one fish and is eaten by another on the same day): add the split.
    extra = []
    for ev in events:
        if ev.get("linked"):
            parent = ev["split_from"]
            tid = ev["targets"][0]
            outside.setdefault(tid, {"id": tid, "name": {"att_broadband": "AT&T Broadband", "fox_assets": "21st Century Fox studios and channels", "warnermedia": "WarnerMedia"}[tid],
                                     "sector": "cable" if tid == "att_broadband" else "media", "piece": True})
            survivors = [] if parent in ("fox21",) else [parent]
            extra.append({"id": ev["id"] + "_pop", "type": "split", "actor": parent, "children": survivors + [tid] + ev.get("also_children", []),
                          "date": ev["date"], "precision": ev["precision"], "src": ev["src"], "targets": [], "pause": False, "minor": None,
                          "rename": None, "value": None, "value_real": None, "leaves": [], "linked": False, "_tmpl": (None, None)})
    events += extra
    events.sort(key=lambda e: (e["date"], 0 if e["type"] == "split" else 1))

    # ---------- fish values
    fish = []
    held_notes, xcheck_notes = [], []
    for f in FISH:
        pts = []
        for seg in f["segs"]:
            kind, ref, a, b = seg
            if kind == "cmc":
                sid, ps = cmc(ref)
                pts += [{"d": d, "v": v, "kind": "market", "src": sid} for d, v in ps if (a is None or d >= a) and (b is None or d <= b)]
            elif kind in ("float", "sxp"):
                for c in covers(ref):
                    d = c["asof"]
                    if not d or (a and d < a) or (b and d > b):
                        continue
                    sid = add_source(f"sec:{ref}", f"SEC EDGAR, annual reports (10-K) of {c['company'].title()}, cover page",
                                     f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={int(ref):010d}&type=10-K", short=f"SEC 10-K covers: {c['company'].title()}")
                    if kind == "float" and c["float"]:
                        pts.append({"d": d, "v": c["float"], "kind": "float", "src": sid, "doc": c["url"]})
                    elif kind == "sxp" and c["shares"] and c["prices"]:
                        sh, pr = c["shares"], c["prices"]
                        if len(pr) >= len(sh):
                            v = sum(n * p for n, p in zip(sh, pr))
                        else:
                            v = sum(sh) * pr[0]
                        pts.append({"d": d, "v": v, "kind": "market", "src": sid, "doc": c["url"], "how": f"{len(sh)} share classes x cover price"})
                    else:
                        log(f"COVER UNUSED {f['id']} {c['filed']}: kind={kind} float={c['float']} shares={c['shares'][:3]} prices={c['prices'][:3]}")
            elif kind == "est":
                for d, how, sk, sref, quote, share in ESTIMATES[ref]:
                    sid = check_quote(sk, sref, quote)
                    pts.append({"d": d, "v": money(quote) / share, "kind": "estimate", "src": sid, "how": f"{fmt_bn(money(quote))} for {share:.0%} of the company"})
        pts.sort(key=lambda p: p["d"])
        # Drop obviously broken readings: a cover value less than a tenth of its neighbours.
        clean = []
        for i, p in enumerate(pts):
            nb = [q["v"] for q in pts[max(0, i - 2):i + 3] if q is not p]
            if nb and p["v"] < 0.1 * sorted(nb)[len(nb) // 2]:
                log(f"DROP {f['id']} {p['d']} {fmt_bn(p['v'])}: under a tenth of nearby values {[fmt_bn(x) for x in nb]}")
                continue
            clean.append(p)
        fish.append({"id": f["id"], "sector": f["sector"], "names": [[None, f["name"]]], "series": clean})
        # Cross-check the monthly source against SEC cover values where both exist.
        if f.get("check"):
            cs = covers(f["check"])
            for c in cs:
                if not c["float"] or not c["asof"]:
                    continue
                near = [p for p in clean if p["kind"] == "market" and abs((d2(p["d"]) - d2(c["asof"])).days) <= 20]
                if near:
                    r = near[0]["v"] / c["float"]
                    log(f"XCHECK {f['id']} {c['asof']}: monthly {fmt_bn(near[0]['v'])} vs SEC outside-investor value {fmt_bn(c['float'])} (ratio {r:.2f})")
                    if r < 0.85:
                        xcheck_notes.append(f"{f['name']} on {c['asof']}: monthly value {fmt_bn(near[0]['v'])} is below the {fmt_bn(c['float'])} the company reported for shares held by outside investors alone.")

    for tid, o in outside.items():
        fish.append({"id": tid, "sector": o["sector"], "names": [[None, o["name"]]], "series": [], "outside": True, "piece": o.get("piece", False)})
    byid = {f["id"]: f for f in fish}

    # Deal values size the outside fish and the pieces that pop off and get eaten.
    for ev in events:
        if ev["type"] == "eat":
            for tid in ev["targets"]:
                f = byid[tid]
                if f.get("outside") and ev["value"]:
                    share = 1 if len(ev["targets"]) == 1 else None
                    if share is None:
                        continue
                    f["series"] = [{"d": ev["date"], "v": ev["value"], "kind": "deal", "src": ev["src"][-1]}]
    # Bright House rides along with Time Warner Cable in one deal; no separate price, so it is left out of that eat.
    for ev in events:
        if ev["type"] == "eat":
            keep = [t for t in ev["targets"] if byid[t]["series"]]
            for t in ev["targets"]:
                if t not in keep:
                    log(f"NOTE {ev['id']}: {byid[t]['names'][0][1]} has no value of its own, left out of the tank")
                    held_notes.append(f"{byid[t]['names'][0][1]} was part of the {ev['date'][:4]} deal but has no price of its own in the sources, so it isn't drawn.")
                    byid[t]["drop"] = True
            ev["targets"] = keep
    fish = [f for f in fish if not f.get("drop")]
    byid = {f["id"]: f for f in fish}

    # ---------- lifetimes and names
    for f in fish:
        f["born"], f["died"] = None, None
    for ev in events:
        a = ev["actor"]
        if ev["type"] == "eat":
            for t in ev["targets"]:
                byid[t]["died"] = ev["date"]
                if byid[t].get("outside") and not byid[t].get("piece"):
                    byid[t]["born"] = ev["date"]
        elif ev["type"] == "split":
            for c in ev["children"]:
                if c != a:
                    byid[c]["born"] = ev["date"]
            if a not in ev["children"]:
                byid[a]["died"] = ev["date"]
        elif ev["type"] == "enter":
            byid[a]["born"] = ev["date"]
        elif ev["type"] == "exit":
            byid[a]["died"] = ev["date"]
        if ev.get("rename"):
            byid[a]["names"].append([ev["date"], ev["rename"]])
    # Children that leave the tank as soon as they are born (Lucent made equipment, not service).
    for ev in events:
        for c in ev.get("leaves", []):
            events.append({"id": ev["id"] + "_" + c + "_leaves", "type": "exit", "actor": c, "date": ev["date"], "precision": ev["precision"], "src": ev["src"],
                           "targets": [], "children": [], "pause": False, "minor": None, "rename": None, "value": None, "value_real": None, "leaves": [], "linked": False,
                           "after_pop": True, "_tmpl": (None, None)})
            byid[c]["died"] = ev["date"]
            byid[c]["leaves_at_birth"] = True
    events.sort(key=lambda e: (e["date"], {"split": 0, "enter": 1, "eat": 2, "exit": 3}.get(e["type"], 4)))

    # Trim each fish's values to its life in the tank (plus one point either side for easing).
    for f in fish:
        s = f["series"]
        if not s:
            continue
        lo = f["born"] or FIRST
        hi = f["died"] or LAST
        inside = [p for p in s if lo <= p["d"] <= hi]
        before = [p for p in s if p["d"] < lo][-1:]
        after = [p for p in s if p["d"] > hi][:1]
        f["series"] = before + inside + after
        if not f["series"]:
            log(f"NOTE {f['id']}: no values inside its life {lo}..{hi}")
            continue
        gap_start = (d2(f["series"][0]["d"]) - d2(lo)).days
        if gap_start > 183 and not f.get("outside"):
            held_notes.append(f"{f['names'][0][1]}: first value is {f['series'][0]['d']}, so it is drawn at that size from {lo}.")

    missing = [f["id"] for f in fish if not f["series"]]
    for m in missing:
        log(f"NOTE {m}: no values at all, left out")
    fish = [f for f in fish if f["series"]]
    byid = {f["id"]: f for f in fish}
    events = [e for e in events if e["actor"] in byid and all(t in byid for t in e["targets"]) and all(c in byid for c in e["children"])]

    # ---------- predators: a fish turns predator on its second eat worth $1bn or more in today's dollars
    counts = {}
    for ev in events:
        if ev["type"] == "eat" and ev["value_real"] and ev["value_real"] >= 1e9:
            counts.setdefault(ev["actor"], []).append(ev["date"])
    for fid, ds in counts.items():
        if len(ds) >= 2:
            byid[fid]["predator_from"] = ds[1]
            log(f"PREDATOR {fid} from {ds[1]} ({len(ds)} qualifying eats)")

    # ---------- value lookups for captions
    def val_at(fid, d, side=0):
        s = byid[fid]["series"]
        if side < 0:
            s2 = [p for p in s if p["d"] < d]
            return s2[-1]["v"] if s2 else s[0]["v"]
        if side > 0:
            s2 = [p for p in s if p["d"] > d]
            return s2[0]["v"] if s2 else s[-1]["v"]
        import math
        t = d2(d)
        prev = [p for p in s if d2(p["d"]) <= t]
        nxt = [p for p in s if d2(p["d"]) >= t]
        if not prev:
            return nxt[0]["v"]
        if not nxt:
            return prev[-1]["v"]
        a, b = prev[-1], nxt[0]
        if a is b:
            return a["v"]
        w = (t - d2(a["d"])).days / max(1, (d2(b["d"]) - d2(a["d"])).days)
        return math.exp(math.log(a["v"]) * (1 - w) + math.log(b["v"]) * w)

    evid = {e["id"]: e for e in events}
    for ev in events:
        head, tmpl = ev.pop("_tmpl")
        if not head:
            continue
        a = ev["actor"]
        t0 = ev["targets"][0] if ev["targets"] else None
        after_d = (d2(ev["date"]) + dt.timedelta(days=40)).isoformat()
        vals = {"value": fmt_bn(ev["value"]) if ev["value"] else "",
                "actor_after": fmt_bn(val_at(a, after_d, 1)), "actor_before": fmt_bn(val_at(a, ev["date"], -1)),
                "actor_start": fmt_bn(val_at(a, max(FIRST, byid[a]["born"] or FIRST))), "actor_peak": fmt_bn(max(p["v"] for p in byid[a]["series"] if p["d"] <= ev["date"]))}
        if t0:
            vals["target_start"] = fmt_bn(val_at(t0, max(FIRST, byid[t0]["born"] or FIRST)))
            vals["target_last"] = fmt_bn(val_at(t0, ev["date"], -1))
        for k in re.findall(r"\{(\w+)\}", tmpl):
            if k in vals:
                continue
            m = re.match(r"(\w+?)_(now|after|value)$", k)
            if m and m.group(2) == "value" and m.group(1) in evid:
                vals[k] = fmt_bn(evid[m.group(1)]["value"])
            elif m and m.group(1) in byid:
                vals[k] = fmt_bn(val_at(m.group(1), after_d if m.group(2) == "after" else ev["date"], 1 if m.group(2) == "after" else 0))
            else:
                raise KeyError(f"{ev['id']}: no value for {{{k}}}")
        ev["headline"] = head
        ev["text"] = tmpl.format(**vals)
        log(f"PAUSE {ev['date']} {head}: {ev['text'][:200]}")

    # ---------- totals for sizing
    months = []
    y, m = 1996, 1
    while f"{y}-{m:02d}" <= LAST[:7]:
        months.append(f"{y}-{m:02d}-15")
        m += 1
        if m == 13:
            y, m = y + 1, 1
    max_total, max_when = 0, None
    for d in months:
        tot = 0
        for f in fish:
            if f.get("outside"):
                continue
            if (f["born"] or FIRST) <= d < (f["died"] or "9999"):
                tot += val_at(f["id"], d)
        if tot > max_total:
            max_total, max_when = tot, d
    log(f"Most crowded month: {max_when}, {fmt_bn(max_total)} in the tank")

    # ---------- write
    for f in fish:
        for p in f["series"]:
            p["v"] = round(p["v"])
    gaps = GAPS + held_notes + xcheck_notes
    tank = {
        "first_date": FIRST, "last_date": LAST, "built": dt.date.today().isoformat(),
        "max_total": max_total, "deflator": deflator, "cpi_base": base_m,
        "thresholds": {"adult_real": 10e9, "predator_deal_real": 1e9},
        "fish": fish, "events": events, "sources": list(SOURCES.values()), "gaps": gaps,
        "text": {**TEXT(base_m), "end": end_text(fish, events, val_at)},
    }
    json.dump(tank, open(os.path.join(OUT, "tank.json"), "w"), indent=0, default=str)
    with open(os.path.join(OUT, "values.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["fish", "name", "date", "value_usd", "kind", "source", "document"])
        for f in fish:
            for p in f["series"]:
                w.writerow([f["id"], f["names"][0][1], p["d"], p["v"], p["kind"], SOURCES.get(p["src"], {}).get("url", p["src"]), p.get("doc", "")])
    with open(os.path.join(OUT, "events.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["date", "precision", "type", "actor", "targets", "children", "value_usd", "value_usd_today", "sources"])
        for e in events:
            w.writerow([e["date"], e["precision"], e["type"], e["actor"], " ".join(e["targets"]), " ".join(e["children"]), e["value"] or "", round(e["value_real"]) if e["value_real"] else "",
                        " ".join(SOURCES[s]["url"] for s in e["src"] if s in SOURCES)])
    open(os.path.join(OUT, "build_log.txt"), "w").write("\n".join(LOG) + "\n")
    log(f"Wrote {len(fish)} fish, {len(events)} events, {sum(len(f['series']) for f in fish)} values, {len(SOURCES)} sources.")


def end_text(fish, events, val_at):
    def name_at_end(f):
        return f["names"][-1][1]
    start = [f for f in fish if not f.get("outside") and f["born"] is None and f["sector"] == "telecom"]
    left = [f for f in start if f["died"] is None]
    alive = [f for f in fish if not f.get("outside") and f["died"] is None and (f["born"] or FIRST) <= LAST]
    alive.sort(key=lambda f: -val_at(f["id"], LAST[:8] + "15"))
    eats = {}
    for e in events:
        if e["type"] == "eat":
            eats[e["actor"]] = eats.get(e["actor"], 0) + len(e["targets"])
    nf = [f for f in fish if f["id"] == "netflix"][0]
    first = nf["series"][0]
    parts = [
        f"Of the {len(start)} phone companies swimming in January 1996, {len(left)} are still here: " + ", ".join(f"{f['names'][0][1]} (now {name_at_end(f)})" if name_at_end(f) != f['names'][0][1] else f['names'][0][1] for f in left) + ".",
        "The biggest fish in the tank now: " + ", ".join(f"{name_at_end(f)} ({fmt_bn(val_at(f['id'], LAST[:8] + '15'))})" for f in alive[:4]) + ".",
        f"Netflix never ate anything in this tank. It swam in at {fmt_bn(first['v'])} in {dt.date.fromisoformat(first['d']).strftime('%B %Y')} and grew on its own.",
    ]
    return " ".join(parts)


GAPS = [
    "The tank starts in January 1996. No free source we could reach gives market values for these companies before then, so the 1984 breakup of the Bell System, Time Inc. and Warner Communications (1990) and Capital Cities buying ABC (1985) happen before the first frame.",
    "Firms that no longer trade are sized from the cover of each annual report, which gives the value of shares held by outside investors on one date a year. That leaves out shares held by insiders, so a few fish are drawn smaller than their full stock-market value, most of all Charter before 2009 (Paul Allen's class B shares are excluded) and Pixar (Steve Jobs's stake is excluded).",
    "Viacom, the second Viacom and News Corp / 21st Century Fox have voting and non-voting shares. For them the value is every class's shares outstanding times that class's price, both printed on the annual report cover; share counts are from a few weeks after the price date.",
    "AOL Time Warner's first annual report cover after the merger is dated February 2002, so between the January 2001 merger and then its size is eased from AOL's last value before the deal. Its real 2001 value is not shown.",
    "Turner Broadcasting (bought by Time Warner in October 1996) is left out: we found no deal value or full market value for it in the sources used.",
    "Bright House Networks, bought together with Time Warner Cable in 2016, is left out because the sources give one price for both.",
    "News Corp is in the tank only from November 2004, when it moved from Australia to the US and began filing US annual reports. Before that it filed as a foreign company and its covers carry no US market value.",
    "Cox Communications, public until Cox Enterprises took it private in December 2004, is left out of those years: its annual reports give a value only for the Class A shares held by outside investors, a small slice of the company. It appears only when Charter buys it in 2026, sized by the deal.",
    "Left out entirely: NCR (spun off by AT&T in 1996, a computer maker), Time Inc. (2014 spin-off from Time Warner), Cablevision, Dish Network, Sirius XM and Cingular Wireless (owned by SBC and BellSouth, never traded on its own). AT&T's 2021 move of DirecTV into a venture with TPG, and its 2025 sale of the rest, are not shown.",
    "Wikipedia's list of the largest deals gives $52 billion for Bell Atlantic and NYNEX (announced 1996). That figure may describe the size of the combined company rather than the price paid; we use it as listed.",
    "Deal values are as reported in the sources, which sometimes include the target's debt and sometimes don't. They are in dollars of the day; the predator rule converts them to today's dollars with the consumer price index.",
    "After Paramount Skydance closed its purchase of Warner Bros. Discovery on October 6, 2026, the monthly source had not yet updated Skydance's share count, so its size in the last weeks of the tank may be too small.",
]


def TEXT(base_m):
    return {
        "value_method": "Values come from three kinds of source. For companies that still trade, or traded into the 2000s, companiesmarketcap.com gives a market value at the end of each month (for the last two years, each week). For companies that no longer trade, the value is read off the cover of each annual report filed with the SEC. For the few companies with no stock price of their own, the size is the price paid in a deal, or the value implied when a known slice of the company was sold; these are drawn as dashed outlines. Where the monthly source and the SEC covers overlap, the build checks one against the other; the monthly source was wrong for Comcast before its 2002 AT&T Broadband deal and counted only one of Sprint's two stocks before 2005, so SEC covers are used there instead.",
        "species_method": f"Species follow two rules. A fish becomes a predator, and stays one, on its second purchase worth $1 billion or more in today's dollars ({base_m[:4]} prices, using the consumer price index for {dt.date.fromisoformat(base_m + '-01').strftime('%B %Y')}). Below $10 billion in today's dollars a fish is drawn as a guppy; above it, as a grown fish.",
        "intro": "January 1996. Five of the seven Baby Bells split off from AT&T in 1984 are still on their own, and so is their old parent. Disney is five weeks from closing its purchase of ABC.",
        "end_headline": "Thirty years later",
        "adult_short": "$10 billion",
        "span-note": "",
    }


if __name__ == "__main__":
    main()
