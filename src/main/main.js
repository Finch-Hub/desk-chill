'use strict';
/**
 * 主进程：应用生命周期 / 单窗口 / 托盘 / 老板键 / IPC / 内置浏览器 WebContentsView
 *
 * 分层原则（PRD 架构与可迁移性）：渲染进程不直接碰 Node，一切系统能力经 preload 白名单桥接。
 */
const { app, BrowserWindow, WebContentsView, globalShortcut, Tray, Menu, nativeImage, ipcMain, dialog, shell, screen, clipboard, protocol, net, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
// 注意别叫 net：electron 已经导入了 net（HTTP 客户端），重名会直接语法错误
const nodeNet = require('node:net');
const store = require('./store');
const bookLib = require('./book');
const { DockEngine } = require('./dock');
const { isWebUrl, classifyUrl } = require('./urlguard');

/* ------------------------------------------------------------------ *
 * 本机 GPU 兼容：图形环境创建共享上下文失败会导致 GPU 进程反复崩溃后秒退。
 * disable-gpu-sandbox 是关键开关（只关硬件加速不够）。阅读器/工具类 UI
 * 关 GPU 收益极小、稳定性收益极大。
 * ------------------------------------------------------------------ */
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');
/**
 * 关掉 QUIC(HTTP/3)。
 * 很多公司网/校园网/代理只放行 TCP 443，UDP 443 被丢弃时 Chromium 会先尝试 QUIC、
 * 等好几秒才回落到 TCP —— 用户感知就是「网页一直转圈打不开」。
 */
app.commandLine.appendSwitch('disable-quic');
/**
 * Windows 上让 Chromium 也读 WinHTTP 代理。
 * 部分代理软件（Clash/v2rayN 的某些模式）只写 WinHTTP 不写 WinINET，
 * 结果浏览器能上网、Electron 却直连 → TLS 握手被重置（ERR_CONNECTION_RESET）。
 */
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('winhttp-proxy-resolver');
}

const isDev = process.argv.includes('--dev');
const HOME_URL_DEFAULT = 'file://' + path.join(__dirname, 'home.html').replace(/\\/g, '/');
/** 导航卡住多久算超时（毫秒）：网络被静默丢包时别让用户无限等 */
const NAV_TIMEOUT_MS = 15000;

/* ------------------------------------------------------------------ *
 * 主动导航超时（作用域：模块顶层，导航 / 重试 / 重载共用）
 *
 * 背景：本机网络策略会把部分域名「静默丢弃」——既不复位连接也不回 RST，
 * Chromium 自己要等很久才报 ERR_TIMED_OUT。用户看到的就是「一直转圈、
 * 打不开、连错误页都没有」。这里 15s 内没等到 did-stop-loading 就主动
 * stop 并抛超时错误页，让用户立刻拿到明确反馈。
 *
 * 注意：这几个定义必须在模块顶层。早先误写进 ensureBrowserView() 函数体，
 * 导致 browser:navigate / browser:retry 的 IPC handler 里引用时报
 * ReferenceError: armNavTimeout is not defined。
 * ------------------------------------------------------------------ */
let navTimeoutTimer = null;
/**
 * 超时是否已经由我们自己「宣布」过。
 * 超时时会主动 wc.stop()，Chromium 随即抛 did-fail-load(ERR_ABORTED)；
 * 这个标记用来把「超时引发的 abort」和「用户点了停止」区分开：
 * 前者已经发过超时错误页，后者什么都不该发。
 */
let navTimeoutFired = false;

function clearNavTimeout() {
  navTimeoutFired = false;
  if (navTimeoutTimer) {
    clearTimeout(navTimeoutTimer);
    navTimeoutTimer = null;
  }
}

function armNavTimeout(wc, rawUrl) {
  clearNavTimeout();
  navTimeoutTimer = setTimeout(() => {
    navTimeoutTimer = null;
    navTimeoutFired = true;
    try {
      // 已经加载完（或被销毁）就不必再判超时
      if (!wc || wc.isDestroyed() || !wc.isLoading()) {
        navTimeoutFired = false;
        return;
      }
      wc.stop(); // 触发 did-fail-load(ERR_ABORTED)，由 navTimeoutFired 兜住，不重复报错
    } catch {
      navTimeoutFired = false;
      return;
    }
    let host = rawUrl;
    try { host = new URL(rawUrl).hostname; } catch { /* 忽略 */ }
    store.logEvent('browse_nav_timeout', { urlDomain: host, timeoutMs: NAV_TIMEOUT_MS });
    if (win && !win.isDestroyed()) {
      win.webContents.send('browser:loading', { loading: false });
      win.webContents.send('browser:error', {
        code: -7, desc: 'ERR_TIMED_OUT', url: rawUrl, errType: 'net', timedOut: true,
      });
    }
  }, NAV_TIMEOUT_MS);
  // 别让这个计时器拖住进程退出
  if (typeof navTimeoutTimer.unref === 'function') navTimeoutTimer.unref();
}

/* ------------------------------------------------------------------ *
 * 自定义协议 app:// ：ES module 在 file:// 下会被 Chromium 以 CORS 拦截，
 * 必须挂一个「标准 + 支持.fetch」的 scheme 才能加载 module script。
 * ------------------------------------------------------------------ */
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

function registerAppProtocol() {
  const root = path.normalize(path.join(__dirname, '..'));
  protocol.handle('app', (request) => {
    try {
      const { pathname } = new URL(request.url);
      let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
      if (!rel) rel = 'renderer/index.html';
      const abs = path.normalize(path.join(root, rel));
      if (!abs.startsWith(root)) return new Response('forbidden', { status: 403 });
      return net.fetch('file://' + abs.split('\\').join('/'));
    } catch (err) {
      return new Response('bad request: ' + err.message, { status: 400 });
    }
  });
}

/* ------------------------------ 网络 / 代理 ------------------------------ */

/**
 * 应用代理设置到内置浏览器的会话。
 *  - system：跟随 Windows 系统代理（默认，Clash/公司代理开着系统代理就能用）
 *  - direct：强制直连（排查「代理把站点拦了」时用）
 *  - manual：手动填代理地址（代理软件只监听端口、没开系统代理时用）
 */
async function applyProxy(ses) {
  if (!ses) return;
  const mode = settings.proxyMode || 'system';
  try {
    if (mode === 'direct') {
      await ses.setProxy({ mode: 'direct' });
    } else if (mode === 'manual') {
      const rules = String(settings.proxyRules || '').trim();
      if (!rules) await ses.setProxy({ mode: 'system' });
      else await ses.setProxy({ proxyRules: rules, proxyBypassRules: '<local>' });
    } else {
      await ses.setProxy({ mode: 'system' });
    }
    store.logEvent('proxy_applied', { mode });
  } catch (err) {
    store.logEvent('proxy_failed', { mode, error: String(err && err.message) });
  }
}

