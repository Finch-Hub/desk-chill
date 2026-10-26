/* ==================================================================
   browser.js —— 内置浏览器（WebContentsView 由主进程叠加在 .browser-stage 上）
   渲染层负责：地址栏、前进后退、首页、错误页、页内查找、快捷键。
   多标签：单个持久会话（persist:moyu），标签切换靠「重新导航 + 记录 URL」实现，
   最大程度保留登录态；同一时刻只有一个活动 URL（够用且省内存）。
   ================================================================== */

import { $, $$, el, state, throttle, emit } from './state.js';
import { toast } from './ui.js';

const stage = () => $('#browser-stage');

/** Chromium 网络错误码 -> 人话（否则用户只看到一串英文） */
const NET_HINT = {
  [-2]: '网络请求失败，检查是否已联网。',
  [-6]: '文件未找到。',
  [-7]: '连接超时：目标站点或中间网络没响应。',
  [-21]: '网络连接中断。',
  [-100]: '连接被关闭（可能是代理中断了请求）。',
  [-101]: '连接被重置：常见于公司网络策略、代理软件或运营商拦截。',
  [-102]: '连接被拒绝：目标端口没有服务在监听。',
  [-104]: '读取失败，连接中途断开。',
  [-105]: '域名解析失败：检查 DNS 或换一个网络。',
  [-106]: '网络已断开。',
  [-109]: '无法访问网络。',
  [-118]: '连接超时（TCP 没建立起来）。',
  [-137]: '域名解析失败。',
  [-200]: '证书校验失败，可能被中间设备拦截。',
  [-324]: '页面是空的（服务器返回了空响应）。',
};

/** 当前是否应该显示「真实网页」。首页/错误页显示时必须关掉原生视图，否则会盖住它们 */
let wantPage = false;

/**
 * 把「是否显示原生网页视图」同步给主进程。
 * 主进程还会叠加「窗口是否收起为边条 / 是否在托盘」的门控。
 */
function applyNative() {
  window.moyu.browser.setVisible(wantPage);
  syncBounds();
}

/**
 * 浏览区三态：home（自绘首页）/ page（真实网页）/ error（自绘错误页）。
 * 只用 url 判断是不够的——失败的那次导航也会把 url 写进来，
 * 切走再切回就会「以为有网页可看」，结果露出一张空白页把首页盖住。
 */
function setMode(mode) {
  state.browser.mode = mode;
  const home = $('#browser-home');
  const err = $('#browser-err');
  if (home) home.hidden = mode !== 'home';
  if (err) err.hidden = mode !== 'error';
  // 回首页时清空地址栏（别把上一次失败的 URL 留在那里，看着像没生效）
  if (mode === 'home' && document.activeElement !== $('#addr')) $('#addr').value = '';
  wantPage = mode === 'page';
  applyNative();
}

/** 需要重新对齐（窗口尺寸/停靠状态变化）时调用 */
export function resyncBrowser() {
  if (state.view !== 'browser') return;
  window.moyu.browser.setVisible(wantPage);
  syncBounds();
}


