/// 未来 7 天预报列表

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../models/weather.dart';
import '../utils/wmo_weather.dart';
import 'weather_icon.dart';

class DailyForecastList extends StatelessWidget {
  final List<DailyForecast> daily;

  const DailyForecastList({super.key, required this.daily});

  @override
  Widget build(BuildContext context) {
    final items = <DailyForecast>[...daily].take(7).toList();
    if (items.isEmpty) {
      return const SizedBox.shrink();
    }

    final minTempAll = items
        .map((d) => d.minTemp)
        .reduce((a, b) => a < b ? a : b);
    final maxTempAll = items
        .map((d) => d.maxTemp)
        .reduce((a, b) => a > b ? a : b);
    final span = (maxTempAll - minTempAll).abs().clamp(0.001, double.infinity);

    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      decoration: BoxDecoration(
        color: const Color(0x0AFFFFFF),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: const Color(0x14FFFFFF)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.calendar_month, size: 18, color: Color(0xFF818CF8)),
              const SizedBox(width: 6),
              const Text(
                '未来 7 天',
                style: TextStyle(
                  color: Color(0xFFF8FAFC),
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const Spacer(),
              Text(
                '${items.length} 天',
                style: const TextStyle(color: Color(0x66F8FAFC), fontSize: 12),
              ),
            ],
          ),
          const SizedBox(height: 8),
          ListView.separated(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            itemCount: items.length,
            separatorBuilder: (_, __) => const Divider(
              color: Color(0x10FFFFFF),
              height: 1,
            ),
            itemBuilder: (context, i) {
              final d = items[i];
              final isToday = _isSameDay(d.date, DateTime.now());

              final weekdayLabel = isToday
                  ? '今天'
                  : DateFormat('EE', 'zh_CN').format(d.date);
              final dateLabel = DateFormat('M/d', 'zh_CN').format(d.date);

              final weatherType = d.weatherCode != null
                  ? WmoWeather.type(d.weatherCode!)
                  : WmoWeather.typeFromText(d.weather);
              final isDay = true;

              // 归一化范围条
              final leftRatio = ((d.minTemp - minTempAll) / span).clamp(0.0, 1.0);
              final rightRatio = ((d.maxTemp - minTempAll) / span).clamp(0.0, 1.0);

              return Padding(
                padding: const EdgeInsets.symmetric(vertical: 10),
                child: Row(
                  children: [
                    SizedBox(
                      width: 64,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            weekdayLabel,
                            style: const TextStyle(
                              color: Color(0xFFF8FAFC),
                              fontSize: 14,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          Text(
                            dateLabel,
                            style: const TextStyle(
                              color: Color(0x80F8FAFC),
                              fontSize: 11,
                            ),
                          ),
                        ],
                      ),
                    ),
                    SizedBox(
                      width: 36,
                      child: WeatherIcon(type: weatherType, isDay: isDay, size: 26),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            d.weather,
                            style: const TextStyle(
                              color: Color(0xB3F8FAFC),
                              fontSize: 13,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          Row(
                            children: [
                              Icon(
                                Icons.water_drop,
                                size: 11,
                                color: const Color(0xFF38BDF8).withOpacity(0.8),
                              ),
                              const SizedBox(width: 2),
                              Text(
                                '${d.precipProbability ?? 0}%',
                                style: const TextStyle(
                                  color: Color(0x80F8FAFC),
                                  fontSize: 11,
                                ),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 8),
                    // 温度范围条
                    Expanded(
                      child: LayoutBuilder(
                        builder: (context, c) {
                          final width = c.maxWidth;
                          return Column(
                            crossAxisAlignment: CrossAxisAlignment.end,
                            children: [
                              Row(
                                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                children: [
                                  Text(
                                    '${d.minTemp.round()}°',
                                    style: const TextStyle(
                                      color: Color(0xFF38BDF8),
                                      fontSize: 13,
                                    ),
                                  ),
                                  Text(
                                    '${d.maxTemp.round()}°',
                                    style: const TextStyle(
                                      color: Color(0xFFF87171),
                                      fontSize: 13,
                                      fontWeight: FontWeight.w600,
                                    ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 4),
                              SizedBox(
                                height: 4,
                                child: Stack(
                                  children: [
                                    Container(
                                      decoration: BoxDecoration(
                                        color: const Color(0x10FFFFFF),
                                        borderRadius: BorderRadius.circular(2),
                                      ),
                                    ),
                                    Positioned(
                                      left: width * leftRatio,
                                      width: (width * (rightRatio - leftRatio))
                                          .clamp(2.0, double.infinity),
                                      child: Container(
                                        height: 4,
                                        decoration: BoxDecoration(
                                          gradient: const LinearGradient(
                                            colors: [
                                              Color(0xFF38BDF8),
                                              Color(0xFFFBBF24),
                                              Color(0xFFF87171),
                                            ],
                                          ),
                                          borderRadius: BorderRadius.circular(2),
                                        ),
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ],
                          );
                        },
                      ),
                    ),
                  ],
                ),
              );
            },
          ),
        ],
      ),
    );
  }

  bool _isSameDay(DateTime a, DateTime b) =>
      a.year == b.year && a.month == b.month && a.day == b.day;
}
