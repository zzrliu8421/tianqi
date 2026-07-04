# SkyWeather · 云际天气

一个简洁、现代的跨平台天气应用，支持城市搜索、IP / GPS 定位、实时天气、24 小时预报、7 天预报、空气质量 AQI 以及**小米天气级 WebGL 沉浸式动态背景**。

> 同一份前端代码同时支持：**Web 浏览器**、**Windows 桌面应用（Electron）**、**Android 应用（Capacitor）**。

---

## 功能特性

- **多方式定位**：支持城市搜索、GPS 定位、IP 自动定位（IPv4 / IPv6 兼容）。
- **实时天气**：当前温度、体感温度、天气现象、风速、湿度、气压、紫外线等。
- **空气质量 AQI**：PM2.5、PM10、NO₂、SO₂、O₃ 等污染物数据（需配置和风天气 Key）。
- **24 小时预报**：逐小时温度、天气、降水概率、风速。
- **7 天预报**：每日最高 / 最低温度、天气、降水概率、日出日落。
- **动态天气背景**：基于 **WebGL（Three.js）** 的小米天气级沉浸式动画，包含：
  - **god rays 体积光** + 双层光晕 + 大气散射（晴天）
  - **分层视差云**（4 层深度分布 + 闪电时云层瞬时照亮）
  - **真实雨滴** + 落地飞溅 + 地面水膜反射（雨天）
  - **景深雪花** + 六角晶体纹理旋转 + 地面积雪（雪天）
  - **体积雾** + fbm 噪声流动 + 雾/霾色彩切换（雾/霾）
  - **闪电分形** + 整屏闪光 + 二次闪 + 云层照亮（雷暴）
  - **昼夜主题** + 颜色插值的平滑天气过渡
  - 后期处理：UnrealBloomPass 辉光 + 自定义景深/色调/暗角
  - **降级机制**：WebGL 不可用时自动回退到 Canvas 2D 粒子动画
- **自适应主题**：根据天气状态自动切换晴天、多云、雨天、雪天、雷暴、雾霾等主题。
- **搜索历史**：本地存储最近搜索城市，最多 8 条，支持一键清空。
- **随机背景图**：可切换 Bing / 随机风景背景。
- **PWA 友好**：支持 `apple-mobile-web-app`、theme-color、viewport-fit 等移动端适配。

---

## 技术栈

