/* app.js — 状态、交互、预览播放器、体积逼近 */
(function () {
  'use strict';

  var G = globalThis.GiferGif;
  var R = globalThis.GiferRender;

  var FPS = 12;                                    // 固定 12fps：降 fps 会破坏「缓缓」的观感
  var AREAS = [230400, 129600, 82944, 57600];      // ≈640×360, 480×270, 384×216, 320×180
  var COLORS = [256, 192, 128];
  var LINE_DARK = [38, 38, 38];
  var LINE_WHITE = [255, 255, 255];
  var MAX_DECODE = 1600;                           // 超大图解码时先缩放，避免爆内存

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    add: $('btnAdd'), preview: $('btnPreview'), save: $('btnSave'), clear: $('btnClear'),
    list: $('list'), stage: $('stage'), canvas: $('canvas'), hint: $('hint'), status: $('status'),
    summary: $('summary'), file: $('file'),
    transition: $('optTransition'), hold: $('optHold'), limit: $('optLimit'), bg: $('optBg'),
    valTransition: $('valTransition'), valHold: $('valHold'), valLimit: $('valLimit')
  };

  var state = {
    images: [],
    out: null,
    seq: 0,
    playing: false,
    frameIdx: 0,
    opts: { transition: 700, hold: 700, limitMB: 1.0, bg: 'white' }
  };

  var uid = 0;
  var buildToken = 0;
  var rebuildTimer = 0;
  var raf = 0, lastTs = 0, acc = 0;
  var previewBuf = null, previewImageData = null, previewCtx = null;
  var building = false;
  var pendingClose = [];

  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

  /* 位图不能在构建过程中被 close()，否则正在进行的 drawImage 会抛异常。
     构建期间先挂起，这一轮结束再统一释放。 */
  function queueClose(bmp) {
    if (!bmp) return;
    if (building) pendingClose.push(bmp);
    else if (bmp.close) bmp.close();
  }

  function flushClose() {
    while (pendingClose.length) {
      var b = pendingClose.pop();
      try { if (b.close) b.close(); } catch (e) { /* 忽略 */ }
    }
  }

  /* ==================== 图片加载 ==================== */
  async function decodeImage(file) {
    var bmp = await createImageBitmap(file);
    var long = Math.max(bmp.width, bmp.height);
    if (long > MAX_DECODE) {
      var s = MAX_DECODE / long;
      var nw = Math.max(1, Math.round(bmp.width * s));
      var nh = Math.max(1, Math.round(bmp.height * s));
      var small = await createImageBitmap(bmp, { resizeWidth: nw, resizeHeight: nh, resizeQuality: 'high' });
      bmp.close();
      bmp = small;
    }
    return bmp;
  }

  async function addFiles(files) {
    var arr = Array.prototype.slice.call(files).filter(function (f) {
      return /^image\//.test(f.type) || /\.(png|jpe?g|gif|webp|bmp|avif|heic|heif)$/i.test(f.name);
    });
    if (!arr.length) { flash('没有可用的图片文件', 'error'); return; }

    var added = 0, failed = [];
    for (var i = 0; i < arr.length; i++) {
      try {
        var bmp = await decodeImage(arr[i]);
        state.images.push({
          id: 'i' + (++uid),
          name: arr[i].name,
          url: URL.createObjectURL(arr[i]),
          bitmap: bmp,
          w: bmp.width,
          h: bmp.height
        });
        added++;
      } catch (e) {
        failed.push(arr[i].name);
      }
    }
    renderList();
    if (added) scheduleRebuild(80);
    if (failed.length) {
      var isHeic = failed.some(function (n) { return /\.(heic|heif)$/i.test(n); });
      flash('有 ' + failed.length + ' 个文件无法解码' +
            (isHeic ? '（HEIC 浏览器解不了，请先转成 JPEG）' : '') + '：' + failed.join('、'), 'error');
    }
  }

  function removeImage(id) {
    var i = state.images.findIndex(function (x) { return x.id === id; });
    if (i < 0) return;
    URL.revokeObjectURL(state.images[i].url);
    queueClose(state.images[i].bitmap);
    state.images.splice(i, 1);
    renderList();
    scheduleRebuild(80);
  }

  function clearAll() {
    state.images.forEach(function (im) {
      URL.revokeObjectURL(im.url);
      queueClose(im.bitmap);
    });
    state.images = [];
    renderList();
    scheduleRebuild(0);
  }

  function moveImage(fromId, toId) {
    var from = state.images.findIndex(function (x) { return x.id === fromId; });
    var to = state.images.findIndex(function (x) { return x.id === toId; });
    if (from < 0 || to < 0 || from === to) return;
    var it = state.images.splice(from, 1)[0];
    state.images.splice(to, 0, it);
    renderList();
    scheduleRebuild(120);
  }

  /* ==================== 列表渲染 + 拖拽排序 ==================== */
  var dragId = null;

  function clearOver() {
    Array.prototype.forEach.call(el.list.children, function (c) { c.classList.remove('over'); });
  }

  function renderList() {
    el.list.innerHTML = '';
    state.images.forEach(function (im, idx) {
      var item = document.createElement('div');
      item.className = 'item';
      item.draggable = true;
      item.dataset.id = im.id;

      var num = document.createElement('span');
      num.className = 'num'; num.textContent = idx + 1;

      var img = document.createElement('img');
      img.src = im.url; img.alt = '';

      var name = document.createElement('span');
      name.className = 'name'; name.textContent = im.name; name.title = im.name;

      var del = document.createElement('button');
      del.className = 'del'; del.textContent = '×'; del.title = '移除';
      del.addEventListener('click', function (ev) { ev.stopPropagation(); removeImage(im.id); });

      item.appendChild(num); item.appendChild(img);
      item.appendChild(name); item.appendChild(del);

      item.addEventListener('dragstart', function (ev) {
        dragId = im.id;
        item.classList.add('dragging');
        ev.dataTransfer.effectAllowed = 'move';
        try { ev.dataTransfer.setData('text/plain', im.id); } catch (e) { /* IE 无所谓 */ }
      });
      item.addEventListener('dragend', function () {
        item.classList.remove('dragging'); clearOver(); dragId = null;
      });
      item.addEventListener('dragover', function (ev) {
        if (dragId && dragId !== im.id) { ev.preventDefault(); clearOver(); item.classList.add('over'); }
      });
      item.addEventListener('dragleave', function () { item.classList.remove('over'); });
      item.addEventListener('drop', function (ev) {
        if (!dragId || dragId === im.id) return;      // 文件拖放交给 document 处理
        ev.preventDefault(); ev.stopPropagation();
        moveImage(dragId, im.id);
        clearOver();
      });

      el.list.appendChild(item);
    });
    updateButtons();
  }

  /* ==================== 参数 ==================== */
  function readOpts() {
    state.opts.transition = +el.transition.value;
    state.opts.hold = +el.hold.value;
    var lv = +el.limit.value;
    state.opts.limitMB = lv === 0 ? 0 : lv / 10;
    state.opts.bg = el.bg.value;
    el.valTransition.textContent = state.opts.transition + 'ms';
    el.valHold.textContent = state.opts.hold + 'ms';
    el.valLimit.textContent = lv === 0 ? '不限' : state.opts.limitMB.toFixed(1) + 'MB';
  }

  function mainColorOfFirst() {
    var im = state.images[0];
    if (!im) return [255, 255, 255];
    if (im._main) return im._main;
    var S = 48;
    var cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    var ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, S, S);
    var sc = Math.min(S / im.w, S / im.h);
    var dw = Math.max(1, Math.round(im.w * sc)), dh = Math.max(1, Math.round(im.h * sc));
    ctx.drawImage(im.bitmap, Math.round((S - dw) / 2), Math.round((S - dh) / 2), dw, dh);
    var q = G.quantizeEx(ctx.getImageData(0, 0, S, S).data, 8);
    var bi = 0;
    for (var i = 1; i < q.counts.length; i++) if (q.counts[i] > q.counts[bi]) bi = i;
    im._main = q.palette[bi];
    return im._main;
  }

  function resolveBg() {
    if (state.opts.bg === 'black') return { rgb: [0, 0, 0], css: '#000' };
    if (state.opts.bg === 'white') return { rgb: [255, 255, 255], css: '#fff' };
    var c = mainColorOfFirst();
    return { rgb: c, css: 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')' };
  }

  /* ==================== 构建流水线 ==================== */
  function buildLadder() {
    var L = AREAS.map(function (a) { return { area: a, colors: 256 }; });
    var last = AREAS[AREAS.length - 1];
    for (var c = 1; c < COLORS.length; c++) L.push({ area: last, colors: COLORS[c] });
    return L;
  }

  function nextStep(ladder, i, need) {
    var minArea = AREAS[AREAS.length - 1];
    if (need <= minArea) {
      // 跳到最小面积档的「第一档」（256 色），后面再逐档降颜色，
      // 否则会一步跳到 128 色，降得比需要的狠。
      for (var k = i + 1; k < ladder.length; k++) if (ladder[k].area === minArea) return k;
      return ladder.length - 1;
    }
    for (var m = i + 1; m < ladder.length; m++) {
      if (ladder[m].area < ladder[i].area && ladder[m].area <= need) return m;
    }
    return i + 1;
  }

  function sampleRasters(rasters, budget) {
    var per = Math.max(1, Math.floor(budget / rasters.length));
    var out = [];
    for (var r = 0; r < rasters.length; r++) {
      var data = rasters[r];
      var n = data.length >> 2;
      var step = Math.max(1, Math.floor(n / per));
      for (var i = 0; i < n; i += step) {
        var o = i << 2;
        out.push(data[o], data[o + 1], data[o + 2], 255);
      }
    }
    return new Uint8ClampedArray(out);
  }

  async function runPipeline(step, aspect, token) {
    var sz = R.computeCanvasSize(aspect, step.area);
    var W = sz.W, H = sz.H;
    var bg = resolveBg();
    var list = state.images.slice();      // 快照：构建期间用户删图/排序都不影响这一轮
    var count = list.length;

    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d', { willReadFrequently: true });

    var rasters = [];
    for (var i = 0; i < count; i++) {
      var im = list[i];
      ctx.fillStyle = bg.css;
      ctx.fillRect(0, 0, W, H);
      var s = Math.min(W / im.w, H / im.h);
      var dw = Math.max(1, Math.round(im.w * s));
      var dh = Math.max(1, Math.round(im.h * s));
      ctx.drawImage(im.bitmap, Math.round((W - dw) / 2), Math.round((H - dh) / 2), dw, dh);
      rasters.push(ctx.getImageData(0, 0, W, H).data);
      if ((i & 3) === 0) { await tick(); if (token !== buildToken) return null; }
    }

    // 一张全局调色板 —— 帧差成立的前提
    var q = G.quantizeEx(sampleRasters(rasters, 24576), step.colors);
    G.ensureForced(q.palette, q.counts, [bg.rgb, LINE_DARK, LINE_WHITE]);

    var idxList = [];
    for (var j = 0; j < count; j++) {
      idxList.push(G.applyPalette(rasters[j], q.palette));
      rasters[j] = null;
      if ((j & 3) === 0) { await tick(); if (token !== buildToken) return null; }
    }

    var line = [
      G.nearestIndex(q.palette, LINE_DARK),
      G.nearestIndex(q.palette, LINE_WHITE),
      G.nearestIndex(q.palette, LINE_DARK)
    ];

    var geo = R.buildFrames(count, W, H, state.opts.transition, state.opts.hold, FPS);
    var gifFrames = [];
    var prev = null;

    for (var f = 0; f < geo.length; f++) {
      var cur = R.compose(idxList, W, H, geo[f], line);
      var rect = (f === 0) ? { x: 0, y: 0, w: W, h: H } : R.diffBBox(prev, cur, W, H);
      if (rect) {
        gifFrames.push({
          x: rect.x, y: rect.y, w: rect.w, h: rect.h,
          delay: geo[f].delay,
          indices: R.extractRect(cur, W, rect)
        });
      } else if (gifFrames.length) {
        gifFrames[gifFrames.length - 1].delay += geo[f].delay;
      }
      prev = cur;
      if ((f & 7) === 0) { await tick(); if (token !== buildToken) return null; }
    }

    var bytes = G.encode({ width: W, height: H, palette: q.palette, frames: gifFrames, loop: 0 });
    if (token !== buildToken) return null;

    return {
      W: W, H: H, palette: q.palette, line: line, idxList: idxList,
      frames: geo, bytes: bytes, size: bytes.length, step: step, written: gifFrames.length
    };
  }

  function scheduleRebuild(delay) {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(function () { rebuild(); }, delay === undefined ? 200 : delay);
  }

  async function rebuild() {
    var token = ++buildToken;
    building = true;

    if (!state.images.length) {
      state.out = null;
      stopPlay();
      el.canvas.classList.add('hidden');
      el.hint.classList.remove('hidden');
      el.status.textContent = '';
      el.status.className = 'status';
      el.summary.textContent = '还没有图片';
      updateButtons();
      building = false; flushClose();
      return;
    }

    el.status.className = 'status';
    el.status.textContent = '生成中…';
    el.save.disabled = true;

    var first = state.images[0];
    var aspect = first.w / first.h;
    var ladder = buildLadder();
    var limit = state.opts.limitMB > 0 ? Math.round(state.opts.limitMB * 1024 * 1024) : Infinity;

    var i = 0, res = null, attempts = 0;
    while (i < ladder.length) {
      res = await runPipeline(ladder[i], aspect, token);
      if (!res) { building = false; flushClose(); return; }   // 已被更新的构建取代
      attempts++;
      if (res.size <= limit || i === ladder.length - 1) break;
      var need = Math.floor(ladder[i].area * limit / res.size * 0.96);
      i = nextStep(ladder, i, need);
    }
    if (!res || token !== buildToken) { building = false; flushClose(); return; }

    state.out = res;
    state.seq++;
    applyOut(res);

    var kb = res.size / 1024;
    var sizeTxt = kb >= 1024 ? (kb / 1024).toFixed(2) + 'MB' : Math.round(kb) + 'KB';
    el.summary.innerHTML = '成品 <b>' + sizeTxt + '</b> · ' + res.W + '×' + res.H + ' · ' + state.images.length + ' 张';

    if (res.size > limit) {
      el.status.className = 'status warn';
      el.status.textContent = '已经压到最小档仍是 ' + sizeTxt + '，超过目标体积上限';
    } else if (attempts > 1) {
      el.status.className = 'status warn';
      el.status.textContent = '为控制体积已自动降到 ' + res.W + '×' + res.H +
        (res.step.colors < 256 ? ' / ' + res.step.colors + ' 色' : '') + '，实际 ' + sizeTxt;
    } else {
      el.status.className = 'status';
      el.status.textContent = '';
    }
    updateButtons();
    building = false; flushClose();
  }

  /* ==================== 预览 ==================== */
  function applyOut(res) {
    el.canvas.width = res.W;
    el.canvas.height = res.H;
    el.canvas.classList.remove('hidden');
    el.hint.classList.add('hidden');
    previewBuf = new Uint8ClampedArray(res.W * res.H * 4);
    previewImageData = new ImageData(previewBuf, res.W, res.H);
    previewCtx = el.canvas.getContext('2d');
    state.frameIdx = 0;
    drawFrame(0);
  }

  function drawFrame(i) {
    var o = state.out;
    if (!o || !previewCtx) return;
    var cur = R.compose(o.idxList, o.W, o.H, o.frames[i], o.line);
    R.toRGBA(cur, o.palette, previewBuf);
    previewCtx.putImageData(previewImageData, 0, 0);
  }

  function loop(ts) {
    if (!state.playing) return;
    var o = state.out;
    if (!o) { stopPlay(); return; }
    if (!lastTs) lastTs = ts;
    var dt = ts - lastTs;
    lastTs = ts;
    if (dt > 250) dt = 250;
    acc += dt;
    var guard = 0;
    while (guard++ < 400) {
      var d = Math.max(1, o.frames[state.frameIdx].delay);
      if (acc < d) break;
      acc -= d;
      state.frameIdx = (state.frameIdx + 1) % o.frames.length;
    }
    drawFrame(state.frameIdx);
    raf = requestAnimationFrame(loop);
  }

  function startPlay() {
    if (!state.out || state.playing) return;
    state.playing = true;
    lastTs = 0; acc = 0;
    el.preview.textContent = '暂停';
    raf = requestAnimationFrame(loop);
  }

  function stopPlay() {
    state.playing = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    el.preview.textContent = '预览';
  }

  /* ==================== 保存 ==================== */
  function save() {
    var o = state.out;
    if (!o) return;
    var blob = new Blob([o.bytes], { type: 'image/gif' });
    var url = URL.createObjectURL(blob);
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    var a = document.createElement('a');
    a.href = url;
    a.download = 'gifer-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
                 '-' + p(d.getHours()) + p(d.getMinutes()) + '.gif';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  /* ==================== UI 杂项 ==================== */
  var flashTimer = 0;
  function flash(msg, kind) {
    el.status.className = 'status ' + (kind || 'error');
    el.status.textContent = msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () {
      el.status.className = 'status';
      el.status.textContent = '';
    }, 4000);
  }

  function updateButtons() {
    var has = state.images.length > 0;
    el.clear.disabled = !has;
    el.preview.disabled = !state.out;
    el.save.disabled = !state.out;
  }

  /* ==================== 事件绑定 ==================== */
  el.add.addEventListener('click', function () { el.file.click(); });
  el.file.addEventListener('change', function () {
    if (el.file.files && el.file.files.length) addFiles(el.file.files);
    el.file.value = '';
  });
  el.preview.addEventListener('click', function () {
    if (state.playing) stopPlay(); else startPlay();
  });
  el.save.addEventListener('click', save);
  el.clear.addEventListener('click', function () {
    if (state.images.length && confirm('清空所有图片？')) clearAll();
  });

  [el.transition, el.hold, el.limit, el.bg].forEach(function (node) {
    node.addEventListener('input', function () { readOpts(); scheduleRebuild(320); });
    node.addEventListener('change', function () { readOpts(); scheduleRebuild(320); });
  });

  ['dragover', 'drop'].forEach(function (t) {
    document.addEventListener(t, function (ev) {
      ev.preventDefault();
      if (t !== 'drop') return;
      if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length) {
        addFiles(ev.dataTransfer.files);
      }
    });
  });

  document.addEventListener('paste', function (ev) {
    if (!ev.clipboardData) return;
    var files = Array.prototype.slice.call(ev.clipboardData.files || []);
    if (!files.length) {
      Array.prototype.forEach.call(ev.clipboardData.items || [], function (it) {
        if (it.kind === 'file') { var f = it.getAsFile(); if (f) files.push(f); }
      });
    }
    if (files.length) { ev.preventDefault(); addFiles(files); }
  });

  window.addEventListener('keydown', function (ev) {
    if (ev.code === 'Space' && ev.target === document.body) {
      ev.preventDefault();
      if (state.playing) stopPlay(); else startPlay();
    }
  });

  // 初始化
  readOpts();
  renderList();

  // 调试/自动化入口（浏览器控制台可用，headless 验证也走它）
  window.__gifer = {
    state: state,
    addFiles: addFiles,
    clearAll: clearAll,
    rebuild: rebuild,
    save: save,
    startPlay: startPlay,
    stopPlay: stopPlay,
    drawFrame: drawFrame
  };
})();
