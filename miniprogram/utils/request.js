// utils/request.js —— 网络请求封装
//
// 小程序与网页版的关键差异：
//   1. 没有 fetch，用 wx.request
//   2. 只能请求「服务器域名白名单」里的域名，所以行情必须经后端中转
//   3. 开发者工具可在「详情 → 本地设置」勾选「不校验合法域名」来联调
//   4. 域名必须 HTTPS 且已备案

const app = getApp();

/**
 * 发起请求
 * @param {string} path  接口路径，如 '/api/kline'
 * @param {object} data  查询参数
 * @param {object} opt   { method, timeout }
 * @returns {Promise<any>} 响应体
 */
function request(path, data, opt) {
  opt = opt || {};
  const cfg = app.globalData.config;

  // 显式拼接 query string，不依赖 wx.request 自动拼接 data 的行为
  let url = cfg.baseUrl + path;
  const qs = [];
  Object.keys(data || {}).forEach(function (k) {
    const v = data[k];
    if (v === undefined || v === null || v === '') return;
    qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  });
  if (qs.length) url += (url.indexOf('?') >= 0 ? '&' : '?') + qs.join('&');

  return new Promise((resolve, reject) => {
    wx.request({
      url: url,
      data: data || {},
      method: opt.method || 'GET',
      timeout: opt.timeout || 20000,
      header: {
        'Content-Type': 'application/json'
      },
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else {
          reject(new Error('HTTP ' + res.statusCode));
        }
      },
      fail(err) {
        // errMsg 常见值：
        //   request:fail url not in domain list -> 域名未加入白名单
        //   request:fail timeout                -> 超时
        //   request:fail ssl hand shake error   -> 证书问题
        const msg = (err && err.errMsg) || '网络异常';
        reject(new Error(msg));
      }
    });
  });
}

/** 错误提示：把微信的 errMsg 翻译成人话 */
function friendlyError(err) {
  const raw = (err && err.message) || String(err);
  if (raw.indexOf('not in domain list') >= 0) {
    return '接口域名未加入小程序白名单（开发时可在「本地设置」勾选不校验域名）';
  }
  if (raw.indexOf('timeout') >= 0) return '请求超时，请检查网络或后端服务';
  if (raw.indexOf('ssl') >= 0) return 'HTTPS 证书校验失败';
  if (raw.indexOf('ECONNREFUSED') >= 0 || raw.indexOf('fail ') >= 0) {
    return '连不上后端服务，请确认地址与后端已启动';
  }
  return raw;
}

/** 本地缓存读取（带过期判断） */
function cacheGet(key) {
  try {
    const item = wx.getStorageSync('cache_' + key);
    if (!item || !item.t) return null;
    const age = (Date.now() - item.t) / 1000;
    if (age > app.globalData.config.cacheAge) return null;
    return item.d;
  } catch (e) {
    return null;
  }
}

/** 本地缓存写入 */
function cacheSet(key, data) {
  try {
    wx.setStorageSync('cache_' + key, { t: Date.now(), d: data });
  } catch (e) { /* 存储满了就算了 */ }
}

module.exports = {
  request: request,
  friendlyError: friendlyError,
  cacheGet: cacheGet,
  cacheSet: cacheSet
};
