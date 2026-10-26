/* ==================================================================
   reader.js —— 阅读视图（TXT / PDF）
   ------------------------------------------------------------------
   TXT：连贯滚动模式（主流阅读器交互）。全文按「章节」分块（无章节按
        固定字符数虚拟分块），可视块前后各预载 2 块、滚动到边缘再追加/
        前插并补偿 scrollTop，离开窗口的块回收——830 万字也不卡。
        进度按「视口顶部字符偏移 position」记忆，重开书精确还原。
   PDF：pdf.js 逐页 canvas 渲染，IntersectionObserver 懒渲染；文本层支持选择复制。
   ================================================================== */

import { $, el, state, escapeHtml, throttle, debounce, emit } from './state.js';
import { toast, modal } from './ui.js';

const PAGE_CHARS = 1100; // 与主进程 book.js 保持一致（仅用于旧进度/书签迁移换算）
const CHUNK_CHARS = 8000; // 单块最大字符数：超长章节会再切成若干子块
const WIN_RADIUS = 2; // 可视块前后各预载块数
const MAX_WINDOW = 12; // DOM 中最多保留的块数（超出从远端回收）
const BG_CLASS = { white: '', sepia: 'theme-sepia', green: 'theme-green', dark: 'theme-dark' };

let pdfjsLib = null;
let pdfLoadError = null;
/** 打开序号：两段式加载期间若用户切走/切书，旧结果必须丢弃 */
let openToken = 0;

/* ------------------------------------------------------------------ *
 * TXT 连贯滚动：块模型与运行时
 *   flow = { chunks: [{start,end,title,chapter}], from, to }
 *   [from, to] 是当前渲染在 DOM 里的连续块区间
 * ------------------------------------------------------------------ */
let flow = null;

function buildChunks() {
  const text = state.txtText || '';
  const chapters = (state.book.chapters || [])
    .filter((c) => typeof c.offset === 'number' && c.offset >= 0 && c.offset < Math.max(1, text.length))
    .sort((a, b) => a.offset - b.offset);
  const chunks = [];
  if (chapters.length) {
    chapters.forEach((c, i) => {
      const start = c.offset;
      const end = i + 1 < chapters.length ? Math.min(chapters[i + 1].offset, text.length) : text.length;
      if (end <= start) return;
      // 超长章节再切子块，只有第一个子块带章标题
      for (let s = start; s < end; s += CHUNK_CHARS) {
        chunks.push({ start: s, end: Math.min(end, s + CHUNK_CHARS), title: s === start ? c.title : '', chapter: i });
      }
    });
  }
  if (!chunks.length) {
    for (let s = 0; s < text.length; s += CHUNK_CHARS) {
      chunks.push({ start: s, end: Math.min(text.length, s + CHUNK_CHARS), title: '', chapter: -1 });
    }
  }
  if (!chunks.length) chunks.push({ start: 0, end: Math.max(0, text.length), title: '', chapter: -1 });
  return chunks;
}

function chunkIndexForOffset(off) {
  const cs = flow.chunks;
  let lo = 0;
  let hi = cs.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cs[mid].start <= off) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * 容器是否可测量。
 * 边条收起（body.strip-mode 下 #content display:none）或视图未激活时，
 * 滚动容器尺寸为 0——此时任何测量都会得到 0，绝不能拿它当真实位置。
 */
function flowHasSize() {
  const box = $('#txt-pages');
  return !!box && box.clientHeight > 8;
}

/** 视口顶部探针（顶部偏下一点）对应的全文偏移 */
function currentOffsetRaw() {
  const box = $('#txt-pages');
  if (!box || !flow) return 0;
  if (!flowHasSize()) {
    // 不可测量：沿用最后已知位置（打开时来自进度，滚动时来自上次同步）
    return typeof state.position === 'number' ? state.position : (flow.chunks[0] ? flow.chunks[0].start : 0);
  }
  const probe = box.getBoundingClientRect().top + Math.min(box.clientHeight * 0.3, 140);
  for (const n of $('#txt-flow').children) {
    const r = n.getBoundingClientRect();
    if (r.bottom > probe) {
      const ch = flow.chunks[Number(n.dataset.chunk)];
      if (!ch) break;
      const ratio = r.height > 0 ? Math.min(1, Math.max(0, (probe - r.top) / r.height)) : 0;
      return Math.max(ch.start, Math.min(ch.end - 1, ch.start + Math.floor(ratio * (ch.end - ch.start))));
    }
  }
  const last = flow.chunks[flow.to];
  return last ? Math.max(0, last.end - 1) : 0;
}

/** pdf.js 懒加载（只在打开 PDF 时才载入 ~1MB 的解析器） */
async function loadPdfjs() {
  if (pdfjsLib) return pdfjsLib;
  if (pdfLoadError) throw pdfLoadError;
  try {
    const lib = await import('../../vendor/pdf/pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdf/pdf.worker.min.mjs', import.meta.url).href;
    pdfjsLib = lib;
    return lib;
  } catch (err) {
    pdfLoadError = err;
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * 进度保存（节流 1s，PRD「进度保存」）
 * TXT 记 position（视口字符偏移，滚动位置级还原）；
 * pageIndex/percent 是给书库列表等旧界面看的兼容字段。
 * ------------------------------------------------------------------ */
function txtProgressData() {
  const b = state.book;
  const off = flow ? currentOffsetRaw() : (typeof state.position === 'number' ? state.position : 0);
  const chapters = (b && b.chapters) || [];
  let chapterIndex = -1;
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i].offset <= off) chapterIndex = i;
    else break;
  }
  return {
    position: off,
    pageIndex: Math.floor(off / PAGE_CHARS),
    chapterIndex,
    percent: b && b.totalChars ? Math.round((off / b.totalChars) * 100) : 0,
  };
}

const saveProgressThrottled = throttle(() => {
  if (!state.book) return;
  const b = state.book;
  const pos = b.format === 'txt' ? txtProgressData() : { position: undefined, pageIndex: state.page, percent: b.pageCount ? Math.round(((state.page + 1) / b.pageCount) * 100) : 0 };
  window.moyu.progress.save(b.bookId, {
    ...pos,
    fontSize: state.fontSize,
    lineHeight: state.lineHeight,
    bgPreset: state.bgPreset,
    fontFamily: state.fontFamily,
    bookmarks: state.bookmarks,
  });
}, 1000);

