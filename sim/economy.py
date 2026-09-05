"""Crumb Clicker economy simulator, v2. Deterministic, stdlib only.

Hard constraint: one click = one transaction. Measured slot time 0.45 s; the program takes at most one
click per slot per player (ceiling 2.2 clicks/s) and at most DAILY_CLICK_CAP counted clicks per day.

Design targets this version is tuned against:
  T1 a casual player (10 min/day) reaches the last tier in roughly three weeks, not on day two
  T2 clicking matters for CRUMB in a way a bot cannot out-scale a dedicated human
  T3 CRUMB supply is fixed per day (a pool split by share), so bots and sybils dilute, never inflate
  T4 a 24/7 bot's advantage over an active human stays under 2x on a per-account basis
"""
from __future__ import annotations
import json, sys
from dataclasses import dataclass, field

SLOT_S = 0.45
CLICK_CAP_PER_SLOT = 1
MAX_CLICKS_PER_S = CLICK_CAP_PER_SLOT / SLOT_S
DAY = 86_400
DAILY_CLICK_CAP = 5_000            # counted clicks per player per day (~38 min at the cap)
OFFLINE_CAP_S = 7 * DAY

# Bakers: cookies per second and the payback time of the FIRST unit; cost = cps x payback, rounded.
# Ladder C from sim/tune.py: paybacks step 2.5x from 20 minutes, cps steps ~5.5x (the Cookie Clicker
# ratios). Chosen because a casual player reaches the last tier around day 23 and a 24/7 bot ends up
# at about 1.25x a casual player's output by day 30.
BAKERS_SPEC = [
    ("Cursor",      0.1,    20 * 60),
    ("Grandma",     1.0,    50 * 60),
    ("Oven",        8.0,    125 * 60),
    ("Bakery",      47.0,   5.2 * 3600),
    ("Factory",     260.0,  13 * 3600),
    ("Validator",   1_400.0, 32.5 * 3600),
    ("Bridge",      7_800.0, 81 * 3600),
    ("Cookie Jar",  44_000.0, 203 * 3600),
]
def _round_cost(c: float) -> int:
    mag = 10 ** max(0, len(str(int(c))) - 2)
    return int(round(c / mag) * mag)
BAKERS = [(n, _round_cost(cps * payback), cps) for n, cps, payback in BAKERS_SPEC]
GROWTH = 1.15

# Emission: a fixed daily pool, split 70/30 between cookie production share and counted-click share.
DAILY_POOL = 10_000.0
POOL_COOKIE_SHARE = 0.70
POOL_CLICK_SHARE = 0.30

CLICK_VALUE_PCT_OF_CPS = 0.001     # a click is worth 1 cookie + 0.1% of current cps (keeps numbers moving)

def price(tier: int, owned: int) -> float:
    return BAKERS[tier][1] * GROWTH ** owned

@dataclass
class Player:
    name: str
    online_s_per_day: float
    sessions_per_day: int
    click_rate: float
    click_budget: int = DAILY_CLICK_CAP   # how many clicks this archetype bothers to make per day
    cookies: float = 0.0
    cps: float = 0.0
    owned: list = field(default_factory=lambda: [0] * len(BAKERS))
    lifetime: float = 0.0
    clicks: int = 0
    counted_clicks_today: int = 0
    purchases: int = 0
    daily: list = field(default_factory=list)   # per day: dict(produced, clicks_counted, clicks_sent, cps, purchases)
    firsts: list = field(default_factory=lambda: [None] * len(BAKERS))

    def buy_greedy(self, day):
        """Cookie Clicker efficiency rule: aim at the tier with the best payback overall. Buy it when
        affordable; otherwise buy a cheaper tier only if it repays itself before you could have saved
        up for the target anyway. Everyone uses this policy when online; bots run it every second."""
        while True:
            paybacks = [price(t, self.owned[t]) / BAKERS[t][2] for t in range(len(BAKERS))]
            target = min(range(len(BAKERS)), key=lambda t: paybacks[t])
            target_price = price(target, self.owned[target])
            if target_price <= self.cookies:
                buy = target
            else:
                time_to_save = (target_price - self.cookies) / self.cps if self.cps > 0 else float("inf")
                buy = None
                for t in range(len(BAKERS)):
                    if t != target and price(t, self.owned[t]) <= self.cookies and paybacks[t] < time_to_save:
                        if buy is None or paybacks[t] < paybacks[buy]:
                            buy = t
                if buy is None:
                    return
            self.cookies -= price(buy, self.owned[buy])
            self.owned[buy] += 1
            self.cps += BAKERS[buy][2]
            self.purchases += 1
            if self.firsts[buy] is None:
                self.firsts[buy] = day + 1

