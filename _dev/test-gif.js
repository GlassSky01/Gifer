/* 开发期验证脚本（不属于交付物，验收后可删）
   1) 用独立实现的解码器对自研编码器做往返比对
   2) 输出一个真实 GIF 供人工/工具确认可解码
   3) 跑一遍完整的擦除动画流水线，给出体积预估 */
'use strict';
const fs = require('fs');
const path = require('path');

require(path.join(__dirname, '..', 'gif.js'));
require(path.join(__dirname, '..', 'render.js'));

const G = globalThis.GiferGif;
const R = globalThis.GiferRender;

/* ================= 独立实现的 GIF 解码器 ================= */
function readCT(buf, p, n) {
  const ct = [];
  for (let i = 0; i < n; i++) ct.push([buf[p + i * 3], buf[p + i * 3 + 1], buf[p + i * 3 + 2]]);
  return ct;
}

function lzwDecode(data, minCodeSize, expected) {
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let codeSize, dict;
  const reset = () => {
    dict = new Array(clear + 2);
    for (let i = 0; i < clear; i++) dict[i] = [i];
    dict[clear] = []; dict[eoi] = null;
    codeSize = minCodeSize + 1;
  };
  reset();

  const out = new Uint8Array(expected);
  let oi = 0;
  let bitPos = 0;
  const totalBits = data.length * 8;
  let prev = null;

  while (bitPos + codeSize <= totalBits) {
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      const bp = bitPos + i;
      code |= ((data[bp >> 3] >> (bp & 7)) & 1) << i;
    }
    bitPos += codeSize;

    if (code === clear) { reset(); prev = null; continue; }
    if (code === eoi) break;

    let entry;
    if (code < dict.length && dict[code] !== undefined && dict[code] !== null) entry = dict[code];
    else if (prev) { entry = prev.concat(prev[0]); }
    else throw new Error('LZW 解码失败：非法码 ' + code);

    for (let i = 0; i < entry.length; i++) {
      if (oi >= expected) throw new Error('LZW 解码溢出：输出超过 ' + expected + ' 像素');
      out[oi++] = entry[i];
    }
    if (oi > expected) throw new Error('LZW 解码溢出');

    if (prev) {
      dict.push(prev.concat(entry[0]));
      if (dict.length === (1 << codeSize) && codeSize < 12) codeSize++;
    }
    prev = entry;
  }
  if (oi !== expected) throw new Error('LZW 解码长度不符：' + oi + ' != ' + expected);
  return out;
}

function decodeGif(buf) {
  if (String.fromCharCode(buf[0], buf[1], buf[2], buf[3], buf[4], buf[5]) !== 'GIF89a')
    throw new Error('签名不是 GIF89a');
  let p = 6;
  const W = buf[p] | (buf[p + 1] << 8); p += 2;
  const H = buf[p] | (buf[p + 1] << 8); p += 2;
  const packed = buf[p++];
  const bgIndex = buf[p++];
  p++; // aspect
  let gct = null;
  if (packed & 0x80) {
    const n = 2 << (packed & 7);
    gct = readCT(buf, p, n);
    p += n * 3;
  }
  if (!gct) throw new Error('没有全局调色板');

  const frames = [];
  let delay = 0, disposal = 0, transparent = -1;
  let loop = null;
  const canvas = new Uint8Array(W * H).fill(bgIndex);

  while (p < buf.length) {
    const b = buf[p];
    if (b === 0x3B) break;

    if (b === 0x21) {
      const label = buf[p + 1];
      if (label === 0xF9) {
        const size = buf[p + 2];
        const pk = buf[p + 3];
        disposal = (pk >> 2) & 7;
        transparent = (pk & 1) ? buf[p + 6] : -1;
        delay = buf[p + 4] | (buf[p + 5] << 8);
        p += 3 + size + 1;
      } else {
        let q = p + 2;
        while (true) { const n = buf[q++]; if (!n) break; q += n; }
        // 记录 NETSCAPE 循环次数
        if (label === 0xFF && buf[p + 2] === 11) {
          const tag = String.fromCharCode(...buf.subarray(p + 3, p + 14));
          if (tag === 'NETSCAPE2.0') loop = buf[p + 16] | (buf[p + 17] << 8);
        }
        p = q;
      }
      continue;
    }

    if (b === 0x2C) {
      const x = buf[p + 1] | (buf[p + 2] << 8);
      const y = buf[p + 3] | (buf[p + 4] << 8);
      const w = buf[p + 5] | (buf[p + 6] << 8);
      const h = buf[p + 7] | (buf[p + 8] << 8);
      const pk = buf[p + 9];
      p += 10;
      let ct = gct;
      if (pk & 0x80) { const n = 2 << (pk & 7); ct = readCT(buf, p, n); p += n * 3; }
      const minCodeSize = buf[p++];
      const chunks = [];
      while (true) { const n = buf[p++]; if (!n) break; chunks.push(buf.subarray(p, p + n)); p += n; }
      const total = chunks.reduce((a, c) => a + c.length, 0);
      const data = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { data.set(c, off); off += c.length; }

      const idx = lzwDecode(data, minCodeSize, w * h);
      for (let yy = 0; yy < h; yy++)
        for (let xx = 0; xx < w; xx++)
          canvas[(y + yy) * W + (x + xx)] = idx[yy * w + xx];

      frames.push({
        x, y, w, h, delay, disposal, transparent,
        snapshot: canvas.slice(),
        localPalette: ct === gct ? null : ct
      });
      if (disposal === 2) { /* 本项目不用，忽略 */ }
      continue;
    }
    throw new Error('遇到未知块 0x' + b.toString(16) + ' @ ' + p);
  }
  return { W, H, gct, frames, loop, bgIndex };
}