/** 探测本机常见代理端口是否在监听（Clash / v2rayN / Shadowsocks 等的默认端口） */
const LOCAL_PROXY_PORTS = [7890, 7891, 1080, 10808, 10809, 1087, 8889, 8888, 8080, 33210];

function probePort(port, host = '127.0.0.1', timeout = 600) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* 忽略 */ }
      resolve(ok);
    };
    const socket = nodeNet.connect({ port, host });
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    setTimeout(() => finish(false), timeout);
  });
}

/** 并发探测本机代理端口，返回在监听的那些 */
async function findLocalProxies() {
  const flags = await Promise.all(LOCAL_PROXY_PORTS.map((p) => probePort(p)));
  return LOCAL_PROXY_PORTS.filter((_, i) => flags[i]);
}

/**
 * 一次 HEAD 请求，走指定 session（因此会应用该 session 的代理设置）。
 * 用于「网络诊断」：把「以为在用代理、实际直连」这类问题直接暴露出来。
 */
function probeUrl(ses, url, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'TIMEOUT' }), timeoutMs);
    try {
      const req = net.request({ method: 'HEAD', url, session: ses });
      req.on('response', (res) => finish({ ok: true, status: res.statusCode }));
      req.on('error', (err) => finish({ ok: false, error: String((err && err.message) || err) }));
      req.end();
    } catch (err) {
      finish({ ok: false, error: String((err && err.message) || err) });
    }
  });
}

/** 网络诊断：当前生效的代理 + 几个代表站点的连通性 */
async function runNetCheck() {
  const ses = session.fromPartition('persist:moyu');
  let proxy = 'DIRECT';
  try {
    proxy = await ses.resolveProxy('https://www.baidu.com/');
  } catch { /* 忽略 */ }
  const targets = ['https://www.baidu.com/', 'https://www.bing.com/', 'https://www.xiaohongshu.com/'];
  // 并行探测 + 5s 超时：串行最坏要 18s，用户会以为卡死
  const results = await Promise.all(
    targets.map((url) => probeUrl(ses, url, 5000).then((r) => ({ url, ...r }))),
  );
  store.logEvent('net_check', {
    proxy: String(proxy).slice(0, 60),
    ok: results.filter((r) => r.ok).length,
    total: results.length,
  });
  // 直连且全挂时，最可能的就是「本机有代理软件但没设系统代理」，
  // 顺手探测常见端口，前端可以一键切过去。
  const localProxies = await findLocalProxies();
  return { proxy, results, mode: settings.proxyMode || 'system', rules: settings.proxyRules || '', localProxies };
}

/** 清空内置浏览器的缓存/存储，用于「明明有网却打不开」的兜底 */async function clearBrowserCache() {
  const ses = session.fromPartition('persist:moyu');
  try {
    await ses.clearCache();
    await ses.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
    store.logEvent('browse_cache_cleared', {});
    return true;
  } catch (err) {
    store.logEvent('browse_cache_clear_failed', { error: String(err && err.message) });
    return false;
  }
}



/* ------------------------------ 外部协议拦截 ------------------------------ */

/** 同一种协议 1.5s 内只提示一次（页面常一次点出好几个链接） */
let lastBlock = { scheme: '', at: 0 };

/**
 * 拦截非网页协议（bytedance://、weixin://、mailto: 等），只回应用内提示，绝不交给系统。
 * 交给 shell.openExternal 会在 Windows 上弹出「获取打开此链接的应用 / Microsoft Store」，
 * 对摸鱼场景是硬伤：一个误点就跳出系统弹窗。
 */
function blockExternalUrl(raw, where) {
  const info = classifyUrl(raw);
  const now = Date.now();
  if (info.scheme === lastBlock.scheme && now - lastBlock.at < 1500) {
    return info;
  }
  lastBlock = { scheme: info.scheme, at: now };
  store.logEvent('browse_scheme_blocked', { scheme: info.scheme, where });
  if (win && !win.isDestroyed()) {
    win.webContents.send('browser:blocked', {
      url: String(raw || '').slice(0, 400),
      scheme: info.scheme,
      app: info.app,
    });
  }
  return info;
}

/* ------------------------------ 默认数据 ------------------------------ */

const DEFAULT_SETTINGS = {
  fontSize: 17,
  lineHeight: 1.8,
  bgPreset: 'white', // white | sepia | dark
  fontFamily: '',
  // TXT 阅读滚轮行为：scroll=连贯滚动（网页式，默认） / screen=整屏翻动
  wheelMode: 'scroll',
  dockEdge: 'left',
  dockPeek: 4,
  dockAnim: 300,
  autoDockOnLeave: false,
  edgeDockEnabled: true,
  // 内置浏览器网络：system=跟随系统代理（默认） / direct=直连 / manual=手动填
  proxyMode: 'system',
  proxyRules: '',
  // 信任证书错误（仅在明确知道自己在做什么时打开；公司代理做 HTTPS 中间人时需要）
  ignoreCertErrors: false,
  bossKey: 'F8',
  bossEnabled: true,
  launchAtStartup: false,
  homeUrl: HOME_URL_DEFAULT,
  quickSites: [
    { name: 'B站', url: 'https://www.bilibili.com' },
    { name: '小红书', url: 'https://www.xiaohongshu.com' },
    { name: '知乎', url: 'https://www.zhihu.com' },
    { name: '微博', url: 'https://weibo.com' },
    { name: '抖音', url: 'https://www.douyin.com' },
  ],
  importDir: '',
};
const DEFAULT_WINDOW = { bounds: null, dockMode: 'NORMAL', dockEdge: 'left' };

let settings = { ...DEFAULT_SETTINGS };
let windowState = { ...DEFAULT_WINDOW };
/** 书库条目（library.json）：bookId/title/filePath/format/size/lastOpenedAt/progressPercent */
let library = [];
/** 阅读进度（progress.json）：按 bookId 键控 */
let progress = {};

/* ------------------------------ 运行时对象 ------------------------------ */

/** @type {BrowserWindow|null} */
let win = null;
/** @type {DockEngine|null} */
let dock = null;
/** @type {Tray|null} */
let tray = null;
/** @type {WebContentsView|null} */
let browserView = null;
let browserBounds = { x: 0, y: 0, width: 0, height: 0 };
let browserVisible = false;
let lastView = 'library';
let quitting = false;
let trayHidden = false;
/** 浏览器视图最近一次被要求可见（渲染层切到浏览视图时为 true） */
let browserWanted = false;

/* ------------------------------ 数据加载与保存 ------------------------------ */

