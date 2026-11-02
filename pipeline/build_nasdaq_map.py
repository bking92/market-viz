"""Build data for the 'Nasdaq-100 as a map of the US' story.

Inputs (all in data/raw/):
  nasdaq100_list_snapshot.csv  stockanalysis.com/list/nasdaq-100-stocks/ as fetched (prices match Oct 23, 2026 closes)
  closes.csv                   ticker,date,close,source_url  (daily Close column from stockanalysis.com history pages)
  states_albers.geojson        us-atlas 3.0.1 states-albers-10m (Census cartographic boundaries, pre-projected Albers equal-area)
Outputs (data/):
  caps.csv, map.json, meta.json
"""
import csv, json, math, sys, os
from collections import defaultdict
from shapely.geometry import shape, box, mapping, Polygon, MultiPolygon
from shapely.ops import unary_union
from shapely import affinity

HERE = sys.argv[1] if len(sys.argv) > 1 else '.'
RAW = os.path.join(HERE, 'data', 'raw'); OUT = os.path.join(HERE, 'data')

def parse_cap(s):
    s = s.strip(); return float(s[:-1]) * {'T': 1e12, 'B': 1e9}[s[-1]]

# Members, share counts and daily market values come from the tech-selloff pipeline (SEC cover-page shares x Yahoo closes),
# so both stories use one set of numbers. Our own stockanalysis.com closes (data/raw/closes.csv) are kept as a cross-check.
LIVE = os.path.join(HERE, '..', 'tech-selloff', 'data')
names = {r['ticker']: r['name'] for r in csv.DictReader(open(os.path.join(LIVE, 'constituent_mcap.csv')))}
daily = defaultdict(dict)
for r in csv.DictReader(open(os.path.join(LIVE, 'constituent_daily.csv'))):
    daily[r['ticker']][r['date']] = (float(r['close']), float(r['mcap']))
dates = sorted({d for t in daily for d in daily[t]})
companies, gaps = [], []
for t, nm in names.items():
    miss = [d for d in dates if d not in daily[t]]
    if miss: gaps.append({'ticker': t, 'why': f'no close on {len(miss)} days'}); continue
    companies.append({'t': t, 'name': nm, 'cap': [daily[t][d][1] for d in dates]})
# cross-check against independently fetched closes
own = defaultdict(dict)
for r in csv.DictReader(open(os.path.join(RAW, 'closes.csv'))): own[r['ticker']][r['date']] = float(r['close'])
xc = [(t, d) for t in daily for d in daily[t] if d in own.get(t, {})]
xc_bad = [(t, d, own[t][d], daily[t][d][0]) for t, d in xc if abs(own[t][d] - daily[t][d][0]) > 0.011]
live_meta = json.load(open(os.path.join(LIVE, 'meta.json')))
crosscheck = {'compared': len(xc), 'mismatched': len(xc_bad), 'examples': xc_bad[:10]}
total = [sum(co['cap'][k] for co in companies) for k in range(len(dates))]
pk = max(range(len(dates)), key=lambda k: total[k])
last = len(dates) - 1
trough = min(range(pk, len(dates)), key=lambda k: total[k])
companies.sort(key=lambda co: -co['cap'][pk])
W0 = [co['cap'][pk] for co in companies]

# ---- geometry
gj = json.load(open(os.path.join(RAW, 'states_albers.geojson')))
states = {f['id']: (f['properties']['name'], shape(f['geometry']).buffer(0)) for f in gj['features'] if f['id'] not in ('02', '15')}
conus = unary_union([g for _, g in states.values()]).buffer(0)
A = conus.area

def cut(poly, frac, axis):
    minx, miny, maxx, maxy = poly.bounds
    lo, hi = (minx, maxx) if axis == 0 else (miny, maxy)
    target = frac * poly.area
    for _ in range(50):
        mid = (lo + hi) / 2
        half = box(minx - 1, miny - 1, mid, maxy + 1) if axis == 0 else box(minx - 1, miny - 1, maxx + 1, mid)
        if poly.intersection(half).area < target: lo = mid
        else: hi = mid
    mid = (lo + hi) / 2
    a = box(minx - 1, miny - 1, mid, maxy + 1) if axis == 0 else box(minx - 1, miny - 1, maxx + 1, mid)
    b = box(mid, miny - 1, maxx + 1, maxy + 1) if axis == 0 else box(minx - 1, mid, maxx + 1, maxy + 1)
    return poly.intersection(a), poly.intersection(b)

def build_tree(poly, idx, w):
    if len(idx) == 1: return {'leaf': idx[0]}
    tot = sum(w[i] for i in idx); best, acc = None, 0
    for j in range(1, len(idx)):
        acc += w[idx[j - 1]]
        if best is None or abs(acc / tot - 0.5) < abs(best[1] - 0.5): best = (j, acc / tot)
    j = best[0]
    minx, miny, maxx, maxy = poly.bounds
    axis = 0 if (maxx - minx) >= (maxy - miny) else 1
    a, b = cut(poly, best[1], axis)
    return {'axis': axis, 'L': build_tree(a, idx[:j], w), 'R': build_tree(b, idx[j:], w), 'nL': j}

