/// 天气动画 CustomPainter
///
/// 根据 [WeatherType] 渲染小米天气级别的动态背景动画。
/// 动画由外部传入的 [progress] (0.0 - 1.0) 驱动，所有粒子位置都是
/// 初始位置与 progress 的确定性函数，因此切换天气时位置稳定。
///
/// 仅依赖 dart:ui / flutter，不使用第三方包。

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../utils/wmo_weather.dart';

/// 正数化取模，保证结果落在 [0, 1)
double _mod1(double v) => ((v % 1.0) + 1.0) % 1.0;

/// ===================================================================
/// 粒子辅助类
/// ===================================================================

/// 雨滴：归一化坐标 + 下落速度 + 长度，风偏由统一倾角实现
class _RainDrop {
  final double x; // 0..1
  final double y; // 0..1 起始
  final double speed; // 每个进度周期下落的屏幕高度比例
  final double length; // 像素

  _RainDrop(this.x, this.y, this.speed, this.length);

  double curY(double progress) => _mod1(y + progress * speed);
}

/// 雪花：缓慢飘落 + 水平摇摆
class _SnowFlake {
  final double x; // 0..1
  final double y; // 0..1 起始
  final double speed; // 下落速度
  final double radius; // 2-5 像素
  final double drift; // 水平摇摆幅度（归一化）
  final double phase; // 摇摆相位

  _SnowFlake(this.x, this.y, this.speed, this.radius, this.drift, this.phase);

  double curY(double progress) => _mod1(y + progress * speed);

  double curX(double progress, double width) {
    return (x + math.sin(progress * 2 * math.pi + phase) * drift) * width;
  }
}

/// 云朵：水平移动，出屏后从另一侧进入
class _Cloud {
  final double x; // 0..1 起始位置（占整段行程的比例）
  final double y; // 0..1 屏幕高度比例（上半区）
  final double scale; // 0.6-1.4
  final double speed; // 每周期行程比例

  _Cloud(this.x, this.y, this.scale, this.speed);

  double curCenterX(double progress, double totalRange, double halfWidth) {
    return _mod1(x + progress * speed) * totalRange - halfWidth;
  }
}

/// 星星：闪烁透明度
class _Star {
  final double x; // 0..1
  final double y; // 0..1
  final double size; // 0.5-2 像素
  final double twinkleSpeed; // 每周期闪烁次数
  final double phase;

  _Star(this.x, this.y, this.size, this.twinkleSpeed, this.phase);

  double opacity(double progress) {
    return 0.3 + 0.7 * (0.5 + 0.5 * math.sin(progress * 2 * math.pi * twinkleSpeed + phase));
  }
}

/// 漂浮光点（晴天白天）：缓慢上升 + 闪烁
class _LightDot {
  final double x; // 0..1
  final double y; // 0..1 起始
  final double riseSpeed; // 上升速度（归一化/周期）
  final double radius; // 1-3 像素
  final double twinkleSpeed;
  final double phase;

  _LightDot(this.x, this.y, this.riseSpeed, this.radius, this.twinkleSpeed, this.phase);

  double curY(double progress) => _mod1(y - progress * riseSpeed);

  double opacity(double progress) {
    return 0.2 + 0.6 * (0.5 + 0.5 * math.sin(progress * 2 * math.pi * twinkleSpeed + phase));
  }
}

/// 雾/霾层：水平移动
class _FogLayer {
  final double y; // 0..1 中心 y
  final double height; // 0..1 高度比例
  final double speed; // 水平速度（行程比例/周期）
  final double opacity; // 0..1
  final double startX; // 0..1 起始

  _FogLayer(this.y, this.height, this.speed, this.opacity, this.startX);

  double curOffset(double progress, double totalRange) {
    return _mod1(startX + progress * speed) * totalRange;
  }
}

/// 地面溅水（雨天）
class _Splash {
  final double x; // 0..1
  final double phase; // 0..1 起始偏移
  final double speed; // 扩展速度

