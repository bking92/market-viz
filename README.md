# Market Visualization site

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
- Brian confirmed: 90 s of swimming plus pauses; "sources and uses" means sources and method. Look is pixel art (pixel.js), one colour per company.
