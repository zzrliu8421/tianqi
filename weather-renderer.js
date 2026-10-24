// ============================================================
// SkyWeather · WebGL 渲染器（基于 Three.js）
// 实现小米天气级别的天气动画效果：
//  - 分层视差云 + 云影投射
//  - god rays 体积光 + 大气散射
//  - 真实雨滴 + 飞溅 + 水膜反射
//  - 闪电云层瞬时照亮
//  - 景深雪花 + 背景虚化
//  - 体积雾 + 地表雾流动
//  - 背景色插值的平滑天气过渡
// ============================================================

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// ===================== 工具：噪声（GLSL） =====================
// 简化的 2D/3D 值噪声 + fbm，供 shader 中自然形态使用
const NOISE_GLSL = `
vec3 hash3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
          dot(p, vec3(269.5, 183.3, 246.1)),
          dot(p, vec3(113.5, 271.9, 124.6)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}
float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(dot(hash3(i + vec3(0,0,0)), f - vec3(0,0,0)),
                    dot(hash3(i + vec3(1,0,0)), f - vec3(1,0,0)), u.x),
                mix(dot(hash3(i + vec3(0,1,0)), f - vec3(0,1,0)),
                    dot(hash3(i + vec3(1,1,0)), f - vec3(1,1,0)), u.x), u.y),
            mix(mix(dot(hash3(i + vec3(0,0,1)), f - vec3(0,0,1)),
                    dot(hash3(i + vec3(1,0,1)), f - vec3(1,0,1)), u.x),
                mix(dot(hash3(i + vec3(0,1,1)), f - vec3(0,1,1)),
                    dot(hash3(i + vec3(1,1,1)), f - vec3(1,1,1)), u.x), u.y), u.z);
}
float fbm(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise3(p);
    p *= 2.0;
    a *= 0.5;
  }
  return v;
}
`;

// ===================== 天气主题颜色配置 =====================
// 每种天气定义一组"天空顶部色 / 地平线色 / 地面色 / 雾色 / 主光色"
// 用于过渡时颜色插值（HSL 空间或线性 RGB 都可，这里用线性 RGB）
const WEATHER_THEMES = {
  sunny: {
    top: new THREE.Color('#1e3a8a'),     // 深蓝
    horizon: new THREE.Color('#60a5fa'), // 浅蓝
    ground: new THREE.Color('#0f172a'),
    fog: new THREE.Color('#bae6fd'),
    sunColor: new THREE.Color('#fff8e1'),
    light: new THREE.Color('#fffaf0')
  },
  partlyCloudy: {
    top: new THREE.Color('#1e40af'),
    horizon: new THREE.Color('#93c5fd'),
    ground: new THREE.Color('#0f172a'),
    fog: new THREE.Color('#cbd5e1'),
    sunColor: new THREE.Color('#fff8e1'),
    light: new THREE.Color('#e0e7ff')
  },
  cloudy: {
    top: new THREE.Color('#334155'),
    horizon: new THREE.Color('#64748b'),
    ground: new THREE.Color('#0f172a'),
    fog: new THREE.Color('#94a3b8'),
    sunColor: new THREE.Color('#cbd5e1'),
    light: new THREE.Color('#cbd5e1')
  },
  rain: {
    top: new THREE.Color('#1f2937'),
    horizon: new THREE.Color('#374151'),
    ground: new THREE.Color('#0b0f19'),
    fog: new THREE.Color('#475569'),
    sunColor: new THREE.Color('#64748b'),
    light: new THREE.Color('#94a3b8')
  },
  storm: {
    top: new THREE.Color('#0f172a'),
    horizon: new THREE.Color('#1e293b'),
    ground: new THREE.Color('#020617'),
    fog: new THREE.Color('#1e293b'),
    sunColor: new THREE.Color('#a78bfa'),
    light: new THREE.Color('#64748b')
  },
  snow: {
    top: new THREE.Color('#475569'),
    horizon: new THREE.Color('#cbd5e1'),
    ground: new THREE.Color('#e2e8f0'),
    fog: new THREE.Color('#f1f5f9'),
    sunColor: new THREE.Color('#f8fafc'),
    light: new THREE.Color('#e0f2fe')
  },
  fog: {
    top: new THREE.Color('#94a3b8'),
    horizon: new THREE.Color('#cbd5e1'),
    ground: new THREE.Color('#64748b'),
    fog: new THREE.Color('#cbd5e1'),
    sunColor: new THREE.Color('#e2e8f0'),
    light: new THREE.Color('#cbd5e1')
  },
  haze: {
    top: new THREE.Color('#78716c'),
    horizon: new THREE.Color('#a8a29e'),
    ground: new THREE.Color('#44403c'),
    fog: new THREE.Color('#a8a29e'),
    sunColor: new THREE.Color('#fde68a'),
    light: new THREE.Color('#d6d3d1')
  }
};

// 夜晚版本（_dayFactor < 0.3 时混合）
const NIGHT_THEMES = {
  sunny: { top: new THREE.Color('#020617'), horizon: new THREE.Color('#1e293b'), sunColor: new THREE.Color('#e0e7ff') },
  partlyCloudy: { top: new THREE.Color('#020617'), horizon: new THREE.Color('#1e293b'), sunColor: new THREE.Color('#c7d2fe') },
  cloudy: { top: new THREE.Color('#0f172a'), horizon: new THREE.Color('#1e293b'), sunColor: new THREE.Color('#94a3b8') },
  rain: { top: new THREE.Color('#020617'), horizon: new THREE.Color('#0f172a'), sunColor: new THREE.Color('#475569') },
  storm: { top: new THREE.Color('#000000'), horizon: new THREE.Color('#020617'), sunColor: new THREE.Color('#7c3aed') },
  snow: { top: new THREE.Color('#1e293b'), horizon: new THREE.Color('#334155'), sunColor: new THREE.Color('#cbd5e1') },
  fog: { top: new THREE.Color('#1e293b'), horizon: new THREE.Color('#334155'), sunColor: new THREE.Color('#94a3b8') },
  haze: { top: new THREE.Color('#1c1917'), horizon: new THREE.Color('#292524'), sunColor: new THREE.Color('#fbbf24') }
};

