/// 天气图标组件
/// 根据 WeatherType 与是否白天返回对应的 Material Icon

import 'package:flutter/material.dart';
import '../utils/theme.dart';
import '../utils/wmo_weather.dart';

class WeatherIcon extends StatelessWidget {
  final WeatherType type;
  final bool isDay;
  final double size;
  final Color? color;

  const WeatherIcon({
    super.key,
    required this.type,
    this.isDay = true,
    this.size = 64,
    this.color,
  });

  @override
  Widget build(BuildContext context) {
    final iconColor = color ?? weatherAccentColor(type);
    final icon = _iconForType(type, isDay);
    return Icon(
      icon,
      size: size,
      color: iconColor,
      shadows: [
        Shadow(
          color: iconColor.withValues(alpha: 0.5),
          blurRadius: 12,
        ),
      ],
    );
  }

  IconData _iconForType(WeatherType t, bool day) {
    switch (t) {
      case WeatherType.sunny:
        return day ? Icons.wb_sunny : Icons.nights_stay;
      case WeatherType.partlyCloudy:
        return day ? Icons.wb_cloudy : Icons.nights_stay;
      case WeatherType.cloudy:
        return Icons.cloud;
      case WeatherType.rain:
        return Icons.grain;
      case WeatherType.storm:
        return Icons.thunderstorm;
      case WeatherType.snow:
        return Icons.ac_unit;
      case WeatherType.fog:
        return Icons.foggy;
      case WeatherType.haze:
        return Icons.air;
    }
  }
}
