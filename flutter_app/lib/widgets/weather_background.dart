/// 动画背景容器
/// 底层为天气类型对应的背景渐变色，上层为粒子动画
/// 子组件叠加在动画之上

import 'package:flutter/material.dart';
import '../painters/weather_painter.dart';
import '../utils/theme.dart';
import '../utils/wmo_weather.dart';

class WeatherBackground extends StatefulWidget {
  final WeatherType type;
  final Widget child;
  final bool isDay;

  const WeatherBackground({
    super.key,
    required this.type,
    required this.child,
    this.isDay = true,
  });

  @override
  State<WeatherBackground> createState() => _WeatherBackgroundState();
}

class _WeatherBackgroundState extends State<WeatherBackground>
    with TickerProviderStateMixin {
  late AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 20),
    )..repeat();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) {
        return Container(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: [
                weatherBgColor(widget.type),
                weatherAccentColor(widget.type).withValues(alpha: 0.35),
                weatherBgColor(widget.type),
              ],
            ),
          ),
          child: Stack(
            children: [
              // 粒子动画层
              Positioned.fill(
                child: CustomPaint(
                  painter: WeatherPainter(
                    type: widget.type,
                    progress: _controller.value,
                    isDay: widget.isDay,
                  ),
                ),
              ),
              // 内容层
              widget.child,
            ],
          ),
        );
      },
    );
  }
}
