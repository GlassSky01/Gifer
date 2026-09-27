/* render.js — 帧几何 + 索引空间合成 + 帧差
   纯计算，不碰 DOM，可同时在浏览器和 Node 里跑。
   这一份几何是「预览」和「编码」共用的唯一真相来源。 */
(function (root) {
  'use strict';

  /* 过渡曲线：线性 —— 竖线匀速向右前进。
     想换回缓入缓出，把 ease() 的函数体换成 easeInOutCubic(t) 即可。 */
  function ease(t) { return t; }

  // 备选：缓入缓出（起步慢、中间快、收尾慢）
  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  // 以第一张图的比例为准，按像素预算算出偶数宽高
  function computeCanvasSize(aspect, budget) {
    if (!isFinite(aspect) || aspect <= 0) aspect = 1;
    var W = Math.max(2, Math.round(Math.sqrt(budget * aspect)));
    var H = Math.max(2, Math.round(budget / W));
    var CAP = 1920;
    if (W > CAP) { W = CAP; H = Math.round(W / aspect); }
    if (H > CAP) { H = CAP; W = Math.round(H * aspect); }
    W -= W % 2; H -= H % 2;
    return { W: Math.max(2, W), H: Math.max(2, H) };
  }

  /* 生成帧序列。
     每帧 = { cur, nxt, x, delay }
       x   : 已变成「下一张」的宽度（竖线就在 x 处）
       停留时长被合并进「过渡完成帧」的 delay —— 所以停留不花体积。 */
  function buildFrames(count, W, H, transitionMs, holdMs, fps) {
    var out = [];
    if (count <= 0) return out;
    var hold = Math.max(0, holdMs);

    if (count === 1) {
      out.push({ cur: 0, nxt: 0, x: W, delay: Math.max(20, hold || 700) });
      return out;
    }

    // 首帧：完整显示第 0 张，停留后再开始第一次擦除
    out.push({ cur: 0, nxt: 0, x: W, delay: Math.max(20, hold || 1) });

    var frameMs = 1000 / fps;
    // lineFrames 帧用来「画线并推进」，多出来的 1 帧只负责收尾（抹掉竖线）
    var lineFrames = Math.max(2, Math.round(transitionMs / frameMs));
    var total = lineFrames + 1;

    for (var i = 0; i < count; i++) {
      var cur = i, nxt = (i + 1) % count;
      var prevMs = 0;

      // ① 画线帧：竖线从最左边界 0 匀速走到最右边界 W-1。
      //    位置用归一化参数 u∈[0,1] 经 ease 映射，所以无论换什么曲线，
      //    起点都钉在 0、终点都钉在 W-1。
      for (var k = 1; k <= lineFrames; k++) {
        var u = (k - 1) / (lineFrames - 1);
        var x = Math.round((W - 1) * ease(u));
        var ms = Math.round(transitionMs * k / lineFrames / 10) * 10;  // 对齐 GIF 的 1/100s
        var d = ms - prevMs;
        prevMs = ms;
        if (d <= 0) d = 10;
        out.push({ cur: cur, nxt: nxt, x: x, delay: d });
      }

      // ② 收尾帧：x === W，不画线，画面完全变成下一张。
      //    停留合并进这一帧，所以停留不花体积。
      //    最后一次擦除（回到第 0 张）不加停留：循环会接回首帧，那里已经带了停留，
      //    否则首图在接缝处会被停留两次。
      var tail = (i < count - 1) ? hold : 0;
      out.push({ cur: cur, nxt: nxt, x: W, delay: Math.max(10, tail) });
    }
    return out;
  }

  /* 在索引空间合成一帧的完整画面。
     idxList : 每张图的 Uint8Array(W*H)
     line    : [深, 白, 深] 三个调色板索引 */
  function compose(idxList, W, H, frame, line) {
    var out = idxList[frame.cur].slice();
    var x = frame.x;

    if (x > 0 && frame.nxt !== frame.cur) {
      var nx = idxList[frame.nxt];
      var w = Math.min(x, W);
      for (var y = 0; y < H; y++) {
        var off = y * W;
        out.set(nx.subarray(off, off + w), off);
      }
    }

    if (line && x < W) {
      var a = Math.max(0, x - 1);
      var b = Math.min(W, x + 2);
      for (var yy = 0; yy < H; yy++) {
        var o2 = yy * W;
        for (var px = a; px < b; px++) out[o2 + px] = line[px - a];
      }
    }
    return out;
  }

  // 与上一帧索引数组求差异包围盒；完全相同返回 null
  function diffBBox(prev, cur, W, H) {
    var minX = W, maxX = -1, minY = H, maxY = -1;
    for (var y = 0; y < H; y++) {
      var off = y * W;
      for (var x = 0; x < W; x++) {
        if (prev[off + x] !== cur[off + x]) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  // 从整幅索引位图里抠出一个连续的子矩形
  function extractRect(src, W, rect) {
    var out = new Uint8Array(rect.w * rect.h);
    for (var y = 0; y < rect.h; y++) {
      var s = (rect.y + y) * W + rect.x;
      out.set(src.subarray(s, s + rect.w), y * rect.w);
    }
    return out;
  }

  // 索引位图 → RGBA 缓冲（预览用；fill 进已有缓冲避免反复分配）
  function toRGBA(indices, palette, buf) {
    var n = indices.length;
    for (var i = 0; i < n; i++) {
      var c = palette[indices[i]] || [0, 0, 0];
      var o = i << 2;
      buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; buf[o + 3] = 255;
    }
    return buf;
  }

  root.GiferRender = {
    easeInOutCubic: easeInOutCubic,
    computeCanvasSize: computeCanvasSize,
    buildFrames: buildFrames,
    compose: compose,
    diffBBox: diffBBox,
    extractRect: extractRect,
    toRGBA: toRGBA
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
