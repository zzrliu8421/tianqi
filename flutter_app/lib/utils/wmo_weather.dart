/// 天气类型枚举与 WMO weather_code 映射
/// 参考: https://open-meteo.com/en/docs (WMO Weather interpretation codes)

/// 8 种内部天气类型（与 Web 版 weatherTypeMap 对应）
enum WeatherType {
  sunny,        // 晴
  partlyCloudy, // 多云
  cloudy,       // 阴
  rain,         // 雨
  storm,        // 雷暴
  snow,         // 雪
  fog,          // 雾
  haze,         // 霾
}

/// WMO weather_code → {中文文本, WeatherType} 映射
class WmoWeather {
  /// 返回天气中文文本
  static String text(int code) {
    return _map[code]?.$1 ?? '未知';
  }

  /// 返回天气类型
  static WeatherType type(int code) {
    return _map[code]?.$2 ?? WeatherType.sunny;
  }

  /// 同时返回文本和类型
  static (String, WeatherType) info(int code) {
    return _map[code] ?? ('未知', WeatherType.sunny);
  }

  /// 判断是否白天（用于天气图标选择）
  static bool isDay(int hour) => hour >= 6 && hour < 19;

  /// WMO Weather interpretation codes (WW)
  /// https://open-meteo.com/en/docs
  static const Map<int, (String, WeatherType)> _map = {
    0:  ('晴', WeatherType.sunny),
    1:  ('晴间多云', WeatherType.partlyCloudy),
    2:  ('多云', WeatherType.partlyCloudy),
    3:  ('阴', WeatherType.cloudy),
    45: ('雾', WeatherType.fog),
    48: ('雾凇', WeatherType.fog),
    51: ('小毛毛雨', WeatherType.rain),
    53: ('毛毛雨', WeatherType.rain),
    55: ('大毛毛雨', WeatherType.rain),
    56: ('冻毛毛雨', WeatherType.rain),
    57: ('强冻毛毛雨', WeatherType.rain),
    61: ('小雨', WeatherType.rain),
    63: ('中雨', WeatherType.rain),
    65: ('大雨', WeatherType.rain),
    66: ('冻雨', WeatherType.rain),
    67: ('强冻雨', WeatherType.rain),
    71: ('小雪', WeatherType.snow),
    73: ('中雪', WeatherType.snow),
    75: ('大雪', WeatherType.snow),
    77: ('米雪', WeatherType.snow),
    80: ('小阵雨', WeatherType.rain),
    81: ('阵雨', WeatherType.rain),
    82: ('强阵雨', WeatherType.rain),
    85: ('小阵雪', WeatherType.snow),
    86: ('强阵雪', WeatherType.snow),
    95: ('雷阵雨', WeatherType.storm),
    96: ('雷阵雨伴冰雹', WeatherType.storm),
    99: ('强雷阵雨伴冰雹', WeatherType.storm),
  };

  /// 根据文本关键词推断天气类型（用于非 WMO 数据源如高德）
  static WeatherType typeFromText(String text) {
    final t = text.toLowerCase();
    if (t.contains('雷') || t.contains('thunder')) return WeatherType.storm;
    if (t.contains('雪') || t.contains('snow') || t.contains('sleet')) return WeatherType.snow;
    if (t.contains('雨') || t.contains('rain') || t.contains('drizzle') || t.contains('shower')) return WeatherType.rain;
    if (t.contains('雾') || t.contains('fog') || t.contains('mist')) return WeatherType.fog;
    if (t.contains('霾') || t.contains('haze') || t.contains('smog') || t.contains('dust') || t.contains('sand')) return WeatherType.haze;
    if (t.contains('阴') || t.contains('overcast')) return WeatherType.cloudy;
    if (t.contains('多云') || t.contains('partly') || t.contains('mainly clear')) return WeatherType.partlyCloudy;
    return WeatherType.sunny;
  }
}
