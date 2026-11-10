# -*- coding: utf-8 -*-
"""
数据层：标的清单 + 日线行情抓取（多源容错）+ 本地磁盘缓存。

数据源优先级：
  1. 腾讯 ifzq.gtimg.cn  —— 前复权(qfq)，分页拉取，历史完整
  2. 新浪财经            —— 不复权，仅作兜底（会标注口径差异）

注意：偏离率策略对复权口径敏感，腾讯与东财口径一致（均为前复权）。
"""

import gzip
import json
import os
import subprocess
import time
import urllib.request

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")
os.makedirs(CACHE_DIR, exist_ok=True)

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

HEADERS = {
    "User-Agent": UA,
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": "https://gu.qq.com/",
}

# ---------------------------------------------------------------- 标的清单
SYMBOLS = [
    {"code": "510500", "market": 1, "name": "中证500ETF(南方)", "cat": "宽基ETF"},
    {"code": "510300", "market": 1, "name": "沪深300ETF(华泰柏瑞)", "cat": "宽基ETF"},
    {"code": "510050", "market": 1, "name": "上证50ETF(华夏)", "cat": "宽基ETF"},
    {"code": "512100", "market": 1, "name": "中证1000ETF(南方)", "cat": "宽基ETF"},
    {"code": "159915", "market": 0, "name": "创业板ETF(易方达)", "cat": "宽基ETF"},
    {"code": "588000", "market": 1, "name": "科创50ETF(华夏)", "cat": "宽基ETF"},
    {"code": "512880", "market": 1, "name": "证券ETF(国泰)", "cat": "行业ETF"},
    {"code": "512690", "market": 1, "name": "酒ETF(鹏华)", "cat": "行业ETF"},
    {"code": "512170", "market": 1, "name": "医疗ETF(华宝)", "cat": "行业ETF"},
    {"code": "159928", "market": 0, "name": "消费ETF(汇添富)", "cat": "行业ETF"},
    {"code": "518880", "market": 1, "name": "黄金ETF(华安)", "cat": "商品"},
    {"code": "513100", "market": 1, "name": "纳指ETF(国泰)", "cat": "海外"},
    {"code": "513500", "market": 1, "name": "标普500ETF(博时)", "cat": "海外"},
    {"code": "000905", "market": 1, "name": "中证500指数", "cat": "指数"},
    {"code": "000300", "market": 1, "name": "沪深300指数", "cat": "指数"},
    {"code": "000001", "market": 1, "name": "上证指数", "cat": "指数"},
    {"code": "399006", "market": 0, "name": "创业板指", "cat": "指数"},
    {"code": "600900", "market": 1, "name": "长江电力", "cat": "个股"},
]

TX_URL = ("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
          "?param={sym},day,{start},{end},{cnt},qfq")
SINA_URL = ("https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/"
            "CN_MarketData.getKLineData?symbol={sym}&scale=240&ma=no&datalen={cnt}")


def _tx_symbol(code, market):
    return ("sh" if market == 1 else "sz") + code


# A 股代码段 -> 交易所。用于支持输入清单外的任意代码。
# 规则来自代码本身的分段，不依赖外部数据。
_SH_PREFIX = ("600", "601", "603", "605", "688", "689", "900", "730", "780", "787")
_SZ_PREFIX = ("000", "001", "002", "003", "300", "301", "200", "159", "160", "161",
              "162", "163", "164", "165", "166", "167", "168", "169", "170", "171")


def guess_market(code):
    """按代码段推断交易所。无法判断时返回 None。

    1 = 上交所，0 = 深交所。
    """
    c = str(code or "").strip()
    if len(c) != 6 or not c.isdigit():
        return None
    p3 = c[:3]
    if p3 in _SH_PREFIX:
        return 1
    if p3 in _SZ_PREFIX:
        return 0
    if c[0] == "5":          # 沪市 ETF / LOF
        return 1
    if c[0] == "1":          # 深市 ETF / LOF
        return 0
    if c[:2] == "39":        # 深证指数
        return 0
    return None


def _extract_name(payload, sym):
    """从腾讯返回的 qt 字段里取股票名称。"""
    try:
        node = (payload.get("data") or {}).get(sym) or {}
        qt = node.get("qt") or {}
        for v in qt.values():
            if isinstance(v, list) and len(v) > 3 and isinstance(v[1], str):
                name = v[1].strip()
                # Rank_A_sh 之类的内部标记不是真实名称
                if name and not name.startswith("Rank_"):
                    return name
    except Exception:
        pass
    return None


