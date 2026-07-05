import 'dart:convert';
import 'dart:io';

/// 纯 Dart 实现的轻量 KV 持久化存储。
///
/// 替代 shared_preferences 以避免引入 native 编译依赖（NDK/CMake）。
/// 数据以 JSON 形式持久化到应用沙盒目录下。
class LocalStorage {
  LocalStorage._(this._file, this._data);

  final File _file;
  Map<String, dynamic> _data;

  /// 单例实例。
  static LocalStorage? _instance;

  /// 获取单例。
  static Future<LocalStorage> getInstance() async {
    if (_instance != null) return _instance!;
    final file = await _resolveFile();
    Map<String, dynamic> data;
    if (await file.exists()) {
      try {
        final raw = await file.readAsString();
        data = jsonDecode(raw) as Map<String, dynamic>? ?? {};
      } catch (_) {
        data = {};
      }
    } else {
      data = {};
    }
    _instance = LocalStorage._(file, data);
    return _instance!;
  }

  /// 解析存储文件路径。
  ///
  /// Android 上使用应用沙盒目录 `/data/data/<pkg>/files/prefs.json`，
  /// 其他平台回退到系统临时目录。
  static Future<File> _resolveFile() async {
    final dir = _appDataDir();
    final file = File('${dir.path}${Platform.pathSeparator}prefs.json');
    if (!await file.parent.exists()) {
      await file.parent.create(recursive: true);
    }
    return file;
  }

  static Directory _appDataDir() {
    // Android：包名 com.skyweather.skyweather 对应沙盒目录
    if (Platform.isAndroid) {
      return Directory('/data/data/com.skyweather.skyweather/files');
    }
    if (Platform.isWindows) {
      final home = Platform.environment['USERPROFILE'] ?? '.';
      return Directory('$home\\.skyweather');
    }
    final home = Platform.environment['HOME'] ?? '.';
    return Directory('$home/.skyweather');
  }

  /// 读取字符串列表。
  List<String> getStringList(String key) {
    final v = _data[key];
    if (v is List) return v.map((e) => e.toString()).toList();
    return [];
  }

  /// 写入字符串列表。
  Future<void> setStringList(String key, List<String> value) async {
    _data[key] = value;
    await _flush();
  }

  /// 删除指定 key。
  Future<void> remove(String key) async {
    _data.remove(key);
    await _flush();
  }

  Future<void> _flush() async {
    final encoded = jsonEncode(_data);
    await _file.writeAsString(encoded, flush: true);
  }
}