function loadAll() {
  settings = { ...DEFAULT_SETTINGS, ...store.readJson('settings', {}) };
  windowState = { ...DEFAULT_WINDOW, ...store.readJson('window', {}) };
  library = store.readJson('library', []);
  if (!Array.isArray(library)) library = [];
  progress = store.readJson('progress', {});
  if (!progress || typeof progress !== 'object') progress = {};
}

function saveSettings() {
  store.writeJson('settings', settings);
}
function saveWindowState() {
  store.writeJson('window', windowState);
}
function saveLibrary() {
  store.writeJson('library', library);
}
function saveProgress() {
  store.writeJson('progress', progress);
}

/* ------------------------------ 图标 ------------------------------ */

function appIcon(size = 64) {
  // 运行时绘制一个「书页 + 收纳条」图标，避免依赖外部图片资源
  const canvasSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
    <rect width="64" height="64" rx="14" fill="#2f6feb"/>
    <rect x="14" y="14" width="30" height="36" rx="4" fill="#ffffff"/>
    <rect x="20" y="22" width="18" height="3" rx="1.5" fill="#2f6feb" opacity="0.55"/>
    <rect x="20" y="30" width="18" height="3" rx="1.5" fill="#2f6feb" opacity="0.55"/>
    <rect x="20" y="38" width="12" height="3" rx="1.5" fill="#2f6feb" opacity="0.55"/>
    <rect x="46" y="14" width="5" height="36" rx="2.5" fill="#ffd166"/>
  </svg>`;
  return nativeImage.createFromDataURL(
    'data:image/svg+xml;base64,' + Buffer.from(canvasSvg).toString('base64'),
  );
}

/* ------------------------------ 窗口 ------------------------------ */

function defaultBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  const width = Math.min(1180, Math.round(wa.width * 0.66));
  const height = Math.min(800, Math.round(wa.height * 0.8));
  return {
    width,
    height,
    x: wa.x + Math.round((wa.width - width) / 2),
    y: wa.y + Math.round((wa.height - height) / 2),
  };
}

function sanitizeBounds(b) {
  if (!b) return null;
  const displays = screen.getAllDisplays();
  const visible = displays.some((d) => {
    const wa = d.workArea;
    return (
      b.x < wa.x + wa.width - 80 &&
      b.x + b.width > wa.x + 80 &&
      b.y < wa.y + wa.height - 60 &&
      b.y + b.height > wa.y + 40
    );
  });
  return visible ? b : null;
}

function createWindow() {
  const bounds = sanitizeBounds(windowState.bounds) || defaultBounds();

  win = new BrowserWindow({
    ...bounds,
    minWidth: 520,
    minHeight: 380,
    frame: false,
    show: false,
    backgroundColor: '#f6f7f9',
    title: '摸鱼一体',
    icon: appIcon(256),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      webviewTag: false,
      backgroundThrottling: false,
    },
  });

  win.loadURL('app://local/renderer/index.html');

  win.once('ready-to-show', () => {
    // 上次退出时处于贴边状态 -> 直接恢复贴边（PRD 停靠位置记忆）
    if (settings.edgeDockEnabled && windowState.dockMode === 'DOCKED') {
      dock.state = 'NORMAL';
      win.setBounds(bounds);
      dock.restoreBounds = { ...bounds };
      dock.dock(windowState.dockEdge || settings.dockEdge, 'restore');
    } else {
      win.show();
    }
  });

  win.on('maximize', () => notifyLayout());
  win.on('unmaximize', () => notifyLayout());
  win.on('resize', () => {
    notifyLayout();
    if (browserVisible) layoutBrowserView();
  });
  win.on('show', () => reapplyBrowserVisibility());
  win.on('restore', () => reapplyBrowserVisibility());

  win.on('close', (e) => {
    // 关闭 = 最小化到托盘（老板键同款语义），真正退出走托盘菜单
    if (!quitting) {
      e.preventDefault();
      hideToTray();
    }
  });

  win.on('closed', () => {
    win = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // 应用内新窗口：交给浏览视图新标签页
    if (/^https?:/i.test(url)) {
      win.webContents.send('browser:open-url', url);
      return { action: 'deny' };
    }
    // 非网页协议不再交给系统（否则 Windows 会弹「在 Store 中查找应用」）
    if (!isWebUrl(url)) blockExternalUrl(url, 'app-window');
    return { action: 'deny' };
  });

  // 防止渲染层被意外导航走
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) e.preventDefault();
  });

  // e2e 跑的时候不自动开 DevTools：它会往终端刷一堆自身报错
  // （Unknown VE context / Autofill.enable not found），容易被误认为应用故障。
  const runningE2E = process.env.MOYU_E2E || process.env.MOYU_E2E_BROWSER
    || process.env.MOYU_E2E_LAYOUT || process.env.MOYU_E2E_NET
    || process.env.MOYU_E2E_FLOW || process.env.MOYU_E2E_REAL;
  if (isDev && !runningE2E) win.webContents.openDevTools({ mode: 'detach' });
  if (isDev && process.env.MOYU_E2E) {
    try {
      require('../../scripts/e2e.js')(win, fs);
    } catch (err) {
      console.error('[e2e] 注入失败', err);
    }
  }
  if (isDev && process.env.MOYU_E2E_BROWSER) {
    try {
      require('../../scripts/e2e-browser.js')(win, fs);
    } catch (err) {
      console.error('[e2e-b] 注入失败', err);
    }
  }
  if (isDev && process.env.MOYU_E2E_LAYOUT) {
    try {
      require('../../scripts/e2e-layout.js')(win, fs);
    } catch (err) {
      console.error('[e2e-l] 注入失败', err);
    }
  }
  if (isDev && process.env.MOYU_E2E_REAL) {
    try {
      require('../../scripts/e2e-real-sites.js')(win, fs);
    } catch (err) {
      console.error('[real] 注入失败', err);
    }
  }
  if (isDev && process.env.MOYU_E2E_NET) {
    try {
      require('../../scripts/e2e-browser-audit.js')(win, fs);
    } catch (err) {
      console.error('[audit] 注入失败', err);
    }
  }
  if (isDev && process.env.MOYU_E2E_FLOW) {
    try {
      require('../../scripts/e2e-flow.js')(win, fs);
    } catch (err) {
      console.error('[flow] 注入失败', err);
    }
  }

  dock = new DockEngine(win, {
    enabled: settings.edgeDockEnabled,
    edge: windowState.dockEdge || settings.dockEdge,
    peek: settings.dockPeek,
    anim: settings.dockAnim,
    autoDockOnLeave: settings.autoDockOnLeave,
    logEvent: (ev, props) => store.logEvent(ev, props),
    onState: (snap) => {
      windowState.dockMode = snap.state;
      windowState.dockEdge = snap.edge;
      saveWindowState();
      if (win && !win.isDestroyed()) win.webContents.send('dock:state', snap);
      reapplyBrowserVisibility();
      rebuildTrayMenu();
    },
  });
}

function notifyLayout() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('win:layout', {
    maximized: win.isMaximized(),
    fullscreen: win.isFullScreen(),
  });
}

/* ------------------------------ 托盘与老板键 ------------------------------ */

function hideToTray() {
  if (!win || win.isDestroyed() || trayHidden) return;
  trayHidden = true;
  win.hide();
  reapplyBrowserVisibility();
  store.logEvent('boss_hide', { fromState: dock ? dock.state : 'NORMAL' });
  rebuildTrayMenu();
  if (win) win.webContents.send('app:tray', { hidden: true });
}

function restoreFromTray() {
  if (!win || win.isDestroyed()) return;
  trayHidden = false;
  if (dock && dock.state === 'DOCKED') {
    // 恢复到隐藏前最后状态（可能是贴边条）
    win.showInactive();
  } else {
    win.show();
    win.focus();
  }
  store.logEvent('boss_restore', { ts: Date.now(), toState: dock ? dock.state : 'NORMAL' });
  reapplyBrowserVisibility();
  rebuildTrayMenu();
  if (win) win.webContents.send('app:tray', { hidden: false });
}

function toggleBoss() {
  if (trayHidden) restoreFromTray();
  else hideToTray();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    {
      label: trayHidden ? '显示主窗口  (F8)' : '隐藏到托盘  (F8)',
      click: () => toggleBoss(),
    },
    { type: 'separator' },
    {
      label: '书库',
      click: () => {
        if (trayHidden) restoreFromTray();
        if (win) win.webContents.send('app:goto', 'library');
      },
    },
    {
      label: '浏览器',
      click: () => {
        if (trayHidden) restoreFromTray();
        if (win) win.webContents.send('app:goto', 'browser');
      },
    },
    ...(dock && dock.state === 'DOCKED'
      ? [
          {
            label: '展开窗口',
            click: () => {
              if (trayHidden) win.showInactive();
              dock.undock('tray');
            },
          },
        ]
      : []),
    { label: '设置', click: () => {
        if (trayHidden) restoreFromTray();
        if (win) win.webContents.send('app:goto', 'settings');
      } },
    { type: 'separator' },
    { label: '退出（需确认）', click: () => requestQuit() },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(trayHidden ? '摸鱼一体（已隐藏，F8 恢复）' : '摸鱼一体');
}

function createTray() {
  tray = new Tray(appIcon(32));
  rebuildTrayMenu();
  tray.on('click', () => toggleBoss());
}

function registerBossKey() {
  globalShortcut.unregisterAll();
  if (!settings.bossEnabled || !settings.bossKey) return { ok: true, skipped: true };
  let ok = false;
  try {
    ok = globalShortcut.register(settings.bossKey, toggleBoss);
  } catch {
    ok = false;
  }
  if (!ok) {
    store.logEvent('bosskey_conflict', { key: settings.bossKey });
    if (win) {
      win.webContents.send('toast', {
        type: 'error',
        msg: `${settings.bossKey} 已被其他应用占用，请到设置里更换老板键`,
      });
    }
  }
  return { ok, key: settings.bossKey };
}

/* ------------------------------ 退出 ------------------------------ */

async function requestQuit() {
  if (!win || win.isDestroyed()) {
    quitting = true;
    app.quit();
    return;
  }
  // 渲染层此刻可能正是 4px 边条（内容被隐藏），确认框挂在一个不可见的父窗口上
  // 会出现「看不见的对话框」，所以先把窗口展开再问。
  if (dock && dock.state === 'DOCKED') {
    await dock.undock('quit');
  }
  if (!win.isVisible()) win.show();

  // 先把渲染层内存里的进度落盘（渲染层会在收到 app:before-quit 后回写）
  try {
    win.webContents.send('app:before-quit');
    await new Promise((r) => setTimeout(r, 200));
    saveProgress();
    saveLibrary();
    saveSettings();
    if (dock && dock.state === 'NORMAL' && !win.isMaximized()) {
      windowState.bounds = win.getBounds();
      saveWindowState();
    }
  } catch (err) {
    store.logEvent('quit_blocked', { reason: String(err && err.message) });
    dialog.showMessageBoxSync(win, {
      type: 'error',
      title: '退出被阻止',
      message: '进度保存失败，已取消退出',
      detail: String(err && err.message) + '\n\n请重试，或点「继续使用」。',
      buttons: ['继续使用'],
    });
    return;
  }

  // 退出确认是原生模态框，鼠标会离开主窗口，期间暂停自动收起
  if (dock) dock.suspendAutoHide(120000);
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: '退出摸鱼一体',
    message: '确定退出吗？阅读进度会先保存。',
    buttons: ['退出', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });  if (response !== 0) return;

  quitting = true;
  store.logEvent('app_quit', { sessionDuration: Math.round((Date.now() - startedAt) / 1000) });
  app.quit();
}

/* ------------------------------ 内置浏览器 ------------------------------ */

function ensureBrowserView() {
  if (browserView) return browserView;
  browserView = new WebContentsView({
    webPreferences: {
      partition: 'persist:moyu', // 登录态在会话内保留（小红书扫码后刷新仍有效）
      contextIsolation: true,
      nodeIntegration: false,
      // 本机的图形/沙箱环境装不起 Chromium 的 renderer sandbox：
      // 开 sandbox:true 时这个子渲染进程一启动就 render-process-gone('crashed')，
      // 表现就是「浏览页面一片空白 / 页面崩溃」。主窗口本来就是 sandbox:false，
      // 这里保持一致；远程内容依旧拿不到 Node（nodeIntegration:false + contextIsolation）。
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  const wc = browserView.webContents;
  win.contentView.addChildView(browserView);
  browserView.setVisible(false);

  // 用真实 Chrome UA，去掉 Electron/应用名。
  // 部分站点（抖音、知乎等）的 WAF 会针对非标准 UA 直接重置连接，
  // 表现就是「一直转圈 / ERR_CONNECTION_RESET」，排查起来很费劲。
  const chromeMajor = (process.versions.chrome || '120').split('.')[0];
  const uaPlatform = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
  const CHROME_UA = `Mozilla/5.0 (${uaPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
  try {
    wc.setUserAgent(CHROME_UA);
  } catch { /* 忽略 */ }
  // 代理设置（跟随系统 / 直连 / 手动）在会话层生效
  applyProxy(wc.session);

  const send = (ch, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(ch, payload);
  };
  const domainOf = (url) => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  };

  wc.on('did-start-loading', () => send('browser:loading', { loading: true }));
  // 加载全程正常结束时撤掉超时计时器（超时逻辑本身在模块顶层的 armNavTimeout）
  wc.on('did-stop-loading', () => {
    clearNavTimeout();
    send('browser:loading', { loading: false });
  });
  wc.on('did-navigate', (_e, url) => {
    clearNavTimeout();
    send('browser:navigated', { url, canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward() });
    store.logEvent('browse_nav', { urlDomain: domainOf(url) });
  });
  wc.on('did-navigate-in-page', (_e, url) => {
    send('browser:navigated', { url, canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward() });
  });
  wc.on('page-title-updated', (_e, title) => send('browser:title', { title }));
  wc.on('page-favicon-updated', (_e, icons) => send('browser:favicon', { icons }));
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    // -3 ERR_ABORTED：加载被主动打断。
    //   · 超时路径：armNavTimeout 已经发过超时错误页 → 这里什么都不做
    //   · 用户点停止 / 中途换页 → 也不该弹错误页
    // 两种情况都直接 return，只是要把计时器清掉。
    if (code === -3) {
      clearNavTimeout();
      return;
    }
    clearNavTimeout();
    const errType = /CERT/i.test(desc) ? 'cert' : 'net';
    store.logEvent('browse_error', { urlDomain: domainOf(url), errType, code });
    send('browser:error', { code, desc, url, errType });
  });
  wc.on('render-process-gone', (_e, details) => {
    store.logEvent('page_crash', { reason: details.reason });
    send('browser:crash', { reason: details.reason });
  });
  /**
   * 证书错误必须显式给回调。
   * 早先只写了 e.preventDefault() 却没调 callback —— Electron 会一直等这个回调，
   * 于是页面既不加载也不报错，表现为「一直转圈打不开」（公司代理做 HTTPS 中间人时几乎必现）。
   * 现在的策略：默认拒绝（安全），用户可在设置里显式信任；
   * 拒绝会走 did-fail-load(ERR_CERT_*)，前端展示「无法建立安全连接」并有重试入口。
   */
  wc.on('certificate-error', (event, url, error, certificate, callback) => {
    if (settings.ignoreCertErrors) {
      event.preventDefault();
      store.logEvent('cert_trusted', { host: domainOf(url), error });
      callback(true);
      return;
    }
    store.logEvent('cert_rejected', { host: domainOf(url), error });
    callback(false);
  });

  wc.setWindowOpenHandler(({ url }) => {
    // 只让真正的网页进新标签页；bytedance:// / weixin:// 这类交给客户端协议的
    // 一律拦下并提示，绝不 shell.openExternal（会触发系统「找不到应用」弹窗）
    if (isWebUrl(url)) send('browser:open-url', url);
    else blockExternalUrl(url, 'window-open');
    return { action: 'deny' };
  });

  /**
   * 页面里的 <a href="bytedance://..."> 或 JS 直接改 location 走的是导航，
   * 不是 window.open，必须在这里也拦一道；否则 Chromium 仍会交给系统协议处理器。
   */
  const guardNav = (where) => (event, url) => {
    const target = url || (event && event.url);
    if (!target) return;
    if (isWebUrl(target)) return;
    // 不同 Electron 版本的导航事件签名不完全一致（有的把参数收进 details 对象），
    // 这里两种情况都兜住，避免在 preventDefault 上抛错。
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    blockExternalUrl(target, where);
  };
  wc.on('will-navigate', guardNav('will-navigate'));
  wc.on('will-redirect', guardNav('will-redirect'));
  // 子 frame 的导航（Electron 32+）。两种参数形态都兼容
  wc.on('will-frame-navigate', guardNav('will-frame-navigate'));

  /**
   * 焦点在网页里时，渲染层收不到键盘事件：Esc 回阅读、Ctrl+L 定位地址栏这些
   * 都会失效（用户感受就是「浏览器控件点不动/快捷键没反应」）。
   * 这里把常用快捷键从网页这一侧转发给渲染层处理。
   */
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '').toLowerCase();
    const ctrl = input.control || input.meta;
    const cmds = {
      escape: 'escape',
      f5: 'reload',
    };
    if (!ctrl && cmds[key]) {
      event.preventDefault();
      send('browser:command', { cmd: cmds[key] });
      return;
    }
    if (ctrl && !input.alt) {
      const map = { l: 'focus-addr', t: 'new-tab', w: 'close-tab', f: 'find', r: 'reload' };
      if (map[key]) {
        event.preventDefault();
        send('browser:command', { cmd: map[key] });
      }
    }
  });

  return browserView;
}

