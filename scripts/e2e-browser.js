// 浏览器模块专项自检（MOYU_E2E_BROWSER=1）
// 用本地 HTML 做确定性目标，验证：首页可见性、导航后网页可见、标签栏/查找条不被盖住、
// 错误页可见（原生视图必须让位）、返回首页。截图落到 .shots/b-*.png。
const path = require('node:path');

module.exports = (win, fs) => {
  const shots = path.join('D:/app/reader', '.shots');
  if (!fs.existsSync(shots)) fs.mkdirSync(shots, { recursive: true });
  const log = (...a) => console.log('[e2e-b]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code, true);

  const shot = async (name) => {
    const b = win.getBounds();
    win.setBounds({ ...b, width: b.width + 1 });
    await sleep(120);
    win.setBounds({ ...b, width: b.width });
    await sleep(300);
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(shots, name + '.png'), img.toPNG());
      log('截图', name);
    } catch (e) {
      log('截图失败', name, e.message);
    }
  };

  /**
   * 整屏截图：webContents.capturePage() 只抓窗口自己的渲染层，**不含** WebContentsView
   * 这类原生子视图，所以判断「网页到底有没有显示在屏幕上」必须用桌面截图。
   */
  const screenShot = async (name) => {
    try {
      const { desktopCapturer, screen } = require('electron');
      const disp = screen.getPrimaryDisplay();
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: disp.size.width, height: disp.size.height },
      });
      if (!sources.length) return log('整屏截图无源');
      fs.writeFileSync(path.join(shots, name + '.png'), sources[0].thumbnail.toPNG());
      log('整屏截图', name);
    } catch (e) {
      log('整屏截图失败', name, e.message);
    }
  };

  /** 直接抓原生视图自己的画面，用来区分「页面没渲染」还是「窗口没合成」 */
  const viewShot = async (name) => {
    try {
      const { WebContentsView } = require('electron');
      const views = win.contentView.children.filter((v) => v instanceof WebContentsView);
      if (!views.length) return log('没有原生视图可抓');
      const img = await views[0].webContents.capturePage();
      fs.writeFileSync(path.join(shots, name + '.png'), img.toPNG());
      log('视图截图', name);
    } catch (e) {
      log('视图截图失败', name, e.message);
    }
  };

  // 测试用页面：整屏明显色块 + 大标题，方便肉眼/像素判断「网页是否真的显示出来」
  const page = path.join('D:/app/reader/.junk', 'browser-test.html');
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8">
<title>浏览器自检页</title>
<style>
 html,body{margin:0;height:100%}
 body{background:#0b7a5a;color:#fff;font:600 42px/1.4 "Microsoft YaHei";display:flex;
      flex-direction:column;align-items:center;justify-content:center;gap:14px}
 .t{font-size:16px;font-weight:400;opacity:.85}
 input{margin-top:20px;font-size:20px;padding:10px 16px;border-radius:10px;border:0}
</style>
<div>浏览器自检页 OK</div>
<div class="t">如果你看到这块绿色，说明 WebContentsView 正常显示</div>
<input id="q" value="可输入文本" />
<a id="deep-link" href="bytedance://webview?url=https%3A%2F%2Fwww.douyin.com">打开抖音 App（应被拦截）</a>
<button id="deep-open">window.open 客户端协议（应被拦截）</button>
<button id="deep-loc">location 跳客户端协议（应被拦截）</button>
<script>
  document.getElementById('deep-open').onclick = () => window.open('snssdk1128://aweme/detail/1');
  document.getElementById('deep-loc').onclick = () => { location.href = 'weixin://dl/business/'; };