  _Splash(this.x, this.phase, this.speed);

  double expansion(double progress) => _mod1(progress * speed + phase);
}

/// ===================================================================
/// 粒子集合（按天气类型 + 屏幕尺寸缓存）
/// ===================================================================

class _WeatherParticles {
  final WeatherType type;
  final Size size;

  List<_RainDrop> rainDrops = [];
  List<_SnowFlake> snowFlakes = [];
  List<_Cloud> clouds = [];
  List<_Star> stars = [];
  List<_LightDot> lightDots = [];
  List<_FogLayer> fogLayers = [];
  List<_Splash> splashes = [];
  Path? lightningBolt;
  Offset? lightningStart;

  _WeatherParticles(this.type, this.size) {
    _init();
  }

  /// 屏幕尺寸自适应因子
  double get _f => (size.width / 400.0).clamp(0.6, 2.2);

  int _count(int base, int min, int max) =>
      (base * _f).round().clamp(min, max);

  void _init() {
    final r = math.Random(42); // 固定种子保证切换时稳定
    switch (type) {
      case WeatherType.sunny:
        _initSunny(r);
        break;
      case WeatherType.partlyCloudy:
        _initPartlyCloudy(r);
        break;
      case WeatherType.cloudy:
        _initCloudy(r);
        break;
      case WeatherType.rain:
        _initRain(r);
        break;
      case WeatherType.storm:
        _initStorm(r);
        break;
      case WeatherType.snow:
        _initSnow(r);
        break;
      case WeatherType.fog:
        _initFog(r);
        break;
      case WeatherType.haze:
        _initHaze(r);
        break;
    }
  }

  void _initSunny(math.Random r) {
    // 白天漂浮光点 10-20 个
    final dotCount = _count(15, 10, 20);
    for (int i = 0; i < dotCount; i++) {
      lightDots.add(_LightDot(
        r.nextDouble(),
        r.nextDouble(),
        0.3 + r.nextDouble() * 0.5,
        1.0 + r.nextDouble() * 2.0,
        1.0 + r.nextDouble() * 2.0,
        r.nextDouble() * 2 * math.pi,
      ));
    }
    // 夜晚星星 80-120 个
    _initStars(r, _count(100, 80, 120));
  }

  void _initPartlyCloudy(math.Random r) {
    // 云朵 4-6 朵
    final cloudCount = _count(5, 4, 6);
    _initClouds(r, cloudCount, 0.6, 1.3, 0.05, 0.4);
    // 夜晚少量星星
    _initStars(r, _count(40, 30, 50));
  }

  void _initCloudy(math.Random r) {
    // 大量云朵 6-9 朵
    _initClouds(r, _count(8, 6, 9), 0.8, 1.5, 0.03, 0.55);
  }

  void _initRain(math.Random r) {
    // 雨滴 80-120 个
    final dropCount = _count(100, 80, 120);
    for (int i = 0; i < dropCount; i++) {
      rainDrops.add(_RainDrop(
        r.nextDouble(),
        r.nextDouble(),
        0.9 + r.nextDouble() * 0.9,
        10.0 + r.nextDouble() * 15.0,
      ));
    }
    // 暗灰色云层 3-5 朵
    _initClouds(r, _count(4, 3, 5), 0.7, 1.2, 0.04, 0.3);
    // 地面溅水
    final splashCount = _count(18, 12, 24);
    for (int i = 0; i < splashCount; i++) {
      splashes.add(_Splash(
        r.nextDouble(),
        r.nextDouble(),
        0.8 + r.nextDouble() * 1.2,
      ));
    }
  }

  void _initStorm(math.Random r) {
    // 雨滴 120-150 个（更密集）
    final dropCount = _count(135, 120, 150);
    for (int i = 0; i < dropCount; i++) {
      rainDrops.add(_RainDrop(
        r.nextDouble(),
        r.nextDouble(),
        1.2 + r.nextDouble() * 1.0,
        12.0 + r.nextDouble() * 18.0,
      ));
    }
    // 暗黑云层 5-7 朵
    _initClouds(r, _count(6, 5, 7), 0.8, 1.4, 0.04, 0.4);
    // 闪电折线（固定种子，预生成）
    _generateLightning(r);
  }

