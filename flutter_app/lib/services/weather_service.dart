/// 整合天气服务
///
/// 整合 [WeatherApi]、[GeocodingService]、[IpLocationService] 三个底层服务，
/// 对外提供带内存缓存的天气与城市查询入口。
///
/// - 天气缓存：5 分钟
/// - 城市缓存：30 分钟
library;

import '../models/location.dart';
import '../models/weather.dart';
import 'geocoding_service.dart';
import 'ip_location_service.dart';
import 'weather_api.dart';

/// 整合天气服务
class WeatherService {
  WeatherService();

  final _api = WeatherApi();
  final _geo = GeocodingService();
  final _ip = IpLocationService();

  /// 天气缓存: key = "lat,lon" → (WeatherData, 缓存时间)
  final Map<String, (WeatherData, DateTime)> _weatherCache = <String, (WeatherData, DateTime)>{};

  /// 城市缓存: query → (LocationInfo, 缓存时间)
  final Map<String, (LocationInfo, DateTime)> _cityCache = <String, (LocationInfo, DateTime)>{};

  /// 天气缓存有效期
  static const _weatherCacheTtl = Duration(minutes: 5);

  /// 城市缓存有效期
  static const _cityCacheTtl = Duration(minutes: 30);

  /// 搜索城市 → 获取天气
  ///
  /// 城市不存在或请求失败时返回 null。
  Future<WeatherData?> getWeatherByCity(String city) async {
    try {
      final loc = await searchCity(city);
      if (loc == null) return null;
      final data = await getWeatherByLocation(loc.lat, loc.lon);
      if (data == null) return null;
      // 用真实城市信息替换占位 LocationInfo
      return WeatherData(
        location: loc,
        current: data.current,
        hourly: data.hourly,
        daily: data.daily,
        source: data.source,
        updatedAt: data.updatedAt,
      );
    } catch (_) {
      return null;
    }
  }

  /// 直接用坐标获取天气（带 5 分钟缓存）
  Future<WeatherData?> getWeatherByLocation(double lat, double lon) async {
    final key = '$lat,$lon';
    final cached = _weatherCache[key];
    if (cached != null && DateTime.now().difference(cached.$2) < _weatherCacheTtl) {
      return cached.$1;
    }
    try {
      final data = await _api.getWeather(lat, lon);
      _weatherCache[key] = (data, DateTime.now());
      return data;
    } catch (_) {
      return null;
    }
  }

  /// IP 定位 → 获取天气
  Future<WeatherData?> getWeatherByIp() async {
    try {
      final loc = await _ip.locateByIp();
      if (loc == null) return null;
      final data = await getWeatherByLocation(loc.lat, loc.lon);
      if (data == null) return null;
      // 用 IP 反查到的城市信息替换占位 LocationInfo
      return WeatherData(
        location: loc,
        current: data.current,
        hourly: data.hourly,
        daily: data.daily,
        source: data.source,
        updatedAt: data.updatedAt,
      );
    } catch (_) {
      return null;
    }
  }

  /// 城市搜索（带 30 分钟缓存）
  Future<LocationInfo?> searchCity(String query) async {
    final cached = _cityCache[query];
    if (cached != null && DateTime.now().difference(cached.$2) < _cityCacheTtl) {
      return cached.$1;
    }
    try {
      final loc = await _geo.search(query);
      if (loc != null) {
        _cityCache[query] = (loc, DateTime.now());
      }
      return loc;
    } catch (_) {
      return null;
    }
  }
}