def fetch_name(code, market):
    """用实时行情接口查股票名称（GBK 编码）。失败返回 None。"""
    sym = _tx_symbol(code, market)
    try:
        raw = _http_get_bytes("https://qt.gtimg.cn/q=" + sym, timeout=12, retries=2)
        txt = raw.decode("gbk", "ignore")
        # 形如：v_sh600519="1~贵州茅台~600519~1439.00~..."
        if "=" not in txt:
            return None
        body = txt.split("=", 1)[1].strip().strip('";')
        parts = body.split("~")
        if len(parts) < 3:
            return None
        name = parts[1].strip()
        # 校验返回的代码是否与请求一致（腾讯会模糊匹配到别的标的）
        if parts[2].strip() != str(code):
            return None
        if not name or name.startswith("Rank_"):
            return None
        return name
    except Exception:
        return None


def _sina_symbol(code, market):
    return ("sh" if market == 1 else "sz") + code


# ---------------------------------------------------------------- HTTP
def http_get(url, timeout=25, retries=3):
    """GET 请求。优先 urllib；失败时回退系统 curl（部分站点会拦截 Python TLS 指纹）。

    腾讯的 WAF 会返回一段 HTML 跳转页来限流，这种响应不是有效数据，
    必须当成失败继续重试，否则下游 json.loads 会炸。
    """
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                txt = raw.decode("utf-8", "ignore")
                if _looks_like_waf(txt):
                    last = RuntimeError("被腾讯 WAF 限流")
                    time.sleep(1.2 * (i + 1))
                    continue
                return txt
        except Exception as e:
            last = e
            time.sleep(0.8 * (i + 1))

    # curl 回退
    for flag in ([], ["--noproxy", "*"]):
        try:
            out = subprocess.run(
                ["curl", "-s", "--compressed", "--max-time", str(timeout)] + flag + [url],
                capture_output=True, timeout=timeout + 8)
            txt = out.stdout.decode("utf-8", "ignore")
            if txt.strip() and not _looks_like_waf(txt):
                return txt
        except Exception as e:
            last = e
    raise RuntimeError("请求失败：%s" % last)


def _looks_like_waf(txt):
    """判断响应是否为腾讯 WAF 的限流跳转页。"""
    head = (txt or "")[:400]
    return ("waf.tencent.com" in head) or head.lstrip().startswith("<!DOCTYPE html>")


def _http_get_bytes(url, timeout=25, retries=3):
    """取原始字节（用于 GBK 编码的接口）。"""
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                if _looks_like_waf(raw.decode("utf-8", "ignore")):
                    last = RuntimeError("被腾讯 WAF 限流")
                    time.sleep(1.2 * (i + 1))
                    continue
                return raw
        except Exception as e:
            last = e
            time.sleep(0.8 * (i + 1))
    raise RuntimeError("请求失败：%s" % last)


# ---------------------------------------------------------------- 腾讯（前复权）
def fetch_tencent(code, market, max_pages=12, page=640):
    sym = _tx_symbol(code, market)
    bars = {}
    end = "2099-12-31"
    name = None

    for _ in range(max_pages):
        url = TX_URL.format(sym=sym, start="1990-01-01", end=end, cnt=page)
        txt = http_get(url)
        payload = json.loads(txt)
        data = payload.get("data") or {}
        node = data.get(sym) or {}
        rows = node.get("qfqday") or node.get("day") or []
        if not rows:
            break
        if name is None:
            name = _extract_name(payload, sym)
        before = len(bars)
        for r in rows:
            # [日期, 开, 收, 高, 低, 成交量(手)]
            if len(r) < 6:
                continue
            bars[r[0]] = {
                "date": r[0],
                "open": float(r[1]),
                "close": float(r[2]),
                "high": float(r[3]),
                "low": float(r[4]),
                "volume": float(r[5]),
                "amount": float(r[5]) * float(r[2]),
            }
        earliest = rows[0][0]
        if len(rows) < page or len(bars) == before:
            break
        end = _prev_day(earliest)

    out = sorted(bars.values(), key=lambda b: b["date"])
    return out, name


