/* ==================================================================
   ui.js —— Toast / 模态 / 通用交互
   ================================================================== */

import { $, el } from './state.js';

export function toast(msg, type = '', ttl = 3000) {
  const box = $('#toasts');
  if (!box) return;
  const node = el('div', { class: `toast ${type}`, text: msg });
  box.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, ttl);
}

/**
 * 通用模态。
 * @param {{title?:string, body?:string|Node, actions?:{label:string, primary?:boolean, value:any}[]}} opts
 * @returns {Promise<any>} 选中的 action.value
 */
export function modal(opts) {
  return new Promise((resolve) => {
    const mask = $('#modal-mask');
    const title = $('#modal-title');
    const body = $('#modal-body');
    const actions = $('#modal-actions');
    title.textContent = opts.title || '提示';
    body.innerHTML = '';
    if (typeof opts.body === 'string') body.innerHTML = opts.body;
    else if (opts.body) body.append(opts.body);
    actions.innerHTML = '';

    const close = (value) => {
      mask.hidden = true;
      resolve(value);
    };

    (opts.actions || [{ label: '好', primary: true, value: true }]).forEach((a) => {
      actions.append(
        el('button', {
          class: `btn ${a.primary ? 'primary' : ''}`,
          text: a.label,
          onclick: () => close(a.value),
        }),
      );
    });
    mask.onclick = (e) => {
      if (e.target === mask) close(null);
    };
    mask.hidden = false;
  });
}

export function confirmDialog(title, message, okLabel = '确定', cancelLabel = '取消') {
  return modal({
    title,
    body: message,
    actions: [
      { label: cancelLabel, value: false },
      { label: okLabel, primary: true, value: true },
    ],
  });
}

export function promptDialog(title, value, placeholder = '') {
  const input = el('input', {
    type: 'text',
    value,
    placeholder,
    style: 'width:100%;border:1px solid #d3d8de;border-radius:8px;padding:7px 10px;user-select:text',
  });
  const wrap = el('div', {}, [input]);
  setTimeout(() => {
    input.focus();
    input.select();
  }, 30);
  const p = modal({
    title,
    body: wrap,
    actions: [
      { label: '取消', value: null },
      { label: '确定', primary: true, value: '__ok__' },
    ],
  });
  return p.then((v) => (v === '__ok__' ? input.value.trim() : null));
}

/** 简易确认键捕获（老板键改写） */
export function captureHotkey() {
  return new Promise((resolve) => {
    const body = el('div', {
      text: '请按下要使用的组合键（例如 F8 / Ctrl+Shift+M）…按 Esc 取消',
      style: 'padding:14px 0;font-size:12.5px;color:#5b636d',
    });
    const ACCEPT = /^(F\d{1,2}|[A-Z0-9]|Space|Tab|Insert|Delete|Home|End|PageUp|PageDown|Up|Down|Left|Right|[\x60\-=\\\[\];',./])$/;
    const keyFor = (e) => {
      const mods = [];
      if (e.ctrlKey) mods.push('Ctrl');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');
      if (e.metaKey) mods.push('Super');
      let key = e.key;
      if (key === ' ') key = 'Space';
      if (key.length === 1) key = key.toUpperCase();
      if (mods.length === 0 && !ACCEPT.test(key)) return null;
      return [...mods, key].join('+');
    };
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        cleanup();
        resolve(null);
        return;
      }
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      const combo = keyFor(e);
      if (!combo) {
        body.textContent = '这个键不支持，请换一个（F1—F12 或带 Ctrl/Alt 的组合）';
        return;
      }
      cleanup();
      resolve(combo);
    };
    const cleanup = () => {
      window.removeEventListener('keydown', onKey, true);
      mask?.remove();
    };
    const mask = modal({ title: '设置老板键', body, actions: [] });
    // modal 返回 Promise，这里只需要它的 DOM；手动加一个取消按钮
    window.addEventListener('keydown', onKey, true);
    setTimeout(() => {
      const m = document.querySelector('.modal-actions');
      if (m) {
        m.append(
          el('button', {
            class: 'btn',
            text: '取消',
            onclick: () => {
              cleanup();
              resolve(null);
              document.querySelector('#modal-mask').hidden = true;
            },
          }),
        );
      }
    }, 20);
    mask.then(() => resolve(null));
  });
}
