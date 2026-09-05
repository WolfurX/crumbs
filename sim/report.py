"""Render the economy simulation as a single HTML page with inline SVG charts. Usage: report.py sim.json out.html"""
import json, math, sys
from datetime import date

data = json.load(open(sys.argv[1]))
solo, firsts, pop, bakers, sybil = data["solo"], data["firsts"], data["population"], data["bakers"], data["sybil"]
P = data["params"]
DAYS = len(next(iter(solo.values())))
ORDER = ["casual", "active", "grinder", "bot", "farm"]
LABEL = {"casual": "Casual, 10 min a day", "active": "Active, 1 hour a day", "grinder": "Grinder, 4 hours a day", "bot": "Bot, 24/7 at the cap", "farm": "Farm account, 200 clicks a day"}
SHORT = {"casual": "Casual", "active": "Active", "grinder": "Grinder", "bot": "Bot", "farm": "Farm"}
COLOR = {k: f"var(--s{i+1})" for i, k in enumerate(ORDER)}

def fmt(n):
    if n >= 1e12: return f"{n/1e12:.1f}T"
    if n >= 1e9: return f"{n/1e9:.1f}B"
    if n >= 1e6: return f"{n/1e6:.1f}M"
    if n >= 1e3: return f"{n/1e3:.0f}K"
    return f"{n:,.0f}" if n >= 10 or n == 0 else f"{n:.1f}"

def esc(s): return str(s).replace("&", "&amp;").replace("<", "&lt;")

def line_chart(series, ylabel, log=False, yfmt=fmt, w=760, h=300, title=""):
    """series: list of (key, [values per day]). Direct end labels, legend, hover tooltip via <title>."""
    ml, mr, mt, mb = 56, 118, 16, 34
    pw, ph = w - ml - mr, h - mt - mb
    allv = [v for _, vs in series for v in vs if v > 0]
    if log:
        lo = 10 ** math.floor(math.log10(min(allv))); hi = 10 ** math.ceil(math.log10(max(allv)))
        ys = lambda v: mt + ph - (math.log10(max(v, lo)) - math.log10(lo)) / (math.log10(hi) - math.log10(lo)) * ph
        ticks = [10 ** e for e in range(int(math.log10(lo)), int(math.log10(hi)) + 1)]
    else:
        hi = max(allv); step = 10 ** math.floor(math.log10(hi)); step = step if hi / step >= 3 else step / 2
        hi = math.ceil(hi / step) * step; lo = 0
        ys = lambda v: mt + ph - (v - lo) / (hi - lo) * ph
        ticks = [lo + i * step for i in range(int(round((hi - lo) / step)) + 1)]
    xs = lambda d: ml + d / (DAYS - 1) * pw
    out = [f'<svg class="chart" viewBox="0 0 {w} {h}" role="img" aria-label="{esc(title)}">']
    for t in ticks:
        y = ys(t)
        out.append(f'<line x1="{ml}" x2="{ml+pw}" y1="{y:.1f}" y2="{y:.1f}" class="grid"/>')
        out.append(f'<text x="{ml-8}" y="{y+4:.1f}" class="tick" text-anchor="end">{yfmt(t)}</text>')
    for d in (0, 6, 13, 20, 29):
        out.append(f'<text x="{xs(d):.1f}" y="{h-10}" class="tick" text-anchor="middle">day {d+1}</text>')
    out.append(f'<line x1="{ml}" x2="{ml+pw}" y1="{mt+ph}" y2="{mt+ph}" class="axis"/>')
    ends = []
    for key, vs in series:
        pts = " ".join(f"{xs(i):.1f},{ys(v):.1f}" for i, v in enumerate(vs))
        out.append(f'<polyline points="{pts}" fill="none" stroke="{COLOR[key]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>')
        out.append(f'<circle cx="{xs(DAYS-1):.1f}" cy="{ys(vs[-1]):.1f}" r="4" fill="{COLOR[key]}" class="ring"/>')
        ends.append((ys(vs[-1]), key, vs[-1]))
    # end labels, nudged apart
    ends.sort()
    last = -99
    for y, key, v in ends:
        y = max(y, last + 14); last = y
        out.append(f'<text x="{ml+pw+10}" y="{y+4:.1f}" class="endlabel"><tspan fill="{COLOR[key]}">●</tspan> {SHORT[key]} {yfmt(v)}</text>')
    out.append('</svg>')
    return "\n".join(out)

