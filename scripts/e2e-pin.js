/* ==================================================================
   e2e-pin.js —— 窗口置顶（钉在最上层）探针
   ------------------------------------------------------------------
   跑法（在项目根目录）：
     $env:MOYU_E2E_PIN='1'; npx electron . --dev --user-data-dir=<临时目录>
   产出：.shots/pin.json、.shots/pin.png、.shots/pin-done

   验证：
   1) 顶栏图钉按钮能真的把窗口提到最上层（win.isAlwaysOnTop()）
   2) 状态会落盘到 settings.json，设置页复选框同步
   3) **置顶与贴边互斥**：
      · 置顶时贴边被拒（窗口不动、状态仍 NORMAL）
      · 取消置顶后贴边成功，且窗口不置顶
      · 贴边状态下开置顶 -> 自动展开（不会又贴屏幕外又置顶）
   4) 关掉后不会再残留 TOPMOST

   注意：store 的数据目录固定为 %APPDATA%/desk-chill（--user-data-dir 无效），
   所以这里会写真实设置，结束时必须把原值写回去。
   ================================================================== */
'use strict';

module.exports = (win, fs, api = {}) => {
  const path = require('path');
  const { app, screen, desktopCapturer } = require('electron');

  const ROOT = path.join(__dirname, '..');
  const LOG = path.join(ROOT, '.shots');
  const BASE = process.env.MOYU_DATA_DIR || path.join(app.getPath('appData'), 'desk-chill');
  const SETTINGS_FILE = path.join(BASE, 'data', 'settings.json');

  const js = (code) => win.webContents.executeJavaScript(code, true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lines = [];
  const checks = [];
  const check = (name, cond, extra) => {
    checks.push({ name, ok: !!cond, ...(cond ? {} : { extra: extra === undefined ? null : extra }) });
  };

  win.webContents.on('console-message', (_e, level, message, lineNo) => {
    if (level >= 2) lines.push(`[console:${level}] ${message} @${lineNo}`);
  });

  /** 读磁盘上的 settings.json：验证「置顶」是否真的持久化 */
  const readSettings = () => {
    try {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch {
      return null;
    }
  };

  const dockState = async () => (await js(`window.moyu.dock.state()`)).state;
  const setTop = (v) => js(`window.moyu.win.setAlwaysOnTop(${v ? 'true' : 'false'})`);

  async function shot(name) {
    try { win.show(); win.focus(); win.moveTop(); } catch { /* 忽略 */ }
    await sleep(350);
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
    return true;
  }

  setTimeout(async () => {
    const out = { checks, steps: [], settingsFile: SETTINGS_FILE };
    let orig = false;
    try {
      fs.mkdirSync(LOG, { recursive: true });

      const wa = screen.getPrimaryDisplay().workArea;
      const width = Math.min(980, wa.width - 120);
      const height = Math.min(720, wa.height - 120);
      win.setBounds({
        x: wa.x + Math.round((wa.width - width) / 2),
        y: wa.y + Math.round((wa.height - height) / 2),
        width,
        height,
      });
      win.show();
      win.focus();
      win.moveTop();
      await sleep(800);

      /* ---- 0) 基线 ---- */
      orig = api.settings ? !!api.settings.alwaysOnTop : false;
      out.orig = orig;
      out.before = { onTop: win.isAlwaysOnTop(), setting: orig };
      check('窗口起始置顶状态与存档一致', win.isAlwaysOnTop() === orig, out.before);
      check('顶栏存在图钉按钮', await js(`!!document.querySelector('#btn-pin')`));
      check('设置页存在置顶开关', await js(`!!document.querySelector('#s-alwaysOnTop')`));

      // 测试从「未置顶」开始，后面的断言才有意义
      if (orig) {
        await setTop(false);
        await sleep(400);
      }

      /* ---- 1) 点图钉 -> 置顶 ---- */
      await js(`document.querySelector('#btn-pin').click(); 1`);
      await sleep(500);
      out.afterClick = {
        window: win.isAlwaysOnTop(),
        setting: api.settings && api.settings.alwaysOnTop,
        disk: (readSettings() || {}).alwaysOnTop,
        btnOn: await js(`document.querySelector('#btn-pin').classList.contains('on')`),
        dockBlocked: await js(`document.querySelector('#btn-dock').classList.contains('blocked')`),
        title: await js(`document.querySelector('#btn-pin').title`),
      };
      check('点击后窗口真的在最上层', out.afterClick.window === true, out.afterClick.window);
      check('点击后内存设置=true', out.afterClick.setting === true, out.afterClick.setting);
      check('点击后已落盘 settings.json', out.afterClick.disk === true, out.afterClick.disk);
      check('按钮进入高亮态', out.afterClick.btnOn === true);
      check('按钮文案变为「取消置顶」', /取消置顶/.test(out.afterClick.title || ''), out.afterClick.title);
      check('贴边按钮进入不可用态（互斥提示）', out.afterClick.dockBlocked === true);

      /* ---- 2) 设置页同步（反向读） ---- */
      await js(`document.querySelector('#nav .nav-btn[data-view="settings"]').click(); 1`);
      await sleep(600);
      out.settingsViewChecked = await js(`document.querySelector('#s-alwaysOnTop').checked`);
      check('设置页复选框同步为勾选', out.settingsViewChecked === true, out.settingsViewChecked);
      await js(`document.querySelector('#nav .nav-btn[data-view="library"]').click(); 1`);
      await sleep(400);

      out.shot = await shot('pin');

      /* ---- 3) 互斥 A：置顶时贴边被拒 ---- */
      const boxBefore = win.getBounds();
      out.dockWhilePinned = { result: await js(`window.moyu.dock.dock('left')`) };
      await sleep(900);
      out.dockWhilePinned.state = await dockState();
      out.dockWhilePinned.bounds = win.getBounds();
      out.dockWhilePinned.onTop = win.isAlwaysOnTop();
      check('置顶时 dock 调用被拒绝', out.dockWhilePinned.result === false, out.dockWhilePinned.result);
      check('置顶时窗口没被收成边条', out.dockWhilePinned.state === 'NORMAL', out.dockWhilePinned);
      check(
        '置顶时窗口位置没动（没飞出屏幕）',
        out.dockWhilePinned.bounds.x === boxBefore.x && out.dockWhilePinned.bounds.y === boxBefore.y,
        { before: boxBefore, after: out.dockWhilePinned.bounds },
      );
      check('置顶状态没被贴边动作影响', out.dockWhilePinned.onTop === true);

      /* ---- 4) 互斥 B：取消置顶 -> 贴边成功且窗口不置顶 ---- */
      await setTop(false);
      await sleep(450);
      out.dockAfterUnpin = { result: await js(`window.moyu.dock.dock('left')`) };
      await sleep(900);
      out.dockAfterUnpin.state = await dockState();
      out.dockAfterUnpin.onTop = win.isAlwaysOnTop();
      check('取消置顶后可以贴边', out.dockAfterUnpin.state === 'DOCKED', out.dockAfterUnpin);
      check('贴边后窗口不置顶（互斥）', out.dockAfterUnpin.onTop === false, out.dockAfterUnpin);

      /* ---- 5) 互斥 C：贴边状态下开置顶 -> 自动展开 ---- */
      await setTop(true);
      await sleep(1200);
      out.pinWhileDocked = { state: await dockState(), onTop: win.isAlwaysOnTop() };
      check('贴边时开置顶会自动展开窗口', out.pinWhileDocked.state === 'NORMAL', out.pinWhileDocked);
      check('展开后仍保持置顶', out.pinWhileDocked.onTop === true, out.pinWhileDocked);

      /* ---- 6) 关掉置顶 ---- */
      await setTop(false);
      await sleep(500);
      out.afterOff = {
        window: win.isAlwaysOnTop(),
        setting: api.settings && api.settings.alwaysOnTop,
        disk: (readSettings() || {}).alwaysOnTop,
        btnOn: await js(`document.querySelector('#btn-pin').classList.contains('on')`),
        dockBlocked: await js(`document.querySelector('#btn-dock').classList.contains('blocked')`),
      };
      check('关闭后窗口不再置顶', out.afterOff.window === false, out.afterOff);
      check('关闭后设置=false 且已落盘', out.afterOff.setting === false && out.afterOff.disk === false, out.afterOff);
      check('关闭后按钮取消高亮', out.afterOff.btnOn === false, out.afterOff.btnOn);
      check('关闭后贴边按钮恢复可用', out.afterOff.dockBlocked === false, out.afterOff.dockBlocked);

      // 再拍一张「未置顶」态：用于核对两个新图标在正常颜色下是否清楚
      out.shotOff = await shot('pin-off');

      /* ---- 7) 主进程 API 直连（托盘菜单走的是同一条路） ---- */
      if (typeof api.setAlwaysOnTop === 'function') {
        const on = api.setAlwaysOnTop(true, 'e2e');
        check('主进程 setAlwaysOnTop(true) 生效', on === true && win.isAlwaysOnTop() === true);
        const off = api.setAlwaysOnTop(false, 'e2e');
        check('主进程 setAlwaysOnTop(false) 生效', off === false && win.isAlwaysOnTop() === false);
      }

      out.errors = lines;
      out.pass = checks.filter((c) => c.ok).length;
      out.fail = checks.filter((c) => !c.ok).length;

      // 收尾：恢复测试前的置顶状态（真实用户设置，不能留脏数据）
      try {
        await setTop(orig);
        await sleep(300);
      } catch { /* 忽略 */ }

      fs.writeFileSync(path.join(LOG, 'pin.json'), JSON.stringify(out, null, 1));
      fs.writeFileSync(path.join(LOG, 'pin-done'), out.fail ? 'fail' : 'ok');
    } catch (err) {
      try {
        fs.mkdirSync(LOG, { recursive: true });
        try {
          await setTop(orig);
        } catch { /* 忽略 */ }
        fs.writeFileSync(
          path.join(LOG, 'pin.json'),
          JSON.stringify({ err: String(err && err.stack), checks, errors: lines }, null, 1),
        );
        fs.writeFileSync(path.join(LOG, 'pin-done'), 'error');
      } catch { /* 忽略 */ }
    }
  }, 2800);
};
