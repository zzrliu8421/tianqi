/// 位置信息模型
class LocationInfo {
  final String city;
  final String? province;
  final String? country;
  final String? countryCode;
  final double lat;
  final double lon;
  final String? timezone;

  LocationInfo({
    required this.city,
    this.province,
    this.country,
    this.countryCode,
    required this.lat,
    required this.lon,
    this.timezone,
  });
}
