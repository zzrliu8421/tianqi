// 基础烟雾测试：验证应用根组件可被构造。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:skyweather/main.dart';

void main() {
  testWidgets('App root can be constructed', (WidgetTester tester) async {
    await tester.pumpWidget(const SkyWeatherApp());
    expect(find.byType(MaterialApp), findsOneWidget);
  });
}
