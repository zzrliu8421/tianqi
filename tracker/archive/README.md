# 归档 · 过程性与临时文件

tracker 演进过程中被后续版本取代的中间产物。**原始数据均在 `data/`,这些文件全部可由脚本随时重新生成**,归档仅为保持 `reports/` 只含最终产物;引用证据请使用 `reports/` 下的现行版本。

| 归档文件 | 原用途 | 被什么取代 |
|---|---|---|
| `<city>-daily.csv` × 6(2026-08-27 ~ 10-21 窗口) | 首版 OM 单源汇总(`report.js` 最早一版)的分城市逐日明细导出 | `reports/sources-openmeteo-daily.csv`(单文件含城市列,同一数据)+ `data/summary.json` 的 `daily` 序列 |
| `daily-mae.csv` | 逐日跨城市平均 MAE 过程序列(error-trend.png 的中间数据) | `data/summary.json` 内嵌 `daily` 数列(`make_charts.py` 直接读取);趋势图 `reports/error-trend.png` |
| `source-skill.png` | 早期"三商业源对比"图(`make_charts_extra.py` 第一版) | `reports/sources-compare.png`(双面板,信息更全;且旧图基于 `data/sources/` 中已弃用的 om 字段,口径作废) |

配套调整(防止重跑脚本再生成过程文件):

- `report.js` 不再导出分城市 CSV 与 daily-mae.csv,只产出 `data/summary.json`;
- `make_charts_extra.py` 不再绘制 source-skill.png,只产出 `reports/model-skill.png`。

归档时间:2026-10-24
