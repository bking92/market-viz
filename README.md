# Finance in Pictures site

Static site, no build step. Open `index.html` through any static server, for example
`python3 -m http.server` from this folder, then visit http://localhost:8000.

## Hosting
Served by GitHub Pages from the `main` branch root at https://bking92.github.io/market-viz/. All links are relative, so the same files work locally and on Pages. `.nojekyll` makes Pages serve files as-is. `previews/` (review screenshots) stays out of the repo.

## Layout
- `index.html`: the home page, one link per story, newest first.
- `assets/`: shared pieces. `css/site.css` holds the house style. `js/scroller.js` is the scrollytelling driver. `js/d3.min.js` is D3 v7. `fonts/` has Newsreader (text) and Libre Franklin (chart labels), both self-hosted.
- `stories/<slug>/`: one folder per story, with `index.html`, `story.js` and `data/`. The page reads only from `data/`.
- `pipeline/`: one script per story that pulls primary sources and writes that story's `data/` files, plus a `build_log.txt` of every request and check.
- `previews/`: screenshots for review.

## Rules every story follows
- Every number on the page comes from a file in `data/` that a pipeline script wrote. Nothing is typed in by hand.
- Each story ends with "How this was made", sources, known gaps, and the underlying table.
- Brand: treemap logo (`assets/img/logo.svg`, blocks sized by the five largest Nasdaq-100 market caps on Oct 30, 2026). Palette in `site.css`: cream paper `#f6f1e3`, ink `#14110f`, cobalt `--brand` `#1f3cff` for the masthead and main data series, tomato `--loss` `#ff4b23` for value that is gone, citron `#d7ff3c` as a rare highlight. Charts use the CSS variables, never hex codes.
- Style: sentence-case serif headlines, prose carries the story, labels sit on the marks. No all-caps kicker labels, no stacked small subheads, no boxed caveat panels.

## Tech selloff: status (Nov 1, 2026)
- Built from live data on Nov 1, 2026: 209 Nasdaq-100 closes (Jan 2 to Oct 30, 2026) from Yahoo, cross-checked against FRED (max gap 0.22 points; FRED ends Oct 29). Peak Oct 6, latest Oct 30.
- `data/constituent_mcap.csv`: 100 companies in the index on the peak day, value at peak and latest close. `data/constituent_daily.csv`: each company's close and value for every day from peak to latest.
- Members: api.nasdaq.com is blocked from the cloud environment, so the list comes from the Invesco QQQ Trust's latest public N-PORT on SEC EDGAR (holdings as of Jun 30, 2026), CUSIP/ISIN to ticker via api.openfigi.com, plus the hand-maintained `MEMBERSHIP_CHANGES` list in the script (each with a source URL). Update that list when Nasdaq announces changes, or swap to the next N-PORT (Sep 30 holdings should be public around late Nov 2026).
- Shares: summed from every class tagged on the cover of each company's latest 10-Q/10-K/20-F/40-F (companyfacts drops multi-class companies). 20-F counts are divided by the ADS ratio on the cover.
- Rerun: `SEC_USER_AGENT="name email" python3 pipeline/build_tech_selloff.py --start 2026-01-01` (about 10 minutes, rate-limited for Yahoo and SEC).

## Who ate whom (fish tank): status (Nov 2, 2026)

- Page: `stories/fish-tank/index.html`. Data: `stories/fish-tank/data/` (tank.json, values.csv, events.csv, build_log.txt).
- Rebuild from `site/`: `SEC_USER_AGENT="market-viz research pipeline admin@example.com" python3 pipeline/build_fish_tank.py` (needs network to companiesmarketcap.com, data.sec.gov, sec.gov, en.wikipedia.org, fred). The build refuses to run if any quoted source passage is missing.
- 57 fish, 69 events, 10 pauses, 1996 to Oct 2026. Values: companiesmarketcap.com, SEC 10-K cover float where that site is wrong (Comcast pre-2016, Sprint pre-2005), deal prices for firms with no stock.
- URL hooks for checking: `?t=2007` jumps to a year, `?pause=4` jumps to just before a pause.
- Known gaps are listed on the page under "What is left out".
- Brian confirmed: 2 minutes of swimming plus pauses (changed from 90 s on Nov 3); "sources and uses" means sources and method. Look is pixel art (pixel.js), one colour per company.

## How fast do companies make a buck? (Newton's cradles): status (Nov 7, 2026)

- Page: `stories/cradles/index.html`, renderer `cradle.js` (canvas, pendulum motion, motion blur at high clock speeds). Data: `stories/cradles/data/` (companies.csv, meta.json, build_log.txt).
- Profit = us-gaap `NetIncomeLoss` over the latest twelve reported months (FY + YTD − prior YTD) from SEC company facts, checked against four discrete quarters. Seconds per $1M uses the window's real length.
- Rebuild: `SEC_USER_AGENT="your name you@example.com" AS_OF=YYYY-MM-DD python3 pipeline/build_cradles.py`. Company list and groups are at the top of the script; loss-makers are decided by the data, not the list.
- Excluded: Beyond Meat (TTM and four-quarter sum disagree by $10.8M). Berkshire's net income includes unrealized investment gains; flagged on the page.

## Where your $20 goes at Uber: status (Nov 8, 2026)

- Page: `stories/uber/index.html`. Data: `stories/uber/data/quarters.csv`, `meta.json`, `build_log.txt`.
- Source tables: Uber's 30 quarterly earnings releases (8-K Exhibit 99.1, Q2 2019 to Q3 2026) and the April 2019 S-1/A. www.sec.gov refuses scripted downloads from the cloud environment, so the tables were read page by page and copied into `data/raw/releases_compact.txt` and `data/raw/releases_transcribed.csv`, one line per table per quarter, each naming its source file. Brian chose this route on Nov 8, 2026.
- Rebuild: `SEC_USER_AGENT="name email" python3 pipeline/build_uber.py`. It checks segment sums, overlapping releases and SEC XBRL revenue, and stops on any failure. To add a quarter, copy the new release's tables into `releases_compact.txt` in the same format.
- Known gaps: no regional gross bookings; regional revenue only to Q2 2023; revenue before Q4 2019 only as first reported (not used for take rates).
