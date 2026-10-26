/* ==================================================================
   shots.js —— 生成 README 用的界面截图（MOYU_E2E_SHOTS=1 npx electron . --dev）
   ------------------------------------------------------------------
   为什么不用 capturePage()：本机强制 disable-gpu，capturePage 返回空白帧，
   而且它也不包含 WebContentsView（内置浏览器）这类原生子视图。
   所以统一走 desktopCapturer 整屏抓图，再按窗口 bounds 裁剪。
   产出：assets/screenshot-{library,reader,browser}.png
   ================================================================== */
'use strict';

module.exports = (win, fs) => {
  const path = require('path');
  const { desktopCapturer, screen } = require('electron');

  const ROOT = path.join(__dirname, '..');
  const OUT = path.join(ROOT, 'assets');
  const LOG = path.join(ROOT, '.shots');
  const BOOK = 'C:\\Users\\ch\\Documents\\凡人修仙传.txt';

  const js = (code) => win.webContents.executeJavaScript(code, true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lines = [];

  win.webContents.on('console-message', (_e, level, message, lineNo) => {
    if (level >= 2) lines.push(`[console:${level}] ${message} @${lineNo}`);
  });

  /** 抓整屏 → 按窗口 bounds 裁剪 → 写 PNG */
  async function shot(name) {
    const b = win.getBounds();
    const disp = screen.getDisplayMatching(b);
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
    const scale = sz.width / disp.size.width; // 物理像素 / DIP

    const rect = {
      x: Math.round((b.x - disp.bounds.x) * scale),
      y: Math.round((b.y - disp.bounds.y) * scale),
      width: Math.round(b.width * scale),
      height: Math.round(b.height * scale),
    };
    // 夹在图像范围内，避免越界裁剪报错
    rect.x = Math.max(0, Math.min(rect.x, sz.width - 40));
    rect.y = Math.max(0, Math.min(rect.y, sz.height - 40));
    rect.width = Math.min(rect.width, sz.width - rect.x);
    rect.height = Math.min(rect.height, sz.height - rect.y);

    const cropped = img.crop(rect);
    fs.writeFileSync(path.join(OUT, `${name}.png`), cropped.toPNG());
    return { name, imageSize: sz, crop: rect, scale, file: `${name}.png` };
  }

  setTimeout(async () => {
    const out = { steps: [], errors: lines };
    try {
      fs.mkdirSync(OUT, { recursive: true });
      fs.mkdirSync(LOG, { recursive: true });
      if (!fs.existsSync(BOOK)) throw new Error('找不到示例书：' + BOOK);

      // 1) 摆好窗口位置：离开屏幕边缘（否则贴边引擎立刻收起），并「固定展开」
      const wa = screen.getPrimaryDisplay().workArea;
      const width = Math.min(1180, wa.width - 120);
      const height = Math.min(800, wa.height - 120);
      win.setBounds({
        x: wa.x + Math.round((wa.width - width) / 2),
        y: wa.y + Math.round((wa.height - height) / 2),
        width,
        height,
      });
      win.show();
      win.focus();
      win.moveTop();
      await sleep(700);

      await js(`(async()=>{
        try { await window.moyu.dock.undock(); } catch(e){}
        await new Promise(r=>setTimeout(r,250));
        try { const s = await window.moyu.dock.state(); if (!s.pinned) await window.moyu.dock.togglePin(); } catch(e){}
        return 1;
      })()`);
      await sleep(900);
      out.bounds = win.getBounds();
      out.bodyClass = await js('document.body.className');

      // 2) 导入示例书（走真实 IPC，不碰真实书库/进度：这里用临时 user-data-dir 启动）
      const imported = await js(`window.moyu.library.importPaths([${JSON.stringify(BOOK)}])`);
      out.imported = Array.isArray(imported)
        ? imported.map((r) => ({ ok: r.ok, title: r.book && r.book.title, err: r.errType }))
        : imported;

      // 3) 重载渲染层让书库刷新（initLibrary 会 emit library:refresh）
      await js('location.reload(); 1');
      await sleep(2200);

      // 4) 打开书 → 阅读区截图（等正文块渲染出来）
      await js(`(()=>{const c=document.querySelector('.book'); if(c) c.click(); return c?'ok':'no-card'})()`);
      const d1 = Date.now() + 30000;
      while (Date.now() < d1) {
        const ok = await js(`(()=>{const m=document.querySelector('#reader-loading');
          const f=document.querySelector('#txt-flow');
          return !!m && m.hidden && f && f.children.length>0;})()`);
        if (ok) break;
        await sleep(150);
      }
      await sleep(800);

      // 跳到第 7 章（示例书开头的版权/来源信息不适合入镜）
      // 这本 txt 每个章节标题在原文里就写了两遍（h2 一次 + 原文一次），
      // 所以再多滚过 <h2>，让画面以原文那行标题开头，看起来才自然。
      await js(`(()=>{const it=document.querySelectorAll('#pane-toc .toc-item'); if(it[6]) it[6].click(); return it.length})()`);
      await sleep(1500);
      await js(`(()=>{const b=document.querySelector('#txt-pages'); b.scrollTop += 235; return 1})()`);
      await sleep(700);

      out.flow = await js('window.__flowDebug ? window.__flowDebug() : null');
      // 探针：找出「宽而矮、无文字、却带边框/底色」的元素（截图里的可疑空白框）
      out.ghosts = await js(`(()=>{
        const out=[];
        document.querySelectorAll('body *').forEach((n)=>{
          if (n.tagName === 'svg' || n.closest('svg')) return;
          const r = n.getBoundingClientRect();
          if (!(r.width > 200 && r.height > 3 && r.height < 40 && r.top > 0 && r.top < 240)) return;
          if (n.textContent.trim()) return;
          const cs = getComputedStyle(n);
          if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return;
          if (cs.borderTopWidth === '0px' && cs.backgroundColor === 'rgba(0, 0, 0, 0)') return;
          out.push({
            tag: n.tagName, id: n.id, cls: String(n.className),
            top: Math.round(r.top), left: Math.round(r.left),
            w: Math.round(r.width), h: Math.round(r.height),
            border: cs.borderTopWidth + ' ' + cs.borderTopColor,
            bg: cs.backgroundColor, pos: cs.position,
          });
        });
        return out.slice(0, 24);
      })()`);
      out.steps.push(await shot('screenshot-reader'));

      // 6) 浏览器：先试真站点，失败就留在新标签页（本地 home.html）
      await js(`(()=>{document.querySelector('#nav .nav-btn[data-view="browser"]').click(); return 1})()`);
      await sleep(1200);
      let navOk = false;
      try {
        await js(`window.moyu.browser.navigate('https://www.bing.com'); 1`);
        const d2 = Date.now() + 15000;
        while (Date.now() < d2) {
          const st = await js(`window.moyu.browser.debug()`);
          // 必须 visible=true：视图没显示出来时屏幕抓到的还是阅读页
          if (st && st.visible && st.url && /bing\.com/.test(st.url) && !st.loading) { navOk = true; break; }
          await sleep(400);
        }
        out.browserDebug = await js(`window.moyu.browser.debug()`);
      } catch (err) {
        lines.push('[browser] ' + String(err && err.message));
      }
      out.browserNav = navOk;
      await sleep(1800);
      out.steps.push(await shot('screenshot-browser'));

      out.errors = lines;
      fs.writeFileSync(path.join(LOG, 'shots.json'), JSON.stringify(out, null, 1));
      fs.writeFileSync(path.join(LOG, 'shots-done'), 'ok');
    } catch (err) {
      fs.writeFileSync(
        path.join(ROOT, '.shots', 'shots.json'),
        JSON.stringify({ err: String(err && err.stack), steps: out.steps, errors: lines }, null, 1),
      );
      fs.writeFileSync(path.join(ROOT, '.shots', 'shots-done'), 'error');
    }
  }, 2600);
};
