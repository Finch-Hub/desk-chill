/* ==================================================================
   settings.js —— 设置视图（全部落盘到 settings.json，即时生效）
   ================================================================== */

import { $, $$, el, state, emit } from './state.js';
import { toast, confirmDialog, modal } from './ui.js';

let edgeChoice = 'left';

export function initSettings() {
  const bind = (sel, key, kind = 'value') => {
    const node = $(sel);
    if (!node) return;
    const handler = async () => {
      let v;
      if (kind === 'checked') v = node.checked;
      else if (kind === 'number') v = Number(node.value);
      else v = node.value;
      await patch({ [key]: v });
    };
    node.addEventListener(kind === 'checked' ? 'change' : 'change', handler);
  };

  bind('#s-fontSize', 'fontSize', 'number');
  bind('#s-lineHeight', 'lineHeight', 'number');
  bind('#s-bgPreset', 'bgPreset');
  bind('#s-edgeDockEnabled', 'edgeDockEnabled', 'checked');
  bind('#s-autoDockOnLeave', 'autoDockOnLeave', 'checked');
  bind('#s-alwaysOnTop', 'alwaysOnTop', 'checked');
  bind('#s-bossEnabled', 'bossEnabled', 'checked');
  bind('#s-launchAtStartup', 'launchAtStartup', 'checked');
  bind('#s-proxyMode', 'proxyMode');
  bind('#s-proxyRules', 'proxyRules');
  bind('#s-ignoreCertErrors', 'ignoreCertErrors', 'checked');

  $('#s-clearCache').onclick = async () => {
    const ok = await window.moyu.browser.clearCache();
    toast(ok ? '浏览缓存已清空，已重新加载当前页' : '清缓存失败', ok ? 'ok' : 'err', 2600);
  };

  // 联网诊断：把「实际生效的代理」和站点连通性摆出来，避免盲猜
  $('#s-netCheck').onclick = async () => {
    const btn = $('#s-netCheck');
    btn.disabled = true;
    btn.textContent = '检测中…';
    try {
      const r = await window.moyu.browser.netCheck();
      const proxyText = String(r.proxy || 'DIRECT');
      const isDirect = /^DIRECT/i.test(proxyText);
      const ports = r.localProxies || [];
      const lines = [
        `代理模式：${r.mode === 'manual' ? '手动指定' : r.mode === 'direct' ? '直连' : '跟随系统'}`,
        `实际生效：${proxyText}`,
        isDirect && r.mode === 'system'
          ? '⚠ 系统没有给代理，应用正在直连（代理软件可能只开了本地端口，未设系统代理）'
          : '',
        ports.length
          ? `🔎 本机代理端口（在监听）：${ports.map((p) => '127.0.0.1:' + p).join('、')}`
          : '🔎 未发现本机常见代理端口在监听',
        '',
        ...r.results.map((x) => `${x.ok ? '✓' : '✗'} ${x.url}${x.ok ? ` (${x.status})` : ' · ' + x.error}`),
      ].filter((s) => s !== '');

      const pre = document.createElement('pre');
      pre.className = 'net-check-pre';
      pre.textContent = lines.join('\n');
      const actions = [];
      ports.slice(0, 2).forEach((p) => {
        actions.push({ label: `使用 127.0.0.1:${p}`, primary: true, value: { useProxy: p } });
      });
      actions.push({ label: '关闭', value: null });

      const picked = await modal({ title: '联网诊断', body: pre, actions });
      if (picked && picked.useProxy) {
        await patch({ proxyMode: 'manual', proxyRules: `http://127.0.0.1:${picked.useProxy}` });
        syncForm(state.settings);
        toast(`已切到 127.0.0.1:${picked.useProxy}，正在重新加载`, 'ok', 2600);
      }
    } catch (err) {
      toast('诊断失败：' + (err && err.message), 'err', 4000);
    } finally {
      btn.disabled = false;
      btn.textContent = '检查代理与连通性';
    }
  };
  // 只有「手动指定」时地址才可编辑，否则容易误以为填了没生效
  const syncProxyInput = () => {
    const manual = $('#s-proxyMode').value === 'manual';
    $('#s-proxyRules').disabled = !manual;
    $('#s-proxyRules').placeholder = manual ? 'http://127.0.0.1:7890' : '仅在「手动指定」时可填';
  };
  $('#s-proxyMode').addEventListener('change', syncProxyInput);
  syncProxyInput();

  $('#s-dockPeek').addEventListener('input', (e) => {
    $('#s-peek-val').textContent = e.target.value;
    patch({ dockPeek: Number(e.target.value) });
  });
  $('#s-dockAnim').addEventListener('input', (e) => {
    $('#s-anim-val').textContent = e.target.value;
    patch({ dockAnim: Number(e.target.value) });
  });

  $$('#s-edge-seg .seg-btn').forEach((b) => {
    b.onclick = async () => {
      edgeChoice = b.dataset.edge;
      markEdge();
      await patch({ dockEdge: edgeChoice });
      const ok = await window.moyu.dock.apply(edgeChoice);
      if (ok) toast('已按新方向收起，鼠标移到屏幕边缘可展开', 'ok', 3200);
    };
  });

  $('#s-pickdir').onclick = async () => {
    const dir = await window.moyu.settings.chooseImportDir();
    if (dir) $('#s-importDir').value = dir;
  };

  $('#s-capture').onclick = async () => {
    toast('按下组合键即可（Esc 取消）', '', 1600);
    const { captureHotkey } = await import('./ui.js');
    const key = await captureHotkey();
    if (!key) return;
    await patch({ bossKey: key, bossEnabled: true });
    $('#s-bossKey').value = key;
    $('#s-bossEnabled').checked = true;
    const s = state.settings;
    if (s.bossKeyConflict) toast(`${key} 已被其他应用占用，请换一个`, 'err', 4200);
    else toast(`老板键已设为 ${key}`, 'ok');
  };

  $('#s-edgeDockEnabled').addEventListener('change', async () => {
    // 关掉时立刻把窗口恢复普通形态
    if (!state.settings.edgeDockEnabled && state.dock.state === 'DOCKED') {
      await window.moyu.dock.undock();
    }
  });

  $('#btn-reset').onclick = async () => {
    const ok = await confirmDialog('恢复默认设置', '所有设置会回到初始值（书库与阅读进度不受影响）。', '恢复默认');
    if (!ok) return;
    const s = await window.moyu.settings.reset();
    state.settings = s;
    syncForm(s);
    emit('settings:changed', s);
    toast('已恢复默认设置', 'ok');
  };

  $('#btn-open-data').onclick = () => window.moyu.app.openDataDir();
  $('#btn-open-log').onclick = () => window.moyu.app.openLogDir();
  $('#btn-quit').onclick = () => window.moyu.app.quit();

  $('#quick-editor').addEventListener('change', async (e) => {
    if (e.target.tagName !== 'TEXTAREA') return;
    const lines = e.target.value.split('\n').map((l) => l.trim()).filter(Boolean);
    const sites = [];
    for (const l of lines) {
      const [name, url] = l.split('|').map((x) => (x || '').trim());
      if (!name) continue;
      const finalUrl = url && /^https?:/i.test(url) ? url : `https://${url || ''}`;
      if (!url) continue;
      sites.push({ name, url: finalUrl });
    }
    await patch({ quickSites: sites });
    emit('quick-sites:changed');
    toast('常用站点已保存', 'ok', 1600);
  });
}

