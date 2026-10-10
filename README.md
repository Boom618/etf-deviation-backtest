# 偏离率回测系统

用「价格相对均线的偏离率」触发买卖的 ETF / 指数策略回测工具。同一套代码，三种运行方式：

- **本机服务** — 零依赖，Python 3.8+ 直接跑，手机同 Wi-Fi 也能访问
- **PWA 网页** — 可添加到手机主屏，像 App 一样全屏使用
- **Android App** — 预编译 APK 直接安装

![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Android%20%7C%20iOS-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![python](https://img.shields.io/badge/python-3.8%2B-blue)

---

## 策略逻辑

以收盘价计算偏离率：

```
deviation = (close - MA) / MA × 100%
```

| 信号 | 触发条件 | 默认阈值 |
|------|----------|----------|
| 买入 | `deviation ≤ buy_dev` | **-4%**（负数） |
| 卖出 | `deviation ≥ sell_dev` | **+5%**（正数） |

**成交假设**：信号在收盘后产生，**次日开盘价**成交（避免未来函数）。A 股 100 股整数倍，含双边佣金与最低 5 元佣金。

> 买入偏离率是负数、卖出是正数。为兼容旧写法，若买入传入正数会自动取负，卖出传入负数会取绝对值。

---

## 快速开始

### 方式一：本机服务（推荐，功能最全）

```bash
git clone https://github.com/Boom618/etf-deviation-backtest.git
cd etf-deviation-backtest
python server.py
```

浏览器打开 <http://127.0.0.1:8770>

启动后终端会显示局域网地址，手机连同一 Wi-Fi 即可访问：

```
本机访问：   http://127.0.0.1:8770
局域网访问： http://192.168.x.x:8770   ← 手机连同一 Wi-Fi 用这个
```

Windows 用户可直接双击 `启动.bat`。

**零第三方依赖**，Python 3.8+ 标准库即可运行。行情缓存自动生成在 `cache/`。

### 方式二：直接用网页版

本机服务起一次后，手机浏览器打开局域网地址，菜单里选「添加到主屏幕」，之后可全屏运行。

### 方式三：安装 Android App

下载 [Releases](https://github.com/Boom618/etf-deviation-backtest/releases) 里的 APK 安装即可。App 内置回测引擎，**不需要电脑提供服务**。

---

## 输出指标

| 类别 | 指标 |
|------|------|
| 偏离率 | 当前偏离率、区间最大/最小偏离率（含发生日期）、区间均值 |
| 收益 | 策略收益率、基准（买入持有）收益率、超额收益、年化收益 |
| 风险 | 最大回撤、年化波动率、夏普比率 |
| 交易 | 交易次数、胜率、盈亏比、平均盈利/亏损、持仓占比、累计手续费 |
| 终值 | 期末净值 |

三张联动图表（悬停/触摸时十字光标同步）：

1. **偏离率走势** — 含买入区 / 卖出区色带与阈值线
2. **价格与均线** — 标注每笔买卖点
3. **收益对比** — 策略净值 vs 基准净值

---

## 可配置参数

| 参数 | 说明 | 默认 |
|------|------|------|
| 标的 | 17 个 ETF / 指数（宽基 / 行业 / 商品 / 海外） | 510500 |
| 回测区间 | 起始日 / 截止日 | 近 5 年 |
| 均线周期 | 5–250 日 | **20** |
| 买入偏离率 | 低于均线多少个百分点买入（负数） | **-4%** |
| 卖出偏离率 | 高于均线多少个百分点卖出（正数） | **+5%** |
| 初始资金 | — | 100000 |
| 佣金费率 | 双边 | 0.05% |
| 仓位模式 | 满仓 / 半仓 | 满仓 |

---

## 架构

```
etf-deviation-backtest/
├── server.py           # HTTP 服务 + JSON API（标准库）
├── backtest.py         # 回测引擎（纯计算，零依赖）
├── data_source.py      # 行情抓取 + 多源容错 + 缓存
└── web/                # 前端
    ├── index.html
    ├── style.css
    ├── app.js          # 界面逻辑
    ├── chart.js        # 自绘 Canvas 图表引擎
    ├── backtest.js     # JS 版回测引擎（App 内使用）
    ├── data.js         # JS 版行情获取（App 内使用）
    ├── sw.js           # Service Worker
    └── manifest.webmanifest

android/                # Capacitor 打包的 Android 工程
├── scripts/
│   ├── sync-web.js     # 同步 web/ → www/
│   └── make-icons.js   # 生成 Android 启动图标
└── android/            # 原生工程
```

**两套回测引擎**：`backtest.py`（服务端，Python）与 `backtest.js`（App 内，JavaScript）。两者逻辑严格一致 —— 迁移时用 5 组参数做了逐字段比对（收益率、年化、回撤、夏普、交易明细全部相同）。App 内没有 Python 运行时，因此走 JS 引擎本地计算。

---

## 数据源

| 优先级 | 来源 | 复权 | 说明 |
|--------|------|------|------|
| 主源 | 腾讯财经 `ifzq.gtimg.cn` | 前复权 | 分页拉取，可回溯至 2013 年 |
| 备源 | 东方财富 | 前复权 | 主源失败时兜底 |
| 兜底 | 新浪财经 | 不复权 | 仅在前两者都失败时使用 |

> ⚠️ 偏离率对复权口径非常敏感（ETF 分红会导致除权跳空），因此优先使用前复权数据。新浪返回不复权价，只能作为最后兜底。

行情数据来自第三方公开接口，仅供研究学习，**不构成投资建议**。

---

## HTTP API

服务启动后可直接调用：

```bash
# 执行回测
curl -X POST http://127.0.0.1:8770/api/backtest \
  -H "Content-Type: application/json" \
  -d '{"code":"510500","ma_period":20,"buy_dev":-4,"sell_dev":5}'

# 也支持 GET
curl "http://127.0.0.1:8770/api/backtest?code=510500&ma_period=20&buy_dev=-4&sell_dev=5"
```

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/backtest` | GET / POST | 执行回测，返回偏离率序列、净值、成交明细、绩效指标 |
| `/api/kline` | GET | 获取日线行情（供浏览器端使用，避免跨域） |
| `/api/symbols` | GET | 标的清单 |
| `/api/clearcache` | POST | 清空行情缓存并重新拉取 |
| `/api/info` | GET / POST | 返回本机局域网访问地址 |
| `/api/qr` | GET / POST | 生成访问地址二维码（需 `pip install segno`） |

---

## 从源码构建 Android App

需要 JDK 17、Android SDK（API 36）。

```bash
cd android
npm install

# 1. 同步 web/ 到 www/
node scripts/sync-web.js

# 2. 生成启动图标
node scripts/make-icons.js

# 3. 构建 APK
cd android
export JAVA_HOME=/path/to/jdk-17
export ANDROID_HOME=/path/to/android-sdk
./gradlew assembleRelease
```

产物位置：

```
android/android/app/build/outputs/apk/release/app-release.apk
```

### 签名说明

`android/android/keystore.properties` 与 `.keystore` 文件**不在版本库中**（已在 `.gitignore` 排除）。

自行生成签名密钥：

```bash
keytool -genkeypair -v -keystore deviation-release.keystore \
  -alias deviation -keyalg RSA -keysize 2048 -validity 10950
```

然后在 `android/android/keystore.properties` 中填写：

```properties
storeFile=deviation-release.keystore
storePassword=你的密码
keyAlias=deviation
keyPassword=你的密码
```

> 不配置签名也能构建出 debug APK，但正式分发建议用自己的密钥签名。

---

## 部署到服务器

服务已支持 `PORT` 环境变量与 `0.0.0.0` 绑定：

```bash
PORT=80 python server.py          # Linux
$env:PORT=80; python server.py    # Windows PowerShell
```

公网暴露时建议自行加一层 HTTPS 反向代理。

---

## 常见问题

**Q：手机上打不开局域网地址？**
A：确认手机与电脑连的是同一 Wi-Fi；部分公司/公共网络开启了 AP 隔离，会阻止设备间通信。另外电脑防火墙需放行该端口。

**Q：回测结果和之前对不上？**
A：本工具的信号在**收盘后产生、次日开盘成交**。如果你的其他工具用当日收盘价成交，结果会有差异。

**Q：为什么策略跑不赢基准？**
A：偏离率策略本质是「高抛低吸」，在单边上涨行情中会不断卖飞。这是策略特性而非 bug，建议对照不同均线周期与阈值观察表现。

**Q：能回测港股或美股吗？**
A：当前标的清单为 A 股 ETF / 指数。扩展只需在 `data_source.py` 和 `web/data.js` 的 `SYMBOLS` 中增加条目。

---

## 免责声明

本工具仅供研究与学习，**不构成任何投资建议**。历史回测结果不代表未来收益，据此操作风险自担。

## License

[MIT](LICENSE)
