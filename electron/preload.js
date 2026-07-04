// SkyWeather Electron preload
// 通过 contextBridge 暴露最小化的运行时信息给前端
// 前端可通过 window.skyApp.platform 检测运行环境，触发相应原生行为

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('skyApp', {
  platform: 'electron',
  isElectron: true,
  isCapacitor: false,
  isWeb: false,
  // 版本信息（用于诊断面板）
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },
  // 退出应用
  quit: () => ipcRenderer.send('app-quit'),
  // 最小化
  minimize: () => ipcRenderer.send('app-minimize'),
  // 最大化切换
  toggleMaximize: () => ipcRenderer.send('app-toggle-maximize')
});
