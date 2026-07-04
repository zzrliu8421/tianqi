// ============================================================
// SkyWeather · 移动端桥接（Capacitor）
// 在 Capacitor 环境下：
//  1. 设置状态栏样式（沉浸式）
//  2. 隐藏 SplashScreen
//  3. 桥接 Geolocation（用原生定位代替浏览器定位）
//  4. 桥接 DeviceOrientation（陀螺仪倾斜）
//  5. 提供统一的 window.skyApp 运行时检测
// ============================================================

(async function initMobileBridge() {
  // 仅在 Capacitor 环境下生效
  const isCapacitor = typeof window !== 'undefined' &&
    (window.Capacitor || (navigator.userAgent.includes('Capacitor')));
  if (!isCapacitor) return;

  // 暴露运行时标记
  window.skyApp = {
    platform: 'capacitor',
    isCapacitor: true,
    isElectron: false,
    isWeb: false
  };

  console.log('[SkyWeather Mobile] Capacitor 环境检测成功，启动桥接');

  try {
    // 动态加载 Capacitor 插件（Capacitor 6 通过 registerPlugin 注册）
    const Capacitor = window.Capacitor || {};

    // 1. SplashScreen 隐藏
    try {
      const SplashScreen = Capacitor.Plugins && Capacitor.Plugins.SplashScreen;
      if (SplashScreen && SplashScreen.hide) {
        await SplashScreen.hide({ fadeOutDuration: 300 });
      }
    } catch (e) {
      console.warn('[SkyWeather Mobile] SplashScreen 隐藏失败', e);
    }

    // 2. StatusBar 配置
    try {
      const StatusBar = Capacitor.Plugins && Capacitor.Plugins.StatusBar;
      if (StatusBar) {
        // 透明状态栏，覆盖 WebView
        if (StatusBar.setStyle) {
          await StatusBar.setStyle({ style: 'DARK' }); // 深色文字（背景是深色，所以是浅色文字）
        }
        if (StatusBar.setBackgroundColor) {
          await StatusBar.setBackgroundColor({ color: '#0b0f19' });
        }
        if (StatusBar.setOverlaysWebView) {
          await StatusBar.setOverlaysWebView({ overlay: true });
        }
      }
    } catch (e) {
      console.warn('[SkyWeather Mobile] StatusBar 设置失败', e);
    }

    // 3. Geolocation 桥接：把原生定位注入到 getCurrentPosition
    try {
      const Geolocation = Capacitor.Plugins && Capacitor.Plugins.Geolocation;
      if (Geolocation && Geolocation.getCurrentPosition) {
        const origGetCurrent = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
        navigator.geolocation.getCurrentPosition = function (success, error, options) {
          // 优先用 Capacitor 原生定位
          Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000, ...options })
            .then(pos => {
              // 转换为标准 GeolocationPosition
              const standardPos = {
                coords: {
                  latitude: pos.coords.latitude,
                  longitude: pos.coords.longitude,
                  accuracy: pos.coords.accuracy,
                  altitude: pos.coords.altitude,
                  altitudeAccuracy: pos.coords.altitudeAccuracy,
                  heading: pos.coords.heading,
                  speed: pos.coords.speed
                },
                timestamp: pos.timestamp
              };
              success(standardPos);
            })
            .catch(err => {
              // 失败回退到浏览器定位
              origGetCurrent(success, error, options);
            });
        };
        console.log('[SkyWeather Mobile] Geolocation 已桥接到 Capacitor');
      }
    } catch (e) {
      console.warn('[SkyWeather Mobile] Geolocation 桥接失败', e);
    }

    // 4. DeviceOrientation（陀螺仪）权限请求（iOS 13+）
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      // 让 enableTilt() 来触发请求，这里只标记可用
      window._capacitorDeviceOrientationReady = true;
    }

    // 5. Android 返回键处理：让浏览器历史后退
    try {
      const App = Capacitor.Plugins && Capacitor.Plugins.App;
      if (App && App.addListener) {
        App.addListener('backButton', ({ canGoBack }) => {
          if (canGoBack) {
            window.history.back();
          } else {
            App.exitApp && App.exitApp();
          }
        });
      }
    } catch (e) {
      console.warn('[SkyWeather Mobile] backButton 监听失败', e);
    }

  } catch (e) {
    console.error('[SkyWeather Mobile] 桥接初始化失败', e);
  }
})();