def _prev_day(datestr):
    import datetime
    d = datetime.date.fromisoformat(datestr) - datetime.timedelta(days=1)
    return d.isoformat()


# ---------------------------------------------------------------- 新浪（不复权，兜底）
def fetch_sina(code, market, cnt=2000):
    sym = _sina_symbol(code, market)
    url = SINA_URL.format(sym=sym, cnt=cnt)
    txt = http_get(url)
    try:
        rows = json.loads(txt)
    except Exception:
        rows = None
    if not isinstance(rows, list):
        rows = []
    out = []
    for r in rows:
        try:
            out.append({
                "date": r["day"],
                "open": float(r["open"]), "close": float(r["close"]),
                "high": float(r["high"]), "low": float(r["low"]),
                "volume": float(r.get("volume") or 0) / 100.0,
                "amount": 0.0,
            })
        except Exception:
            continue
    out.sort(key=lambda b: b["date"])
    return out


# ---------------------------------------------------------------- 对外入口
def _cache_path(code, market):
    return os.path.join(CACHE_DIR, "kline_%s_%d.json" % (code, market))


def fetch_kline(code, market=None, max_age=1800):
    """抓取日线行情。返回 (meta, from_cache)。

    market 传 None 时按代码段自动推断交易所。
    """
    code = str(code or "").strip()
    symbol = next((s for s in SYMBOLS if s["code"] == code), None)
    if symbol:
        market = symbol["market"]
    elif market in (None, ""):
        market = guess_market(code)
        if market is None:
            raise ValueError("无法识别 %s 的交易所，请在代码后加 sh 或 sz" % code)
    else:
        market = int(market)

    path = _cache_path(code, market)

    if os.path.exists(path):
        try:
            if time.time() - os.pathmtime(path) < max_age:
                with open(path, "r", encoding="utf-8") as f:
                    return json.load(f), True
        except Exception:
            pass

    meta = None
    err1 = err2 = None
    # 源1：腾讯前复权
    try:
        bars, tx_name = fetch_tencent(code, market)
        if len(bars) >= 60:
            meta = {"code": code, "market": market, "source": "tencent_qfq",
                    "adjust": "qfq", "bars": bars, "tx_name": tx_name}
        else:
            err1 = "返回数据不足（%d 根）" % len(bars)
    except Exception as e:
        err1 = str(e)

    # 源2：新浪兜底
    if meta is None:
        try:
            bars = fetch_sina(code, market)
            if len(bars) >= 60:
                meta = {"code": code, "market": market, "source": "sina_raw",
                        "adjust": "none", "bars": bars, "tx_name": None}
            else:
                err2 = "返回数据不足（%d 根）" % len(bars)
        except Exception as e:
            err2 = str(e)

    if meta is None:
        raise RuntimeError("未获取到 %s 的行情数据（腾讯: %s / 新浪: %s）"
                           % (code, err1, err2))

    # 高分红标的（如长江电力）早期前复权价会被累计调整成负数，
    # 这类数据会让均线与回撤计算失真，直接丢弃。
    meta["bars"] = _drop_invalid(meta["bars"])

    # 清单外的代码要另外查一次真实名称（腾讯的 K 线接口不带 qt 字段）
    if not symbol and not meta.get("tx_name"):
        meta["tx_name"] = fetch_name(code, market)

    meta["name"] = _display_name(code, meta)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, separators=(",", ":"))
    return meta, False


def _drop_invalid(bars):
    """剔除价格非正或非有限的 bar（高分红标的早期前复权价可能为负）。"""
    out = []
    for b in bars:
        ok = True
        for k in ("open", "close", "high", "low"):
            v = b.get(k)
            if v is None or v != v or v <= 0:      # None / NaN / <=0
                ok = False
                break
        if ok:
            out.append(b)
    return out


def _display_name(code, meta):
    """清单内用自定义名称；清单外用行情接口返回的真实名称。"""
    s = next((x for x in SYMBOLS if x["code"] == code), None)
    if s:
        return s["name"]
    tx_name = (meta or {}).get("tx_name")
    if tx_name:
        return tx_name
    return code


def clear_cache():
    n = 0
    for f in os.listdir(CACHE_DIR):
        try:
            os.remove(os.path.join(CACHE_DIR, f))
            n += 1
        except Exception:
            pass
    return n
