// 响应式布局专项自检（MOYU_E2E_LAYOUT=1）
// 把窗口调到多组「长/宽」，逐视图检查：
//   1) 没有横向溢出（scrollWidth > clientWidth 即为不合格）
//   2) 顶栏/底栏关键控件仍在可视区内
//   3) 阅读区宽度合理（侧栏抽屉不会挤掉正文）
// 截图落到 .shots/L-<尺寸>-<视图>.png（渲染层截图，不含原生视图）
const path = require('node:path');

module.exports = (win, fs) => {
  const shots = path.join('D:/app/reader', '.shots');
  if (!fs.existsSync(shots)) fs.mkdirSync(shots, { recursive: true });
  const log = (...a) => console.log('[e2e-l]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code, true);

  const shot = async (name) => {
    const b = win.getBounds();
    win.setBounds({ ...b, width: b.width + 1 });
    await sleep(100);
    win.setBounds({ ...b, width: b.width });
    await sleep(220);
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(shots, name + '.png'), img.toPNG());
    } catch (e) {
      log('截图失败', name, e.message);
    }
  };

  // 宽 x 高：覆盖默认窗口、窄长、宽扁、极小、最大
  const SIZES = [
    [1440, 900],
    [1100, 760],
    [950, 682],
    [820, 640],
    [700, 520],
    [620, 420],
    [520, 380],
    [1600, 420], // 超宽扁
  ];

  const probe = () => js(`(()=>{
    const de = document.documentElement;
    const vw = window.innerWidth, vh = window.innerHeight;
    const rect = (sel) => { const n=document.querySelector(sel); if(!n) return null;
      const r=n.getBoundingClientRect(); const cs=getComputedStyle(n);
      return { l:Math.round(r.left), t:Math.round(r.top), r:Math.round(r.right), b:Math.round(r.bottom),
               w:Math.round(r.width), h:Math.round(r.height), shown: cs.display!=='none' && r.width>0 }; };
    const overflowX = Math.max(de.scrollWidth, document.body.scrollWidth) - vw;
    // 找出越界的可见元素（右边超出视口 / 左边为负）
    const bad = [];
    document.querySelectorAll('#topbar *, #reader-toolbar > *, .reader-footer > *, .browser-bar > *, .view-head *').forEach((n)=>{
      const cs=getComputedStyle(n);
      if (cs.display==='none' || cs.visibility==='hidden') return;
      const r=n.getBoundingClientRect(); if (r.width===0 && r.height===0) return;
      if (r.right > vw + 1 || r.left < -1) bad.push((n.id||n.className||n.tagName)+':'+Math.round(r.left)+'~'+Math.round(r.right));
    });
    return {
      vw, vh, overflowX,
      view: ['library','reader','browser','settings'].find(v=>!document.querySelector('#view-'+v).hidden),
      topbar: rect('#topbar'), nav: rect('#nav'), winBtns: rect('.topbar-right'),
      footer: rect('.reader-footer'), stage: rect('#reader-stage'),
      side: document.querySelector('#reader-side') ? { ...rect('#reader-side'),
        pos: getComputedStyle(document.querySelector('#reader-side')).position,
        hidden: document.querySelector('#reader-side').classList.contains('collapsed') } : null,
      scrimShown: !document.querySelector('#reader-scrim').hidden,
      addr: rect('#addr'),
      cards: document.querySelectorAll('.settings-grid .card').length,
      shelfCols: getComputedStyle(document.querySelector('.shelf')).gridTemplateColumns.split(' ').length,
      bad: bad.slice(0, 5),
      dbg2: { vr: rect('#view-reader'), rb: rect('.reader-body'), rt: rect('.reader-toolbar'),
               stageDisplay: getComputedStyle(document.querySelector('#reader-stage')).display,
               bodyMin: getComputedStyle(document.querySelector('.reader-body')).minHeight,
               viewDisplay: getComputedStyle(document.querySelector('#view-reader')).display,
               bookOpen: !!window.__bookProbe },
      dbg: { bodyClass: document.body.className, appDisplay: getComputedStyle(document.querySelector('#app')).display,
             appW: document.querySelector('#app').offsetWidth,
             topbarDisplay: getComputedStyle(document.querySelector('#topbar')).display,
             topbarW: document.querySelector('#topbar').offsetWidth,
             topbarH: document.querySelector('#topbar').offsetHeight,
             docH: document.documentElement.clientHeight },
    };
  })()`);

  const check = (size, name, p) => {
    const issues = [];
    if (p.overflowX > 1) issues.push(`横向溢出 ${p.overflowX}px`);
    if (p.bad.length) issues.push(`越界元素 ${p.bad.join(' | ')}`);
    if (!p.topbar || !p.topbar.shown) issues.push('顶栏不可见');
    if (p.winBtns && p.winBtns.r > p.vw + 1) issues.push('窗口按钮超出右边界');
    if (name === 'reader' && p.stage && p.stage.w < Math.min(260, p.vw * 0.45)) {
      issues.push(`阅读区过窄 ${p.stage.w}px`);
    }
    if (name === 'browser' && p.addr && p.addr.w < 90) issues.push(`地址栏过窄 ${p.addr.w}px`);
    return issues;
  };

  setTimeout(async () => {
    const results = [];
    try {
      log('--- 响应式布局自检 ---');

      // 上次退出可能停在「边条模式」，此时 body.strip-mode 会隐藏整块 UI，
      // 所有元素宽度都是 0，必须先展开窗口再量。
      // 同时临时关掉边缘收纳：本用例只验证布局，不需要贴边逻辑插手窗口位置。
      try {
        await js(`window.moyu.settings.update({ edgeDockEnabled: false })`);
      } catch { /* 忽略 */ }
      try {
        await js(`window.moyu.dock.undock()`);
      } catch { /* 忽略 */ }
      await sleep(900);
      try {
        await js(`document.querySelector('#nav .nav-btn[data-view="library"]').click(); 1`);
      } catch { /* 忽略 */ }

      // 准备一本可读的书，并真正打开它——否则点「阅读」会按产品逻辑回退到书库，
      // 阅读区宽度自然是 0，会误报。
      try {
        await js(`window.moyu.library.importPaths(['D:/app/reader/testdata/gbk.txt'])`);
      } catch (e) { log('导入失败', e.message); }
      await sleep(700);
      try {
        // 切走再切回，触发 refreshLibrary，否则书库 DOM 还是空的
        await js(`document.querySelector('#nav .nav-btn[data-view="settings"]').click(); 1`);
        await sleep(200);
        await js(`document.querySelector('#nav .nav-btn[data-view="library"]').click(); 1`);
        await sleep(700);
        const opened = await js(`(()=>{const c=document.querySelector('.book');
          if(!c) return 'no-card'; c.click(); return 'clicked:' + c.querySelector('.book-title').textContent;})()`);
        log('打开书籍', opened);
        await sleep(1600);
      } catch (e) { log('打开书籍失败', e.message); }

      const views = ['library', 'reader', 'browser', 'settings'];
      for (const [w, h] of SIZES) {
        win.setBounds({ x: 40, y: 40, width: w, height: h });
        await sleep(420);
        for (const v of views) {
          await js(`document.querySelector('#nav .nav-btn[data-view="${v}"]').click(); 1`);
          await sleep(v === 'reader' ? 900 : 320);
          const p = await probe();
          const issues = check([w, h], v, p);
          const row = { size: `${w}x${h}`, view: v, issues, overflowX: p.overflowX, stageW: p.stage ? p.stage.w : null,
                        sidePos: p.side ? p.side.pos : null, cols: p.shelfCols };
          results.push(row);
          log(`${w}x${h} ${v}`, 'dbg=' + JSON.stringify(p.dbg2), 'tb=' + JSON.stringify(p.dbg), 'stage=' + (p.stage ? p.stage.w : '-') + '/' + (p.stage ? p.stage.h : '-'), 'vw=' + p.vw + 'x' + p.vh, 'topbarDisplay=' + (p.topbar ? p.topbar.shown : 'null'), issues.length ? 'FAIL: ' + issues.join('; ') : 'ok',
            `stage=${p.stage ? p.stage.w : '-'} side=${p.side ? p.side.pos : '-'} overflow=${p.overflowX}`);
          if (w === 520 || w === 1600 || (w === 950 && v === 'reader') || (w === 820 && v === 'reader')) {
            await shot(`L-${w}x${h}-${v}`);
          }

          // 窄窗口抽屉：点「目录」应浮出侧栏 + 遮罩，点遮罩应关闭
          if (w === 620 && v === 'reader') {
            const drawer = await js(`(async()=>{
              document.querySelector('#btn-toc').click();
              await new Promise(r=>setTimeout(r,260));
              const side = document.querySelector('#reader-side');
              const r = side.getBoundingClientRect();
              const open = { drawerW: Math.round(r.width), position: getComputedStyle(side).position,
                             scrim: !document.querySelector('#reader-scrim').hidden,
                             overlap: Math.round(r.right) };
              document.querySelector('#reader-scrim').click();
              await new Promise(r2=>setTimeout(r2,260));
              const closed = { collapsed: side.classList.contains('collapsed'),
                               scrim: !document.querySelector('#reader-scrim').hidden };
              return { open, closed };
            })()`);
            const ok = drawer.open.position === 'absolute' && drawer.open.drawerW > 150
              && drawer.open.scrim === true && drawer.closed.collapsed === true
              && drawer.closed.scrim === false;
            results.push({ size: `${w}x${h}`, view: 'drawer', issues: ok ? [] : ['抽屉行为异常: ' + JSON.stringify(drawer)],
                           overflowX: 0, stageW: null, sidePos: drawer.open.position, cols: null });
            log(`${w}x${h} 抽屉`, ok ? 'ok' : 'FAIL', JSON.stringify(drawer));
            if (!ok) {
              // 抽屉坏了要能被汇总统计到
              console.log('[e2e-l] drawer-fail', JSON.stringify(drawer));
            }
          }
        }
      }

      const failed = results.filter((r) => r.issues.length);
      fs.writeFileSync('D:/app/reader/.e2e-layout.json', JSON.stringify({ failed, results }, null, 1));
      fs.writeFileSync('D:/app/reader/.e2e-layout-done', failed.length ? 'fail' : 'ok');
      log(failed.length ? `FAILED ${failed.length}/${results.length}` : `ALL OK ${results.length}`);
    } catch (err) {
      log('异常', err && err.stack);
      fs.writeFileSync('D:/app/reader/.e2e-layout-done', 'error: ' + (err && err.message));
    }
  }, 2600);
};