  void _initSnow(math.Random r) {
    // 雪花 60-80 个
    final flakeCount = _count(70, 60, 80);
    for (int i = 0; i < flakeCount; i++) {
      snowFlakes.add(_SnowFlake(
        r.nextDouble(),
        r.nextDouble(),
        0.15 + r.nextDouble() * 0.2,
        2.0 + r.nextDouble() * 3.0,
        0.01 + r.nextDouble() * 0.04,
        r.nextDouble() * 2 * math.pi,
      ));
    }
    // 浅灰云层 2-3 朵
    _initClouds(r, _count(3, 2, 3), 0.6, 1.0, 0.05, 0.3);
  }

  void _initFog(math.Random r) {
    // 雾层 3-4 层
    final layerCount = _count(4, 3, 4);
    for (int i = 0; i < layerCount; i++) {
      fogLayers.add(_FogLayer(
        0.2 + (i / layerCount) * 0.6 + r.nextDouble() * 0.05,
        0.12 + r.nextDouble() * 0.08,
        0.05 + r.nextDouble() * 0.1,
        0.25 + r.nextDouble() * 0.2,
        r.nextDouble(),
      ));
    }
  }

  void _initHaze(math.Random r) {
    // 霾层 3-4 层
    final layerCount = _count(4, 3, 4);
    for (int i = 0; i < layerCount; i++) {
      fogLayers.add(_FogLayer(
        0.15 + (i / layerCount) * 0.65 + r.nextDouble() * 0.05,
        0.14 + r.nextDouble() * 0.1,
        0.04 + r.nextDouble() * 0.08,
        0.3 + r.nextDouble() * 0.25,
        r.nextDouble(),
      ));
    }
  }

  void _initStars(math.Random r, int count) {
    for (int i = 0; i < count; i++) {
      stars.add(_Star(
        r.nextDouble(),
        r.nextDouble() * 0.7, // 集中在上 70% 区域
        0.5 + r.nextDouble() * 1.5,
        0.8 + r.nextDouble() * 2.2,
        r.nextDouble() * 2 * math.pi,
      ));
    }
  }

  void _initClouds(math.Random r, int count, double sMin, double sMax,
      double yMin, double yMax) {
    for (int i = 0; i < count; i++) {
      clouds.add(_Cloud(
        r.nextDouble(),
        yMin + r.nextDouble() * (yMax - yMin),
        sMin + r.nextDouble() * (sMax - sMin),
        0.03 + r.nextDouble() * 0.06,
      ));
    }
  }

  /// 生成分形闪电折线（从顶部到中部，带一条分支）
  void _generateLightning(math.Random r) {
    final path = Path();
    double x = size.width * (0.3 + r.nextDouble() * 0.4);
    double y = 0.0;
    path.moveTo(x, y);
    final endY = size.height * (0.45 + r.nextDouble() * 0.2);
    while (y < endY) {
      y += 14.0 + r.nextDouble() * 22.0;
      x += (r.nextDouble() - 0.5) * 70.0;
      path.lineTo(x, y);
    }
    // 分支
    if (endY > size.height * 0.2) {
      final branchStart = Offset(x, y - (endY - y) * 0.0); // 在末端附近分支
      double bx = branchStart.dx;
      double by = branchStart.dy;
      final branchPath = Path();
      branchPath.moveTo(bx, by);
      final branchEnd = by + 40.0 + r.nextDouble() * 60.0;
      while (by < branchEnd) {
        by += 12.0 + r.nextDouble() * 18.0;
        bx += (r.nextDouble() - 0.5) * 50.0;
        branchPath.lineTo(bx, by);
      }
      path.addPath(branchPath, Offset.zero);
    }
    lightningBolt = path;
    lightningStart = Offset(x, 0);
  }
}

