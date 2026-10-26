'use strict';
/**
 * URL 守卫：区分「能在内置浏览器里打开的网页」与「必须交给系统/客户端的自定义协议」。
 *
 * 背景（真实故障）：抖音网页里点「打开 APP / 下载客户端」，链接是 `bytedance://...`。
 * 早先这条链接被兜底交给 shell.openExternal()，而 Windows 没有注册该协议，
 * 于是系统弹出「获取打开此'bytedance'链接的应用 —— 请尝试在 Microsoft Store 中查找」。
 * 摸鱼工具因为误点一个链接就跳出系统弹窗，既暴露又在全屏时很扎眼，
 * 所以这里用白名单：只有真正的网页协议才允许导航，其余一律拦住并在应用内提示。
 */

/** 可以在内置视图里渲染的协议（其余一律视为「外部应用协议」） */
const WEB_SCHEMES = new Set([
  'http',
  'https',
  'file',
  'about',
  'data',
  'blob',
  'chrome',
  'chrome-extension',
  'view-source',
]);

/** 常见自定义协议 -> 人类可读的应用名（只用于提示文案，未列出的走兜底文案） */
const APP_NAMES = {
  bytedance: '抖音',
  snssdk1128: '抖音',
  snssdk: '抖音',
  douyin: '抖音',
  aweme: '抖音',
  weixin: '微信',
  wxwork: '企业微信',
  mqq: 'QQ',
  mqqapi: 'QQ',
  tencent: '腾讯系客户端',
  alipay: '支付宝',
  alipays: '支付宝',
  taobao: '淘宝',
  openapp: '对应客户端',
  mailto: '邮件客户端',
  tel: '电话',
  thunder: '迅雷',
  magnet: '下载工具',
  ed2k: '下载工具',
  steam: 'Steam',
  weibo: '微博',
  xhs: '小红书',
  xhsdiscover: '小红书',
  bilibili: '哔哩哔哩',
};

/**
 * 解析协议名（小写、无冒号）。解析失败返回 ''。
 * 注意不能只用正则匹配 `^[a-z]+:`，否则 `BYTEDANCE://x` 或带空白的复制串会漏判。
 */
function schemeOf(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  try {
    return new URL(s).protocol.replace(/:$/, '').toLowerCase();
  } catch {
    // 形如 "bytedance:xxx"（无 //）也要能识别
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(s);
    return m ? m[1].toLowerCase() : '';
  }
}

/** 是否可以在内置浏览器里安全渲染 */
function isWebUrl(raw) {
  return WEB_SCHEMES.has(schemeOf(raw));
}

/**
 * @returns {{ok:boolean, scheme:string, app:string, kind:'web'|'external'|'invalid'}}
 */
function classifyUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: false, scheme: '', app: '', kind: 'invalid' };
  const scheme = schemeOf(s);
  if (WEB_SCHEMES.has(scheme)) {
    return { ok: true, scheme, app: '', kind: 'web' };
  }
  if (!scheme) {
    // 没有协议头又解析不了的串（大概率是用户少打了 https:// 的域名）
    return { ok: false, scheme: '', app: '', kind: 'invalid' };
  }
  // javascript: 之类要特别点名，属于「能执行代码」的危险协议，不是外部应用
  if (scheme === 'javascript' || scheme === 'vbscript') {
    return { ok: false, scheme, app: '', kind: 'external' };
  }
  return { ok: false, scheme, app: APP_NAMES[scheme] || '', kind: 'external' };
}

module.exports = { WEB_SCHEMES, APP_NAMES, schemeOf, isWebUrl, classifyUrl };
