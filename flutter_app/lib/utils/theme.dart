/// 主题配置：天气类型对应的主色调 + 暗色主题

import 'package:flutter/material.dart';
import 'wmo_weather.dart';

/// 天气类型对应的背景主色
Color weatherBgColor(WeatherType type) {
  switch (type) {
    case WeatherType.sunny:
    case WeatherType.partlyCloudy:
    case WeatherType.cloudy:
      return const Color(0xFF0F172A); // 深蓝
    case WeatherType.rain:
      return const Color(0xFF0B1220); // 更深的蓝
    case WeatherType.storm:
      return const Color(0xFF050510); // 近黑
    case WeatherType.snow:
      return const Color(0xFF1E293B); // 蓝灰
    case WeatherType.fog:
      return const Color(0xFF1E293B);
    case WeatherType.haze:
      return const Color(0xFF1C1917); // 棕黑
  }
}

/// 天气类型对应的强调色（渐变终点）
Color weatherAccentColor(WeatherType type) {
  switch (type) {
    case WeatherType.sunny:
      return const Color(0xFFFBBF24); // 暖黄
    case WeatherType.partlyCloudy:
      return const Color(0xFF38BDF8); // 天蓝
    case WeatherType.cloudy:
      return const Color(0xFF94A3B8); // 灰
    case WeatherType.rain:
      return const Color(0xFF38BDF8); // 蓝
    case WeatherType.storm:
      return const Color(0xFF818CF8); // 紫蓝
    case WeatherType.snow:
      return const Color(0xFFE0F2FE); // 雪白蓝
    case WeatherType.fog:
      return const Color(0xFFCBD5E1); // 雾灰
    case WeatherType.haze:
      return const Color(0xFFA8A29E); // 霾棕
  }
}

/// 全局暗色主题
ThemeData appTheme() {
  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    scaffoldBackgroundColor: const Color(0xFF0B0F19),
    colorScheme: const ColorScheme.dark(
      primary: Color(0xFF38BDF8),
      secondary: Color(0xFF818CF8),
      surface: Color(0xFF111827),
      onSurface: Color(0xFFF8FAFC),
    ),
    textTheme: const TextTheme(
      bodyLarge: TextStyle(color: Color(0xFFF8FAFC)),
      bodyMedium: TextStyle(color: Color(0xFFF8FAFC)),
      bodySmall: TextStyle(color: Color(0x72F8FAFC)),
    ),
    cardTheme: const CardThemeData(
      color: Color(0x0AFFFFFF), // 玻璃态
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(20)),
      ),
    ),
  );
}

/// 玻璃态容器装饰
LinearGradient glassGradient() {
  return const LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0x0AFFFFFF), Color(0x06FFFFFF)],
  );
}