/** 强制立即落盘（退出/切换书籍/收藏时调用） */
export function flushProgress() {
  if (!state.book) return Promise.resolve();
  const b = state.book;
  const pos = b.format === 'txt' ? txtProgressData() : { position: undefined, pageIndex: state.page, percent: b.pageCount ? Math.round(((state.page + 1) / b.pageCount) * 100) : 0 };
  return window.moyu.progress.save(b.bookId, {
    ...pos,
    fontSize: state.fontSize,
    lineHeight: state.lineHeight,
    bgPreset: state.bgPreset,
    fontFamily: state.fontFamily,
    bookmarks: state.bookmarks,
  });
}

/* ------------------------------------------------------------------ *
 * 主题与字号
 * ------------------------------------------------------------------ */
export function applyReadingStyle() {
  const app = $('#app');
  app.classList.remove('theme-light', 'theme-sepia', 'theme-green', 'theme-dark');
  const cls = BG_CLASS[state.bgPreset];
  if (cls) app.classList.add(cls);
  const stage = $('#reader-stage');
  if (stage) {
    stage.style.setProperty('--read-size', `${state.fontSize}px`);
    stage.style.setProperty('--read-lh', String(state.lineHeight));
    stage.style.fontFamily = state.fontFamily || '';
    stage.style.fontSize = `${state.fontSize}px`;
  }
  const page = $('#txt-flow');
  if (page) {
    page.style.fontSize = `${state.fontSize}px`;
    page.style.lineHeight = String(state.lineHeight);
    page.style.fontFamily = state.fontFamily || '';
  }
  $('#fs-val') && ($('#fs-val').textContent = String(state.fontSize));
  $('#fs-range') && ($('#fs-range').value = String(state.fontSize));
  $('#lh-select') && ($('#lh-select').value = String(state.lineHeight));
  document.querySelectorAll('#bg-swatches .sw').forEach((b) => {
    b.classList.toggle('active', b.dataset.bg === state.bgPreset);
  });
  // 字号/行距/字体变化会改变块高度：重排可视窗口并把滚动位置校回同一偏移
  relayoutFlow();
}

/* ------------------------------------------------------------------ *
 * 打开书籍
 * ------------------------------------------------------------------ */
export async function openBook(bookId, opts = {}) {
  if (state.book && state.book.bookId !== bookId) await flushProgress();
  const loading = $('#reader-loading');
  const loadTip = $('#reader-loading-tip');
  loading.hidden = false;
  if (loadTip) loadTip.textContent = '正在解析…';
  // 每次打开递增：异步分两段返回，用户中途切书时旧请求必须丢弃
  const token = ++openToken;
  try {
    // 第一段：只取元信息（编码/字数/页数/目录）。超大 TXT 不在这里传正文，
    // 否则十几 MB 的字符串结构化克隆会把首屏拖住几十秒。
    const data = await window.moyu.book.open(bookId, opts.encoding, { metaOnly: true });
    if (token !== openToken) return null;

    if (data.format === 'txt' && data.needEncodingChoice && !opts.encoding) {
      loading.hidden = true;
      const choice = await askEncoding(data.encoding);
      if (!choice) return null;
      return openBook(bookId, { encoding: choice });
    }

    state.book = {
      bookId: data.bookId,
      format: data.format,
      title: data.title,
      pageCount: data.format === 'txt' ? data.pageCount : (data.pageCount || 0),
      totalChars: data.totalChars,
      chapters: data.chapters || [],
      encoding: data.encoding,
    };
    // 清掉上一本的正文与流状态：两段式加载期间不能读到旧内容
    state.txtText = '';
    flow = null;
    const p = data.progress || {};
    state.page = Math.max(0, Math.min(p.pageIndex || 0, Math.max(0, state.book.pageCount - 1)));
    state.position = typeof p.position === 'number' ? p.position : null;
    state.fontSize = p.fontSize || state.settings.fontSize || 17;
    state.lineHeight = p.lineHeight || state.settings.lineHeight || 1.8;
    state.bgPreset = p.bgPreset || state.settings.bgPreset || 'white';
    state.fontFamily = p.fontFamily || state.settings.fontFamily || '';
    state.bookmarks = migrateBookmarks(p.bookmarks);
    state.findQuery = '';
    state.findHits = [];
    state.findIndex = -1;

    $('#reader-title').textContent = data.title;
    $('#reader-meta').textContent =
      data.format === 'txt'
        ? `TXT · ${data.encoding} · ${fmtCount(data.totalChars)} 字`
        : `PDF · ${state.book.pageCount} 页`;
    $('#reader-placeholder').hidden = true;
    applyReadingStyle();

    if (data.format === 'txt') {
      $('#pdf-pages').hidden = true;
      $('#txt-pages').hidden = false;
      // 目录先出（元信息里已经带回来了），正文随后
      renderChapters();
      if (loadTip) loadTip.textContent = '正在载入正文…';

      // 第二段：单独取正文
      const [text] = await Promise.all([
        window.moyu.book.text(bookId, data.encoding),
        // 让遮罩至少渲染一帧，避免「瞬间一闪」的观感
        new Promise((r) => requestAnimationFrame(() => r())),
      ]);
      if (token !== openToken) return null;

      if (typeof text !== 'string' || !text.length) {
        // 主进程读失败 / 空文件：给出明确提示，不要停在空白页上
        state.txtText = '';
        flow = null;
        renderPage();
        toast('文件内容为空或读取失败', 'err', 4000);
        return state.book;
      }

      state.txtText = text;
      state.book.totalChars = text.length;
      state.book.pageCount = Math.max(1, Math.ceil(text.length / PAGE_CHARS));
      flow = { chunks: buildChunks(), from: 0, to: -1 };
      renderChapters();
      // 恢复滚动位置：优先滚动级 position，其次旧版 pageIndex 换算
      let restoreOff = 0;
      if (typeof state.position === 'number' && state.position >= 0 && state.position < text.length) {
        restoreOff = state.position;
      } else if (p.pageIndex) {
        restoreOff = Math.min(p.pageIndex * PAGE_CHARS, text.length - 1);
      }
      renderPage(restoreOff);
    } else {
      $('#txt-pages').hidden = true;
      $('#pdf-pages').hidden = false;
      await openPdf(data.data, data.title);
    }
    if (token !== openToken) return null;

    // 还原 PDF 页内滚动比例
    if (data.format === 'pdf' && p.scrollRatio) {
      requestAnimationFrame(() => {
        const box = $('#pdf-pages');
        if (box) box.scrollTop = (box.scrollHeight - box.clientHeight) * p.scrollRatio;
      });
    }

    renderBookmarks();
    updateFooter();
    return state.book;
  } catch (err) {
    const code = err && (err.code || (err.message || '').match(/E_[A-Z_]+/)?.[0]);
    const msg =
      String(err && err.message).includes('E_MISSING') || code === 'E_MISSING'
        ? '文件已被移动或删除，请重新导入'
        : '无法打开：文件损坏、加密或格式不受支持';
    toast(msg, 'err', 5000);
    emit('library:refresh');
    return null;
  } finally {
    loading.hidden = true;
  }
}

