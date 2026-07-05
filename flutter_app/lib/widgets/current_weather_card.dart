/// 当前天气卡片
/// 展示城市、当前温度、天气描述、详情网格（湿度/风/气压/UV/能见度/降水）

import 'package:flutter/material.dart';
import '../models/weather.dart';
import '../utils/helpers.dart';
import '../utils/wmo_weather.dart';
import 'weather_icon.dart';

class CurrentWeatherCard extends StatelessWidget {
  final CurrentWeather current;
  final String cityName;
  final String? countryCode;
  final String? source;
  final DailyForecast? today;

  const CurrentWeatherCard({
    super.key,
    required this.current,
    required this.cityName,
    this.countryCode,
    this.source,
    this.today,
  });

  @override
  Widget build(BuildContext context) {
    final weatherType = current.weatherCode != null
        ? WmoWeather.type(current.weatherCode!)
        : WmoWeather.typeFromText(current.weather);
    final isDay = WmoWeather.isDay(DateTime.now().hour);
    final (comfort, comfortColor) = getComfort(current.temp);

    final minT = today?.minTemp ?? current.temp;
    final maxT = today?.maxTemp ?? current.temp;

    return _glassCard(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // 顶部：城市 + 徽章
            Row(
              children: [
                Expanded(
                  child: Text(
                    cityName,
                    style: const TextStyle(
                      color: Color(0xFFF8FAFC),
                      fontSize: 26,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                if (countryCode != null)
                  _badge(countryCode!, const Color(0xFF38BDF8)),
                if (source != null) ...[
                  const SizedBox(width: 6),
                  _badge(source!.toUpperCase(), const Color(0xFF818CF8)),
                ],
              ],
            ),
            const SizedBox(height: 16),
            // 中部：图标 + 温度
            Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                WeatherIcon(type: weatherType, isDay: isDay, size: 88),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '${current.temp.round()}°C',
                        style: const TextStyle(
                          color: Color(0xFFF8FAFC),
                          fontSize: 72,
                          fontWeight: FontWeight.w300,
                          height: 1.0,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        current.weather,
                        style: const TextStyle(
                          color: Color(0xB3F8FAFC),
                          fontSize: 16,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            // 舒适度徽章 + 体感
            Wrap(
              spacing: 8,
              runSpacing: 6,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                _badge(comfort, comfortColor),
                Text(
                  '体感 ${current.feelsLike.round()}°',
                  style: const TextStyle(color: Color(0xB3F8FAFC), fontSize: 14),
                ),
              ],
            ),
            const SizedBox(height: 18),
            // 温度范围条
            _TemperatureRange(
              min: minT,
              max: maxT,
              current: current.temp,
            ),
            const SizedBox(height: 18),
            // 详情网格
            _DetailGrid(current: current),
          ],
        ),
      ),
    );
  }

  Widget _glassCard({required Widget child}) {
    return Container(
      decoration: BoxDecoration(
        color: const Color(0x0AFFFFFF),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: const Color(0x14FFFFFF)),
      ),
      child: child,
    );
  }

