# -*- coding: utf-8 -*-
# 测 · 多模式证据图表
#   python tracker/make_charts_extra.py
# 输出:
#   tracker/reports/model-skill.png     # 5 个数值模式 8 周误差对比
# (早期同时生成 source-skill.png 三商业源对比图,已由 make_charts_sources.py
#  的 sources-compare.png 取代,过程版本归档于 tracker/archive/)

import json
import pathlib

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

plt.rcParams['font.sans-serif'] = ['Microsoft YaHei', 'SimHei']
plt.rcParams['axes.unicode_minus'] = False

ROOT = pathlib.Path(__file__).resolve().parent
REP = ROOT / 'reports'
REP.mkdir(exist_ok=True)

# ── 图 1(B 方案,真实数据):多模式技巧对比 ──
S = json.loads((ROOT / 'data' / 'summary-models.json').read_text(encoding='utf-8'))
MODEL_LABEL = {
    'ecmwf_ifs025': 'ECMWF IFS\n(欧洲)',
    'gfs_seamless': 'GFS\n(美国)',
    'icon_seamless': 'ICON\n(德国)',
    'jma_seamless': 'JMA GSM\n(日本)',
    'cma_grapes_global': 'GRAPES\n(中国)',
}
models = [m for m in MODEL_LABEL if m in S['perModel']]
m1 = [S['perModel'][m]['maeTmaxF1'] for m in models]
m3 = [S['perModel'][m]['maeTmaxF3'] for m in models]
bias = [S['perModel'][m]['biasTmaxF1'] for m in models]
pod = [S['perModel'][m]['pod'] for m in models]

fig, (a1, a2) = plt.subplots(1, 2, figsize=(11, 4.6), dpi=150)
x = range(len(models))
a1.bar([i - .19 for i in x], m1, width=.38, color='#d4875a', label='提前 1 天')
a1.bar([i + .19 for i in x], m3, width=.38, color='#5a7ca8', label='提前 3 天')
a1.set_xticks(list(x)); a1.set_xticklabels([MODEL_LABEL[m] for m in models], fontsize=9)
a1.set_ylabel('日最高气温 MAE(°C)')
a1.set_title('五个全球数值模式预报误差(真实历史数据)')
a1.legend(); a1.grid(axis='y', alpha=.3)
for i, (v, b) in enumerate(zip(m1, bias)):
    a1.text(i - .19, v + .03, f'{v}', ha='center', fontsize=8)
    a1.text(i, max(m1[i], m3[i]) + .22, f'偏差{b:+.2f}', ha='center', fontsize=7.5, color='#666')

a2.bar(list(x), pod, width=.5, color='#6a9955')
a2.set_xticks(list(x)); a2.set_xticklabels([MODEL_LABEL[m] for m in models], fontsize=9)
a2.set_ylim(0, 100)
a2.set_title('降水命中率 POD(%),日雨量 ≥0.2 mm')
a2.grid(axis='y', alpha=.3)
for i, v in zip(x, pod):
    a2.text(i, v + 1.5, f'{v}%', ha='center', fontsize=9)

fig.suptitle(f"多模式回溯:{S['cityCount']} 城 × {S['daysPerCity']} 天,实况参照 best_match day-0(数据:Open-Meteo Previous Runs API)", fontsize=10)
fig.tight_layout()
fig.savefig(REP / 'model-skill.png')
plt.close(fig)

print('charts saved:', REP / 'model-skill.png')
