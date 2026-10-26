/* ==================================================================
   app.js —— 渲染层入口：装配视图、全局快捷键、窗口联动、IPC 事件
   ================================================================== */

import { $, $$, el, state, emit, on } from './state.js';
import { toast, confirmDialog } from './ui.js';
import { initLibrary, initDropZone, refreshLibrary, handleImportResult } from './library.js';
import {
  initReader, openBook, flushProgress, applyReadingStyle, nextPage, prevPage,
  renderPage, gotoPage, relayoutPdf, closeBookOnExit,
} from './reader.js';
import {
  initBrowser, enterBrowser, leaveBrowser, resyncBrowser, newTab, closeTab, refreshQuickSites,
} from './browser.js';
import { initSettings, syncForm } from './settings.js';

/* ------------------------------ 视图切换 ------------------------------ */

function setView(view, opts = {}) {
  if (view === state.view && !opts.force) {
    if (view === 'browser') resyncBrowser();
    return;
  }
  const prev = state.view;
  state.view = view;

  $$('.view').forEach((v) => {
    v.hidden = v.id !== `view-${view}`;
  });
  $$('#nav .nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));

  if (prev === 'browser' && view !== 'browser') leaveBrowser();
  window.moyu.view.set(view);

  if (view === 'library') refreshLibrary();
  if (view === 'browser') enterBrowser();
  if (view === 'settings') syncForm(state.settings);
  if (view === 'reader' && !state.book && state.lastBookId) {
    openAndRead(state.lastBookId);
  }
  if (view === 'reader') relayoutPdf();
  syncSideScrim();
}

/* ------------------------------ 响应式适配 ------------------------------ */

/** 与 styles.css 的断点保持一致：<=900px 时侧栏变成抽屉浮层 */
const COMPACT_MQ = '(max-width: 900px)';

function isCompact() {
  return window.matchMedia(COMPACT_MQ).matches;
}

/**
 * 侧栏遮罩：只在「窄窗口 + 侧栏打开 + 处于阅读视图」时出现。
 * 侧栏本身由 CSS 媒体查询切成绝对定位抽屉，这里只负责遮罩与关闭手势。
 */
export function syncSideScrim() {
  const scrim = $('#reader-scrim');
  if (!scrim) return;
  scrim.hidden = !(isCompact() && state.sideOpen && state.view === 'reader');
}

/** 关闭侧栏（抽屉模式下点遮罩、或按 Esc 用） */
export function closeSide() {
  if (!state.sideOpen) return;
  state.sideOpen = false;
  $('#reader-side').classList.add('collapsed');
  $('#btn-toc').classList.remove('on');
  syncSideScrim();
}

/* ------------------------------ 打开书籍 ------------------------------ */

async function openAndRead(bookId) {
  setView('reader');
  const book = await openBook(bookId);
  if (book) {
    state.lastBookId = bookId;
    // 首次打开自动展开目录，方便长篇跳章；但窄窗口下会挤掉正文，故不自动展开
    if (!state.sideOpen && !isCompact()) {
      $('#btn-toc').classList.add('on');
      state.sideOpen = true;
      $('#reader-side').classList.remove('collapsed');
    }
    syncSideScrim();
  } else {
    setView('library');
  }
}

/* ------------------------------ 顶栏与窗口 ------------------------------ */

function initChrome() {
  $$('#nav .nav-btn').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.view === 'reader' && !state.book) {
        if (state.lastBookId) return openAndRead(state.lastBookId);
        toast('还没有打开的书，先去书库选一本', '', 2200);
        return setView('library');
      }
      setView(b.dataset.view);
    };
  });

  $('#btn-min').onclick = () => window.moyu.win.minimize();
  $('#btn-max').onclick = () => window.moyu.win.toggleMaximize();
  $('#btn-close').onclick = () => window.moyu.win.close();
  $('#btn-boss').onclick = () => window.moyu.win.boss();
  $('#btn-dock').onclick = async () => {
    const s = await window.moyu.dock.state();
    if (s.state === 'DOCKED') {
      window.moyu.dock.undock();
    } else {
      const edge = state.settings.dockEdge || 'left';
      window.moyu.dock.dock(edge);
      const label = edge === 'left' ? '左' : edge === 'right' ? '右' : '上';
      toast(`已收成${label}边条：鼠标移到屏幕边缘展开，移开窗口会自动收回`, '', 3200);
    }
  };

  // 窗口最大化状态
  window.moyu.win.onLayout(({ maximized }) => {
    $('#btn-max').title = maximized ? '还原' : '最大化';
    resyncBrowser();
    relayoutPdf();
  });

  // 双击标题栏切换最大化
  const topbar = $('#topbar');
  topbar.addEventListener('dblclick', (e) => {
    if (e.target.closest('button') || e.target.closest('.nav')) return;
    window.moyu.win.toggleMaximize();
  });
}

