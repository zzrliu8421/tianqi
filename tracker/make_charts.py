# -*- coding: utf-8 -*-
# 测 · 准确性证据图表(附件素材)
#   python tracker/make_charts.py
# 输出 tracker/reports/error-trend.png 与 tracker/reports/city-skill.png

import json
import pathlib

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

plt.rcParams['font.sans-serif'] = ['Microsoft YaHei', 'SimHei']
plt.rcParams['axes.unicode_minus'] = False

ROOT = pathlib.Path(__file__).resolve().parent
S = json.loads((ROOT / 'data' / 'summary.json').read_text(encoding='utf-8'))
REP = ROOT / 'reports'
REP.mkdir(exist_ok=True)

# ── 图 1:逐日温度误差趋势(提前1天 vs 提前3天,含 7 日滑动平均)──
daily = S['daily']
dates = [d['date'][5:] for d in daily]
f1 = [d['maeTmaxF1'] for d in daily]
f3 = [d['maeTmaxF3'] for d in daily]

def rolling(xs, w=7):
    return [round(sum(xs[max(0, i - w + 1):i + 1]) / len(xs[max(0, i - w + 1):i + 1]), 2) for i in range(len(xs))]

fig, ax = plt.subplots(figsize=(10, 4.6), dpi=150)
ax.plot(dates, f1, color='#d4875a', alpha=.35, lw=1, label='逐日 MAE(提前 1 天)')
ax.plot(dates, f3, color='#5a7ca8', alpha=.35, lw=1, label='逐日 MAE(提前 3 天)')
ax.plot(dates, rolling(f1), color='#d4875a', lw=2.2, label='7 日滑动(提前 1 天)')
ax.plot(dates, rolling(f3), color='#5a7ca8', lw=2.2, label='7 日滑动(提前 3 天)')
ax.axhline(S['overall']['maeTmaxF1'], color='#d4875a', ls=':', lw=1)
ax.axhline(S['overall']['maeTmaxF3'], color='#5a7ca8', ls=':', lw=1)
ax.set_title(f"日最高气温预报误差(6 城平均,{S['totalCityDays']} 个城市日)")
ax.set_ylabel('平均绝对误差 MAE(°C)')
ax.legend(ncol=2, fontsize=9)
ax.grid(axis='y', alpha=.3)
ax.set_xticks(dates[::7])
fig.tight_layout()
fig.savefig(REP / 'error-trend.png')
plt.close(fig)

# ── 图 2:分城市技巧对比(MAE 柱状 + 降水 POD/FAR)──
cities = list(S['perCity'].keys())
m1 = [S['perCity'][c]['maeTmaxF1'] for c in cities]
m3 = [S['perCity'][c]['maeTmaxF3'] for c in cities]
pod = [S['perCity'][c]['pod'] for c in cities]

fig, (a1, a2) = plt.subplots(1, 2, figsize=(10, 4.2), dpi=150)
x = range(len(cities))
a1.bar([i - .18 for i in x], m1, width=.36, color='#d4875a', label='提前 1 天')
a1.bar([i + .18 for i in x], m3, width=.36, color='#5a7ca8', label='提前 3 天')
a1.set_xticks(list(x)); a1.set_xticklabels(cities)
a1.set_title('温度预报 MAE(°C)'); a1.legend(); a1.grid(axis='y', alpha=.3)
for i, v in zip(x, m1): a1.text(i - .18, v + .02, f'{v}', ha='center', fontsize=8)

a2.bar(list(x), pod, width=.5, color='#6a9955')
a2.set_xticks(list(x)); a2.set_xticklabels(cities)
a2.set_ylim(0, 100); a2.set_title('降水命中率 POD(%),日雨量 ≥0.2 mm')
a2.grid(axis='y', alpha=.3)
for i, v in zip(x, pod): a2.text(i, v + 1.5, f'{v}%', ha='center', fontsize=9)

fig.suptitle(f"分城市预报技巧对比(每城 {S['perCity'][cities[0]]['days']} 天,整体 POD {S['overall']['pod']}% / 空报率 {S['overall']['far']}%)")
fig.tight_layout()
fig.savefig(REP / 'city-skill.png')
plt.close(fig)

print('charts saved:', REP / 'error-trend.png', REP / 'city-skill.png')