  Widget _badge(String text, Color color) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.18),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: color.withValues(alpha: 0.5)),
      ),
      child: Text(
        text,
        style: TextStyle(
          color: color,
          fontSize: 11,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

/// 温度范围条
class _TemperatureRange extends StatelessWidget {
  final double min;
  final double max;
  final double current;

  const _TemperatureRange({
    required this.min,
    required this.max,
    required this.current,
  });

  @override
  Widget build(BuildContext context) {
    final span = (max - min).abs().clamp(0.001, double.infinity);
    final curClamp = current.clamp(min, max);
    final curRatio = ((curClamp - min) / span).clamp(0.0, 1.0);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text('最低 ${min.round()}°',
                style: const TextStyle(color: Color(0x80F8FAFC), fontSize: 12)),
            Text('最高 ${max.round()}°',
                style: const TextStyle(color: Color(0x80F8FAFC), fontSize: 12)),
          ],
        ),
        const SizedBox(height: 6),
        LayoutBuilder(
          builder: (context, constraints) {
            final width = constraints.maxWidth;
            return SizedBox(
              height: 6,
              child: Stack(
                alignment: Alignment.centerLeft,
                children: [
                  Container(
                    decoration: BoxDecoration(
                      gradient: const LinearGradient(
                        colors: [Color(0xFF38BDF8), Color(0xFFFBBF24), Color(0xFFF87171)],
                      ),
                      borderRadius: BorderRadius.circular(3),
                    ),
                  ),
                  Positioned(
                    left: width * curRatio - 6,
                    child: Container(
                      width: 12,
                      height: 12,
                      decoration: BoxDecoration(
                        color: const Color(0xFFF8FAFC),
                        shape: BoxShape.circle,
                        boxShadow: [
                          BoxShadow(
                            color: const Color(0xFFF8FAFC).withValues(alpha: 0.5),
                            blurRadius: 6,
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            );
          },
        ),
      ],
    );
  }
}

/// 详情网格：6 个小卡片，2 行 3 列
class _DetailGrid extends StatelessWidget {
  final CurrentWeather current;

  const _DetailGrid({required this.current});

  @override
  Widget build(BuildContext context) {
    final (humidityLevel, _) = getHumidityLevel(current.humidity);
    final windLevel = getWindLevel(current.windSpeed);
    final windDir = degToDirection(current.windDirectionDeg);
    final (uvLevel, _) = getUVLevel(current.uv);
    // weather_api.dart 已将米转 km，此处直接展示
    final visibilityKm = current.visibility != null
        ? current.visibility!.toStringAsFixed(1)
        : '--';
    final precip = current.precipProbability?.toString() ?? '--';

    final items = <_DetailItem>[
      _DetailItem(
        Icons.water_drop,
        '湿度',
        '${current.humidity?.toString() ?? '--'}%',
        humidityLevel,
      ),
      _DetailItem(
        Icons.air,
        '风速',
        '${current.windSpeed.toStringAsFixed(1)} km/h',
        '$windLevel · ${current.windDirection.isNotEmpty ? current.windDirection : windDir}',
      ),
      _DetailItem(
        Icons.speed,
        '气压',
        current.pressure != null
            ? '${current.pressure!.round()} hPa'
            : '--',
        '大气压',
      ),
      _DetailItem(
        Icons.wb_sunny,
        'UV 指数',
        current.uv != null ? current.uv!.toStringAsFixed(1) : '--',
        uvLevel,
      ),
      _DetailItem(
        Icons.visibility,
        '能见度',
        '$visibilityKm km',
        '可视距离',
      ),
      _DetailItem(
        Icons.umbrella,
        '降水概率',
        '$precip%',
        '降雨可能',
      ),
    ];

    return GridView.builder(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      itemCount: items.length,
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 3,
        crossAxisSpacing: 8,
        mainAxisSpacing: 8,
        childAspectRatio: 0.95,
      ),
      itemBuilder: (context, i) => _DetailCard(items[i]),
    );
  }
}

class _DetailItem {
  final IconData icon;
  final String title;
  final String value;
  final String sub;
  _DetailItem(this.icon, this.title, this.value, this.sub);
}

class _DetailCard extends StatelessWidget {
  final _DetailItem item;
  const _DetailCard(this.item);

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: const Color(0x08FFFFFF),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0x10FFFFFF)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Icon(item.icon, size: 18, color: const Color(0xFF38BDF8)),
          const SizedBox(height: 6),
          Text(
            item.value,
            style: const TextStyle(
              color: Color(0xFFF8FAFC),
              fontSize: 15,
              fontWeight: FontWeight.w600,
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          const SizedBox(height: 2),
          Text(
            item.title,
            style: const TextStyle(color: Color(0x80F8FAFC), fontSize: 11),
          ),
          const SizedBox(height: 2),
          Text(
            item.sub,
            style: const TextStyle(color: Color(0x66F8FAFC), fontSize: 10),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ],
      ),
    );
  }
}
