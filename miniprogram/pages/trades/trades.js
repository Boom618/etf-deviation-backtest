// pages/trades/trades.js —— 成交明细

const app = getApp();

function pct(v) {
  if (v == null || !isFinite(v)) return '--';
  return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
}

Page({
  data: {
    hasResult: false,
    symbolName: '',
    windowLabel: '',
    trades: [],
    summary: null
  },

  onLoad() {
    this._render();
  },

  onShow() {
    // 从回测页返回时刷新
    this._render();
  },

  _render() {
    const r = app.globalData.lastResult;
    if (!r || !r.trades) {
      this.setData({ hasResult: false, trades: [] });
      return;
    }

    const closed = r.trades.filter(t => t.pnl != null);
    const wins = closed.filter(t => t.pnl > 0);

    const trades = r.trades.map((t, i) => {
      const holding = String(t.sell_date || '').indexOf('持有中') >= 0;
      return {
        no: i + 1,
        sigDate: t.sig_date,
        buyDate: t.buy_date,
        buyPrice: t.buy_price == null ? '--' : t.buy_price.toFixed(3),
        buyDev: pct(t.buy_dev),
        sellDate: t.sell_date || '--',
        sellPrice: t.sell_price == null ? '--' : t.sell_price.toFixed(3),
        sellDev: t.sell_dev == null ? '--' : pct(t.sell_dev),
        holdDays: t.hold_days == null ? '--' : t.hold_days,
        pnl: pct(t.pnl),
        pnlCls: t.pnl == null ? 'flat' : (t.pnl > 0 ? 'up' : t.pnl < 0 ? 'down' : 'flat'),
        holding: holding
      };
    });

    const summary = {
      count: closed.length,
      winRate: closed.length ? (wins.length / closed.length * 100).toFixed(1) + '%' : '--',
      totalFee: Math.round(r.metrics.total_fee).toLocaleString()
    };

    this.setData({
      hasResult: true,
      symbolName: r.symbol ? r.symbol.name : '',
      windowLabel: r.dates[0] + ' ~ ' + r.dates[r.dates.length - 1],
      trades: trades,
      summary: summary
    });
  }
});