/* ------------------------------ 全局快捷键 ------------------------------ */

function initHotkeys() {
  window.addEventListener('keydown', (e) => {
    const inInput = e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);

    // Ctrl+1 / Ctrl+2 / Ctrl+,：视图切换
    if (e.ctrlKey && !e.shiftKey && !e.altKey) {
      if (e.key === '1') { e.preventDefault(); setView('library'); return; }
      if (e.key === '2') { e.preventDefault(); setView('browser'); return; }
      if (e.key === ',') { e.preventDefault(); setView('settings'); return; }
      if (e.key === 'o') {
        e.preventDefault();
        window.moyu.library.pick().then((res) => res && res.length && handleImportResult(res));
        return;
      }
      // 浏览器模块快捷键
      if (state.view === 'browser') {
        if (e.key === 't') { e.preventDefault(); newTab(); return; }
        if (e.key === 'w') { e.preventDefault(); closeTab(); return; }
        if (e.key === 'l') { e.preventDefault(); $('#addr').focus(); return; }
        if (e.key === 'f') { e.preventDefault(); $('#b-find').click(); return; }
        if (e.key === '=' || e.key === '+') { e.preventDefault(); window.moyu.browser.zoom(0.5); return; }
        if (e.key === '-') { e.preventDefault(); window.moyu.browser.zoom(-0.5); return; }
        if (e.key === '0') { e.preventDefault(); window.moyu.browser.resetZoom(); return; }
        if (e.key === 'r') { e.preventDefault(); window.moyu.browser.reload(); return; }
      }
      // 阅读模块：Ctrl+F 全文搜索
      if (state.view === 'reader' && e.key === 'f') {
        e.preventDefault();
        $('#btn-find').click();
        return;
      }
    }

    // F8 由主进程 globalShortcut 接管；这里只处理 Esc / F11
    if (e.key === 'Escape' && state.view === 'browser') {
      const bar = $('#browser-find');
      if (bar && !bar.hidden) {
        bar.hidden = true;
        window.moyu.browser.find({ text: '' });
        return;
      }
      setView('reader');
      return;
    }
    if (e.key === 'F11') {
      e.preventDefault();
      window.moyu.win.toggleMaximize();
    }
  });

  // 鼠标侧键（部分鼠标/键盘映射为 browser back/forward）
  window.addEventListener('mouseup', (e) => {
    if (state.view !== 'browser') return;
    if (e.button === 3) window.moyu.browser.back();
    if (e.button === 4) window.moyu.browser.forward();
  });
}

/* ------------------------------ IPC 事件 ------------------------------ */

function initBridge() {
  window.moyu.dock.onState((snap) => {
    state.dock = snap;
    $('#btn-dock').classList.toggle('on', snap.state === 'DOCKED');
    paintDockPeek(snap);
    // 主进程在收起/展开时会强制收放原生视图，展开后必须由渲染层重新声明意图，
    // 否则会出现「网页视图盖住首页/错误页」或「页面区域一片空白」。
    resyncBrowser();
  });

  window.moyu.app.onGoto((view) => {
    if (view === 'reader' && !state.book && state.lastBookId) return openAndRead(state.lastBookId);
    setView(view);
  });

  window.moyu.app.onTray(({ hidden }) => {
    state.trayHidden = hidden;
    $('#btn-boss').classList.toggle('on', hidden);
    resyncBrowser();
  });

  window.moyu.misc.onToast(({ msg, type }) => toast(msg, type === 'error' ? 'err' : type || ''));

  // 主进程广播的设置变更（任何入口改的设置都会到这里）：
  // 转成内部事件，让常用站点/阅读默认值等 UI 一起刷新
  if (window.moyu.settings && window.moyu.settings.onChange) {
    window.moyu.settings.onChange((s) => {
      if (!s) return;
      state.settings = s;
      emit('settings:changed', s);
    });
  }

  window.moyu.misc.onHotkeyConflict(({ key }) => {
    toast(`${key} 已被其他应用占用，请到设置里更换老板键`, 'err', 6000);
    if (state.view === 'settings') syncForm(state.settings);
  });

  window.moyu.app.onBeforeQuit(async () => {
    try {
      await flushProgress();
    } catch { /* 忽略 */ }
  });

  emit('settings:changed', state.settings);
}