- **纯前端**：HTML5 + CSS3（自定义属性 / 玻璃拟态）+ 原生 JavaScript（ES6+）
- **动画**：**WebGL（Three.js）** 主渲染 + Canvas 2D 粒子降级方案 + CSS 动画
- **跨平台打包**：
  - **Web**：静态文件 + server.js 代理
  - **Windows**：Electron 28（GPU 硬件加速 WebGL）
  - **Android**：Capacitor 6（WebView 承载 + 原生能力桥接）
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
├── index.html              # 主页面（HTML + CSS + 业务逻辑）
├── weather-renderer.js    # WebGL 渲染器（Three.js，小米天气级动画）
├── mobile-bridge.js       # Capacitor 移动端原生能力桥接
├── server.js              # 代理服务器：托管静态文件 + 代理上游 API（隐藏 Key）
├── build.js               # 构建脚本：根据环境变量生成 config.js（仅含布尔标志）
├── electron/              # Electron 桌面应用配置
│   ├── main.js            # 主进程：创建窗口 + 内嵌 server.js
│   ├── preload.js         # preload：暴露 window.skyApp
│   └── builder.json       # electron-builder 打包配置
├── capacitor.config.json  # Capacitor Android 配置
├── edgeone.json           # EdgeOne Pages 部署配置
├── package.json           # 项目脚本定义（含 Web/Electron/Android 三端命令）
├── .env.example           # 环境变量模板
├── .gitignore             # Git 忽略规则
└── README.md              # 本文件
```

---

## 安全模型：API Key 不暴露给用户

为避免 API Key 硬编码到前端被用户在浏览器中查看，本项目采用 **服务端代理** 模式：

- 真实 Key 仅在服务端读取（来自系统环境变量或 `.env` 文件），前端代码、构建产物、Git 仓库中均不出现
- 前端 `config.js` 仅包含布尔值（如 `AMAP_KEY: true`）表示"服务端是否已配置"，**不含任何密钥**
- 前端所有需要 Key 的请求统一走同源 `/api/*` 代理，由服务端补齐 Key 后转发到上游

本项目提供两种等价的服务端实现，路由表完全一致，可按部署场景任选其一：

| 实现 | 入口文件 | 适用场景 | Key 读取方式 |
|---|---|---|---|
| Node.js 代理 | [server.js](server.js) | 方式 A：自建 NAT 服务器 / VPS | `process.env` 或 `.env` |
| EdgeOne 边缘函数 | [edge-functions/api/[[path]].js](edge-functions/api/%5B%5Bpath%5D%5D.js) | 方式 D：EdgeOne Pages 部署 | `context.env`（控制台环境变量） |

代理路由：

| 前端请求 | 上游目标 |
|---|---|
| `GET /api/amap/<path>` | `https://restapi.amap.com/<path>` (附加 `key=AMAP_KEY`) |
| `GET /api/qweather/geo/<path>` | `https://geoapi.qweather.com/<path>` (附加 `key=QWEATHER_KEY`) |
| `GET /api/qweather/dev/<path>` | `https://devapi.qweather.com/<path>` (附加 `key=QWEATHER_KEY`) |
| `GET /api/ipnews/<path>` | `https://ipnews.io/<path>` (附加 `api-key=IPNEWS_KEY`) |
| `GET /api/status` | 返回服务端已配置的 provider 列表（不暴露 Key） |

> Open-Meteo、ipify 等免 Key 公开 API 仍由前端直接访问。

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

按需填入以下 Key（**仅服务端读取，不会暴露给前端**）：

| 变量名 | 用途 | 是否必填 |
|---|---|---|
| `AMAP_KEY` | 高德地图 Web 服务 Key，用于中国地区天气与地理编码 | 推荐 |
| `QWEATHER_KEY` | 和风天气 Key，用于 AQI 空气质量数据 | 可选 |
| `IPNEWS_KEY` | IPnews Key，用于 IPv6 IP 定位 | 可选 |
| `PORT` | 代理服务器端口，默认 8787 | 可选 |
| `HOST` | 代理服务器监听地址，默认 0.0.0.0 | 可选 |
| `API_BASE` | 前端访问代理的基地址，默认空（同源） | 可选 |

### 3. 本地预览（推荐：代理模式）

直接启动代理服务器，它会同时托管静态文件、代理上游 API、自动生成 `config.js`：

```bash
npm start
# 或
node server.js
```

打开浏览器访问 `http://localhost:8787` 即可。此时所有 API Key 仅存在服务端进程内存中，前端不会以任何形式获取到。

检查配置是否生效：

```bash
npm run check
# 或
node build.js check
```

### 4. 仅生成前端配置（不启动代理）

如果需要把前端单独部署到静态托管平台（此时 `config.js` 不再包含真实 Key，已安全），可只运行构建脚本：

```bash
npm run build
# 或
node build.js
```

构建脚本会读取 `.env` 或系统环境变量，生成只含布尔标志的 `config.js`。

---

## 部署

### 方式 A：自建 NAT 服务器（推荐，Key 完全不暴露）

适用于你拥有 NAT 服务器 / VPS / 容器的场景。一台机器同时托管前端与代理：

```bash
# 1. 把代码部署到服务器
# 2. 配置 .env（填入真实 API Key）
cp .env.example .env
vim .env

# 3. 启动代理服务器（推荐用 pm2 / systemd 守护）
npm start
# 或
PORT=8787 node server.js

# 4. 浏览器访问 http://<服务器IP>:8787
```

反向代理（Nginx）示例：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

此模式下：
- `config.js` 只含布尔值，即便被抓包也无法获取真实 Key
- 浏览器请求 `/api/amap/v3/ip` → 服务器补齐 `key=AMAP_KEY` → 转发到高德
- 用户在前端开发者工具中只能看到 `/api/...`，看不到任何 Key

### 方式 B：前端静态托管 + 独立代理服务

如果你想把前端部署到 EdgeOne Pages / Vercel / Cloudflare Pages（享受 CDN），把代理单独部署到自己的服务器：

1. **前端侧**：构建时设置 `API_BASE` 指向你的代理服务器：

   ```bash
   API_BASE=https://api.your-domain.com node build.js
   ```

   生成的 `config.js` 会包含 `API_BASE: 'https://api.your-domain.com'`，前端请求会拼成 `https://api.your-domain.com/api/amap/...`。

2. **代理侧**：在另一台服务器上运行 `server.js`，配置好 `.env` 与 CORS 即可（`server.js` 已默认开启 `Access-Control-Allow-Origin: *`）。

### 方式 C：纯静态部署（不再使用代理）

如果不需要隐藏 Key（例如内部使用），可像旧版本那样直接构建并部署：

```bash
node build.js
```

> 注意：自代理模式上线后，`build.js` 生成的 `config.js` **不再包含真实 Key**，纯静态部署将无法调用高德 / 和风 / IPnews 等需要 Key 的 API。仅 Open-Meteo 等免 Key 数据源可用。

### 方式 D：EdgeOne Pages 边缘函数（推荐，可用性最高）

把代理逻辑直接跑在 EdgeOne 的全球边缘节点上，**无需自建服务器**，Key 收敛在边缘函数运行时中，前端零暴露。这是本项目针对 EdgeOne Pages 平台的原生适配方案。

#### 架构

```
浏览器
  │  GET /api/amap/v3/ip  (同源，不带 Key)
  ▼
EdgeOne 边缘节点 (edge-functions/api/[[path]].js)
  │  读取 context.env.AMAP_KEY
  │  fetch https://restapi.amap.com/v3/ip?key=AMAP_KEY
  ▼
上游 API (高德 / 和风 / IPnews)
```

- 静态资源（`index.html` / `config.js` 等）由 EdgeOne Pages CDN 托管
- `/api/*` 请求由 `edge-functions/api/[[path]].js` 在边缘节点处理
- 真实 Key 仅存在于 `context.env`，**不会出现在前端代码、构建产物、Git 仓库中**

#### 项目结构（新增部分）

```
.
├── edge-functions/
│   └── api/
│       └── [[path]].js     # 边缘函数：catch-all 处理所有 /api/* 请求
├── edgeone.json            # 构建配置（buildCommand: node build.js）
├── server.js               # 保留，仅用于方式 A（自建服务器）
├── build.js                # 构建时生成只含布尔值的 config.js
└── index.html              # 前端（不修改，仍请求同源 /api/*）
```

> `edge-functions/` 目录会被 EdgeOne Pages 自动扫描，无需在 `edgeone.json` 中声明。静态资源路由与边缘函数路由冲突时，静态资源优先；本项目 `/api/*` 不与任何静态文件冲突。

#### 步骤 1：在 EdgeOne Pages 控制台配置环境变量

进入「项目设置 → 环境变量」，添加以下三个变量，**作用域同时勾选「构建环境」和「运行环境」**：

| 变量名 | 用途 | 构建环境 | 运行环境 |
|---|---|---|---|
| `AMAP_KEY` | 高德 Web 服务 Key | ✅（生成 config.js 布尔标志） | ✅（边缘函数代理时注入） |
| `QWEATHER_KEY` | 和风天气 Key | ✅ | ✅ |
| `IPNEWS_KEY` | IPnews Key | ✅ | ✅ |

为什么两个作用域都要勾？
- **构建环境**：`build.js` 读取后生成 `config.js`，仅含 `AMAP_KEY: true/false` 等布尔值，前端据此判断功能可用性
- **运行环境**：`edge-functions/api/[[path]].js` 通过 `context.env.AMAP_KEY` 读取真实 Key 用于上游转发

> 也可以用 CLI 一键同步：`edgeone makers env set AMAP_KEY <your-key>`

#### 步骤 2：关联 Git 仓库并部署

1. 把代码推送到 GitHub / GitLab 仓库（`.env` 会被 `.gitignore` 自动忽略，安全）
2. 在 EdgeOne Pages 控制台「新建项目」→ 选择仓库 → 框架预设选「无」
3. 构建配置会自动读取项目根目录的 `edgeone.json`：
   - 构建命令：`node build.js`
   - 输出目录：`./`
   - Node 版本：`20.18.0`
4. 点击「部署」，等待构建完成

部署成功后访问 EdgeOne 分配的域名（如 `xxx.edgeone.app`），所有 `/api/*` 请求会自动路由到边缘函数。

#### 步骤 3：本地调试边缘函数

```bash
# 安装 EdgeOne CLI
npm install -g edgeone

# 登录（选择 China 站）
edgeone login

# 在项目根目录创建本地 .env（仅供本地调试用，不提交）
cp .env.example .env
# 编辑 .env 填入真实 Key

# 启动本地开发服务（同时托管静态资源 + 边缘函数）
edgeone pages dev
# 或新命名空间：edgeone makers dev
```

CLI 会读取本地 `.env` 注入到 `context.env`，行为与线上一致。默认监听 `http://localhost:8788`。

#### 边缘函数路由表

| 前端请求 | 上游目标 | 注入的 Key |
|---|---|---|
| `GET /api/status` | （无上游）返回 provider 布尔值 | — |
| `GET /api/amap/<path>` | `https://restapi.amap.com/<path>` | `key=AMAP_KEY` |
| `GET /api/qweather/geo/<path>` | `https://geoapi.qweather.com/<path>` | `key=QWEATHER_KEY` |
| `GET /api/qweather/dev/<path>` | `https://devapi.qweather.com/<path>` | `key=QWEATHER_KEY` |
| `GET /api/ipnews/<path>` | `https://ipnews.io/<path>` | `api-key=IPNEWS_KEY` |

未匹配 `/api/*` 的请求会回退到静态资源。

#### 安全与限制说明

- **CORS**：边缘函数已在所有响应中附加 `Access-Control-Allow-Origin: *`，跨域调用可直接使用
- **超时**：单次上游请求超时 10s（通过 EdgeOne 特有的 `eo.timeoutSetting` 配置）；EdgeOne 边缘函数单次执行 CPU 时间限制 200ms（不含 I/O 等待）
- **CPU 限制**：边缘函数单次执行 CPU 时间片 200ms，本项目代理逻辑远低于此限制
- **代码包大小**：单个函数代码包 ≤ 5MB，本文件远低于此限制
- **Key 安全**：`context.env` 中的 Key 不会出现在前端任何位置；建议同时在高德 / 和风控制台设置 **域名白名单 / 配额限制**，防止边缘节点 IP 被盗用
- **降级**：若所有 Key 均未配置，前端会自动降级到 Open-Meteo 等免 Key 数据源（由 `config.js` 布尔值控制）

#### 与其它方式的对比

| 方式 | Key 安全 | 运维成本 | 全球加速 | 国内访问 |
|---|---|---|---|---|
| A 自建服务器 | ✅ | 高（需维护服务器） | ❌ | 取决于服务器位置 |
| B 静态+独立代理 | ✅ | 中（CDN + 服务器） | ✅ 前端 | 取决于代理位置 |
| C 纯静态 | ❌ Key 暴露 | 低 | ✅ | ✅ |
| **D EdgeOne 边缘函数** | ✅ | **低（无服务器）** | ✅ 3200+ 节点 | ✅ |

---

## 环境变量说明

构建时配置来源优先级（高 → 低）：

1. 系统环境变量（`process.env`）
2. `.env` 文件

这样设计可以同时兼容本地开发与 EdgeOne Pages / Vercel 等 CI/CD 平台。

`server.js` 同样按上述优先级读取 Key，并自动调用 `node build.js` 生成 `config.js`。

---

## 浏览器支持

- Chrome / Edge / Firefox / Safari 最新版（需支持 WebGL 2）
- 支持移动端浏览器与 PWA 添加到主屏
- 尊重 `prefers-reduced-motion` 媒体查询，减少动态效果
- WebGL 不可用时自动降级为 Canvas 2D 粒子动画

---

## Windows 桌面应用（Electron）

将 Web 版本打包为 Windows 原生桌面应用，享受独立窗口、GPU 加速与离线能力。

### 1. 安装依赖

```bash
npm install
```

### 2. 开发模式（连接到正在运行的 server.js）

```bash
# 终端 1：启动代理服务器（提供 API Key 安全代理）
npm start
# 终端 2：启动 Electron
npm run electron:dev
```

### 3. 打包为 Windows 可执行文件

```bash
npm run electron:build
```

构建产物位于 `dist-electron/`，包含：
- `SkyWeather-Setup-x64.exe`：NSIS 安装包（推荐分发）
- `SkyWeather-1.0.0-x64.exe`：便携版（免安装）

### 4. Electron 架构说明

```
electron/
├── main.js          # 主进程：创建窗口 + 内嵌启动 server.js 代理
├── preload.js       # preload：通过 contextBridge 暴露 window.skyApp
└── builder.json     # electron-builder 打包配置
```

- 主进程通过 `require('../server.js')` 内嵌启动代理服务器，所有 API Key 仍走服务端代理，与 Web 部署一致
- 启用 GPU 硬件加速（`enable-gpu-rasterization` + `ignore-gpu-blocklist`），WebGL 必需
- 单例锁，避免多开
- macOS/Linux 同样支持（修改 `builder.json` 的 target 即可）

---

## Android 应用（Capacitor）

将 Web 版本打包为 Android 原生应用，使用 WebView 承载，并桥接原生能力。

### 1. 安装依赖 + 添加 Android 平台

```bash
npm install
npx cap add android
```

### 2. 同步 Web 资源到 Android 工程

每次修改 `index.html` / `weather-renderer.js` / `mobile-bridge.js` 后，都需要重新同步：

```bash
npm run cap:sync
```

### 3. 在 Android Studio 中打开

```bash
npm run cap:open:android
```

然后在 Android Studio 中点击 ▶ 运行到设备/模拟器，或 Build → Generate Signed APK 生成发布包。

### 4. Capacitor 配置说明

`capacitor.config.json` 关键配置：

| 字段 | 值 | 说明 |
|---|---|---|
| `appId` | `com.skyweather.app` | Android 包名 |
| `appName` | `SkyWeather` | 应用显示名 |
| `webDir` | `.` | Web 资源根目录（即 `index.html` 所在位置） |
| `server.androidScheme` | `https` | 使用 HTTPS scheme（CORS 友好） |
| `StatusBar.overlaysWebView` | `true` | 状态栏沉浸式覆盖 |

### 5. 原生能力桥接

`mobile-bridge.js` 在 Capacitor 环境下自动启用：
- **StatusBar**：深色主题，沉浸式覆盖 WebView
- **SplashScreen**：启动后淡出
- **Geolocation**：用 Capacitor 原生定位替代浏览器定位（权限弹窗更友好）
- **App.backButton**：Android 返回键映射到浏览器历史后退

### 6. 注意事项

- Capacitor WebView 需要 Android 5.0+（API 21+）
- WebGL 在 Android WebView 中支持良好（Chromium 内核）
- 如需离线运行，需把 `importmap` 中的 Three.js CDN 替换为本地路径
- 发布到应用商店需要签名，参考 [Capacitor 签名指南](https://capacitorjs.com/docs/android/deploying-to-google-play)

---

## 许可证

本项目仅用于学习与交流，请遵守各数据提供方的使用条款。

---

## 致谢

- 天气数据：[Open-Meteo](https://open-meteo.com/)、[和风天气](https://dev.qweather.com/)
- 地图与定位：[高德地图](https://lbs.amap.com/)、[IPnews](https://ipnews.io/)、[GeoDB](https://geodb-cities-api.wirefreethought.com/)
- 字体：[Inter](https://fonts.google.com/specimen/Inter) by Google Fonts