function fmtCount(n) {
  if (!n) return '0';
  if (n < 10000) return String(n);
  return (n / 10000).toFixed(1) + ' 万';
}

async function askEncoding(detected) {
  const body = el('div', {}, [
    el('div', { text: '检测到的编码可能导致乱码，请选择正确的编码重新打开：' }),
    el('div', { class: 'opt-row', id: 'enc-row' }, []),
  ]);
  const wrap = el('div', {}, [body]);
  const choices = ['UTF-8', 'GBK', 'BIG5', 'UTF-16LE'];
  let chosen = null;
  const p = modal({
    title: '选择文本编码',
    body: wrap,
    actions: [
      { label: '取消', value: null },
      { label: '用此编码打开', primary: true, value: '__ok__' },
    ],
  });
  setTimeout(() => {
    const row = $('#enc-row');
    if (!row) return;
    choices.forEach((c) => {
      const b = el('button', {
        class: `btn small ${c === detected ? 'primary' : ''}`,
        text: c === detected ? `${c}（检测）` : c,
        onclick: (e) => {
          chosen = c;
          row.querySelectorAll('button').forEach((x) => x.classList.remove('primary'));
          e.currentTarget.classList.add('primary');
        },
      });
      row.append(b);
    });
  }, 10);
  const v = await p;
  return v === '__ok__' ? chosen || detected : null;
}

/* ------------------------------------------------------------------ *
 * TXT 连贯滚动渲染
 * ------------------------------------------------------------------ */

/** 旧书签/进度兼容：{page} → {position}（page*PAGE_CHARS 是当时的字符偏移） */
function migrateBookmarks(list) {
  return (Array.isArray(list) ? list : []).map((b) => ({
    id: b.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    position:
      typeof b.position === 'number'
        ? b.position
        : typeof b.page === 'number'
          ? b.page * PAGE_CHARS
          : 0,
    label: b.label || '',
    createdAt: b.createdAt || Date.now(),
  }));
}

