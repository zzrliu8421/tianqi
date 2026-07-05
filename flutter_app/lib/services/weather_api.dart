/// Open-Meteo 天气预报 API 客户端
///
/// 提供获取完整天气数据（含空气质量 AQI）的能力，并将原始 JSON 归一化为
/// 应用内部的 WeatherData 模型。
///
/// 文档: https://open-meteo.com/en/docs
library;

import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/location.dart';
import '../models/weather.dart';
import '../utils/helpers.dart';
import '../utils/wmo_weather.dart';

/// Open-Meteo 天气预报 API 客户端
class WeatherApi {
  static const _forecastUrl = 'https://api.open-meteo.com/v1/forecast';
  static const _aqiUrl = 'https://air-quality-api.open-meteo.com/v1/air-quality';

  /// 请求超时时间
  static const _timeout = Duration(seconds: 10);

  /// 获取完整天气数据（天气 + AQI），归一化为 WeatherData 模型
  ///
  /// 抛出 [Exception] 时附带友好的中文错误消息。
  Future<WeatherData> getWeather(double lat, double lon) async {
    try {
      // 并发拉取天气与空气质量数据
      final results = await Future.wait<dynamic>([
        _fetchForecast(lat, lon),
        _fetchAqi(lat, lon),
      ]);

      final forecastJson = results[0] as Map<String, dynamic>;
      final aqiJson = results[1] as Map<String, dynamic>?;

      return _normalize(lat, lon, forecastJson, aqiJson);
    } on Exception {
      rethrow;
    } catch (e) {
      throw Exception('获取天气数据失败：$e');
    }
  }

  /// 请求天气预报接口
  Future<Map<String, dynamic>> _fetchForecast(double lat, double lon) async {
    final uri = Uri.parse(_forecastUrl).replace(queryParameters: <String, String>{
      'latitude': lat.toString(),
      'longitude': lon.toString(),
      'current': 'temperature_2m,relative_humidity_2m,apparent_temperature,'
          'weather_code,pressure_msl,wind_speed_10m,wind_direction_10m,visibility',
      'hourly': 'temperature_2m,weather_code,precipitation_probability,wind_speed_10m',
      'daily': 'weather_code,temperature_2m_max,temperature_2m_min,'
          'precipitation_probability_max,sunrise,sunset,uv_index_max',
      'timezone': 'auto',
      'forecast_days': '7',
    });

    http.Response response;
    try {
      response = await http.get(uri).timeout(_timeout);
    } catch (e) {
      throw Exception('网络请求失败，请检查网络连接：$e');
    }
    if (response.statusCode != 200) {
      throw Exception('天气服务暂时不可用（HTTP ${response.statusCode}）');
    }
    return jsonDecode(response.body) as Map<String, dynamic>;
  }

  /// 请求空气质量接口（失败时返回 null，不影响主流程）
  Future<Map<String, dynamic>?> _fetchAqi(double lat, double lon) async {
    try {
      final uri = Uri.parse(_aqiUrl).replace(queryParameters: <String, String>{
        'latitude': lat.toString(),
        'longitude': lon.toString(),
        'current': 'us_aqi,pm10,pm2_5,nitrogen_dioxide,ozone',
      });

      final response = await http.get(uri).timeout(_timeout);
      if (response.statusCode != 200) return null;
      return jsonDecode(response.body) as Map<String, dynamic>;
    } catch (_) {
      // AQI 属附加数据，失败时静默降级
      return null;
    }
  }

