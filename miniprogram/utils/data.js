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
  { code: '600900', market: 1, name: '长江电力', cat: '个股' }
];

function findSymbol(code) {
  for (let i = 0; i < SYMBOLS.length; i++) {
    if (SYMBOLS[i].code === code) return SYMBOLS[i];
  }
  return null;
}

/**
 * 按代码段推断交易所。1 = 上交所，0 = 深交所。无法判断返回 null。
 * 与后端 data_source.guess_market 规则一致。
 */
function guessMarket(code) {
  const c = String(code || '').trim();
  if (c.length !== 6 || !/^\d{6}$/.test(c)) return null;
  const p3 = c.slice(0, 3);
  const SH = ['600', '601', '603', '605', '688', '689', '900', '730', '780', '787'];
  const SZ = ['000', '001', '002', '003', '300', '301', '200', '159', '160', '161',
    '162', '163', '164', '165', '166', '167', '168', '169', '170', '171'];
  if (SH.indexOf(p3) >= 0) return 1;
  if (SZ.indexOf(p3) >= 0) return 0;
  if (c[0] === '5') return 1;   // 沪市 ETF / LOF
  if (c[0] === '1') return 0;   // 深市 ETF / LOF
  if (c.slice(0, 2) === '39') return 0;   // 深证指数
  return null;
}

/** 解析用户输入的代码，支持 600519 / sh600519 / 600519.sh */
function parseCode(raw) {
  const m = String(raw || '').trim().toLowerCase()
    .match(/^(sh|sz)?(\d{6})(\.(sh|sz))?$/);
  return m ? m[2] : null;
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

/** 通过后端中转取行情（推荐路径）。返回 {bars, name, market} */
function fetchViaBackend(code, market) {
  return req.request('/api/kline', { code: code, market: market })
    .then(function (j) {
      if (j && j.ok && j.bars && j.bars.length) {
        return {
          bars: dropInvalid(j.bars),
          name: j.name || null,
          market: (j.market == null ? guessMarket(code) : j.market)
        };
      }
      throw new Error((j && j.error) || '后端未返回数据');
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
 * 返回 { bars, name, market }。
 */
function loadKline(code, market) {
  const cacheKey = 'k_' + code + '_' + (market == null ? 'auto' : market);
  const cached = req.cacheGet(cacheKey);
  if (cached) return Promise.resolve(cached);

  return fetchViaBackend(code, market)
    .then(function (res) {
      req.cacheSet(cacheKey, res);
      return res;
    })
    .catch(function () {
      const mk = (market == null ? guessMarket(code) : market);
      if (mk == null) throw new Error('无法识别 ' + code + ' 的交易所');
      return fetchDirect(code, mk).then(function (bars) {
        const res = { bars: bars, name: null, market: mk };
        req.cacheSet(cacheKey, res);
        return res;
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

/**
 * 直连查名称（后端不可用时的兜底）。
 * 用东财的实时行情接口：UTF-8 编码，WebView 里不用做 GBK 解码。
 */
function fetchName(code, market) {
  const url = 'https://push2.eastmoney.com/api/qt/stock/get' +
    '?secid=' + market + '.' + code +
    '&fields=f57,f58,f107,f43,f169,f170';
  return req.request(url, null, { method: 'GET' })
    .then(function (j) {
      const d = j && j.data;
      if (!d || !d.f58) return null;
      // 校验代码一致，避免取到别的标的
      if (String(d.f57) !== String(code)) return null;
      return String(d.f58);
    })
    .catch(function () { return null; });
}

/**
 * 查询任意代码：返回 { code, name, market }。
 * 后端 /api/kline 会按代码段推断交易所，并返回真实名称。
 */
function queryCode(raw) {
  const code = parseCode(raw);
  if (!code) return Promise.reject(new Error('代码格式不对，请输入 6 位数字'));

  // 清单内的代码：直接给名称与市场，行情走 loadKline（带缓存）
  const known = findSymbol(code);
  if (known) {
    return loadKline(code, known.market).then(function (res) {
      return {
        code: code,
        name: known.name,
        market: known.market,
        bars: res.bars || []
      };
    });
  }

  // 清单外：走后端，一次请求同时拿到名称、市场与行情
  return req.request('/api/kline', { code: code })
    .then(function (j) {
      if (!j || !j.ok) {
        throw new Error((j && j.error) || ('查不到 ' + code));
      }
      return {
        code: code,
        name: j.name || code,
        market: (j.market == null ? guessMarket(code) : j.market),
        bars: dropInvalid(j.bars || [])
      };
    })
    .catch(function (err) {
      // 后端不可用时尝试直连，至少确认代码存在
      const mk = guessMarket(code);
      if (mk == null) throw err;
      return fetchDirect(code, mk).then(function (bars) {
        if (!bars || bars.length < 60) {
          throw new Error('查不到 ' + code + ' 的行情数据');
        }
        return fetchName(code, mk).then(function (nm) {
          return { code: code, name: nm || code, market: mk, bars: bars };
        });
      });
    });
}

module.exports = {
  SYMBOLS: SYMBOLS,
  findSymbol: findSymbol,
  guessMarket: guessMarket,
  parseCode: parseCode,
  loadKline: loadKline,
  loadSymbols: loadSymbols,
  queryCode: queryCode,
  fetchName: fetchName,
  dropInvalid: dropInvalid
};
