# -*- coding: utf-8 -*-
"""
本地 Web 服务：静态文件 + JSON API。
启动：python server.py  然后浏览器打开 http://127.0.0.1:8770
"""

import gzip
import io
import json
import os
import socket
import threading
import traceback
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import data_source
import backtest

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")

_lock = threading.Lock()


def _flat(src):
    """把 parse_qs 的 {k: [v]} 结构压平成 {k: v}，已压平的 dict 原样返回。"""
    if not src:
        return {}
    out = {}
    for k, v in src.items():
        out[k] = v[0] if isinstance(v, list) and v else ("" if isinstance(v, list) else v)
    return out


def _num(qs, key, default=None, cast=float):
    """从 query dict（值是 list）或 body dict（值是标量）中取数值。"""
    v = qs.get(key)
    if isinstance(v, list):
        v = v[0] if v else None
    if v is None or v == "":
        return default
    try:
        return cast(v)
    except Exception:
        return default


def api_symbols(qs, body):
    return {"ok": True, "symbols": data_source.SYMBOLS}


def api_backtest(qs, body):
    src = _flat(body if body else qs)
    code = src.get("code", "510500")
    market = src.get("market")
    if market in (None, "", "1", 1):
        market = 1
    elif market in ("0", 0):
        market = 0
    else:
        market = int(market)

    symbol = next((s for s in data_source.SYMBOLS if s["code"] == code), None)
    if symbol:
        market = symbol["market"]

    # 未指定区间时默认近一年，与前端保持一致
    import datetime as _dt
    _default_start = (_dt.date.today() - _dt.timedelta(days=365)).isoformat()
    start = src.get("start") or _default_start
    end = src.get("end") or _dt.date.today().isoformat()

    ma_period = int(_num(src, "ma_period", 20))
    # 买入偏离率语义为负数（-4 表示 dev <= -4% 买入）；卖出为正数。
    # 引擎内部会做归一化，这里只做空值兜底。
    buy_dev = _num(src, "buy_dev", -4.0)
    sell_dev = _num(src, "sell_dev", 5.0)
    capital = _num(src, "capital", 100000.0)
    fee_rate = _num(src, "fee_rate", 0.0005)
    min_fee = _num(src, "min_fee", 5.0)
    full_position = str(src.get("full_position", "1")).lower() in ("1", "true", "yes")

    # 强制刷新缓存
    if str(src.get("_fresh", "")).lower() in ("1", "true", "yes"):
        with _lock:
            try:
                os.remove(data_source._cache_path(code, market))
            except OSError:
                pass

    # 需多取 ma_period 根前置数据，保证区间首日均线即可用
    try:
        pad = int(ma_period * 1.6) + 30
    except Exception:
        pad = 150

    with _lock:
        try:
            meta, cached = data_source.fetch_kline(code, market)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    bars = meta["bars"]
    if not bars:
        return {"ok": False, "error": "未获取到 %s 的行情数据" % code}

    # 定位区间起点前 pad 根
    si = 0
    for i, b in enumerate(bars):
        if b["date"] >= start:
            si = i
            break
    else:
        si = len(bars)
    si = max(0, si - pad)

    ei = len(bars)
    for i, b in enumerate(bars):
        if b["date"] > end:
            ei = i
            break

    window = bars[si:ei]
    if len(window) < 3:
        return {"ok": False,
                "error": "所选区间内只有 %d 个交易日，请放宽时间范围" % len(window)}

    result = backtest.run_backtest(
        window, ma_period=ma_period, buy_dev=buy_dev, sell_dev=sell_dev,
        initial_capital=capital, fee_rate=fee_rate, min_fee=min_fee,
        full_position=full_position, report_start=start)

    if result.get("error"):
        return {"ok": False, "error": result["error"]}

    result["ok"] = True
    result["symbol"] = {"code": code, "name": meta.get("name") or code,
                        "market": market}
    result["params"] = {"start": start, "end": end, "ma_period": ma_period,
                        "buy_dev": buy_dev, "sell_dev": sell_dev,
                        "capital": capital, "fee_rate": fee_rate,
                        "full_position": full_position}
    result["cached"] = cached
    result["source"] = meta.get("source")
    result["adjust"] = meta.get("adjust")
    result["data_range"] = [bars[0]["date"], bars[-1]["date"]]

    # 有效样本过少时给出提示，但不阻断结果
    warnings = []
    if len(result["dates"]) < 60:
        warnings.append("回测区间仅 %d 个交易日，样本偏少，指标参考意义有限"
                        % len(result["dates"]))
    if result["metrics"]["trade_count"] == 0:
        warnings.append("该参数下未触发任何买卖信号，可适当放宽偏离率阈值")
    result["warnings"] = warnings

    # NaN / Infinity 不是合法 JSON，统一转 None
    return json.loads(json.dumps(result, ensure_ascii=False, default=str))


def api_clearcache(qs, body):
    with _lock:
        n = data_source.clear_cache()
    return {"ok": True, "cleared": n}


