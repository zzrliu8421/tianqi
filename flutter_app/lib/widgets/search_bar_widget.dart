/// 搜索栏组件
/// 搜索框 + 搜索按钮 + 刷新按钮 + 搜索历史 + 快速城市

import 'package:flutter/material.dart';

import '../services/local_storage.dart';

class SearchBarWidget extends StatefulWidget {
  final void Function(String city) onSearch;
  final VoidCallback onRefresh;
  final String? currentCity;

  const SearchBarWidget({
    super.key,
    required this.onSearch,
    required this.onRefresh,
    this.currentCity,
  });

  @override
  State<SearchBarWidget> createState() => _SearchBarWidgetState();
}

class _SearchBarWidgetState extends State<SearchBarWidget> {
  static const _historyKey = 'weather_search_history';
  static const _maxHistory = 8;

  final TextEditingController _controller = TextEditingController();
  final FocusNode _focusNode = FocusNode();
  List<String> _history = [];
  bool _showHistory = false;

  static const _quickCities = [
    '北京', '上海', '广州', '深圳', '杭州',
    '成都', '纽约', '伦敦', '东京',
  ];

  @override
  void initState() {
    super.initState();
    _loadHistory();
    _focusNode.addListener(() {
      setState(() => _showHistory = _focusNode.hasFocus);
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  Future<void> _loadHistory() async {
    final prefs = await LocalStorage.getInstance();
    setState(() {
      _history = prefs.getStringList(_historyKey);
    });
  }

  Future<void> _saveHistory(String city) async {
    final prefs = await LocalStorage.getInstance();
    final list = <String>[city, ..._history.where((c) => c != city)];
    final trimmed = list.take(_maxHistory).toList();
    await prefs.setStringList(_historyKey, trimmed);
    setState(() => _history = trimmed);
  }

  Future<void> _clearHistory() async {
    final prefs = await LocalStorage.getInstance();
    await prefs.remove(_historyKey);
    setState(() => _history = []);
  }

  void _doSearch(String value) {
    final city = value.trim();
    if (city.isEmpty) return;
    _controller.clear();
    _focusNode.unfocus();
    _saveHistory(city);
    widget.onSearch(city);
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 8, 12, 4),
      padding: const EdgeInsets.fromLTRB(14, 10, 10, 12),
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
              const Icon(Icons.location_on, size: 18, color: Color(0xFF38BDF8)),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  widget.currentCity ?? 'SkyWeather',
                  style: const TextStyle(
                    color: Color(0xFFF8FAFC),
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              IconButton(
                onPressed: widget.onRefresh,
                icon: const Icon(Icons.refresh, size: 20),
                color: const Color(0xFF38BDF8),
                tooltip: '刷新',
              ),
            ],
          ),
          const SizedBox(height: 8),
          TextField(
            controller: _controller,
            focusNode: _focusNode,
            style: const TextStyle(color: Color(0xFFF8FAFC), fontSize: 14),
            decoration: InputDecoration(
              isDense: true,
              hintText: '搜索城市名（如：北京）',
              hintStyle: const TextStyle(color: Color(0x66F8FAFC), fontSize: 14),
              prefixIcon: const Icon(Icons.search, size: 20, color: Color(0xFF38BDF8)),
              suffixIcon: ValueListenableBuilder<TextEditingValue>(
                valueListenable: _controller,
                builder: (context, value, _) {
                  if (value.text.isEmpty) return const SizedBox.shrink();
                  return IconButton(
                    onPressed: () => _doSearch(value.text),
                    icon: const Icon(Icons.north, size: 18),
                    color: const Color(0xFF38BDF8),
                    tooltip: '搜索',
                  );
                },
              ),
              filled: true,
              fillColor: const Color(0x10FFFFFF),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(14),
                borderSide: BorderSide.none,
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(14),
                borderSide: const BorderSide(color: Color(0x33F8FAFC)),
              ),
              contentPadding: const EdgeInsets.symmetric(vertical: 8, horizontal: 12),
            ),
            onSubmitted: _doSearch,
            textInputAction: TextInputAction.search,
          ),
          // 搜索历史
          if (_showHistory && _history.isNotEmpty) ...[
            const SizedBox(height: 8),
            Row(
              children: [
                const Icon(Icons.history, size: 14, color: Color(0x66F8FAFC)),
                const SizedBox(width: 4),
                const Text(
                  '最近搜索',
                  style: TextStyle(color: Color(0x66F8FAFC), fontSize: 11),
                ),
                const Spacer(),
                GestureDetector(
                  onTap: _clearHistory,
                  child: const Text(
                    '清除',
                    style: TextStyle(color: Color(0xFF818CF8), fontSize: 11),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: _history.map((c) => _chip(c, () {
                _focusNode.unfocus();
                _doSearch(c);
              })).toList(),
            ),
          ],
          // 快速城市
          const SizedBox(height: 10),
          const Text(
            '热门城市',
            style: TextStyle(color: Color(0x66F8FAFC), fontSize: 11),
          ),
          const SizedBox(height: 6),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: _quickCities.map((c) => _chip(c, () {
              _focusNode.unfocus();
              _doSearch(c);
            })).toList(),
          ),
        ],
      ),
    );
  }

  Widget _chip(String label, VoidCallback onTap) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(
          color: const Color(0x10FFFFFF),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: const Color(0x14FFFFFF)),
        ),
        child: Text(
          label,
          style: const TextStyle(
            color: Color(0xB3F8FAFC),
            fontSize: 12,
          ),
        ),
      ),
    );
  }
}