function truncate(s, n) {
  const t = String(s || '').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 块 HTML：正文 pre-wrap 转义；有搜索词时块内命中包 <mark> */
function chunkHtml(ch) {
  const text = state.txtText.slice(ch.start, ch.end);
  if (!state.findQuery) return escapeHtml(text);
  const lq = state.findQuery.toLowerCase();
  if (!lq) return escapeHtml(text);
  const lower = text.toLowerCase();
  // 全局命中 -> 块内下标（runFind 时给每条命中编了号 h.i）
  const hitAt = new Map();
  (state.findHits || []).forEach((h) => {
    const local = h.at - ch.start;
    if (local >= 0 && local < text.length) hitAt.set(local, h.i);
  });
  let out = '';
  let i = 0;
  let guard = 0;
  while (guard++ < 2000) {
    const idx = lower.indexOf(lq, i);
    if (idx === -1) break;
    out += escapeHtml(text.slice(i, idx));
    const gi = hitAt.get(idx);
    out += `<mark class="hl${gi === state.findIndex ? ' current' : ''}"${gi != null ? ` data-hit="${gi}"` : ''}>${escapeHtml(text.substr(idx, lq.length))}</mark>`;
    i = idx + lq.length;
  }
  out += escapeHtml(text.slice(i));
  return out;
}

function chunkNode(idx) {
  const ch = flow.chunks[idx];
  const sec = el('section', { class: 'flow-chunk', 'data-chunk': String(idx) });
  if (ch.title) sec.append(el('h2', { class: 'flow-h', text: ch.title }));
  const body = el('div', { class: 'flow-body' });
  body.innerHTML = chunkHtml(ch);
  sec.append(body);
  if (idx === flow.chunks.length - 1) sec.append(el('div', { class: 'page-end', text: '— 全文完 —' }));
  return sec;
}

/** 整窗重建：以 center 为中心渲染 [center-R, center+R]（跳转/恢复/重排用） */
function renderWindow(center) {
  flow.from = Math.max(0, center - WIN_RADIUS);
  flow.to = Math.min(flow.chunks.length - 1, center + WIN_RADIUS);
  const host = $('#txt-flow');
  host.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (let i = flow.from; i <= flow.to; i++) frag.append(chunkNode(i));
  host.append(frag);
}

function appendNext() {
  if (flow.to >= flow.chunks.length - 1) return;
  flow.to++;
  $('#txt-flow').append(chunkNode(flow.to));
}

function prependPrev() {
  if (flow.from <= 0) return;
  const box = $('#txt-pages');
  const before = box.scrollHeight;
  flow.from--;
  $('#txt-flow').prepend(chunkNode(flow.from));
  // 顶部插入后内容整体下移，补偿 scrollTop 保证视觉不动
  box.scrollTop += box.scrollHeight - before;
}

/** 窗口太大时从远离可视中心的一端回收（顶部回收同样要补偿 scrollTop） */
function trimWindow() {
  const box = $('#txt-pages');
  const cur = chunkIndexForOffset(currentOffsetRaw());
  let guard = 0;
  while (flow.to - flow.from + 1 > MAX_WINDOW && guard++ < 20) {
    if (cur - flow.from < flow.to - cur && flow.to > cur + WIN_RADIUS) {
      $('#txt-flow').lastElementChild.remove();
      flow.to--;
    } else if (flow.from < cur - WIN_RADIUS) {
      const before = box.scrollHeight;
      $('#txt-flow').firstElementChild.remove();
      box.scrollTop += box.scrollHeight - before;
      flow.from++;
    } else {
      break;
    }
  }
}

/**
 * 渲染入口（兼容旧导出名）。
 * 传 off 则定位到该字符偏移；不传且已有流则保持当前位置。
 */
export function renderPage(off) {
  if (!state.book || state.book.format !== 'txt') return;
  const host = $('#txt-flow');
  if (!state.txtText || !flow) {
    // 正文尚未取回（第二段还在路上）：显示等待提示而不是空白页
    host.innerHTML = '<div class="page-tag">正在载入正文…</div>';
    updateFooter();
    return;
  }
  const target = typeof off === 'number' && off >= 0 ? off : currentOffsetRaw();
  scrollToOffset(target, 'auto');
}

/** 跳转到全文偏移：整窗重建后按块内比率定位 */
let pendingRestore = null; // 容器无尺寸时挂起的定位目标，恢复尺寸后补做

function scrollToOffset(off, behavior = 'auto') {
  if (!flow) return;
  const target = Math.max(0, Math.min(off, Math.max(0, state.txtText.length - 1)));
  const idx = chunkIndexForOffset(target);

  // 容器不可测量（边条模式 / 视图未激活）：先渲染窗口并挂起定位，
  // 等 ResizeObserver 检测到尺寸恢复再落位——否则会静默丢失阅读位置。
  if (!flowHasSize()) {
    pendingRestore = target;
    state.position = target;
    if (flow.to < flow.from || !$('#txt-flow').children.length) renderWindow(idx);
    syncScrollUi();
    return;
  }
  pendingRestore = null;

  renderWindow(idx);
  const box = $('#txt-pages');
  const node = $('#txt-flow').querySelector(`.flow-chunk[data-chunk="${idx}"]`);
  if (!node) return;
  const ch = flow.chunks[idx];
  const boxTop = box.getBoundingClientRect().top;
  const r = node.getBoundingClientRect();
  const ratio = (target - ch.start) / Math.max(1, ch.end - ch.start);
  const margin = Math.min(box.clientHeight * 0.25, 120);
  const top = box.scrollTop + (r.top - boxTop) + ratio * r.height - margin;
  box.scrollTo({ top: Math.max(0, top), behavior });
  syncScrollUi();
}

/** 字号/行距/字体/窗口尺寸变化后：保持字符偏移不变地重排 */
export const relayoutFlow = debounce(() => {
  if (!flow || !state.book || state.book.format !== 'txt' || !state.txtText) return;
  scrollToOffset(currentOffsetRaw(), 'auto');
}, 120);

/** 滚动同步：补块 / 回收 / 页脚 / 目录 / 进度 */
const onFlowScroll = throttle(function sync() {
  if (!flow || !state.book || state.book.format !== 'txt') return;
  const box = $('#txt-pages');
  const vh = Math.max(200, box.clientHeight);
  if (box.scrollHeight - box.scrollTop - vh < vh * 1.5 && flow.to < flow.chunks.length - 1) appendNext();
  if (box.scrollTop < vh * 1.5 && flow.from > 0) prependPrev();
  trimWindow();
  syncScrollUi();
}, 90);

/** 页脚 + 目录高亮 + 书签按钮 + 进度保存 */
function syncScrollUi() {
  const b = state.book;
  if (!b || b.format !== 'txt' || !flow) return;
  const off = currentOffsetRaw();
  state.page = Math.floor(off / PAGE_CHARS); // 兼容旧界面
  state.position = off;
  const pct = b.totalChars ? Math.round((off / b.totalChars) * 100) : 0;
  $('#page-info').textContent = `${pct}%`;
  const chIdx = flow.chunks[chunkIndexForOffset(off)].chapter;
  const chapters = b.chapters || [];
  const ctitle = chIdx >= 0 && chapters[chIdx] ? chapters[chIdx].title : '';
  const pctEl = $('#pct-info');
  pctEl.textContent = ctitle ? truncate(ctitle, 16) : '—';
  pctEl.title = ctitle || '';
  const range = $('#page-range');
  range.max = String(Math.max(1, b.totalChars || 1));
  range.value = String(off);
  updateTocActive();
  updateBookmarkBtn();
  saveProgressThrottled();
}

/** e2e/排错用：暴露流窗口状态（只读） */
if (typeof window !== 'undefined') {
  window.__flowDebug = () =>
    flow
      ? {
          from: flow.from,
          to: flow.to,
          chunks: flow.chunks.length,
          scrollTop: Math.round($('#txt-pages').scrollTop),
          scrollHeight: $('#txt-pages').scrollHeight,
          clientH: $('#txt-pages').clientHeight,
          pending: pendingRestore,
          position: state.position,
        }
      : null;
}

/* ------------------------------------------------------------------ *
 * 章节（TXT 自动识别 / PDF 大纲）
 * ------------------------------------------------------------------ */
function renderChapters() {
  const pane = $('#pane-toc');
  pane.innerHTML = '';
  tocActiveIdx = -1;
  const chapters = state.book.chapters || [];
  if (!chapters.length) {
    pane.append(el('p', { class: 'hint', text: '未识别到章节标题。可拖动底部进度条定位。', style: 'padding:8px' }));
    return;
  }
  const isTxt = state.book.format === 'txt';
  chapters.forEach((c, i) => {
    // TXT 用字符偏移（连贯滚动定位）；PDF 大纲给的是页码 —— 两者都要认
    const off = typeof c.offset === 'number' ? c.offset : null;
    const page = typeof c.pageIndex === 'number' ? c.pageIndex : c.page;
    if (isTxt && off == null) return;
    if (!isTxt && (typeof page !== 'number' || !Number.isFinite(page))) return;
    pane.append(
      el('button', {
        class: 'toc-item',
        'data-idx': String(i),
        title: c.title,
        onclick: () => (isTxt ? scrollToOffset(off, 'smooth') : gotoPage(page)),
      }, [el('b', { text: String(i + 1) }), document.createTextNode(c.title)]),
    );
  });
}

let tocActiveIdx = -1; // 缓存当前高亮项：目录可能有两千多条，不能每次滚动都全量遍历

function updateTocActive(force = false) {
  const pane = $('#pane-toc');
  if (!pane) return;
  const chapters = state.book && state.book.chapters ? state.book.chapters : [];
  let active = -1;
  if (state.book.format === 'txt') {
    if (flow) {
      const off = currentOffsetRaw();
      active = flow.chunks[chunkIndexForOffset(off)].chapter;
    }
  } else {
    for (let i = 0; i < chapters.length; i++) {
      const page = typeof chapters[i].pageIndex === 'number' ? chapters[i].pageIndex : chapters[i].page;
      if (page <= state.page) active = i;
      else break;
    }
  }
  if (active === tocActiveIdx && !force) return;
  // 只改动变化的两项，避免滚动时对几千个节点做 classList.toggle
  if (!force) {
    const prev = pane.querySelector('.toc-item.active');
    if (prev) prev.classList.remove('active');
    const next = pane.querySelectorAll('.toc-item')[active];
    if (next) {
      next.classList.add('active');
      // 让当前章在目录里保持可见（鼠标正悬停目录时不抢滚动）
      if (active >= 0 && !pane.matches(':hover')) next.scrollIntoView({ block: 'nearest' });
    }
    tocActiveIdx = active;
    return;
  }
  pane.querySelectorAll('.toc-item').forEach((n, i) => n.classList.toggle('active', i === active));
  tocActiveIdx = active;
}

/* ------------------------------------------------------------------ *
 * 书签（TXT 按字符偏移精确记录；PDF 按页码）
 * ------------------------------------------------------------------ */
const BOOKMARK_NEAR = 600; // 当前位置附近 ±600 字符内视为同一书签

export function toggleBookmark() {
  if (!state.book) return;
  const isTxt = state.book.format === 'txt';
  const pos = isTxt ? currentOffsetRaw() : state.page;
  const idx = state.bookmarks.findIndex((b) => Math.abs((b.position ?? b.page) - pos) < (isTxt ? BOOKMARK_NEAR : 1));
  if (idx >= 0) {
    state.bookmarks.splice(idx, 1);
    toast('已删除书签');
  } else {
    const label = isTxt
      ? (state.txtText || '').slice(pos, pos + 40).replace(/\s+/g, ' ').trim() || '书签'
      : `第 ${state.page + 1} 页`;
    state.bookmarks.push({ id: `${Date.now()}`, position: isTxt ? pos : undefined, page: isTxt ? undefined : state.page, label, createdAt: Date.now() });
    state.bookmarks.sort((a, b) => (a.position ?? (a.page || 0) * PAGE_CHARS) - (b.position ?? (b.page || 0) * PAGE_CHARS));
    toast('已添加书签', 'ok', 1600);
  }
  renderBookmarks();
  updateBookmarkBtn();
  flushProgress();
}

function renderBookmarks() {
  const pane = $('#pane-marks');
  pane.innerHTML = '';
  if (!state.bookmarks.length) {
    pane.append(el('p', { class: 'hint', text: '还没有书签。点工具栏「书签」在当前位置添加。', style: 'padding:8px' }));
    return;
  }
  const total = state.book && state.book.totalChars;
  state.bookmarks.forEach((b) => {
    const pos = typeof b.position === 'number' ? b.position : (b.page || 0) * PAGE_CHARS;
    const sub = state.book && state.book.format === 'txt'
      ? (total ? `${Math.round((pos / total) * 100)}%` : '')
      : `第 ${(b.page || 0) + 1} 页`;
    pane.append(
      el('div', { class: 'mark-item' }, [
        el('div', { class: 'm1', text: b.label, title: b.label }),
        el('div', { class: 'm2' }, [
          el('span', {
            text: sub,
            style: 'cursor:pointer',
            onclick: () => gotoBookmark(b),
          }),
          el('button', {
            text: '删除',
            onclick: () => {
              state.bookmarks = state.bookmarks.filter((x) => x.id !== b.id);
              renderBookmarks();
              updateBookmarkBtn();
              flushProgress();
            },
          }),
        ]),
      ]),
    );
  });
}

function gotoBookmark(b) {
  if (state.book.format === 'txt') scrollToOffset(b.position ?? 0, 'smooth');
  else gotoPage(b.page || 0);
}

function updateBookmarkBtn() {
  const btn = $('#btn-bookmark');
  if (!btn) return;
  const isTxt = state.book && state.book.format === 'txt';
  const pos = isTxt ? currentOffsetRaw() : state.page;
  const near = isTxt ? BOOKMARK_NEAR : 0.5;
  const has = state.bookmarks.some((b) => Math.abs((b.position ?? b.page) - pos) <= near);
  btn.classList.toggle('on', has);
  btn.title = has ? '删除当前书签' : '在当前位置添加书签';
}

/* ------------------------------------------------------------------ *
 * 翻页 / 跳转
 *   TXT：gotoPage(旧页码) 换算成字符偏移定位；next/prev = 整屏平滑翻动
 *   PDF：保持逐页
 * ------------------------------------------------------------------ */
export function gotoPage(page, opts = {}) {
  if (!state.book) return;
  const total = state.book.pageCount;
  if (!Number.isFinite(page)) return; // 目录项缺页码时不要跳到 NaN
  const target = Math.max(0, Math.min(total - 1, Math.round(page)));
  if (state.book.format === 'txt') {
    // 旧「页码」接口 = 字符偏移 page*PAGE_CHARS，交给流式定位
    if (flow) scrollToOffset(target * PAGE_CHARS, 'auto');
    updateBookmarkBtn();
    return;
  }
  if (target === state.page && !opts.force) return;
  state.page = target;
  scrollToPdfPage(state.page);
  updateFooter();
  saveProgressThrottled();
  updateBookmarkBtn();
}

/** 整屏翻动（TXT）：平滑滚动约一屏；到头给提示 */
function flipScreen(dir) {
  const box = $('#txt-pages');
  if (!box) return;
  const max = box.scrollHeight - box.clientHeight;
  const target = box.scrollTop + dir * box.clientHeight * 0.88;
  if (dir > 0 && box.scrollTop >= max - 2) {
    toast('已经是最后了', '', 1200);
    return;
  }
  if (dir < 0 && box.scrollTop <= 2) {
    toast('已经是开头', '', 1200);
    return;
  }
  box.scrollTo({ top: Math.max(0, Math.min(max, target)), behavior: 'smooth' });
}

export function nextPage() {
  if (!state.book) return;
  if (state.book.format === 'txt') flipScreen(1);
  else if (state.page < state.book.pageCount - 1) gotoPage(state.page + 1);
  else toast('已经是最后一页', '', 1200);
}

export function prevPage() {
  if (!state.book) return;
  if (state.book.format === 'txt') flipScreen(-1);
  else if (state.page > 0) gotoPage(state.page - 1);
  else toast('已经是第一页', '', 1200);
}

function updateFooter() {
  if (state.book && state.book.format === 'txt') {
    if (flow) syncScrollUi();
    return;
  }
  const total = state.book ? state.book.pageCount : 0;
  $('#page-info').textContent = total ? `${state.page + 1} / ${total}` : '— / —';
  const pct = total ? Math.round(((state.page + 1) / total) * 100) : 0;
  $('#pct-info').textContent = `${pct}%`;
  const range = $('#page-range');
  range.max = String(Math.max(0, total - 1));
  range.value = String(state.page);
}

/* ------------------------------------------------------------------ *
 * PDF
 * ------------------------------------------------------------------ */
async function openPdf(arrayBuffer, title) {
  const box = $('#pdf-pages');
  box.innerHTML = '<div class="pdf-loading">正在解析 PDF…</div>';
  try {
    const lib = await loadPdfjs();
    if (state.pdf && state.pdf.doc) {
      try { await state.pdf.doc.destroy(); } catch { /* 忽略 */ }
    }
    const doc = await lib.getDocument({
      data: arrayBuffer,
      cMapUrl: new URL('../../vendor/pdf/cmaps/', import.meta.url).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('../../vendor/pdf/standard_fonts/', import.meta.url).href,
      wasmUrl: new URL('../../vendor/pdf/wasm/', import.meta.url).href,
    }).promise;

    state.book.pageCount = doc.numPages;
    state.pdf = { doc, scale: 1, fitWidth: true, rendered: new Map(), observer: null };
    $('#reader-meta').textContent = `PDF · ${doc.numPages} 页`;

    // 大纲作为目录
    try {
      const outline = await doc.getOutline();
      state.book.chapters = outline ? await flattenOutline(doc, outline) : [];
    } catch {
      state.book.chapters = [];
    }
    renderChapters();

    box.innerHTML = '';
    for (let i = 1; i <= doc.numPages; i++) {
      box.append(
        el('div', { class: 'pdf-page', 'data-page': String(i - 1), id: `pdfpage-${i - 1}` }, [
          el('div', { class: 'pdf-page-inner', style: 'min-height:40px' }),
          el('div', { class: 'pdf-no', text: String(i) }),
        ]),
      );
    }

    await layoutPdfPages(true);

    // 懒渲染：只在可视范围附近的页渲染
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const idx = Number(e.target.dataset.page);
            renderPdfPage(idx, { near: true });
          }
        }
      },
      { root: box, rootMargin: '300px 0px' },
    );
    box.querySelectorAll('.pdf-page').forEach((n) => obs.observe(n));
    state.pdf.observer = obs;

    // 滚动 -> 当前页 + 进度
    box.onscroll = throttle(() => {
      const pages = box.querySelectorAll('.pdf-page');
      const mid = box.scrollTop + box.clientHeight * 0.35;
      let cur = 0;
      for (const p of pages) {
        if (p.offsetTop <= mid + 40) cur = Number(p.dataset.page);
      }
      if (cur !== state.page) {
        state.page = cur;
        updateFooter();
        updateTocActive();
        updateBookmarkBtn();
        saveProgressThrottled();
      }
    }, 120);

    scrollToPdfPage(state.page, true);
  } catch (err) {
    console.error('[pdf] 打开失败', err);
    box.innerHTML = '';
    const wrap = el('div', { class: 'reader-placeholder' }, [
      el('h2', { text: 'PDF 无法渲染' }),
      el('p', { text: String((err && err.message) || err).slice(0, 200) }),
      el('p', { text: '文件可能已损坏、加密或使用了不支持的加密算法。' }),
    ]);
    box.append(wrap);
    toast('PDF 打开失败', 'err', 4000);
  }
}

