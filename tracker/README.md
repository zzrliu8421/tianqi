# 测 · 预报准确性追踪

围绕「测」环节的证据生产线:回溯回填(不需要等待)+ 日常记录(可选,持续累积)。

## 目录结构

```
tracker/
├── cities.json          # 追踪城市(北京/上海/广州/成都/南阳/纽约,含坐标/时区/adcode)
├── backfill.js          # 回填:Open-Meteo「过去实际发布的预报」vs 当日分析值
├── backfill-models.js   # 多模式回填:ECMWF/GFS/ICON/JMA/中国 GRAPES 五模式真实历史预报
├── record.js            # 日常:记录各数据源(OM/高德/彩云/和风)当天对 D+1/D+3 的预报
├── compare.js           # 次日:昨日记录 vs 实况参照,逐源误差
├── live-import.js       # 一次性:把回溯窗口数据转成 live 格式(带 origin 标记,不覆盖真实记录)
├── report.js            # 汇总 MAE / 偏差 / 降水命中率 POD / 空报率 FAR
├── report-models.js     # 多模式指标汇总(城市 × 模式矩阵)
├── report-sources.js    # 多源汇总:高德+和风/彩云(取 data/sources)+ OM(取 data/backfill)
├── make_charts.py       # 证据图表(误差趋势 / 分城市技巧),依赖 matplotlib
├── make_charts_extra.py # 多模式与多商业源图表
├── make_charts_sources.py # 多源对比图(reports/sources-compare.png)
├── data/
│   ├── backfill/        # 每城逐日明细(JSON,原始证据)
│   ├── backfill-models/ # 多模式逐日明细(JSON,真实数据)
│   ├── sources/         # 多商业源逐日误差(JSON)
│   ├── live/            # 逐日各源预报存档(YYYY-MM-DD.json)
│   ├── live-compare/    # 逐日逐源对比结果(实况=OM day-0 在线获取)
│   ├── summary.json     # 汇总指标(前端"误差带"数字来源)
│   ├── summary-models.json # 多模式汇总
│   └── summary-sources.json # 多商业源汇总
├── reports/             # 最终产物(图表 PNG + 汇总/逐日 CSV,附件素材)
└── archive/             # 过程性/临时文件归档(见 archive/README.md,均可由脚本重新生成)
```

## 方法论(可直接写进研究报告)