def bar_chart(rows, w=760, title="", fmtv=lambda v: f"{v:.1%}", color=None):
    """rows: list of (label, value, colorkey or None). Horizontal, <=24px bars, 4px rounded end."""
    bh, gap, ml, mr = 22, 10, 200, 90
    h = 8 + len(rows) * (bh + gap)
    mx = max(v for _, v, _ in rows) or 1
    pw = w - ml - mr
    out = [f'<svg class="chart" viewBox="0 0 {w} {h}" role="img" aria-label="{esc(title)}">']
    for i, (label, v, ck) in enumerate(rows):
        y = 4 + i * (bh + gap)
        bw = max(2, v / mx * pw)
        fill = COLOR[ck] if ck else (color or "var(--accent)")
        out.append(f'<text x="{ml-10}" y="{y+bh/2+4}" class="barlabel" text-anchor="end">{esc(label)}</text>')
        out.append(f'<path d="M{ml} {y} h{bw-4:.1f} a4 4 0 0 1 4 4 v{bh-8} a4 4 0 0 1 -4 4 h-{bw-4:.1f} z" fill="{fill}"><title>{esc(label)}: {fmtv(v)}</title></path>')
        out.append(f'<text x="{ml+bw+8:.1f}" y="{y+bh/2+4}" class="barval">{fmtv(v)}</text>')
    out.append('</svg>')
    return "\n".join(out)

d = lambda k, i, f: solo[k][i][f]
per_day = pop["per_day"]; counts = pop["counts"]
cookies_series = [(k, [solo[k][i]["produced"] for i in range(DAYS)]) for k in ORDER]
crumb_series = [(k, [per_day[i][k] for i in range(DAYS)]) for k in ORDER]
share_rows = [(f"{SHORT[k]} × {counts[k]}", per_day[DAYS-1][k] * counts[k] / P["pool"], k) for k in ORDER]
sybil_rows = [(f"{r['farms']:,} farm accounts" if r["farms"] else "no farms", r["human_share"], None) for r in sybil]
bot_ratio = {k: (d("bot", 6, "produced") / d(k, 6, "produced"), d("bot", 29, "produced") / d(k, 29, "produced")) for k in ("casual", "active", "grinder")}
tx = {k: d(k, 29, "clicks") + d(k, 29, "purchases") for k in ORDER}
total_tx = pop["tx_per_day"]

