// SkyWeather Electron 主进程
// 在 Electron 中以窗口形式承载 index.html，并复用 server.js 作为本地代理
// 这样所有 API Key 仍走服务端代理（不暴露给前端），与 Web 版完全一致
// 打包后：优先启动内嵌 server.js 代理；若 .env 缺失则降级为 file:// 直接加载（使用免 Key 数据源）

const { app, BrowserWindow, Menu, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let proxyServer = null;
let proxyPort = 8787;
let proxyStarted = false;

// 启动 server.js 作为本地代理（与 Web 部署一致的 Key 安全模型）
// 注意：仅未打包的开发模式才尝试，打包后直接降级（server.js 在 asar 内无法 spawnSync）
function startProxyServer() {
  if (app.isPackaged) {
    console.log('[SkyWeather] 打包模式，跳过 server.js 代理（使用免 Key 数据源）');
    return false;
  }
  try {
    // 通过 require 引入 server.js，复用其 createServer 逻辑
    const serverModule = require('../server.js');
    if (serverModule && typeof serverModule.listen === 'function') {
      proxyServer = serverModule;
      proxyStarted = true;
      return true;
    }
  } catch (e) {
    console.warn('[SkyWeather] 代理服务器未能内嵌启动，将退化为纯静态模式:', e.message);
  }
  return false;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0b0f19',
    title: 'SkyWeather · 云际天气',
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
      // WebGL 硬件加速必须保留
      webgl: true,
      experimentalFeatures: true
    }
  });

  // 加载页面：优先 DEV_URL > 本地代理 > 直接 file:// 加载
  const indexPath = path.join(__dirname, '..', 'index.html');
  const loadPage = () => {
    if (process.env.DEV_URL) {
      // 开发模式：连接到外部 server.js
      mainWindow.loadURL(process.env.DEV_URL);
    } else if (proxyStarted) {
      // 代理已启动：通过 http 加载（享受完整 API 能力）
      mainWindow.loadURL(`http://127.0.0.1:${proxyPort}/`);
    } else {
      // 降级模式：直接加载本地 index.html（使用 Open-Meteo 免 Key 数据源）
      mainWindow.loadFile(indexPath);
    }
  };

  // 优先尝试启动本地代理（享受完整 API 能力）
  startProxyServer();
  // 给代理服务器一个启动缓冲
  setTimeout(loadPage, 500);

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // 移除默认菜单（Windows/Linux）
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 单例锁，避免多开
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // 启用 GPU 硬件加速（WebGL 必需）
    app.commandLine.appendSwitch('enable-gpu-rasterization');
    app.commandLine.appendSwitch('ignore-gpu-blocklist');

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (proxyServer && typeof proxyServer.close === 'function') {
    proxyServer.close();
  }
});

