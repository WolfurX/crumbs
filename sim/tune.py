"""Tune the baker ladder: for a payback ladder, when does each archetype first buy each tier, and how
far apart do a casual player and a 24/7 bot end up? Casual + bot only, 30 days."""
import sys, importlib
import economy as E

def ladder(paybacks_h, cps_list):
    E.BAKERS_SPEC = [(f"T{i}", cps, h * 3600) for i, (cps, h) in enumerate(zip(cps_list, paybacks_h))]
    E.BAKERS = [(n, round(cps * pb), cps) for n, cps, pb in E.BAKERS_SPEC]

CPS8 = [0.1, 1.0, 8.0, 47.0, 260.0, 1_400, 7_800, 44_000]   # Cookie Clicker style ~5.5x steps
candidates = {
    "A 3x from 10m":      [10/60, 0.5, 1.5, 4.5, 13.5, 40.5, 121.5, 364.5],
    "B 3x from 15m":      [0.25, 0.75, 2.25, 6.75, 20.25, 60.75, 182, 546],
    "C 2.5x from 20m":    [1/3, 0.83, 2.08, 5.2, 13, 32.5, 81, 203],
    "D 4x from 10m":      [10/60, 0.67, 2.67, 10.7, 42.7, 171, 683, 2731],
}
for name, pbs in candidates.items():
    ladder(pbs, CPS8)
    res = {}
    for k in ("casual", "active", "bot"):
        p = E.archetypes()[k]
        p.owned = [0] * len(E.BAKERS); p.firsts = [None] * len(E.BAKERS)
        E.simulate(p, 30)
        res[k] = p
    c, b, a = res["casual"], res["bot"], res["active"]
    firsts = " ".join(f"{f or '-'}" for f in c.firsts)
    print(f"{name:16} casual first-unit days [{firsts}]  cps d30 casual {E.fmt(c.daily[29]['cps'])} bot {E.fmt(b.daily[29]['cps'])}  bot/casual cookies d7 {b.daily[6]['produced']/c.daily[6]['produced']:.2f}x d15 {b.daily[14]['produced']/c.daily[14]['produced']:.2f}x d30 {b.daily[29]['produced']/c.daily[29]['produced']:.2f}x  active/casual d30 {a.daily[29]['produced']/c.daily[29]['produced']:.2f}x")
