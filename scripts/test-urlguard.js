#!/usr/bin/env node
'use strict';
/**
 * urlguard 单测：确认「哪些链接能进内置浏览器、哪些必须拦下」。
 * 关键回归点：bytedance://（抖音「打开 APP」）绝不能被放行到 shell.openExternal，
 * 否则 Windows 会弹「获取打开此'bytedance'链接的应用 / Microsoft Store」。
 *
 * 运行：node scripts/test-urlguard.js
 */
const path = require('node:path');
const { classifyUrl, isWebUrl, schemeOf } = require(path.resolve(__dirname, '../src/main/urlguard.js'));

let pass = 0;
let fail = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    console.log(`  \u2717 ${name}  -> 实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
  }
}

console.log('\n允许在内置浏览器里打开');
[
  'https://www.douyin.com/',
  'http://example.com/a?b=1#c',
  'HTTPS://EXAMPLE.COM/',
  'file:///D:/app/reader/testdata/gbk.txt',
  'about:blank',
  'data:text/html,<b>hi</b>',
  'blob:https://a.com/xx-yy',
  'view-source:https://a.com',
  '  https://trimmed.example/  ',
].forEach((u) => eq(`${u} -> 放行`, isWebUrl(u), true));

console.log('\n必须拦下的客户端协议');
[
  ['bytedance://webview?url=https%3A%2F%2Fwww.douyin.com', 'bytedance'],
  ['snssdk1128://aweme/detail/123', 'snssdk1128'],
  ['weixin://dl/business/?ticket=abc', 'weixin'],
  ['mqqapi://card/show_pslcard?uin=1', 'mqqapi'],
  ['alipays://platformapi/startapp?appId=1', 'alipays'],
  ['javascript:alert(1)', 'javascript'],
  ['mailto:a@b.com', 'mailto'],
  ['thunder://QUFodHRw', 'thunder'],
  ['magnet:?xt=urn:btih:abc', 'magnet'],
  ['BYTEDANCE://UPPER', 'bytedance'], // 大小写不敏感
  ['bytedance:no-slash', 'bytedance'], // 无 // 的写法
].forEach(([u, scheme]) => {
  const info = classifyUrl(u);
  eq(`${u} -> 拦截(${scheme})`, { ok: info.ok, scheme: info.scheme, kind: info.kind }, { ok: false, scheme, kind: 'external' });
});

console.log('\n协议名解析与中文名');
eq('bytedance 应用名', classifyUrl('bytedance://x').app, '抖音');
eq('snssdk1128 应用名', classifyUrl('snssdk1128://x').app, '抖音');
eq('weixin 应用名', classifyUrl('weixin://x').app, '微信');
eq('未知协议无应用名', classifyUrl('foobar://x').app, '');
eq('空串 -> invalid', classifyUrl('').kind, 'invalid');
eq('纯域名 -> invalid', classifyUrl('www.douyin.com').kind, 'invalid');
eq('schemeOf 大小写归一', schemeOf('ByTeDaNcE://x'), 'bytedance');
eq('schemeOf 非法串', schemeOf('://'), '');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
