/// 城市地理编码服务
///
/// 提供城市名称 → 经纬度的查询能力。
/// 数据源：Open-Meteo Geocoding API
/// 文档：https://open-meteo.com/en/docs/geocoding-api
library;

import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/location.dart';

/// 地理编码服务
class GeocodingService {
  /// Open-Meteo Geocoding 端点
  static const _geocodingUrl = 'https://geocoding-api.open-meteo.com/v1/search';

  /// 请求超时时间
  static const _timeout = Duration(seconds: 8);

  /// 搜索城市，返回首个匹配结果
  ///
  /// 失败或无匹配时返回 null。
  Future<LocationInfo?> search(String query) async {
    if (query.trim().isEmpty) return null;
    try {
      final uri = Uri.parse(_geocodingUrl).replace(queryParameters: <String, String>{
        'name': query.trim(),
        'count': '1',
        'language': 'zh',
        'format': 'json',
      });

      final response = await http.get(uri).timeout(_timeout);
      if (response.statusCode != 200) return null;

      final json = jsonDecode(response.body) as Map<String, dynamic>;
      final results = json['results'] as List?;
      if (results == null || results.isEmpty) return null;

      final item = results.first as Map<String, dynamic>;
      final lat = (item['latitude'] as num?)?.toDouble();
      final lon = (item['longitude'] as num?)?.toDouble();
      if (lat == null || lon == null) return null;

      return LocationInfo(
        city: (item['name'] as String?) ?? query,
        province: item['admin1'] as String?,
        country: item['country'] as String?,
        countryCode: item['country_code'] as String?,
        lat: lat,
        lon: lon,
        timezone: item['timezone'] as String?,
      );
    } catch (_) {
      return null;
    }
  }
}
