/* sync-web.js —— 把 web/ 目录同步到 Capacitor 的 www/
 *
 * App 内不运行 Python 后端，前端会自动切到内置 JS 引擎本地计算，
 * 因此只需要把静态资源拷贝过去即可。
 */
const fs = require('fs');
const path = require('path');

// scripts/ → android/ → 项目根 → etf-deviation-backtest/web
const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'etf-deviation-backtest', 'web');
const DST = path.join(ROOT, 'android', 'www');

// App 内不注册 Service Worker（Capacitor 用本地资源，无需离线缓存）
const SKIP = new Set(['sw.js']);

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (!SKIP.has(entry.name)) fs.copyFileSync(s, d);
  }
}

if (!fs.existsSync(SRC)) {
  console.error('找不到源目录：' + SRC);
  process.exit(1);
}

fs.rmSync(DST, { recursive: true, force: true });
copyDir(SRC, DST);

const files = fs.readdirSync(DST);
console.log('已同步 ' + files.length + ' 个文件到 www/');
files.forEach(f => console.log('  ' + f));