- **数据源**:[Open-Meteo Previous Runs API](https://open-meteo.com/en/docs/previous-runs-api),保存了过去每天**实际发布**的数值预报(`*_previous_day1/3` = 提前 1/3 天发布的预报),数据自 2024 年起可查,延迟约 3 天;
- **实况参照**:同接口的当日(day-0)分析值,视为"实况的最佳近似"——用于预报技巧评估是标准做法;
- **指标**:日最高气温 MAE(平均绝对误差,提前 1 天与 3 天分别统计)、系统性偏差(bias)、降水命中率 POD 与空报率 FAR(日降水量 ≥0.2 mm 记为有雨);
- **当前结论**(6 城 × 8 周 = 336 城市日):最高温 MAE 提前 1 天 **0.79°C**、提前 3 天 **1.14°C**,偏差 +0.05°C,POD **79%**,FAR **11%**。分城市:成都最难报(1.01/1.67°C),广州上海最准(0.64/0.75°C)。

## 多模式回溯(真实数据,可直接引用)

`backfill-models.js` 用同一 API 的 `models` 参数回溯五个全球数值模式过去 8 周的实际预报(各 336 城市日,实况参照统一为 best_match day-0):

| 模式 | MAE t+1 | MAE t+3 | 系统性偏差 | POD |
|---|---|---|---|---|
| ECMWF IFS(欧洲) | **0.90°C** | **1.21°C** | -0.08°C | 82% |
| ICON(德国) | 1.06°C | 1.31°C | -0.27°C | 63% |
| GFS(美国) | 1.21°C | 1.32°C | -0.08°C | 74% |
| JMA GSM(日本) | 1.52°C | 1.73°C | -0.13°C | 74% |
| **GRAPES(中国)** | 1.80°C | 2.01°C | **-1.22°C(系统性偏冷)** | 76% |

可引用的发现:**同一城市、同一时段,不同数值模式的预报差异巨大(最优与最差相差一倍),且中国 GRAPES 全球模式对中国城市存在约 1.2°C 的系统性低温偏差**——这正是"多源交叉验证/融"必要性的实证。图表:`reports/model-skill.png`,矩阵:`reports/model-city-mae.csv`。

## 多源对比(高德+和风 / 彩云 / Open-Meteo)

`report-sources.js` 的数据约定:**OM 一律取 `data/backfill/` 的 Previous Runs 回填**(`data/sources/` 文件里的 om 字段不参与计算);高德+和风(`amap_qweather`,两者逐日数值一致故合并)与彩云(`caiyun`)取自 `data/sources/`。实况参照统一为 OM day-0,按日期对齐,`node tracker/report-sources.js && python tracker/make_charts_sources.py` 重算。结论(同窗口 6 城 × 8 周 = 336 城市日):

| 数据源 | MAE t+1 | MAE t+3 | POD / FAR |
|---|---|---|---|
| 彩云天气 | **0.60°C** | 1.37°C | **86% / 5%** |
| Open-Meteo | 0.79°C | 1.14°C | 79% / 11% |
| 高德+和风 | 0.92°C | **1.12°C** | -(无降水量) |

可引用的发现:**提前 1 天彩云最准,提前 3 天高德+和风最稳、彩云衰减最快——不同数据源在不同提前期各有所长**,这是"按提前期择源/加权"(融)的实证依据。图表:`reports/sources-compare.png`,明细:`reports/sources-*-daily.csv`。



## 使用

```bash
node tracker/backfill.js        # 回填最近 8 周(可传起止日期参数)
node tracker/live-import.js     # 一次性:回溯窗口 → live 格式(55 天,已执行;重跑只补缺失)
node tracker/record.js          # 每天 1 次,记录各源今日预报(缺 Key 的源自动跳过)
node tracker/compare.js         # 每天 1 次,对比昨日记录(需昨日已有记录)
node tracker/report.js          # 随时重跑,汇总 data/ 生成 summary.json 与 CSV
python tracker/make_charts.py   # 生成 reports/*.png 图表
```

`record.js`/`compare.js` 从仓库根目录 `.env` 读 Key(进程环境变量优先,便于 CI 注入)。

## 定时运行(GitHub Actions,已配置)

工作流文件:`.github/workflows/track.yml`——每天北京时间 00:10 自动执行:record 存档当日各源预报 → 对最近 3 天逐日 compare(day-0 实况有 2~3 天延迟,幂等合并,数据到齐自动补上)→ 数据 commit 回仓库。

首次使用:在仓库 **Settings → Secrets and variables → Actions** 添加 `AMAP_KEY`、`CAIYUN_TOKEN`(和风 Key 修复后补 `QWEATHER_KEY`/`QWEATHER_HOST`),然后在 Actions 页手动触发一次验证。核心配置:

```yaml
name: forecast-track
on:
  schedule:
    - cron: '10 16 * * *' # UTC 16:10 = 北京时间 00:10
  workflow_dispatch: {}
permissions:
  contents: write
jobs:
  track:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: node tracker/record.js
        env:
          AMAP_KEY: ${{ secrets.AMAP_KEY }}
          CAIYUN_TOKEN: ${{ secrets.CAIYUN_TOKEN }}
          QWEATHER_KEY: ${{ secrets.QWEATHER_KEY }}
          QWEATHER_HOST: ${{ secrets.QWEATHER_HOST }}
      - run: |
          for d in 1 2 3; do node tracker/compare.js "$(date -u -d "-$d day" +%F)" || true; done
      - run: |
          git config user.name "tracker-bot" && git config user.email "tracker-bot@users.noreply.github.com"
          git add tracker/data && git commit -m "tracker: $(date -u +%F) 日常预报记录与对比" || true
          git push
```

git 提交历史即为"研究日志",Actions 运行记录即为过程证据。

## 已知事项

- 和风 Key 绑定专属 API Host 后,通用域名 `devapi/geoapi.qweather.com` 永远返回 403 "Invalid Host"——**预期行为**,配置了 `QWEATHER_HOST` 的 `record.js` 与应用代理都会自动走专属域名;若专属域名也报 403 "Security Restriction",说明控制台的安全限制(来源白名单)还没放行/生效;
- 彩云免费档 `daily` 常只返回 3 天,D+3 记为 null 属正常;
- 观察记录(2026-10-24):高德与和风的逐日温度数值完全一致,两者底层疑似同源——多源交叉验证时,彩云 / Open-Meteo 相对独立,作为对证源更有意义(前端 crossValidate 的选源规则与此一致)。
