/// 24 小时预报横向列表

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../models/weather.dart';
import '../utils/wmo_weather.dart';
import 'weather_icon.dart';

class HourlyForecast extends StatelessWidget {
  final List<HourlyForecast> hourly;
  final CurrentWeather? current;

  const HourlyForecast({
    super.key,
    required this.hourly,
    this.current,
  });

  @override
  Widget build(BuildContext context) {
    final items = <HourlyForecast>[...hourly].take(24).toList();

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
              const Icon(Icons.timeline, size: 18, color: Color(0xFF38BDF8)),
              const SizedBox(width: 6),
              const Text(
                '24 小时预报',
                style: TextStyle(
                  color: Color(0xFFF8FAFC),
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const Spacer(),
              Text(
                '${items.length} 项',
                style: const TextStyle(color: Color(0x66F8FAFC), fontSize: 12),
              ),
            ],
          ),
          const SizedBox(height: 12),
          items.isEmpty
              ? const Padding(
                  padding: EdgeInsets.symmetric(vertical: 20),
                  child: Center(
                    child: Text('暂无逐时数据',
                        style: TextStyle(color: Color(0x80F8FAFC))),
                  ),
                )
              : SizedBox(
                  height: 120,
                  child: ListView.separated(
                    scrollDirection: Axis.horizontal,
                    itemCount: items.length,
                    separatorBuilder: (_, __) => const SizedBox(width: 10),
                    itemBuilder: (context, i) {
                      final h = items[i];
                      final isNow = i == 0;
                      final now = DateTime.now();
                      final isDay = WmoWeather.isDay(h.time.hour);
                      final weatherType = h.weatherCode != null
                          ? WmoWeather.type(h.weatherCode!)
                          : WmoWeather.typeFromText(h.weather);
                      final timeLabel = isNow
                          ? '现在'
                          : DateFormat('HH:mm').format(h.time);
                      final isHighlight = isNow ||
                          (h.time.day == now.day &&
                              h.time.hour == now.hour);
                      return Container(
                        width: 68,
                        padding: const EdgeInsets.symmetric(vertical: 10),
                        decoration: BoxDecoration(
                          color: isHighlight
                              ? const Color(0xFF38BDF8).withOpacity(0.18)
                              : const Color(0x08FFFFFF),
                          borderRadius: BorderRadius.circular(14),
                          border: Border.all(
                            color: isHighlight
                                ? const Color(0xFF38BDF8).withOpacity(0.5)
                                : const Color(0x10FFFFFF),
                          ),
                        ),
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Text(
                              timeLabel,
                              style: const TextStyle(
                                color: Color(0xB3F8FAFC),
                                fontSize: 12,
                              ),
                            ),
                            WeatherIcon(
                              type: weatherType,
                              isDay: isDay,
                              size: 28,
                            ),
                            Text(
                              '${h.temp.round()}°',
                              style: const TextStyle(
                                color: Color(0xFFF8FAFC),
                                fontSize: 16,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                            Row(
                              mainAxisAlignment: MainAxisAlignment.center,
                              children: [
                                Icon(
                                  Icons.water_drop,
                                  size: 10,
                                  color: const Color(0xFF38BDF8).withOpacity(0.8),
                                ),
                                const SizedBox(width: 2),
                                Text(
                                  '${h.precipProbability ?? 0}%',
                                  style: const TextStyle(
                                    color: Color(0x80F8FAFC),
                                    fontSize: 10,
                                  ),
                                ),
                              ],
                            ),
                          ],
                        ),
                      );
                    },
                  ),
                ),
        ],
      ),
    );
  }
}
