/// 辅助函数：AQI/UV/舒适度/风力 等分级

import 'package:flutter/material.dart';
import 'wmo_weather.dart';

/// AQI 分级
class AQIInfo {
  final String level;
  final String description;
  final Color color;
  AQIInfo(this.level, this.description, this.color);
}

AQIInfo getAQIInfo(int? aqi) {
  if (aqi == null) return AQIInfo('--', '暂无数据', Colors.grey);
  if (aqi <= 50) return AQIInfo('优', '空气质量令人满意', const Color(0xFF34D399));
  if (aqi <= 100) return AQIInfo('良', '空气质量可接受', const Color(0xFFFBBF24));
  if (aqi <= 150) return AQIInfo('轻度污染', '敏感人群应减少户外运动', const Color(0xFFFB923C));
  if (aqi <= 200) return AQIInfo('中度污染', '应减少户外运动', const Color(0xFFF87171));
  if (aqi <= 300) return AQIInfo('重度污染', '避免户外运动', const Color(0xFFC084FC));
  return AQIInfo('严重污染', '应留在室内', const Color(0xFFA78BFA));
}

/// 舒适度
(String, Color) getComfort(double temp) {
  if (temp < 0) return ('极冷', const Color(0xFF60A5FA));
  if (temp < 10) return ('寒冷', const Color(0xFF60A5FA));
  if (temp < 18) return ('凉爽', const Color(0xFF34D399));
  if (temp < 25) return ('舒适', const Color(0xFF34D399));
  if (temp < 30) return ('温暖', const Color(0xFFFBBF24));
  if (temp < 35) return ('炎热', const Color(0xFFFB923C));
  return ('酷热', const Color(0xFFF87171));
}

/// UV 分级
(String, Color) getUVLevel(double? uv) {
  if (uv == null) return ('--', Colors.grey);
  if (uv < 3) return ('低', const Color(0xFF34D399));
  if (uv < 6) return ('中等', const Color(0xFFFBBF24));
  if (uv < 8) return ('高', const Color(0xFFFB923C));
  if (uv < 11) return ('极高', const Color(0xFFF87171));
  return ('危险', const Color(0xFFC084FC));
}

/// 湿度分级
(String, Color) getHumidityLevel(int? humidity) {
  if (humidity == null) return ('--', Colors.grey);
  if (humidity < 30) return ('干燥', const Color(0xFFFBBF24));
  if (humidity < 60) return ('舒适', const Color(0xFF34D399));
  if (humidity < 80) return ('潮湿', const Color(0xFF60A5FA));
  return ('闷热', const Color(0xFFF87171));
}

/// 风力等级
String getWindLevel(double speedKmh) {
  if (speedKmh < 1) return '无风';
  if (speedKmh < 12) return '微风';
  if (speedKmh < 20) return '和风';
  if (speedKmh < 29) return '强风';
  if (speedKmh < 39) return '疾风';
  return '大风';
}

/// 风向角度 → 方向
String degToDirection(int? deg) {
  if (deg == null) return '--';
  const dirs = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  final idx = ((deg + 22.5) / 45).floor() % 8;
  return '${dirs[idx]}风';
}

/// 生活建议
class LifeTip {
  final String icon;
  final String title;
  final String value;
  final String description;
  LifeTip(this.icon, this.title, this.value, this.description);
}

/// 根据当前天气生成生活建议
List<LifeTip> generateLifeTips(CurrentWeatherProxy current, List<DailyForecastProxy> daily) {
  final tips = <LifeTip>[];
  final temp = current.temp;

  // 穿衣指数
  String clothing, clothingDesc;
  if (temp < 0) { clothing = '严寒'; clothingDesc = '需穿羽绒服、棉衣'; }
  else if (temp < 10) { clothing = '寒冷'; clothingDesc = '建议穿冬装'; }
  else if (temp < 18) { clothing = '凉爽'; clothingDesc = '建议穿外套'; }
  else if (temp < 25) { clothing = '舒适'; clothingDesc = '穿薄单衣即可'; }
  else if (temp < 30) { clothing = '温暖'; clothingDesc = '穿短袖短裤'; }
  else { clothing = '炎热'; clothingDesc = '穿轻薄透气衣物'; }
  tips.add(LifeTip('👔', '穿衣指数', clothing, clothingDesc));

  // 紫外线
  final (uvLevel, _) = getUVLevel(current.uv);
  String uvDesc;
  if (current.uv == null) uvDesc = '暂无数据';
  else if (current.uv! < 3) uvDesc = '无需特别防护';
  else if (current.uv! < 6) uvDesc = '建议涂防晒霜';
  else if (current.uv! < 8) uvDesc = '需涂防晒霜';
  else if (current.uv! < 11) uvDesc = '尽量避免外出';
  else uvDesc = '必须避免外出';
  tips.add(LifeTip('☀️', '紫外线', uvLevel, uvDesc));

  // 运动指数
  final weatherType = current.weatherCode != null
      ? WmoWeather.type(current.weatherCode!)
      : WeatherType.sunny;
  final isBadWeather = [WeatherType.rain, WeatherType.storm, WeatherType.snow, WeatherType.haze].contains(weatherType);
  tips.add(LifeTip('🏃', '运动指数', isBadWeather ? '不宜' : '宜', isBadWeather ? '天气不佳，建议室内运动' : '适合户外运动'));

  // 洗车指数
  final precip = current.precipProbability ?? 0;
  String washCar, washCarDesc;
  if (precip > 60) { washCar = '不宜'; washCarDesc = '有降水概率，不建议洗车'; }
  else if (precip > 30) { washCar = '谨慎'; washCarDesc = '有一定降水概率'; }
  else { washCar = '适宜'; washCarDesc = '天气晴好，适合洗车'; }
  tips.add(LifeTip('🚗', '洗车指数', washCar, washCarDesc));

  // 感冒指数
  String cold, coldDesc;
  if (temp < 5 || temp > 33) { cold = '易发'; coldDesc = '温差较大，注意保暖'; }
  else if (temp < 12 || temp > 28) { cold = '少发'; coldDesc = '温度适宜感冒'; }
  else { cold = '少发'; coldDesc = '不易感冒'; }
  tips.add(LifeTip('🤧', '感冒指数', cold, coldDesc));

  // 过敏指数
  String allergy;
  if (weatherType == WeatherType.fog || weatherType == WeatherType.haze) { allergy = '高'; }
  else if (current.aqi != null && current.aqi! > 100) { allergy = '高'; }
  else { allergy = '低'; }
  tips.add(LifeTip('🌸', '过敏指数', allergy, allergy == '高' ? '空气质量不佳，敏感人群注意' : '空气质量良好'));

  return tips;
}

/// 代理接口（避免循环依赖，供 generateLifeTips 使用）
class CurrentWeatherProxy {
  final double temp;
  final double? uv;
  final int? weatherCode;
  final int? precipProbability;
  final int? aqi;
  CurrentWeatherProxy({required this.temp, this.uv, this.weatherCode, this.precipProbability, this.aqi});
}

class DailyForecastProxy {
  final double minTemp;
  final double maxTemp;
  DailyForecastProxy({required this.minTemp, required this.maxTemp});
}
