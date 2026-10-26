// 从一张正方形插画生成应用图标 / 托盘图标。
//
// 用法（必须用 electron 跑，脚本依赖 nativeImage 解码 JPEG/PNG）：
//   node_modules\electron\dist\electron.exe scripts\make-icon.js [源图]
//
// 做四件事：
//   1. 定位主体：对「非背景色」像素做连通域分析，取面积最大的那块的外接框
//      （源图右下角的「豆包AI生成」水印是独立小块，会被自然排除）
//   2. 抠底：从外接框四边向内 flood fill「浅色低饱和」像素，连通的背景变透明；
//      边缘像素按与就近背景色的差距给部分 alpha，不留奶白描边
//   3. 自己按面积平均缩放（不用 nativeImage.resize —— 它会破坏 alpha 通道），
//      输出 src/assets/icon.png(512) / icon.ico(16~256) / tray.ico(16~64) / tray.png
//   4. 生成 .shots/ 下的预览图（浅底、深底、品红底、遮罩）便于肉眼验收
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-sandbox');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'src', 'assets');
const SHOT_DIR = path.join(ROOT, '.shots');
const LOG = path.join(SHOT_DIR, 'icon.json');

const SRC = process.argv[2] || 'C:/Users/ch/.workbuddy/clipboard-images/clipboard-2026-10-26T07-26-50-170Z-353dfd1e.jpg';
const FG_TOL2 = 46 * 46; // 「算主体」的颜色距离阈值（平方）
const MARGIN = 0.04; // 画布四周留白比例

const lines = [];
const log = (s) => { lines.push(s); };

/* ------------------------------ 像素工具 ------------------------------ */

const dist2 = (r, g, b, bg) => {
  const dr = r - bg[0];
  const dg = g - bg[1];
  const db = b - bg[2];
  return dr * dr + dg * dg + db * db;
};

/** 4 连通泛洪：passable(i) 判定可扩散，visit(i) 标记 */
function flood(seeds, passable, visit, w, h) {
  const stack = new Int32Array(w * h);
  const seen = new Uint8Array(w * h);
  let sp = 0;
  for (const s of seeds) {
    if (s < 0 || s >= w * h || seen[s] || !passable(s)) continue;
    seen[s] = 1;
    stack[sp++] = s;
  }
  while (sp > 0) {
    const i = stack[--sp];
    visit(i);
    const x = i % w;
    if (x > 0 && !seen[i - 1] && passable(i - 1)) { seen[i - 1] = 1; stack[sp++] = i - 1; }
    if (x < w - 1 && !seen[i + 1] && passable(i + 1)) { seen[i + 1] = 1; stack[sp++] = i + 1; }
    if (i >= w && !seen[i - w] && passable(i - w)) { seen[i - w] = 1; stack[sp++] = i - w; }
    if (i + w < w * h && !seen[i + w] && passable(i + w)) { seen[i + w] = 1; stack[sp++] = i + w; }
  }
  void h;
}

/** 主体外接框：非背景像素的最大连通域 */
function findSubjectBox(buf, w, h, bg) {
  const isFg = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    isFg[i] = dist2(buf[o + 2], buf[o + 1], buf[o], bg) > FG_TOL2 ? 1 : 0;
  }
  const label = new Int32Array(w * h).fill(-1);
  let best = null;
  const comps = [];
  for (let start = 0; start < w * h; start++) {
    if (!isFg[start] || label[start] >= 0) continue;
    const id = comps.length;
    let minX = w, minY = h, maxX = -1, maxY = -1, area = 0;
    flood([start], (i) => isFg[i] === 1 && label[i] < 0, (i) => {
      label[i] = id;
      area += 1;
      const x = i % w;
      const y = (i - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }, w, h);
    const c = { id, area, minX, minY, maxX, maxY };
    comps.push(c);
    if (!best || c.area > best.area) best = c;
  }
  comps.sort((a, b) => b.area - a.area);
  return { box: best, top: comps.slice(0, 4) };
}