/// 静态缓存：仅在天气类型变化或屏幕尺寸显著变化时重建粒子
class _ParticleCache {
  static _WeatherParticles? _particles;
  static WeatherType? _type;
  static Size? _size;

  static _WeatherParticles get(WeatherType type, Size size) {
    if (_particles != null &&
        _type == type &&
        _size != null &&
        (_size!.width - size.width).abs() < 12 &&
        (_size!.height - size.height).abs() < 12) {
      return _particles!;
    }
    _particles = _WeatherParticles(type, size);
    _type = type;
    _size = size;
    return _particles!;
  }
}

/// ===================================================================
/// 云朵基础形状（多个圆弧组合，scale=1 时参考尺寸）
/// ===================================================================

const _cloudCircles = <(double, double, double)>[
  (-28.0, 4.0, 22.0),
  (-10.0, -14.0, 28.0),
  (14.0, -10.0, 26.0),
  (32.0, 6.0, 20.0),
  (2.0, 12.0, 24.0),
];

/// 单朵云的参考宽度（用于环绕计算）
const _cloudBaseWidth = 104.0;

/// ===================================================================
/// WeatherPainter
/// ===================================================================

class WeatherPainter extends CustomPainter {
  final WeatherType type;
  final double progress; // 0.0 - 1.0 动画进度，由 AnimationController 驱动
  final bool isDay; // 是否白天

  WeatherPainter({
    required this.type,
    required this.progress,
    this.isDay = true,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final p = _ParticleCache.get(type, size);

    // 1. 背景渐变
    _drawBackground(canvas, size);

    // 2. 按天气类型绘制
    switch (type) {
      case WeatherType.sunny:
        if (isDay) {
          _drawSunnyDay(canvas, size, p);
        } else {
          _drawSunnyNight(canvas, size, p);
        }
        break;
      case WeatherType.partlyCloudy:
        _drawPartlyCloudy(canvas, size, p);
        break;
      case WeatherType.cloudy:
        _drawCloudy(canvas, size, p);
        break;
      case WeatherType.rain:
        _drawRain(canvas, size, p);
        break;
      case WeatherType.storm:
        _drawStorm(canvas, size, p);
        break;
      case WeatherType.snow:
        _drawSnow(canvas, size, p);
        break;
      case WeatherType.fog:
        _drawFog(canvas, size, p, brownish: false);
        break;
      case WeatherType.haze:
        _drawFog(canvas, size, p, brownish: true);
        break;
    }
  }

  @override
  bool shouldRepaint(WeatherPainter old) =>
      type != old.type || progress != old.progress || isDay != old.isDay;

  /// -------------------------------------------------------------------
  /// 背景
  /// -------------------------------------------------------------------

  void _drawBackground(Canvas canvas, Size size) {
    final (top, bottom) = _bgColors(type);
    final paint = Paint()
      ..shader = LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: [top, bottom],
      ).createShader(Offset.zero & size);
    canvas.drawRect(Offset.zero & size, paint);
  }

  (Color, Color) _bgColors(WeatherType t) {
    switch (t) {
      case WeatherType.sunny:
      case WeatherType.partlyCloudy:
        return (const Color(0xFF0F172A), const Color(0xFF1E3A5F));
      case WeatherType.cloudy:
        return (const Color(0xFF0F172A), const Color(0xFF1E293B));
      case WeatherType.rain:
        return (const Color(0xFF0B1220), const Color(0xFF1E3A5F));
      case WeatherType.storm:
        return (const Color(0xFF050510), const Color(0xFF1E293B));
      case WeatherType.snow:
        return (const Color(0xFF1E293B), const Color(0xFF334155));
      case WeatherType.fog:
        return (const Color(0xFF1E293B), const Color(0xFF475569));
      case WeatherType.haze:
        return (const Color(0xFF1C1917), const Color(0xFF44403C));
    }
  }

