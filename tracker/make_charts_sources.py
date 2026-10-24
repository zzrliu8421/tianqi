# -*- coding: utf-8 -*-
# 测 · 多源准确性对比图(附件素材)
#   python tracker/make_charts_sources.py
# 输出 tracker/reports/sources-compare.png

import json
import pathlib

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

plt.rcParams['font.sans-serif'] = ['Microsoft YaHei', 'SimHei']
plt.rcParams['axes.unicode_minus'] = False

ROOT = pathlib.Path(__file__).resolve().parent
S = json.loads((ROOT / 'data' / 'summary-sources.json').read_text(encoding='utf-8'))
REP = ROOT / 'reports'
REP.mkdir(exist_ok=True)

NAMES = {'openmeteo': 'Open-Meteo', 'caiyun': '彩云天气', 'amap_qweather': '高德+和风'}
COLORS = {'openmeteo': '#5a7ca8', 'caiyun': '#d4875a', 'amap_qweather': '#6a9955'}
keys = list(NAMES.keys())

fig, (a1, a2) = plt.subplots(1, 2, figsize=(11, 4.4), dpi=150)

# 左:整体 MAE(提前 1 天 vs 3 天)
x = range(len(keys))
f1 = [S['perSource'][k]['maeTmaxF1'] for k in keys]
f3 = [S['perSource'][k]['maeTmaxF3'] for k in keys]
a1.bar([i - 0.18 for i in x], f1, width=0.36, color=[COLORS[k] for k in keys], label='提前 1 天')
a1.bar([i + 0.18 for i in x], f3, width=0.36, color=[COLORS[k] for k in keys], alpha=0.45, label='提前 3 天')
a1.set_xticks(list(x))
a1.set_xticklabels([NAMES[k] for k in keys])
a1.set_ylabel('日最高气温 MAE(°C)')
a1.set_title('多源预报误差对比(6 城 × 8 周 = 336 城市日)')
a1.legend()
a1.grid(axis='y', alpha=0.3)
for i, (v1, v3) in enumerate(zip(f1, f3)):
    a1.text(i - 0.18, v1 + 0.02, f'{v1}', ha='center', fontsize=9)
    a1.text(i + 0.18, v3 + 0.02, f'{v3}', ha='center', fontsize=9)

# 右:分城市 MAE(提前 1 天)
cities = list(S['perCityMatrix'].keys())
xc = range(len(cities))
w = 0.26
for j, k in enumerate(keys):
    vals = [S['perCityMatrix'][c][k]['maeTmaxF1'] for c in cities]
    a2.bar([i + (j - 1) * w for i in xc], vals, width=w, color=COLORS[k], label=NAMES[k])
    for i, v in zip(xc, vals):
        a2.text(i + (j - 1) * w, v + 0.015, f'{v:.1f}', ha='center', fontsize=7)
a2.set_xticks(list(xc))
a2.set_xticklabels(cities)
a2.set_ylabel('MAE(°C,提前 1 天)')
a2.set_title('分城市对比(每源每城 56 天)')
a2.legend(fontsize=8)
a2.grid(axis='y', alpha=0.3)

fig.tight_layout()
fig.savefig(REP / 'sources-compare.png')
print('saved:', REP / 'sources-compare.png')