async function flattenOutline(doc, items, depth = 0, out = []) {
  for (const item of items) {
    let page = 0;
    try {
      let dest = item.dest;
      if (typeof dest === 'string') dest = await doc.getDestination(dest);
      if (Array.isArray(dest) && dest[0]) {
        const ref = dest[0];
        page = typeof ref === 'object' ? await doc.getPageIndex(ref) : Number(ref);
      }
    } catch {
      page = 0;
    }
    out.push({ title: `${'　'.repeat(depth)}${item.title || ''}`.trim(), page: page || 0 });
    if (item.items && item.items.length && depth < 3) {
      await flattenOutline(doc, item.items, depth + 1, out);
    }
  }
  return out;
}

/** 按容器宽度计算展示比例（适应宽度）与每页尺寸占位 */
async function layoutPdfPages(rebuild = false) {
  if (!state.pdf || !state.pdf.doc) return;
  const box = $('#pdf-pages');
  const avail = Math.max(320, box.clientWidth - 40);
  const first = await state.pdf.doc.getPage(1);
  const base = first.getViewport({ scale: 1 });
  const scale = state.pdf.fitWidth ? avail / base.width : state.pdf.scale || 1;
  state.pdf.scale = state.pdf.fitWidth ? scale : state.pdf.scale;

  for (let i = 0; i < state.pdf.doc.numPages; i++) {
    const holder = $(`#pdfpage-${i}`)?.querySelector('.pdf-page-inner');
    if (!holder) continue;
    const pg = await (i === 0 ? Promise.resolve(first) : state.pdf.doc.getPage(i + 1));
    const vp = pg.getViewport({ scale: state.pdf.scale });
    holder.style.width = `${Math.floor(vp.width)}px`;
    holder.style.height = `${Math.floor(vp.height)}px`;
    holder.dataset.ready = '';
  }
  // 尺寸变化后清空已渲染缓存，重新绘制可视区
  state.pdf.rendered.clear();
  const visible = Math.floor(box.scrollTop / Math.max(1, box.clientHeight));
  for (let i = Math.max(0, visible - 1); i < Math.min(state.pdf.doc.numPages, visible + 3); i++) {
    renderPdfPage(i);
  }
}

