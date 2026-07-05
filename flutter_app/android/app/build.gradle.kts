plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.skyweather.skyweather"
    compileSdk = 36
    ndkVersion = flutter.ndkVersion
    buildToolsVersion = "36.1.0"

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "com.skyweather.skyweather"
        minSdk = flutter.minSdkVersion
        targetSdk = 36
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        ndk {
            // Flutter 插件默认设置 abiFilters 为 [armeabi-v7a, arm64-v8a, x86_64]
            // 这里清除并只保留 arm64-v8a 以减小 APK 体积（手机为 arm64 架构）
            abiFilters.clear()
            abiFilters += "arm64-v8a"
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

// Flutter gradle 插件 forceNdkDownload 仍激活（在 FlutterPlugin.kt 中），
// 它设置空 CMakeLists.txt 触发 mergeNativeLibs 任务来打包 AAR 中的 libflutter.so。
// 但假 NDK 缺少完整 toolchain，CMake 配置/构建会失败，必须禁用。
// mergeNativeLibs 任务不依赖 CMake 实际运行，仍会从 AAR 提取 libflutter.so。
// llvm-strip.exe 已用 C# 编译的假程序替换（仅复制文件不剥离符号），
// strip 任务能正常运行并注册 STRIPPED_NATIVE_LIBS artifact 供打包使用。
tasks.matching {
    val n = runCatching { it.name }.getOrNull() ?: ""
    // 禁用 CMake 配置/构建任务（假 NDK 无法执行 CMake）
    n.startsWith("configure") && n.contains("CMake") ||
    n.startsWith("build") && n.contains("CMake") ||
    n.startsWith("externalNativeBuild")
}.configureEach {
    enabled = false
}
