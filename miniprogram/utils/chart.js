// utils/chart.js —— 图表引擎（小程序版）
//
// 基于网页版 web/chart.js 改造，关键差异：
//   1. 用 wx.createSelectorQuery().select('#id').fields({node:true,size:true})
//      拿 canvas 2d 节点，而不是 document.getElementById
//   2. 事件用 bindtouchstart/move/end，而不是 addEventListener
//   3. tooltip 不用 DOM，改用回调把内容交给页面 setData 渲染
//   4. 没有 ResizeObserver，改用 wx.onWindowResize
//
// 绘制逻辑（网格、刻度、阈值带、折线、买卖点、十字光标）与网页版保持一致。

const DPR_MAX = 3;   // 超过 3 倍屏比没必要，浪费内存

const C = {
  grid: 'rgba(255,255,255,0.055)',
  axis: 'rgba(255,255,255,0.16)',
  text: '#8b949e',
  textHi: '#e6edf3',
  up: '#f85149',        // 红涨
  down: '#2ea043',      // 绿跌
  accent: '#388bfd',
  ma: '#d9a441',
  bench: '#6e7681',
  cross: 'rgba(255,255,255,0.28)'
};

function niceTicks(min, max, count) {
  if (!isFinite(min) || !isFinite(max)) return [0];
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const step0 = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  let step;
  if (norm <= 1) step = 1;
  else if (norm <= 2) step = 2;
  else if (norm <= 2.5) step = 2.5;
  else if (norm <= 5) step = 5;
  else step = 10;
  step *= mag;
  const t0 = Math.ceil(min / step) * step;
  const out = [];
  for (let v = t0; v <= max + step * 0.001; v += step) out.push(v);
  return out.length ? out : [min, max];
}

function fmt(v, dec) {
  if (v == null || !isFinite(v)) return '--';
  return v.toFixed(dec == null ? 2 : dec);
}

/**
 * 图表实例
 * @param {string} canvasId  canvas 元素的 id
 * @param {object} opts
 *   - group      联动分组名（同组图表十字光标同步）
 *   - onTip      回调 function(info|null)
 */
class Chart {
  constructor(canvasId, opts) {
    this.canvasId = canvasId;
    this.o = Object.assign({
      padL: 8, padR: 62, padT: 12, padB: 24,
      yDec: 2, yPct: false,
      emptyText: '暂无数据',
      legend: null
    }, opts || {});
    this.data = { labels: [], series: [], markers: [], hlines: [], bands: [] };
    this.hover = -1;
    this.ready = false;
    this.canvas = null;
    this.ctx = null;
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    if (this.o.group) {
      Chart.groups[this.o.group] = Chart.groups[this.o.group] || [];
      Chart.groups[this.o.group].push(this);
    }
  }

  /** 异步初始化：拿到 canvas 2d 节点 */
  init() {
    return new Promise((resolve) => {
      const query = wx.createSelectorQuery().in(this);
      query.select('#' + this.canvasId)
        .fields({ node: true, size: true })
        .exec((res) => {
          const item = res && res[0];
          if (!item || !item.node) {
            console.error('[chart] 找不到 canvas 节点: #' + this.canvasId);
            resolve(false);
            return;
          }
          const canvas = item.node;
          const ctx = canvas.getContext('2d');
          const dpr = Math.min(wx.getSystemInfoSync().pixelRatio || 1, DPR_MAX);
          const w = item.width || 300;
          const h = item.height || 200;
          canvas.width = w * dpr;
          canvas.height = h * dpr;
          ctx.scale(dpr, dpr);
          this.canvas = canvas;
          this.ctx = ctx;
          this.w = w;
          this.h = h;
          this.dpr = dpr;
          this.ready = true;
          this.draw();
          resolve(true);
        });
    });
  }

  setData(d) {
    this.data = Object.assign(
      { labels: [], series: [], markers: [], hlines: [], bands: [] },
      d || {}
    );
    this.draw();
  }

  resize() {
    if (!this.ready) return;
    const query = wx.createSelectorQuery().in(this);
    query.select('#' + this.canvasId)
      .fields({ node: true, size: true })
      .exec((res) => {
        const item = res && res[0];
        if (!item || !item.node) return;
        const w = item.width || this.w;
        const h = item.height || this.h;
        if (w === this.w && h === this.h) { this.draw(); return; }
        this.canvas.width = w * this.dpr;
        this.canvas.height = h * this.dpr;
        this.ctx.scale(this.dpr, this.dpr);
        this.w = w;
        this.h = h;
        this.draw();
      });
  }

