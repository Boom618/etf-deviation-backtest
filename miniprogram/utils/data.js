// utils/data.js —— 行情数据源（小程序版）
//
// 与网页版 web/data.js 逻辑一致，区别只在网络层：
//   网页版：fetch → 直接请求腾讯/东财
//   小程序：wx.request → 必须先过后端中转（域名白名单限制）
//
// 数据源优先级：
//   1. 后端 /api/kline（后端自己去腾讯/东财抓）
//   2. 腾讯接口直连（仅开发者工具勾选「不校验合法域名」时可用）
//   3. 东财接口直连（同上）

const req = require('./request.js');

const TX = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
const EM = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';

// 标的清单（与后端 data_source.py 的 SYMBOLS 保持一致）
const SYMBOLS = [
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
  for (let i = 0; i < SYMBOLS.length; i++) {
    if (SYMBOLS[i].code === code) return SYMBOLS[i];
  }
  return null;
}

/** 剔除价格非正或非有限的 bar（高分红标的早期前复权价可能为负） */
function dropInvalid(bars) {
  return (bars || []).filter(function (b) {
    return ['open', 'close', 'high', 'low'].every(function (k) {
      const v = b[k];
      return typeof v === 'number' && isFinite(v) && v > 0;
    });
  });
}

function prevDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- 腾讯
function txSymbol(code, market) {
  return (market === 1 ? 'sh' : 'sz') + code;
}

function parseTencent(sym, j) {
  if (!j || j.code !== 0 || !j.data) return null;
  const node = j.data[sym];
  if (!node) return null;
  const rows = node.qfqday || node.day;
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
  const sym = txSymbol(code, market);
  const seen = {};
  const out = [];
  let end = '2099-12-31';

  function step(page) {
    if (page >= maxPages) return Promise.resolve(out);
    const url = TX + '?param=' + sym + ',day,1990-01-01,' + end + ',640,qfq';
    return req.request(url, null, { method: 'GET' })
      .then(function (j) {
        const rows = parseTencent(sym, j);
        if (!rows) return out;
        let added = 0;
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

// ---------------------------------------------------------------- 东财
function fetchEastmoney(code, market) {
  const secid = market + '.' + code;
  const url = EM + '?secid=' + secid +
    '&fields1=f1,f2,f3,f4,f5,f6' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61' +
    '&klt=101&fqt=1&beg=19900101&end=20500101&lmt=100000';
  return req.request(url, null, { method: 'GET' })
    .then(function (j) {
      const d = j && j.data;
      if (!d || !d.klines) return [];
      return d.klines.map(function (line) {
        const p = line.split(',');
        return {
          date: p[0], open: +p[1], close: +p[2], high: +p[3], low: +p[4],
          volume: +p[5], amount: +p[7]
        };
      });
    })
    .catch(function () { return []; });
}

// ---------------------------------------------------------------- 统一入口

/** 通过后端中转取行情（推荐路径） */
function fetchViaBackend(code, market) {
  return req.request('/api/kline', { code: code, market: market })
    .then(function (j) {
      if (j && j.ok && j.bars && j.bars.length) return dropInvalid(j.bars);
      throw new Error('后端未返回数据');
    });
}

/** 直连第三方（仅开发调试用） */
function fetchDirect(code, market) {
  return fetchTencent(code, market)
    .then(function (bars) {
      if (bars && bars.length >= 60) return dropInvalid(bars);
      return fetchEastmoney(code, market).then(function (b2) {
        if (b2 && b2.length >= 60) return dropInvalid(b2);
        throw new Error('未获取到 ' + code + ' 的行情数据');
      });
    });
}

/**
 * 取行情：先后端，后直连。
 * 后端可用时走后端（更快、有缓存）；后端不可用时尝试直连。
 */
function loadKline(code, market) {
  const cacheKey = 'k_' + code + '_' + market;
  const cached = req.cacheGet(cacheKey);
  if (cached) return Promise.resolve(cached);

  return fetchViaBackend(code, market)
    .then(function (bars) {
      req.cacheSet(cacheKey, bars);
      return bars;
    })
    .catch(function () {
      return fetchDirect(code, market).then(function (bars) {
        req.cacheSet(cacheKey, bars);
        return bars;
      });
    });
}

/** 取标的清单：后端优先，内置清单兜底 */
function loadSymbols() {
  return req.request('/api/symbols', null, { method: 'GET' })
    .then(function (j) {
      if (j && j.symbols && j.symbols.length) return j.symbols;
      return SYMBOLS;
    })
    .catch(function () { return SYMBOLS; });
}

module.exports = {
  SYMBOLS: SYMBOLS,
  findSymbol: findSymbol,
  loadKline: loadKline,
  loadSymbols: loadSymbols,
  dropInvalid: dropInvalid
};
