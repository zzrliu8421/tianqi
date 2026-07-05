/// IP 定位服务
///
/// 提供公网 IP 查询与基于 IP 的位置定位能力。
///
/// 数据源降级方案：
/// 1. Cloudflare trace - 文本响应，解析 `ip=` 行
/// 2. ipify - JSON `{ip: "..."}`
/// 3. GeoDB - JSON 含经纬度与城市信息，用于 [locateByIp]
library;

import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/location.dart';

/// IP 定位服务
class IpLocationService {
  /// Cloudflare trace 端点
  static const _cloudflareUrl = 'https://www.cloudflare.com/cdn-cgi/trace';

  /// ipify JSON 端点
  static const _ipifyUrl = 'https://api4.ipify.org?format=json';

  /// GeoDB 定位端点
  static const _geoDbUrl = 'https://geolocation-db.com/json/';

  /// GeoDB 请求超时时间
  static const _geoDbTimeout = Duration(seconds: 5);

  /// 公网 IP 获取请求超时时间
  static const _ipTimeout = Duration(seconds: 5);

  /// 获取公网 IP（Cloudflare → ipify 降级）
  ///
  /// 失败时返回 null。
  Future<String?> getPublicIp() async {
    // 1. Cloudflare trace
    var ip = await _fetchFromCloudflare();
    if (ip != null && ip.isNotEmpty) return ip;

    // 2. ipify
    ip = await _fetchFromIpify();
    if (ip != null && ip.isNotEmpty) return ip;

    return null;
  }

  /// 通过 IP 定位（使用 GeoDB），返回 LocationInfo
  ///
  /// 失败时返回 null。
  Future<LocationInfo?> locateByIp() async {
    try {
      final response = await http.get(Uri.parse(_geoDbUrl)).timeout(_geoDbTimeout);
      if (response.statusCode != 200) return null;

      final json = jsonDecode(response.body) as Map<String, dynamic>;
      final lat = _toDouble(json['latitude']);
      final lon = _toDouble(json['longitude']);
      if (lat == null || lon == null) return null;

      return LocationInfo(
        city: (json['city'] as String?) ?? '',
        province: json['state'] as String?,
        country: json['country_name'] as String?,
        countryCode: json['country_code'] as String?,
        lat: lat,
        lon: lon,
      );
    } catch (_) {
      return null;
    }
  }

  /// 从 Cloudflare trace 解析 IP
  Future<String?> _fetchFromCloudflare() async {
    try {
      final response = await http.get(Uri.parse(_cloudflareUrl)).timeout(_ipTimeout);
      if (response.statusCode != 200) return null;
      return _parseCloudflareTrace(response.body);
    } catch (_) {
      return null;
    }
  }

  /// 从 ipify 获取 IP
  Future<String?> _fetchFromIpify() async {
    try {
      final response = await http.get(Uri.parse(_ipifyUrl)).timeout(_ipTimeout);
      if (response.statusCode != 200) return null;
      final json = jsonDecode(response.body) as Map<String, dynamic>;
      final ip = json['ip'] as String?;
      return (ip != null && ip.isNotEmpty) ? ip : null;
    } catch (_) {
      return null;
    }
  }

  /// 解析 Cloudflare trace 文本响应中的 `ip=` 行
  String? _parseCloudflareTrace(String body) {
    for (final line in body.split('\n')) {
      if (line.startsWith('ip=')) {
        final ip = line.substring(3).trim();
        if (ip.isNotEmpty) return ip;
      }
    }
    return null;
  }

  /// 安全转换 num → double
  double? _toDouble(Object? value) {
    if (value == null) return null;
    if (value is num) return value.toDouble();
    return null;
  }
}
