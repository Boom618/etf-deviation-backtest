# -*- coding: utf-8 -*-
"""
回测引擎：均线偏离率策略。

信号定义（以收盘价计算，次日开盘成交，避免未来函数）：
    deviation = (close - MA) / MA * 100%
    deviation <= buy_dev    -> 买入信号（超跌），buy_dev 为负数，如 -4
    deviation >= sell_dev   -> 卖出信号（超涨），sell_dev 为正数，如 5

本模块只做纯计算，无第三方依赖。
"""

import math


# ---------------------------------------------------------------- 指标计算
def moving_average(closes, period):
    """简单移动均线，前 period-1 个位置为 None。"""
    ma = [None] * len(closes)
    if period <= 0:
        return ma
    run = 0.0
    for i, c in enumerate(closes):
        run += c
        if i >= period:
            run -= closes[i - period]
        if i >= period - 1:
            ma[i] = run / period
    return ma


def deviation_series(closes, period):
    """偏离率序列（%），与 closes 等长，均线无效处为 None。"""
    ma = moving_average(closes, period)
    dev = [None] * len(closes)
    for i, c in enumerate(closes):
        if ma[i] not in (None, 0):
            dev[i] = (c - ma[i]) / ma[i] * 100.0
    return ma, dev


# ---------------------------------------------------------------- 回测主函数
def run_backtest(bars, ma_period=60, buy_dev=10.0, sell_dev=10.0,
                  initial_capital=100000.0, fee_rate=0.0005, min_fee=5.0,
                  full_position=True, report_start=None):
    """
    执行回测。

    参数
    ----
    bars        : 按日期升序的行情列表 [{date, open, close, high, low, ...}]
    ma_period   : 均线周期
    buy_dev     : 买入偏离率阈值。语义为负数，dev <= buy_dev 触发买入。
                  传入正数会自动取负（兼容旧写法：4 等价于 -4）。
    sell_dev    : 卖出偏离率阈值。语义为正数，dev >= sell_dev 触发卖出。
                  传入负数会自动取绝对值。
    initial_capital : 初始资金
    fee_rate    : 佣金费率（双边）
    min_fee     : 单笔最低佣金
    full_position : True=满仓进出；False=每次只用一半资金
    report_start : 统计与展示的起始日。bars 中早于该日期的数据仅用于预热均线，
                   不计入收益、基准与图表，避免前置数据稀释指标。

    返回
    ----
    dict，含净值曲线、成交明细、偏离率序列与绩效指标。
    """
    if not bars or len(bars) < 2:
        return {"error": "数据不足，无法回测"}

    dates = [b["date"] for b in bars]
    opens = [b["open"] for b in bars]
    closes = [b["close"] for b in bars]
    n = len(bars)

    # ---- 回测起点：report_start 之前的数据仅用于均线预热，不参与交易。
    # 否则策略会在窗口开始前就已持仓，净值起点被压低、指标失真。
    start_i = 0
    if report_start:
        for i, d in enumerate(dates):
            if d >= report_start:
                start_i = i
                break

    ma, dev = deviation_series(closes, ma_period)

    # 阈值归一化：
    #   buy_dev  语义为「买入阈值」，正常是负数（-4 表示 dev <= -4% 买入）。
    #            兼容旧的正数写法（4 视为 -4）。
    #   sell_dev 语义为「卖出阈值」，正常是正数（5 表示 dev >= +5% 卖出）。
    #            若传入负数，取其绝对值。
    buy_thr = -abs(float(buy_dev)) if float(buy_dev) != 0 else -1e-9
    sell_thr = abs(float(sell_dev)) if float(sell_dev) != 0 else 1e-9

    cash = initial_capital
    shares = 0.0
    position = 0              # 0 空仓 / 1 持仓
    pending = None            # 待执行指令：'buy' / 'sell'
    trades = []               # 已平仓交易
    equity = []               # 每日净值
    markers = []              # 图表买卖点
    invest_ratio = 1.0 if full_position else 0.5

    total_fee = 0.0

    for i in range(n):
        d = dates[i]
        px_close = closes[i]

        # 起点之前只做均线预热，不交易
        if i < start_i:
            continue

        # ---- 1) 执行上一交易日收盘后产生的信号（次日开盘成交）
        if pending == "buy" and cash > 0:
            px = opens[i]
            budget = cash * invest_ratio
            qty = int(budget / px / 100) * 100          # A股最小 100 股
            if qty > 0:
                amount = qty * px
                fee = max(amount * fee_rate, min_fee)
                if amount + fee <= cash:
                    cash -= amount + fee
                    shares += qty
                    position = 1
                    total_fee += fee
                    markers.append({"date": d, "type": "buy", "price": px,
                                    "dev": dev[i], "qty": qty})
                    # 回填成交信息到这笔交易的持仓记录。
                    # buy_dev 保留【信号日】的偏离率（触发原因），另记成交日偏离率。
                    for t in reversed(trades):
                        if t["buy_date"] is None:
                            t["buy_date"] = d
                            t["buy_price"] = px
                            t["buy_fill_dev"] = dev[i]
                            t["qty"] = qty
                            t["fee"] = fee
                            t["_bidx"] = i
                            break
        elif pending == "sell" and shares > 0:
            px = opens[i]
            amount = shares * px
            fee = max(amount * fee_rate, min_fee)
            cash += amount - fee
            shares = 0.0
            position = 0
            total_fee += fee
            markers.append({"date": d, "type": "sell", "price": px,
                            "dev": dev[i], "qty": 0})
            for t in reversed(trades):
                if t["buy_date"] is not None and t["sell_date"] is None:
                    t["sell_date"] = d
                    t["sell_price"] = px
                    t["sell_fill_dev"] = dev[i]
                    t["fee"] += fee
                    t["pnl"] = (px - t["buy_price"]) / t["buy_price"] * 100.0
                    t["pnl_amount"] = (px - t["buy_price"]) * t["qty"] - t["fee"]
                    t["hold_days"] = i - t.pop("_bidx", i)
                    break
            pending = None

        # ---- 2) 记录当日净值
        equity.append(cash + shares * px_close)

        # ---- 3) 用当日收盘价计算偏离率，产生明日指令
        if dev[i] is None:
            pending = None
        elif position == 0:
            if dev[i] <= buy_thr:
                pending = "buy"
                # 占位：真正的成交价/数量在次日开盘成交时回填。
                # buy_dev 记录【信号日】偏离率，即触发本次买入的真实原因。
                trades.append({
                    "sig_date": d,
                    "buy_date": None, "buy_price": None, "buy_dev": dev[i],
                    "buy_fill_dev": None,
                    "qty": 0, "fee": 0.0, "sell_date": None,
                    "sig_sell_date": None,
                    "sell_price": None, "sell_dev": None, "sell_fill_dev": None,
                    "pnl": None, "pnl_amount": None, "hold_days": None,
                })
        else:
            if dev[i] >= sell_thr:
                pending = "sell"
                for t in reversed(trades):
                    if t["buy_date"] is not None and t["sell_date"] is None:
                        t["sig_sell_date"] = d
                        t["sell_dev"] = dev[i]
                        break

    # 剔除未成交的占位记录：若买入信号出现在最后一日之后无次日可成交
    trades = [t for t in trades if t["buy_date"] is not None]

    # 未平仓的持仓按最后一日收盘价结算（模拟持仓中）
    for t in trades:
        if t["buy_date"] is not None and t["sell_date"] is None:
            last_close = closes[-1]
            t["sell_date"] = dates[-1] + " (持有中)"
            t["sell_price"] = last_close
            t["sell_fill_dev"] = dev[-1]
            t["pnl"] = (last_close - t["buy_price"]) / t["buy_price"] * 100.0
            t["pnl_amount"] = (last_close - t["buy_price"]) * t["qty"] - t["fee"]
            t["hold_days"] = (n - 1) - t.get("_bidx", n - 1)
            t.pop("_bidx", None)

    # ---- 基准（买入持有），以回测起点归一
    bench_equity = [closes[i] / closes[start_i] * initial_capital
                    for i in range(n)]

    # ---- 统计窗口：equity 只记录 start_i 之后的部分，故下标从 0 开始
    cut = 0
    rep_dates = dates[start_i:]
    rep_equity = equity[cut:]
    rep_bench = bench_equity[start_i:]
    rep_dev = dev[start_i:]
    rep_ma = ma[start_i:]
    rep_closes = closes[start_i:]

    # 回测已在 start_i 起算，此处无成交早于窗口起点
    rep_fee = sum(t.get("fee") or 0.0 for t in trades)
    rep_trades = trades
    rep_markers = markers

    metrics = compute_metrics(rep_equity, rep_bench, rep_trades,
                              initial_capital, rep_fee, rep_dates)

    # ---- 偏离率统计
    valid_dev = [x for x in rep_dev if x is not None]
    max_dev = max(valid_dev) if valid_dev else None
    min_dev = min(valid_dev) if valid_dev else None
    max_dev_date = rep_dates[rep_dev.index(max_dev)] if valid_dev else None
    min_dev_date = rep_dates[rep_dev.index(min_dev)] if valid_dev else None

    return {
        "ok": True,
        "dates": rep_dates,
        "closes": rep_closes,
        "ma": rep_ma,
        "dev": rep_dev,
        "equity": rep_equity,
        "bench_equity": rep_bench,
        "markers": rep_markers,
        "trades": rep_trades,
        "metrics": metrics,
        "dev_stats": {
            "current": rep_dev[-1],
            "max": max_dev, "max_date": max_dev_date,
            "min": min_dev, "min_date": min_dev_date,
            "avg": sum(valid_dev) / len(valid_dev) if valid_dev else None,
        },
        "final_state": {"holding": bool(shares > 0), "shares": shares,
                        "cash": cash},
    }