/* ================= 测试素材 ================= */
function makeImage(W, H, kind) {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) << 2;
      let r, g, b;
      if (kind === 0) { r = (x / W) * 255; g = (y / H) * 255; b = 128; }
      else if (kind === 1) { const c = ((x >> 3) + (y >> 3)) & 1; r = g = b = c ? 235 : 25; }
      else if (kind === 2) { r = 40; g = 200; b = 90; }
      else { r = 240; g = 240; b = 240; }
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
    }
  }
  return rgba;
}

/* 制造一张「类照片」：平滑底色 + 若干色块 + 轻噪声 */
function makePhotoLike(W, H, seed) {
  const rgba = new Uint8ClampedArray(W * H * 4);
  let s = seed * 9301 + 49297;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const blobs = [];
  for (let i = 0; i < 7; i++)
    blobs.push({ x: rnd() * W, y: rnd() * H, r: (0.1 + rnd() * 0.28) * W, c: [rnd() * 255, rnd() * 255, rnd() * 255] });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) << 2;
      let r = 60 + (x / W) * 90, g = 70 + (y / H) * 80, b = 110;
      for (const bl of blobs) {
        const d = Math.hypot(x - bl.x, y - bl.y) / bl.r;
        if (d < 1) { const k = (1 - d) * (1 - d); r += (bl.c[0] - r) * k * 0.8; g += (bl.c[1] - g) * k * 0.8; b += (bl.c[2] - b) * k * 0.8; }
      }
      const n = (rnd() - 0.5) * 26;
      rgba[o] = Math.max(0, Math.min(255, r + n));
      rgba[o + 1] = Math.max(0, Math.min(255, g + n));
      rgba[o + 2] = Math.max(0, Math.min(255, b + n));
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

/* ================= 用例 1：编码器往返比对 ================= */
function caseRoundTrip() {
  const W = 96, H = 64;
  const imgs = [makeImage(W, H, 0), makeImage(W, H, 1), makeImage(W, H, 2)];
  const { palette } = G.quantizeEx(makeImage(W, H, 0), 256);
  G.ensureForced(palette, new Array(palette.length).fill(1), [[255, 255, 255], [38, 38, 38], [255, 255, 255]]);
  const idxList = imgs.map(rgba => G.applyPalette(rgba, palette));
  const line = [
    G.nearestIndex(palette, [38, 38, 38]),
    G.nearestIndex(palette, [255, 255, 255]),
    G.nearestIndex(palette, [38, 38, 38])
  ];

  const geo = R.buildFrames(imgs.length, W, H, 400, 120, 12);
  const expected = [];
  const gifFrames = [];
  let prev = null;

  for (let i = 0; i < geo.length; i++) {
    const cur = R.compose(idxList, W, H, geo[i], line);
    expected.push(cur);
    let rect = (i === 0) ? { x: 0, y: 0, w: W, h: H } : R.diffBBox(prev, cur, W, H);
    if (rect) {
      gifFrames.push({ x: rect.x, y: rect.y, w: rect.w, h: rect.h, delay: geo[i].delay, indices: R.extractRect(cur, W, rect) });
    } else if (gifFrames.length) {
      gifFrames[gifFrames.length - 1].delay += geo[i].delay;
    }
    prev = cur;
  }

  const bytes = G.encode({ width: W, height: H, palette, frames: gifFrames, loop: 0 });
  fs.writeFileSync(path.join(__dirname, 'roundtrip.gif'), bytes);

  const dec = decodeGif(bytes);
  const problems = [];
  if (dec.W !== W || dec.H !== H) problems.push(`画布 ${dec.W}x${dec.H} != ${W}x${H}`);
  if (dec.loop !== 0) problems.push(`循环次数 ${dec.loop} != 0`);
  const gifFrameCount = gifFrames.length;
  if (dec.frames.length !== gifFrameCount) problems.push(`帧数 ${dec.frames.length} != ${gifFrameCount}`);

  // 逐帧比对「解码后重建的完整画面」与「编码前的合成画面」
  // 注意 gifFrames 可能因空白帧被合并，需要按 delay 对齐
  let di = 0, ei = 0;
  let totalDelay = 0, decDelay = 0;
  while (ei < expected.length && di < dec.frames.length) {
    const want = expected[ei];
    const got = dec.frames[di].snapshot;
    let diffCount = 0;
    for (let k = 0; k < W * H; k++) if (want[k] !== got[k]) diffCount++;
    if (diffCount > 0) { problems.push(`第 ${ei} 帧画面有 ${diffCount} 个像素不一致`); break; }
    totalDelay += geo[ei].delay;
    decDelay += dec.frames[di].delay * 10;
    ei++; di++;
  }
  if (ei !== expected.length) problems.push(`提前结束：只比对了 ${ei}/${expected.length} 帧`);

  console.log('【用例1】往返比对');
  console.log('  GIF 字节数        :', bytes.length);
  console.log('  编码帧数 / 几何帧数:', gifFrameCount, '/', expected.length);
  console.log('  解码帧数          :', dec.frames.length);
  console.log('  总时长(几何/解码) :', totalDelay + 'ms /', decDelay + 'ms');
  console.log('  结果              :', problems.length ? '❌ ' + problems.join('; ') : '✅ 全部一致');
  return problems.length === 0;
}

