# 测 · 预报准确性追踪

围绕「测」环节的证据生产线:回溯回填(不需要等待)+ 日常记录(可选,持续累积)。

## 目录结构

```
tracker/
├── cities.json          # 追踪城市(北京/上海/广州/成都/南阳/纽约,含坐标/时区/adcode)
├── backfill.js          # 回填:Open-Meteo「过去实际发布的预报」vs 当日分析值
├── record.js            # 日常:记录各数据源(OM/高德/彩云/和风)当天对 D+1/D+3 的预报
├── compare.js           # 次日:昨日记录 vs 实况参照,逐源误差
├── report.js            # 汇总 MAE / 偏差 / 降水命中率 POD / 空报率 FAR
├── make_charts.py       # 证据图表(误差趋势 / 分城市技巧),依赖 matplotlib
├── data/
│   ├── backfill/        # 每城逐日明细(JSON,原始证据)
│   ├── live/            # 每日各源预报存档(YYYY-MM-DD.json)
│   ├── live-compare/    # 每日逐源对比结果
│   └── summary.json     # 汇总指标(前端"误差带"数字来源)
└── reports/             # CSV 明细 + PNG 图表(附件素材)
```

## 方法论(可直接写进研究报告)

- **数据源**:[Open-Meteo Previous Runs API](https://open-meteo.com/en/docs/previous-runs-api),保存了过去每天**实际发布**的数值预报(`*_previous_day1/3` = 提前 1/3 天发布的预报),数据自 2024 年起可查,延迟约 3 天;
- **实况参照**:同接口的当日(day-0)分析值,视为"实况的最佳近似"——用于预报技巧评估是标准做法;
- **指标**:日最高气温 MAE(平均绝对误差,提前 1 天与 3 天分别统计)、系统性偏差(bias)、降水命中率 POD 与空报率 FAR(日降水量 ≥0.2 mm 记为有雨);
- **当前结论**(6 城 × 8 周 = 336 城市日):最高温 MAE 提前 1 天 **0.79°C**、提前 3 天 **1.14°C**,偏差 +0.05°C,POD **79%**,FAR **11%**。分城市:成都最难报(1.01/1.67°C),广州上海最准(0.64/0.75°C)。

## 使用

```bash
node tracker/backfill.js        # 回填最近 8 周(可传起止日期参数)
node tracker/record.js          # 每天 1 次,记录各源今日预报(缺 Key 的源自动跳过)
node tracker/compare.js         # 每天 1 次,对比昨日记录(需昨日已有记录)
node tracker/report.js          # 随时重跑,汇总 data/ 生成 summary.json 与 CSV
python tracker/make_charts.py   # 生成 reports/*.png 图表
```

`record.js`/`compare.js` 从仓库根目录 `.env` 读 Key(进程环境变量优先,便于 CI 注入)。

## 定时运行(可选,GitHub Actions)

```yaml
# .github/workflows/track.yml
name: forecast-track
on:
  schedule:
    - cron: '0 0 * * *'   # UTC 00:00 = 北京 08:00
  workflow_dispatch:
permissions:
  contents: write
jobs:
  track:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: node tracker/record.js && node tracker/compare.js
        env:
          AMAP_KEY: ${{ secrets.AMAP_KEY }}
          CAIYUN_TOKEN: ${{ secrets.CAIYUN_TOKEN }}
          QWEATHER_KEY: ${{ secrets.QWEATHER_KEY }}
          QWEATHER_HOST: ${{ secrets.QWEATHER_HOST }}
      - run: |
          git config user.name "tracker-bot" && git config user.email "bot@users.noreply.github.com"
          git add tracker/data && git commit -m "tracker: ${date +%F} 日常记录" || true
          git push
```

git 提交历史即为"研究日志",Actions 运行记录即为过程证据。

## 已知事项

- 和风 Key 绑定专属 API Host 后,通用域名 `devapi/geoapi.qweather.com` 永远返回 403 "Invalid Host"——**预期行为**,配置了 `QWEATHER_HOST` 的 `record.js` 与应用代理都会自动走专属域名;若专属域名也报 403 "Security Restriction",说明控制台的安全限制(来源白名单)还没放行/生效;
- 彩云免费档 `daily` 常只返回 3 天,D+3 记为 null 属正常;
- 观察记录(2026-10-24):高德与和风的逐日温度数值完全一致,两者底层疑似同源——多源交叉验证时,彩云 / Open-Meteo 相对独立,作为对证源更有意义(前端 crossValidate 的选源规则与此一致)。