def _lan_ip():
    """探测本机在局域网中的 IP，用于给手机端提示访问地址。"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.4)
        s.connect(("223.5.5.5", 80))     # 不会真的发包，仅用于查询出口网卡地址
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return None


def api_kline(qs, body):
    """供前端直接拉取行情（浏览器场景走服务端代理，避免跨域）。"""
    src = _flat(body if body else qs)
    code = src.get("code") or "510500"
    market = src.get("market")
    sym = next((s for s in data_source.SYMBOLS if s["code"] == code), None)
    market = sym["market"] if sym else (1 if str(market) != "0" else 0)

    with _lock:
        try:
            meta, _ = data_source.fetch_kline(code, market)
        except Exception as e:
            return {"ok": False, "error": str(e)}
    return {"ok": True, "code": code, "market": market,
            "name": meta.get("name"), "source": meta.get("source"),
            "bars": meta["bars"]}


def api_info(qs, body):
    """返回本机可用的访问地址，供前端展示与生成二维码。"""
    port = int(os.environ.get("PORT", "8770"))
    lan = _lan_ip()
    host = (body or {}).get("host") or qs.get("host", [None])[0]
    # 前端上报的 host：若是 localhost/127.0.0.1，则替换为局域网 IP 方便手机扫码
    if host in ("localhost", "127.0.0.1", "::1", "") and lan:
        host = lan
    return {
        "ok": True,
        "lan_ip": lan,
        "port": port,
        "host": host,
        "url": "http://%s:%d" % (host, port) if host else "",
        "local_url": "http://127.0.0.1:%d" % port,
    }


def api_qr(qs, body):
    """生成访问地址二维码（SVG）。缺少二维码库时降级，前端改为纯文本提示。"""
    info = api_info(qs, body)
    url = info.get("url")
    if not url:
        return {"ok": False, "error": "无法确定访问地址"}
    try:
        import segno
        qr = segno.make(url, error='m')      # M 级纠错，容错 15%，扫码更稳
        buf = io.BytesIO()
        qr.save(buf, kind='svg', scale=4, border=2,
                dark="#0b0e14", light="#ffffff")
        return {"ok": True, "svg": buf.getvalue().decode("utf-8"), "url": url}
    except ImportError:
        return {"ok": False, "error": "未安装二维码库（pip install segno）", "url": url}
    except Exception as e:
        return {"ok": False, "error": str(e), "url": url}


def main():
    # 监听 0.0.0.0，手机 / 平板与本机处于同一 Wi-Fi 时可直接访问。
    # 端口优先取环境变量 PORT（部署环境注入），本地默认 8770。
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8770"))

    srv = ThreadingHTTPServer((host, port), Handler)
    srv.daemon_threads = True

    lan = _lan_ip()
    print("=" * 56)
    print("  ETF 偏离率回测系统")
    print("  本机访问：   http://127.0.0.1:%d" % port)
    if lan:
        print("  局域网访问： http://%s:%d   ← 手机连同一 Wi-Fi 用这个" % (lan, port))
    print("  按 Ctrl+C 停止")
    print("=" * 56)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        srv.server_close()


ROUTES = {
    "/api/symbols": api_symbols,
    "/api/backtest": api_backtest,
    "/api/clearcache": api_clearcache,
    "/api/kline": api_kline,
    "/api/info": api_info,
    "/api/qr": api_qr,
}


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB_DIR, **kw)

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        # 允许同网段设备（手机/平板）访问本机资源
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def _send(self, code, payload, ctype="application/json; charset=utf-8"):
        data = payload if isinstance(payload, bytes) else \
            json.dumps(payload, ensure_ascii=False, allow_nan=False,
                       default=str).encode("utf-8")

        # 行情数据量较大（约 200KB+），支持 gzip 显著降低手机端流量与加载耗时
        encoded = None
        if len(data) > 2048 and "gzip" in (self.headers.get("Accept-Encoding") or ""):
            buf = io.BytesIO()
            with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=6) as gz:
                gz.write(data)
            if len(buf.getvalue()) < len(data):
                encoded = buf.getvalue()

        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(encoded or data)))
        self.send_header("Cache-Control", "no-store")
        if encoded:
            self.send_header("Content-Encoding", "gzip")
        self.end_headers()
        try:
            self.wfile.write(encoded or data)
        except (BrokenPipeError, ConnectionResetError):
            pass          # 移动端切换页面时主动断开，属正常现象

    def do_GET(self):
        u = urlparse(self.path)
        if u.path in ROUTES:
            try:
                self._send(200, ROUTES[u.path](parse_qs(u.query), None))
            except Exception as e:
                traceback.print_exc()
                self._send(500, {"ok": False, "error": str(e)})
            return
        super().do_GET()

    def do_POST(self):
        u = urlparse(self.path)
        if u.path in ROUTES:
            try:
                ln = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(ln) if ln else b"{}"
                try:
                    body = json.loads(raw.decode("utf-8") or "{}")
                except Exception:
                    body = {}
                self._send(200, ROUTES[u.path](parse_qs(u.query), body))
            except Exception as e:
                traceback.print_exc()
                self._send(500, {"ok": False, "error": str(e)})
            return
        self._send(404, {"ok": False, "error": "not found"})


if __name__ == "__main__":
    main()