function layoutBrowserView() {
  if (!browserView || !win || win.isDestroyed()) return;
  // 隐藏时用零尺寸裁剪：只改 bounds + 隐藏，不销毁视图，
  // 切回阅读时网页会话、播放进度都还在，也不会有原生层盖住渲染层。
  if (!browserVisible || browserBounds.width < 2 || browserBounds.height < 2) {
    browserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    browserView.setVisible(false);
    return;
  }
  browserView.setVisible(true);
  browserView.setBounds(browserBounds);
}

function showBrowser(show) {
  if (!win || win.isDestroyed()) return;
  browserWanted = !!show;
  if (browserWanted) ensureBrowserView();
  // 必须走统一的门控：窗口收起为边条 / 在托盘时不能把原生视图放出来
  reapplyBrowserVisibility();
}

/** 所有系统原生视图显隐都必须同时考虑「当前是否为浏览视图」与「窗口是否收起为边条」 */
function reapplyBrowserVisibility() {
  if (!browserView) return;
  const stripMode = !!dock && dock.state === 'DOCKED';
  browserVisible = browserWanted && !stripMode && !trayHidden;
  layoutBrowserView();
}

/* ------------------------------ 书库与文件 ------------------------------ */

function pickFiles() {
  // 原生文件对话框是独立窗口，鼠标会离开主窗口：期间暂停「移开自动收起」
  if (dock) dock.suspendAutoHide(60000);
  const res = dialog.showOpenDialogSync(win, {
    title: '导入书籍',
    defaultPath: settings.importDir && fs.existsSync(settings.importDir) ? settings.importDir : undefined,
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '电子书 (TXT / PDF)', extensions: ['txt', 'pdf'] },
      { name: '文本文件', extensions: ['txt'] },
      { name: 'PDF 文件', extensions: ['pdf'] },
    ],
  });
  // 对话框关闭后再留 1.2s 余量，避免鼠标还在移动的瞬间被收起
  if (dock) dock.suspendAutoHide(1200);
  if (!res || !res.length) return [];
  settings.importDir = path.dirname(res[0]);
  saveSettings();
  return res;
}

