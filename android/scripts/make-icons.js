/* 由 web/icon-512.png 生成 Android 各密度启动图标 */
const fs = require('fs'), path = require('path'), zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'etf-deviation-backtest', 'web', 'icon-512.png');
const RES = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');

function readPNG(file) {
  const buf = fs.readFileSync(file);
  let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('仅支持 8bit，实际 ' + bitDepth);
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!ch) throw new Error('不支持的 colorType ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= ch) ? prev[x - ch] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, ch, data: out };
}

function writePNG(file, w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(td) >>> 0 : crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  function crc32(b) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < b.length; n++) {
      c = (crc ^ b[n]) & 0xff;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
  ]));
}

function resize(src, size) {
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = Math.floor(x * src.w / size), sy = Math.floor(y * src.h / size);
      const si = (sy * src.w + sx) * src.ch, di = (y * size + x) * 4;
      out[di] = src.data[si]; out[di + 1] = src.data[si + 1]; out[di + 2] = src.data[si + 2];
      out[di + 3] = src.ch === 4 ? src.data[si + 3] : 255;
    }
  }
  return out;
}

// 生成方形图标与圆形图标（圆形用简单圆形裁切）
const DENSITIES = [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]];
const img = readPNG(SRC);

for (const [d, size] of DENSITIES) {
  const square = resize(img, size);
  writePNG(path.join(RES, `mipmap-${d}`, 'ic_launcher.png'), size, size, square);

  const round = Buffer.from(square);
  const c = (size - 1) / 2, r = size / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = x - c, dy = y - c;
    if (Math.sqrt(dx * dx + dy * dy) > r) round[(y * size + x) * 4 + 3] = 0;
  }
  writePNG(path.join(RES, `mipmap-${d}`, 'ic_launcher_round.png'), size, size, round);
  console.log(`mipmap-${d}: ${size}x${size} 方形 + 圆形`);
}
