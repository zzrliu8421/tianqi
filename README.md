# SkyWeather · 云际天气

沉浸式天气 Web 应用：IP 定位与城市搜索、GPS 精确定位、实时天气、24 小时 / 7 天预报、空气质量，以及 8 种天气 × 昼夜主题的 Canvas 动态天气背景。围绕"测 → 校 → 融 → 示 → 智"主线：预报准确性追踪、AQI 国标校准、多源交叉验证、可信呈现与 AI 生活建议。

在线体验：<https://weather.sylv.top>

## 功能

- **定位**：打开页面自动 IP 定位（IPv4 / IPv6），支持 GPS 精确定位（浏览器授权，中国用高德逆地理编码、海外用 BigDataCloud）、城市搜索、快捷城市、搜索历史（本地保存 8 条）
- **天气**：实况（温度 / 体感 / 风速 / 湿度 / 气压 / 紫外线）、24 小时逐时预报、7 天预报（含预报误差带）、日出日落
- **空气质量**：中国国标 AQI——彩云源直接提供 `aqi.chn`；Open-Meteo 源取六项污染物浓度按 **HJ 633-2012** 自算（IAQI 分段线性插值取最大），显示首要污染物与 PM2.5、PM10、NO₂、O₃ 浓度
- **可信呈现**：来源徽章悬停可见完整数据链路，标注实况性质（观测 / 短临 / 模式值）；昼夜主题、24 小时列表与日照弧按所查城市的钟表时间渲染（`utc_offset_seconds` 修正跨时区错位）
- **多源交叉验证**：主源成功后用独立第二源核对明日气温，分歧 >2°C 时显示"双源分歧"角标
- **AI 生活建议**：大模型基于校准后的结构化数据生成情境化建议（数值接地：响应中数值必须来自输入），未配置 Key 或校验失败时静默降级为规则版建议
- **动态背景**：Canvas 2D 渲染的云 / 雨 / 雪 / 雾 / 霾 / 雷暴 / 星空动画，昼夜主题与天气平滑过渡，重力感应视差，强度由实测数据驱动（降水量 / 能见度 / 湿度 / UV）
- **无障碍**：aria-live 播报、错误提示 role=alert、键盘可操作的搜索历史与重试按钮

## 项目结构

```
├── index.html                  # 单文件前端：HTML + CSS + 业务逻辑（含 Canvas 天气动画）
├── server.js                   # Node 代理：静态托管 + /api/* 转发（白名单 / 限流 / gzip / SPA 回退）
├── build.js                    # 构建脚本：读取环境变量生成 config.js；check 模式查看配置状态
├── edge-functions/
│   └── api/[[path]].js         # EdgeOne 边缘函数版代理，与 server.js 同路由表、同白名单
├── edgeone.json                # EdgeOne Pages 构建配置（构建命令 / 输出目录 / Node 版本）
├── package.json                # npm 脚本（无运行时依赖）
├── tracker/                    # 测 · 预报准确性追踪（回溯回填 + 日常记录 + 指标汇总 + 图表）
├── docs/                       # 改造记录、数据源准确性分析、README 归档
├── .env.example                # 环境变量模板（复制为 .env 使用）
├── .gitignore
├── LICENSE                     # MIT
├── .env                        # ★ 本地配置：真实 API Key，不入库
└── config.js                   # ★ 生成文件：布尔标志 + 静态配置，不入库
```

两类文件：

- **源码（入库）**：`index.html`、`server.js`、`build.js`、`edge-functions/`
- **生成（不入库，可随时重建）**：`config.js` 由 `build.js` 生成
- **本地（不入库）**：`.env` 存放真实 API Key

运行时关系：`index.html` 读取 `config.js` 判断服务端配置了哪些数据源；需要 Key 的请求都发往同源 `/api/*`，由 `server.js`（自建部署）或 `edge-functions/api/[[path]].js`（EdgeOne 部署）补 Key 后转发上游。

## 数据源

