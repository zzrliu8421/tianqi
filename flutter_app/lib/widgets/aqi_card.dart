/// AQI 空气质量卡片
/// 仅当 current.aqi != null 时显示

import 'dart:math';
import 'package:flutter/material.dart';
import '../models/weather.dart';
import '../utils/helpers.dart';

class AqiCard extends StatelessWidget {
  final CurrentWeather current;

  const AqiCard({super.key, required this.current});

  @override
  Widget build(BuildContext context) {
    if (current.aqi == null) {
      return const SizedBox.shrink();
    }

    final info = getAQIInfo(current.aqi);
    final progress = (current.aqi! / 300).clamp(0.0, 1.0);

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
              Icon(Icons.ec, size: 18, color: info.color),
              const SizedBox(width: 6),
              const Text(
                '空气质量',
                style: TextStyle(
                  color: Color(0xFFF8FAFC),
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const Spacer(),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: info.color.withOpacity(0.18),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: info.color.withOpacity(0.5)),
                ),
                child: Text(
                  info.level,
                  style: TextStyle(
                    color: info.color,
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              // 圆环进度
              SizedBox(
                width: 110,
                height: 110,
                child: CustomPaint(
                  painter: _AqiRingPainter(
                    progress: progress,
                    color: info.color,
                  ),
                  child: Center(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Text(
                          '${current.aqi}',
                          style: TextStyle(
                            color: info.color,
                            fontSize: 28,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        const Text(
                          'AQI',
                          style: TextStyle(
                            color: Color(0x80F8FAFC),
                            fontSize: 11,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 20),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      info.description,
                      style: const TextStyle(
                        color: Color(0xF2F8FAFC),
                        fontSize: 14,
                      ),
                    ),
                    const SizedBox(height: 14),
                    Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      children: [
                        _pollutantTag('PM2.5', current.aqiPm25, 'μg/m³'),
                        _pollutantTag('PM10', current.aqiPm10, 'μg/m³'),
                        _pollutantTag('NO₂', current.aqiNo2, 'μg/m³'),
                        _pollutantTag('O₃', current.aqiO3, 'μg/m³'),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _pollutantTag(String name, double? value, String unit) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
      decoration: BoxDecoration(
        color: const Color(0x08FFFFFF),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: const Color(0x14FFFFFF)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            name,
            style: const TextStyle(
              color: Color(0xB3F8FAFC),
              fontSize: 11,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(width: 4),
          Text(
            value != null ? value.toStringAsFixed(0) : '--',
            style: const TextStyle(
              color: Color(0xFFF8FAFC),
              fontSize: 12,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(width: 2),
          Text(
            unit,
            style: const TextStyle(color: Color(0x66F8FAFC), fontSize: 9),
          ),
        ],
      ),
    );
  }
}

/// AQI 圆环绘制器（dasharray 效果）
class _AqiRingPainter extends CustomPainter {
  final double progress;
  final Color color;

  _AqiRingPainter({required this.progress, required this.color});

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = (size.width - 12) / 2;

    // 背景轨道（虚线）
    final trackPaint = Paint()
      ..color = const Color(0x22FFFFFF)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 6
      ..strokeCap = StrokeCap.round;
    canvas.drawArc(
      Rect.fromCircle(center: center, radius: radius),
      -pi / 2,
      2 * pi,
      false,
      trackPaint,
    );

    // 进度弧（带 dasharray）
    final progressPaint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 8
      ..strokeCap = StrokeCap.round;
    canvas.drawArc(
      Rect.fromCircle(center: center, radius: radius),
      -pi / 2,
      2 * pi * progress,
      false,
      progressPaint,
    );

    // 端点圆点
    final endAngle = -pi / 2 + 2 * pi * progress;
    final dot = Offset(
      center.dx + radius * cos(endAngle),
      center.dy + radius * sin(endAngle),
    );
    canvas.drawCircle(
      dot,
      6,
      Paint()..color = color,
    );
    canvas.drawCircle(
      dot,
      6,
      Paint()
        ..color = Colors.white.withOpacity(0.4)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.5,
    );
  }

  @override
  bool shouldRepaint(covariant _AqiRingPainter old) =>
      old.progress != progress || old.color != color;
}
