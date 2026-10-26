// 开发期端到端自检：仅在 MOYU_E2E=1 时由 main.js 加载。
// 用途：在没有人工点击的环境下跑通「导入 -> 阅读 -> 翻页 -> 续读 -> 浏览」并截图。
const path = require('node:path');

module.exports = (win, fs) => {
  const wc0 = win.webContents;
  wc0.on('console-message', (_e, level, message, line, source) => {
    console.log('[renderer]', level, source + ':' + line, message);
  });
  wc0.on('did-fail-load', (_e, code, desc, url) => {
    console.log('[renderer] did-fail-load', code, desc, url);
  });
  const shots = path.join('D:/app/reader', '.shots');
  if (!fs.existsSync(shots)) fs.mkdirSync(shots, { recursive: true });
  const log = (...a) => console.log('[e2e]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const shot = async (name) => {
    try {
      // disable-gpu 下 capturePage 经常返回滞后帧：先强制触发一次重绘
      // （宽高 +1/-1 抖动一次），再等两帧，然后截图。
      const b = win.getBounds();
      win.setBounds({ ...b, width: b.width + 1 });
      await sleep(120);
      win.setBounds({ ...b, width: b.width });
      await sleep(250);
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(shots, name + '.png'), img.toPNG());
      log('截图', name);
    } catch (e) {
      log('截图失败', name, e.message);
    }
  };
  const js = (code) => win.webContents.executeJavaScript(code, true);

  setTimeout(async () => {
    const wc = win.webContents;
    wc.on('console-message', (_e, level, message) => {
      if (level >= 1) log('renderer-console:', message);
    });
    try {
      await sleep(600);
      const probe = await js(`({moyu: typeof window.moyu, hook: typeof window.__moyuImport})`);
      log('探针', JSON.stringify(probe));
      log('导入三本测试书');
      const r = await js(`(async()=>{
        const res = await window.moyu.library.importPaths([
          'D:/app/reader/testdata/gbk.txt',
          'D:/app/reader/testdata/utf8-5mb.txt',
          'D:/app/reader/testdata/sample.pdf'
        ]);
        // 与真实路径一致地刷新书架：切走再切回会触发 refreshLibrary
        document.querySelector('#nav .nav-btn[data-view="settings"]').click();
        document.querySelector('#nav .nav-btn[data-view="library"]').click();
        return res.map(x=>({ok:x.ok,title:x.book&&x.book.title,err:x.errType||x.msg}));
      })()`);
      log('导入结果', JSON.stringify(r));
      await sleep(900);
      await shot('01-library');

      log('打开 GBK 书（验证编码）');
      // 直接点书架卡片打开（走真实交互路径）
      const clicked = await js(`(async()=>{
        const cards=[...document.querySelectorAll('.book')];
        const card=cards.find(c=>c.querySelector('.book-title').textContent==='gbk');
        if(!card) return 'card-missing';
        card.click();
        return 'clicked';
      })()`);
      log('点击卡片', clicked);
      await sleep(1200);
      const info = await js(`(()=>{
        const t=document.querySelector('#reader-title').textContent;
        const meta=document.querySelector('#reader-meta').textContent;
        const body=document.querySelector('#txt-flow').textContent.slice(0,120);
        const page=document.querySelector('#page-info').textContent;
        return {t,meta,body,page};
      })()`);
      log('阅读状态', JSON.stringify(info));
      await shot('02-reader-txt');

      // 翻页 & 检查进度落盘
      await js(`document.querySelector('#btn-next').click(); 1`);
      await sleep(400);
      await js(`document.querySelector('#btn-next').click(); 1`);
      await sleep(1600);
      const pg = await js(`document.querySelector('#page-info').textContent`);
      log('翻页后', pg);
      await shot('03-reader-page3');

      // 字号 + 主题
      await js(`document.querySelector('#fs-range').value=22; document.querySelector('#fs-range').dispatchEvent(new Event('input')); 1`);
      await js(`document.querySelector('#bg-swatches .sw[data-bg="sepia"]').click(); 1`);
      await sleep(700);
      await shot('04-reader-sepia22');

      // 搜索
      await js(`document.querySelector('#btn-find').click(); 1`);
      await sleep(300);
      await js(`(()=>{const i=document.querySelector('#find-input');i.value='的';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return 1})()`);
      await sleep(900);
      await shot('05-find');

      // 打开 PDF
      await js(`(()=>{const cards=[...document.querySelectorAll('.book')];return 1})()`);
      await js(`document.querySelector('#nav .nav-btn[data-view="library"]').click(); 1`);
      await sleep(500);
      const pdfClicked = await js(`(async()=>{
        const cards=[...document.querySelectorAll('.book')];
        const card=cards.find(c=>c.querySelector('.book-title').textContent==='sample');
        if(!card) return 'card-missing';
        card.click(); return 'clicked';
      })()`);
      log('打开 PDF', pdfClicked);
      await sleep(3000);
      const pdfInfo = await js(`(()=>{
        const meta=document.querySelector('#reader-meta').textContent;
        const pages=document.querySelectorAll('.pdf-page').length;
        const canvas=document.querySelectorAll('.pdf-page canvas').length;
        const toc=document.querySelectorAll('#pane-toc .toc-item').length;
        return {meta,pages,canvas,toc};
      })()`);
      log('PDF 状态', JSON.stringify(pdfInfo));
      await shot('06-reader-pdf');

      // 浏览器视图
      await js(`document.querySelector('#nav .nav-btn[data-view="browser"]').click(); 1`);
      await sleep(800);
      await shot('07-browser-home');

      // 设置视图
      await js(`document.querySelector('#nav .nav-btn[data-view="settings"]').click(); 1`);
      await sleep(500);
      await shot('08-settings');

      // 贴边条形态
      await js(`document.querySelector('#nav .nav-btn[data-view="library"]').click(); 1`);
      await js(`window.moyu.dock.dock('left'); 1`);
      await sleep(1200);
      await shot('09-docked-strip');
      const dockedBounds = win.getBounds();
      log('收起后 bounds', JSON.stringify(dockedBounds));
      await js(`window.moyu.dock.undock(); 1`);
      await sleep(1200);
      log('展开后 bounds', JSON.stringify(win.getBounds()));
      await shot('10-undocked');

      // 数据落盘检查
      const dataDir = path.join(win.webContents.getURL().startsWith('file') ? '' : '', '');
      log('E2E DONE');
      fs.writeFileSync('D:/app/reader/.e2e-done', 'ok');
    } catch (err) {
      log('E2E 异常', err && err.stack);
      fs.writeFileSync('D:/app/reader/.e2e-done', 'error');
    }
  }, 2600);

  /* ------------------------------------------------------------------ *
   * 大文件专项：15MB GBK《凡人修仙传》—— 曾经卡在「正在解析」
   * 判定标准：从点击到正文出现 < 6s，页码/目录合理，正文无乱码。
   * ------------------------------------------------------------------ */
  setTimeout(async () => {
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const big = 'C:/Users/ch/Documents/凡人修仙传.txt';
    if (!fs.existsSync(big)) {
      log('大文件用例跳过（文件不存在）');
      return;
    }
    try {
      log('--- 大文件用例 ---');
      const imported = await js(`(async()=>{
        const r = await window.moyu.library.importPaths([${JSON.stringify(big)}]);
        document.querySelector('#nav .nav-btn[data-view="settings"]').click();
        document.querySelector('#nav .nav-btn[data-view="library"]').click();
        return r.map(x=>({ok:x.ok,title:x.book&&x.book.title}));
      })()`);
      log('导入大文件', JSON.stringify(imported));
      await sleep(800);

      // 记录点击时刻，正文渲染完成后由页面回报耗时
      const result = await js(`(async()=>{
        const title = '凡人修仙传';
        const cards = [...document.querySelectorAll('.book')];
        const card = cards.find(c => c.querySelector('.book-title').textContent === title);
        if (!card) return { err: 'card-missing' };
        const t0 = performance.now();
        card.click();
        // 等「书名变成目标书」且遮罩隐藏且正文非空（三个条件缺一不可，
        // 只等遮罩会读到上一本书遗留的隐藏状态）
        const deadline = Date.now() + 25000;
        let ok = false;
        while (Date.now() < deadline) {
          const mask = document.querySelector('#reader-loading');
          const name = document.querySelector('#reader-title').textContent;
          const body = document.querySelector('#txt-flow').textContent || '';
          if (name === title && mask && mask.hidden && body.length > 200) { ok = true; break; }
          await new Promise(r => setTimeout(r, 50));
        }
        const ms = Math.round(performance.now() - t0);
        return {
          ms,
          ok,
          maskHidden: document.querySelector('#reader-loading').hidden,
          title: document.querySelector('#reader-title').textContent,
          meta: document.querySelector('#reader-meta').textContent,
          page: document.querySelector('#page-info').textContent,
          toc: document.querySelectorAll('#pane-toc .toc-item').length,
          bodyLen: (document.querySelector('#txt-flow').textContent || '').length,
          body: (document.querySelector('#txt-flow').textContent || '').slice(0, 80),
          hasGarbled: /[\\uFFFD]/.test(document.querySelector('#txt-flow').textContent || ''),
        };
      })()`);
      log('大文件阅读状态', JSON.stringify(result));
      // disable-gpu 下 capturePage 可能拿到滞后帧，先等几帧再截
      await sleep(1500);
      await shot('11-big-txt');

      // 直接跳最后一页，确认尾部也能正常渲染（不是只有首屏好）
      const tailJump = await js(`(async()=>{
        window.__readerGoto = true;
        const r = document.querySelector('#page-range');
        r.value = r.max;
        r.dispatchEvent(new Event('change'));
        await new Promise(r2 => setTimeout(r2, 400));
        return { page: document.querySelector('#page-info').textContent,
                 body: (document.querySelector('#txt-flow').textContent||'').slice(0,60) };
      })()`);
      log('大文件尾页', JSON.stringify(tailJump));
      await sleep(1200);
      await shot('12-big-txt-tail');
      fs.writeFileSync('D:/app/reader/.e2e-big-done', JSON.stringify(result, null, 1));

      // 目录跳转：点第 100 条
      const tocJump = await js(`(()=>{
        const items=[...document.querySelectorAll('#pane-toc .toc-item')];
        if(items.length < 100) return {err:'toc-too-few', n: items.length};
        const label = items[99].textContent;
        items[99].click();
        return {ok:true, label, page: document.querySelector('#page-info').textContent};
      })()`);
      log('目录跳转', JSON.stringify(tocJump));
      await sleep(1500);
      await shot('13-big-toc-jump');

      // 连贯滚动恢复验证：必须先离开屏幕边缘并「固定展开」，
      // 否则窗口处于 strip-mode（#content display:none），尺寸为 0 测不出滚动行为。
      try { win.setBounds({ x: 240, y: 110, width: 900, height: 780 }); } catch { /* 忽略 */ }
      await js(`(async()=>{
        try { await window.moyu.dock.undock(); } catch(e){}
        await new Promise(r=>setTimeout(r,250));
        try { const s = await window.moyu.dock.state(); if (!s.pinned) await window.moyu.dock.togglePin(); } catch(e){}
        return 1;
      })()`);
      await sleep(900);
      const flowRestore = await js(`(async()=>{
        const box = document.querySelector('#txt-pages');
        if (box.clientHeight < 50) return { err: 'no-height', clientH: box.clientHeight };
        // 定位到 42% 处再重开，验证「非首屏位置」也能精确还原
        const r = document.querySelector('#page-range');
        r.value = String(Math.floor(Number(r.max) * 0.42));
        r.dispatchEvent(new Event('change'));
        await new Promise(x=>setTimeout(x,500));
        const before = Math.round(box.scrollTop);
        const posBefore = (window.__flowDebug() || {}).position;
        await new Promise(x=>setTimeout(x,1400)); // 等 1s 节流的进度落盘
        const cards=[...document.querySelectorAll('.book')];
        const card=cards.find(c=>c.querySelector('.book-title').textContent==='凡人修仙传');
        if(!card) return {err:'card-missing'};
        card.click();
        const deadline=Date.now()+25000;
        while(Date.now()<deadline){
          const mask=document.querySelector('#reader-loading');
          const name=document.querySelector('#reader-title').textContent;
          if(mask && mask.hidden && name==='凡人修仙传') break;
          await new Promise(x=>setTimeout(x,50));
        }
        await new Promise(x=>setTimeout(x,800));
        const after = Math.round(box.scrollTop);
        const posAfter = (window.__flowDebug() || {}).position;
        return { before, after, driftPx: Math.abs(before-after), posBefore, posAfter,
                 driftChars: Math.abs((posBefore||0)-(posAfter||0)) };
      })()`);
      log('滚动位置恢复', JSON.stringify(flowRestore));
      result.flowRestore = flowRestore;
      fs.writeFileSync('D:/app/reader/.e2e-big-done', JSON.stringify(result, null, 1));
    } catch (err) {
      log('大文件用例异常', err && err.stack);
      fs.writeFileSync('D:/app/reader/.e2e-big-done', 'error: ' + (err && err.message));
    }
  }, 2600 + 30000);
};
