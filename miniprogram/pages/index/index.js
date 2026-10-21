// pages/index/index.js —— 回测主页面
//
// 流程：选标的 → 调参数 → 取行情 → 本地算回测 → 渲染指标与图表
// 数据流：后端 /api/kline（取行情） → utils/backtest.js（本地计算）
//         引擎在小程序内跑，不依赖后端的回测接口，节省一次往返。

const app = getApp();
const req = require('../../utils/request.js');
const data = require('../../utils/data.js');
const Backtest = require('../../utils/backtest.js');
const Chart = require('../../utils/chart.js');

function today() {
  const d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function yearsAgo(y) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - y);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

Page({
  data: {
    loading: false,
    loadingText: '加载中',
    symbols: [],
    symbolIndex: 0,

    // 参数
    maPeriod: 20,
    buyDev: -4,
    sellDev: 5,
    capital: 100000,
    feeRate: 0.05,
    fullPosition: true,
    rangeYears: 1,
    startDate: '',
    endDate: '',

    // 结果
    hasResult: false,
    kpis: [],
    metricRows: [],
    warnings: [],
    windowLabel: '',

    // 图表 tooltip
    tip: null,
    tipVisible: false
  },

  onLoad() {
    const saved = app.globalData.savedParams;
    const d = this.data;
    this.setData({
      startDate: yearsAgo(d.rangeYears),
      endDate: today(),
      maPeriod: saved ? saved.maPeriod : d.maPeriod,
      buyDev: saved ? saved.buyDev : d.buyDev,
      sellDev: saved ? saved.sellDev : d.sellDev,
      capital: saved ? saved.capital : d.capital,
      feeRate: saved ? saved.feeRate : d.feeRate,
      fullPosition: saved ? saved.fullPosition : d.fullPosition
    });

    this.charts = [];
    this._loadSymbols();
  },

  onReady() {
    this._initCharts();
    this._resizeHandler = () => {
      (this.charts || []).forEach(c => c.resize());
    };
    wx.onWindowResize(this._resizeHandler);
  },

  onUnload() {
    try { wx.offWindowResize(this._resizeHandler); } catch (e) { /* 忽略 */ }
  },

  // ------------------------------------------------------------ 数据
  _loadSymbols() {
    data.loadSymbols().then((list) => {
      this.setData({ symbols: list });
    }).catch(() => {
      wx.showToast({ title: '标的加载失败', icon: 'none' });
    });
  },

  _initCharts() {
    const self = this;
    const tipHandler = (info) => {
      if (!info) {
        self.setData({ tipVisible: false, tip: null });
        return;
      }
      self.setData({
        tipVisible: true,
        tip: {
          x: info.x, y: info.y,
          date: info.date,
          rows: info.rows,
          sig: info.sig
        }
      });
    };

    const mk = (id, opts) => {
      const c = new Chart(id, Object.assign({ onTip: tipHandler }, opts || {}));
      c.init();
      self.charts.push(c);
      return c;
    };

    mk('chartDev', { group: 'main', yPct: true, yDec: 2, padR: 70 });
    mk('chartPx', { group: 'main', yDec: 2, padR: 70 });
    mk('chartEq', { group: 'main', yPct: true, yDec: 1, padR: 70 });
  },

  // ------------------------------------------------------------ 交互
  onSymbolChange(e) {
    this.setData({ symbolIndex: parseInt(e.detail.value, 10) });
  },

  onMaChange(e) {
    this.setData({ maPeriod: e.detail.value });
  },
  onBuyChange(e) {
    this.setData({ buyDev: e.detail.value });
  },
  onSellChange(e) {
    this.setData({ sellDev: e.detail.value });
  },
  onCapitalChange(e) {
    this.setData({ capital: e.detail.value });
  },
  onFeeChange(e) {
    this.setData({ feeRate: e.detail.value });
  },

  onRangeTap(e) {
    const y = parseInt(e.currentTarget.dataset.y, 10);
    this.setData({
      rangeYears: y,
      startDate: y === 0 ? '2013-01-01' : yearsAgo(y),
      endDate: today()
    });
  },

  onPosTap(e) {
    this.setData({ fullPosition: e.currentTarget.dataset.v === '1' });
  },

  /** 买入滑块（负区间） */
  onBuySlider(e) {
    let v = e.detail.value;
    if (v > 0) v = -v;
    this.setData({ buyDev: v });
  },
  /** 买入数字框：输入正数自动转负 */
  onBuyInput(e) {
    let v = parseFloat(e.detail.value);
    if (!isFinite(v) || v === 0) v = -4;
    if (v > 0) v = -v;
    this.setData({ buyDev: v });
  },
  /** 卖出数字框：输入负数自动转正 */
  onSellInput(e) {
    let v = parseFloat(e.detail.value);
    if (!isFinite(v) || v === 0) v = 5;
    if (v < 0) v = -v;
    this.setData({ sellDev: v });
  },

  // ------------------------------------------------------------ 回测
  run() {
    if (this._running) return;
    this._running = true;
    this.setData({ loading: true, loadingText: '获取行情' });

    const sym = this.data.symbols[this.data.symbolIndex];
    if (!sym) {
      this._running = false;
      this.setData({ loading: false });
      wx.showToast({ title: '请先选择标的', icon: 'none' });
      return;
    }

    const p = {
      code: sym.code,
      market: sym.market,
      ma_period: parseInt(this.data.maPeriod, 10) || 20,
      buy_dev: -Math.abs(parseFloat(this.data.buyDev) || -4),
      sell_dev: Math.abs(parseFloat(this.data.sellDev) || 5),
      capital: parseFloat(this.data.capital) || 100000,
      fee_rate: (parseFloat(this.data.feeRate) || 0) / 100,
      full_position: this.data.fullPosition,
      start: this.data.startDate,
      end: this.data.endDate
    };

    data.loadKline(p.code, p.market)
      .then((bars) => {
        this.setData({ loadingText: '计算回测' });
        // 均线预热：向前多取一段，统计时再裁掉
        const pad = Math.floor(p.ma_period * 1.6) + 30;
        let si = 0;
        for (let i = 0; i < bars.length; i++) {
          if (bars[i].date >= p.start) { si = i; break; }
        }
        si = Math.max(0, si - pad);
        let ei = bars.length;
        for (let j = 0; j < bars.length; j++) {
          if (bars[j].date > p.end) { ei = j; break; }
        }
        const win = bars.slice(si, ei);
        if (win.length < 3) throw new Error('所选区间内数据不足');

        const r = Backtest.runBacktest(win, {
          ma_period: p.ma_period,
          buy_dev: p.buy_dev,
          sell_dev: p.sell_dev,
          capital: p.capital,
          fee_rate: p.fee_rate,
          full_position: p.full_position,
          report_start: p.start
        });
        if (r.error) throw new Error(r.error);

        r.symbol = sym;
        r.params = p;
        this._render(r);

        app.globalData.lastResult = r;
        app.globalData.lastParams = p;
        try {
          wx.setStorageSync('dev_params', {
            maPeriod: p.ma_period, buyDev: p.buy_dev, sellDev: p.sell_dev,
            capital: p.capital, feeRate: p.fee_rate * 100, fullPosition: p.full_position
          });
        } catch (e) { /* 忽略 */ }
      })
      .catch((e) => {
        wx.showModal({
          title: '回测失败',
          content: req.friendlyError(e),
          showCancel: false
        });
      })
      .then(() => {
        this._running = false;
        this.setData({ loading: false });
      });
  },

  // ------------------------------------------------------------ 渲染
  _render(r) {
    const m = r.metrics;
    const s = r.dev_stats;
    const p = r.params;

    const sign = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
    const pct = (v, dec) => (v == null || !isFinite(v)
      ? '--'
      : (v > 0 ? '+' : '') + v.toFixed(dec == null ? 2 : dec) + '%');

    const kpis = [
      { label: '当前偏离率', value: pct(s.current), sub: m.final_value ? '期末 ' + Math.round(m.final_value).toLocaleString() : '', cls: sign(s.current) },
      { label: '区间最大偏离', value: pct(s.max), sub: s.max_date || '', cls: sign(s.max) },
      { label: '区间最小偏离', value: pct(s.min), sub: s.min_date || '', cls: sign(s.min) },
      { label: '策略收益', value: pct(m.total_return), sub: '基准 ' + pct(m.bench_return), cls: sign(m.total_return) }
    ];

    const metricRows = [
      ['超额收益', pct(m.excess_return), sign(m.excess_return)],
      ['年化收益', pct(m.annual_return), sign(m.annual_return)],
      ['基准年化', pct(m.bench_annual_return), sign(m.bench_annual_return)],
      ['最大回撤', pct(-m.max_drawdown), 'down'],
      ['年化波动', pct(m.volatility, 2), 'flat'],
      ['夏普比率', m.sharpe == null ? '--' : m.sharpe.toFixed(2), sign(m.sharpe)],
      ['交易次数', m.trade_count + ' 笔', 'flat'],
      ['胜率', m.win_rate == null ? '--' : m.win_rate.toFixed(1) + '%', 'flat'],
      ['盈亏比', m.profit_factor == null ? '--' : m.profit_factor.toFixed(2), 'flat'],
      ['平均盈利', pct(m.avg_win), 'up'],
      ['平均亏损', pct(m.avg_loss), 'down'],
      ['累计手续费', Math.round(m.total_fee).toLocaleString() + ' 元', 'flat']
    ];

    const warnings = [];
    if (r.dates.length < 60) {
      warnings.push('回测区间仅 ' + r.dates.length + ' 个交易日，样本偏少，指标参考意义有限');
    }
    if (m.trade_count === 0) {
      warnings.push('该参数下未触发任何买卖信号，可适当放宽偏离率阈值');
    }

    this.setData({
      hasResult: true,
      kpis: kpis,
      metricRows: metricRows,
      warnings: warnings,
      windowLabel: r.dates[0] + ' ~ ' + r.dates[r.dates.length - 1] + '（' + r.dates.length + ' 个交易日）'
    });

    this._renderCharts(r);
  },

  _renderCharts(r) {
    if (!this.charts || !this.charts.length) return;
    const p = r.params;
    const buy = p.buy_dev;
    const sell = p.sell_dev;

    // 标记索引
    const idxMap = {};
    r.dates.forEach((dt, i) => { idxMap[dt] = i; });
    const markers = (r.markers || []).map((m) => {
      return { index: idxMap[m.date], type: m.type, price: m.price, dev: m.dev, date: m.date };
    }).filter((m) => { return m.index != null; });

    const devBands = [
      {
        from: buy, to: null,
        color: 'rgba(46,160,67,0.10)',
        label: '买入区 ≤ ' + buy + '%',
        labelColor: 'rgba(46,160,67,0.6)'
      },
      {
        from: sell, to: null,
        color: 'rgba(248,81,73,0.10)',
        label: '卖出区 ≥ +' + sell + '%',
        labelColor: 'rgba(248,81,73,0.6)'
      }
    ];
    const devVals = r.dev.filter((v) => { return v != null; });
    if (devVals.length) {
      devBands[0].to = Math.max(Math.min.apply(null, devVals), buy - 1);
      devBands[1].to = Math.max.apply(null, devVals) + 1;
    }

    this.charts[0].setData({
      labels: r.dates,
      series: [
        { name: '偏离率', data: r.dev, color: '#388bfd', width: 1.8, area: true, fill: 'rgba(56,139,253,0.18)' },
        { name: p.ma_period + '日均线', data: r.ma, color: '#d9a441', width: 1.4, dash: [4, 3] }
      ],
      bands: devBands,
      hlines: [
        { value: buy, color: 'rgba(46,160,67,0.55)', dash: [5, 4] },
        { value: sell, color: 'rgba(248,81,73,0.55)', dash: [5, 4] }
      ],
      markers: markers,
      buyThr: buy,
      sellThr: sell
    });

    this.charts[1].setData({
      labels: r.dates,
      series: [
        { name: '收盘价', data: r.closes, color: '#e6edf3', width: 1.8 },
        { name: p.ma_period + '日均线', data: r.ma, color: '#d9a441', width: 1.4, dash: [4, 3] }
      ],
      bands: [],
      hlines: [],
      markers: markers,
      buyThr: buy,
      sellThr: sell
    });

    this.charts[2].setData({
      labels: r.dates,
      series: [
        { name: '策略净值', data: r.equity, color: '#f85149', width: 1.8 },
        { name: '基准净值', data: r.bench_equity, color: '#6e7681', width: 1.4, dash: [4, 3] }
      ],
      bands: [],
      hlines: [],
      markers: [],
      buyThr: buy,
      sellThr: sell
    });
  },

  // ------------------------------------------------------------ 图表触摸
  onChartTouchStart(e) {
    const c = (this.charts || [])[Number(e.currentTarget.dataset.id)];
    if (c) c.onTouchStart(e);
  },
  onChartTouchMove(e) {
    const c = (this.charts || [])[Number(e.currentTarget.dataset.id)];
    if (c) c.onTouchMove(e);
  },
  onChartTouchEnd(e) {
    const c = (this.charts || [])[Number(e.currentTarget.dataset.id)];
    if (c) c.onTouchEnd(e);
  }
});
