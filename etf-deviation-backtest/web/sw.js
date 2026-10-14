/* sw.js —— 离线壳缓存
 * 只缓存静态资源（HTML/CSS/JS/图标）。
 * 行情与回测接口一律走网络，避免显示过期行情造成误判。
 */
var CACHE = 'deviation-v2';
var SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './chart.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
      .catch(function () { /* 某个文件缺失不应阻断安装 */ })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.indexOf('/api/') === 0) return;   // 接口不缓存

  // 导航请求：网络优先，断网时回退到缓存的首页
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put('./index.html', copy); });
        return res;
      }).catch(function () {
        return caches.match('./index.html');
      })
    );
    return;
  }

  // 静态资源：网络优先 + 后台更新缓存。
  // 不用「缓存优先」——那会导致 app.js/chart.js 改动后长期不生效，
  // 用户反复刷新仍看到旧界面（尤其在「添加到主屏幕」的 PWA 里）。
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.status === 200 && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req);      // 断网时回退到缓存
    })
  );
});