html = f"""<title>Crumb Clicker Economy</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">
<style>
:root {{ color-scheme: light; --bg:#f4f2ee; --surface:#ebe7df; --ink:#1a1712; --ink2:#524b41; --muted:#7d746a; --line:rgba(26,23,18,.12); --accent:#a86f1c;
  --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --s4:#eda100; --s5:#e87ba4; --display:"Space Grotesk",system-ui,sans-serif; --body:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; --mono:ui-monospace,Menlo,Consolas,monospace; }}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{ color-scheme: dark; --bg:#12100c; --surface:#1a1712; --ink:#ece6da; --ink2:#b9b1a4; --muted:#877f73; --line:rgba(255,255,255,.10); --accent:#e0a54a; --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500; --s5:#d55181; }} }}
:root[data-theme="dark"] {{ color-scheme: dark; --bg:#12100c; --surface:#1a1712; --ink:#ece6da; --ink2:#b9b1a4; --muted:#877f73; --line:rgba(255,255,255,.10); --accent:#e0a54a; --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500; --s5:#d55181; }}
body {{ margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 var(--body); }}
main {{ max-width: 78ch; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }}
h1,h2,h3 {{ font-family: var(--display); letter-spacing:-.01em; text-wrap: balance; margin:0; }}
h1 {{ font-size: clamp(1.7rem,4vw,2.4rem); line-height:1.1; }}
h2 {{ font-size:1.15rem; margin-top:2.6rem; padding-top:1.2rem; border-top:1px solid var(--line); }}
h3 {{ font-size:1rem; margin-top:1.4rem; }}
p {{ margin: .7rem 0; max-width: 68ch; }}
.eyebrow {{ font-size:.78rem; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }}
.lede {{ color:var(--ink2); font-size:1.05rem; }}
.tiles {{ display:grid; grid-template-columns: repeat(auto-fit,minmax(150px,1fr)); border:1px solid var(--line); border-radius:6px; overflow:hidden; margin:1.4rem 0; }}
.tile {{ padding:.8rem .9rem; border-right:1px solid var(--line); background:var(--surface); }} .tile:last-child {{ border-right:0; }}
.tile .l {{ font-size:.78rem; color:var(--muted); }} .tile .v {{ font-family:var(--display); font-weight:600; font-size:1.35rem; margin-top:.1rem; }}
.tile .s {{ font-size:.8rem; color:var(--ink2); }}
table {{ width:100%; border-collapse:collapse; font-size:.9rem; margin:.8rem 0; }}
th,td {{ text-align:left; padding:.45rem .6rem; border-bottom:1px solid var(--line); vertical-align:top; }}
th {{ color:var(--muted); font-weight:500; font-size:.78rem; letter-spacing:.04em; text-transform:uppercase; }}
td.n, th.n {{ text-align:right; font-variant-numeric: tabular-nums; font-family: var(--mono); font-size:.85rem; }}
.wrap {{ overflow-x:auto; }}
.chart {{ width:100%; height:auto; display:block; margin:.6rem 0 .2rem; }}
.grid {{ stroke: var(--line); stroke-width:1; }} .axis {{ stroke: var(--muted); stroke-width:1; }}
.tick, .barlabel, .barval, .endlabel {{ font: 12px var(--body); fill: var(--ink2); }} .barval {{ fill: var(--ink); }}
.ring {{ stroke: var(--bg); stroke-width:2; }}
figcaption {{ font-size:.82rem; color:var(--muted); margin-bottom:1rem; }}
.rule {{ display:grid; grid-template-columns: 11rem 1fr; gap:.3rem 1.2rem; padding:.6rem 0; border-bottom:1px solid var(--line); }}
.rule b {{ font-weight:600; }} .rule span {{ color:var(--ink2); }}
@media (max-width:560px) {{ .rule {{ grid-template-columns:1fr; }} }}
ol li, ul li {{ margin:.35rem 0; }}
.q {{ padding:.7rem 0; border-bottom:1px solid var(--line); }} .q b {{ display:block; }} .q span {{ color:var(--ink2); }}
</style>
<main>
<div class="eyebrow">Crumbs · game design · simulation of {DAYS} days · {date.today().isoformat()}</div>
<h1 style="margin-top:.4rem">Crumb Clicker Economy</h1>
<p class="lede">One click is one transaction. Everything below follows from that constraint, the chain's measured {P['slot']*1000:.0f} ms slot, and a fixed daily pool of CRUMB. Five player archetypes, {DAYS} simulated days, every purchase decided by the same efficiency rule a bot would use.</p>

<div class="tiles">
  <div class="tile"><div class="l">Casual player reaches the last tier</div><div class="v">day {firsts['casual'][-1]}</div><div class="s">target was about three weeks</div></div>
  <div class="tile"><div class="l">Bot output vs casual, day 30</div><div class="v">{bot_ratio['casual'][1]:.2f}×</div><div class="s">{bot_ratio['casual'][0]:.2f}× on day 7, then it narrows</div></div>
  <div class="tile"><div class="l">Bot CRUMB vs active human, day 30</div><div class="v">{per_day[29]['bot']/per_day[29]['active']:.2f}×</div><div class="s">the click cap equalises them</div></div>
  <div class="tile"><div class="l">Chain load at {sum(counts.values())} accounts</div><div class="v">{total_tx/86400:.1f} tps</div><div class="s">on a chain doing about 9 today</div></div>
</div>

<h2>The rules the model runs</h2>
<div class="rule"><b>Click</b><span>One transaction. The program accepts one click per slot per player ({1/P['slot']:.1f} per second at most) and counts at most {P['cap']:,} per day toward rewards; clicks past the daily cap are rejected. A click is worth 1 cookie plus 0.1% of your production rate.</span></div>
<div class="rule"><b>Bakers</b><span>Eight tiers. Cost equals output times a payback time that steps up 2.5× per tier, from 20 minutes to 8.5 days. Every extra unit of a tier costs 15% more.</span></div>
<div class="rule"><b>Idle</b><span>Production accrues whether the tab is open or not, settled from the chain clock on your next transaction, capped at 7 days away.</span></div>
<div class="rule"><b>CRUMB</b><span>A fixed pool of {P['pool']:,.0f} CRUMB per day. {P['cookie_share']:.0%} is split by share of cookies produced that day, {1-P['cookie_share']:.0%} by share of counted clicks. Claim any time; the token is a normal transferable SPL mint.</span></div>
<div class="rule"><b>Entry</b><span>0.01 COOK to the treasury plus about 0.002 COOK of account rent. Friction, not security; see the sybil section.</span></div>
<div class="rule"><b>Session wallet</b><span>A browser keypair signs clicks and purchases. Claims mint to the real wallet.</span></div>

<h2>Bakers</h2>
<div class="wrap"><table>
<tr><th>Tier</th><th class="n">Cost</th><th class="n">Cookies / s</th><th class="n">Payback</th><th class="n">Casual first buy</th><th class="n">Active</th><th class="n">Bot</th></tr>
{''.join(f"<tr><td>{n}</td><td class='n'>{c:,}</td><td class='n'>{r:g}</td><td class='n'>{(c/r/3600):.1f} h</td><td class='n'>day {firsts['casual'][i] or '-'}</td><td class='n'>day {firsts['active'][i] or '-'}</td><td class='n'>day {firsts['bot'][i] or '-'}</td></tr>" for i,(n,c,r) in enumerate(bakers))}
</table></div>
<p>Six tiers with the classic table put everyone on the last tier by day two and made every archetype converge on the same output. Eight tiers with paybacks stretching to days keep a month of progression and leave the last tier as a goal a casual player reaches in the fourth week.</p>

<h2>Production</h2>
<figure>
{line_chart(cookies_series, "cookies per day", log=True, title="Cookies produced per day by archetype, log scale")}
<figcaption>Cookies produced per day, log scale. The bot's edge is reinvesting every second; it is largest in week one and shrinks as paybacks lengthen.</figcaption>
</figure>
<div class="wrap"><table>
<tr><th>Archetype</th><th class="n">Day 1</th><th class="n">Day 7</th><th class="n">Day 30</th><th class="n">Rate, day 30</th><th class="n">Counted clicks / day</th><th class="n">Transactions / day</th></tr>
{''.join(f"<tr><td>{LABEL[k]}</td><td class='n'>{fmt(d(k,0,'produced'))}</td><td class='n'>{fmt(d(k,6,'produced'))}</td><td class='n'>{fmt(d(k,29,'produced'))}</td><td class='n'>{fmt(d(k,29,'cps'))}/s</td><td class='n'>{d(k,29,'clicks'):,.0f}</td><td class='n'>{tx[k]:,.0f}</td></tr>" for k in ORDER)}
</table></div>
<p>Bot output divided by human output: casual {bot_ratio['casual'][0]:.2f}× on day 7 and {bot_ratio['casual'][1]:.2f}× on day 30; active {bot_ratio['active'][0]:.2f}× and {bot_ratio['active'][1]:.2f}×; grinder {bot_ratio['grinder'][0]:.2f}× and {bot_ratio['grinder'][1]:.2f}×. A farm account that clicks 200 times a day produces {d('farm',29,'produced')/d('bot',29,'produced'):.1%} of what a bot clicking 5,000 times produces: clicking is worth almost nothing in cookies, by design, so there is no reason to bot the clicking.</p>

<h2>Rewards</h2>
<figure>
{line_chart(crumb_series, "CRUMB per account per day", title="CRUMB earned per account per day, population of " + str(sum(counts.values())))}
<figcaption>CRUMB per account per day with {counts['casual']} casual, {counts['active']} active, {counts['grinder']} grinder, {counts['bot']} bot and {counts['farm']} farm accounts sharing the pool. Early days pay more because fewer cookies compete for the same pool.</figcaption>
</figure>
<figure>
{bar_chart(share_rows, title="Share of the daily pool by group, day 30")}
<figcaption>Share of the {P['pool']:,.0f} CRUMB pool on day 30 by group. Humans hold {sum(per_day[29][k]*counts[k] for k in ('casual','active','grinder'))/P['pool']:.0%}.</figcaption>
</figure>
<p>Because the pool is fixed, a bot cannot mint more CRUMB than a human who plays an hour a day: {per_day[29]['bot']:.1f} against {per_day[29]['active']:.1f} on day 30. The 30% click share is where an attentive human beats a farm: {P['cap']:,} counted clicks is about 38 minutes at the cap, a farm that only bootstraps gets a fraction of that share.</p>
<p>Supply is a schedule, not a function of players: {P['pool']:,.0f} a day is {P['pool']*30:,.0f} a month and {P['pool']*365:,.0f} a year. A yearly halving is one line in the program if you want scarcity to tighten.</p>

<h2>Sybil farms, the honest weak point</h2>
<figure>
{bar_chart(sybil_rows, title="Human share of the pool against farm size")}
<figcaption>Human share of the daily pool as a sybil farm grows, with the same 370 human accounts. Running 1,000 farm accounts costs about {sybil[3]['farm_cost_cook_per_day']:.0f} COOK a day in fees plus {sybil[3]['farm_entry_cook']:.0f} COOK to enter, a fraction of a cent.</figcaption>
</figure>
<p>Fees cannot stop sybils on a chain where a thousand transactions cost a hundredth of a cent. What the fixed pool does is bound the damage to dilution: farms cannot inflate the supply, they take share. At 200 farm accounts humans still hold {sybil[2]['human_share']:.0%}; at 1,000 they hold {sybil[3]['human_share']:.0%}.</p>
<p>The one deterrent that scales with the prize is to price entry in the prize: after the first few hundred players, a new account burns CRUMB to start, and the burn rises with the player count. A farm then has to buy the token it is trying to farm, and every failed farm is supply removed. The leaderboard stays per account, so farms never show up as one big name.</p>

<h2>Chain load</h2>
<p>Every click lands on chain. The daily click cap bounds any one account at {P['cap']:,} transactions a day ({P['cap']/86400:.3f} tps). The modelled population of {sum(counts.values())} accounts adds {total_tx/86400:.1f} tps to a chain that carries about 9 today. A thousand active players would add about {1000*5000/86400:.0f} tps. The validators can take that; the public RPC and the Cookiescan indexer are the parts to watch, and Crumbs already sends through the public RPC.</p>

<h2>What is still your call</h2>
<div class="q"><b>Pool size and halving</b><span>{P['pool']:,.0f} CRUMB a day sets the unit; only ratios matter. Halve yearly or leave flat.</span></div>
<div class="q"><b>Click share of the pool</b><span>30% makes an attentive human out-earn a farm on that slice. 20% or 40% shift the game toward idle or toward clicking.</span></div>
<div class="q"><b>Daily click cap</b><span>5,000 is 38 minutes at full speed. Lower it and the click share gets more egalitarian; raise it and grinders pull ahead.</span></div>
<div class="q"><b>CRUMB-priced entry</b><span>Start it after N players, at what burn, rising how fast. The only lever that grows with the token.</span></div>
<div class="q"><b>Names and skins</b><span>Cursor, Grandma, Oven, Bakery, Factory, Validator, Bridge, Cookie Jar. Rename freely; the numbers stay.</span></div>
</main>
"""
open(sys.argv[2], "w").write(html)
print("wrote", sys.argv[2], len(html), "bytes")