/** 面积平均缩放（alpha 加权），自己算就不用担心 resize 丢 alpha */
function resample(src, S, n) {
  const out = Buffer.alloc(n * n * 4, 0);
  const scale = S / n;
  for (let ty = 0; ty < n; ty++) {
    const y0 = ty * scale;
    const y1 = y0 + scale;
    const sy0 = Math.floor(y0);
    const sy1 = Math.min(S, Math.ceil(y1));
    for (let tx = 0; tx < n; tx++) {
      const x0 = tx * scale;
      const x1 = x0 + scale;
      const sx0 = Math.floor(x0);
      const sx1 = Math.min(S, Math.ceil(x1));
      let b = 0, g = 0, r = 0, a = 0, wsum = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (wy <= 0) continue;
        for (let sx = sx0; sx < sx1; sx++) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (wx <= 0) continue;
          const w = wy * wx;
          const o = (sy * S + sx) * 4;
          const pa = src[o + 3] / 255;
          b += src[o] * pa * w;
          g += src[o + 1] * pa * w;
          r += src[o + 2] * pa * w;
          a += pa * w;
          wsum += w;
        }
      }
      const o = (ty * n + tx) * 4;
      if (a > 0) {
        out[o] = Math.round(b / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(r / a);
      }
      out[o + 3] = wsum > 0 ? Math.round((a / wsum) * 255) : 0;
    }
  }
  return out;
}

/** BGRA buffer -> PNG buffer */
const pngOf = (buf, n) => nativeImage.createFromBitmap(buf, { width: n, height: n }).toPNG();

/** 多个尺寸拼一张预览图；scaleUp>1 时用最近邻放大看清像素 */
function compose(tiles, bgRgb, file, scaleUp = 1) {
  const gap = 8 * scaleUp;
  const cellW = tiles.reduce((s, t) => s + t.n * scaleUp, 0) + gap * (tiles.length + 1);
  const cellH = Math.max(...tiles.map((t) => t.n * scaleUp)) + gap * 2;
  const out = Buffer.alloc(cellW * cellH * 4, 255);
  for (let i = 0; i < cellW * cellH; i++) {
    out[i * 4] = bgRgb[2];
    out[i * 4 + 1] = bgRgb[1];
    out[i * 4 + 2] = bgRgb[0];
    out[i * 4 + 3] = 255;
  }
  let curX = gap;
  for (const { n, buf } of tiles) {
    const y0 = Math.round((cellH - n * scaleUp) / 2);
    for (let y = 0; y < n * scaleUp; y++) {
      for (let x = 0; x < n * scaleUp; x++) {
        const si = (Math.floor(y / scaleUp) * n + Math.floor(x / scaleUp)) * 4;
        const a = buf[si + 3] / 255;
        if (a <= 0) continue;
        const di = ((y0 + y) * cellW + curX + x) * 4;
        out[di] = Math.round(buf[si] * a + out[di] * (1 - a));
        out[di + 1] = Math.round(buf[si + 1] * a + out[di + 1] * (1 - a));
        out[di + 2] = Math.round(buf[si + 2] * a + out[di + 2] * (1 - a));
      }
    }
    curX += n * scaleUp + gap;
  }
  const png = nativeImage.createFromBitmap(out, { width: cellW, height: cellH }).toPNG();
  fs.writeFileSync(path.join(SHOT_DIR, file), png);
  log(`preview ${file} ${cellW}x${cellH}`);
}

/* ------------------------------ 主流程 ------------------------------ */

