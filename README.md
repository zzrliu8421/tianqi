# SkyWeather · 云际天气

一个简洁、现代的纯前端天气应用，支持城市搜索、IP / GPS 定位、实时天气、24 小时预报、7 天预报、空气质量 AQI 以及沉浸式动态天气背景。

> 项目采用单文件 `index.html` 构建，无前端框架依赖，可直接部署到任意静态托管平台。

---

## 功能特性

- **多方式定位**：支持城市搜索、GPS 定位、IP 自动定位（IPv4 / IPv6 兼容）。
- **实时天气**：当前温度、体感温度、天气现象、风速、湿度、气压、紫外线等。
- **空气质量 AQI**：PM2.5、PM10、NO₂、SO₂、O₃ 等污染物数据（需配置和风天气 Key）。
- **24 小时预报**：逐小时温度、天气、降水概率、风速。
- **7 天预报**：每日最高 / 最低温度、天气、降水概率、日出日落。
- **动态天气背景**：基于 Canvas 的雨雪、雷暴、雪花、雾气等沉浸式粒子动画。
- **自适应主题**：根据天气状态自动切换晴天、多云、雨天、雪天、雷暴、雾霾等主题。
- **搜索历史**：本地存储最近搜索城市，最多 8 条，支持一键清空。
- **随机背景图**：可切换 Bing / 随机风景背景。
- **PWA 友好**：支持 `apple-mobile-web-app`、theme-color、viewport-fit 等移动端适配。

---

## 技术栈

- **纯前端**：HTML5 + CSS3（自定义属性 / 玻璃拟态）+ 原生 JavaScript（ES6+）
- **动画**：Canvas 2D 粒子系统 + CSS 动画
- **天气数据源**：
  - [Open-Meteo](https://open-meteo.com/)：全球天气，免 API Key，作为默认兜底。
  - [高德地图 Web 服务](https://lbs.amap.com/)：中国地区地理编码 / 天气 / IP 定位。
  - [和风天气](https://dev.qweather.com/)：AQI 空气质量与城市天气。
  - [IPnews](https://ipnews.io/)：IPv6 网络 IP 定位。
  - [GeoDB Cities](https://geodb-cities-api.wirefreethought.com/)：城市搜索与 IP 定位兜底。
- **图片源**：随机背景图通过 `https://pic.api.sylv.top/image` 获取。

---

## 目录结构

```
.
├── index.html          # 主页面（包含样式与业务逻辑）
├── build.js            # 构建脚本：根据环境变量生成 config.js
├── edgeone.json        # EdgeOne Pages 部署配置
├── package.json        # 项目脚本定义
├── .env.example        # 环境变量模板
├── .gitignore          # Git 忽略规则
└── README.md           # 本文件
```

---

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/your-username/tianqi.git
cd tianqi
```

### 2. 配置 API Key

复制 `.env.example` 为 `.env`：

```bash
cp .env.example .env
```

按需填入以下 Key：

| 变量名 | 用途 | 是否必填 |
|---|---|---|
| `AMAP_KEY` | 高德地图 Web 服务 Key，用于中国地区天气与地理编码 | 推荐 |
| `QWEATHER_KEY` | 和风天气 Key，用于 AQI 空气质量数据 | 可选 |
| `IPNEWS_KEY` | IPnews Key，用于 IPv6 IP 定位 | 可选 |

### 3. 生成配置

```bash
npm run build
# 或
node build.js
```

构建脚本会读取 `.env` 或系统环境变量，生成 `config.js`。

检查配置是否生效：

```bash
npm run check
# 或
node build.js check
```

### 4. 本地预览

`index.html` 是纯静态文件，可直接用任意静态服务器打开，例如：

```bash
npx serve .
```

---

## 部署

### EdgeOne Pages

项目已包含 `edgeone.json`，构建命令为：

```bash
node build.js
```

输出目录为 `./`，Node 版本 `20.18.0`。

### 其他平台

由于 `config.js` 包含 API Key，建议在部署前运行 `node build.js` 生成，或在 CI/CD 中注入环境变量后运行构建。不要直接将 `.env` 提交到仓库。

---

## 环境变量说明

构建时配置来源优先级（高 → 低）：

1. 系统环境变量（`process.env`）
2. `.env` 文件

这样设计可以同时兼容本地开发与 EdgeOne Pages / Vercel 等 CI/CD 平台。

---

## 浏览器支持

- Chrome / Edge / Firefox / Safari 最新版
- 支持移动端浏览器与 PWA 添加到主屏
- 尊重 `prefers-reduced-motion` 媒体查询，减少动态效果

---

## 许可证

本项目仅用于学习与交流，请遵守各数据提供方的使用条款。

---

## 致谢

- 天气数据：[Open-Meteo](https://open-meteo.com/)、[和风天气](https://dev.qweather.com/)
- 地图与定位：[高德地图](https://lbs.amap.com/)、[IPnews](https://ipnews.io/)、[GeoDB](https://geodb-cities-api.wirefreethought.com/)
- 字体：[Inter](https://fonts.google.com/specimen/Inter) by Google Fonts
