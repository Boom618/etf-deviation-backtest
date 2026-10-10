/* app.js —— 界面逻辑与后端交互 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var C = window.ChartColors;
  var fmt = window.chartFmt;

  var chDev, chPx, chEq, DATA = null, TIMER = null;

  // -------------------------------------------------- 工具
  function pct(v, d) { return v == null || !isFinite(v) ? '--' : v.toFixed(d == null ? 2 : d) + '%'; }
  function spct(v, d) {
    if (v == null || !isFinite(v)) return '--';
    return (v > 0 ? '+' : '') + v.toFixed(d == null ? 2 : d) + '%';
  }
  function money(v) {
    if (v == null || !isFinite(v)) return '--';
    return Math.round(v).toLocaleString('en-US');
  }
  function cls(v, rev) {
    if (v == null || !isFinite(v) || v === 0) return '';
    var pos = rev ? v < 0 : v > 0;
    return pos ? 'up' : 'down';
  }
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg; t.classList.add('on');
    clearTimeout(t._tm); t._tm = setTimeout(function () { t.classList.remove('on'); }, 3800);
  }
  function loading(on) { $('loading').classList.toggle('on', !!on); }

  function today() { return new Date().toISOString().slice(0, 10); }
  function yearsAgo(y) {
    var d = new Date(); d.setFullYear(d.getFullYear() - y);
    return d.toISOString().slice(0, 10);
  }

  // -------------------------------------------------- 初始化标的
  function initSymbols(list) {
    var sel = $('symbol'), groups = {};
    list.forEach(function (s) { (groups[s.cat || '其他'] = groups[s.cat || '其他'] || []).push(s); });
    sel.innerHTML = '';
    Object.keys(groups).forEach(function (cat) {
      var og = document.createElement('optgroup');
      og.label = cat;
      groups[cat].forEach(function (s) {
        var o = document.createElement('option');
        o.value = s.code;
        o.textContent = s.code + '  ' + s.name;
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
    sel.value = '510500';
  }

  // -------------------------------------------------- 双向绑定滑块 <-> 数字
  // negate=true 时用于买入偏离率：滑块为负区间，数字框输入正数会自动转负。
  function bindPair(rangeId, numId, negate) {
    var r = $(rangeId), n = $(numId);
    r.addEventListener('input', function () { n.value = r.value; });
    n.addEventListener('input', function () {
      var v = parseFloat(n.value);
      if (isFinite(v)) {
        if (negate && v > 0) { v = -v; n.value = v; }   // 保持买入为负数语义
        r.value = Math.max(parseFloat(r.min), Math.min(parseFloat(r.max), v));
      }
    });
  }

  // -------------------------------------------------- 读取参数
  // 买入偏离率为负数（-4 表示 dev <= -4% 买入），卖出为正数。
  // 归一化：买入若误填正数则自动取负，卖出若误填负数则取绝对值。
  function params() {
    var buy = parseFloat($('buy').value);
    var sell = parseFloat($('sell').value);
    if (!isFinite(buy) || buy === 0) buy = -4;
    if (!isFinite(sell) || sell === 0) sell = 5;
    return {
      code: $('symbol').value,
      start: $('start').value || '2015-01-01',
      end: $('end').value || today(),
      ma_period: parseInt($('ma').value, 10) || 20,
      buy_dev: -Math.abs(buy),
      sell_dev: Math.abs(sell),
      capital: parseFloat($('capital').value) || 100000,
      fee_rate: (parseFloat($('fee').value) || 0) / 100,
      full_position: $('posMode').querySelector('.on').dataset.v === '1'
    };
  }

  // -------------------------------------------------- 移动端抽屉
  function isMobile() { return window.matchMedia('(max-width: 1024px)').matches; }

  function openDrawer() {
    $('paramsPanel').classList.add('open');
    $('drawerMask').classList.add('on');
    document.body.style.overflow = 'hidden';
  }
  function closeDrawer() {
    $('paramsPanel').classList.remove('open');
    $('drawerMask').classList.remove('on');
    document.body.style.overflow = '';
  }

  // -------------------------------------------------- 事件绑定
  function bindEvents() {
    bindPair('maRange', 'ma');
    bindPair('buyRange', 'buy', true);      // 买入偏离率为负数区间
    bindPair('sellRange', 'sell');

    $('btnRun').addEventListener('click', run);
    $('btnRun2').addEventListener('click', function () { closeDrawer(); run(); });

    $('btnParams').addEventListener('click', openDrawer);
    $('btnParams2').addEventListener('click', openDrawer);
    $('btnCloseParams').addEventListener('click', closeDrawer);
    $('drawerMask').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDrawer();
    });
    // 从移动端切回桌面宽度时复位，避免面板停留在抽屉状态
    window.addEventListener('resize', function () {
      if (!isMobile()) closeDrawer();
      if (chDev) { chDev.draw(); chPx.draw(); chEq.draw(); }
    });

    $('posMode').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      this.querySelectorAll('button').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
    });

    $('rangeChips').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var y = parseInt(b.dataset.r, 10);
      $('start').value = y === 0 ? '2013-01-01' : yearsAgo(y);
      $('end').value = today();
      run();
    });

    document.querySelectorAll('.presets button').forEach(function (b) {
      b.addEventListener('click', function () {
        var p = this.dataset.p.split(',');
        $('ma').value = p[0]; $('maRange').value = p[0];
        $('buy').value = p[1]; $('buyRange').value = p[1];
        $('sell').value = p[2]; $('sellRange').value = p[2];
        closeDrawer();
        run();
      });
    });

    function refresh() {
      fetch('/api/clearcache', { method: 'POST' })
        .then(function () { toast('缓存已清除，正在重新拉取行情…'); return run(true); })
        .catch(function () { toast('清缓存失败，已尝试直接刷新'); run(true); });
    }
    $('btnRefresh').addEventListener('click', refresh);
    $('btnRefreshM').addEventListener('click', function () { closeDrawer(); refresh(); });

    $('symbol').addEventListener('change', function () { closeDrawer(); run(); });
    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') run();
    });
  }

  // -------------------------------------------------- 执行回测
  function run(force) {
    var p = params();
    loading(true);
    return fetch('/api/backtest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(force ? Object.assign({}, p, { _fresh: 1 }) : p)
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) throw new Error(d.error || '回测失败');
        loading(false);
        DATA = d;
        render(d);
      })
      .catch(function (err) {
        // 无后端环境（如 App 内运行）时，改用内置 JS 引擎本地计算
        return runLocal(p, err);
      });
  }

  // -------------------------------------------------- 本地计算（App / 无后端场景）
  function runLocal(p, apiErr) {
    if (!window.Backtest || !window.DataSource) {
      loading(false);
      toast('回测失败：' + (apiErr ? apiErr.message : '引擎未加载'));
      return Promise.resolve();
    }
    var sym = window.DataSource.findSymbol(p.code) || { code: p.code, market: 1, name: p.code };
    return window.DataSource.loadKline(p.code, sym.market)
      .then(function (bars) {
        // 均线预热：向前多取一段，统计时再裁掉
        var pad = Math.floor(p.ma_period * 1.6) + 30;
        var si = 0;
        for (var i = 0; i < bars.length; i++) {
          if (bars[i].date >= p.start) { si = i; break; }
        }
        si = Math.max(0, si - pad);
        var ei = bars.length;
        for (var j = 0; j < bars.length; j++) {
          if (bars[j].date > p.end) { ei = j; break; }
        }
        var win = bars.slice(si, ei);
        if (win.length < 3) throw new Error('所选区间内数据不足');

        var r = window.Backtest.runBacktest(win, {
          ma_period: p.ma_period, buy_dev: p.buy_dev, sell_dev: p.sell_dev,
          capital: p.capital, fee_rate: p.fee_rate,
          full_position: p.full_position, report_start: p.start
        });
        if (r.error) throw new Error(r.error);
        r.symbol = { code: sym.code, name: sym.name, market: sym.market };
        r.params = p;
        r.cached = true;
        r.source = 'local';
        r.warnings = [];
        if (r.dates.length < 60) {
          r.warnings.push('回测区间仅 ' + r.dates.length + ' 个交易日，样本偏少，指标参考意义有限');
        }
        if (r.metrics.trade_count === 0) {
          r.warnings.push('该参数下未触发任何买卖信号，可适当放宽偏离率阈值');
        }
        loading(false);
        DATA = r;
        render(r);
        return r;
      })
      .catch(function (e2) {
        loading(false);
        toast('无法获取行情数据：' + e2.message);
      });
  }

  // -------------------------------------------------- 渲染
  function render(d) {
    var s = d.dev_stats, m = d.metrics;

    $('symCode').textContent = d.symbol.code;
    $('symName').textContent = d.symbol.name;

    // KPI
    $('kCur').textContent = spct(s.current);
    $('kCur').className = 'k-val ' + cls(s.current);
    $('kCurSub').textContent = '相对 ' + d.params.ma_period + ' 日均线';

    $('kMax').textContent = spct(s.max);
    $('kMaxSub').textContent = s.max_date || '';
    $('kMin').textContent = spct(s.min);
    $('kMin').className = 'k-val down';
    $('kMinSub').textContent = s.min_date || '';

    $('kStrat').textContent = spct(m.total_return);
    $('kStrat').className = 'k-val ' + cls(m.total_return);
    $('kStratSub').textContent = '基准 ' + spct(m.bench_return) + ' · 超额 ' + spct(m.excess_return);

    renderMetrics(m, d);
    renderTrades(d);
    renderCharts(d);

    if (d.cached === false) toast('已拉取最新行情');
    if (d.warnings && d.warnings.length) toast(d.warnings[0]);
  }

  function renderMetrics(m, d) {
    var box = $('metrics');
    var items = [
      ['总收益率', spct(m.total_return), cls(m.total_return), ''],
      ['基准收益率', spct(m.bench_return), cls(m.bench_return), ''],
      ['超额收益', spct(m.excess_return), cls(m.excess_return), ''],
      ['年化收益', spct(m.annual_return), cls(m.annual_return), ''],
      ['最大回撤', pct(-m.max_drawdown), m.max_drawdown > 0 ? 'down' : '', ''],
      ['基准回撤', pct(-m.bench_max_drawdown), m.bench_max_drawdown > 0 ? 'down' : '', ''],
      ['夏普比率', fmt(m.sharpe), m.sharpe > 0 ? 'up' : 'down', ''],
      ['年化波动', pct(m.volatility), '', ''],
      ['交易次数', String(m.trade_count), '', '次'],
      ['胜率', m.win_rate == null ? '--' : m.win_rate.toFixed(1) + '%', '', ''],
      ['盈亏比', fmt(m.profit_factor), '', ''],
      ['平均盈利', m.avg_win == null ? '--' : m.avg_win.toFixed(2) + '%', 'up', ''],
      ['平均亏损', m.avg_loss == null ? '--' : m.avg_loss.toFixed(2) + '%', 'down', ''],
      ['持仓占比', pct(m.exposure, 1), '', ''],
      ['累计手续费', money(m.total_fee), '', '元'],
      ['期末净值', money(m.final_value), '', '元']
    ];
    box.innerHTML = items.map(function (it) {
      return '<div><label>' + it[0] + '</label><b class="' + it[2] + '">' + it[1] +
        (it[3] ? '<small>' + it[3] + '</small>' : '') + '</b></div>';
    }).join('');
  }

  function renderTrades(d) {
    var tb = $('tradeBody'), trs = d.trades || [];
    $('tradeCount').textContent = trs.length ? trs.length + ' 笔' : '';
    $('tradeEmpty').classList.toggle('on', trs.length === 0);

    tb.innerHTML = trs.map(function (t, i) {
      var pnl = t.pnl;
      var c = pnl > 0 ? 'pos' : (pnl < 0 ? 'neg' : '');
      return '<tr>' +
        '<td>' + (i + 1) + '</td>' +
        '<td>' + (t.sig_date || '--') + '</td>' +
        '<td>' + t.buy_date + '</td>' +
        '<td>' + fmt(t.buy_price, 3) + '</td>' +
        '<td>' + spct(t.buy_dev) + '</td>' +
        '<td>' + t.sell_date + '</td>' +
        '<td>' + fmt(t.sell_price, 3) + '</td>' +
        '<td>' + spct(t.sell_dev) + '</td>' +
        '<td>' + (t.hold_days == null ? '--' : t.hold_days) + '</td>' +
        '<td class="' + c + '">' + spct(pnl) + '</td>' +
        '<td class="' + c + '">' + (t.pnl_amount == null ? '--' : money(t.pnl_amount)) + '</td>' +
        '</tr>';
    }).join('');
  }

  function renderCharts(d) {
    var dates = d.dates, dev = d.dev, ma = d.ma, closes = d.closes;
    // buy 已是负数（-4），sell 为正数（5）
    var buy = d.params.buy_dev, sell = d.params.sell_dev;
    var n = dates.length;

    // 标记索引
    var idxMap = {};
    dates.forEach(function (dt, i) { idxMap[dt] = i; });
    var markers = (d.markers || []).map(function (m) {
      return { index: idxMap[m.date], type: m.type, price: m.price, dev: m.dev, date: m.date };
    }).filter(function (m) { return m.index != null; });

    // ---------- 图1：偏离率 ----------
    var buyTxt = buy.toFixed(buy % 1 === 0 ? 0 : 1);
    var sellTxt = sell.toFixed(sell % 1 === 0 ? 0 : 1);
    var devBands = [
      { from: buy, to: null, color: 'rgba(46,160,67,0.10)', label: '买入区 ≤ ' + buyTxt + '%', labelColor: 'rgba(46,160,67,0.6)' },
      { from: sell, to: null, color: 'rgba(248,81,73,0.10)', label: '卖出区 ≥ +' + sellTxt + '%', labelColor: 'rgba(248,81,73,0.6)' }
    ];
    // 补全区间终点
    var devVals = dev.filter(function (v) { return v != null; });
    var dmin = Math.min.apply(null, devVals), dmax = Math.max.apply(null, devVals);
    devBands[0].to = Math.max(dmin, buy - 1);
    devBands[1].to = dmax + 1;

    chDev.setData({
      labels: dates,
      series: [
        { name: '偏离率', data: dev, color: C.accent, width: 1.8, area: true, fill: 'rgba(56,139,253,0.18)', dotLast: true, showLast: true },
        { name: d.params.ma_period + '日均线', data: ma, color: C.ma, width: 1.4, dash: [4, 3] }
      ],
      bands: devBands,
      hlines: [
        { value: buy, color: 'rgba(46,160,67,0.55)', dash: [5, 4] },
        { value: sell, color: 'rgba(248,81,73,0.55)', dash: [5, 4] }
      ],
      markers: markers
    });

    // ---------- 图2：价格与均线 ----------
    chPx.setData({
      labels: dates,
      series: [
        { name: '收盘价', data: closes, color: '#c9d1d9', width: 1.6 },
        { name: d.params.ma_period + '日均线', data: ma, color: C.ma, width: 1.6, dash: [5, 3], showLast: true }
      ],
      markers: markers
    });

    // ---------- 图3：收益对比 ----------
    var init = d.params.capital;
    var eq = d.equity.map(function (v) { return v / init * 100; });
    var bq = d.bench_equity.map(function (v) { return v / init * 100; });
    chEq.setData({
      labels: dates,
      series: [
        { name: '策略净值', data: eq, color: C.accent, width: 1.9, dotLast: true, showLast: true },
        { name: '基准净值（买入持有）', data: bq, color: C.bench, width: 1.4, dotLast: true, showLast: true }
      ],
      hlines: [{ value: 100, color: 'rgba(255,255,255,0.22)', dash: [3, 4] }]
    });

    legend('devLegend', [
      ['偏离率', C.accent], [d.params.ma_period + '日均线', C.ma]
    ], [['买入区', 'rgba(46,160,67,0.55)', true], ['卖出区', 'rgba(248,81,73,0.55)', true]]);

    legend('pxLegend', [
      ['收盘价', '#c9d1d9'], ['均线 MA' + d.params.ma_period, C.ma]
    ], [['买入', C.up, false], ['卖出', C.down, false]]);

    legend('eqLegend', [
      ['策略净值', C.accent], ['基准净值', C.bench]
    ]);
  }

  function legend(id, lines, areas) {
    var el = $(id);
    var h = lines.map(function (l) {
      return '<span><i style="background:' + l[1] + '"></i>' + l[0] + '</span>';
    }).join('');
    (areas || []).forEach(function (a) {
      h += '<span><i class="sq" style="background:' + a[1] + '"></i>' + a[0] + '</span>';
    });
    el.innerHTML = h;
  }

  // -------------------------------------------------- 局域网地址 / 二维码
  function loadShareInfo() {
    var host = location.hostname;
    fetch('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: host })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok || !d.url) return;
        $('qrUrl').textContent = d.url;
        return fetch('/api/qr', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host: host })
        })
          .then(function (r) { return r.json(); })
          .then(function (q) {
            if (q.ok && q.svg) $('qrImg').innerHTML = q.svg;
          });
      })
      .catch(function () { /* 二维码失败不影响主功能 */ });
  }

  // -------------------------------------------------- 启动
  function init() {
    $('start').value = yearsAgo(5);
    $('end').value = today();

    registerSW();
    loadShareInfo();

    // 优先用服务端标的清单；无后端时回退到内置清单（App 场景）
    fetch('/api/symbols')
      .then(function (r) { return r.json(); })
      .then(function (d) { return d.symbols; })
      .catch(function () {
        return window.DataSource ? window.DataSource.SYMBOLS : [];
      })
      .then(function (list) {
        if (!list || !list.length) throw new Error('标的清单为空');
        initSymbols(list);
        initCharts();
        bindEvents();
        return run();
      })
      .catch(function (e) { toast('初始化失败：' + e.message); loading(false); });
  }

  // 注册 Service Worker：支持添加到手机主屏、断网时仍能打开界面
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'https:' && location.hostname !== 'localhost'
      && location.hostname !== '127.0.0.1') return;
    navigator.serviceWorker.register('sw.js').catch(function () { /* 静默失败，不影响使用 */ });
  }

  function initCharts() {
    var base = { group: 'main', showLast: true };
    chDev = new Chart($('chartDev'), Object.assign({}, base, {
      yPct: true, yDec: 1, padR: 66,
      tooltip: function (i) { return devTip(i); }
    }));
    chPx = new Chart($('chartPx'), Object.assign({}, base, {
      yDec: 3, padR: 66,
      tooltip: function (i) { return pxTip(i); }
    }));
    chEq = new Chart($('chartEq'), Object.assign({}, base, {
      yDec: 1, padR: 66,
      tooltip: function (i) { return eqTip(i); }
    }));
  }

  function devTip(i) {
    var d = DATA, s = d.dev[i];
    var sig = '';
    if (s != null) {
      if (s <= d.params.buy_dev) sig = '<div class="tt-sig" style="color:#2ea043">● 触发买入信号</div>';
      else if (s >= d.params.sell_dev) sig = '<div class="tt-sig" style="color:#f85149">● 触发卖出信号</div>';
    }
    return '<div class="tt-d">' + d.dates[i] + '</div>' +
      '<div class="tt-r"><span><i style="background:' + C.accent + '"></i>偏离率</span><b>' + spct(s) + '</b></div>' +
      '<div class="tt-r"><span><i style="background:' + C.ma + '"></i>均线</span><b>' + fmt(d.ma[i], 3) + '</b></div>' +
      sig;
  }
  function pxTip(i) {
    var d = DATA;
    return '<div class="tt-d">' + d.dates[i] + '</div>' +
      '<div class="tt-r"><span><i style="background:#c9d1d9"></i>收盘价</span><b>' + fmt(d.closes[i], 3) + '</b></div>' +
      '<div class="tt-r"><span><i style="background:' + C.ma + '"></i>均线</span><b>' + fmt(d.ma[i], 3) + '</b></div>';
  }
  function eqTip(i) {
    var d = DATA, init2 = d.params.capital;
    var sp = (d.equity[i] / init2 - 1) * 100, bp = (d.bench_equity[i] / init2 - 1) * 100;
    return '<div class="tt-d">' + d.dates[i] + '</div>' +
      '<div class="tt-r"><span><i style="background:' + C.accent + '"></i>策略</span><b style="color:' +
      (sp >= 0 ? C.up : C.down) + '">' + spct(sp) + '</b></div>' +
      '<div class="tt-r"><span><i style="background:' + C.bench + '"></i>基准</span><b>' + spct(bp) + '</b></div>';
  }

  document.addEventListener('DOMContentLoaded', init);
})();