def simulate(p: Player, days: int, step: float = 1.0):
    per_session = p.online_s_per_day / max(1, p.sessions_per_day)
    gap = (DAY - p.online_s_per_day) / max(1, p.sessions_per_day)
    rate = min(p.click_rate, MAX_CLICKS_PER_S)
    for d in range(days):
        produced0, clicks0, purchases0 = p.lifetime, p.clicks, p.purchases
        counted = 0
        for _ in range(p.sessions_per_day):
            t = 0.0
            while t < per_session:
                gain = p.cps * step
                if rate > 0 and counted < min(DAILY_CLICK_CAP, p.click_budget):
                    n = min(rate * step, min(DAILY_CLICK_CAP, p.click_budget) - counted)
                    gain += n * (1 + CLICK_VALUE_PCT_OF_CPS * p.cps)
                    p.clicks += n
                    counted += n
                p.cookies += gain
                p.lifetime += gain
                p.buy_greedy(d)
                t += step
            idle = p.cps * min(gap, OFFLINE_CAP_S)
            p.cookies += idle
            p.lifetime += idle
        p.daily.append(dict(produced=p.lifetime - produced0, clicks=counted, cps=p.cps, purchases=p.purchases - purchases0))

def archetypes():
    return {
        "casual":  Player("casual",  online_s_per_day=600,    sessions_per_day=2, click_rate=1.5),
        "active":  Player("active",  online_s_per_day=3600,   sessions_per_day=4, click_rate=1.8),
        "grinder": Player("grinder", online_s_per_day=14_400, sessions_per_day=6, click_rate=9.9),
        "bot":     Player("bot",     online_s_per_day=DAY,    sessions_per_day=1, click_rate=9.9),
        # farm account: a sybil's script that clicks 200 times a day to bootstrap, then only reinvests
        "farm":    Player("farm",    online_s_per_day=DAY,    sessions_per_day=1, click_rate=9.9, click_budget=200),
    }

def population_scenario(days: int, counts: dict):
    """Split the daily pool across a population. counts = {archetype: number of accounts}."""
    players = {k: archetypes()[k] for k in counts}
    for p in players.values():
        simulate(p, days)
    per_day = []
    for d in range(days):
        tot_cookies = sum(players[k].daily[d]["produced"] * n for k, n in counts.items())
        tot_clicks = sum(players[k].daily[d]["clicks"] * n for k, n in counts.items())
        row = {}
        for k, n in counts.items():
            dd = players[k].daily[d]
            share_c = dd["produced"] / tot_cookies if tot_cookies else 0
            share_k = dd["clicks"] / tot_clicks if tot_clicks else 0
            row[k] = DAILY_POOL * (POOL_COOKIE_SHARE * share_c + POOL_CLICK_SHARE * share_k)
        per_day.append(row)
    return players, per_day

def fmt(n):
    if n >= 1e12: return f"{n/1e12:.2f}T"
    if n >= 1e9: return f"{n/1e9:.2f}B"
    if n >= 1e6: return f"{n/1e6:.2f}M"
    if n >= 1e3: return f"{n/1e3:.1f}K"
    return f"{n:.2f}"