function run() {
  const src = nativeImage.createFromPath(SRC);
  const { width: W, height: H } = src.getSize();
  if (!W || !H) throw new Error('源图解码失败: ' + SRC);
  log(`源图 ${W}x${H}`);

  const buf = src.toBitmap(); // BGRA

  // 背景色：四角 12x12 均值
  const pick = [];
  for (const [ox, oy] of [[0, 0], [W - 12, 0], [0, H - 12], [W - 12, H - 12]]) {
    for (let y = oy; y < oy + 12; y++) {
      for (let x = ox; x < ox + 12; x++) {
        const o = (y * W + x) * 4;
        pick.push([buf[o + 2], buf[o + 1], buf[o]]);
      }
    }
  }
  const bg = [0, 1, 2].map((k) => Math.round(pick.reduce((s, c) => s + c[k], 0) / pick.length));
  log(`背景色 rgb(${bg.join(',')})`);

  const { box, top } = findSubjectBox(buf, W, H, bg);
  if (!box) throw new Error('没找到主体');
  log(`主体外接框 x=${box.minX}..${box.maxX} y=${box.minY}..${box.maxY} area=${box.area}`);
  log('最大 4 个连通域面积: ' + top.map((c) => c.area).join(', '));

  const pad = 1;
  const cx = Math.max(0, box.minX - pad);
  const cy = Math.max(0, box.minY - pad);
  const cw = Math.min(W - cx, box.maxX - box.minX + 1 + pad * 2);
  const ch = Math.min(H - cy, box.maxY - box.minY + 1 + pad * 2);
  log(`裁剪 ${cw}x${ch} @ (${cx},${cy})`);

  const cropped = src.crop({ x: cx, y: cy, width: cw, height: ch }).toBitmap();

  // 抠底：从四周边缘出发，把「浅色低饱和」的像素连成一片算背景。
  // 图标内部的奶油色「天空」被青色边框包住，泛洪进不去，不会被误伤。
  const isBgLike = (i) => {
    const o = i * 4;
    const b = cropped[o], g = cropped[o + 1], r = cropped[o + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    return lum > 205 && Math.max(r, g, b) - Math.min(r, g, b) < 46;
  };
  const bgMask = new Uint8Array(cw * ch);
  const seeds = [];
  for (let x = 0; x < cw; x++) { seeds.push(x); seeds.push((ch - 1) * cw + x); }
  for (let y = 0; y < ch; y++) { seeds.push(y * cw); seeds.push(y * cw + cw - 1); }
  flood(seeds, (i) => bgMask[i] === 0 && isBgLike(i), (i) => { bgMask[i] = 1; }, cw, ch);

  // 写 alpha：背景 0；与背景相邻的边缘像素按「和就近背景色的差距」给部分 alpha
  let cleared = 0;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = y * cw + x;
      if (bgMask[i]) { cropped[i * 4 + 3] = 0; cleared++; continue; }
      let lr = 0, lg = 0, lb = 0, ln = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
          const ni = ny * cw + nx;
          if (!bgMask[ni]) continue;
          lb += cropped[ni * 4];
          lg += cropped[ni * 4 + 1];
          lr += cropped[ni * 4 + 2];
          ln++;
        }
      }
      if (!ln) continue;
      const d = Math.sqrt(dist2(cropped[i * 4 + 2], cropped[i * 4 + 1], cropped[i * 4], [lr / ln, lg / ln, lb / ln]));
      const a = Math.max(0, Math.min(1, (d - 12) / (70 - 12)));
      cropped[i * 4 + 3] = Math.round(a * 255);
    }
  }
  log(`透明像素 ${cleared} / ${cw * ch} (${((cleared / (cw * ch)) * 100).toFixed(1)}%)`);

  // 补成正方形 + 留白
  const side = Math.max(cw, ch);
  const margin = Math.round(side * MARGIN);
  const S = side + margin * 2;
  const canvas = Buffer.alloc(S * S * 4, 0);
  const ox = Math.round((S - cw) / 2);
  const oy = Math.round((S - ch) / 2);
  for (let y = 0; y < ch; y++) {
    cropped.copy(canvas, ((y + oy) * S + ox) * 4, y * cw * 4, y * cw * 4 + cw * 4);
  }
  log(`母版 ${S}x${S}（留白 ${margin}px）`);

  const cache = new Map();
  const at = (n) => {
    if (!cache.has(n)) cache.set(n, resample(canvas, S, n));
    return cache.get(n);
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const png512 = pngOf(at(512), 512);
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png512);
  log(`icon.png 512x512 ${png512.length} B`);

  // ICO：PNG 负载（Vista+ 支持），尺寸由系统按场景挑
  const buildIco = (sizes) => {
    const entries = sizes.map((n) => ({ size: n, png: pngOf(at(n), n) }));
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(entries.length, 4);
    const dir = Buffer.alloc(16 * entries.length);
    let off = 6 + 16 * entries.length;
    entries.forEach((e, i) => {
      const b = dir.subarray(i * 16, i * 16 + 16);
      b.writeUInt8(e.size >= 256 ? 0 : e.size, 0);
      b.writeUInt8(e.size >= 256 ? 0 : e.size, 1);
      b.writeUInt8(0, 2);
      b.writeUInt8(0, 3);
      b.writeUInt16LE(1, 4);
      b.writeUInt16LE(32, 6);
      b.writeUInt32LE(e.png.length, 8);
      b.writeUInt32LE(off, 12);
      off += e.png.length;
    });
    return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
  };

  const appIco = buildIco([16, 20, 24, 32, 40, 48, 64, 128, 256]);
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), appIco);
  log(`icon.ico [16..256] ${appIco.length} B`);

  const trayIco = buildIco([16, 20, 24, 32, 40, 48, 64]);
  fs.writeFileSync(path.join(OUT_DIR, 'tray.ico'), trayIco);
  log(`tray.ico [16..64] ${trayIco.length} B`);

  const trayPng = pngOf(at(64), 64);
  fs.writeFileSync(path.join(OUT_DIR, 'tray.png'), trayPng);
  log(`tray.png 64x64 ${trayPng.length} B`);

  /* ------------------------------ 预览 ------------------------------ */
  compose([16, 24, 32, 48].map((n) => ({ n, buf: at(n) })), [255, 255, 255], 'icon-light.png', 6);
  compose([16, 24, 32, 48].map((n) => ({ n, buf: at(n) })), [32, 32, 32], 'icon-dark.png', 6);
  compose([{ n: 256, buf: at(256) }], [245, 246, 248], 'icon-256-light.png');
  compose([{ n: 256, buf: at(256) }], [28, 30, 34], 'icon-256-dark.png');
  // 品红底：任何残留的不透明背景都会一眼看出来
  compose([{ n: 220, buf: at(220) }], [255, 0, 255], 'icon-magenta.png');

  const a256 = at(256);
  const alphaAt = (x, y) => a256[(y * 256 + x) * 4 + 3];
  log(`alpha@256: (2,2)=${alphaAt(2, 2)} (14,14)=${alphaAt(14, 14)} (128,2)=${alphaAt(128, 2)} (2,128)=${alphaAt(2, 128)} (128,128)=${alphaAt(128, 128)} (253,253)=${alphaAt(253, 253)}`);

  // 回读自检：确认 Electron 能解码产出的 png / ico（托盘若用 ico，必须是它认得的）
  for (const f of ['icon.png', 'icon.ico', 'tray.ico', 'tray.png']) {
    const im = nativeImage.createFromBuffer(fs.readFileSync(path.join(OUT_DIR, f)));
    log(`回读 ${f}: empty=${im.isEmpty()} size=${im.getSize().width}x${im.getSize().height}`);
  }

  fs.writeFileSync(LOG, JSON.stringify({ ok: true, bg, box, cw, ch, side: S, lines }, null, 1));
}

app.whenReady().then(() => {
  let code = 0;
  try {
    run();
  } catch (err) {
    code = 1;
    try { fs.writeFileSync(LOG, JSON.stringify({ ok: false, err: String((err && err.stack) || err), lines }, null, 1)); } catch {}
  }
  app.exit(code);
});