/** 收起后屏幕上只剩边条：切换「条状模式」让渲染层铺满露出的那条并显示方向图标 */
function paintDockPeek(snap) {
  const strip = $('#dock-strip');
  const app = $('#app');
  if (!strip) return;
  const docked = snap.state === 'DOCKED';
  document.body.classList.toggle('strip-mode', docked);
  strip.hidden = !docked;
  if (!docked) {
    return;
  }
  strip.className = `dock-strip edge-${snap.edge || 'left'}`;
  const glyph = $('#dock-glyph');
  if (glyph) glyph.textContent = snap.edge === 'left' ? '›' : snap.edge === 'right' ? '‹' : '⌄';
}

/* ------------------------------ 启动 ------------------------------ */

async function boot() {
  // 设置与信息
  state.settings = await window.moyu.settings.get();
  const info = await window.moyu.app.info();
  $('#data-dir').textContent = info.dataDir;
  $('#log-dir').textContent = info.logDir;
  $('#app-version').textContent = `v${info.version}`;
  state.trayHidden = info.trayHidden;

  // 阅读默认值
  state.fontSize = state.settings.fontSize;
  state.lineHeight = state.settings.lineHeight;
  state.bgPreset = state.settings.bgPreset;
  state.fontFamily = state.settings.fontFamily;

  // 供开发期 e2e / 控制台调用（生产无副作用）
  window.__moyuImport = handleImportResult;

  waitFonts().then(async () => {
    initChrome();
    initLibrary();
    initDropZone();
    initReader();
    initBrowser();
    initSettings();
    initHotkeys();

    on('view:goto', (v) => setView(v));
    on('open-book', (id) => openAndRead(id));
    on('side:changed', () => syncSideScrim());
    on('library:refresh', () => refreshLibrary());
    on('quick-sites:changed', () => refreshQuickSites());
    on('settings:changed', (s) => {
      state.settings = s;
      // 阅读默认值仅影响「还没单独设置过的书」
      if (!state.book) {
        state.fontSize = s.fontSize;
        state.lineHeight = s.lineHeight;
        state.bgPreset = s.bgPreset;
      }
      applyReadingStyle();
      refreshQuickSites();
    });

    initBridge();

    // 侧栏遮罩：点一下关闭抽屉
    const scrim = $('#reader-scrim');
    if (scrim) scrim.onclick = () => closeSide();
    // 窗口跨过断点时重算遮罩（侧栏由 CSS 自动切成抽屉/常驻）
    const mq = window.matchMedia(COMPACT_MQ);
    const onCompactChange = () => {
      // 从宽变窄：原本常驻的侧栏会变成盖住正文的抽屉，自动收起更像「响应式」
      if (mq.matches && state.sideOpen) closeSide();
      syncSideScrim();
    };
    if (mq.addEventListener) mq.addEventListener('change', onCompactChange);
    else if (mq.addListener) mq.addListener(onCompactChange);

    const list = await window.moyu.library.list();
    state.books = list.books || [];
    state.lastBookId = list.lastBookId || null;
    await refreshLibrary();
    setView('library', { force: true });

    const dock = await window.moyu.dock.state();
    state.dock = dock;
    paintDockPeek(dock);

    // 启动续读：记住了上次读的书 -> 直接进阅读视图
    if (state.lastBookId && state.books.some((b) => b.bookId === state.lastBookId)) {
      await openAndRead(state.lastBookId);
    }
    if (state.dock.state === 'DOCKED') paintDockPeek(state.dock);
  });
}

/** 字体加载完成后再启动，避免首次渲染闪一下默认字体 */
async function waitFonts() {
  if (!document.fonts || !document.fonts.ready) return;
  await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 800))]);
}

boot().catch((err) => {
  console.error('[boot] 失败', err);
  toast('启动异常：' + (err && err.message), 'err', 6000);
});
