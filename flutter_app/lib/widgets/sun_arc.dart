/// 日出日落弧线组件
/// 仅当 daily[0].sunrise 或 sunset 存在时显示

import 'dart:math';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../models/weather.dart';

class SunArc extends StatelessWidget {
  final DailyForecast? today;

  const SunArc({super.key, this.today});

  @override
  Widget build(BuildContext context) {
    final sunrise = today?.sunrise;
    final sunset = today?.sunset;
    if (sunrise == null && sunset == null) {
      return const SizedBox.shrink();
    }

    final now = DateTime.now();
    double sunProgress = 0.5; // 默认正午
    bool isDaytime = false;
    if (sunrise != null && sunset != null) {
      if (now.isAfter(sunrise) && now.isBefore(sunset)) {
        final totalMin = sunset.difference(sunrise).inMinutes;
        final elapsed = now.difference(sunrise).inMinutes;
        sunProgress = (elapsed / totalMin).clamp(0.0, 1.0);
        isDaytime = true;
      } else {
        sunProgress = now.isBefore(sunrise) ? 0.0 : 1.0;
      }
    }

    final durationMin = (sunrise != null && sunset != null)
        ? sunset.difference(sunrise).inMinutes
        : 0;
    final durationLabel = Duration(minutes: durationMin);
    final h = durationLabel.inHours;
    final m = durationLabel.inMinutes % 60;

    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      decoration: BoxDecoration(
        color: const Color(0x0AFFFFFF),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: const Color(0x14FFFFFF)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.wb_twilight, size: 18, color: Color(0xFFFBBF24)),
              const SizedBox(width: 6),
              const Text(
                '日出日落',
                style: TextStyle(
                  color: Color(0xFFF8FAFC),
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const Spacer(),
              if (isDaytime)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: const Color(0xFFFBBF24).withValues(alpha: 0.18),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: const Text(
                    '白天',
                    style: TextStyle(color: Color(0xFFFBBF24), fontSize: 11),
                  ),
                )
              else
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: const Color(0xFF818CF8).withValues(alpha: 0.18),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: const Text(
                    '夜晚',
                    style: TextStyle(color: Color(0xFF818CF8), fontSize: 11),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 8),
          SizedBox(
            height: 140,
            child: LayoutBuilder(
              builder: (context, constraints) {
                final w = constraints.maxWidth;
                return Stack(
                  children: [
                    CustomPaint(
                      size: Size(w, 140),
                      painter: _SunArcPainter(
                        progress: sunProgress,
                        isDaytime: isDaytime,
                      ),
                    ),
                    Positioned(
                      left: 8,
                      bottom: 8,
                      child: Column(
                        children: [
                          const Icon(Icons.wb_sunny, size: 16, color: Color(0xFFFBBF24)),
                          const SizedBox(height: 2),
                          Text(
                            sunrise != null
                                ? DateFormat('HH:mm').format(sunrise)
                                : '--:--',
                            style: const TextStyle(
                              color: Color(0xF2F8FAFC),
                              fontSize: 12,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          const Text(
                            '日出',
                            style: TextStyle(
                              color: Color(0x66F8FAFC),
                              fontSize: 10,
                            ),
                          ),
                        ],
                      ),
                    ),
                    Positioned(
                      right: 8,
                      bottom: 8,
                      child: Column(
                        children: [
                          const Icon(Icons.nights_stay, size: 16, color: Color(0xFF818CF8)),
                          const SizedBox(height: 2),
                          Text(
                            sunset != null
                                ? DateFormat('HH:mm').format(sunset)
                                : '--:--',
                            style: const TextStyle(
                              color: Color(0xF2F8FAFC),
                              fontSize: 12,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          const Text(
                            '日落',
                            style: TextStyle(
                              color: Color(0x66F8FAFC),
                              fontSize: 10,
                            ),
                          ),
                        ],
                      ),
                    ),
                    Positioned(
                      top: 8,
                      left: 0,
                      right: 0,
                      child: Center(
                        child: Text(
                          '日照 $h 时 $m 分',
                          style: const TextStyle(
                            color: Color(0xB3F8FAFC),
                            fontSize: 12,
                          ),
                        ),
                      ),
                    ),
                  ],
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

/// 太阳弧线绘制器
class _SunArcPainter extends CustomPainter {
  final double progress; // 0..1
  final bool isDaytime;

  _SunArcPainter({required this.progress, required this.isDaytime});

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    // 弧线起点与终点
    final rect = Rect.fromLTWH(20, 10, w - 40, h * 1.6);

    // 背景虚线弧
    final bgPaint = Paint()
      ..color = const Color(0x33FFFFFF)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2;
    canvas.drawArc(rect, pi, pi, false, bgPaint);

    // 已走过的弧（强调色）
    final fgPaint = Paint()
      ..color = const Color(0xFFFBBF24)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round;
    canvas.drawArc(rect, pi, pi * progress, false, fgPaint);

    // 地平线
    final horizonPaint = Paint()
      ..color = const Color(0x22FFFFFF)
      ..strokeWidth = 1;
    canvas.drawLine(
      Offset(20, h * 0.6),
      Offset(w - 20, h * 0.6),
      horizonPaint,
    );

    // 太阳点
    final sunAngle = pi + pi * progress;
    final sunX = rect.center.dx + (rect.width / 2) * cos(sunAngle);
    final sunY = rect.center.dy + (rect.height / 2) * sin(sunAngle);

    final sunColor = isDaytime ? const Color(0xFFFBBF24) : const Color(0xFF818CF8);

    // 光晕
    final glowPaint = Paint()
      ..shader = RadialGradient(
        colors: [
          sunColor.withValues(alpha: 0.6),
          sunColor.withValues(alpha: 0),
        ],
      ).createShader(Rect.fromCircle(center: Offset(sunX, sunY), radius: 28));
    canvas.drawCircle(Offset(sunX, sunY), 28, glowPaint);

    // 太阳本体
    canvas.drawCircle(
      Offset(sunX, sunY),
      10,
      Paint()..color = sunColor,
    );
  }

  @override
  bool shouldRepaint(covariant _SunArcPainter old) =>
      old.progress != progress || old.isDaytime != isDaytime;
}