  // ------------------------------------------------------------ 坐标计算
  _geom() {
    const o = this.o;
    const g = {
      x0: o.padL, x1: this.w - o.padR,
      y0: o.padT, y1: this.h - o.padB
    };
    g.top = g.y0 + 4;
    g.bot = g.y1 - 4;
    g.iw = g.x1 - g.x0;
    g.ih = g.bot - g.top;

    const d = this.data;
    let mn = Infinity, mx = -Infinity;
    (d.series || []).forEach(function (s) {
      (s.data || []).forEach(function (v) {
        if (v == null || !isFinite(v)) return;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      });
    });
    (d.bands || []).forEach(function (b) {
      if (b.from != null && isFinite(b.from)) {
        if (b.from < mn) mn = b.from;
        if (b.from > mx) mx = b.from;
      }
    });
    if (!isFinite(mn) || !isFinite(mx)) { mn = 0; mx = 1; }
    if (mn === mx) { mn -= 1; mx += 1; }
    const pad = (mx - mn) * 0.08;
    g.mn = mn - pad;
    g.mx = mx + pad;
    g.n = (d.labels || []).length;
    return g;
  }

  _xAt(i, g) {
    if (g.n <= 1) return g.x0;
    return g.x0 + (i / (g.n - 1)) * g.iw;
  }

  _yAt(v, g) {
    if (g.mx === g.mn) return g.top;
    return g.bot - ((v - g.mn) / (g.mx - g.mn)) * g.ih;
  }

  _idxAt(px, g) {
    if (g.n <= 1) return -1;
    const r = (px - g.x0) / g.iw;
    let i = Math.round(r * (g.n - 1));
    if (i < 0) i = 0;
    if (i > g.n - 1) i = g.n - 1;
    return i;
  }

  // ------------------------------------------------------------ 绘制
  draw() {
    if (!this.ready || !this.ctx) return;
    const ctx = this.ctx;
    const g = this._geom();
    const d = this.data;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);