# ---------------------------------------------------------------- 绩效指标
def max_drawdown(equity):
    """最大回撤（%，正数表示回撤幅度）。"""
    peak = equity[0] if equity else 0
    mdd = 0.0
    for v in equity:
        if v > peak:
            peak = v
        if peak > 0:
            dd = (peak - v) / peak * 100.0
            if dd > mdd:
                mdd = dd
    return mdd


def compute_metrics(equity, bench_equity, trades, initial_capital,
                    total_fee, dates):
    n = len(equity)
    total_ret = (equity[-1] / initial_capital - 1) * 100.0
    bench_ret = (bench_equity[-1] / initial_capital - 1) * 100.0

    # 年化：按实际自然日跨度
    days = 1
    try:
        from datetime import date as _d
        y0, m0, dd0 = map(int, dates[0].split("-"))
        y1, m1, dd1 = map(int, dates[-1].split("-"))
        days = max((_d(y1, m1, dd1) - _d(y0, m0, dd0)).days, 1)
    except Exception:
        days = n
    years = max(days / 365.0, 1e-6)
    annual = ((equity[-1] / initial_capital) ** (1 / years) - 1) * 100.0
    bench_annual = ((bench_equity[-1] / initial_capital) ** (1 / years) - 1) * 100.0

    max_dd = max_drawdown(equity)
    bench_dd = max_drawdown(bench_equity)

    rets = []
    for i in range(1, n):
        if equity[i - 1] > 0:
            rets.append(equity[i] / equity[i - 1] - 1)
    vol = 0.0
    sharpe = 0.0
    if len(rets) > 1:
        mean = sum(rets) / len(rets)
        var = sum((x - mean) ** 2 for x in rets) / (len(rets) - 1)
        sd = math.sqrt(var)
        vol = sd * math.sqrt(252) * 100
        if sd > 0:
            sharpe = (mean * 252 - 0.02) / sd

    closed = [t for t in trades if t.get("pnl") is not None]
    wins = [t for t in closed if t["pnl"] > 0]
    win_rate = len(wins) / len(closed) * 100.0 if closed else None
    avg_win = sum(t["pnl"] for t in wins) / len(wins) if wins else None
    losses = [t for t in closed if t["pnl"] <= 0]
    avg_loss = sum(t["pnl"] for t in losses) / len(losses) if losses else None

    # 持仓占比
    holding_days = sum(1 for t in closed if t.get("hold_days", 0) > 0)
    exposure = min(holding_days / n * 100.0, 100.0) if n else 0.0

    profit_factor = None
    if closed:
        gp = sum(t["pnl_amount"] for t in closed if (t.get("pnl_amount") or 0) > 0)
        gl = abs(sum(t["pnl_amount"] for t in closed if (t.get("pnl_amount") or 0) < 0))
        if gl > 0:
            profit_factor = gp / gl

    return {
        "total_return": total_ret,
        "bench_return": bench_ret,
        "excess_return": total_ret - bench_ret,
        "annual_return": annual,
        "bench_annual_return": bench_annual,
        "max_drawdown": max_dd,
        "bench_max_drawdown": bench_dd,
        "volatility": vol,
        "sharpe": sharpe,
        "trade_count": len(closed),
        "win_rate": win_rate,
        "avg_win": avg_win,
        "avg_loss": avg_loss,
        "profit_factor": profit_factor,
        "total_fee": total_fee,
        "exposure": exposure,
        "final_value": equity[-1],
        "backtest_days": days,
        "years": years,
    }
