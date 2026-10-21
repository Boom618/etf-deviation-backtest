// app.js —— 小程序入口
//
// 后端地址在此配置。拿到自己的服务器后改成正式域名即可。
// 详见 docs/小程序接入说明.md

const CONFIG = {
  // 后端基地址。开发阶段可在开发者工具「详情 → 本地设置」勾选
  // 「不校验合法域名」来联调；正式发布必须是你已备案、已配 SSL、
  // 且已加入小程序后台「开发管理 → 服务器域名 → request 合法域名」的域名。
  baseUrl: 'https://your-domain.com',

  // 行情缓存有效期（秒）
  cacheAge: 1800
};

App({
  globalData: {
    config: CONFIG,
    // 最近一次回测结果，跨页共享（成交明细页会用到）
    lastResult: null,
    // 最近使用的参数
    lastParams: null
  },

  onLaunch: function () {
    const sys = wx.getSystemInfoSync();
    this.globalData.statusBarHeight = sys.statusBarHeight || 20;
    this.globalData.windowHeight = sys.windowHeight;
    this.globalData.windowWidth = sys.windowWidth;

    // 恢复上次参数
    try {
      const saved = wx.getStorageSync('dev_params');
      if (saved) this.globalData.savedParams = saved;
    } catch (e) { /* 忽略 */ }
  }
});
