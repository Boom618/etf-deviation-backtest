/* backtest.js —— 均线偏离率回测引擎（与后端 backtest.py 逻辑一致）
 *
 * 信号定义（以收盘价计算，次日开盘成交，避免未来函数）：
 *     deviation = (close - MA) / MA * 100%
 *     deviation <= buy_dev    -> 买入（buy_dev 为负数，如 -4）
 *     deviation >= sell_dev   -> 卖出（sell_dev 为正数，如 5）
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- 指标
  function movingAverage(closes, period) {
    var ma = new Array(closes.length).fill(null);
    if (period <= 0) return ma;
    var run = 0;
    for (var i = 0; i < closes.length; i++) {
      run += closes[i];
      if (i >= period) run -= closes[i - period];
      if (i >= period - 1) ma[i] = run / period;
    }
    return ma;
  }

  function deviationSeries(closes, period) {
    var ma = movingAverage(closes, period);
    var dev = new Array(closes.length).fill(null);
    for (var i = 0; i < closes.length; i++) {
      if (ma[i] != null && ma[i] !== 0) dev[i] = (closes[i] - ma[i]) / ma[i] * 100;
    }
    return { ma: ma, dev: dev };
  }

  function maxDrawdown(equity) {
    if (!equity.length) return 0;
    var peak = equity[0], mdd = 0;
    for (var i = 0; i < equity.length; i++) {
      if (equity[i] > peak) peak = equity[i];
      if (peak > 0) {
        var dd = (peak - equity[i]) / peak * 100;
        if (dd > mdd) mdd = dd;
      }
    }
    return mdd;
  }

  function validTrades(trades) {
    return trades.filter(function (t) { return t.pnl != null; });
  }

  function computeMetrics(equity, bench, trades, capital, totalFee, dates) {
    var n = equity.length;
    var totalReturn = (equity[n - 1] / capital - 1) * 100;
    var benchReturn = (bench[n - 1] / capital - 1) * 100;

    // 年化：按自然日跨度
    var days = n;
    try {
      var a = new Date(dates[0] + 'T00:00:00Z');
      var b = new Date(dates[n - 1] + 'T00:00:00Z');
      days = Math.max(Math.round((b - a) / 86400000), 1);
    } catch (e) { days = n; }
    var years = Math.max(days / 365, 1e-6);
    var annual = (Math.pow(equity[n - 1] / capital, 1 / years) - 1) * 100;
    var benchAnnual = (Math.pow(bench[n - 1] / capital, 1 / years) - 1) * 100;

    // 日收益波动与夏普
    var rets = [];
    for (var i = 1; i < n; i++) {
      if (equity[i - 1] > 0) rets.push(equity[i] / equity[i - 1] - 1);
    }
    var vol = 0, sharpe = 0;
    if (rets.length > 1) {
      var mean = rets.reduce(function (s, x) { return s + x; }, 0) / rets.length;
      var varr = rets.reduce(function (s, x) { return s + (x - mean) * (x - mean); }, 0) / (rets.length - 1);
      var sd = Math.sqrt(varr);
      vol = sd * Math.sqrt(252) * 100;
      if (sd > 0) sharpe = (mean * 252 - 0.02) / sd;
    }

    var closed = validTrades(trades);
    var wins = closed.filter(function (t) { return t.pnl > 0; });
    var losses = closed.filter(function (t) { return t.pnl <= 0; });
    var winRate = closed.length ? wins.length / closed.length * 100 : null;
    var avgWin = wins.length ? wins.reduce(function (s, t) { return s + t.pnl; }, 0) / wins.length : null;
    var avgLoss = losses.length ? losses.reduce(function (s, t) { return s + t.pnl; }, 0) / losses.length : null;

    var profitFactor = null;
    if (closed.length) {
      var gp = closed.reduce(function (s, t) { return s + Math.max(t.pnl_amount || 0, 0); }, 0);
      var gl = closed.reduce(function (s, t) { return s + Math.max(-(t.pnl_amount || 0), 0); }, 0);
      if (gl > 0) profitFactor = gp / gl;
    }

    // 持仓占比：按交易区间覆盖的交易日估算
    var holdDays = {};
    closed.forEach(function (t) { if (t.hold_days > 0) holdDays[t.hold_days] = 1; });
    var exposure = Math.min(Object.keys(holdDays).length, n) / n * 100;

    return {
      total_return: totalReturn,
      bench_return: benchReturn,
      excess_return: totalReturn - benchReturn,
      annual_return: annual,
      bench_annual_return: benchAnnual,
      max_drawdown: maxDrawdown(equity),
      bench_max_drawdown: maxDrawdown(bench),
      volatility: vol,
      sharpe: sharpe,
      trade_count: closed.length,
      win_rate: winRate,
      avg_win: avgWin,
      avg_loss: avgLoss,
      profit_factor: profitFactor,
      total_fee: totalFee,
      exposure: exposure,
      final_value: equity[n - 1],
      backtest_days: days,
      years: years
    };
  }

  // ---------------------------------------------------------------- 回测
  function runBacktest(bars, opt) {
    opt = opt || {};
    var maPeriod = opt.ma_period || 20;
    var initialCapital = opt.capital || 100000;
    var feeRate = opt.fee_rate != null ? opt.fee_rate : 0.0005;
    var minFee = opt.min_fee != null ? opt.min_fee : 5;
    var fullPosition = opt.full_position !== false;

    if (!bars || bars.length < 2) return { error: '数据不足，无法回测' };

    var dates = bars.map(function (b) { return b.date; });
    var opens = bars.map(function (b) { return b.open; });
    var closes = bars.map(function (b) { return b.close; });
    var n = bars.length;

    var ds = deviationSeries(closes, maPeriod);
    var ma = ds.ma, dev = ds.dev;

    // 阈值归一化：买入为负、卖出为正，兼容旧的正数写法
    var buyRaw = parseFloat(opt.buy_dev);
    var sellRaw = parseFloat(opt.sell_dev);
    if (!isFinite(buyRaw) || buyRaw === 0) buyRaw = -4;
    if (!isFinite(sellRaw) || sellRaw === 0) sellRaw = 5;
    var buyThr = -Math.abs(buyRaw);
    var sellThr = Math.abs(sellRaw);

    var cash = initialCapital, shares = 0, position = 0, pending = null;
    var trades = [], equity = [], markers = [];
    var investRatio = fullPosition ? 1 : 0.5;

    for (var i = 0; i < n; i++) {
      var d = dates[i], pxClose = closes[i];

      // 1) 执行上一交易日收盘后产生的信号（次日开盘成交）
      if (pending === 'buy' && cash > 0) {
        var px = opens[i];
        var budget = cash * investRatio;
        var qty = Math.floor(budget / px / 100) * 100;
        if (qty > 0) {
          var amount = qty * px;
          var fee = Math.max(amount * feeRate, minFee);
          if (amount + fee <= cash) {
            cash -= amount + fee;
            shares += qty;
            position = 1;
            markers.push({ date: d, type: 'buy', price: px, dev: dev[i], qty: qty });
            for (var k = trades.length - 1; k >= 0; k--) {
              if (trades[k].buy_date == null) {
                trades[k].buy_date = d;
                trades[k].buy_price = px;
                trades[k].buy_fill_dev = dev[i];
                trades[k].qty = qty;
                trades[k].fee = fee;
                trades[k]._bidx = i;
                break;
              }
            }
          }
        }
      } else if (pending === 'sell' && shares > 0) {
        var pxs = opens[i];
        var amt = shares * pxs;
        var feeS = Math.max(amt * feeRate, minFee);
        cash += amt - feeS;
        shares = 0; position = 0;
        markers.push({ date: d, type: 'sell', price: pxs, dev: dev[i], qty: 0 });
        for (var k2 = trades.length - 1; k2 >= 0; k2--) {
          if (trades[k2].buy_date != null && trades[k2].sell_date == null) {
            trades[k2].sell_date = d;
            trades[k2].sell_price = pxs;
            trades[k2].sell_fill_dev = dev[i];
            trades[k2].fee += feeS;
            trades[k2].pnl = (pxs - trades[k2].buy_price) / trades[k2].buy_price * 100;
            trades[k2].pnl_amount = (pxs - trades[k2].buy_price) * trades[k2].qty - trades[k2].fee;
            trades[k2].hold_days = i - trades[k2]._bidx;
            break;
          }
        }
        pending = null;
      }

      // 2) 记录当日净值
      equity.push(cash + shares * pxClose);

      // 3) 用当日收盘价计算偏离率，产生明日指令
      if (dev[i] == null) {
        pending = null;
      } else if (position === 0) {
        if (dev[i] <= buyThr) {
          pending = 'buy';
          trades.push({
            sig_date: d, buy_date: null, buy_price: null, buy_dev: dev[i],
            buy_fill_dev: null, qty: 0, fee: 0, sell_date: null,
            sig_sell_date: null, sell_price: null, sell_dev: null,
            sell_fill_dev: null, pnl: null, pnl_amount: null, hold_days: null
          });
        }
      } else if (dev[i] >= sellThr) {
        pending = 'sell';
        for (var k3 = trades.length - 1; k3 >= 0; k3--) {
          if (trades[k3].buy_date != null && trades[k3].sell_date == null) {
            trades[k3].sig_sell_date = d;
            trades[k3].sell_dev = dev[i];
            break;
          }
        }
      }
    }

    // 未平仓持仓按最后一日收盘价结算
    for (var ti = 0; ti < trades.length; ti++) {
      var t = trades[ti];
      if (t.buy_date != null && t.sell_date == null) {
        var last = closes[n - 1];
        t.sell_date = dates[n - 1] + ' (持有中)';
        t.sell_price = last;
        t.sell_fill_dev = dev[n - 1];
        t.pnl = (last - t.buy_price) / t.buy_price * 100;
        t.pnl_amount = (last - t.buy_price) * t.qty - t.fee;
        t.hold_days = (n - 1) - (t._bidx != null ? t._bidx : n - 1);
      }
      delete t._bidx;
    }

    // 统计窗口：剔除均线预热用的前置数据
    var baseI = 0;
    if (opt.report_start) {
      for (var j = 0; j < n; j++) {
        if (dates[j] >= opt.report_start) { baseI = j; break; }
      }
    }
    var repDates = dates.slice(baseI);
    var repEquity = equity.slice(baseI);
    var repCloses = closes.slice(baseI);
    var repMa = ma.slice(baseI);
    var repDev = dev.slice(baseI);
    var repBench = closes.slice(baseI).map(function (c) { return c / closes[baseI] * initialCapital; });

    var from = opt.report_start || dates[0];
    var repTrades = trades.filter(function (t) { return t.buy_date && t.buy_date >= from; });
    var repMarkers = markers.filter(function (m) { return m.date >= from; });
    var repFee = repTrades.reduce(function (s, t) { return s + (t.fee || 0); }, 0);

    var metrics = computeMetrics(repEquity, repBench, repTrades, initialCapital, repFee, repDates);

    // 偏离率统计
    var valid = repDev.filter(function (v) { return v != null; });
    var maxDev = valid.length ? Math.max.apply(null, valid) : null;
    var minDev = valid.length ? Math.min.apply(null, valid) : null;
    return {
      ok: true,
      dates: repDates,
      closes: repCloses,
      ma: repMa,
      dev: repDev,
      equity: repEquity,
      bench_equity: repBench,
      markers: repMarkers,
      trades: repTrades,
      metrics: metrics,
      dev_stats: {
        current: repDev[repDev.length - 1],
        max: maxDev, max_date: maxDev == null ? null : repDates[repDev.indexOf(maxDev)],
        min: minDev, min_date: minDev == null ? null : repDates[repDev.indexOf(minDev)],
        avg: valid.length ? valid.reduce(function (s, v) { return s + v; }, 0) / valid.length : null
      },
      final_state: { holding: shares > 0, shares: shares, cash: cash }
    };
  }

  global.Backtest = {
    runBacktest: runBacktest,
    movingAverage: movingAverage,
    deviationSeries: deviationSeries,
    maxDrawdown: maxDrawdown
  };
})(window);
