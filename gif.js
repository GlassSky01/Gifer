/* gif.js — 自研 GIF89a 编码器 + 中位切分量化器
   零依赖，浏览器 / Node 通用。只实现本项目需要的子集：
     全局调色板(256) + 子矩形帧 + delay + 无限循环 + disposal=1(不处置)
   不需要：交错、局部调色板、透明、用户输入标志。 */
(function (root) {
  'use strict';

  /* ==================== 字节写入器 ==================== */
  function ByteWriter(cap) {
    this.buf = new Uint8Array(cap || 65536);
    this.len = 0;
  }
  ByteWriter.prototype._ensure = function (n) {
    if (this.len + n <= this.buf.length) return;
    var cap = this.buf.length;
    while (cap < this.len + n) cap *= 2;
    var nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  };
  ByteWriter.prototype.byte = function (b) {
    this._ensure(1); this.buf[this.len++] = b & 0xff;
  };
  ByteWriter.prototype.u16 = function (v) {
    this._ensure(2);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >> 8) & 0xff;
  };
  ByteWriter.prototype.bytes = function (a) {
    this._ensure(a.length); this.buf.set(a, this.len); this.len += a.length;
  };
  ByteWriter.prototype.ascii = function (s) {
    for (var i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
  };
  ByteWriter.prototype.result = function () {
    return this.buf.slice(0, this.len);
  };

  /* ==================== LZW 编码（GIF 变长码） ====================
     增长时机必须和 omggif 等成熟实现一致：先按当前 codeSize 发出前缀码，
     再判断 nextCode 是否越界并加宽。差一个码就会让解码器错位。 */
  function lzwEncode(pixels, minCodeSize) {
    var out = new ByteWriter(pixels.length >> 1);
    var clearCode = 1 << minCodeSize;
    var eoiCode = clearCode + 1;
    var codeMask = clearCode - 1;
    var codeSize = minCodeSize + 1;
    var nextCode = eoiCode + 1;
    var table = Object.create(null);
    var cur = 0, shift = 0;

    function emit(code) {
      cur |= code << shift;
      shift += codeSize;
      while (shift >= 8) {
        out.byte(cur & 0xff);
        cur >>= 8;
        shift -= 8;
      }
    }

    emit(clearCode);
    var ib = pixels[0] & codeMask;
    for (var i = 1; i < pixels.length; i++) {
      var k = pixels[i] & codeMask;
      var key = (ib << 8) | k;
      var code = table[key];
      if (code !== undefined) { ib = code; continue; }

      emit(ib);
      if (nextCode === 4096) {
        emit(clearCode);
        nextCode = eoiCode + 1;
        codeSize = minCodeSize + 1;
        table = Object.create(null);
      } else {
        if (nextCode >= (1 << codeSize)) codeSize++;
        table[key] = nextCode++;
      }
      ib = k;
    }
    emit(ib);
    emit(eoiCode);
    if (shift > 0) out.byte(cur & 0xff);
    return out.result();
  }

  /* ==================== GIF 容器 ====================
     frames: [{ x, y, w, h, delay, indices: Uint8Array(w*h) }]
     第一帧必须是整幅画布，用来确立全局调色板。 */
  function encode(opts) {
    var W = opts.width, H = opts.height;
    var palette = opts.palette, frames = opts.frames;
    var loop = (opts.loop === undefined) ? 0 : opts.loop;
    var minCodeSize = 8;

    var w = new ByteWriter(1024 * 1024);

    w.ascii('GIF89a');
    w.u16(W); w.u16(H);
    w.byte(0xF7);          // 全局调色板 | 色深7 | 未排序 | 表大小 2^8
    w.byte(0);             // 背景色索引
    w.byte(0);             // 像素宽高比

    for (var i = 0; i < 256; i++) {
      var c = palette[i] || [0, 0, 0];
      w.byte(c[0]); w.byte(c[1]); w.byte(c[2]);
    }

    // NETSCAPE2.0 循环扩展
    w.byte(0x21); w.byte(0xFF); w.byte(0x0B);
    w.ascii('NETSCAPE2.0');
    w.byte(0x03); w.byte(0x01); w.u16(loop); w.byte(0x00);

    for (var f = 0; f < frames.length; f++) {
      var fr = frames[f];
      var delay = Math.max(1, Math.round(fr.delay / 10));

      // 图形控制扩展：disposal = 1（保留画面，帧差依赖它）
      w.byte(0x21); w.byte(0xF9); w.byte(0x04);
      w.byte(0x04);
      w.u16(delay);
      w.byte(0x00);
      w.byte(0x00);

      // 图像描述符
      w.byte(0x2C);
      w.u16(fr.x); w.u16(fr.y); w.u16(fr.w); w.u16(fr.h);
      w.byte(0x00);        // 无局部调色板、非交错
      w.byte(minCodeSize);

      var data = lzwEncode(fr.indices, minCodeSize);
      for (var p = 0; p < data.length; p += 255) {
        var n = Math.min(255, data.length - p);
        w.byte(n);
        w.bytes(data.subarray(p, p + n));
      }
      w.byte(0x00);
    }

    w.byte(0x3B);
    return w.result();
  }

  /* ==================== 中位切分量化 ==================== */
  function cmpR(a, b) { return ((a >> 16) & 255) - ((b >> 16) & 255); }
  function cmpG(a, b) { return ((a >> 8) & 255) - ((b >> 8) & 255); }
  function cmpB(a, b) { return (a & 255) - (b & 255); }

  function makeBox(px, start, end) {
    var rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
    for (var i = start; i < end; i++) {
      var v = px[i];
      var r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
      if (r < rMin) rMin = r; if (r > rMax) rMax = r;
      if (g < gMin) gMin = g; if (g > gMax) gMax = g;
      if (b < bMin) bMin = b; if (b > bMax) bMax = b;
    }
    return {
      start: start, end: end,
      dr: rMax - rMin, dg: gMax - gMin, db: bMax - bMin
    };
  }

  /* 返回 { palette, counts }，counts 用于后续强制注入竖线色/背景色 */
  function quantizeEx(rgba, maxColors, maxSamples) {
    var n = rgba.length >> 2;
    if (n === 0) return { palette: [[0, 0, 0]], counts: [1] };

    maxSamples = maxSamples || 24576;
    var step = Math.max(1, Math.floor(n / maxSamples));
    var tmp = new Int32Array(Math.ceil(n / step) + 1);
    var cnt = 0;
    for (var i = 0; i < n; i += step) {
      var o = i << 2;
      if (rgba[o + 3] < 8) continue;                 // 跳过全透明像素
      tmp[cnt++] = (rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2];
    }
    if (cnt === 0) return { palette: [[0, 0, 0]], counts: [1] };

    var px = tmp.subarray(0, cnt);
    var boxes = [makeBox(px, 0, cnt)];

    while (boxes.length < maxColors) {
      var best = -1, bestScore = -1;
      for (var bi = 0; bi < boxes.length; bi++) {
        var b = boxes[bi];
        var size = b.end - b.start;
        if (size < 2) continue;
        var range = Math.max(b.dr, Math.max(b.dg, b.db));
        var score = size * (range + 1);
        if (score > bestScore) { bestScore = score; best = bi; }
      }
      if (best < 0) break;

      var box = boxes[best];
      var ch = (box.dr >= box.dg && box.dr >= box.db) ? 0 : (box.dg >= box.db ? 1 : 2);
      var sub = px.subarray(box.start, box.end);
      sub.sort(ch === 0 ? cmpR : (ch === 1 ? cmpG : cmpB));

      var mid = box.start + ((box.end - box.start) >> 1);
      boxes.splice(best, 1, makeBox(px, box.start, mid), makeBox(px, mid, box.end));
    }

    var palette = [], counts = [];
    for (var k = 0; k < boxes.length; k++) {
      var bb = boxes[k], r = 0, g = 0, bl = 0, c = 0;
      for (var j = bb.start; j < bb.end; j++) {
        var v2 = px[j];
        r += (v2 >> 16) & 255; g += (v2 >> 8) & 255; bl += v2 & 255; c++;
      }
      palette.push([Math.round(r / c), Math.round(g / c), Math.round(bl / c)]);
      counts.push(c);
    }
    return { palette: palette, counts: counts };
  }

  function quantize(rgba, maxColors, maxSamples) {
    return quantizeEx(rgba, maxColors, maxSamples).palette;
  }

  /* 保证若干「必须存在」的颜色（竖线、留边背景）真的在调色板里 */
  function ensureForced(palette, counts, forced) {
    for (var i = 0; i < forced.length; i++) {
      var f = forced[i], ok = false;
      for (var j = 0; j < palette.length; j++) {
        var c = palette[j];
        if (Math.abs(c[0] - f[0]) <= 10 &&
            Math.abs(c[1] - f[1]) <= 10 &&
            Math.abs(c[2] - f[2]) <= 10) { ok = true; break; }
      }
      if (ok) continue;
      var mi = 0;
      for (var m = 1; m < counts.length; m++) if (counts[m] < counts[mi]) mi = m;
      palette[mi] = [f[0], f[1], f[2]];
      counts[mi] = Infinity;   // 同一个槽位不再被第二个强制色覆盖
    }
    return palette;
  }

  function nearestIndex(palette, rgb) {
    var best = 0, bd = Infinity;
    for (var i = 0; i < palette.length; i++) {
      var c = palette[i];
      var dr = rgb[0] - c[0], dg = rgb[1] - c[1], db = rgb[2] - c[2];
      var d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /* RGBA → 索引。用 5-5-5 缓存把最近色搜索压到最多 32768 次。
     缓存同时保证了「相同像素 → 相同索引」，这是帧差成立的前提。 */
  function applyPalette(rgba, palette) {
    var n = rgba.length >> 2;
    var out = new Uint8Array(n);
    var cache = new Int16Array(32768).fill(-1);
    var plen = palette.length;
    for (var i = 0; i < n; i++) {
      var o = i << 2;
      var r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
      var key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      var idx = cache[key];
      if (idx < 0) {
        var best = 0, bd = Infinity;
        for (var p = 0; p < plen; p++) {
          var c = palette[p];
          var dr = r - c[0], dg = g - c[1], db = b - c[2];
          var d = dr * dr + dg * dg + db * db;
          if (d < bd) { bd = d; best = p; }
        }
        idx = best;
        cache[key] = best;
      }
      out[i] = idx;
    }
    return out;
  }

  root.GiferGif = {
    encode: encode,
    quantize: quantize,
    quantizeEx: quantizeEx,
    ensureForced: ensureForced,
    nearestIndex: nearestIndex,
    applyPalette: applyPalette,
    _lzwEncode: lzwEncode
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