def apply_tree(node, poly, idx, w, out):
    if 'leaf' in node: out[node['leaf']] = poly; return
    j = node['nL']; tot = sum(w[i] for i in idx)
    frac = sum(w[i] for i in idx[:j]) / tot
    a, b = cut(poly, frac, node['axis'])
    apply_tree(node['L'], a, idx[:j], w, out); apply_tree(node['R'], b, idx[j:], w, out)

idx = list(range(len(companies)))
tree = build_tree(conus, idx, W0)
regions = {}; apply_tree(tree, conus, idx, W0, regions)

def path(g, tol=0.12):
    g = g.simplify(tol, preserve_topology=True)
    polys = [g] if isinstance(g, Polygon) else [p for p in getattr(g, 'geoms', []) if isinstance(p, Polygon)]
    s = []
    for p in polys:
        for ring in [p.exterior] + list(p.interiors):
            c = list(ring.coords)
            if len(c) < 3: continue
            s.append('M' + 'L'.join(f'{x:.1f},{y:.1f}' for x, y in c[:-1]) + 'Z')
    return ''.join(s)

def drain_level(g, f):
    """y such that the part of g below y (screen coords: larger y) has area f*area(g)."""
    minx, miny, maxx, maxy = g.bounds
    if f >= 1: return miny
    lo, hi = miny, maxy; target = f * g.area
    for _ in range(40):
        mid = (lo + hi) / 2
        if g.intersection(box(minx - 1, mid, maxx + 1, maxy + 1)).area > target: lo = mid
        else: hi = mid
    return round((lo + hi) / 2, 2)

out_co = []
for i, co in enumerate(companies):
    g = regions[i]
    frac = [co['cap'][k] / co['cap'][pk] for k in range(len(dates))]
    c = g.representative_point(); minx, miny, maxx, maxy = g.bounds
    out_co.append({'t': co['t'], 'name': co['name'], 'share_peak': co['cap'][pk] / total[pk],
                   'cap': [round(x / 1e9, 2) for x in co['cap']],
                   'area_check': g.area / A,
                   'path': path(g), 'bbox': [round(v, 1) for v in (minx, miny, maxx, maxy)],
                   'label': [round(c.x, 1), round(c.y, 1)],
                   'drain': [drain_level(g, f) for f in frac]})

# "After" map: remove the state or pair of states whose combined area is closest to the share of value lost
# (peak to last day), then lay the remaining members out again on the land that is left, at last-day values.
import itertools
lost_share = (total[pk] - total[last]) / total[pk]
cands = [c for k in (1, 2) for c in itertools.combinations(sorted(states), k)]
removed = min(cands, key=lambda c: abs(sum(states[i][1].area for i in c) / A - lost_share))
removed_geom = unary_union([states[i][1] for i in removed]).buffer(0)
remaining = conus.difference(removed_geom).buffer(0)
order = sorted(idx, key=lambda i: -companies[i]['cap'][last])
w_last = [co['cap'][last] for co in companies]
tree_after = build_tree(remaining, order, w_last)
reg_after = {}; apply_tree(tree_after, remaining, order, w_last, reg_after)
after = {'removed': [{'id': i, 'name': states[i][0], 'share': states[i][1].area / A, 'path': path(states[i][1], 0.1)} for i in removed],
         'removed_share': removed_geom.area / A, 'lost_share': lost_share,
         'remaining_path': path(remaining, 0.1),
         'patches': [{'path': path(reg_after[i]), 'label': [round(reg_after[i].representative_point().x, 1), round(reg_after[i].representative_point().y, 1)],
                      'bbox': [round(v, 1) for v in reg_after[i].bounds]} for i in idx]}

# state equivalents (area share of the continental 48, from the same equal-area projection)
state_list = sorted([{'name': n, 'share': g.area / A} for n, g in states.values()], key=lambda s: -s['share'])

meta = {'live_gaps': live_meta.get('gaps', ''), 'live_members_note': live_meta.get('members_note', '').replace('listed below', 'listed in the companion story'), 'crosscheck': crosscheck, 'dates': dates, 'peak_index': pk, 'trough_index': trough, 'last_index': last,
        'total_cap_bn': [round(x / 1e9, 1) for x in total],
        'n_companies': len(companies), 'gaps': gaps,
        'conus_bounds': [round(v, 1) for v in conus.bounds],
        'conus_path': path(conus, 0.1),
        'states_paths': [{'name': n, 'path': path(g, 0.1)} for n, g in states.values()],
        'state_shares': state_list}
json.dump({'meta': meta, 'companies': out_co, 'after': after}, open(os.path.join(OUT, 'map.json'), 'w'), separators=(',', ':'))
with open(os.path.join(OUT, 'caps.csv'), 'w', newline='') as f:
    wr = csv.writer(f); wr.writerow(['ticker', 'name'] + dates)
    for co in companies: wr.writerow([co['t'], co['name']] + [round(x) for x in co['cap']])
json.dump({k: meta[k] for k in ('crosscheck', 'dates', 'peak_index', 'trough_index', 'last_index', 'total_cap_bn', 'n_companies', 'gaps')}, open(os.path.join(OUT, 'meta.json'), 'w'), indent=1)
print('removed', [states[i][0] for i in removed], round(removed_geom.area / A, 5), 'lost', round(lost_share, 5))
print('peak', dates[pk], total[pk] / 1e12, 'last', dates[last], total[last] / 1e12, 'trough', dates[trough], 'n', len(companies))
print('max area error', max(abs(c['area_check'] - c['share_peak']) for c in out_co))