async function renderPdfPage(index, opts = {}) {
  if (!state.pdf || !state.pdf.doc) return;
  const holder = $(`#pdfpage-${index}`)?.querySelector('.pdf-page-inner');
  if (!holder) return;
  const key = `${index}@${state.pdf.scale.toFixed(3)}`;
  if (state.pdf.rendered.get(index) === key) return;

  const task = { cancelled: false };
  state.pdf.rendered.set(index, `pending:${key}`);
  try {
    const page = await state.pdf.doc.getPage(index + 1);
    if (task.cancelled) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const vp = page.getViewport({ scale: state.pdf.scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = `${Math.floor(vp.width)}px`;
    canvas.style.height = `${Math.floor(vp.height)}px`;
    const ctx = canvas.getContext('2d', { alpha: false });
    const renderTask = page.render({
      canvasContext: ctx,
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    });
    await renderTask.promise;
    holder.replaceChildren(canvas);

    // 文本层：支持选择与复制（pdf.js 4.x 的 TextLayer 类）
    try {
      const lib = await loadPdfjs();
      if (lib.TextLayer) {
        const tlDiv = document.createElement('div');
        tlDiv.className = 'textLayer';
        holder.append(tlDiv);
        const textLayer = new lib.TextLayer({
          textContentSource: page.streamTextContent({ includeMarkedContent: true }),
          container: tlDiv,
          viewport: vp,
        });
        await textLayer.render();
      }
    } catch (e) {
      console.warn('[pdf] 文本层渲染失败（不影响阅读）', e);
    }

    state.pdf.rendered.set(index, key);
  } catch (err) {
    if (String(err && err.name) !== 'RenderingCancelledException') {
      console.warn('[pdf] 单页渲染失败', index, err);
      state.pdf.rendered.delete(index);
    }
  }
}

function scrollToPdfPage(page, instant = false) {
  const holder = $(`#pdfpage-${page}`);
  const box = $('#pdf-pages');
  if (!holder || !box) return;
  box.scrollTo({ top: holder.offsetTop - 8, behavior: instant ? 'auto' : 'smooth' });
}

/* ------------------------------------------------------------------ *
 * 全文搜索（TXT 全文 / PDF 当前页文本）
 * ------------------------------------------------------------------ */
export async function runFind(query) {
  state.findQuery = query;
  state.findHits = [];
  state.findIndex = -1;
  const list = $('#find-results');
  const pane = $('#pane-find');
  pane.hidden = false;
  $('#pane-toc').hidden = true;
  $('#pane-marks').hidden = true;
  document.querySelectorAll('.side-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'find'));
  list.innerHTML = '';
  if (!query) {
    // 清空搜索：把已渲染块的高亮标记去掉，否则 mark 会残留在页面上
    if (flow && state.book.format === 'txt' && state.txtText) {
      renderWindow(chunkIndexForOffset(currentOffsetRaw()));
    }
    return;
  }

  if (state.book.format === 'txt') {
    const lower = state.txtText.toLowerCase();
    const lq = query.toLowerCase();
    let idx = 0;
    let guard = 0;
    while (guard++ < 2000) {
      const at = lower.indexOf(lq, idx);
      if (at === -1) break;
      const from = Math.max(0, at - 24);
      const snippet = state.txtText.slice(from, at + query.length + 24).replace(/\s+/g, ' ');
      state.findHits.push({ at, i: state.findHits.length, snippet });
      idx = at + lq.length;
      if (state.findHits.length >= 800) break;
    }
    const total = state.book.totalChars || 1;
    state.findHits.forEach((h) => {
      const frag = el('div', {
        class: 'fr',
        onclick: () => {
          state.findIndex = h.i;
          scrollToOffset(h.at, 'smooth'); // 整窗重建会带上 current 高亮
        },
      });
      const escaped = escapeHtml(h.snippet);
      frag.innerHTML = `${escaped.replace(new RegExp(escapeReg(escapeHtml(query)), 'gi'), (m) => `<em>${m}</em>`)}<div class="pg">${Math.round((h.at / total) * 100)}% 处</div>`;
      list.append(frag);
    });
    if (!state.findHits.length) list.append(el('p', { class: 'hint', text: '没有找到匹配内容', style: 'padding:8px' }));
    else {
      // 立刻在当前可视块里画出高亮
      renderWindow(chunkIndexForOffset(currentOffsetRaw()));
      findNextTxt();
    }
  } else {
    // PDF：搜索当前页文本
    list.append(el('p', { class: 'hint', text: 'PDF 暂只支持当前页内匹配（点击下方按钮定位）', style: 'padding:8px' }));
    list.append(el('div', { class: 'fr', text: '在页面中查找（Ctrl+F）', onclick: () => openBrowserFind() }));
  }
}

export function findNextTxt() {
  if (!state.findHits || !state.findHits.length) {
    toast('没有匹配结果', '', 1400);
    return;
  }
  state.findIndex = (state.findIndex + 1) % state.findHits.length;
  const hit = state.findHits[state.findIndex];
  scrollToOffset(hit.at, 'smooth'); // 整窗重建会带上 current 高亮
}

function escapeReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function openBrowserFind() {
  const bar = $('#browser-find');
  if (bar) bar.hidden = false;
}

/* ------------------------------------------------------------------ *
 * 视图内交互绑定
 * ------------------------------------------------------------------ */
export function initReader() {
  observeStageResize();
  $('#btn-reader-back').onclick = () => emit('view:goto', 'library');
  $('#btn-prev').onclick = () => prevPage();
  $('#btn-next').onclick = () => nextPage();
  $('#btn-bookmark').onclick = () => toggleBookmark();
  $('#btn-goto-library').onclick = () => emit('view:goto', 'library');

  // TXT：滚动驱动补块/进度；滑条直接映射字符偏移
  $('#txt-pages').addEventListener('scroll', onFlowScroll, { passive: true });
  // 尺寸恢复（边条展开 / 视图切回）后补做挂起的定位
  const flowBox = $('#txt-pages');
  if (flowBox && !flowBox.__ro) {
    flowBox.__ro = new ResizeObserver(() => {
      if (!flow || !flowHasSize()) return;
      const h = flowBox.clientHeight;
      const w = flowBox.clientWidth;
      // 滚动条出现/消失引起的 1~15px 宽度抖动不触发重排，避免来回震荡
      const sizeChanged = Math.abs(h - (flowBox.__lastH || 0)) > 4 || Math.abs(w - (flowBox.__lastW || 0)) > 24;
      flowBox.__lastH = h;
      flowBox.__lastW = w;
      if (pendingRestore != null) {
        const off = pendingRestore;
        pendingRestore = null;
        scrollToOffset(off, 'auto');
      } else if (sizeChanged) {
        // 尺寸变化后块高度变了：保持字符偏移重排
        relayoutFlow();
      }
    });
    flowBox.__ro.observe(flowBox);
  }
  $('#page-range').oninput = (e) => {
    const off = Number(e.target.value);
    const total = state.book && state.book.totalChars ? state.book.totalChars : 0;
    if (total) $('#page-info').textContent = `${Math.round((off / total) * 100)}%`;
  };
  $('#page-range').onchange = (e) => {
    if (state.book && state.book.format === 'txt') scrollToOffset(Number(e.target.value), 'auto');
    else gotoPage(Number(e.target.value));
  };

  $('#btn-jump').onclick = async () => {
    const total = state.book && state.book.totalChars ? state.book.totalChars : 0;
    if (!total) return;
    const cur = state.book.format === 'txt' ? (flow ? currentOffsetRaw() : 0) : state.page;
    const curPct = state.book.format === 'txt' ? Math.round((cur / total) * 100) : Math.round(((state.page + 1) / (state.book.pageCount || 1)) * 100);
    const input = el('input', {
      type: 'number', min: 0, max: 100, value: Math.min(100, curPct),
      style: 'width:100%;border:1px solid #d3d8de;border-radius:8px;padding:7px 10px;user-select:text',
    });
    const v = await modal({
      title: '跳转位置',
      body: el('div', {}, [el('div', { text: '输入百分比（0-100）：', style: 'margin-bottom:8px' }), input]),
      actions: [{ label: '取消', value: null }, { label: '跳转', primary: true, value: '__ok__' }],
    });
    if (v !== '__ok__') return;
    const pct = Math.max(0, Math.min(100, Number(input.value) || 0));
    if (state.book.format === 'txt') scrollToOffset(Math.floor((pct / 100) * total), 'auto');
    else gotoPage(Math.floor((pct / 100) * (state.book.pageCount - 1)));
  };

  // 侧栏：目录 / 书签 / 搜索
  $('#btn-toc').onclick = () => {
    state.sideOpen = !state.sideOpen;
    $('#reader-side').classList.toggle('collapsed', !state.sideOpen);
    $('#btn-toc').classList.toggle('on', state.sideOpen);
    if (state.book && state.book.format === 'pdf') layoutPdfPages();
    // 窄窗口下侧栏是抽屉，需要同步半透明遮罩
    emit('side:changed');
  };
  document.querySelectorAll('.side-tab').forEach((tab) => {
    tab.onclick = () => {
      const t = tab.dataset.tab;
      document.querySelectorAll('.side-tab').forEach((x) => x.classList.toggle('active', x === tab));
      $('#pane-toc').hidden = t !== 'toc';
      $('#pane-marks').hidden = t !== 'marks';
      $('#pane-find').hidden = t !== 'find';
    };
  });
  $('#btn-find').onclick = () => {
    if (!state.sideOpen) $('#btn-toc').click();
    document.querySelector('.side-tab[data-tab="find"]').click();
    $('#find-input').focus();
  };
  $('#find-input').onkeydown = (e) => {
    if (e.key === 'Enter') runFind(e.target.value.trim());
  };
  $('#find-next').onclick = () => findNextTxt();

  // 阅读设置弹层
  const pop = $('#reader-settings-pop');
  $('#btn-reader-settings').onclick = (e) => {
    e.stopPropagation();
    pop.hidden = !pop.hidden;
  };
  document.addEventListener('click', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && e.target.id !== 'btn-reader-settings') pop.hidden = true;
  });
  $('#fs-range').oninput = (e) => {
    state.fontSize = Number(e.target.value);
    applyReadingStyle();
    saveProgressThrottled();
  };
  $('#lh-select').onchange = (e) => {
    state.lineHeight = Number(e.target.value);
    applyReadingStyle();
    saveProgressThrottled();
  };
  $('#font-select').onchange = (e) => {
    state.fontFamily = e.target.value;
    applyReadingStyle();
    saveProgressThrottled();
  };
  document.querySelectorAll('#bg-swatches .sw').forEach((b) => {
    b.onclick = () => {
      state.bgPreset = b.dataset.bg;
      applyReadingStyle();
      saveProgressThrottled();
    };
  });

  // 字体列表来自系统（Chromium 只能枚举到常见字体，这里给一个实用清单）
  const FONTS = ['微软雅黑', '宋体', '楷体', '仿宋', '黑体', '等线', '新宋体', '思源宋体', 'Noto Serif SC', 'Georgia', 'Consolas'];
  const fsel = $('#font-select');
  FONTS.forEach((f) => fsel.append(el('option', { value: f, text: f })));

  // 翻页方式：连贯滚动（原生滚轮）/ 整屏翻动（拦截滚轮做动画）
  const wheelSel = $('#wheel-select');
  if (wheelSel) {
    wheelSel.value = (state.settings && state.settings.wheelMode) || 'scroll';
    wheelSel.onchange = async () => {
      try {
        const res = await window.moyu.settings.update({ wheelMode: wheelSel.value });
        state.settings = res.settings;
        toast(wheelSel.value === 'screen' ? '已切换为整屏翻动' : '已切换为连贯滚动', 'ok', 1600);
      } catch {
        toast('保存设置失败', 'err', 2000);
      }
    };
  }

  // 键盘翻页
  window.addEventListener('keydown', onReaderKeys);

  // 鼠标滚轮（TXT）：
  //   wheelMode=scroll（默认）→ 不拦截，原生连贯滚动
  //   wheelMode=screen        → 拦截并动画翻一屏
  let wheelAnim = 0;
  $('#txt-pages').addEventListener('wheel', (e) => {
    if (!state.book || state.book.format !== 'txt' || !flow) return;
    if (e.ctrlKey) return;
    const mode = (state.settings && state.settings.wheelMode) || 'scroll';
    if (mode !== 'screen') return; // 连贯滚动：交给浏览器
    e.preventDefault();
    if (wheelAnim) return;
    const box = $('#txt-pages');
    const max = box.scrollHeight - box.clientHeight;
    const dir = e.deltaY > 0 ? 1 : -1;
    const start = box.scrollTop;
    const dist = Math.max(0, Math.min(max, start + dir * box.clientHeight * 0.88)) - start;
    if (!dist) return;
    const t0 = performance.now();
    const DUR = 420;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / DUR);
      box.scrollTop = start + dist * (1 - Math.pow(1 - k, 3)); // easeOutCubic
      wheelAnim = k < 1 ? requestAnimationFrame(step) : 0;
    };
    wheelAnim = requestAnimationFrame(step);
  }, { passive: false });
}