// ===================== 主渲染器类 =====================
export class SkyWeatherRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.composer = null;
    this.bloomPass = null;
    this.skyPass = null;

    this.clock = new THREE.Clock();
    this.rAF = null;
    this.running = false;

    // 天气状态
    this.currentType = null;
    this.targetType = null;
    this.intensity = 0.5;
    this.windSpeed = 0;
    this.transitionProgress = 1; // 0=旧, 1=新
    this.transitionDuration = 2.5; // 秒

    // 时间
    this.elapsed = 0;
    this.dayFactor = 1;
    this.tiltX = 0;

    // 视口
    this.vpW = window.innerWidth;
    this.vpH = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    // 各效果组
    this.layers = {
      sky: null,           // 天空盒
      sun: null,           // 太阳/月亮
      stars: null,         // 星星
      clouds: null,        // 云层组
      rain: null,          // 雨滴粒子
      snow: null,          // 雪花粒子
      fog: null,           // 体积雾
      lightning: null,     // 闪电
      ground: null,        // 地面
      splashes: null      // 雨溅
    };

    // 主题颜色（当前/目标，用于插值）
    this.curTheme = Object.assign({}, WEATHER_THEMES.sunny);
    this.tgtTheme = Object.assign({}, WEATHER_THEMES.sunny);

    // 闪光层（DOM）
    this.flashEl = document.getElementById('weather-flash');

    // 闪电调度
    this.nextLightningAt = 3 + Math.random() * 4;
    this.lightningFlash = 0; // 0-1 闪光强度

    // FPS 自适应
    this.fpsSamples = [];
    this.fpsLastCheck = 0;
    this.dynamicScale = 1;

    // reduced motion
    this.reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // 当前活动效果列表（按天气类型启用）
    this.activeEffects = new Set(['sky', 'sun', 'stars']);

    // 可见性（每种天气下各 effect 的目标 alpha）
    this.visibility = {
      sky: 1,
      sun: 1,
      stars: 0,
      clouds: 0,
      rain: 0,
      snow: 0,
      fog: 0,
      lightning: 0,
      splashes: 0
    };
    this.curVisibility = Object.assign({}, this.visibility);

    this._boundResize = this._onResize.bind(this);
    this._boundTick = this._tick.bind(this);
  }

  // -------------------- 初始化 --------------------
  init() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: !this.reducedMotion,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true
    });
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(this.vpW, this.vpH, false);
    this.renderer.setClearColor(WEATHER_THEMES.sunny.top, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(WEATHER_THEMES.sunny.fog.getHex(), 0.0008);

    this.camera = new THREE.PerspectiveCamera(60, this.vpW / this.vpH, 0.1, 2000);
    this.camera.position.set(0, 0, 100);

    // 构建各层
    this._buildSky();
    this._buildSun();
    this._buildStars();
    this._buildClouds();
    this._buildRain();
    this._buildSnow();
    this._buildFog();
    this._buildLightning();
    this._buildGround();
    this._buildSplashes();

    // 后期处理
    this._buildComposer();

    // 应用初始天气
    this._applyWeatherVisibility('sunny');

    window.addEventListener('resize', this._boundResize);

    this.running = true;
    this.clock.start();
    this.rAF = requestAnimationFrame(this._boundTick);
  }

  // -------------------- 后期处理 --------------------
  _buildComposer() {
    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(this.dpr);
    this.composer.setSize(this.vpW, this.vpH);

    const renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(renderPass);

    // Bloom 用于辉光（太阳、闪电、星星）
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(this.vpW, this.vpH),
      0.6,  // strength
      0.4,  // radius
      0.85  // threshold
    );
    this.composer.addPass(this.bloomPass);

    // 自定义景深 + 大气散射 + 颜色分级 Pass
    this.skyPass = new ShaderPass(SkyWeatherShader);
    this.skyPass.uniforms.focalDepth.value = 80;
    this.skyPass.uniforms.aperture.value = 0.002;
    this.skyPass.uniforms.focalLength.value = 30;
    this.composer.addPass(this.skyPass);
  }

  // -------------------- 天空盒 --------------------
  _buildSky() {
    const geo = new THREE.SphereGeometry(1000, 32, 16);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: WEATHER_THEMES.sunny.top.clone() },
        horizonColor: { value: WEATHER_THEMES.sunny.horizon.clone() },
        groundColor: { value: WEATHER_THEMES.sunny.ground.clone() },
        offset: { value: 33 },
        exponent: { value: 0.6 },
        dayFactor: { value: 1 }
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPosition = wp.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 horizonColor;
        uniform vec3 groundColor;
        uniform float offset;
        uniform float exponent;
        uniform float dayFactor;
        varying vec3 vWorldPosition;
        void main() {
          float h = normalize(vWorldPosition + vec3(0.0, offset, 0.0)).y;
          vec3 col;
          if (h > 0.0) {
            float t = pow(max(h, 0.0), exponent);
            col = mix(horizonColor, topColor, t);
          } else {
            float t = pow(max(-h, 0.0), exponent);
            col = mix(horizonColor, groundColor, t);
          }
          gl_FragColor = vec4(col, 1.0);
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false
    });
    this.layers.sky = new THREE.Mesh(geo, mat);
    this.scene.add(this.layers.sky);
  }

  // -------------------- 太阳/月亮 --------------------
  _buildSun() {
    const group = new THREE.Group();

    // 太阳本体（球）
    const sunGeo = new THREE.SphereGeometry(8, 32, 32);
    const sunMat = new THREE.MeshBasicMaterial({
      color: 0xfff8e1,
      transparent: true,
      opacity: 1,
      fog: false
    });
    const sun = new THREE.Mesh(sunGeo, sunMat);
    group.add(sun);

    // 太阳光晕（多层 sprite）
    const glowTex = this._makeGlowTexture();
    const glowMat = new THREE.SpriteMaterial({
      map: glowTex,
      color: 0xfff8e1,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false
    });
    const glow1 = new THREE.Sprite(glowMat.clone());
    glow1.scale.set(60, 60, 1);
    group.add(glow1);
    const glow2 = new THREE.Sprite(glowMat.clone());
    glow2.scale.set(120, 120, 1);
    glow2.material.opacity = 0.35;
    group.add(glow2);

    // god rays（径向射线）
    const rayMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 1 },
        uColor: { value: new THREE.Color(0xfff8e1) }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uOpacity;
        uniform vec3 uColor;
        varying vec2 vUv;
        void main() {
          vec2 p = vUv - 0.5;
          float r = length(p);
          float a = atan(p.y, p.x);
          // 径向射线：基于角度的 sin 波
          float rays = pow(0.5 + 0.5 * sin(a * 12.0 + uTime * 0.2), 8.0);
          rays += 0.4 * pow(0.5 + 0.5 * sin(a * 7.0 - uTime * 0.15), 12.0);
          // 距离衰减
          float falloff = smoothstep(0.5, 0.0, r);
          float alpha = rays * falloff * 0.6 * uOpacity;
          gl_FragColor = vec4(uColor, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false
    });
    const rayGeo = new THREE.PlaneGeometry(300, 300);
    const rays = new THREE.Mesh(rayGeo, rayMat);
    group.add(rays);

    group.position.set(180, 80, -200);
    group.userData = { sun, glow1, glow2, rays, sunMat, rayMat, glowMat };
    this.layers.sun = group;
    this.scene.add(group);
  }

  _makeGlowTexture() {
    const size = 128;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.2, 'rgba(255,248,225,0.8)');
    grad.addColorStop(0.5, 'rgba(255,236,179,0.3)');
    grad.addColorStop(1, 'rgba(255,224,130,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _makeCloudPuffTexture() {
    const size = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    // 多个椭圆叠加形成蓬松云朵
    const drawPuff = (x, y, r) => {
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, 'rgba(255,255,255,0.9)');
      grad.addColorStop(0.5, 'rgba(255,255,255,0.4)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
    };
    drawPuff(size * 0.5, size * 0.55, size * 0.4);
    drawPuff(size * 0.3, size * 0.6, size * 0.3);
    drawPuff(size * 0.7, size * 0.6, size * 0.3);
    drawPuff(size * 0.4, size * 0.45, size * 0.25);
    drawPuff(size * 0.6, size * 0.5, size * 0.25);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _makeSnowflakeTexture() {
    const size = 64;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    const cx = size / 2;
    const cy = size / 2;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, size / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.3, 'rgba(255,255,255,0.7)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    // 雪花六角晶体
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * (size / 2 - 4), cy + Math.sin(a) * (size / 2 - 4));
      ctx.stroke();
      // 子枝
      const subLen = (size / 2 - 4) * 0.4;
      const subAt = (size / 2 - 4) * 0.55;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * subAt, cy + Math.sin(a) * subAt);
      ctx.lineTo(cx + Math.cos(a - 0.5) * (subAt + subLen), cy + Math.sin(a - 0.5) * (subAt + subLen));
      ctx.moveTo(cx + Math.cos(a) * subAt, cy + Math.sin(a) * subAt);
      ctx.lineTo(cx + Math.cos(a + 0.5) * (subAt + subLen), cy + Math.sin(a + 0.5) * (subAt + subLen));
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // -------------------- 星星 --------------------
  _buildStars() {
    const count = 200;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      // 球面分布（上半球为主）
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 0.7 + 0.3); // 偏上
      const r = 800;
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta) - 200;
      // 颜色：白/蓝/黄
      const tier = Math.random();
      if (tier < 0.7) { colors[i * 3] = 1; colors[i * 3 + 1] = 1; colors[i * 3 + 2] = 1; }
      else if (tier < 0.9) { colors[i * 3] = 0.7; colors[i * 3 + 1] = 0.8; colors[i * 3 + 2] = 1; }
      else { colors[i * 3] = 1; colors[i * 3 + 1] = 0.9; colors[i * 3 + 2] = 0.6; }
      sizes[i] = Math.random() * 3 + 1;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 0 },
        uPixelRatio: { value: this.dpr }
      },
      vertexShader: `
        attribute float size;
        attribute vec3 color;
        varying vec3 vColor;
        varying float vSize;
        uniform float uTime;
        uniform float uPixelRatio;
        void main() {
          vColor = color;
          vSize = size;
          // 闪烁
          float twinkle = 0.7 + 0.3 * sin(uTime * 1.5 + position.x * 0.1);
          gl_PointSize = size * uPixelRatio * twinkle;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vSize;
        uniform float uOpacity;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          float a = smoothstep(0.5, 0.0, d);
          // 十字光芒
          float cross = max(
            smoothstep(0.5, 0.0, abs(c.x) * 4.0) * smoothstep(0.5, 0.0, abs(c.y)),
            smoothstep(0.5, 0.0, abs(c.y) * 4.0) * smoothstep(0.5, 0.0, abs(c.x))
          );
          a = max(a, cross * 0.4);
          gl_FragColor = vec4(vColor, a * uOpacity);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false
    });

    this.layers.stars = new THREE.Points(geo, mat);
    this.scene.add(this.layers.stars);
  }

  // -------------------- 云层（分层视差） --------------------
  _buildClouds() {
    const group = new THREE.Group();
    const tex = this._makeCloudPuffTexture();

    // 4 层视差云
    const layerCount = 4;
    const layers = [];
    for (let L = 0; L < layerCount; L++) {
      const layerGroup = new THREE.Group();
      const depth = L / (layerCount - 1); // 0=远，1=近
      const puffCount = Math.floor(8 + depth * 6);
      const scaleBase = 40 + depth * 60;
      const zPos = -300 + depth * 200;

      for (let i = 0; i < puffCount; i++) {
        const mat = new THREE.SpriteMaterial({
          map: tex,
          color: 0xffffff,
          transparent: true,
          opacity: 0.5 + depth * 0.3,
          depthWrite: false,
          fog: true
        });
        const sprite = new THREE.Sprite(mat);
        const sc = scaleBase * (0.6 + Math.random() * 0.8);
        sprite.scale.set(sc, sc * 0.55, 1);
        sprite.position.set(
          (Math.random() - 0.5) * 800,
          40 + Math.random() * 100 + depth * 20,
          zPos + (Math.random() - 0.5) * 80
        );
        sprite.userData = {
          baseX: sprite.position.x,
          speed: (0.3 + depth * 0.5) * (Math.random() * 0.5 + 0.8),
          depth: depth,
          phase: Math.random() * Math.PI * 2
        };
        layerGroup.add(sprite);
      }
      group.add(layerGroup);
      layers.push({ group: layerGroup, depth: depth });
    }
    group.userData = { layers, tex };
    this.layers.clouds = group;
    this.scene.add(group);
  }

  // -------------------- 雨 --------------------
  _buildRain() {
    const count = 1500;
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count);
    const sizes = new Float32Array(count);
    const layers = new Float32Array(count); // 0=远 1=中 2=近

    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 800;
      positions[i * 3 + 1] = Math.random() * 400 - 100;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 400;
      const L = Math.random() < 0.4 ? 0 : (Math.random() < 0.7 ? 1 : 2);
      layers[i] = L;
      velocities[i] = (3 + L * 4) * (0.9 + Math.random() * 0.2);
      sizes[i] = 0.5 + L * 1.2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('velocity', new THREE.BufferAttribute(velocities, 1));
    geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('layer', new THREE.BufferAttribute(layers, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 0 },
        uColor: { value: new THREE.Color(0xcfd8e3) },
        uPixelRatio: { value: this.dpr }
      },
      vertexShader: `
        attribute float velocity;
        attribute float size;
        attribute float layer;
        uniform float uTime;
        uniform float uPixelRatio;
        varying float vLayer;
        varying float vDepth;
        void main() {
          vLayer = layer;
          vec3 pos = position;
          // 限制 uTime 范围，避免 mediump GPU 长时间运行后浮点精度损失/溢出
          // 雨滴下落周期 = 500/(velocity*30)，对 uTime 取模后视觉无变化
          float period = 500.0 / (velocity * 30.0);
          float t = mod(uTime, period);
          // y 下落
          pos.y = mod(pos.y - t * velocity * 30.0 + 200.0, 500.0) - 100.0;
          // x 风偏
          pos.x += sin(uTime * 0.5 + position.z * 0.01) * 5.0;
          vec4 mv = modelViewMatrix * vec4(pos, 1.0);
          vDepth = -mv.z;
          gl_PointSize = size * uPixelRatio * (200.0 / -mv.z) * 8.0;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vLayer;
        varying float vDepth;
        void main() {
          // 雨滴形状：竖向拉长的椭圆
          vec2 c = gl_PointCoord - 0.5;
          c.y *= 0.3; // 拉长
          float d = length(c);
          float a = smoothstep(0.5, 0.0, d);
          // 远处更淡
          float depthFade = smoothstep(800.0, 100.0, vDepth);
          gl_FragColor = vec4(uColor, a * uOpacity * (0.4 + vLayer * 0.3) * depthFade);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false
    });

    this.layers.rain = new THREE.Points(geo, mat);
    this.scene.add(this.layers.rain);
  }

  // -------------------- 雪 --------------------
  _buildSnow() {
    const count = 800;
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count);
    const sizes = new Float32Array(count);
    const rotations = new Float32Array(count);
    const tex = this._makeSnowflakeTexture();

    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 800;
      positions[i * 3 + 1] = Math.random() * 400 - 100;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 400;
      velocities[i] = (0.4 + Math.random() * 1.0);
      sizes[i] = 2 + Math.random() * 6;
      rotations[i] = Math.random() * Math.PI * 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('velocity', new THREE.BufferAttribute(velocities, 1));
    geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('rotation', new THREE.BufferAttribute(rotations, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 0 },
        uTex: { value: tex },
        uPixelRatio: { value: this.dpr }
      },
      vertexShader: `
        attribute float velocity;
        attribute float size;
        attribute float rotation;
        uniform float uTime;
        uniform float uPixelRatio;
        varying float vRotation;
        varying float vDepth;
        void main() {
          vec3 pos = position;
          // 限制 uTime 范围，避免 mediump GPU 长时间运行后浮点精度损失
          float period = 500.0 / (velocity * 8.0);
          float t = mod(uTime, period);
          pos.y = mod(pos.y - t * velocity * 8.0 + 200.0, 500.0) - 100.0;
          pos.x += sin(uTime * 0.3 + position.y * 0.02) * 8.0 + sin(uTime * 0.7 + position.x * 0.01) * 3.0;
          vRotation = rotation + uTime * 0.5;
          vec4 mv = modelViewMatrix * vec4(pos, 1.0);
          vDepth = -mv.z;
          gl_PointSize = size * uPixelRatio * (300.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform sampler2D uTex;
        uniform float uOpacity;
        varying float vRotation;
        varying float vDepth;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float s = sin(vRotation);
          float cR = cos(vRotation);
          vec2 rot = vec2(c.x * cR - c.y * s, c.x * s + c.y * cR) + 0.5;
          vec4 tex = texture2D(uTex, rot);
          float depthFade = smoothstep(800.0, 100.0, vDepth);
          gl_FragColor = vec4(tex.rgb, tex.a * uOpacity * depthFade);
        }
      `,
      transparent: true,
      depthWrite: false,
      fog: true
    });

    this.layers.snow = new THREE.Points(geo, mat);
    this.scene.add(this.layers.snow);
  }

  // -------------------- 体积雾 --------------------
  _buildFog() {
    // 用一个大盒子 + raymarching 风格 shader
    const geo = new THREE.PlaneGeometry(1200, 600);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 0 },
        uColor: { value: new THREE.Color(0xcbd5e1) },
        uHaze: { value: 0 } // 0=雾 1=霾
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vPos;
        void main() {
          vUv = uv;
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uOpacity;
        uniform vec3 uColor;
        uniform float uHaze;
        varying vec2 vUv;
        varying vec3 vPos;
        ${NOISE_GLSL}
        void main() {
          vec3 p = vec3(vUv * 4.0, uTime * 0.05);
          float n = fbm(p);
          n = 0.5 + 0.5 * n;
          // 地表雾流动：底部更浓
          float vertFade = smoothstep(0.0, 0.6, vUv.y);
          // 上层稀薄
          float upperFade = 1.0 - smoothstep(0.6, 1.0, vUv.y) * 0.6;
          float alpha = n * vertFade * upperFade * (0.5 + (1.0 - uHaze) * 0.5);
          vec3 col = mix(uColor, vec3(0.7, 0.55, 0.35), uHaze * 0.5);
          gl_FragColor = vec4(col, alpha * uOpacity);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false
    });
    this.layers.fog = new THREE.Mesh(geo, mat);
    this.layers.fog.position.set(0, 50, -200);
    this.scene.add(this.layers.fog);
  }

  // -------------------- 闪电 --------------------
  _buildLightning() {
    const group = new THREE.Group();
    // 闪电路径用 LineSegments 动态更新
    const maxPoints = 200;
    const positions = new Float32Array(maxPoints * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setDrawRange(0, 0);

    const mat = new THREE.LineBasicMaterial({
      color: 0xc7d2fe,
      transparent: true,
      opacity: 0,
      linewidth: 2,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false
    });
    const line = new THREE.LineSegments(geo, mat);
    group.add(line);

    group.userData = {
      line,
      positions,
      mat,
      active: false,
      timer: 0,
      segments: 0
    };
    this.layers.lightning = group;
    this.scene.add(group);
  }

  _generateLightning() {
    const ud = this.layers.lightning.userData;
    const positions = ud.positions;
    let idx = 0;
    // 起点：天空上方某处
    const startX = (Math.random() - 0.5) * 400;
    const startY = 200;
    const startZ = -100;
    let x = startX, y = startY, z = startZ;
    const groundY = -100;
    // 主干
    const stepCount = 12 + Math.floor(Math.random() * 6);
    for (let i = 0; i < stepCount; i++) {
      const tx = x + (Math.random() - 0.5) * 30;
      const ty = y - (startY - groundY) / stepCount * (0.7 + Math.random() * 0.6);
      const tz = z + (Math.random() - 0.5) * 20;
      positions[idx++] = x; positions[idx++] = y; positions[idx++] = z;
      positions[idx++] = tx; positions[idx++] = ty; positions[idx++] = tz;
      x = tx; y = ty; z = tz;
      // 分叉
      if (Math.random() < 0.35 && idx < positions.length - 6) {
        const bx = x + (Math.random() - 0.5) * 60;
        const by = y - Math.random() * 40;
        const bz = z + (Math.random() - 0.5) * 30;
        positions[idx++] = x; positions[idx++] = y; positions[idx++] = z;
        positions[idx++] = bx; positions[idx++] = by; positions[idx++] = bz;
      }
    }
    ud.segments = idx / 3;
    ud.line.geometry.setDrawRange(0, ud.segments);
    ud.line.geometry.attributes.position.needsUpdate = true;
    ud.active = true;
    ud.timer = 0;
    ud.mat.opacity = 1;

    // 触发整屏闪光
    this.lightningFlash = 1;
    if (this.flashEl) {
      this.flashEl.style.background = 'rgba(220, 215, 255, 0.55)';
      setTimeout(() => {
        if (this.flashEl) this.flashEl.style.background = 'rgba(220, 215, 255, 0.15)';
        setTimeout(() => {
          if (this.flashEl) this.flashEl.style.background = 'rgba(220, 215, 255, 0.25)';
          setTimeout(() => {
            if (this.flashEl) this.flashEl.style.background = 'rgba(0,0,0,0)';
          }, 100);
        }, 150);
      }, 80);
    }

    // 让云层瞬间被照亮
    if (this.layers.clouds) {
      this.layers.clouds.userData.flashStrength = 1;
    }
  }

  // -------------------- 地面 --------------------
  _buildGround() {
    const geo = new THREE.PlaneGeometry(2000, 600);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(0x0f172a) },
        uSnowColor: { value: new THREE.Color(0xf1f5f9) },
        uSnowAmount: { value: 0 },
        uWetness: { value: 0 }, // 0-1 雨后湿地
        uCameraPos: { value: new THREE.Vector3() }
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vWorldPos;
        void main() {
          vUv = uv;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform vec3 uColor;
        uniform vec3 uSnowColor;
        uniform float uSnowAmount;
        uniform float uWetness;
        uniform vec3 uCameraPos;
        varying vec2 vUv;
        varying vec3 vWorldPos;
        ${NOISE_GLSL}
        void main() {
          // 基础地面色
          vec3 col = uColor;
          // 雪覆盖
          float snowN = fbm(vec3(vUv * 8.0, 0.0));
          float snowMask = smoothstep(0.3, 0.7, snowN) * uSnowAmount;
          col = mix(col, uSnowColor, snowMask);
          // 湿地反射（雨天）
          float wet = uWetness * 0.4;
          float dist = length(vWorldPos.xz - uCameraPos.xz);
          float reflectFade = 1.0 - smoothstep(50.0, 300.0, dist);
          col += vec3(0.2, 0.25, 0.35) * wet * reflectFade;
          // 远景雾化
          float fogFade = smoothstep(100.0, 600.0, dist);
          gl_FragColor = vec4(col, 1.0 - fogFade * 0.5);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      fog: false
    });
    this.layers.ground = new THREE.Mesh(geo, mat);
    this.layers.ground.rotation.x = -Math.PI / 2;
    this.layers.ground.position.y = -100;
    this.scene.add(this.layers.ground);
  }

  // -------------------- 雨溅（落地飞溅） --------------------
  _buildSplashes() {
    const maxCount = 200;
    const positions = new Float32Array(maxCount * 3);
    const ages = new Float32Array(maxCount);
    const sizes = new Float32Array(maxCount);
    for (let i = 0; i < maxCount; i++) {
      positions[i * 3] = 0;
      positions[i * 3 + 1] = -200;
      positions[i * 3 + 2] = 0;
      ages[i] = 1; // 已死
      sizes[i] = 0;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('age', new THREE.BufferAttribute(ages, 1));
    geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uOpacity: { value: 0 },
        uPixelRatio: { value: this.dpr },
        uColor: { value: new THREE.Color(0xa5b4fc) }
      },
      vertexShader: `
        attribute float age;
        attribute float size;
        uniform float uPixelRatio;
        varying float vAge;
        void main() {
          vAge = age;
          if (age < 1.0) {
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = size * uPixelRatio * (200.0 / -mv.z) * (1.0 - age);
            gl_Position = projectionMatrix * mv;
          } else {
            gl_Position = vec4(0, 0, -9999, 1);
            gl_PointSize = 0.0;
          }
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vAge;
        void main() {
          if (vAge >= 1.0) discard;
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          float ring = smoothstep(0.5, 0.4, d) * smoothstep(0.2, 0.3, d);
          float center = smoothstep(0.15, 0.0, d) * 0.5;
          float a = (ring + center) * (1.0 - vAge) * uOpacity;
          gl_FragColor = vec4(uColor, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false
    });

    this.layers.splashes = new THREE.Points(geo, mat);
    this.layers.splashes.userData = {
      maxCount,
      positions,
      ages,
      sizes,
      geo,
      spawnTimer: 0
    };
    this.scene.add(this.layers.splashes);
  }

  _spawnSplash() {
    const ud = this.layers.splashes.userData;
    // 找一个已死的 slot
    for (let i = 0; i < ud.maxCount; i++) {
      if (ud.ages[i] >= 1) {
        ud.positions[i * 3] = (Math.random() - 0.5) * 600;
        ud.positions[i * 3 + 1] = -95;
        ud.positions[i * 3 + 2] = (Math.random() - 0.5) * 200 - 50;
        ud.ages[i] = 0;
        ud.sizes[i] = 3 + Math.random() * 4;
        return;
      }
    }
  }

  // -------------------- 公共接口 --------------------
  setWeather(type, intensity = 0.5, windSpeed = 0) {
    if (!WEATHER_THEMES[type]) type = 'sunny';
    // 同种天气切换（如切换城市查询）：仍需更新强度和风速
    if (type === this.targetType) {
      this.intensity = intensity;
      this.windSpeed = windSpeed;
      return;
    }
    this.targetType = type;
    this.intensity = intensity;
    this.windSpeed = windSpeed;
    this.transitionProgress = 0;
    this._transitionStartTime = this.elapsed;

    // 设置目标主题
    const dayT = WEATHER_THEMES[type];
    const nightT = NIGHT_THEMES[type] || dayT;
    const blend = 1 - this.dayFactor;
    this.tgtTheme = {
      top: dayT.top.clone().lerp(nightT.top, blend),
      horizon: dayT.horizon.clone().lerp(nightT.horizon, blend),
      ground: dayT.ground.clone(),
      fog: dayT.fog.clone(),
      sunColor: dayT.sunColor.clone().lerp(nightT.sunColor, blend),
      light: dayT.light.clone()
    };

    // 设置目标可见性
    const v = {
      sky: 1,
      sun: 0,
      stars: 0,
      clouds: 0,
      rain: 0,
      snow: 0,
      fog: 0,
      lightning: 0,
      splashes: 0
    };
    switch (type) {
      case 'sunny':
        v.sun = 1;
        v.stars = blend > 0.5 ? 1 : 0.3;
        break;
      case 'partlyCloudy':
        v.sun = 0.7;
        v.clouds = 0.6;
        v.stars = blend > 0.5 ? 0.5 : 0;
        break;
      case 'cloudy':
        v.clouds = 1;
        v.sun = 0.2;
        break;
      case 'rain':
        v.clouds = 0.9;
        v.rain = 1;
        v.splashes = 1;
        v.fog = 0.3;
        break;
      case 'storm':
        v.clouds = 1;
        v.rain = 1;
        v.splashes = 1;
        v.lightning = 1;
        v.fog = 0.4;
        break;
      case 'snow':
        v.clouds = 0.7;
        v.snow = 1;
        v.fog = 0.3;
        break;
      case 'fog':
        v.clouds = 0.5;
        v.fog = 1;
        break;
      case 'haze':
        v.clouds = 0.3;
        v.fog = 1;
        break;
    }
    this.visibility = v;
    this.currentType = type;
  }

  _applyWeatherVisibility(type) {
    // 立即应用（无过渡），用于初始化
    this.setWeather(type, this.intensity, this.windSpeed);
    this.transitionProgress = 1;
    this.curVisibility = Object.assign({}, this.visibility);
    this.curTheme = Object.assign({}, this.tgtTheme);
    this._applyThemeToScene();
    this._applyVisibilityToScene();
  }

  _applyThemeToScene() {
    const sky = this.layers.sky.material;
    sky.uniforms.topColor.value.copy(this.curTheme.top);
    sky.uniforms.horizonColor.value.copy(this.curTheme.horizon);
    sky.uniforms.groundColor.value.copy(this.curTheme.ground);

    this.scene.fog.color.copy(this.curTheme.fog);
    this.renderer.setClearColor(this.curTheme.top, 1);

    // 太阳颜色
    if (this.layers.sun) {
      const ud = this.layers.sun.userData;
      ud.sunMat.color.copy(this.curTheme.sunColor);
      ud.glow1.material.color.copy(this.curTheme.sunColor);
      ud.glow2.material.color.copy(this.curTheme.sunColor);
      ud.rayMat.uniforms.uColor.value.copy(this.curTheme.sunColor);
    }

    // 雾色
    if (this.layers.fog) {
      this.layers.fog.material.uniforms.uColor.value.copy(this.curTheme.fog);
    }
  }

  _applyVisibilityToScene() {
    const v = this.curVisibility;
    if (this.layers.sun) this.layers.sun.visible = v.sun > 0.01;
    if (this.layers.stars) {
      this.layers.stars.visible = v.stars > 0.01;
      this.layers.stars.material.uniforms.uOpacity.value = v.stars;
    }
    if (this.layers.clouds) this.layers.clouds.visible = v.clouds > 0.01;
    if (this.layers.rain) {
      this.layers.rain.visible = v.rain > 0.01;
      this.layers.rain.material.uniforms.uOpacity.value = v.rain;
    }
    if (this.layers.snow) {
      this.layers.snow.visible = v.snow > 0.01;
      this.layers.snow.material.uniforms.uOpacity.value = v.snow;
    }
    if (this.layers.fog) {
      this.layers.fog.visible = v.fog > 0.01;
      this.layers.fog.material.uniforms.uOpacity.value = v.fog;
    }
    if (this.layers.splashes) {
      this.layers.splashes.visible = v.splashes > 0.01;
      this.layers.splashes.material.uniforms.uOpacity.value = v.splashes;
    }
  }

  setDayFactor(dayFactor) {
    this.dayFactor = dayFactor;
    // 重新计算目标主题（应用昼夜混合）
    const type = this.targetType;
    const dayT = WEATHER_THEMES[type];
    const nightT = NIGHT_THEMES[type] || dayT;
    const blend = 1 - dayFactor;
    this.tgtTheme = {
      top: dayT.top.clone().lerp(nightT.top, blend),
      horizon: dayT.horizon.clone().lerp(nightT.horizon, blend),
      ground: dayT.ground.clone(),
      fog: dayT.fog.clone(),
      sunColor: dayT.sunColor.clone().lerp(nightT.sunColor, blend),
      light: dayT.light.clone()
    };
  }

  setTilt(tiltX) {
    this.tiltX = tiltX;
  }

  resize() {
    this._onResize();
  }

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w === this.vpW && h === this.vpH) return;
    this.vpW = w;
    this.vpH = h;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.composer) {
      this.composer.setPixelRatio(this.dpr);
      this.composer.setSize(w, h);
    }
  }

  dispose() {
    this.running = false;
    if (this.rAF) cancelAnimationFrame(this.rAF);
    window.removeEventListener('resize', this._boundResize);
    // 释放资源
    this.scene.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
        else obj.material.dispose();
      }
    });
    if (this.renderer) this.renderer.dispose();
  }

  // -------------------- 主循环 --------------------
  _tick() {
    if (!this.running) return;
    this.rAF = requestAnimationFrame(this._boundTick);
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.elapsed += dt;

    // FPS 自适应
    this._updateFpsAdaptive();

    // 过渡进度
    if (this.transitionProgress < 1) {
      this.transitionProgress = Math.min(1, this.transitionProgress + dt / this.transitionDuration);
    }

    // 颜色插值：每帧朝目标 lerp（dt/0.8 意味着约 0.8 秒收敛）
    const lerpFactor = Math.min(dt / 0.8, 1);
    this.curTheme.top.lerp(this.tgtTheme.top, lerpFactor);
    this.curTheme.horizon.lerp(this.tgtTheme.horizon, lerpFactor);
    this.curTheme.ground.lerp(this.tgtTheme.ground, lerpFactor);
    this.curTheme.fog.lerp(this.tgtTheme.fog, lerpFactor);
    this.curTheme.sunColor.lerp(this.tgtTheme.sunColor, lerpFactor);
    this.curTheme.light.lerp(this.tgtTheme.light, lerpFactor);
    this._applyThemeToScene();

    // 可见性插值
    for (const key in this.visibility) {
      this.curVisibility[key] = THREE.MathUtils.lerp(this.curVisibility[key], this.visibility[key], lerpFactor);
    }
    this._applyVisibilityToScene();

    // 更新各层动画
    this._updateSun(dt);
    this._updateStars(dt);
    this._updateClouds(dt);
    this._updateRain(dt);
    this._updateSnow(dt);
    this._updateFog(dt);
    this._updateLightning(dt);
    this._updateGround(dt);
    this._updateSplashes(dt);

    // 渲染
    if (this.composer) {
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  _updateFpsAdaptive() {
    const now = performance.now();
    this.fpsSamples.push(now);
    if (now - this.fpsLastCheck < 1000) return;
    const samples = this.fpsSamples;
    const n = samples.length;
    this.fpsLastCheck = now;
    this.fpsSamples = [];
    if (n < 10) return;
    const fps = (n - 1) * 1000 / (samples[n - 1] - samples[0]);
    if (fps < 40 && this.dynamicScale > 0.4) {
      this.dynamicScale = Math.max(0.4, this.dynamicScale - 0.15);
      this._applyDynamicScale();
    } else if (fps > 55 && this.dynamicScale < 1) {
      this.dynamicScale = Math.min(1, this.dynamicScale + 0.05);
    }
  }

  _applyDynamicScale() {
    // 调整粒子数量相关参数
    if (this.layers.rain) {
      this.layers.rain.geometry.setDrawRange(0, Math.floor(1500 * this.dynamicScale));
    }
    if (this.layers.snow) {
      this.layers.snow.geometry.setDrawRange(0, Math.floor(800 * this.dynamicScale));
    }
  }

  _updateSun(dt) {
    if (!this.layers.sun) return;
    const ud = this.layers.sun.userData;
    ud.rayMat.uniforms.uTime.value = this.elapsed;
    ud.rayMat.uniforms.uOpacity.value = this.curVisibility.sun;
    ud.glow1.material.opacity = 0.8 * this.curVisibility.sun;
    ud.glow2.material.opacity = 0.35 * this.curVisibility.sun;
    ud.sunMat.opacity = this.curVisibility.sun;
    // 太阳位置（昼夜变化）
    const angle = (this.dayFactor - 0.5) * Math.PI; // -π/2 夜，π/2 正午
    this.layers.sun.position.x = Math.cos(angle) * 200;
    this.layers.sun.position.y = Math.sin(angle) * 150 + 30;
    // 让 god rays 始终面向相机
    if (this.camera) {
      this.layers.sun.children[2].lookAt(this.camera.position);
    }
  }

  _updateStars(dt) {
    if (!this.layers.stars || !this.layers.stars.visible) return;
    this.layers.stars.material.uniforms.uTime.value = this.elapsed;
  }

  _updateClouds(dt) {
    if (!this.layers.clouds || !this.layers.clouds.visible) return;
    const ud = this.layers.clouds.userData;
    const wind = this.windSpeed * 0.5 + 0.3;
    // 闪光衰减
    if (ud.flashStrength > 0) {
      ud.flashStrength = Math.max(0, ud.flashStrength - dt * 4);
    }
    ud.layers.forEach(({ group, depth }) => {
      const speed = (0.3 + depth * 0.6) * wind;
      group.children.forEach((sprite) => {
        sprite.position.x += speed * dt * 5;
        // 循环
        if (sprite.position.x > 500) sprite.position.x = -500;
        // 微浮动
        sprite.position.y += Math.sin(this.elapsed * 0.5 + sprite.userData.phase) * dt * 2;
        // 闪电时云朵变亮
        if (ud.flashStrength > 0) {
          const baseOp = 0.5 + depth * 0.3;
          sprite.material.opacity = baseOp + ud.flashStrength * 0.6;
          sprite.material.color.setRGB(1, 1, 1 + ud.flashStrength * 0.3);
        } else {
          const baseOp = (0.5 + depth * 0.3) * this.curVisibility.clouds;
          if (Math.abs(sprite.material.opacity - baseOp) > 0.01) {
            sprite.material.opacity = baseOp;
          }
          sprite.material.color.setRGB(1, 1, 1);
        }
      });
    });
  }

  _updateRain(dt) {
    if (!this.layers.rain || !this.layers.rain.visible) return;
    const mat = this.layers.rain.material;
    // 限制 uTime 范围（% 100），避免长时间运行后浮点精度损失
    // 着色器内会对 uTime 再按雨滴周期取模，所以这里取模不影响视觉
    mat.uniforms.uTime.value = this.elapsed % 100;
    mat.uniforms.uOpacity.value = this.curVisibility.rain;
  }

  _updateSnow(dt) {
    if (!this.layers.snow || !this.layers.snow.visible) return;
    const mat = this.layers.snow.material;
    // 限制 uTime 范围，避免长时间运行后浮点精度损失
    mat.uniforms.uTime.value = this.elapsed % 100;
    mat.uniforms.uOpacity.value = this.curVisibility.snow;
  }

  _updateFog(dt) {
    if (!this.layers.fog || !this.layers.fog.visible) return;
    const mat = this.layers.fog.material;
    mat.uniforms.uTime.value = this.elapsed;
    mat.uniforms.uOpacity.value = this.curVisibility.fog;
    // 雾/霾切换
    const isHaze = (this.targetType === 'haze') ? 1 : 0;
    mat.uniforms.uHaze.value = THREE.MathUtils.lerp(mat.uniforms.uHaze.value, isHaze, dt / 1);
  }

  _updateLightning(dt) {
    if (!this.layers.lightning) return;
    const ud = this.layers.lightning.userData;
    if (this.curVisibility.lightning > 0.1) {
      // 闪电调度
      this.nextLightningAt -= dt;
      if (this.nextLightningAt <= 0 && !ud.active) {
        this._generateLightning();
        this.nextLightningAt = 3 + Math.random() * 5;
      }
    }
    // 活跃闪电衰减
    if (ud.active) {
      ud.timer += dt;
      ud.mat.opacity = Math.max(0, 1 - ud.timer * 3);
      if (ud.timer > 0.4) {
        ud.active = false;
        ud.mat.opacity = 0;
      }
    }
  }

  _updateGround(dt) {
    if (!this.layers.ground) return;
    const mat = this.layers.ground.material;
    mat.uniforms.uTime.value = this.elapsed;
    mat.uniforms.uCameraPos.value.copy(this.camera.position);
    // 雪量
    const targetSnow = (this.targetType === 'snow') ? 1 : 0;
    mat.uniforms.uSnowAmount.value = THREE.MathUtils.lerp(mat.uniforms.uSnowAmount.value, targetSnow, dt / 2);
    // 湿度
    const targetWet = (this.targetType === 'rain' || this.targetType === 'storm') ? 1 : 0;
    mat.uniforms.uWetness.value = THREE.MathUtils.lerp(mat.uniforms.uWetness.value, targetWet, dt / 2);
  }

  _updateSplashes(dt) {
    if (!this.layers.splashes || !this.layers.splashes.visible) return;
    const ud = this.layers.splashes.userData;
    // 生成新飞溅
    ud.spawnTimer += dt;
    const spawnInterval = 0.02 / Math.max(0.1, this.curVisibility.splashes);
    while (ud.spawnTimer > spawnInterval) {
      ud.spawnTimer -= spawnInterval;
      this._spawnSplash();
    }
    // 更新年龄
    for (let i = 0; i < ud.maxCount; i++) {
      if (ud.ages[i] < 1) {
        ud.ages[i] += dt * 2.5;
        if (ud.ages[i] > 1) ud.ages[i] = 1;
      }
    }
    ud.geo.attributes.age.needsUpdate = true;
    ud.geo.attributes.position.needsUpdate = true;
  }
}

// ===================== 自定义后处理 Shader =====================
// 简化版景深 + 颜色分级
const SkyWeatherShader = {
  uniforms: {
    tDiffuse: { value: null },
    focalDepth: { value: 80.0 },
    aperture: { value: 0.002 },
    focalLength: { value: 30.0 },
    uTime: { value: 0 }
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float focalDepth;
    uniform float aperture;
    uniform float focalLength;
    uniform float uTime;
    varying vec2 vUv;
    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      // 轻微的色调提升
      col.rgb = pow(col.rgb, vec3(0.95));
      // 暗角
      vec2 c = vUv - 0.5;
      float vignette = 1.0 - dot(c, c) * 0.4;
      col.rgb *= vignette;
      gl_FragColor = col;
    }
  `
};

// ===================== 兼容入口：暴露到 window =====================
// 这样 index.html 中可以直接调用 window.SkyWeatherRenderer
if (typeof window !== 'undefined') {
  window.SkyWeatherRenderer = SkyWeatherRenderer;
}
