/* ==================================================================
   state.js —— 渲染层唯一状态容器 + 本地小工具
   刻意不用框架：P0 视图数量少，原生 DOM 便于精确控制阅读区性能与 PDF 画布。
   ================================================================== */

export const PAGES_PER_CHUNK = 1; // 一次翻 1 页（逻辑页 = PAGE_CHARS 个字符）

export const state = {
  view: 'library', // library | reader | browser | settings
  settings: null,
  books: [],
  lastBookId: null,
  sort: 'recent',

  // 当前阅读会话
  book: null, // { bookId, format, title, text, pageCount, chapters, ... }
  page: 0,
  position: null, // TXT 连贯滚动：视口字符偏移（进度记忆）
  fontSize: 17,
  lineHeight: 1.8,
  bgPreset: 'white',
  fontFamily: '',
  bookmarks: [], // [{ id, position(字符偏移|TXT), page(页码|PDF), label, createdAt }]
  sideOpen: false,
  sideTab: 'toc',

  // PDF
  pdf: null, // { doc, scale, fitWidth, rendered:Set }

  // 浏览器
  browser: {
    tabs: [],
    active: 0,
    loading: false,
    url: '',
    title: '',
    canGoBack: false,
    canGoForward: false,
    error: null,
    homeVisible: true,
    /** 浏览区三态：home | page | error（决定原生视图是否让位） */
    mode: 'home',
    /** 上一次加载失败的地址：失败的那次导航也会触发 did-navigate，不能拿它撤掉错误页 */
    failedUrl: '',
  },

  dock: { state: 'NORMAL', pinned: false, edge: 'left' },
  trayHidden: false,
};

/* ------------------------------ DOM ------------------------------ */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------ 事件总线 ------------------------------ */

const listeners = new Map();
export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
}
export function emit(evt, payload) {
  const set = listeners.get(evt);
  if (set) for (const fn of set) fn(payload);
}

/* ------------------------------ 格式化 ------------------------------ */

export function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtTime(ts) {
  if (!ts) return '未读';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const pad = (n) => String(n).padStart(2, '0');
  if (sameDay) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const diff = (now - d) / 86400000;
  if (diff < 7) return `${Math.ceil(diff)} 天前`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function throttle(fn, wait) {
  let last = 0;
  let timer = null;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    const now = Date.now();
    const remain = wait - (now - last);
    if (remain <= 0) {
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn(...lastArgs);
      }, remain);
    }
  };
}

export function debounce(fn, wait) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}
