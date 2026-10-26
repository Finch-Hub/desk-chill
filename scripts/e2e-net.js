// 网络连通性探针（MOYU_E2E_NET=1）
// 依次在浏览视图里打开若干站点，记录 did-fail-load 的 code/desc，判断是「全网不通」
// 还是「个别站点被重置」（例如 -101 ERR_CONNECTION_RESET / -118 ERR_CONNECTION_TIMED_OUT）。
const path = require('node:path');

module.exports = (win, fs) => {
  const log = (...a) => console.log('[e2e-net]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code, true);

  const SITES = [
    'https://127.0.0.1:8443/', // 自签名证书：必须走到「无法建立安全连接」，不能一直转圈
    'https://www.bing.com/',
    'https://example.com/',
  ];

  setTimeout(async () => {
    try {
      log('--- 网络探针 ---');
      await js(`document.querySelector('#nav .nav-btn[data-view="browser"]').click(); 1`);
      await sleep(900);

      // 设置页的「联网诊断」按钮 + 结果弹窗（用户实际会点的地方）
      try {
        await js(`document.querySelector('#nav .nav-btn[data-view="settings"]').click(); 1`);
        await sleep(500);
        await js(`document.querySelector('#s-netCheck').click(); 1`);
        await sleep(8000);
        const modalText = await js(`(()=>{const m=document.querySelector('#modal-mask');
          return { shown: m && !m.hidden, title: (document.querySelector('#modal-title')||{}).textContent||'',
                   body: ((document.querySelector('.net-check-pre')||{}).textContent||'').slice(0,300) };})()`);
        log('诊断弹窗', JSON.stringify(modalText));
        const img = await win.webContents.capturePage();
        fs.writeFileSync('D:/app/reader/.shots/net-check.png', img.toPNG());
        await js(`(()=>{const b=[...document.querySelectorAll('#modal-actions .btn')][0]; if(b) b.click(); return 1})()`);
        await sleep(300);
        await js(`document.querySelector('#nav .nav-btn[data-view="browser"]').click(); 1`);
        await sleep(600);
      } catch (e) {
        log('诊断弹窗失败', e.message);
      }

      const rows = [];
      for (const url of SITES) {
        // 每站重新导航，等 loading 结束
        await js(`(()=>{
          const f=document.querySelector('#addr-form');
          document.querySelector('#addr').value=${JSON.stringify(url)};
          f.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
          return 1;
        })()`);
        let info = null;
        for (let i = 0; i < 120; i++) {
          const d = await js(`window.moyu.browser.debug()`);
          if (d.crashed) { info = { state: 'crashed' }; break; }
          if (!d.loading && d.url && d.url.startsWith('http')) { info = { state: 'loaded', url: d.url }; break; }
          if (!d.wanted) { info = { state: 'error-page' }; break; }
          await sleep(100);
        }
        const errText = await js(`(()=>{const n=document.querySelector('#browser-err');
          return { shown: n && !n.hidden, desc: (document.querySelector('#err-desc')||{}).textContent || '' };})()`);
        const row = { site: url, ...(info || { state: 'timeout' }), errShown: errText.shown, errDesc: errText.desc.slice(0, 140) };
        rows.push(row);
        log(url, JSON.stringify(row));

        // 自签名站点：再验证「信任证书错误」开关能让它真的打开
        if (url.includes('8443')) {
          await js(`window.moyu.settings.update({ ignoreCertErrors: true })`);
          await sleep(300);
          // 必须走「重试」按钮：它会把浏览态切回 page 并放出原生视图
          await js(`(()=>{const b=document.querySelector('#err-retry'); if(b) b.click(); return 1})()`);
          let trusted = null;
          for (let i = 0; i < 80; i++) {
            const d = await js(`window.moyu.browser.debug()`);
            if (!d.loading && d.wanted && d.url && d.url.includes('8443')) { trusted = { state: 'loaded', url: d.url }; break; }
            if (!d.wanted) { trusted = { state: 'error-page' }; break; }
            await sleep(100);
          }
          rows.push({ site: url + ' [信任后]', ...(trusted || { state: 'timeout' }) });
          log(url, '[信任证书错误后]', JSON.stringify(trusted));
          await js(`window.moyu.settings.update({ ignoreCertErrors: false })`);
          await sleep(200);
        }

        // 关掉错误页，继续下一站
        await js(`(()=>{const b=document.querySelector('#err-back'); if(b && !document.querySelector('#browser-err').hidden) b.click(); return 1})()`);
        await sleep(300);
      }
      fs.writeFileSync('D:/app/reader/.e2e-net.json', JSON.stringify(rows, null, 1));
      fs.writeFileSync('D:/app/reader/.e2e-net-done', 'ok');
      log('DONE');
    } catch (err) {
      log('异常', err && err.stack);
      fs.writeFileSync('D:/app/reader/.e2e-net-done', 'error: ' + (err && err.message));
    }
  }, 2600);
};
