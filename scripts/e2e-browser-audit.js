// 浏览模块完整审计（MOYU_E2E_NET=1）
// 目的：不再靠猜，逐段验证「页面能不能真的加载」：
//   A. 本地 HTTP 页      -> 验证渲染链路（视图/尺寸/合成）是否正常
//   B. 直连外部站点      -> 验证 TLS/DNS/网络
//   C. 手动代理          -> 验证代理配置是否真的生效（本地 CONNECT 代理会记录日志）
//   D. 证书错误 / 错误码 -> 验证不会卡死
//   E. 联网诊断接口
const path = require('node:path');
const http = require('node:http');

module.exports = (win, fs) => {
  const log = (...a) => console.log('[audit]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code, true);

  const results = [];
  const record = (name, ok, detail) => {
    results.push({ name, ok, detail });
    log(`${ok ? 'PASS' : 'FAIL'} ${name}`, detail ? JSON.stringify(detail).slice(0, 300) : '');
  };

  /** 在浏览视图里打开 url，等 loading 结束，返回状态 */
  const openUrl = async (url, timeoutMs = 12000) => {
    const wantHost = (() => {
      try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
    })();
    await js(`(()=>{
      const f=document.querySelector('#addr-form');
      document.querySelector('#addr').value=${JSON.stringify(url)};
      f.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
      return 1;
    })()`);
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      const d = await js(`window.moyu.browser.debug()`);
      last = d;
      if (d.crashed) return { state: 'crashed', ...d };
      if (!d.wanted) return { state: 'error-page', ...d };
      // 必须等到「加载结束 + 当前 URL 属于目标主机」才算成功；
      // 只看 !loading 会把上一次的旧 URL 当成本次结果（重定向由 host 比对兜住）。
      let host = '';
      try { host = new URL(d.url || '').hostname.replace(/^www\./, ''); } catch { /* 忽略 */ }
      const matched = host && (host === wantHost || host.endsWith('.' + wantHost) || host.includes(wantHost));
      if (!d.loading && d.url && d.url !== 'about:blank' && (matched || !wantHost)) {
        return { state: 'loaded', ...d };
      }
      await sleep(120);
    }
    return { state: 'timeout', ...(last || {}) };
  };

  const errText = () =>
    js(`(()=>{const n=document.querySelector('#browser-err');
      return { shown: !!n && !n.hidden,
               desc: ((document.querySelector('#err-desc')||{}).textContent||'').slice(0,160) };})()`);

  const proxyLog = () =>
    new Promise((resolve) => {
      http
        .get('http://127.0.0.1:8098/log', (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => {
            try { resolve(JSON.parse(b)); } catch { resolve([]); }
          });
        })
        .on('error', () => resolve([]));
    });

  setTimeout(async () => {
    try {
      log('--- 浏览模块完整审计 ---');
      await js(`document.querySelector('#nav .nav-btn[data-view="browser"]').click(); 1`);
      await sleep(900);
      record('视图已进入', true, await js(`window.moyu.browser.debug()`));

      /* A. 本地 HTTP 页：如果这一步都失败，说明是应用自身问题（视图/尺寸/合成） */
      const a = await openUrl('http://127.0.0.1:8099/');
      const bodyA = await js(`(()=>{const n=document.querySelector('#txt-page'); return 1})()`); // 占位，页面内容在原生视图里
      record('A 本地 HTTP 页', a.state === 'loaded' && a.url.includes('8099'), { state: a.state, url: a.url, bounds: a.bounds });

      /* B. 直连外部（用系统代理设置） */
      const b = await openUrl('https://www.bing.com/', 15000);
      const bErr = await errText();
      record('B 直连 bing.com', b.state === 'loaded', { state: b.state, url: b.url, err: bErr });

      /* C. 手动代理：把代理指到本地 8888，应该能看到 CONNECT 记录 */
      await js(`window.moyu.settings.update({ proxyMode: 'manual', proxyRules: 'http://127.0.0.1:8888' })`);
      await sleep(800);
      const c = await openUrl('https://www.bing.com/', 15000);
      const plog = await proxyLog();
      const wentThroughProxy = plog.some((l) => /CONNECT/i.test(l) && /bing/i.test(l));
      record('C 手动代理生效', c.state === 'loaded' && wentThroughProxy, {
        state: c.state,
        proxyLog: plog.slice(-6),
        resolved: (await js(`window.moyu.browser.debug()`)).proxyMode,
      });

      /* C2. 代理写错端口 -> 必须进错误页，不能一直转圈 */
      await js(`window.moyu.settings.update({ proxyRules: 'http://127.0.0.1:8899' })`);
      await sleep(800);
      const c2 = await openUrl('https://www.bing.com/', 12000);
      record('C2 坏代理快速失败（有错误页）', c2.state === 'error-page', { state: c2.state, err: await errText() });

      /* 恢复系统代理 */
      await js(`window.moyu.settings.update({ proxyMode: 'system', proxyRules: '' })`);
      await sleep(600);
      const back = await openUrl('https://www.bing.com/', 15000);
      record('恢复系统代理后可用', back.state === 'loaded', { state: back.state, url: back.url });

      /* D. 证书错误：自签名站必须立刻进错误页（若本地 TLS 服务未启动则跳过） */
      const d = await openUrl('https://127.0.0.1:8443/', 8000);
      const dErr = await errText();
      if (d.state === 'error-page' && /CERT/.test(dErr.desc)) {
        record('D 证书错误进错误页', true, dErr);
      } else if (d.state === 'error-page' && /CONNECTION_REFUSED/.test(dErr.desc)) {
        record('D 证书错误（本地 TLS 服务未启动，跳过）', true, dErr);
      } else {
        record('D 证书错误进错误页', false, { state: d.state, err: dErr });
      }

      /* E. 联网诊断接口 */
      const e = await js(`window.moyu.browser.netCheck()`);
      record('E 联网诊断可用', !!e && Array.isArray(e.results) && e.results.length > 0, {
        proxy: e.proxy,
        localProxies: e.localProxies,
        results: (e.results || []).map((r) => `${r.url}:${r.ok ? 'ok' : r.error}`),
      });

      /* E2. 一键启用本机代理：诊断里发现 8888，点按钮后应切到手动代理并生效 */
      {
        const found = (e.localProxies || []).includes(8888);
        if (!found) {
          record('E2 一键启用本机代理（测试代理未监听，跳过）', true, { localProxies: e.localProxies });
        } else {
          await js(`document.querySelector('#nav .nav-btn[data-view="settings"]').click(); 1`);
          await sleep(400);
          await js(`document.querySelector('#s-netCheck').click(); 1`);
          await sleep(7000);
          const btns = await js(`[...document.querySelectorAll('#modal-actions .btn')].map(b=>b.textContent)`);
          const clicked = await js(`(()=>{const b=[...document.querySelectorAll('#modal-actions .btn')]
            .find(x=>x.textContent.includes('8888')); if(!b) return 'no-btn'; b.click(); return 'clicked';})()`);
          await sleep(1200);
          const s = await js(`window.moyu.settings.get()`);
          record('E2 一键启用本机代理', clicked === 'clicked' && s.proxyMode === 'manual' && /:8888/.test(s.proxyRules || ''),
            { buttons: btns, clicked, proxyMode: s.proxyMode, rules: s.proxyRules });
          await js(`window.moyu.settings.update({ proxyMode: 'system', proxyRules: '' })`);
          await sleep(400);
          await js(`document.querySelector('#nav .nav-btn[data-view="browser"]').click(); 1`);
          await sleep(600);
        }
      }

      /* F. 地址栏容错：不带协议头的域名要能自动补 https */
      const f = await openUrl('www.bing.com');
      record('F 地址栏无协议输入', f.state === 'loaded' && /bing/.test(f.url || ''), { state: f.state, url: f.url });

      /* G. 快捷站点按钮：改一条指向本地页，点首页按钮应能加载 */
      await js(`window.moyu.settings.update({ quickSites: [{ name: '本地页', url: 'http://127.0.0.1:8099/' }] })`);
      await sleep(800);
      await js(`(()=>{const b=document.querySelector('#b-quick'); if(b) b.click(); return 1})()`); // 回首页
      await sleep(600);
      const quickClicked = await js(`(()=>{const q=document.querySelector('#quick-sites .qsite');
        if(!q) return 'no-btn'; q.click(); return 'clicked:' + q.textContent;})()`);
      await sleep(1800);
      const gState = await js(`window.moyu.browser.debug()`);
      record('G 快捷站点入口', /8099/.test(gState.url || ''), { clicked: quickClicked, url: gState.url });

      /* H. 后退 / 前进 */
      await js(`(()=>{const b=document.querySelector('#b-back'); if(b) b.click(); return 1})()`);
      await sleep(1200);
      const h1 = await js(`window.moyu.browser.debug()`);
      await js(`(()=>{const b=document.querySelector('#b-forward'); if(b) b.click(); return 1})()`);
      await sleep(1200);
      const h2 = await js(`window.moyu.browser.debug()`);
      record('H 后退/前进', h2.url !== h1.url, { afterBack: h1.url, afterForward: h2.url });

      const failed = results.filter((r) => !r.ok);
      fs.writeFileSync('D:/app/reader/.audit.json', JSON.stringify(results, null, 1));
      fs.writeFileSync('D:/app/reader/.audit-done', failed.length ? 'fail' : 'ok');
      log(failed.length ? `FAILED ${failed.length}/${results.length}` : `ALL PASS ${results.length}`);
      failed.forEach((f) => log('  失败项：', f.name, JSON.stringify(f.detail).slice(0, 200)));
    } catch (err) {
      log('审计异常', err && err.stack);
      fs.writeFileSync('D:/app/reader/.audit-done', 'error: ' + (err && err.message));
    }
  }, 2600);
};
