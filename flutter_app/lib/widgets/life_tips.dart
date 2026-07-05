/// 生活建议组件
/// 2 行 3 列网格，6 张卡片

import 'package:flutter/material.dart';
import '../models/weather.dart';
import '../utils/helpers.dart';

class LifeTips extends StatelessWidget {
  final CurrentWeather current;
  final List<DailyForecast> daily;

  const LifeTips({
    super.key,
    required this.current,
    required this.daily,
  });

  @override
  Widget build(BuildContext context) {
    final proxy = CurrentWeatherProxy(
      temp: current.temp,
      uv: current.uv,
      weatherCode: current.weatherCode,
      precipProbability: current.precipProbability,
      aqi: current.aqi,
    );
    final dailyProxy = daily
        .map((d) => DailyForecastProxy(minTemp: d.minTemp, maxTemp: d.maxTemp))
        .toList();
    final tips = generateLifeTips(proxy, dailyProxy);

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
              const Icon(Icons.tips_and_updates, size: 18, color: Color(0xFFFBBF24)),
              const SizedBox(width: 6),
              const Text(
                '生活建议',
                style: TextStyle(
                  color: Color(0xFFF8FAFC),
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          GridView.builder(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            itemCount: tips.length,
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 3,
              crossAxisSpacing: 8,
              mainAxisSpacing: 8,
              childAspectRatio: 0.85,
            ),
            itemBuilder: (context, i) => _TipCard(tip: tips[i]),
          ),
        ],
      ),
    );
  }
}

class _TipCard extends StatelessWidget {
  final LifeTip tip;
  const _TipCard({required this.tip});

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
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Text(
            tip.icon,
            style: const TextStyle(fontSize: 22),
          ),
          const SizedBox(height: 4),
          Text(
            tip.title,
            style: const TextStyle(
              color: Color(0xB3F8FAFC),
              fontSize: 11,
            ),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 2),
          Text(
            tip.value,
            style: const TextStyle(
              color: Color(0xFFF8FAFC),
              fontSize: 13,
              fontWeight: FontWeight.w700,
            ),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 2),
          Flexible(
            child: Text(
              tip.description,
              style: const TextStyle(color: Color(0x66F8FAFC), fontSize: 9),
              textAlign: TextAlign.center,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }
}