  /// -------------------------------------------------------------------
  /// 太阳 / 月亮
  /// -------------------------------------------------------------------

  void _drawSun(Canvas canvas, Size size, {double opacity = 1.0}) {
    final center = Offset(size.width * 0.78, size.height * 0.18);
    final discRadius = size.width * 0.09;

    // 径向光晕
    final glowRadius = discRadius * 4.5;
    final glowPaint = Paint()
      ..shader = RadialGradient(
        center: Alignment.center,
        radius: 1.0,
        colors: [
          const Color(0xFFFBBF24).withValues(alpha: 0.55 * opacity),
          const Color(0xFFFBBF24).withValues(alpha: 0.18 * opacity),
          const Color(0xFFFBBF24).withValues(alpha: 0.0),
        ],
      ).createShader(Rect.fromCircle(center: center, radius: glowRadius));
    canvas.drawCircle(center, glowRadius, glowPaint);

    // 旋转光线
    final rayCount = 12;
    final rayAngle = progress * 2 * math.pi;
    final inner = discRadius * 1.25;
    final outer = discRadius * 1.95;
    final rayPaint = Paint()
      ..color = const Color(0xFFFDE68A).withValues(alpha: 0.6 * opacity)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2.0
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 1.5);
    for (int i = 0; i < rayCount; i++) {
      final a = rayAngle + i * (2 * math.pi / rayCount);
      canvas.drawLine(
        Offset(center.dx + math.cos(a) * inner, center.dy + math.sin(a) * inner),
        Offset(center.dx + math.cos(a) * outer, center.dy + math.sin(a) * outer),
        rayPaint,
      );
    }

