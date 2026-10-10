# Android App 构建说明

用 [Capacitor](https://capacitorjs.com/) 把 Web 应用壳成原生 Android App。
App 内**不运行 Python 后端**，回测计算由内置的 JS 引擎完成，因此装到手机上即可独立使用。

## 环境要求

| 组件 | 版本 | 说明 |
|------|------|------|
| JDK | 17+ | Android Gradle Plugin 必需 |
| Android SDK | API 36 | 含 build-tools 36 |
| Node.js | 18+ | 跑 Capacitor CLI |
| Gradle | 8.x | 由 `gradlew` 自动下载 |

本机验证环境：JDK 17.0.4 / SDK API 36 / Gradle 8.7 / Node 22.22.2

## 构建步骤

```bash
# 1. 安装依赖
cd android
npm install

# 2. 设置环境变量
export JAVA_HOME=/path/to/jdk-17        # Windows: $env:JAVA_HOME="..."
export ANDROID_HOME=/path/to/android-sdk

# 3. 同步 web 资源到 www/
node scripts/sync-web.js

# 4. 生成启动图标（改了 web/icon-512.png 后需重跑）
node scripts/make-icons.js

# 5. 同步到原生工程并构建
npx cap sync android
cd android
./gradlew assembleRelease
```

Windows 建议用 `gradlew.bat`：

```bat
gradlew.bat assembleRelease
```

## 产物

| 构建类型 | 路径 | 说明 |
|----------|------|------|
| release | `android/app/build/outputs/apk/release/app-release.apk` | 已签名，可直接安装 |
| debug | `android/app/build/outputs/apk/debug/app-debug.apk` | 调试用 |

安装到手机：

```bash
adb install -r app-release.apk
```

## 签名

签名配置放在 `android/keystore.properties`，该文件**不在版本库中**。

首次生成密钥：

```bash
keytool -genkeypair -v \
  -keystore deviation-release.keystore \
  -alias deviation \
  -keyalg RSA -keysize 2048 -validity 10950
```

然后填写 `android/keystore.properties`：

```properties
storeFile=deviation-release.keystore
storePassword=你的密钥库密码
keyAlias=deviation
keyPassword=你的密钥密码
```

`app/build.gradle` 会检测该文件是否存在：存在则对 release 包签名，不存在则构建出未签名的包。

> **不要把 `.keystore` 和 `keystore.properties` 提交到版本库**，已在 `.gitignore` 中排除。密钥一旦泄露，任何人都能用你的应用身份覆盖发布。

## 网络权限

App 需要联网拉取行情。已在 `AndroidManifest.xml` 声明 `INTERNET` 权限，并通过
`res/xml/network_security_config.xml` 显式放行了行情来源域名：

- `web.ifzq.gtimg.cn`（腾讯财经，主源）
- `push2his.eastmoney.com`（东方财富，备源）
- `money.finance.sina.com.cn`（新浪，兜底）

App 本身不加载任何远程页面，只请求上述行情接口。

## 改前端代码后重新打包

```bash
cd android
node scripts/sync-web.js   # web/ → www/
npx cap sync android       # www/ → android/app/src/main/assets/public/
cd android && ./gradlew assembleRelease
```

## 常见问题

**Q：`SDK location not found`**
A：设置 `ANDROID_HOME` 环境变量，或在 `android/android/local.properties` 写入 `sdk.dir=你的SDK路径`。

**Q：编译报 `Unsupported class file major version`**
A：JDK 版本过低，需 17 或更高。

**Q：APK 装到手机上闪退**
A：确认手机 Android 版本 ≥ 7.0（minSdk 24）。可用 `adb logcat` 查看具体错误。

**Q：App 里提示「无法获取行情数据」**
A：检查网络是否可用。App 直连腾讯/东财接口，若这些域名后续变更，需同步更新 `network_security_config.xml` 与 `web/data.js`。
