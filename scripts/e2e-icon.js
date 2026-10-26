/* ==================================================================
   e2e-icon.js —— 图标接入自检（MOYU_E2E_ICON=1 npx electron . --dev）
   ------------------------------------------------------------------
   验三件事：
     1. 顶栏 logo（app://local/assets/icon.png）真的加载出来了（naturalWidth > 0）
     2. 窗口/任务栏图标已设置（BrowserWindow icon 为 appIcon()）
     3. 抓整屏，裁出任务栏左侧程序按钮区 + 右侧通知区，肉眼确认图标
   capturePage 在本机（disable-gpu）返回空白帧，所以一律走 desktopCapturer。
   产出：.shots/icon-window.png、.shots/icon-taskbar.png、.shots/icon-e2e.json
   ================================================================== */
'use strict';

module.exports = (win, fs, ctx = {}) => {
  const path = require('path');
  const { desktopCapturer, screen, nativeImage } = require('electron');

  const ROOT = path.join(__dirname, '..');
  const LOG = path.join(ROOT, '.shots');
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lines = [];

  win.webContents.on('console-message', (_e, level, message, lineNo) => {
    if (level >= 2) lines.push(`[console:${level}] ${message} @${lineNo}`);
  });

  (async () => {
    const out = { lines, ok: false };
    try {
      await sleep(2600);
      win.show();
      win.setAlwaysOnTop(true);
      win.focus();
      await sleep(700);

      out.dom = await js(`(() => {
        const img = document.querySelector('.brand-logo');
        if (!img) return { found: false };
        const r = img.getBoundingClientRect();
        return {
          found: true,
          src: img.getAttribute('src'),
          complete: img.complete,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          box: { w: Math.round(r.width), h: Math.round(r.height) },
        };
      })()`);

      const disp = screen.getPrimaryDisplay();
      const srcs = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.round(disp.size.width * disp.scaleFactor),
          height: Math.round(disp.size.height * disp.scaleFactor),
        },
      });
      const src = srcs.find((s) => String(s.display_id) === String(disp.id)) || srcs[0];
      if (!src) throw new Error('no screen source');
      const img = src.thumbnail;
      const sz = img.getSize();
      const scale = sz.width / disp.size.width;
      out.screen = { width: sz.width, height: sz.height, scale };

      // 1) 窗口区域
      const b = win.getBounds();
      const rect = {
        x: Math.max(0, Math.round((b.x - disp.bounds.x) * scale)),
        y: Math.max(0, Math.round((b.y - disp.bounds.y) * scale)),
        width: 0,
        height: 0,
      };
      rect.width = Math.min(Math.round(b.width * scale), sz.width - rect.x);
      rect.height = Math.min(Math.round(b.height * scale), sz.height - rect.y);
      fs.writeFileSync(path.join(LOG, 'icon-window.png'), img.crop(rect).toPNG());
      out.windowCrop = rect;

      // 2) 任务栏：左侧挂件 + 中间程序按钮 + 右侧通知区，各裁一条再放大 3 倍
      const barH = Math.round(56 * scale);
      const y = sz.height - barH;
      const left = img.crop({ x: 0, y, width: Math.min(Math.round(420 * scale), sz.width), height: barH });
      const midCx = Math.round((disp.workArea.x + disp.workArea.width / 2 - disp.bounds.x) * scale);
      const midW = Math.round(680 * scale);
      const midX = Math.max(0, Math.min(midCx - Math.round(midW / 2), sz.width - midW));
      const mid = img.crop({ x: midX, y, width: midW, height: barH });
      const rightX = Math.max(0, sz.width - Math.round(470 * scale));
      const right = img.crop({ x: rightX, y, width: sz.width - rightX, height: barH });
      const up = (im, k) => im.resize({ width: im.getSize().width * k, height: im.getSize().height * k, quality: 'best' });
      fs.writeFileSync(path.join(LOG, 'icon-taskbar-left.png'), up(left, 3).toPNG());
      fs.writeFileSync(path.join(LOG, 'icon-taskbar-mid.png'), up(mid, 2).toPNG());
      fs.writeFileSync(path.join(LOG, 'icon-taskbar-right.png'), up(right, 3).toPNG());
      out.taskbar = { barH, leftW: left.getSize().width, midX, rightX };

      // 托盘实例是否真的建起来了（Win11 默认把新图标收进「隐藏的图标」溢出区）
      if (ctx.tray) {
        try {
          const tb = ctx.tray.getBounds();
          out.tray = { bounds: tb, visible: tb.width > 0 && tb.height > 0 };
          if (tb.width > 0) {
            const pad = 6;
            const r = {
              x: Math.max(0, Math.round((tb.x - disp.bounds.x - pad) * scale)),
              y: Math.max(0, Math.round((tb.y - disp.bounds.y - pad) * scale)),
              width: 0,
              height: 0,
            };
            r.width = Math.min(Math.round((tb.width + pad * 2) * scale), sz.width - r.x);
            r.height = Math.min(Math.round((tb.height + pad * 2) * scale), sz.height - r.y);
            const im2 = img.crop(r);
            fs.writeFileSync(path.join(LOG, 'icon-tray-zoom.png'), up(im2, 6).toPNG());
            out.trayCrop = r;
          }
        } catch (err) {
          out.tray = { err: String(err && err.message) };
        }
      }

      // 3) 资源自检（与 main.js 同一套读法）
      const probe = (f) => {
        const im = nativeImage.createFromBuffer(fs.readFileSync(path.join(ROOT, 'src', 'assets', f)));
        return { file: f, empty: im.isEmpty(), size: im.getSize() };
      };
      out.assets = ['icon.png', 'tray.png'].map(probe);
      out.ok = true;
    } catch (err) {
      out.err = String((err && err.stack) || err);
    }
    out.lines = lines;
    fs.writeFileSync(path.join(LOG, 'icon-e2e.json'), JSON.stringify(out, null, 1), 'utf8');
    fs.writeFileSync(path.join(LOG, 'icon-done'), 'ok', 'utf8');
  })();
};
