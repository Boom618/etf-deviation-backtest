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
    { code: '600900', market: 1, name: '长江电力', cat: '个股' }
  ];

  function findSymbol(code) {
    for (var i = 0; i < SYMBOLS.length; i++) if (SYMBOLS[i].code === code) return SYMBOLS[i];
    return null;
  }

  // 按代码段推断交易所。1 = 上交所，0 = 深交所。
  // 与后端 data_source.guess_market 规则一致。
  var SH_PREFIX = ['600', '601', '603', '605', '688', '689', '900', '730', '780', '787'];
  var SZ_PREFIX = ['000', '001', '002', '003', '300', '301', '200', '159', '160', '161',
    '162', '163', '164', '165', '166', '167', '168', '169', '170', '171'];

  function guessMarket(code) {
    var c = String(code || '').trim();
    if (c.length !== 6 || !/^\d{6}$/.test(c)) return null;
    var p3 = c.slice(0, 3);
    if (SH_PREFIX.indexOf(p3) >= 0) return 1;
    if (SZ_PREFIX.indexOf(p3) >= 0) return 0;
    if (c[0] === '5') return 1;   // 沪市 ETF / LOF
    if (c[0] === '1') return 0;   // 深市 ETF / LOF
    if (c.slice(0, 2) === '39') return 0;   // 深证指数
    return null;
  }

  // 解析用户输入的代码，支持 600519 / sh600519 / 600519.sh
  function parseCode(raw) {
    var m = String(raw || '').trim().toLowerCase()
      .match(/^(sh|sz)?(\d{6})(\.(sh|sz))?$/);
    return m ? m[2] : null;
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

  // ---------------------------------------------------------------- 名称查询
  // 腾讯的 qt 接口是 GBK 编码，WebView 里用 TextDecoder('gbk') 不一定可靠，
  // 所以 App 内直连场景改用东财的实时行情接口：UTF-8 且直接给出代码与名称。
  var EM_QUOTE = 'https://push2.eastmoney.com/api/qt/stock/get';

  function fetchName(code, market) {
    var secid = market + '.' + code;
    var url = EM_QUOTE + '?secid=' + secid +
      '&fields=f57,f58,f107,f43,f169,f170';
    return fetch(url, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var d = j && j.data;
        if (!d || !d.f58) return null;
        // 校验代码一致，避免取到别的标的
        if (String(d.f57) !== String(code)) return null;
        return String(d.f58);
      })
      .catch(function () { return null; });
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
  // 返回 { bars, name, market }
  function loadKline(code, market) {
    return fetch('/api/kline?code=' + encodeURIComponent(code) + '&market=' + market)
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok && j.bars && j.bars.length) {
          return {
            bars: dropInvalid(j.bars),
            name: j.name || null,
            market: (j.market == null ? guessMarket(code) : j.market)
          };
        }
        throw new Error('proxy miss');
      })
      .catch(function () {
        // 直连路径（App 内无后端）：另外查一次名称
        return fetchKline(code, market).then(function (bars) {
          var known = findSymbol(code);
          if (known) return { bars: bars, name: known.name, market: known.market };
          return fetchName(code, market).then(function (nm) {
            return { bars: bars, name: nm, market: market };
          });
        });
      });
  }

  global.DataSource = {
    SYMBOLS: SYMBOLS,
    findSymbol: findSymbol,
    guessMarket: guessMarket,
    parseCode: parseCode,
    loadKline: loadKline,
    fetchKline: fetchKline,
    fetchName: fetchName,
    dropInvalid: dropInvalid
  };
})(window);