/* ================= 用例 2：整条流水线 + 体积预估 ================= */
function casePipeline(N, area, colors) {
  const W0 = 1280, H0 = 720;                       // 假定第一张是 16:9
  const aspect = W0 / H0;
  const size = R.computeCanvasSize(aspect, area);
  const { W, H } = size;

  const rasters = [];
  for (let i = 0; i < N; i++) rasters.push(makePhotoLike(W, H, i + 1));

  // 采样合成一张全局调色板
  const samples = [];
  const per = Math.max(1, Math.floor(24000 / N));
  for (const r of rasters) {
    const n = r.length >> 2;
    const step = Math.max(1, Math.floor(n / per));
    for (let i = 0; i < n; i += step) {
      const o = i << 2;
      samples.push(r[o], r[o + 1], r[o + 2], 255);
    }
  }
  const q = G.quantizeEx(new Uint8ClampedArray(samples), colors);
  G.ensureForced(q.palette, q.counts, [[255, 255, 255], [38, 38, 38]]);
  const idxList = rasters.map(r => G.applyPalette(r, q.palette));
  const line = [
    G.nearestIndex(q.palette, [38, 38, 38]),
    G.nearestIndex(q.palette, [255, 255, 255]),
    G.nearestIndex(q.palette, [38, 38, 38])
  ];

  const t0 = Date.now();
  const geo = R.buildFrames(N, W, H, 700, 700, 12);
  const gifFrames = [];
  let prev = null, changedPx = 0;
  for (let i = 0; i < geo.length; i++) {
    const cur = R.compose(idxList, W, H, geo[i], line);
    const rect = (i === 0) ? { x: 0, y: 0, w: W, h: H } : R.diffBBox(prev, cur, W, H);
    if (rect) {
      changedPx += rect.w * rect.h;
      gifFrames.push({ x: rect.x, y: rect.y, w: rect.w, h: rect.h, delay: geo[i].delay, indices: R.extractRect(cur, W, rect) });
    } else if (gifFrames.length) {
      gifFrames[gifFrames.length - 1].delay += geo[i].delay;
    }
    prev = cur;
  }
  const bytes = G.encode({ width: W, height: H, palette: q.palette, frames: gifFrames, loop: 0 });
  const ms = Date.now() - t0;

  const fullPx = W * H;
  console.log(`【用例2】${N} 张 / 画布 ${W}×${H} / ${colors} 色`);
  console.log('  几何帧数 / 实际写入帧 :', geo.length, '/', gifFrames.length);
  console.log('  变化像素总量          :', changedPx.toLocaleString(),
              `= ${(changedPx / fullPx).toFixed(2)} 张整图 (理论 ${N + 1})`);
  console.log('  编码后体积            :', (bytes.length / 1024).toFixed(1) + ' KB',
              `(若整幅编码约 ${(bytes.length / (changedPx / fullPx) / 1024).toFixed(0)} KB)`);
  console.log('  耗时                  :', ms + 'ms');
  fs.writeFileSync(path.join(__dirname, `pipeline-${N}-${W}x${H}.gif`), bytes);
  return bytes.length;
}

/* ================= 跑 ================= */
let ok = true;
ok = caseRoundTrip() && ok;
console.log('');
casePipeline(8, 230400, 256);
console.log('');
casePipeline(8, 129600, 256);

console.log('\n总体：', ok ? '✅ 编码器正确' : '❌ 编码器有问题');
process.exit(ok ? 0 : 1);