</script>
`, 'utf8');
  const fileUrl = 'file:///' + page.split(path.sep).join('/');

  const state = () => js(`(()=>{
    const v = (id) => { const n=document.querySelector(id); if(!n) return null;
      const r=n.getBoundingClientRect(); const cs=getComputedStyle(n);
      return {hidden:n.hidden, display:cs.display, w:Math.round(r.width), h:Math.round(r.height)}; };
    return { view: document.querySelector('#view-browser').hidden ? 'hidden' : 'shown',
             home: v('#browser-home'), err: v('#browser-err'),
             tabs: v('#browser-tabs'), find: v('#browser-find'),
             addr: document.querySelector('#addr').value,
             tabCount: document.querySelectorAll('#browser-tabs .tag').length };
  })()`);

  setTimeout(async () => {
    try {
      log('--- 浏览器模块自检 ---');
      // 1) 进入浏览视图：应显示首页，原生视图不该盖住它
      await js(`document.querySelector('#nav .nav-btn[data-view="browser"]').click(); 1`);
      await sleep(900);
      log('进入浏览视图', JSON.stringify(await state()));
      log('  原生视图(应隐藏)', JSON.stringify(await js('window.moyu.browser.debug()')));
      // 工具栏图标必须是 SVG（文字字符在不同 DPI 下很糊）+ 明确的禁用态
      const ui0 = await js(`(()=>{
        const has = (id) => !!document.querySelector(id + ' svg');
        const btns = ['#b-back','#b-forward','#b-reload','#b-quick','#b-copy','#b-find'];
        return { svg: btns.filter(has), backDisabled: document.querySelector('#b-back').disabled,
                 tagCount: document.querySelectorAll('#browser-tabs .tag').length,
                 closeBtns: document.querySelectorAll('#browser-tabs .tag-x').length };
      })()`);
      log('工具栏/标签 UI', JSON.stringify(ui0));
      await shot('b-01-home');
      await screenShot('b-01-home-screen');

      // 2) 地址栏输入本地页面并回车
      const t0 = Date.now();
      await js(`(()=>{
        const f=document.querySelector('#addr-form');
        document.querySelector('#addr').value=${JSON.stringify(fileUrl)};
        f.dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
        return 1;
      })()`);
      // 等地址栏出现 file:// 且首页隐藏
      let ok = false;
      for (let i = 0; i < 100; i++) {
        const s = await state();
        if (s.home.hidden && s.addr.startsWith('file://')) { ok = true; break; }
        await sleep(60);
      }
      log('导航结果', ok ? 'loaded' : 'timeout', 'ms=' + (Date.now() - t0), JSON.stringify(await state()));
      await sleep(700);
      log('主进程视图状态', JSON.stringify(await js('window.moyu.browser.debug()')));
      await shot('b-02-page');
      await screenShot('b-02-page-screen');
      await viewShot('b-02b-view');
      await screenShot('b-02c-screen');

      // 2.5) 客户端协议拦截：抖音「打开 APP」这类 bytedance:// 链接必须留在应用内，
      //      绝不能 shell.openExternal（会弹 Windows「获取打开此链接的应用 / Store」）
      {
        const { WebContentsView } = require('electron');
        const v = win.contentView.children.find((c) => c instanceof WebContentsView);
        const before = (await js(`window.moyu.browser.debug()`)).url;
        const clickInPage = async (expr) => {
          try { await v.webContents.executeJavaScript(expr, true); } catch (e) { log('页面内点击失败', e.message); }
        };
        await clickInPage(`document.getElementById('deep-open').click(); 1`);
        await sleep(500);
        const afterOpen = (await js(`window.moyu.browser.debug()`)).url;
        const notice1 = await js(`({shown: !document.querySelector('#browser-notice').hidden,
                                      text: document.querySelector('#notice-text').textContent})`);
        log('window.open 客户端协议', JSON.stringify({ before, afterOpen, notice: notice1 }));

        await clickInPage(`document.getElementById('deep-loc').click(); 1`);
        await sleep(500);
        const afterLoc = (await js(`window.moyu.browser.debug()`)).url;
        log('location 客户端协议', JSON.stringify({ afterLoc }));

        await clickInPage(`document.getElementById('deep-link').click(); 1`);
        await sleep(400);
        const afterAnchor = (await js(`window.moyu.browser.debug()`)).url;
        log('a[href] 客户端协议', JSON.stringify({ afterAnchor }));
        await shot('b-02e-blocked-notice');
        await screenShot('b-02d-blocked');
      }

      // 3) 查找条：必须能显示在网页上方（不在原生视图矩形内）
      await js(`document.querySelector('#b-find').click(); 1`);
      await sleep(400);
      const findState = await state();
      log('查找条', JSON.stringify(findState.find));
      await js(`(()=>{const i=document.querySelector('#bfind-input'); i.value='绿色'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1})()`);
      await sleep(500);
      await shot('b-03-find');
      await screenShot('b-03-find-screen');

      // 4) 新标签 + 关闭标签（标签栏要看得见、点得到）
      await js(`document.querySelector('#browser-tabs .tag-new').click(); 1`);
      await sleep(600);
      const beforeClose = await js(`document.querySelectorAll('#browser-tabs .tag').length`);
      log('新标签后', JSON.stringify(await state()));
      await shot('b-04-newtab');

      // 4.5) 点第二个标签的 × 关闭它
      const closeResult = await js(`(()=>{
        const tags=[...document.querySelectorAll('#browser-tabs .tag')].filter(t=>!t.classList.contains('tag-new'));
        if (tags.length < 2) return { err: 'too-few-tabs', n: tags.length };
        const target = tags[1];
        const label = target.querySelector('.tag-t').textContent;
        target.querySelector('.tag-x').click();
        return { closed: label };
      })()`);
      await sleep(400);
      const afterClose = await js(`({
        tabs: [...document.querySelectorAll('#browser-tabs .tag')].filter(t=>!t.classList.contains('tag-new')).length,
        closeBtns: document.querySelectorAll('#browser-tabs .tag-x').length,
        active: document.querySelector('#browser-tabs .tag.active .tag-t')?.textContent || '',
      })`);
      log('关闭标签', JSON.stringify({ beforeClose, ...closeResult, afterClose }));
      await js(`document.querySelector('#browser-tabs .tag-new').click(); 1`);
      await sleep(500);
      await screenShot('b-04-newtab-screen');

      // 5) 错误页：故意访问一个必然失败的主机，原生视图必须让位
      await js(`(()=>{
        const f=document.querySelector('#addr-form');
        document.querySelector('#addr').value='https://this-host-does-not-exist-9f3a.invalid/';
        f.dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
        return 1;
      })()`);
      let errShown = false;
      for (let i = 0; i < 120; i++) {
        const s = await state();
        if (!s.err.hidden) { errShown = true; break; }
        await sleep(80);
      }
      log('错误页', errShown ? 'shown' : 'timeout', JSON.stringify(await state()));
      log('  原生视图(应隐藏)', JSON.stringify(await js('window.moyu.browser.debug()')));
      await sleep(600);
      await shot('b-05-error');
      await screenShot('b-05-error-screen');

      // 6) 回首页
      await js(`document.querySelector('#err-back').click(); 1`);
      await sleep(700);
      log('返回首页', JSON.stringify(await state()));
      log('  原生视图(应隐藏)', JSON.stringify(await js('window.moyu.browser.debug()')));
      await shot('b-06-back-home');
      await screenShot('b-06-back-home-screen');

      // 7) 切走再切回：原生视图不应残留
      await js(`document.querySelector('#nav .nav-btn[data-view="library"]').click(); 1`);
      await sleep(500);
      await js(`document.querySelector('#nav .nav-btn[data-view="browser"]').click(); 1`);
      await sleep(700);
      log('来回切换后', JSON.stringify(await state()));
      log('  原生视图(应隐藏)', JSON.stringify(await js('window.moyu.browser.debug()')));
      await shot('b-07-again');
      await screenShot('b-07-again-screen');

      // 8) 真站点：验证 https + 证书 + 真实网络路径（失败也不判定为用例失败）
      await js(`(()=>{
        document.querySelector('#nav .nav-btn[data-view="browser"]').click();
        const f=document.querySelector('#addr-form');
        document.querySelector('#addr').value='https://www.bing.com/';
        f.dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
        return 1;
      })()`);
      let real = '';
      for (let i = 0; i < 150; i++) {
        const s = await js(`window.moyu.browser.debug()`);
        if (s.crashed) { real = 'crashed'; break; }
        if (!s.loading && s.url && s.url.includes('bing')) { real = 'loaded'; break; }
        if (!s.loading && !s.wanted) { real = 'error-page'; break; }
        await sleep(80);
      }
      log('真站点 bing.com:', real, JSON.stringify(await js('window.moyu.browser.debug()')));
      // UA 必须是「看起来像 Chrome」的，否则部分站点 WAF 会重置连接
      const d = await js(`window.moyu.browser.debug()`);
      log('UA 检查', JSON.stringify({ hasElectron: /Electron/i.test(d.ua || ''), ua: (d.ua || '').slice(0, 90), proxy: d.proxyMode }));
      await screenShot('b-08-real-site');

      // 9) 焦点在网页里时的快捷键转发：Esc 应回阅读视图，Ctrl+L 应聚焦地址栏
      const { WebContentsView } = require('electron');
      const v = win.contentView.children.find((c) => c instanceof WebContentsView);
      if (v) {
        v.webContents.focus();
        v.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        await sleep(500);
        const firstEsc = await js(`({findBar: !document.querySelector('#browser-find').hidden, reader: !document.querySelector('#view-reader').hidden})`);
        log('网页内第 1 次 Esc（应只收查找条）->', JSON.stringify(firstEsc));
        v.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        await sleep(700);
        const afterEsc = await js(`({reader: !document.querySelector('#view-reader').hidden, browserView: !document.querySelector('#view-browser').hidden})`);
        log('网页内第 2 次 Esc（应回阅读）->', JSON.stringify(afterEsc));

        // 回到浏览视图，再测 Ctrl+L
        await js(`document.querySelector('#nav .nav-btn[data-view="browser"]').click(); 1`);
        await sleep(700);
        const v2 = win.contentView.children.find((c) => c instanceof WebContentsView);
        if (v2) {
          v2.webContents.focus();
          v2.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'L', modifiers: ['control'] });
          await sleep(400);
          const focused = await js(`document.activeElement && document.activeElement.id`);
          log('网页内按 Ctrl+L 后焦点 ->', focused);
        }
      } else {
        log('找不到原生视图，跳过快捷键转发测试');
      }

      fs.writeFileSync('D:/app/reader/.e2e-browser-done', 'ok');
      log('DONE');
    } catch (err) {
      log('异常', err && err.stack);
      fs.writeFileSync('D:/app/reader/.e2e-browser-done', 'error: ' + (err && err.message));
    }
  }, 2600);
};