    // 太阳圆盘
    final discPaint = Paint()
      ..shader = RadialGradient(
        center: Alignment.center,
        radius: 1.0,
        colors: [
          const Color(0xFFFFE9B0).withValues(alpha: opacity),
          const Color(0xFFFBBF24).withValues(alpha: opacity),
        ],
      ).createShader(Rect.fromCircle(center: center, radius: discRadius));
    canvas.drawCircle(center, discRadius, discPaint);
  }

  void _drawMoon(Canvas canvas, Size size) {
    final center = Offset(size.width * 0.8, size.height * 0.16);
    final radius = size.width * 0.075;

    // 月亮光晕
    final glowPaint = Paint()
      ..shader = RadialGradient(
        center: Alignment.center,
        radius: 1.0,
        colors: [
          const Color(0xFFE2E8F0).withValues(alpha: 0.35),
          const Color(0xFFE2E8F0).withValues(alpha: 0.0),
        ],
      ).createShader(Rect.fromCircle(center: center, radius: radius * 3.5));
    canvas.drawCircle(center, radius * 3.5, glowPaint);

    // 月牙：两个圆 even-odd 填充
    final moonPath = Path()
      ..fillType = PathFillType.evenOdd
      ..addOval(Rect.fromCircle(center: center, radius: radius))
      ..addOval(Rect.fromCircle(
        center: center + Offset(radius * 0.45, -radius * 0.25),
        radius: radius * 0.92,
      ));
    final moonPaint = Paint()
      ..color = const Color(0xFFE2E8F0)
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 0.6);
    canvas.drawPath(moonPath, moonPaint);
  }

  void _drawStars(Canvas canvas, Size size, List<_Star> stars) {
    final paint = Paint()..color = Colors.white;
    for (final s in stars) {
      paint.color = Colors.white.withValues(alpha: s.opacity(progress));
      canvas.drawCircle(
        Offset(s.x * size.width, s.y * size.height),
        s.size,
        paint,
      );
    }
  }

  /// -------------------------------------------------------------------
  /// 云朵绘制
  /// -------------------------------------------------------------------

  void _drawCloud(
    Canvas canvas,
    double cx,
    double cy,
    double scale,
    Paint paint,
  ) {
    for (final (dx, dy, r) in _cloudCircles) {
      canvas.drawCircle(
        Offset(cx + dx * scale, cy + dy * scale),
        r * scale,
        paint,
      );
    }
  }

  void _drawClouds(
    Canvas canvas,
    Size size,
    List<_Cloud> clouds,
    Color color, {
    double opacity = 1.0,
  }) {
    final paint = Paint()
      ..color = color.withValues(alpha: opacity)
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 2.0);
    for (final c in clouds) {
      final cloudWidth = _cloudBaseWidth * c.scale;
      final totalRange = size.width + cloudWidth;
      final halfWidth = cloudWidth / 2;
      final cx = c.curCenterX(progress, totalRange, halfWidth);
      final cy = c.y * size.height;
      _drawCloud(canvas, cx, cy, c.scale, paint);
    }
  }

  /// -------------------------------------------------------------------
  /// 各天气类型
  /// -------------------------------------------------------------------

  /// 晴天白天
  void _drawSunnyDay(Canvas canvas, Size size, _WeatherParticles p) {
    _drawSun(canvas, size);
    // 漂浮光点
    final paint = Paint()..color = const Color(0xFFFDE68A);
    for (final d in p.lightDots) {
      paint.color = const Color(0xFFFDE68A).withValues(alpha: d.opacity(progress));
      canvas.drawCircle(
        Offset(d.x * size.width, d.curY(progress) * size.height),
        d.radius,
        paint,
      );
    }
  }

  /// 晴天夜晚
  void _drawSunnyNight(Canvas canvas, Size size, _WeatherParticles p) {
    _drawStars(canvas, size, p.stars);
    _drawMoon(canvas, size);
  }

  /// 多云
  void _drawPartlyCloudy(Canvas canvas, Size size, _WeatherParticles p) {
    if (isDay) {
      _drawSun(canvas, size, opacity: 0.7);
    } else {
      _drawStars(canvas, size, p.stars);
      _drawMoon(canvas, size);
    }
    _drawClouds(canvas, size, p.clouds, const Color(0xFFF1F5F9), opacity: 0.85);
  }

  /// 阴天
  void _drawCloudy(Canvas canvas, Size size, _WeatherParticles p) {
    _drawClouds(canvas, size, p.clouds, const Color(0xFF94A3B8), opacity: 0.9);
  }

  /// 雨天
  void _drawRain(Canvas canvas, Size size, _WeatherParticles p) {
    // 暗灰色云层
    _drawClouds(canvas, size, p.clouds, const Color(0xFF334155), opacity: 0.85);

    // 雨滴
    final dropPaint = Paint()
      ..color = const Color(0xFFCBD5E1).withValues(alpha: 0.7)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.4;
    const wind = 0.22; // 风偏倾角因子
    for (final d in p.rainDrops) {
      final dx = d.x * size.width;
      final dy = d.curY(progress) * size.height;
      canvas.drawLine(
        Offset(dx - d.length * wind, dy - d.length),
        Offset(dx, dy),
        dropPaint,
      );
    }

    // 地面溅水
    _drawSplashes(canvas, size, p.splashes);
  }

  /// 雷暴
  void _drawStorm(Canvas canvas, Size size, _WeatherParticles p) {
    // 闪光强度（多个闪光窗口）
    final flash = _stormFlashOpacity(progress);

    // 暗黑云层（闪光时变亮）
    final cloudColor = Color.lerp(
      const Color(0xFF1E293B),
      const Color(0xFF64748B),
      flash,
    )!;
    _drawClouds(canvas, size, p.clouds, cloudColor, opacity: 0.92);

    // 雨滴（更密集）
    final dropPaint = Paint()
      ..color = const Color(0xFFCBD5E1).withValues(alpha: 0.7)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.3;
    const wind = 0.28;
    for (final d in p.rainDrops) {
      final dx = d.x * size.width;
      final dy = d.curY(progress) * size.height;
      canvas.drawLine(
        Offset(dx - d.length * wind, dy - d.length),
        Offset(dx, dy),
        dropPaint,
      );
    }

    // 闪电折线
    if (flash > 0.01 && p.lightningBolt != null) {
      final boltPaint = Paint()
        ..color = Colors.white.withValues(alpha: flash)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2.5
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 1.5);
      canvas.drawPath(p.lightningBolt!, boltPaint);
      // 闪电核心更亮
      final corePaint = Paint()
        ..color = Colors.white.withValues(alpha: flash)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.2;
      canvas.drawPath(p.lightningBolt!, corePaint);
    }

    // 整屏白光闪烁
    if (flash > 0.01) {
      canvas.drawRect(
        Offset.zero & size,
        Paint()..color = Colors.white.withValues(alpha: flash * 0.35),
      );
    }
  }

  /// 计算雷暴闪光透明度：每个周期内多个闪光窗口（主闪 + 余光）
  double _stormFlashOpacity(double progress) {
    const centers = [0.12, 0.48, 0.78];
    double best = 0.0;
    for (final c in centers) {
      final d = (progress - c).abs();
      double v = 0.0;
      if (d < 0.006) {
        v = 1.0;
      } else if (d < 0.016) {
        v = 0.55;
      } else if (d < 0.035) {
        v = 0.18;
      }
      if (v > best) best = v;
    }
    return best;
  }

  /// 雪
  void _drawSnow(Canvas canvas, Size size, _WeatherParticles p) {
    // 浅灰云层
    _drawClouds(canvas, size, p.clouds, const Color(0xFF64748B), opacity: 0.5);

    // 雪花
    final paint = Paint()..color = Colors.white;
    for (final s in p.snowFlakes) {
      final cy = s.curY(progress) * size.height;
      final cx = s.curX(progress, size.width);
      paint.color = Colors.white.withValues(alpha: 0.85);
      canvas.drawCircle(Offset(cx, cy), s.radius, paint);
    }
  }

  /// 雾 / 霾
  void _drawFog(Canvas canvas, Size size, _WeatherParticles p,
      {required bool brownish}) {
    final baseColor =
        brownish ? const Color(0xFFA8A29E) : const Color(0xFFCBD5E1);

    for (final layer in p.fogLayers) {
      final y = layer.y * size.height;
      final h = layer.height * size.height;

      // 整层水平渐变背景
      final bandPaint = Paint()
        ..shader = LinearGradient(
          begin: Alignment.centerLeft,
          end: Alignment.centerRight,
          colors: [
            baseColor.withValues(alpha: 0.0),
            baseColor.withValues(alpha: layer.opacity),
            baseColor.withValues(alpha: layer.opacity),
            baseColor.withValues(alpha: 0.0),
          ],
        ).createShader(Rect.fromLTWH(0, y - h / 2, size.width, h));
      canvas.drawRect(
        Rect.fromLTWH(0, y - h / 2, size.width, h),
        bandPaint,
      );

      // 移动的模糊团块（增加纹理与动感）
      final totalRange = size.width + 240.0;
      final offset = layer.curOffset(progress, totalRange);
      final blobPaint = Paint()
        ..color = baseColor.withValues(alpha: layer.opacity * 0.6)
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 18.0);
      for (int i = 0; i < 4; i++) {
        final bx = ((offset + i * (size.width / 3)) % totalRange) - 120.0;
        final oval = Rect.fromCenter(
          center: Offset(bx + 120, y),
          width: 260,
          height: h * 0.9,
        );
        canvas.drawOval(oval, blobPaint);
      }
    }
  }

  /// 地面溅水效果
  void _drawSplashes(Canvas canvas, Size size, List<_Splash> splashes) {
    final groundY = size.height - 6.0;
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.2;
    for (final s in splashes) {
      final e = s.expansion(progress); // 0..1
      final radius = e * 7.0;
      if (radius < 0.5) continue;
      final opacity = (1.0 - e) * 0.5;
      paint.color = Colors.white.withValues(alpha: opacity);
      canvas.drawCircle(Offset(s.x * size.width, groundY), radius, paint);
    }
  }
}