function onReaderKeys(e) {
  if (state.view !== 'reader') return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
    e.preventDefault();
    state.fontSize = Math.min(28, state.fontSize + 1);
    applyReadingStyle();
    saveProgressThrottled();
    return;
  }
  if (e.ctrlKey && e.key === '-') {
    e.preventDefault();
    state.fontSize = Math.max(14, state.fontSize - 1);
    applyReadingStyle();
    saveProgressThrottled();
    return;
  }
  if (e.ctrlKey) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
    e.preventDefault();
    nextPage();
  } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
    e.preventDefault();
    prevPage();
  } else if (e.key === 'Home') {
    e.preventDefault();
    if (state.book.format === 'txt' && flow) scrollToOffset(0, 'auto');
    else gotoPage(0);
  } else if (e.key === 'End') {
    e.preventDefault();
    if (state.book.format === 'txt' && flow) scrollToOffset((state.txtText || '').length - 1, 'auto');
    else gotoPage(state.book ? state.book.pageCount - 1 : 0);
  }
}

/** 窗口尺寸变化后重排 PDF */
export const relayoutPdf = debounce(() => {
  if (state.book && state.book.format === 'pdf' && state.pdf) layoutPdfPages(true);
}, 250);

/**
 * 阅读区宽度变化（窗口缩放 / 侧栏抽屉开合 / 断点切换）后重排 PDF。
 * 不做的话 canvas 还是旧宽度，窄窗口下会出现横向滚动条。
 */
export function observeStageResize() {
  const stage = $('#reader-stage');
  if (!stage || stage.__ro) return;
  const ro = new ResizeObserver(() => {
    relayoutPdf();
    relayoutFlow();
  });
  ro.observe(stage);
  stage.__ro = ro;
}

export function closeBookOnExit() {
  if (state.pdf && state.pdf.observer) state.pdf.observer.disconnect();
  if (state.pdf && state.pdf.doc) {
    try { state.pdf.doc.destroy(); } catch { /* 忽略 */ }
  }
  state.pdf = null;
  flow = null;
}
