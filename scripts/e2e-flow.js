// 临时探针：诊断 TXT 连贯滚动的尺寸/滚动状态（MOYU_E2E_FLOW=1）
// 跑完写 .flow-probe.json；用完即删。
'use strict';

module.exports = (win, fs) => {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lines = [];

  // 捕获渲染层报错（异常/警告都记下来，避免再次「静默失败」）
  win.webContents.on('console-message', (_e, level, message, lineNo, source) => {
    if (level >= 2) lines.push(`[console:${level}] ${message} @${source}:${lineNo}`);
  });

  const dump = () =>
    js(`(()=>{
      const box = document.querySelector('#txt-pages');
      const flowEl = document.querySelector('#txt-flow');
      const view = document.querySelector('#view-reader');
      const cs = getComputedStyle(box);
      const r = box.getBoundingClientRect();
      // 祖先链尺寸：定位「谁把高度吃掉了」
      const chain = [];
      let n = box;
      while (n && n !== document.documentElement) {
        const st = getComputedStyle(n);
        chain.push({
          id: n.id || n.className || n.tagName,
          ch: n.clientHeight, oh: n.offsetHeight,
          disp: st.display, pos: st.position, flex: st.flex, minH: st.minHeight, h: st.height,
        });
        n = n.parentElement;
      }
      return {
        bodyClass: document.body.className,
        viewHidden: view ? view.hidden : 'no-view',
        viewDisplay: view ? getComputedStyle(view).display : 'n/a',
        boxDisplay: cs.display,
        boxOverflow: cs.overflow,
        boxClientH: box.clientHeight,
        boxScrollH: box.scrollHeight,
        boxRectH: Math.round(r.height),
        boxScrollTop: Math.round(box.scrollTop),
        flowChildren: flowEl ? flowEl.children.length : -1,
        flowRectH: flowEl ? Math.round(flowEl.getBoundingClientRect().height) : -1,
        pageInfo: (document.querySelector('#page-info') || {}).textContent,
        pctInfo: (document.querySelector('#pct-info') || {}).textContent,
        flow: window.__flowDebug ? window.__flowDebug() : null,
        chain: box.clientHeight > 0 ? undefined : chain, // 只在尺寸异常时输出祖先链
      };
    })()`);

  setTimeout(async () => {
    const out = { steps: [], errors: lines };
    try {
      const bookTitle = '凡人修仙传';
      // 关键 1：窗口离开屏幕边缘，否则会被贴边引擎立刻重新收起（body.strip-mode）
      try { win.setBounds({ x: 240, y: 110, width: 900, height: 780 }); } catch { /* 忽略 */ }
      await sleep(600);
      // 关键 2：退出边条模式并「固定展开」——否则鼠标不在窗口上时，
      // 贴边引擎会按「临时展开」语义 500ms 后自动收回（body.strip-mode → 尺寸 0）
      await js(`(async()=>{
        try { await window.moyu.dock.undock(); } catch(e){}
        await new Promise(r=>setTimeout(r,250));
        try { const s = await window.moyu.dock.state(); if (!s.pinned) await window.moyu.dock.togglePin(); } catch(e){}
        return 1;
      })()`);
      await sleep(900);
      out.steps.push({ name: '0-ready', bodyClass: await js('document.body.className'), ...(await dump()) });

      // 从书库点卡片打开
      const clicked = await js(`(()=>{
        document.querySelector('#nav .nav-btn[data-view="library"]').click();
        const cards=[...document.querySelectorAll('.book')];
        const card=cards.find(c=>c.querySelector('.book-title').textContent===${JSON.stringify('凡人修仙传')});
        if(!card) return 'missing';
        card.click(); return 'ok';
      })()`);
      out.clicked = clicked;
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        const ok = await js(`(()=>{const m=document.querySelector('#reader-loading');
          return !!m && m.hidden && document.querySelector('#reader-title').textContent===${JSON.stringify('凡人修仙传')};})()`);
        if (ok) break;
        await sleep(100);
      }
      await sleep(500);
      out.steps.push({ name: '1-after-open', ...(await dump()) });

      // 整屏截图留证：capturePage 在本机（disable-gpu）会返回空白帧，只能整屏抓
      try {
        const { desktopCapturer, screen } = require('electron');
        const disp = screen.getPrimaryDisplay();
        const srcs = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: disp.size.width, height: disp.size.height },
        });
        if (srcs && srcs.length) fs.writeFileSync('D:/app/reader/.shots/flow-live.png', srcs[0].thumbnail.toPNG());
      } catch { /* 忽略 */ }

      // 程序化滚动 800px，看高度/进度是否跟随（触发顶部前插补偿）
      await js(`document.querySelector('#txt-pages').scrollTop = 800; 1`);
      await sleep(400);
      out.steps.push({ name: '2-scrolled-800', ...(await dump()) });

      // 滚到接近底部：应自动追加下一块（连贯阅读跨章的核心路径）
      const beforeAppend = await js(`(window.__flowDebug ? window.__flowDebug() : null)`);
      await js(`(()=>{const b=document.querySelector('#txt-pages');
        b.scrollTop = b.scrollHeight - b.clientHeight - 40; return 1})()`);
      await sleep(500);
      const afterAppend = await js(`(window.__flowDebug ? window.__flowDebug() : null)`);
      out.appendCheck = {
        beforeTo: beforeAppend && beforeAppend.to,
        afterTo: afterAppend && afterAppend.to,
        grew: !!(beforeAppend && afterAppend && afterAppend.to > beforeAppend.to),
      };
      out.steps.push({ name: '2b-near-bottom', ...(await dump()) });

      // 目录第 50 条
      await js(`(()=>{const it=document.querySelectorAll('#pane-toc .toc-item'); if(it[49]) it[49].click(); return 1})()`);
      await sleep(1200);
      out.steps.push({ name: '3-toc-50', ...(await dump()) });

      // 底部滑条拖到 50%
      await js(`(()=>{const r=document.querySelector('#page-range');
        r.value = String(Math.floor(Number(r.max)*0.5)); r.dispatchEvent(new Event('change')); return 1})()`);
      await sleep(1200);
      out.steps.push({ name: '4-slider-50', ...(await dump()) });

      // 等进度落盘 → 重开书 → 看是否还原
      await sleep(1500);
      const beforeReopen = await dump();
      await js(`(()=>{const cards=[...document.querySelectorAll('.book')];
        const card=cards.find(c=>c.querySelector('.book-title').textContent===${JSON.stringify('凡人修仙传')});
        card.click(); return 1})()`);
      const d2 = Date.now() + 25000;
      while (Date.now() < d2) {
        const ok = await js(`(()=>{const m=document.querySelector('#reader-loading'); return !!m && m.hidden;})()`);
        if (ok) break;
        await sleep(100);
      }
      await sleep(1200);
      out.steps.push({ name: '5-after-reopen', before: beforeReopen, ...(await dump()) });

      out.errors = lines;
      fs.writeFileSync('D:/app/reader/.flow-probe.json', JSON.stringify(out, null, 1));
      fs.writeFileSync('D:/app/reader/.flow-probe-done', 'ok');
    } catch (err) {
      fs.writeFileSync('D:/app/reader/.flow-probe.json', JSON.stringify({ err: String(err && err.stack), steps: out.steps, errors: lines }, null, 1));
      fs.writeFileSync('D:/app/reader/.flow-probe-done', 'error');
    }
  }, 2600);
};
