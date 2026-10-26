// 真实站点验证（MOYU_E2E_REAL=1）：只测公网站点，不用任何 127.0.0.1
// 记录每个站点的加载结果/错误码/错误页文案，并截图留证。
module.exports = (win, fs) => {
  const shots = 'D:/app/reader/.shots';
  const log = (...a) => console.log('[real]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code, true);

  const SITES = [
    'https://www.xiaohongshu.com/',
    'https://www.baidu.com/',
    'https://www.zhihu.com/',
    'https://www.bilibili.com/',
    'https://www.bing.com/',
  ];

  const shot = async (name) => {
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(`${shots}/${name}.png`, img.toPNG());
    } catch { /* 忽略 */ }
  };

  setTimeout(async () => {
    const rows = [];
    try {
      log('--- 真实站点验证 ---');
      await js(`document.querySelector('#nav .nav-btn[data-view="browser"]').click(); 1`);
      await sleep(800);

      for (const url of SITES) {
        const host = new URL(url).hostname.replace(/^www\./, '');
        await js(`(()=>{const f=document.querySelector('#addr-form');
          document.querySelector('#addr').value=${JSON.stringify(url)};
          f.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true})); return 1})()`);

        let state = 'still-loading'; // 15s 超时后仍未结束 → 说明超时兜底没生效
        // 采集窗口要 > NAV_TIMEOUT_MS(15s)，否则探针会在超时触发前就放弃，
        // 把「超时没生效」和「超时还没到点」混成同一个结果。
        const deadline = Date.now() + 24000;
        let d = null;
        while (Date.now() < deadline) {
          d = await js(`window.moyu.browser.debug()`);
          if (d.crashed) { state = 'crashed'; break; }
          if (!d.wanted) { state = 'error-page'; break; }
          if (!d.loading && d.url && d.url !== 'about:blank' && d.url.includes(host)) { state = 'loaded'; break; }
          await sleep(150);
        }
        const err = await js(`(()=>{const n=document.querySelector('#browser-err');
          return { shown: !!n && !n.hidden, title: (document.querySelector('#err-title')||{}).textContent||'',
                   desc: ((document.querySelector('#err-desc')||{}).textContent||'').slice(0, 120) };})()`);
        const row = { site: url, state, url: d && d.url, errShown: err.shown, errTitle: err.title, errDesc: err.desc };
        rows.push(row);
        log(url, JSON.stringify(row));
        await shot('real-' + host.replace(/\W+/g, '_'));
        if (state === 'error-page') {
          await js(`(()=>{const b=document.querySelector('#err-back'); if(b) b.click(); return 1})()`);
          await sleep(400);
        }
      }
      fs.writeFileSync('D:/app/reader/.real-sites.json', JSON.stringify(rows, null, 1));
      fs.writeFileSync('D:/app/reader/.real-sites-done', 'ok');
      log('DONE');
    } catch (err) {
      log('异常', err && err.stack);
      fs.writeFileSync('D:/app/reader/.real-sites-done', 'error: ' + (err && err.message));
    }
  }, 2600);
};