async function patch(part) {
  const res = await window.moyu.settings.update(part);
  state.settings = res.settings;
  emit('settings:changed', res.settings);
}

function markEdge() {
  $$('#s-edge-seg .seg-btn').forEach((x) => x.classList.toggle('active', x.dataset.edge === edgeChoice));
}

export function syncForm(s) {
  if (!s) return;
  $('#s-fontSize').value = String(s.fontSize);
  $('#s-lineHeight').value = String(s.lineHeight);
  $('#s-bgPreset').value = s.bgPreset;
  $('#s-importDir').value = s.importDir || '';
  $('#s-edgeDockEnabled').checked = !!s.edgeDockEnabled;
  $('#s-autoDockOnLeave').checked = !!s.autoDockOnLeave;
  const onTop = $('#s-alwaysOnTop');
  if (onTop) onTop.checked = !!s.alwaysOnTop;
  $('#s-dockPeek').value = String(s.dockPeek);
  $('#s-peek-val').textContent = String(s.dockPeek);
  $('#s-dockAnim').value = String(s.dockAnim);
  $('#s-anim-val').textContent = String(s.dockAnim);
  $('#s-bossEnabled').checked = !!s.bossEnabled;
  $('#s-bossKey').value = s.bossKey || '';
  $('#s-launchAtStartup').checked = !!s.launchAtStartup;
  const pm = $('#s-proxyMode');
  if (pm) pm.value = s.proxyMode || 'system';
  const pr = $('#s-proxyRules');
  if (pr) {
    pr.value = s.proxyRules || '';
    pr.disabled = (s.proxyMode || 'system') !== 'manual';
  }
  const cert = $('#s-ignoreCertErrors');
  if (cert) cert.checked = !!s.ignoreCertErrors;
  edgeChoice = s.dockEdge || 'left';
  markEdge();
  const editor = $('#quick-editor');
  if (editor && !editor.querySelector('textarea')) {
    editor.append(el('textarea', {
      spellcheck: 'false',
      value: (s.quickSites || []).map((x) => `${x.name}|${x.url}`).join('\n'),
    }));
  } else if (editor) {
    editor.querySelector('textarea').value = (s.quickSites || []).map((x) => `${x.name}|${x.url}`).join('\n');
  }
  $('#boss-hint').textContent = s.bossKeyConflict
    ? `⚠ ${s.bossKey} 已被其他应用占用，建议更换`
    : '按下老板键，窗口与任务栏入口立即消失，再按一次恢复到隐藏前状态。';
  $('#boss-hint').style.color = s.bossKeyConflict ? '#d9483f' : '';
}