export function initBrowser() {
  $('#b-back').onclick = () => window.moyu.browser.back();
  $('#b-forward').onclick = () => window.moyu.browser.forward();
  $('#b-reload').onclick = () => {
    if (state.browser.loading) window.moyu.browser.stop();
    else window.moyu.browser.reload();
  };
  $('#addr-form').onsubmit = (e) => {
    e.preventDefault();
    navigate($('#addr').value);
  };
  $('#addr').onfocus = () => $('#addr').select();

  $('#home-form').onsubmit = (e) => {
    e.preventDefault();
    navigate($('#home-input').value);
  };

  $('#b-copy').onclick = async () => {
    const url = state.browser.url || (await window.moyu.browser.currentUrl());
    if (!url) return toast('当前没有可复制的网址');
    await window.moyu.clipboard.write(url);
    toast('网址已复制', 'ok', 1600);
  };

  $('#b-quick').onclick = () => {
    setMode('home');
    $('#home-input').focus();
  };

  $('#b-find').onclick = () => {
    const bar = $('#browser-find');
    bar.hidden = !bar.hidden;
    if (!bar.hidden) $('#bfind-input').focus();
  };
  $('#bfind-close').onclick = () => {
    $('#browser-find').hidden = true;
    window.moyu.browser.find({ text: '' });
  };
  $('#bfind-input').oninput = throttle((e) => {
    window.moyu.browser.find({ text: e.target.value, forward: true });
  }, 180);
  $('#bfind-input').onkeydown = (e) => {
    if (e.key === 'Enter') {
      window.moyu.browser.find({ text: $('#bfind-input').value, forward: !e.shiftKey, findNext: true });
    } else if (e.key === 'Escape') {
      $('#bfind-close').click();
    }
  };
  $('#bfind-next').onclick = () => {
    window.moyu.browser.find({ text: $('#bfind-input').value, findNext: true });
  };

  $('#err-retry').onclick = () => {
    // 重试 = 又要看网页了，先把原生视图放出来再重新导航
    setMode('page');
    state.browser.failedUrl = '';
    window.moyu.browser.retry();
  };
  $('#err-clear').onclick = async () => {
    setMode('page');
    state.browser.failedUrl = '';
    const ok = await window.moyu.browser.clearCache();
    if (!ok) toast('清缓存失败，可在设置里手动重试', 'err', 3000);
  };
  $('#err-back').onclick = () => {
    state.browser.failedUrl = '';
    setMode('home');
  };
  // 内置浏览器被网络拦死时的兜底：交给系统默认浏览器（Chrome 能开就说明是网络策略差异）
  $('#err-external').onclick = async () => {
    const url = state.browser.failedUrl || state.browser.url;
    if (!url) return toast('没有可打开的网址');
    const ok = await window.moyu.browser.openExternal(url);
    if (!ok) toast('系统里没有可打开该链接的浏览器', 'err', 3000);
  };

  renderQuickSites();

  // 主进程事件
  const ICON_RELOAD = '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M16 10a6 6 0 1 1-1.8-4.3M16 4v4h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_STOP = '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M6 6l8 8M14 6l-8 8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

  window.moyu.browser.onLoading(({ loading }) => {
    state.browser.loading = loading;
    $('#load-bar').classList.toggle('loading', loading);
    const btn = $('#b-reload');
    // 图标按钮不能直接改 textContent（会把 SVG 冲掉），换 innerHTML
    btn.innerHTML = loading ? ICON_STOP : ICON_RELOAD;
    btn.title = loading ? '停止加载' : '刷新 (Ctrl+R)';
    btn.classList.toggle('is-stop', loading);
  });
  window.moyu.browser.onNavigated(({ url, canGoBack, canGoForward }) => {
    state.browser.canGoBack = canGoBack;
    state.browser.canGoForward = canGoForward;
    // 用「灰色 + 禁用」表达不可用，比原来 0.4 透明度清楚得多
    const back = $('#b-back');
    const fwd = $('#b-forward');
    back.classList.toggle('is-disabled', !canGoBack);
    fwd.classList.toggle('is-disabled', !canGoForward);
    back.disabled = !canGoBack;
    fwd.disabled = !canGoForward;

    const isHome = !url || url === 'about:blank';
    // 失败的那次导航也可能触发 did-navigate：此时要留在错误页，不能切回网页
    const isFailed = !!state.browser.failedUrl && url === state.browser.failedUrl;
    if (isFailed) return;

    state.browser.failedUrl = '';
    state.browser.url = url;
    if (document.activeElement !== $('#addr')) $('#addr').value = url;
    setMode(isHome ? 'home' : 'page');
    // 同步活动标签
    const t = state.browser.tabs[state.browser.active];
    if (t) {
      t.url = url;
      if (!t.title || t.title === '新标签页') renderTabs();
    }
  });
  window.moyu.browser.onTitle(({ title }) => {
    state.browser.title = title;
    const t = state.browser.tabs[state.browser.active];
    if (t) {
      t.title = title || t.url;
      renderTabs();
    }
  });
  window.moyu.browser.onError(({ code, desc, errType, url }) => {
    const hint = NET_HINT[code] || '';
    const advice = errType === 'cert'
      ? '证书不被信任：如果是公司网络或代理软件在做 HTTPS 中间人，可在「设置 → 网络」开启「信任证书错误」后重试。'
      : '如果是公司网络或用了代理，去「设置 → 网络」切换代理模式（跟随系统 / 直连 / 手动）后重试。';
    $('#err-title').textContent = errType === 'cert' ? '无法建立安全连接' : '无法访问此页面';
    const lines = [
      desc || '网络错误',
      code ? `错误码 ${code}` : '',
      url || '',
      hint,
      '',
      advice,
    ].filter((s) => s !== '');
    $('#err-desc').textContent = lines.join('\n');
    $('#browser-err').style.whiteSpace = 'pre-line';
    state.browser.failedUrl = url || '';
    // 错误页画在渲染层，切到 error 态会同时收起原生视图，否则提示会被空白网页盖住
    setMode('error');
  });
  window.moyu.browser.onCrash(() => {
    toast('页面无响应，已为你保留主体', 'err', 4000);
    $('#err-title').textContent = '页面崩溃了';
    $('#err-desc').textContent = '这个页面进程异常退出，点「重试」可以重新加载。';
    setMode('error');
  });
  window.moyu.browser.onOpenUrl((url) => openInTab(url));

  // 网页里的 bytedance:// / weixin:// 等客户端协议：主进程已拦下，
  // 这里给一条不打断阅读的提示（绝不再交给系统，避免弹 Microsoft Store）。
  // 注意用 stage 之外的提示条，toast 在窗口底部会被原生网页视图盖住。
  let noticeTimer = 0;
  let lastBlockedUrl = '';
  const hideNotice = () => {
    clearTimeout(noticeTimer);
    const bar = $('#browser-notice');
    if (bar) bar.hidden = true;
    syncBounds();
  };
  const showNotice = (text, blockedUrl) => {
    const bar = $('#browser-notice');
    if (!bar) return;
    lastBlockedUrl = blockedUrl || '';
    $('#notice-text').textContent = text;
    // 没记到原始链接时就不要展示「用系统打开」，避免点了没反应
    $('#notice-open').hidden = !lastBlockedUrl;
    bar.hidden = false;
    syncBounds(); // 提示条会压缩 stage 高度，原生视图要跟着缩
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(hideNotice, 6000);
  };
  $('#notice-close').onclick = hideNotice;
  $('#notice-open').onclick = async () => {
    if (!lastBlockedUrl) return hideNotice();
    await window.moyu.browser.openExternal(lastBlockedUrl);
    hideNotice();
  };
  window.moyu.browser.onBlocked(({ scheme, app, url }) => {
    const name = app || '对应客户端';
    const s = scheme ? `${scheme}://` : '外部链接';
    showNotice(`已拦截外部应用链接 ${s} —— 需要安装「${name}」才能打开，已帮你留在当前页面`, url);
  });

  // 网页里按下的快捷键由主进程转发过来（焦点在原生视图时渲染层收不到 keydown）
  window.moyu.browser.onCommand(({ cmd }) => {
    if (cmd === 'escape') {
      // 先收查找条，再回阅读视图
      const bar = $('#browser-find');
      if (bar && !bar.hidden) {
        bar.hidden = true;
        window.moyu.browser.find({ text: '' });
        return;
      }
      emit('view:goto', 'reader');
      return;
    }
    if (cmd === 'focus-addr') { $('#addr').focus(); return; }
    if (cmd === 'new-tab') { newTab(); return; }
    if (cmd === 'close-tab') { closeTab(); return; }
    if (cmd === 'find') { $('#b-find').click(); return; }
    if (cmd === 'reload') { window.moyu.browser.reload(); return; }
  });

  // 初始一个标签
  state.browser.tabs = [{ url: '', title: '新标签页' }];
  state.browser.active = 0;
  state.browser.mode = 'home';
  renderTabs();
  // 刚开始没有历史，前进/后退置灰
  ['#b-back', '#b-forward'].forEach((sel) => {
    const n = $(sel);
    n.classList.add('is-disabled');
    n.disabled = true;
  });

  window.addEventListener('resize', throttle(syncBounds, 80));
  new ResizeObserver(throttle(syncBounds, 60)).observe(stage());
}