| 数据                  | 来源                                                            | 说明         |
| ------------------- | ------------------------------------------------------------- | ---------- |
| 中国实况 / 地理编码 / IP 定位 | [高德地图](https://lbs.amap.com/)                                 | 需 Key      |
| 中国区整源天气（实况+24h+7天+国标 AQI） | [彩云天气](https://caiyunapp.com/)                              | 需 Token，可选 |
| 中国标准 AQI / 城市搜索     | [和风天气](https://dev.qweather.com/)                             | 需 Key，可选   |
| 全球天气 / 预报 / 兜底 AQI  | [Open-Meteo](https://open-meteo.com/)                         | 免 Key，默认兜底 |
| IPv6 IP 定位          | [IPnews](https://ipnews.io/)                                  | 需 Key，可选   |
| 城市搜索 / IP 定位兜底      | [GeoDB Cities](https://geodb-cities-api.wirefreethought.com/) | 免 Key      |
| GPS 海外坐标逆地理编码       | [BigDataCloud](https://www.bigdatacloud.com/)                 | 免 Key      |

## 代理与安全

需要 Key 的请求统一走同源 `/api/*` 代理。`server.js` 与 EdgeOne 边缘函数是两套等价实现，路由表一致：

| 前端请求                       | 上游                                     |
| -------------------------- | -------------------------------------- |
| `/api/amap/<path>`         | restapi.amap.com（注入 `AMAP_KEY`）        |
| `/api/qweather/geo/<path>` | 和风 API（注入 `QWEATHER_KEY`；配置 `QWEATHER_HOST` 后走专属域名，GeoAPI 加 `/geo` 前缀） |
| `/api/qweather/dev/<path>` | 和风 API（注入 `QWEATHER_KEY`；配置 `QWEATHER_HOST` 后走专属域名） |
| `/api/ipnews/<path>`       | ipnews.io（注入 `IPNEWS_KEY`）             |
| `/api/caiyun/<path>`       | api.caiyunapp.com（`CAIYUN_TOKEN` 注入上游路径段） |
| `/api/ai/advice`           | 大模型建议生成（`ZHIPU_API_KEY`；数值接地校验 + 城市/小时缓存 + 规则降级） |
| `/api/status`              | 返回服务端已配置的 provider 布尔值                 |

代理侧防护：上游路径白名单（其余 403）、Origin 校验（异源拒绝）、单 IP 限流 90 次 / 分钟（429 + Retry-After）、点开头路径与 `node_modules/` 一律 404；文本资源支持 gzip 与缓存。

## 部署

| 方式            | 做法                                                          | 适用                 |
| ------------- | ----------------------------------------------------------- | ------------------ |
| 自建服务器         | 配好 `.env` 后 `npm start`（建议 pm2 / systemd 守护），Nginx 反代到 8787 | 有 VPS / NAT 服务器    |
| EdgeOne Pages | 控制台配置各 API Key（构建 + 运行环境都勾选），关联仓库即可，构建命令读自 `edgeone.json`      | 无服务器、全球加速（本项目线上方式） |
| 纯静态           | `node build.js` 后托管静态文件                                     | 仅演示；只能用免 Key 数据源   |

## 开发与验证

项目没有自动化测试与 lint，改动后至少执行：

```bash
node --check server.js && node --check build.js
node --check "edge-functions/api/[[path]].js"
npm start
curl http://localhost:8787/api/status
```

人工回归要点：首屏定位成功；快速连点刷新不卡死在骨架屏；8 种天气背景切换正常；昼夜主题随本地时间变化。

## 预报准确性追踪（测）

`tracker/` 用 [Open-Meteo Previous Runs API](https://open-meteo.com/en/docs/previous-runs-api) 回溯"过去实际发布的预报"并与当日分析值逐日对比（数据自 2024 年起可查，延迟约 3 天）：

```bash
node tracker/backfill.js     # 回填最近 8 周 6 城的提前 1/3 天预报误差
node tracker/record.js       # 日常：记录各数据源当天对明天的预报
node tracker/compare.js      # 次日：与实况参照对比，产出逐源误差
node tracker/report.js       # 汇总 MAE / 偏差 / 降水命中率 POD / 空报率 FAR
python tracker/make_charts.py # 生成误差趋势图与分城市技巧图（reports/*.png）
```

当前回溯结论（336 个城市日）：日最高气温 MAE 提前 1 天 ±0.79°C、提前 3 天 ±1.14°C，降水命中率 79%、空报率 11%——7 天预报中的"误差带"即来源于此（`tracker/data/summary.json`）。

## 许可证

第三方数据遵循各自条款：Open-Meteo 为 CC-BY 且免费额度限非商业用途；高德 / 和风 / IPnews 遵循各自开放平台协议。

## 致谢

[Open-Meteo](https://open-meteo.com/) · [高德地图](https://lbs.amap.com/) · [和风天气](https://dev.qweather.com/) · [IPnews](https://ipnews.io/) · [GeoDB Cities](https://geodb-cities-api.wirefreethought.com/) · [Inter](https://fonts.google.com/specimen/Inter)
