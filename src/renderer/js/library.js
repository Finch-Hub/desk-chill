/* ==================================================================
   library.js —— 书库视图：导入（对话框 / 拖拽）、排序、打开、移除、改名
   ================================================================== */

import { $, $$, el, state, fmtSize, fmtTime, emit } from './state.js';
import { toast, confirmDialog, promptDialog } from './ui.js';

export function initLibrary() {
  $('#btn-import').onclick = doPick;
  $('#btn-import-empty').onclick = doPick;

  $$('#sort-seg .seg-btn').forEach((b) => {
    b.onclick = () => {
      state.sort = b.dataset.sort;
      $$('#sort-seg .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
      renderShelf();
    };
  });

  emit('library:refresh');
}

async function doPick() {
  const res = await window.moyu.library.pick();
  if (!res || !res.length) return;
  handleImportResult(res);
}

export function handleImportResult(results) {
  if (!results || !results.length) return;
  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  if (ok.length === 1) toast(`已导入《${ok[0].book.title}》`, 'ok');
  else if (ok.length > 1) toast(`已导入 ${ok.length} 本`, 'ok');
  bad.forEach((r) => {
    const name = (r.path || '').split(/[\\/]/).pop() || '';
    const reason =
      r.errType === 'format' ? '不支持的格式（仅 TXT / PDF）' :
      r.errType === 'missing' ? '文件不存在' :
      r.errType === 'pdf' ? 'PDF 文件损坏或加密' : '无法打开';
    toast(`${name}：${reason}`, 'err', 4500);
  });
  emit('library:refresh');
  if (ok.length === 1) {
    // 单本导入后直接进入阅读，符合「导入即读」的主流程
    emit('open-book', ok[0].book.bookId);
  }
}

/** 拖拽导入：整窗监听 */
export function initDropZone() {
  const mask = $('#drop-mask');
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
    depth++;
    mask.hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) mask.hidden = true;
  });
  window.addEventListener('drop', async (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    depth = 0;
    mask.hidden = true;
    const files = Array.from(e.dataTransfer.files || []);
    if (!files.length) return;
    const paths = files.map((f) => window.moyu.library.pathForFile(f)).filter(Boolean);
    if (!paths.length) {
      toast('无法读取拖入的文件路径', 'err');
      return;
    }
    const res = await window.moyu.library.importPaths(paths);
    handleImportResult(res);
  });
}

export async function refreshLibrary() {
  const data = await window.moyu.library.list();
  state.books = data.books || [];
  state.lastBookId = data.lastBookId || null;
  renderShelf();
  $('#library-sub').textContent = state.books.length
    ? `${state.books.length} 本书 · 拖入 TXT / PDF 即可继续添加`
    : '支持 TXT / PDF，拖入窗口即可导入';
}

function sorted(books) {
  const list = [...books];
  if (state.sort === 'title') {
    list.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
  } else if (state.sort === 'added') {
    list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  } else {
    list.sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0) || (b.addedAt || 0) - (a.addedAt || 0));
  }
  return list;
}

export function renderShelf() {
  const shelf = $('#shelf');
  const empty = $('#library-empty');
  shelf.innerHTML = '';
  if (!state.books.length) {
    empty.hidden = false;
    shelf.hidden = true;
    return;
  }
  empty.hidden = true;
  shelf.hidden = false;

  for (const b of sorted(state.books)) {
    const pct = Math.max(0, Math.min(100, b.progressPercent || 0));
    const card = el('div', {
      class: `book ${b.missing ? 'missing' : ''}`,
      title: b.filePath,
      onclick: () => emit('open-book', b.bookId),
      oncontextmenu: (e) => {
        e.preventDefault();
        showMenu(b, e);
      },
    }, [
      el('div', { class: 'book-top' }, [
        el('div', { class: `fmt ${b.format}`, text: b.format === 'pdf' ? 'PDF' : 'TXT' }),
        el('div', { class: 'book-title', text: b.title || '未命名' }),
      ]),
      el('div', { class: 'book-bar' }, [el('i', { style: `width:${pct}%` })]),
      el('div', { class: 'book-sub' }, [
        el('span', { text: b.missing ? '文件已移除' : `${pct}% · ${fmtSize(b.size)}` }),
        el('span', { text: b.lastOpenedAt ? fmtTime(b.lastOpenedAt) : fmtTime(b.addedAt) }),
      ]),
    ]);
    if (b.bookId === state.lastBookId) {
      card.append(el('span', { class: 'book-tag', text: '在读', style: 'background:#e8f0ff;color:#2f6feb' }));
    }
    shelf.append(card);
  }
}

function showMenu(book, e) {
  const menu = el('div', {
    class: 'pop',
    style: `position:fixed;left:${Math.min(e.clientX, window.innerWidth - 220)}px;top:${Math.min(e.clientY, window.innerHeight - 200)}px;width:180px;padding:6px;gap:2px;z-index:70`,
  }, [
    menuItem('打开', () => emit('open-book', book.bookId)),
    menuItem('重命名', async () => {
      const t = await promptDialog('重命名书名', book.title);
      if (t) {
        await window.moyu.library.rename(book.bookId, t);
        refreshLibrary();
      }
    }),
    menuItem('在文件夹中显示', () => window.moyu.shell.openPath(book.filePath)),
    menuItem('从书库移除', async () => {
      const ok = await confirmDialog(
        '从书库移除',
        `将《${book.title}》从书库移除？<br><span style="color:#8b939d">只删除书库引用与阅读进度，不会删除源文件。</span>`,
        '移除',
      );
      if (ok) {
        await window.moyu.library.remove(book.bookId);
        toast('已从书库移除');
        refreshLibrary();
      }
    }, true),
  ]);
  document.body.append(menu);
  const close = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener('mousedown', close, true);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', close, true), 0);
}

function menuItem(label, fn, danger = false) {
  return el('button', {
    class: 'toc-item',
    text: label,
    style: danger ? 'color:#d9483f' : '',
    onclick: () => fn(),
  });
}
