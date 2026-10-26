/* ==================================================================
   e2e-side.js —— 侧栏（目录）宽度拖拽 + 点外部收起的回归探针
   ------------------------------------------------------------------
   跑法（在项目根目录）：
     $env:MOYU_E2E_SIDE='1'; npx electron . --dev
   产出：.shots/side.json、.shots/side-done
   要点：
   - 必须先 undock + pin，否则 body.strip-mode 下尺寸全为 0（历史坑）
   - 窗口宽度要 > 900px 断点，侧栏才是「常驻」而不是抽屉
   - 拖拽用 dispatchEvent 造 MouseEvent：handler 不校验 isTrusted，够用
   ================================================================== */
'use strict';

module.exports = (win, fs) => {
  const path = require('path');
  const { desktopCapturer, screen } = require('electron');

  const ROOT = path.join(__dirname, '..');
  const LOG = path.join(ROOT, '.shots');
  const BOOK = 'C:\\Users\\ch\\Documents\\凡人修仙传.txt';

  const js = (code) => win.webContents.executeJavaScript(code, true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lines = [];

  win.webContents.on('console-message', (_e, level, message, lineNo) => {
    if (level >= 2) lines.push(`[console:${level}] ${message} @${lineNo}`);
  });

  const snap = () =>
    js(`(()=>{
      const side = document.querySelector('#reader-side');
      const grip = document.querySelector('#side-resizer');
      const stage = document.querySelector('#reader-stage');
      const gs = grip ? getComputedStyle(grip) : null;
      return {
        sideW: side ? Math.round(side.getBoundingClientRect().width) : -1,
        sideCollapsed: side ? side.classList.contains('collapsed') : null,
        tocBtnOn: !!document.querySelector('#btn-toc') && document.querySelector('#btn-toc').classList.contains('on'),
        gripDisplay: gs ? gs.display : 'no-grip',
        stageW: stage ? Math.round(stage.clientWidth) : -1,
        inlineVar: document.documentElement.style.getPropertyValue('--side-w'),
        computedVar: getComputedStyle(document.documentElement).getPropertyValue('--side-w').trim(),
        tocActive: document.querySelectorAll('#pane-toc .toc-item.active').length,
        flow: window.__flowDebug ? window.__flowDebug() : null,
      };
    })()`);

  async function shot(name) {
    // 截图前必须把窗口提到最前：否则抓到的是盖在上面的别的窗口
    try { win.show(); win.focus(); win.moveTop(); } catch { /* 忽略 */ }
    await sleep(400);
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
    if (!src) return null;
    const img = src.thumbnail;
    const sz = img.getSize();
    const scale = sz.width / disp.size.width;
    const rect = {
      x: Math.max(0, Math.round((b.x - disp.bounds.x) * scale)),
      y: Math.max(0, Math.round((b.y - disp.bounds.y) * scale)),
      width: 0,
      height: 0,
    };
    rect.width = Math.min(Math.round(b.width * scale), sz.width - rect.x);
    rect.height = Math.min(Math.round(b.height * scale), sz.height - rect.y);
    fs.writeFileSync(path.join(LOG, `${name}.png`), img.crop(rect).toPNG());
    return { name, rect };
  }

  setTimeout(async () => {
    const out = { steps: [] };
    try {
      fs.mkdirSync(LOG, { recursive: true });
      if (!fs.existsSync(BOOK)) throw new Error('找不到示例书：' + BOOK);

      // 窗口：居中、宽 1100（>900 断点 → 侧栏常驻）
      const wa = screen.getPrimaryDisplay().workArea;
      const width = Math.min(1100, wa.width - 100);
      const height = Math.min(780, wa.height - 100);
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

      // 导入书 + 重载 + 打开
      await js(`window.moyu.library.importPaths([${JSON.stringify(BOOK)}])`);
      await js('location.reload(); 1');
      await sleep(2400);
      // 先记下真实设置里的原始宽度：store 目录固定为 %APPDATA%/desk-chill，
      // --user-data-dir 对 settings 无效，跑完必须写回，否则会留下测试残留。
      out.origSideWidth = (await js(`window.moyu.settings.get()`)).sideWidth;
      await js(`(()=>{const c=document.querySelector('.book'); if(c) c.click(); return c?'ok':'no-card'})()`);
      const d1 = Date.now() + 30000;
      while (Date.now() < d1) {
        const ok = await js(`(()=>{const m=document.querySelector('#reader-loading');
          const f=document.querySelector('#txt-flow');
          return !!m && m.hidden && f && f.children.length>0;})()`);
        if (ok) break;
        await sleep(150);
      }
      await sleep(900);
      out.bounds = win.getBounds();
      out.steps.push({ name: '0-baseline', ...(await snap()) });

      // ---- 1) 拖动右边缘 +180px ----
      await js(`(()=>{
        const grip = document.querySelector('#side-resizer');
        if (!grip) return 'no-grip';
        const r = grip.getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + Math.min(120, r.height / 2));
        grip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0 }));
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x + 60, clientY: y }));
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x + 120, clientY: y }));
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x + 180, clientY: y }));
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x + 180, clientY: y }));
        return 'dragged';
      })()`);
      await sleep(700);
      const afterDrag = await snap();
      out.steps.push({ name: '1-dragged+180', ...afterDrag });
      out.settingsAfterDrag = await js(`window.moyu.settings.get()`);

      // ---- 2) 拖到超上限（应被 clamp） ----
      await js(`(()=>{
        const grip = document.querySelector('#side-resizer');
        const r = grip.getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + Math.min(120, r.height / 2));
        grip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0 }));
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x + 2000, clientY: y }));
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x + 2000, clientY: y }));
        return 1;
      })()`);
      await sleep(600);
      out.steps.push({ name: '2-clamp-max', ...(await snap()) });

      // ---- 3) 点正文（侧栏外）→ 应收起 ----
      await js(`(()=>{
        const flowEl = document.querySelector('#txt-flow');
        const r = flowEl.getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + r.height / 2);
        flowEl.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
        return 1;
      })()`);
      await sleep(600);
      out.steps.push({ name: '3-click-stage-collapse', ...(await snap()) });

      // ---- 4) 重新打开侧栏 ----
      await js(`(()=>{document.querySelector('#btn-toc').click(); return 1})()`);
      await sleep(600);
      out.steps.push({ name: '4-reopen-side', ...(await snap()) });

      // ---- 5) 双击手柄恢复默认宽度 ----
      await js(`(()=>{
        const grip = document.querySelector('#side-resizer');
        const r = grip.getBoundingClientRect();
        grip.dispatchEvent(new MouseEvent('dblclick', {
          bubbles: true, clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + 120),
        }));
        return 1;
      })()`);
      await sleep(800);
      out.steps.push({ name: '5-dblclick-reset', ...(await snap()) });
      out.settingsAfterReset = await js(`window.moyu.settings.get()`);

      // ---- 6) 窄窗口：手柄应隐藏（抽屉模式） ----
      win.setBounds({ x: win.getBounds().x, y: win.getBounds().y, width: 820, height: 700 });
      await sleep(900);
      out.steps.push({ name: '6-narrow-820', ...(await snap()) });
      out.shotNarrow = await shot('side-narrow');

      // 恢复宽窗口截图留证
      win.setBounds({ x: win.getBounds().x, y: win.getBounds().y, width: Math.min(1100, wa.width - 100), height: Math.min(780, wa.height - 100) });
      await sleep(900);
      // 窄→宽切换时侧栏被 onCompactChange 自动收起了，先点开再拖
      await js(`(()=>{const b=document.querySelector('#btn-toc'); if(!b.classList.contains('on')) b.click(); return 1})()`);
      await sleep(700);
      // 拖宽一点，让截图能看出宽度可变
      await js(`(()=>{
        const grip = document.querySelector('#side-resizer');
        const r = grip.getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + 140);
        grip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0 }));
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x + 110, clientY: y }));
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x + 110, clientY: y }));
        return 1;
      })()`);
      await sleep(800);
      out.steps.push({ name: '7-final-wide', ...(await snap()) });
      // 只为出图：跳到第 7 章（示例书开头是版权声明，不适合入镜）
      await js(`(()=>{const it=document.querySelectorAll('#pane-toc .toc-item'); if(it[6]) it[6].click(); return 1})()`);
      await sleep(1300);
      await js(`(()=>{const b=document.querySelector('#txt-pages'); if(b) b.scrollTop += 235; return 1})()`);
      await sleep(600);
      out.shotWide = await shot('side-wide');

      out.errors = lines;
      // 收尾：把真实设置恢复成测试前的宽度（见上方 origSideWidth 注释）
      try {
        await js(`window.moyu.settings.update({ sideWidth: ${Number(out.origSideWidth) || 0} })`);
        await sleep(300);
      } catch { /* 忽略 */ }
      fs.writeFileSync(path.join(LOG, 'side.json'), JSON.stringify(out, null, 1));
      fs.writeFileSync(path.join(LOG, 'side-done'), 'ok');
    } catch (err) {
      try {
        fs.mkdirSync(LOG, { recursive: true });
        fs.writeFileSync(path.join(LOG, 'side.json'), JSON.stringify({ err: String(err && err.stack), steps: out.steps, errors: lines }, null, 1));
        fs.writeFileSync(path.join(LOG, 'side-done'), 'error');
      } catch { /* 忽略 */ }
    }
  }, 2600);
};