function makeId(p) {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${Buffer.from(p).length}`;
}

function importPaths(paths) {
  const results = [];
  for (const p of paths) {
    const ext = path.extname(p).toLowerCase();
    try {
      if (!bookLib.isSupported(p)) {
        results.push({ ok: false, path: p, errType: 'format', msg: '不支持的格式（仅 TXT / PDF）' });
        store.logEvent('book_import_fail', { format: ext, errType: 'format' });
        continue;
      }
      if (!fs.existsSync(p)) {
        results.push({ ok: false, path: p, errType: 'missing', msg: '文件不存在' });
        store.logEvent('book_import_fail', { format: ext, errType: 'missing' });
        continue;
      }
      const stat = fs.statSync(p);
      if (ext === '.pdf') {
        // 只做文件头校验，真正的解析错误会在渲染层 pdf.js 打开时报出
        const head = fs.readFileSync(p).subarray(0, 1024).toString('latin1');
        if (head.indexOf('%PDF-') === -1) throw Object.assign(new Error('PDF 文件已损坏'), { code: 'E_PDF_INVALID' });
      }
      const existing = library.find((b) => b.filePath === p);
      const book = existing || {
        bookId: makeId(p),
        title: path.basename(p, ext),
        filePath: p,
        format: ext.slice(1),
        size: stat.size,
        lastOpenedAt: null,
        progressPercent: 0,
        addedAt: Date.now(),
      };
      book.size = stat.size;
      book.mtime = stat.mtimeMs;
      book.missing = false;
      if (!existing) library.unshift(book);
      store.logEvent('book_import_ok', { format: book.format, size: book.size });
      results.push({ ok: true, path: p, book });
    } catch (err) {
      const errType = err && err.code === 'E_PDF_INVALID' ? 'pdf' : 'read';
      store.logEvent('book_import_fail', { format: ext, errType });
      results.push({ ok: false, path: p, errType, msg: err.message || '无法打开' });
    }
  }
  saveLibrary();
  return results;
}

/**
 * @param {string} bookId
 * @param {string} [forcedEncoding]
 * @param {{withText?: boolean}} [opts] false 时只返回元信息（两段式加载的首段）
 */
function readBook(bookId, forcedEncoding, opts = {}) {
  const withText = opts.withText !== false;
  const book = library.find((b) => b.bookId === bookId);
  if (!book) {
    const e = new Error('书籍不在书库中');
    e.code = 'E_NOT_FOUND';
    throw e;
  }
  if (!fs.existsSync(book.filePath)) {
    book.missing = true;
    saveLibrary();
    store.logEvent('book_missing', { bookId });
    const e = new Error('文件已被移动或删除');
    e.code = 'E_MISSING';
    throw e;
  }
  book.lastOpenedAt = Date.now();
  book.size = fs.statSync(book.filePath).size;
  saveLibrary();
  store.logEvent('book_open', { bookId, format: book.format, size: book.size, withText });

  if (book.format === 'pdf') {
    const buf = fs.readFileSync(book.filePath);
    return {
      bookId,
      format: 'pdf',
      title: book.title,
      size: book.size,
      data: buf,
      progress: progress[bookId] || null,
    };
  }

  const t0 = Date.now();
  const data = bookLib.openTxt(book.filePath, forcedEncoding, { withText });
  if (data.needEncodingChoice) {
    store.logEvent('book_import_encoding', { format: 'txt', detected: data.encoding });
  }
  store.logEvent('book_parse', {
    format: 'txt',
    ms: Date.now() - t0,
    chars: data.totalChars,
    chapters: data.chapters.length,
    withText,
  });
  return {
    bookId,
    format: 'txt',
    title: book.title,
    size: data.size,
    encoding: data.encoding,
    needEncodingChoice: data.needEncodingChoice,
    totalChars: data.totalChars,
    pageCount: data.pageCount,
    chapters: data.chapters,
    text: data.text,
    progress: progress[bookId] || null,
  };
}

function touchRecent(bookId) {
  windowState.lastBookId = bookId;
  saveWindowState();
}

/** 内置首页文件（浏览器空白首页 / 断网错误页由渲染层绘制，这里只是引导页） */
function ensureHomeFile() {
  const p = path.join(__dirname, 'home.html');
  if (!fs.existsSync(p)) fs.writeFileSync(p, '<!doctype html><meta charset="utf-8"><title>新标签页</title>', 'utf8');
  return p;
}

/* ------------------------------ IPC ------------------------------ */

let startedAt = Date.now();

function registerIpc() {
  /* ---- 设置 ---- */
  ipcMain.handle('settings:get', () => settings);

  ipcMain.handle('settings:update', (_e, patch) => {
    const before = { ...settings };
    settings = { ...settings, ...patch };
    saveSettings();
    for (const k of Object.keys(patch)) {
      if (k === 'quickSites') continue;
      store.logEvent('settings_change', { key: k, value: patch[k] });
    }
    // 联动：贴边参数、老板键、开机自启
    if (dock && ('dockPeek' in patch || 'dockAnim' in patch || 'autoDockOnLeave' in patch || 'edgeDockEnabled' in patch)) {
      dock.update({
        enabled: settings.edgeDockEnabled,
        peek: settings.dockPeek,
        anim: settings.dockAnim,
        autoDockOnLeave: settings.autoDockOnLeave,
      });
    }
    if ('bossKey' in patch || 'bossEnabled' in patch) {
      const r = registerBossKey();
      settings.bossKeyConflict = !r.ok && !r.skipped;
      saveSettings();
    }
    if ('launchAtStartup' in patch) {
      try {
        app.setLoginItemSettings({ openAtLogin: !!settings.launchAtStartup, args: [] });
      } catch { /* 忽略 */ }
    }
    if ('homeUrl' in patch && browserView) {
      // 首页变更后不强制导航，下次新标签页生效
    }
    // 代理改动：立刻应用到浏览会话并重载，否则用户改完看不到效果
    if ('proxyMode' in patch || 'proxyRules' in patch) {
      applyProxy(session.fromPartition('persist:moyu')).then(() => {
        if (browserView && !browserView.webContents.isDestroyed()) {
          try { browserView.webContents.reload(); } catch { /* 忽略 */ }
        }
      });
    }
    // 广播给渲染层：设置可能来自任何入口（设置页 / 命令行 / 外部调用），
    // 让常用站点、阅读默认值等依赖设置的 UI 都能同步刷新。
    if (win && !win.isDestroyed()) win.webContents.send('settings:changed', settings);
    return { settings, changed: Object.keys(patch).filter((k) => before[k] !== settings[k]) };
  });

  ipcMain.handle('settings:reset', () => {
    settings = { ...DEFAULT_SETTINGS, quickSites: [...DEFAULT_SETTINGS.quickSites] };
    saveSettings();
    dock && dock.update({
      enabled: settings.edgeDockEnabled,
      peek: settings.dockPeek,
      anim: settings.dockAnim,
      autoDockOnLeave: settings.autoDockOnLeave,
    });
    registerBossKey();
    return settings;
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    dataDir: store.DATA_DIR,
    logDir: store.logDir(),
    homeUrl: HOME_URL_DEFAULT,
    platform: process.platform,
    trayHidden,
  }));

  /* ---- 窗口控制 ---- */
  ipcMain.on('win:minimize', () => win && win.minimize());
  ipcMain.on('win:maximize-toggle', () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('win:close', () => win && win.close());
  ipcMain.on('win:boss', () => toggleBoss());
  ipcMain.handle('win:state', () => ({
    maximized: !!(win && win.isMaximized()),
    fullscreen: !!(win && win.isFullScreen()),
    trayHidden,
  }));

  /* ---- 贴边 ---- */
  ipcMain.handle('dock:state', () => (dock ? dock.snapshot() : { state: 'NORMAL' }));
  ipcMain.handle('dock:pin-toggle', () => (dock ? dock.togglePin() : false));
  ipcMain.handle('dock:undock', () => {
    if (dock) dock.undock('renderer');
    return true;
  });
  ipcMain.handle('dock:dock', (_e, edge) => {
    if (dock && dock.state === 'NORMAL') dock.dock(edge || settings.dockEdge, 'manual');
    return true;
  });
  ipcMain.handle('dock:apply', (_e, edge) => {
    if (!dock || !win) return false;
    if (dock.state === 'DOCKED') dock.undock('apply');
    setTimeout(() => dock.dock(edge, 'manual'), 180);
    return true;
  });

  /* ---- 视图切换 ---- */
  ipcMain.handle('view:set', (_e, view) => {
    lastView = view || 'library';
    // 离开浏览视图立刻收起原生视图；进入浏览视图时不要抢着显示，
    // 由渲染层根据「显示首页还是网页」再发 set-visible（否则首页会被盖住一下）。
    if (lastView !== 'browser') showBrowser(false);
    return true;
  });
  ipcMain.on('browser:bounds', (_e, rect) => {
    if (!rect) return;
    browserBounds = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    layoutBrowserView();
  });

  /* ---- 书库 ---- */
  ipcMain.handle('library:list', () => {
    // 每次返回前刷新「已移除」标记，避免显示过期的可读状态
    let dirty = false;
    for (const b of library) {
      const miss = !fs.existsSync(b.filePath);
      if (b.missing !== miss) {
        b.missing = miss;
        dirty = true;
      }
    }
    if (dirty) saveLibrary();
    return { books: library, lastBookId: windowState.lastBookId || null };
  });

  ipcMain.handle('library:pick', () => {
    const files = pickFiles();
    return files.length ? importPaths(files) : [];
  });

  ipcMain.handle('library:import-paths', (_e, paths) => importPaths(paths || []));

  ipcMain.handle('library:remove', (_e, bookId) => {
    library = library.filter((b) => b.bookId !== bookId);
    delete progress[bookId];
    saveLibrary();
    saveProgress();
    return library;
  });

  ipcMain.handle('library:rename', (_e, { bookId, title }) => {
    const b = library.find((x) => x.bookId === bookId);
    if (b && title) {
      b.title = String(title).slice(0, 120);
      saveLibrary();
    }
    return library;
  });

  ipcMain.handle('book:open', (_e, { bookId, encoding, metaOnly }) => {
    // metaOnly: 只取元信息（书名/页数/目录），正文由 book:text 单独取，
    // 避免超大 TXT 一次性结构化克隆十几 MB 字符串把首屏拖死。
    const data = readBook(bookId, encoding, { withText: !metaOnly });
    touchRecent(bookId);
    if (data.data) {
      // Buffer -> ArrayBuffer（结构化克隆，不经 base64，避免大文件翻倍）
      const ab = data.data.buffer.slice(data.data.byteOffset, data.data.byteOffset + data.data.byteLength);
      return { ...data, data: ab };
    }
    return data;
  });

  /** 两段式加载第二段：只返回正文纯文本 */
  ipcMain.handle('book:text', (_e, { bookId, encoding }) => {
    const book = library.find((b) => b.bookId === bookId);
    if (!book) {
      const e = new Error('书籍不在书库中');
      e.code = 'E_NOT_FOUND';
      throw e;
    }
    if (book.format !== 'txt' || !fs.existsSync(book.filePath)) {
      const e = new Error('文件已被移动或删除');
      e.code = 'E_MISSING';
      throw e;
    }
    const t0 = Date.now();
    const text = bookLib.readTxtText(book.filePath, encoding);
    store.logEvent('book_text', { format: 'txt', ms: Date.now() - t0, chars: text.length });
    return text;
  });

  ipcMain.handle('book:detect-encoding', (_e, { bookId }) => {
    const b = library.find((x) => x.bookId === bookId);
    if (!b) return null;
    const buf = fs.readFileSync(b.filePath);
    return bookLib.detectEncoding(buf);
  });

  ipcMain.handle('progress:save', (_e, { bookId, data }) => {
    if (!bookId) return false;
    progress[bookId] = { ...(progress[bookId] || {}), ...data, updatedAt: Date.now() };
    const b = library.find((x) => x.bookId === bookId);
    if (b && typeof data.percent === 'number') {
      b.progressPercent = Math.max(0, Math.min(100, Math.round(data.percent)));
      b.lastOpenedAt = Date.now();
    }
    saveProgress();
    saveLibrary();
    return true;
  });

  ipcMain.handle('progress:get', (_e, bookId) => progress[bookId] || null);

  /* ---- 系统 ---- */
  ipcMain.handle('dialog:choose-import-dir', () => {
    if (dock) dock.suspendAutoHide(60000);
    const res = dialog.showOpenDialogSync(win, { properties: ['openDirectory'], title: '选择默认导入目录' });
    if (dock) dock.suspendAutoHide(1200);
    if (res && res[0]) {
      settings.importDir = res[0];
      saveSettings();
    }
    return settings.importDir;
  });

  ipcMain.handle('shell:open-path', (_e, p) => {
    if (!p) return false;
    shell.showItemInFolder(p);
    return true;
  });

  ipcMain.handle('app:open-data-dir', () => {
    shell.openPath(store.DATA_DIR);
    return store.DATA_DIR;
  });

  ipcMain.handle('app:open-log-dir', () => {
    shell.openPath(store.logDir());
    return store.logDir();
  });

  ipcMain.handle('clipboard:write', (_e, text) => {
    clipboard.writeText(String(text || ''));
    return true;
  });

  ipcMain.handle('app:quit', () => {
    requestQuit();
    return true;
  });

  ipcMain.handle('app:zoom', (_e, factor) => {
    if (!win) return 1;
    const wc = win.webContents;
    const next = Math.min(2, Math.max(0.6, wc.getZoomFactor() + factor));
    wc.setZoomFactor(next);
    return next;
  });

  /* ---- 浏览器 ---- */
  /** 网络诊断：看当前实际走没走代理、几个站点通不通 */
  ipcMain.handle('browser:net-check', () => runNetCheck());

  /** 清缓存 + 重新加载：应对「有网但打不开」的缓存/ServiceWorker 脏数据 */
  ipcMain.handle('browser:clear-cache', async () => {
    const ok = await clearBrowserCache();
    if (ok && browserView && !browserView.webContents.isDestroyed()) {
      try { browserView.webContents.reload(); } catch { /* 忽略 */ }
    }
    return ok;
  });

  /** 手动重试当前地址（错误页「重试」用，避免 reload 一个错误页壳） */
  ipcMain.handle('browser:retry', () => {
    const v = ensureBrowserView();
    const cur = v.webContents.getURL();
    if (cur && isWebUrl(cur)) {
      armNavTimeout(v.webContents, cur);
      v.webContents.loadURL(cur);
    }
    return true;
  });

  ipcMain.handle('browser:navigate', (_e, url) => {
    if (!win || win.isDestroyed()) return false;
    const v = ensureBrowserView();
    let target = String(url || '').trim();
    if (!target) return false;
    if (!/^[a-z]+:\/\//i.test(target)) {
      if (/^[\w-]+(\.[\w-]+)+([/:?#].*)?$/.test(target) || /^localhost(:\d+)?/.test(target)) {
        target = 'https://' + target;
      } else {
        target = 'https://www.bing.com/search?q=' + encodeURIComponent(target);
      }
    }
    if (!/^https?:/i.test(target) && !target.startsWith('file://')) {
      // 地址栏里手输/粘贴的 bytedance://、weixin:// 等：拦下来提示，
      // 不交给系统（否则弹「获取打开此链接的应用」）
      blockExternalUrl(target, 'address-bar');
      return false;
    }
    armNavTimeout(v.webContents, target);
    v.webContents.loadURL(target);
    return true;
  });

  ipcMain.handle('browser:back', () => {
    const v = ensureBrowserView();
    if (v.webContents.navigationHistory.canGoBack()) v.webContents.navigationHistory.goBack();
    return true;
  });
  ipcMain.handle('browser:forward', () => {
    const v = ensureBrowserView();
    if (v.webContents.navigationHistory.canGoForward()) v.webContents.navigationHistory.goForward();
    return true;
  });
  ipcMain.handle('browser:reload', () => {
    const v = ensureBrowserView();
    // 重载也要计时：网络卡住时 reload 同样会一直转圈
    armNavTimeout(v.webContents, v.webContents.getURL());
    v.webContents.reload();
    return true;
  });
  ipcMain.handle('browser:stop', () => {
    // 用户主动停止：先撤计时器，did-fail-load(-3) 就只当普通取消处理
    clearNavTimeout();
    const v = ensureBrowserView();
    v.webContents.stop();
    return true;
  });
  ipcMain.handle('browser:current-url', () => {
    const v = ensureBrowserView();
    return v.webContents.getURL();
  });
  ipcMain.handle('browser:find', (_e, { text, forward = true, findNext = false }) => {
    const v = ensureBrowserView();
    if (!text) {
      v.webContents.stopFindInPage('clearSelection');
      return null;
    }
    if (findNext) {
      v.webContents.findInPage(text, { findNext: true, forward });
    } else {
      v.webContents.findInPage(text, { forward });
    }
    return true;
  });
  ipcMain.handle('browser:zoom', (_e, delta) => {
    const v = ensureBrowserView();
    const wc = v.webContents;
    wc.setZoomLevel(Math.min(4, Math.max(-3, wc.getZoomLevel() + delta)));
    return wc.getZoomLevel();
  });
  ipcMain.handle('browser:reset-zoom', () => {
    const v = ensureBrowserView();
    v.webContents.setZoomLevel(0);
    return 0;
  });
  ipcMain.handle('browser:set-visible', (_e, visible) => {
    browserWanted = !!visible;
    showBrowser(browserWanted);
    return true;
  });

  /**
   * 用户明确点「用系统打开 / 用系统浏览器打开」时才交给系统。
   * 允许网页协议（内置浏览器打不开时的兜底）与外部应用协议；
   * javascript:/vbscript: 这类可执行脚本的协议永远不放行。
   */
  ipcMain.handle('browser:open-external', (_e, url) => {
    const info = classifyUrl(url);
    if (info.scheme === 'javascript' || info.scheme === 'vbscript') return false;
    if (!info.ok && info.kind !== 'external') return false;
    try {
      shell.openExternal(String(url));
      store.logEvent('browse_external_open', { scheme: info.scheme, kind: info.kind });
      return true;
    } catch {
      return false;
    }
  });

  /** 调试用：原生视图的真实几何/可见性（e2e 与排障使用，正常路径不依赖） */
  ipcMain.handle('browser:debug', () => ({
    wanted: browserWanted,
    visible: browserVisible,
    bounds: browserBounds,
    viewBounds: browserView ? browserView.getBounds() : null,
    url: browserView ? browserView.webContents.getURL() : '',
    ua: browserView ? browserView.webContents.getUserAgent() : '',
    proxyMode: settings.proxyMode || 'system',
    loading: browserView ? browserView.webContents.isLoading() : null,
    crashed: browserView ? browserView.webContents.isCrashed() : null,
    childCount: win && win.contentView && !win.isDestroyed() ? win.contentView.children.length : -1,
    winBounds: win && !win.isDestroyed() ? win.getBounds() : null,
  }));
}

/* ------------------------------ 应用启动 ------------------------------ */

// 单实例：第二次启动直接唤回已运行窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (trayHidden) restoreFromTray();
    if (!win.isVisible()) win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    startedAt = Date.now();
    registerAppProtocol();
    loadAll();
    try {
      app.setAppUserModelId('com.moyu.reader');
    } catch { /* 忽略 */ }
    ensureHomeFile();
    createWindow();
    createTray();
    registerIpc();
    // 等渲染层 ready 后再注册热键，冲突提示才能被收到
    setTimeout(() => {
      const r = registerBossKey();
      settings.bossKeyConflict = !r.ok && !r.skipped;
      saveSettings();
      store.logEvent('app_launch', { version: app.getVersion() });
      if (!r.ok && !r.skipped && win) {
        win.webContents.send('hotkey:conflict', { key: r.key });
      }
      // 首次启动/无书时引导
      if (!fs.existsSync(path.join(store.DATA_DIR, 'settings.json'))) saveSettings();
    }, 800);

    app.on('activate', () => {
      if (!win) createWindow();
      else if (trayHidden) restoreFromTray();
      else win.show();
    });
  });

  app.on('before-quit', () => {
    if (!quitting) {
      // 从系统注销等途径触发时，尽量保存
      saveProgress();
      saveLibrary();
      saveSettings();
    }
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (dock) dock.dispose();
  });

  app.on('window-all-closed', () => {
    if (quitting) app.quit();
  });
}
