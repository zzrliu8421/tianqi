/// SkyWeather · 云际天气 - 应用入口
///
/// 包含：
/// - WeatherPage：首页 StatefulWidget，状态管理 + 加载/错误/空态
/// - 布局：WeatherBackground → SafeArea → ListView → 各组件

import 'package:flutter/material.dart';
import 'package:intl/date_symbol_data_local.dart';

import 'models/weather.dart';
import 'utils/theme.dart';
import 'utils/wmo_weather.dart';
import 'services/weather_service.dart';
import 'widgets/weather_background.dart';
import 'widgets/search_bar_widget.dart';
import 'widgets/current_weather_card.dart';
import 'widgets/aqi_card.dart';
import 'widgets/sun_arc.dart';
import 'widgets/hourly_forecast.dart' as hourly_w;
import 'widgets/daily_forecast.dart' as daily_w;
import 'widgets/life_tips.dart';

/// 应用入口
void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // 初始化 intl 中文日期格式化数据（DateFormat('EE', 'zh_CN') 依赖）
  try {
    await initializeDateFormatting('zh_CN', null);
  } catch (_) {
    // 初始化失败时回退到默认 locale，不阻塞启动
  }
  runApp(const SkyWeatherApp());
}

class SkyWeatherApp extends StatelessWidget {
  const SkyWeatherApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'SkyWeather · 云际天气',
      debugShowCheckedModeBanner: false,
      theme: appTheme(),
      home: WeatherPage(weatherService: WeatherService()),
    );
  }
}

/// 主页：天气详情
class WeatherPage extends StatefulWidget {
  final WeatherService weatherService;

  const WeatherPage({super.key, required this.weatherService});

  @override
  State<WeatherPage> createState() => _WeatherPageState();
}

enum _LoadState { loading, loaded, error, empty }

class _WeatherPageState extends State<WeatherPage> {
  _LoadState _state = _LoadState.loading;
  WeatherData? _data;
  String? _errorMsg;
  String? _currentCity; // 当前查询的城市（null 表示自动定位）

  @override
  void initState() {
    super.initState();
    _loadByIp();
  }

  Future<void> _loadByIp() async {
    setState(() {
      _state = _LoadState.loading;
      _currentCity = null;
    });
    try {
      final data = await widget.weatherService.getWeatherByIp();
      setState(() {
        _data = data;
        _state = _resolveState(data);
      });
    } catch (e) {
      setState(() {
        _errorMsg = e.toString();
        _state = _LoadState.error;
      });
    }
  }

  Future<void> _loadByCity(String city) async {
    setState(() {
      _state = _LoadState.loading;
      _currentCity = city;
    });
    try {
      final data = await widget.weatherService.getWeatherByCity(city);
      setState(() {
        _data = data;
        _state = _resolveState(data);
      });
    } catch (e) {
      setState(() {
        _errorMsg = e.toString();
        _state = _LoadState.error;
      });
    }
  }

  /// WeatherService 返回 null 视为错误，空数据视为 empty
  _LoadState _resolveState(WeatherData? data) {
    if (data == null) {
      _errorMsg = '未能获取该城市的天气数据';
      return _LoadState.error;
    }
    if (data.hourly.isEmpty && data.daily.isEmpty) {
      return _LoadState.empty;
    }
    return _LoadState.loaded;
  }

  Future<void> _refresh() async {
    if (_currentCity != null) {
      await _loadByCity(_currentCity!);
    } else {
      await _loadByIp();
    }
  }

  @override
  Widget build(BuildContext context) {
    final weatherType = _data?.current.weatherCode != null
        ? WmoWeather.type(_data!.current.weatherCode!)
        : (_data != null
            ? WmoWeather.typeFromText(_data!.current.weather)
            : WeatherType.sunny);
    final isDay = _data != null
        ? WmoWeather.isDay(DateTime.now().hour)
        : true;

    return WeatherBackground(
      type: weatherType,
      isDay: isDay,
      child: SafeArea(child: _buildBody()),
    );
  }

  Widget _buildBody() {
    switch (_state) {
      case _LoadState.loading:
        return _buildLoading();
      case _LoadState.error:
        return _buildError();
      case _LoadState.empty:
        return _buildEmpty();
      case _LoadState.loaded:
        return _buildLoaded();
    }
  }

  Widget _buildLoading() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: const [
          CircularProgressIndicator(color: Color(0xFF38BDF8)),
          SizedBox(height: 16),
          Text(
            '正在获取天气数据…',
            style: TextStyle(color: Color(0xB3F8FAFC), fontSize: 14),
          ),
        ],
      ),
    );
  }

  Widget _buildError() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.error_outline, size: 56, color: Color(0xFFF87171)),
            const SizedBox(height: 12),
            const Text(
              '加载失败',
              style: TextStyle(
                color: Color(0xFFF8FAFC),
                fontSize: 18,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              _errorMsg ?? '未知错误',
              style: const TextStyle(color: Color(0x80F8FAFC), fontSize: 13),
              textAlign: TextAlign.center,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
            ),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: _refresh,
              icon: const Icon(Icons.refresh, size: 18),
              label: const Text('重试'),
              style: FilledButton.styleFrom(
                backgroundColor: const Color(0xFF38BDF8),
                foregroundColor: const Color(0xFF0B0F19),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildEmpty() {
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 12),
      children: [
        SearchBarWidget(
          onSearch: _loadByCity,
          onRefresh: _refresh,
          currentCity: _currentCity,
        ),
        const SizedBox(height: 80),
        const Icon(Icons.cloud, size: 80, color: Color(0xFF38BDF8)),
        const SizedBox(height: 12),
        const Center(
          child: Text(
            '欢迎使用 SkyWeather',
            style: TextStyle(
              color: Color(0xFFF8FAFC),
              fontSize: 22,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
        const SizedBox(height: 6),
        const Center(
          child: Text(
            '搜索或选择下方城市开始查询天气',
            style: TextStyle(color: Color(0x80F8FAFC), fontSize: 13),
          ),
        ),
      ],
    );
  }

  Widget _buildLoaded() {
    final data = _data!;
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 12),
      children: [
        SearchBarWidget(
          onSearch: _loadByCity,
          onRefresh: _refresh,
          currentCity: data.location.city,
        ),
        const SizedBox(height: 4),
        CurrentWeatherCard(
          current: data.current,
          cityName: data.location.city,
          countryCode: data.location.countryCode,
          source: data.source,
          today: data.daily.isNotEmpty ? data.daily.first : null,
        ),
        AqiCard(current: data.current),
        SunArc(today: data.daily.isNotEmpty ? data.daily.first : null),
        hourly_w.HourlyForecastList(
          hourly: data.hourly,
          current: data.current,
        ),
        daily_w.DailyForecastList(daily: data.daily),
        LifeTips(current: data.current, daily: data.daily),
        const SizedBox(height: 24),
        Center(
          child: Text(
            '数据更新于 ${_formatTime(data.updatedAt)}',
            style: const TextStyle(color: Color(0x55F8FAFC), fontSize: 11),
          ),
        ),
        const SizedBox(height: 12),
      ],
    );
  }

  String _formatTime(DateTime dt) {
    String two(int v) => v.toString().padLeft(2, '0');
    return '${two(dt.month)}-${two(dt.day)} ${two(dt.hour)}:${two(dt.minute)}';
  }
}
