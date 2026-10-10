/* chart.js —— 轻量 Canvas 图表引擎（零依赖，支持折线/面积/标记/阈值带/十字光标/多图联动） */
(function (global) {
  'use strict';

  var DPR = global.devicePixelRatio || 1;

  var C = {
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
    var step0 = (max - min) / (count || 5);
    var mag = Math.pow(10, Math.floor(Math.log10(step0)));
    var norm = step0 / mag, step;
    if (norm <= 1) step = 1;
    else if (norm <= 2) step = 2;
    else if (norm <= 2.5) step = 2.5;
    else if (norm <= 5) step = 5;
    else step = 10;
    step *= mag;
    var s = Math.floor(min / step) * step, e = Math.ceil(max / step) * step, out = [];
    for (var v = s; v <= e + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    return out;
  }

  function fmt(v, d) {
    if (v == null || !isFinite(v)) return '--';
    return v.toFixed(d == null ? 2 : d);
  }

  function Chart(canvas, opts) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.o = Object.assign({
      padL: 8, padR: 62, padT: 12, padB: 24,
      yDec: 2, yPct: false,
      emptyText: '暂无数据',
      legend: null
    }, opts || {});
    this.wrap = canvas.parentElement;
    this.tip = this.wrap.querySelector('.ctip');
    this.data = { labels: [], series: [], markers: [], hlines: [] };
    this.hover = -1;
    this._bind();
    var self = this;
    if (global.ResizeObserver) {
      this._ro = new ResizeObserver(function () { self.draw(); });
      this._ro.observe(this.wrap);
    } else {
      global.addEventListener('resize', function () { self.draw(); });
    }
    Chart.group.forEach(function (g) { if (g && g !== self && g.o.group === self.o.group) g._peer = true; });
    if (this.o.group) {
      if (!Chart.groups[this.o.group]) Chart.groups[this.o.group] = [];
      Chart.groups[this.o.group].push(this);
    }
  }

  Chart.groups = {};
  Chart.group = [];
  Chart.instances = [];

  Chart.prototype.setData = function (d) {
    this.data = Object.assign({ labels: [], series: [], markers: [], hlines: [], bands: [] }, d || {});
    this.computeRange();
    this.draw();
    if (this.o.onRender) this.o.onRender(this);
  };

  Chart.prototype.computeRange = function () {
    var lo = Infinity, hi = -Infinity, i, s, j, v;
    var ds = this.data.series || [];
    for (i = 0; i < ds.length; i++) {
      s = ds[i].data || [];
      for (j = 0; j < s.length; j++) { v = s[j]; if (v != null && isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    }
    (this.data.hlines || []).forEach(function (h) {
      if (h.value != null && isFinite(h.value)) { if (h.value < lo) lo = h.value; if (h.value > hi) hi = h.value; }
    });
    (this.data.markers || []).forEach(function (m) {
      if (m.price != null && isFinite(m.price)) { if (m.price < lo) lo = m.price; if (m.price > hi) hi = m.price; }
    });
    (this.data.bands || []).forEach(function (b) {
      [b.from, b.to].forEach(function (x) {
        if (x != null && isFinite(x)) { if (x < lo) lo = x; if (x > hi) hi = x; }
      });
    });
    if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
    if (lo === hi) { lo -= 1; hi += 1; }
    var pad = (hi - lo) * 0.10;
    this.lo = lo - pad; this.hi = hi + pad;
    this.ticks = niceTicks(this.lo, this.hi, 5);
    this.lo = Math.min(this.lo, this.ticks[0]);
    this.hi = Math.max(this.hi, this.ticks[this.ticks.length - 1]);
  };

  Chart.prototype._geom = function () {
    var w = this.cv.clientWidth, h = this.cv.clientHeight, o = this.o;
    var x0 = o.padL, x1 = w - o.padR, y0 = o.padT, y1 = h - o.padB;
    var n = this.data.labels.length;
    var self = this;
    return {
      w: w, h: h, x0: x0, x1: x1, y0: y0, y1: y1, n: n,
      px: function (i) { return n <= 1 ? (x0 + x1) / 2 : x0 + (x1 - x0) * (i / (n - 1)); },
      py: function (v) { return y1 - (y1 - y0) * ((v - self.lo) / (self.hi - self.lo)); },
      ix: function (px) { return n <= 1 ? 0 : Math.round((px - x0) / (x1 - x0) * (n - 1)); }
    };
  };

  Chart.prototype.draw = function () {
    var cv = this.cv, ctx = this.ctx;
    var w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    cv.width = Math.round(w * DPR); cv.height = Math.round(h * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (!this.data.labels.length) {
      ctx.fillStyle = C.text; ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(this.o.emptyText, w / 2, h / 2);
      return;
    }

    var g = this._geom(), self = this, o = this.o;
    var t, i, j, v;

    // ---- 阈值带
    (this.data.bands || []).forEach(function (b) {
      if (b.from == null || b.to == null) return;
      var yA = g.py(b.from), yB = g.py(b.to);
      var top = Math.min(yA, yB), bot = Math.max(yA, yB);
      ctx.fillStyle = b.color;
      ctx.fillRect(g.x0, top, g.x1 - g.x0, bot - top);
      if (b.label) {
        ctx.fillStyle = b.labelColor || 'rgba(255,255,255,0.4)';
        ctx.font = '11px system-ui, sans-serif';
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText(b.label, g.x0 + 6, top + 4);
      }
    });

    // ---- 横向网格 + Y 轴
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (i = 0; i < this.ticks.length; i++) {
      t = this.ticks[i];
      var y = g.py(t);
      if (y < g.y0 - 1 || y > g.y1 + 1) continue;
      ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(g.x0, y + 0.5); ctx.lineTo(g.x1, y + 0.5); ctx.stroke();
      ctx.fillStyle = C.text;
      ctx.fillText(o.yPct ? fmt(t, o.yDec) + '%' : fmt(t, o.yDec), g.x1 + 7, y);
    }

    // ---- X 轴日期
    var step = Math.max(1, Math.ceil(g.n / 7));
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = C.text;
    for (i = 0; i < g.n; i += step) {
      var lbl = self.data.labels[i] || '';
      ctx.fillText(lbl.length > 10 ? lbl.slice(2) : lbl, g.px(i), g.y1 + 6);
    }

    // ---- 阈值参考线
    (this.data.hlines || []).forEach(function (hl) {
      if (hl.value == null) return;
      var yy = g.py(hl.value);
      if (yy < g.y0 || yy > g.y1) return;
      ctx.save();
      ctx.strokeStyle = hl.color; ctx.lineWidth = 1;
      ctx.setLineDash(hl.dash || [4, 4]);
      ctx.beginPath(); ctx.moveTo(g.x0, yy + 0.5); ctx.lineTo(g.x1, yy + 0.5); ctx.stroke();
      ctx.restore();
    });

    // ---- 面积 + 折线
    var ss = this.data.series || [];
    for (i = 0; i < ss.length; i++) {
      var s = ss[i], dat = s.data || [];
      if (s.area) {
        var grad = ctx.createLinearGradient(0, g.y0, 0, g.y1);
        grad.addColorStop(0, s.fill || 'rgba(56,139,253,0.22)');
        grad.addColorStop(1, 'rgba(56,139,253,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        var started = false, base = g.y1;
        for (j = 0; j < dat.length; j++) {
          v = dat[j];
          if (v == null || !isFinite(v)) { continue; }
          if (!started) { ctx.moveTo(g.px(j), base); started = true; }
          ctx.lineTo(g.px(j), g.py(v));
        }
        if (started) { ctx.lineTo(g.px(dat.length - 1), base); ctx.closePath(); ctx.fill(); }
      }
      ctx.strokeStyle = s.color || C.accent;
      ctx.lineWidth = s.width || 1.5;
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      if (s.dash) ctx.setLineDash(s.dash); else ctx.setLineDash([]);
      ctx.beginPath();
      var st = false;
      for (j = 0; j < dat.length; j++) {
        v = dat[j];
        if (v == null || !isFinite(v)) { st = false; continue; }
        var px = g.px(j), py = g.py(v);
        if (!st) { ctx.moveTo(px, py); st = true; } else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (s.dotLast) {
        for (j = dat.length - 1; j >= 0; j--) {
          if (dat[j] != null && isFinite(dat[j])) {
            ctx.fillStyle = s.color; ctx.beginPath();
            ctx.arc(g.px(j), g.py(dat[j]), 3, 0, Math.PI * 2); ctx.fill();
            break;
          }
        }
      }
    }

    // ---- 买卖标记
    (this.data.markers || []).forEach(function (m) {
      var idx = m.index;
      if (idx == null || idx < 0 || idx >= g.n) return;
      var x = g.px(idx);
      var y = g.py(m.type === 'sell' ? m.highY : m.lowY != null ? m.lowY : m.price);
      if (m.type === 'sell') y = Math.max(g.y0 + 6, y - 2);
      else y = Math.min(g.y1 - 6, y + 2);
      ctx.fillStyle = m.type === 'sell' ? C.down : C.up;
      ctx.strokeStyle = '#0d1117'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (m.type === 'sell') {
        ctx.moveTo(x, y + 7); ctx.lineTo(x - 5.5, y - 4); ctx.lineTo(x + 5.5, y - 4);
      } else {
        ctx.moveTo(x, y - 7); ctx.lineTo(x - 5.5, y + 4); ctx.lineTo(x + 5.5, y + 4);
      }
      ctx.closePath(); ctx.fill(); ctx.stroke();
    });

    // ---- 十字光标
    if (this.hover >= 0 && this.hover < g.n) {
      var hx = g.px(this.hover);
      ctx.strokeStyle = C.cross; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(hx + 0.5, g.y0); ctx.lineTo(hx + 0.5, g.y1); ctx.stroke();
      ctx.setLineDash([]);
      for (i = 0; i < ss.length; i++) {
        var hv = (ss[i].data || [])[this.hover];
        if (hv == null || !isFinite(hv)) continue;
        ctx.fillStyle = ss[i].color || C.accent;
        ctx.strokeStyle = '#0d1117'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(hx, g.py(hv), 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }

    // ---- 最新值标签
    if (this.o.showLast && ss.length) {
      for (i = 0; i < ss.length; i++) {
        if (!ss[i].showLast) continue;
        var ld = ss[i].data || [], lv = null;
        for (j = ld.length - 1; j >= 0; j--) if (ld[j] != null && isFinite(ld[j])) { lv = ld[j]; break; }
        if (lv == null) continue;
        var ly = g.py(lv);
        if (ly < g.y0 || ly > g.y1) continue;
        var txt = (o.yPct ? fmt(lv, o.yDec) + '%' : fmt(lv, o.yDec));
        ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
        var tw = ctx.measureText(txt).width + 10;
        ctx.fillStyle = ss[i].color || C.accent;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(g.x1 + 3, ly - 8, tw, 16, 3);
        else ctx.rect(g.x1 + 3, ly - 8, tw, 16);
        ctx.fill();
        ctx.fillStyle = '#0d1117';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(txt, g.x1 + 8, ly);
      }
    }
  };

  Chart.prototype._bind = function () {
    var self = this;
    function coords(ev) {
      var r = self.cv.getBoundingClientRect();
      var t = ev.touches && ev.touches[0] ? ev.touches[0]
        : ev.changedTouches && ev.changedTouches[0] ? ev.changedTouches[0] : ev;
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    }
    function move(ev) {
      var p = coords(ev);
      if (p.x < self.o.padL - 10 || p.x > self.cv.clientWidth - self.o.padR + 10) return self._leave();
      var g = self._geom();
      var idx = Math.max(0, Math.min(g.n - 1, g.ix(p.x)));
      if (idx === self.hover) return;
      self.hover = idx;
      // 联动同组其他图
      var grp = Chart.groups[self.o.group] || [];
      grp.forEach(function (c) { if (c !== self) { c.hover = idx; c.draw(); } });
      self.draw();
      self._tip(idx, p.x, p.y);
    }
    function leave() { self._leave(); }

    self.cv.addEventListener('mousemove', move);
    self.cv.addEventListener('mouseleave', leave);

    // 触摸：仅横向拖动时阻止页面滚动，纵向滑动仍可正常翻页
    var sx = 0, sy = 0, locked = null;
    self.cv.addEventListener('touchstart', function (ev) {
      if (!ev.touches[0]) return;
      sx = ev.touches[0].clientX; sy = ev.touches[0].clientY; locked = null;
    }, { passive: true });
    self.cv.addEventListener('touchmove', function (ev) {
      if (!ev.touches[0]) return;
      var dx = ev.touches[0].clientX - sx, dy = ev.touches[0].clientY - sy;
      if (locked === null) {
        // 首次移动后判定方向：横向意图才接管手势
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        locked = Math.abs(dx) > Math.abs(dy);
        if (locked) { try { ev.preventDefault(); } catch (e) { } }
        else { self._leave(); return; }
      }
      if (locked) { try { ev.preventDefault(); } catch (e) { } move(ev); }
    }, { passive: false });
    self.cv.addEventListener('touchend', leave);
    self.cv.addEventListener('touchcancel', leave);
  };

  Chart.prototype._leave = function () {
    this.hover = -1;
    (Chart.groups[this.o.group] || []).forEach(function (c) { c.hover = -1; c.draw(); });
    if (this.tip) this.tip.style.display = 'none';
  };

  Chart.prototype._tip = function (idx, cx, cy) {
    var tip = this.tip;
    if (!tip) return;
    var rows = '';
    if (this.o.tooltip) rows = this.o.tooltip(idx);
    else {
      rows = '<div class="tt-d">' + (this.data.labels[idx] || '') + '</div>';
      (this.data.series || []).forEach(function (s) {
        var v = (s.data || [])[idx];
        rows += '<div class="tt-r"><span><i style="background:' + s.color + '"></i>' + s.name + '</span><b>' +
          (v == null || !isFinite(v) ? '--' : fmt(v, this.o.yDec) + (this.o.yPct ? '%' : '')) + '</b></div>';
      }, this);
    }
    tip.innerHTML = rows;
    tip.style.display = 'block';
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var pw = this.cv.clientWidth, ph = this.cv.clientHeight;
    var left = cx + 14;
    if (left + w > pw - 4) left = cx - w - 14;
    if (left < 4) left = 4;
    if (left + w > pw - 4) left = Math.max(4, pw - w - 4);   // 窄屏兜底：贴右边界
    var top = Math.max(4, Math.min(cy - h / 2, ph - h - 4));
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  };

  global.Chart = Chart;
  global.ChartColors = C;
  global.chartFmt = fmt;
})(window);
