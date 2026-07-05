/// 天气数据模型
/// 与 Web 版归一化后的数据结构一致

import 'location.dart' as m;

/// 顶层天气响应
class WeatherData {
  final m.LocationInfo location;
  final CurrentWeather current;
  final List<HourlyForecast> hourly;
  final List<DailyForecast> daily;
  final String source;
  final DateTime updatedAt;

  WeatherData({
    required this.location,
    required this.current,
    required this.hourly,
    required this.daily,
    required this.source,
    required this.updatedAt,
  });
}

/// 当前天气
class CurrentWeather {
  final double temp;
  final double feelsLike;
  final String weather;
  final int? weatherCode; // WMO 代码
  final int? humidity;
  final double? pressure;
  final double windSpeed;
  final String windDirection;
  final int? windDirectionDeg;
  final double? visibility;
  final double? uv;
  final int? precipProbability;
  final int? aqi;
  final double? aqiPm25;
  final double? aqiPm10;
  final double? aqiNo2;
  final double? aqiO3;

  CurrentWeather({
    required this.temp,
    required this.feelsLike,
    required this.weather,
    this.weatherCode,
    this.humidity,
    this.pressure,
    required this.windSpeed,
    required this.windDirection,
    this.windDirectionDeg,
    this.visibility,
    this.uv,
    this.precipProbability,
    this.aqi,
    this.aqiPm25,
    this.aqiPm10,
    this.aqiNo2,
    this.aqiO3,
  });
}

/// 逐时预报
class HourlyForecast {
  final DateTime time;
  final double temp;
  final String weather;
  final int? weatherCode;
  final int? precipProbability;
  final double? windSpeed;

  HourlyForecast({
    required this.time,
    required this.temp,
    required this.weather,
    this.weatherCode,
    this.precipProbability,
    this.windSpeed,
  });
}

/// 每日预报
class DailyForecast {
  final DateTime date;
  final double minTemp;
  final double maxTemp;
  final String weather;
  final int? weatherCode;
  final int? precipProbability;
  final DateTime? sunrise;
  final DateTime? sunset;

  DailyForecast({
    required this.date,
    required this.minTemp,
    required this.maxTemp,
    required this.weather,
    this.weatherCode,
    this.precipProbability,
    this.sunrise,
    this.sunset,
  });
}
