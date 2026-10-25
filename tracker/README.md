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
├── report.js            # 汇总 MAE / 偏差 / 降水命中率 POD / 空报率 FAR + 融·数据驱动权重
├── report-models.js     # 多模式指标汇总(城市 × 模式矩阵)
├── report-sources.js    # 多源汇总:高德+和风/彩云(取 data/sources)+ OM(取 data/backfill)
├── station-check.js     # 校:GHCN 地面站实测对照,量化 OM day-0 实况参照自身的不确定性
├── official-aqi.js      # 官方值对照:每日国标 AQI 同屏抽查(自算/彩云自动,天气网人工补录)
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
│   ├── summary-sources.json # 多商业源汇总
│   ├── weights.json     # 融·数据驱动权重(report.js 生成,前端加权融合直接消费)
│   ├── station-map.json # 城市→GHCN 候选站映射(缓存,免重复下载全站清单)
│   ├── station-check.{json,md} # 站点对照结论(整窗重算,幂等覆盖)
│   ├── official-check.md # 官方值对照记录(AQI 校准证据链,按日幂等)
│   └── official-check.json # 同上的机器可读版(含逐城滚动统计,前端 AQI 悬停/研究视图抽屉消费)
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

## 融 · 数据驱动权重(weights.json)

`report.js` 在汇总指标后,顺带把 `data/live-compare/` 的逐源误差转成**前端可直接消费的融合权重**(样本门槛:≥30 城市日/源/提前期;合格源不足 2 个时保留旧文件):

- **权重**:逆 MAE 归一化(误差越小权重越大),**按提前期分列**——因为"各源在不同提前期各有所长"。当前值(55 天 × 6 城):明日 彩云 0.41 / OM 0.32 / 高德+和风 0.27,第三天反转为 高德+和风 0.36 / OM 0.35 / 彩云 0.29;
- **融合期望误差 fusedMae**:加权后的期望 MAE(明日 ±0.72°C / 第三天 ±1.17°C),前端"误差带"明日/第三天两档即取此值;
- **分歧角标阈值 badge**:该提前期"同日各源最高温极差"的 p90(明日 1.0°C / 第三天 2.6°C)。实测标定结论:**固定 2°C 阈值对明日完全失效(330 例中 0 例触发,p95 仅 1.3°C),对第三天才有效(触发 18%,触发时各源实际误差 39% ≥2°C)**——故阈值按提前期自适应,由数据滚动更新(城市/季节差异随窗口累积自动体现)。

前端消费方式:`index.html` 启动时 fetch `tracker/data/weights.json`(失败退回内置默认值,离线演示可用),`crossValidate` 升级为加权融合——主源 + 独立对证源(高德/和风同源只取一)按权重融合明日/第三天最高最低温,超阈值挂"多源分歧"角标,正常融合时挂淡色"加权融合"徽标披露数据加工方式。

## 校 · 观测站实况对照(station-check.js)

所有精度指标都用 OM day-0 分析值作"实况参照",它本质仍是模式场——"模式检验模式"是方法论上最容易被质疑的点。`station-check.js` 用 NOAA **GHCN-Daily 地面站逐日实测**(免 Key,NCEI Data Service)与同一窗口的参照对比,量化参照自身的不确定性:站点自动就近匹配(全站清单缓存至 `data/station-map.json`,每城按距离试候选直到重叠 ≥20 天,无达标站时退用重叠最多者并注明样本不足)。

窗口 2026-08-27~10-21 的实测结论:纽约 Central Park 站(8.4km,重叠 55 天)参照平均偏高 **+0.89°C**、MAE 1.05°C;上海 24 天重叠平均差 +1.95°C(样本偏少);成都 -0.23°C;北京/广州因中国站国际交换滞后暂无足够重叠。**解读:参照不确定性约 1°C 量级,与前端误差带(±0.7~1.2°C)同量级——指标相对大小(谁准谁差)不受参照选择影响,绝对值需带着这个不确定度解读。** 重跑:`node tracker/station-check.js`(CI 每日自动)。

## 官方值对照记录(data/official-check.md)

