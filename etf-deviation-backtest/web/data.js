/* data.js —— 行情数据源（浏览器 / App 内可用）
 * 主源：腾讯财经（前复权，分页）
 * 备源：东方财富
 * 说明：浏览器内直连第三方接口受 CORS 限制，故优先用服务端代理 /api/kline；
 *       在 App（Capacitor）中已通过原生网络层解决跨域，可直连。
 */
(function (global) {
  'use strict';

  var TX = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
  var EM = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';

  // 与 Python data_source.py 的 SYMBOLS 保持一致
  var SYMBOLS = [
    { code: '510500', market: 1, name: '中证500ETF(南方)', cat: '宽基ETF' },
    { code: '510300', market: 1, name: '沪深300ETF(华泰柏瑞)', cat: '宽基ETF' },
    { code: '510050', market: 1, name: '上证50ETF(华夏)', cat: '宽基ETF' },
    { code: '512100', market: 1, name: '中证1000ETF(南方)', cat: '宽基ETF' },
    { code: '159915', market: 0, name: '创业板ETF(易方达)', cat: '宽基ETF' },
    { code: '588000', market: 1, name: '科创50ETF(华夏)', cat: '宽基ETF' },
    { code: '512880', market: 1, name: '证券ETF(国泰)', cat: '行业ETF' },
    { code: '512690', market: 1, name: '酒ETF(鹏华)', cat: '行业ETF' },
    { code: '512170', market: 1, name: '医疗ETF(华宝)', cat: '行业ETF' },
    { code: '159928', market: 0, name: '消费ETF(汇添富)', cat: '行业ETF' },
    { code: '518880', market: 1, name: '黄金ETF(华安)', cat: '商品' },
    { code: '513100', market: 1, name: '纳指ETF(国泰)', cat: '海外' },
    { code: '513500', market: 1, name: '标普500ETF(博时)', cat: '海外' },
    { code: '000905', market: 1, name: '中证500指数', cat: '指数' },
    { code: '000300', market: 1, name: '沪深300指数', cat: '指数' },
    { code: '000001', market: 1, name: '上证指数', cat: '指数' },
    { code: '399006', market: 0, name: '创业板指', cat: '指数' },
    { code: '600900', market: 1, name: '长江电力', cat: '个股' }
  ];

  function findSymbol(code) {
    for (var i = 0; i < SYMBOLS.length; i++) if (SYMBOLS[i].code === code) return SYMBOLS[i];
    return null;
  }

  function prevDay(dateStr) {
    var d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  // ---------------------------------------------------------------- 腾讯
  function txSymbol(code, market) { return (market === 1 ? 'sh' : 'sz') + code; }

  function parseTencent(sym, j) {
    if (!j || j.code !== 0 || !j.data) return null;
    var node = j.data[sym];
    if (!node) return null;
    var rows = node.qfqday || node.day;
    if (!rows || !rows.length) return null;
    return rows.map(function (r) {
      return {
        date: r[0],
        open: +r[1], close: +r[2], high: +r[3], low: +r[4],
        volume: +r[5], amount: +r[5] * +r[2]
      };
    });
  }

  function fetchTencent(code, market, maxPages) {
    maxPages = maxPages || 12;
    var sym = txSymbol(code, market);
    var seen = {};
    var out = [];
    var end = '2099-12-31';

    function step(page) {
      if (page >= maxPages) return Promise.resolve(out);
      var url = TX + '?param=' + sym + ',day,1990-01-01,' + end + ',640,qfq';
      return fetch(url, { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var rows = parseTencent(sym, j);
          if (!rows) return out;
          var added = 0;
          rows.forEach(function (b) {
            if (!seen[b.date]) { seen[b.date] = 1; out.push(b); added++; }
          });
          if (rows.length < 640 || added === 0) return out;
          end = prevDay(rows[0].date);
          return step(page + 1);
        })
        .catch(function () { return out; });
    }
    return step(0).then(function (r) {
      return r.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    });
  }

  // ---------------------------------------------------------------- 东财（备源）
  function fetchEastmoney(code, market) {
    var secid = market + '.' + code;
    var url = EM + '?secid=' + secid +
      '&fields1=f1,f2,f3,f4,f5,f6' +
      '&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61' +
      '&klt=101&fqt=1&beg=19900101&end=20500101&lmt=100000';
    return fetch(url, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var d = j && j.data;
        if (!d || !d.klines) return [];
        return d.klines.map(function (line) {
          var p = line.split(',');
          return {
            date: p[0], open: +p[1], close: +p[2], high: +p[3], low: +p[4],
            volume: +p[5], amount: +p[7]
          };
        });
      })
      .catch(function () { return []; });
  }

  // ---------------------------------------------------------------- 统一入口
  // 剔除价格非正或非有限的 bar（高分红标的早期前复权价可能为负）
  function dropInvalid(bars) {
    return (bars || []).filter(function (b) {
      return ['open', 'close', 'high', 'low'].every(function (k) {
        var v = b[k];
        return typeof v === 'number' && isFinite(v) && v > 0;
      });
    });
  }

  function fetchKline(code, market) {
    return fetchTencent(code, market)
      .then(function (bars) {
        if (bars && bars.length >= 60) return dropInvalid(bars);
        return fetchEastmoney(code, market).then(function (b2) {
          if (b2 && b2.length >= 60) return dropInvalid(b2);
          throw new Error('未获取到 ' + code + ' 的行情数据');
        });
      });
  }

  // 优先服务端代理（浏览器场景），失败再直连（App 场景）
  function loadKline(code, market) {
    return fetch('/api/kline?code=' + encodeURIComponent(code) + '&market=' + market)
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok && j.bars && j.bars.length) return dropInvalid(j.bars);
        throw new Error('proxy miss');
      })
      .catch(function () { return fetchKline(code, market); });
  }

  global.DataSource = {
    SYMBOLS: SYMBOLS,
    findSymbol: findSymbol,
    loadKline: loadKline,
    fetchKline: fetchKline
  };
})(window);