    if (!d.labels || !d.labels.length) {
      ctx.fillStyle = C.text;
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.o.emptyText, this.w / 2, this.h / 2);
      return;
    }

    // 阈值带
    (d.bands || []).forEach((b) => {
      if (b.from == null) return;
      const to = b.to == null ? g.mn : b.to;
      const y1 = this._yAt(b.from, g);
      const y2 = this._yAt(to, g);
      const top = Math.min(y1, y2);
      const bot = Math.max(y1, y2);
      ctx.fillStyle = b.color;
      ctx.fillRect(g.x0, top, g.x1 - g.x0, bot - top);
      if (b.label) {
        ctx.fillStyle = b.labelColor || 'rgba(255,255,255,0.4)';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(b.label, g.x0 + 6, top + 4);
      }
    });

    // 横向网格与刻度
    const ticks = niceTicks(g.mn, g.mx, 5);
    ctx.font = '11px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ticks.forEach((t) => {
      const y = this._yAt(t, g);
      if (y < g.top - 1 || y > g.bot + 1) return;
      ctx.strokeStyle = C.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(g.x0, y + 0.5);
      ctx.lineTo(g.x1, y + 0.5);
      ctx.stroke();
      ctx.fillStyle = C.text;
      ctx.fillText(fmt(t, this.o.yDec) + (this.o.yPct ? '%' : ''), g.x1 + 6, y);
    });

    // 横向基准线（阈值）
    (d.hlines || []).forEach((hl) => {
      if (hl.value == null || !isFinite(hl.value)) return;
      const y = this._yAt(hl.value, g);
      if (y < g.top || y > g.bot) return;
      ctx.save();
      ctx.strokeStyle = hl.color || C.cross;
      ctx.lineWidth = 1;
      if (hl.dash) ctx.setLineDash(hl.dash);
      ctx.beginPath();
      ctx.moveTo(g.x0, y + 0.5);
      ctx.lineTo(g.x1, y + 0.5);
      ctx.stroke();
      ctx.restore();
    });

    // 折线 / 面积
    (d.series || []).forEach((s) => {
      const arr = s.data || [];
      if (!arr.length) return;
      if (s.area) {
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < arr.length; i++) {
          const v = arr[i];
          if (v == null || !isFinite(v)) { started = false; continue; }
          const x = this._xAt(i, g);
          const y = this._yAt(v, g);
          if (!started) { ctx.moveTo(x, g.bot); ctx.lineTo(x, y); started = true; }
          else ctx.lineTo(x, y);
        }
        ctx.lineTo(this._xAt(arr.length - 1, g), g.bot);
        ctx.closePath();
        ctx.fillStyle = s.fill || 'rgba(56,139,253,0.18)';
        ctx.fill();
      }
      ctx.save();
      ctx.strokeStyle = s.color || C.accent;
      ctx.lineWidth = s.width || 1.8;
      if (s.dash) ctx.setLineDash(s.dash);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (v == null || !isFinite(v)) { started = false; continue; }
        const x = this._xAt(i, g);
        const y = this._yAt(v, g);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    });

    // 买卖点
    (d.markers || []).forEach((m) => {
      if (m.index == null) return;
      const x = this._xAt(m.index, g);
      const s = (d.series || [])[0];
      const v = s && s.data ? s.data[m.index] : null;
      const y = (v == null || !isFinite(v)) ? g.bot : this._yAt(v, g);
      ctx.fillStyle = m.type === 'buy' ? C.down : C.up;
      ctx.beginPath();
      ctx.arc(x, y, 3.2, 0, Math.PI * 2);
      ctx.fill();
    });

    // 十字光标
    if (this.hover >= 0 && this.hover < g.n) {
      const x = this._xAt(this.hover, g);
      ctx.save();
      ctx.strokeStyle = C.cross;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, g.top);
      ctx.lineTo(x + 0.5, g.bot);
      ctx.stroke();
      ctx.restore();
    }
  }

  // ------------------------------------------------------------ 交互
  onTouchStart(e) {
    if (!this.ready) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    this._sx = t.clientX;
    this._sy = t.clientY;
    this._locked = null;
    this._move(e);
  }

  onTouchMove(e) {
    if (!this.ready) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    if (this._locked === null) {
      const dx = t.clientX - this._sx;
      const dy = t.clientY - this._sy;
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      // 横向意图才接管手势，纵向滑动留给页面滚动
      this._locked = Math.abs(dx) > Math.abs(dy);
      if (!this._locked) { this._leave(); return; }
    }
    this._move(e);
  }

  onTouchEnd() {
    this._leave();
  }

  _move(e) {
    const t = e.touches && e.touches[0];
    if (!t) return;
    const g = this._geom();
    const px = t.clientX - (this._rect ? this._rect.left : 0);
    const idx = this._idxAt(px, g);
    if (idx < 0) return;
    this.hover = idx;
    // 联动同组
    (Chart.groups[this.o.group] || []).forEach((c) => {
      if (c !== this) { c.hover = idx; c.draw(); }
    });
    this.draw();
    if (this.o.onTip) {
      this.o.onTip(this._tipInfo(idx, px, g));
    }
  }

  _leave() {
    this.hover = -1;
    (Chart.groups[this.o.group] || []).forEach((c) => { c.hover = -1; c.draw(); });
    if (this.o.onTip) this.o.onTip(null);
  }

  _tipInfo(idx, px, g) {
    const d = this.data;
    const rows = [];
    (d.series || []).forEach((s) => {
      const v = s.data ? s.data[idx] : null;
      const suffix = (s.yPct != null ? (s.yPct ? '%' : '') : (this.o.yPct ? '%' : ''));
      const val = (v == null || !isFinite(v)) ? '--' : fmt(v, s.dec != null ? s.dec : this.o.yDec) + suffix;
      rows.push([s.name, val]);
    });
    return {
      x: this._xAt(idx, g),
      y: g.top,
      date: d.labels[idx],
      rows: rows,
      sig: this._sigAt(idx)
    };
  }

  _sigAt(idx) {
    const d = this.data;
    const s = (d.series || [])[0];
    const v = s && s.data ? s.data[idx] : null;
    if (v == null || !isFinite(v)) return '';
    const buy = d.buyThr, sell = d.sellThr;
    if (buy != null && v <= buy) return 'buy';
    if (sell != null && v >= sell) return 'sell';
    return '';
  }
}

Chart.groups = {};
Chart.colors = C;
Chart.fmt = fmt;

module.exports = Chart;