  /// 将原始 JSON 归一化为 WeatherData
  WeatherData _normalize(
    double lat,
    double lon,
    Map<String, dynamic> json,
    Map<String, dynamic>? aqiJson,
  ) {
    final currentJson = json['current'] as Map<String, dynamic>? ?? <String, dynamic>{};
    final hourlyJson = json['hourly'] as Map<String, dynamic>? ?? <String, dynamic>{};
    final dailyJson = json['daily'] as Map<String, dynamic>? ?? <String, dynamic>{};
    final timezone = json['timezone'] as String? ?? '';

    // ===== 当前天气 =====
    final weatherCode = currentJson['weather_code'] as int?;
    final windDeg = currentJson['wind_direction_10m'] as int?;
    final visibilityM = currentJson['visibility'] as num?;
    final aqiCurrent = aqiJson?['current'] as Map<String, dynamic>?;

    // 解析 daily，并单独取今日 uv_index_max 填入 current.uv
    final daily = _parseDaily(dailyJson);
    final uvList = (dailyJson['uv_index_max'] as List?) ?? const [];
    final uvToday = uvList.isNotEmpty ? _toDouble(uvList[0]) : null;

    final current = CurrentWeather(
      temp: _toDouble(currentJson['temperature_2m']) ?? 0,
      feelsLike: _toDouble(currentJson['apparent_temperature']) ?? 0,
      weather: weatherCode != null ? WmoWeather.text(weatherCode) : '未知',
      weatherCode: weatherCode,
      humidity: currentJson['relative_humidity_2m'] as int?,
      pressure: _toDouble(currentJson['pressure_msl']),
      windSpeed: _toDouble(currentJson['wind_speed_10m']) ?? 0,
      windDirection: degToDirection(windDeg),
      windDirectionDeg: windDeg,
      visibility: visibilityM != null ? visibilityM.toDouble() / 1000 : null, // m → km
      uv: uvToday,
      precipProbability: null,
      aqi: aqiCurrent?['us_aqi'] as int?,
      aqiPm25: _toDouble(aqiCurrent?['pm2_5']),
      aqiPm10: _toDouble(aqiCurrent?['pm10']),
      aqiNo2: _toDouble(aqiCurrent?['nitrogen_dioxide']),
      aqiO3: _toDouble(aqiCurrent?['ozone']),
    );

    // ===== 逐时预报：过滤过去时间，最多保留 24 条 =====
    final hourly = _parseHourly(hourlyJson);

    return WeatherData(
      location: LocationInfo(
        city: '当前位置',
        lat: lat,
        lon: lon,
        timezone: timezone,
      ),
      current: current,
      hourly: hourly,
      daily: daily,
      source: 'open-meteo',
      updatedAt: DateTime.now(),
    );
  }

  /// 解析逐时预报，过滤过去时间，最多保留 24 条
  List<HourlyForecast> _parseHourly(Map<String, dynamic> json) {
    final times = (json['time'] as List?)?.cast<String>() ?? const <String>[];
    final temps = json['temperature_2m'] as List? ?? const [];
    final codes = json['weather_code'] as List? ?? const [];
    final precips = json['precipitation_probability'] as List? ?? const [];
    final winds = json['wind_speed_10m'] as List? ?? const [];

    final now = DateTime.now();
    final result = <HourlyForecast>[];
    for (var i = 0; i < times.length; i++) {
      final time = DateTime.tryParse(times[i]);
      if (time == null || time.isBefore(now)) continue;
      final code = codes[i] as int?;
      result.add(HourlyForecast(
        time: time,
        temp: _toDouble(temps[i]) ?? 0,
        weather: code != null ? WmoWeather.text(code) : '未知',
        weatherCode: code,
        precipProbability: precips[i] as int?,
        windSpeed: _toDouble(winds[i]),
      ));
      if (result.length >= 24) break;
    }
    return result;
  }

  /// 解析每日预报
  List<DailyForecast> _parseDaily(Map<String, dynamic> json) {
    final times = (json['time'] as List?)?.cast<String>() ?? const <String>[];
    final codes = json['weather_code'] as List? ?? const [];
    final maxes = json['temperature_2m_max'] as List? ?? const [];
    final mins = json['temperature_2m_min'] as List? ?? const [];
    final precips = json['precipitation_probability_max'] as List? ?? const [];
    final sunrises = json['sunrise'] as List? ?? const [];
    final sunsets = json['sunset'] as List? ?? const [];

    final result = <DailyForecast>[];
    for (var i = 0; i < times.length; i++) {
      final date = DateTime.tryParse(times[i]);
      if (date == null) continue;
      final code = codes[i] as int?;
      result.add(DailyForecast(
        date: date,
        minTemp: _toDouble(mins[i]) ?? 0,
        maxTemp: _toDouble(maxes[i]) ?? 0,
        weather: code != null ? WmoWeather.text(code) : '未知',
        weatherCode: code,
        precipProbability: precips[i] as int?,
        sunrise: i < sunrises.length ? DateTime.tryParse(sunrises[i] as String) : null,
        sunset: i < sunsets.length ? DateTime.tryParse(sunsets[i] as String) : null,
      ));
    }
    return result;
  }

  /// 安全转换 num → double
  double? _toDouble(Object? value) {
    if (value == null) return null;
    if (value is num) return value.toDouble();
    return null;
  }
}