function renderQuickSites() {
  const box = $('#quick-sites');
  box.innerHTML = '';
  const sites = (state.settings && state.settings.quickSites) || [];
  sites.forEach((s) => {
    box.append(el('button', { class: 'qsite', text: s.name, title: s.url, onclick: () => navigate(s.url) }));
  });
  if (!sites.length) box.append(el('span', { class: 'hint', text: '可在设置里添加常用站点' }));
}

export function refreshQuickSites() {
  renderQuickSites();
}

function navigate(input) {
  const v = String(input || '').trim();
  if (!v) return;
  state.browser.failedUrl = '';
  setMode('page'); // 放开原生视图
  // 先等一帧让原生视图拿到正确矩形，再真正开始导航（避免首帧显示在上一个尺寸上）
  requestAnimationFrame(() => window.moyu.browser.navigate(v));
  if (document.activeElement) document.activeElement.blur();
}

function openInTab(url) {
  const idx = state.browser.tabs.length;
  state.browser.tabs.push({ url, title: url });
  state.browser.active = idx;
  renderTabs();
  navigate(url);
}

export function newTab() {
  state.browser.tabs.push({ url: '', title: '新标签页' });
  state.browser.active = state.browser.tabs.length - 1;
  renderTabs();
  state.browser.failedUrl = '';
  setMode('home');
  $('#addr').value = '';
  setTimeout(() => $('#home-input').focus(), 20);
}