`official-aqi.js` 每日对 6 城做国标 AQI 同屏对照:**自算**(彩云六项实时浓度 → HJ 633-2012,与前端 calcCNAQI 同一套断点)vs **彩云上报**(aqi.chn)vs **中国天气网**(人工补录列)。注意自算输入是实时浓度(与页面展示同口径,非官方逐日 24h 均值),差值本身即记录对象。和风空气接口 v7/air/now 已在专属 Host 废弃(403 Deprecated,新版需 JWT),探测失败自动跳过该列,迁移后自动恢复。



## 使用

```bash
node tracker/backfill.js        # 回填最近 8 周(可传起止日期参数)
node tracker/live-import.js     # 一次性:回溯窗口 → live 格式(55 天,已执行;重跑只补缺失)
node tracker/record.js          # 每天 1 次,记录各源今日预报(缺 Key 的源自动跳过)
node tracker/compare.js         # 每天 1 次,对比昨日记录(需昨日已有记录)
node tracker/report.js          # 随时重跑,汇总 data/ 生成 summary.json 与 CSV(含融合权重)
node tracker/station-check.js   # 观测站对照:量化 OM day-0 参照自身不确定性(免 Key)
node tracker/official-aqi.js    # 官方值对照:国标 AQI 同屏抽查,追加当日小节
python tracker/make_charts.py   # 生成 reports/*.png 图表
```

`record.js`/`compare.js` 从仓库根目录 `.env` 读 Key(进程环境变量优先,便于 CI 注入)。

## 定时运行(GitHub Actions,已上线)

工作流文件:`.github/workflows/track.yml`——每天北京时间 00:10 自动执行:record 存档当日各源预报 → 对最近 3 天逐日 compare(day-0 实况有 2~3 天延迟,幂等合并,数据到齐自动补上)→ report 重算汇总与融合权重 → official-aqi 官方值对照 → station-check 观测站对照 → 数据 commit 回仓库(2026-10-25 已验证全链路跑通)。

Secrets 已配置:`AMAP_KEY` / `CAIYUN_TOKEN` / `QWEATHER_KEY` / `QWEATHER_HOST`。核心配置:

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
      - run: node tracker/report.js          # 汇总指标 + 融合权重 weights.json
      - run: node tracker/official-aqi.js || true   # 官方值对照(失败不影响整体)
        env:
          CAIYUN_TOKEN: ${{ secrets.CAIYUN_TOKEN }}
          QWEATHER_KEY: ${{ secrets.QWEATHER_KEY }}
          QWEATHER_HOST: ${{ secrets.QWEATHER_HOST }}
      - run: node tracker/station-check.js || true  # 观测站对照(免 Key,失败不影响整体)
      - run: |
          git config user.name "tracker-bot" && git config user.email "tracker-bot@users.noreply.github.com"
          git add tracker/data && git commit -m "tracker: $(date -u +%F) 日常预报记录与对比" || true
          git push
```

git 提交历史即为"研究日志",Actions 运行记录即为过程证据。

## 已知事项

- 和风 Key 绑定专属 API Host 后,通用域名 `devapi/geoapi.qweather.com` 永远返回 403 "Invalid Host"——**预期行为**,配置了 `QWEATHER_HOST` 的 `record.js` 与应用代理都会自动走专属域名;若专属域名也报 403 "Security Restriction",说明控制台的安全限制(来源白名单)还没放行/生效;
- **和风空气接口 v7/air/now 已在专属 Host 废弃**(2026-10-25 实测 403 Deprecated;v2/air、airpred 均 404,新版空气 API 走 JWT 认证)。影响:前端和风主源时 AQI 回退"Open-Meteo 浓度 + 国标自算"(已实现);official-aqi.js 的和风列自动跳过,迁移 JWT 后恢复;
- 彩云免费档 `daily` 常只返回 3 天,D+3 记为 null 属正常;彩云接口偶发 429 限流,脚本已带一次退避重试;
- 观察记录(2026-10-24):高德与和风的逐日温度数值完全一致,两者底层疑似同源——多源交叉验证时,彩云 / Open-Meteo 相对独立,作为对证源更有意义(前端 crossValidate 的选源规则与此一致)。