if __name__ == "__main__":
    days = 30
    print(f"slot {SLOT_S}s, {CLICK_CAP_PER_SLOT}/slot -> {MAX_CLICKS_PER_S:.2f} clicks/s; daily counted cap {DAILY_CLICK_CAP:,} (~{DAILY_CLICK_CAP/MAX_CLICKS_PER_S/60:.0f} min at the cap)")
    print("bakers (cost = cps x payback):")
    for (n, c, r), (_, _, pb) in zip(BAKERS, BAKERS_SPEC):
        print(f"  {n:9} cost {c:>12,} cps {r:>7} payback {pb/3600:>6.1f}h")
    res = {k: archetypes()[k] for k in archetypes()}
    for p in res.values(): simulate(p, days)
    print(f"\n{'archetype':8} {'d1 cookies':>11} {'d7':>9} {'d30':>9} {'cps d7':>8} {'cps d30':>8} {'clicks/d':>9} {'tx/d (d30)':>10}  first unit per tier")
    for k, p in res.items():
        d = p.daily
        tx = d[29]["clicks"] + d[29]["purchases"]
        firsts = " ".join(f"{BAKERS[t][0][:3]}:d{p.firsts[t]}" if p.firsts[t] else f"{BAKERS[t][0][:3]}:-" for t in range(len(BAKERS)))
        print(f"{k:8} {fmt(d[0]['produced']):>11} {fmt(d[6]['produced']):>9} {fmt(d[29]['produced']):>9} {fmt(d[6]['cps']):>8} {fmt(d[29]['cps']):>8} {d[29]['clicks']:>9,.0f} {tx:>10,.0f}  {firsts}")
    print("\nbot advantage (cookies produced, bot / archetype): " + ", ".join(f"{k} d7 {res['bot'].daily[6]['produced']/res[k].daily[6]['produced']:.2f}x d30 {res['bot'].daily[29]['produced']/res[k].daily[29]['produced']:.2f}x" for k in ("casual","active","grinder")))
    print(f"farm (200 clicks/day) vs bot (5,000 clicks/day) cookies d30: {res['farm'].daily[29]['produced']/res['bot'].daily[29]['produced']:.3f}x  (what clicking is worth to a bot)")

    # population: 300 casual, 60 active, 10 grinders, 5 bots, one sybil farm of 50 idle bots
    counts = {"casual": 300, "active": 60, "grinder": 10, "bot": 5, "farm": 50}
    players, per_day = population_scenario(days, counts)
    print(f"\nCRUMB per account per day, pool {DAILY_POOL:,.0f}/day split {POOL_COOKIE_SHARE:.0%} cookies / {POOL_CLICK_SHARE:.0%} counted clicks, population {counts}")
    print(f"{'archetype':8} {'day1':>8} {'day7':>8} {'day30':>8}   {'group share d30':>15}")
    for k, n in counts.items():
        share = per_day[29][k] * n / DAILY_POOL
        print(f"{k:8} {per_day[0][k]:>8.2f} {per_day[6][k]:>8.2f} {per_day[29][k]:>8.2f}   {share:>14.1%} ({n} accts)")
    total_tx = sum((players[k].daily[29]['clicks'] + players[k].daily[29]['purchases']) * n for k, n in counts.items())
    print(f"\nchain load d30: {total_tx:,.0f} tx/day = {total_tx/DAY:.1f} tps added (baseline ~9 tps)")
    # sybil sensitivity at day 30: humans fixed (300 casual, 60 active, 10 grinders), farms vary
    def shares(counts_, d):
        tc = sum(players[k].daily[d]["produced"] * n for k, n in counts_.items())
        tk = sum(players[k].daily[d]["clicks"] * n for k, n in counts_.items())
        out_ = {}
        for k, n in counts_.items():
            dd = players[k].daily[d]
            out_[k] = n * DAILY_POOL * (POOL_COOKIE_SHARE * (dd["produced"] / tc if tc else 0) + POOL_CLICK_SHARE * (dd["clicks"] / tk if tk else 0))
        return out_
    sybil = []
    for farms in (0, 50, 200, 1000, 5000):
        c_ = {"casual": 300, "active": 60, "grinder": 10, "bot": 5, "farm": farms}
        sh = shares(c_, 29)
        human = sh["casual"] + sh["active"] + sh["grinder"]
        sybil.append(dict(farms=farms, human_share=human / DAILY_POOL, farm_share=sh["farm"] / DAILY_POOL, farm_crumb_per_acct=(sh["farm"] / farms) if farms else 0, casual_crumb=sh["casual"] / 300, farm_cost_cook_per_day=farms * (200 * 5000 + 0) / 1e9, farm_entry_cook=farms * 0.012))
    print("\nsybil sensitivity d30 (humans fixed at 370 accounts):")
    for r in sybil:
        print(f"  farms {r['farms']:>5}: human share {r['human_share']:.1%}, farm share {r['farm_share']:.1%}, CRUMB/farm-acct {r['farm_crumb_per_acct']:.2f}, casual CRUMB {r['casual_crumb']:.2f}, farm tx cost {r['farm_cost_cook_per_day']:.3f} COOK/day + entry {r['farm_entry_cook']:.1f} COOK")
    json.dump({"bakers": BAKERS, "sybil": sybil, "spec": BAKERS_SPEC, "params": dict(slot=SLOT_S, cap=DAILY_CLICK_CAP, pool=DAILY_POOL, cookie_share=POOL_COOKIE_SHARE, growth=GROWTH),
               "solo": {k: p.daily for k, p in res.items()}, "firsts": {k: p.firsts for k, p in res.items()},
               "population": {"counts": counts, "per_day": per_day, "tx_per_day": total_tx}},
              open(sys.argv[1] if len(sys.argv) > 1 else "/dev/null", "w"))