export function closeTab(index = state.browser.active) {
  if (state.browser.tabs.length <= 1) {
    // 最后一个标签：回到首页，而不是关掉整个模块
    state.browser.tabs = [{ url: '', title: '新标签页' }];
    state.browser.active = 0;
    renderTabs();
    state.browser.failedUrl = '';
    setMode('home');
    return;
  }
  state.browser.tabs.splice(index, 1);
  state.browser.active = Math.max(0, Math.min(index, state.browser.tabs.length - 1));
  renderTabs();
  const t = state.browser.tabs[state.browser.active];
  if (t.url) navigate(t.url);
  else {
    state.browser.failedUrl = '';
    setMode('home');
  }
}

function renderTabs() {
  const bar = $('#browser-tabs');
  if (!bar) return;
  bar.innerHTML = '';
  const tabs = state.browser.tabs;
  tabs.forEach((t, i) => {
    const label = t.title && t.title.length < 24 ? t.title : (t.url || '新标签页');
    const active = i === state.browser.active;
    const tab = el('div', {
      class: `tag${active ? ' active' : ''}`,
      title: t.url || label,
    }, [
      el('span', {
        class: 'tag-t',
        text: String(label).slice(0, 22),
        onclick: () => {
          state.browser.active = i;
          renderTabs();
          if (t.url) navigate(t.url);
          else setMode('home');
        },
      }),
      el('button', {
        class: 'tag-x',
        title: '关闭标签 (Ctrl+W)',
        'aria-label': '关闭标签',
        text: '×',
        onclick: (e) => {
          e.stopPropagation(); // 别触发标签切换
          closeTab(i);
        },
      }),
    ]);
    bar.append(tab);
  });
  bar.append(
    el('button', {
      class: 'tag tag-new',
      title: '新标签 (Ctrl+T)',
      text: '+',
      onclick: () => newTab(),
    }),
  );
}

/** 把 WebContentsView 对齐到 stage 矩形（滚动/缩放后的实际坐标） */
export function syncBounds() {
  const show = state.view === 'browser' && wantPage;
  if (!show) {
    window.moyu.browser.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    return;
  }
  const node = stage();
  if (!node) return;
  const r = node.getBoundingClientRect();
  window.moyu.browser.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
}

/** 切换离开浏览视图时必须把原生视图让出去 */
export function leaveBrowser() {
  wantPage = false;
  window.moyu.browser.setVisible(false);
  window.moyu.browser.setBounds({ x: 0, y: 0, width: 0, height: 0 });
}

export function enterBrowser() {
  // 直接按上次的三态恢复：home / page / error。
  // 不能只看 url —— 一次失败的导航也会写 url，切回来就会露出一张空白页盖住首页。
  const mode = state.browser.mode || 'home';
  if (mode === 'page' && (!state.browser.url || state.browser.url === 'about:blank')) {
    setMode('home');
    return;
  }
  setMode(mode);
  syncBounds();
}
