// SkyWeather Electron 主进程
// 在 Electron 中以窗口形式承载 index.html，并复用 server.js 作为本地代理
// 这样所有 API Key 仍走服务端代理（不暴露给前端），与 Web 版完全一致

const { app, BrowserWindow, Menu, shell, session } = require('electron');
const path = require('path');
const http = require('http');

let mainWindow = null;
let proxyServer = null;
let proxyPort = 8787;

// 启动 server.js 作为本地代理（与 Web 部署一致的 Key 安全模型）
function startProxyServer() {
  try {
    // 通过 require 引入 server.js，复用其 createServer 逻辑
    // server.js 默认监听 8787，无法二次 require 时则启动子进程
    const serverModule = require('../server.js');
    if (serverModule && typeof serverModule.listen === 'function') {
      proxyServer = serverModule;
    }
  } catch (e) {
    console.warn('[SkyWeather] 代理服务器未能内嵌启动，将退化为纯静态模式:', e.message);
  }
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

  // 启动本地代理服务器后加载页面
  const loadPage = () => {
    const url = process.env.DEV_URL || `http://127.0.0.1:${proxyPort}/`;
    mainWindow.loadURL(url);
  };

  // 优先尝试加载本地代理（享受完整 API 能力）
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
