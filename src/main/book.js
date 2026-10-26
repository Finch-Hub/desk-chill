'use strict';
/**
 * 书籍解析：
 *  - TXT：编码检测（UTF-8 / UTF-16 / GBK / BIG5）+ 章节识别 + 按「页」切分
 *  - PDF：主进程只做存在性与页数探测，渲染交给渲染进程 pdf.js
 *
 * 「页」的口径：为保证进度可续读、页码稳定，页数由文本按固定字符数切分计算，
 * 与窗口尺寸无关（窗口变化只影响视觉排版，不影响页码）。
 */
const fs = require('node:fs');
const path = require('node:path');
const chardet = require('chardet');

/** 每页字符数（按 16px 字号估算，约合 40 行 × 34 字） */
const PAGE_CHARS = 1100;

/** 章节标题：第一章 / 第1章 / 第十二回 / 序章 / 楔子 / 后记 / Chapter 1
 *  行首锚点用 (?:^|\n) + [^\S\n]* 而不是 ^...$ + /m：后者在 800 万字文本上会回溯爆炸。
 */
const CHAPTER_RE =
  /(?:^|\n)[^\S\n]*(第[0-9零一二三四五六七八九十百千万两〇]{1,10}[章节回卷部集篇幕话][^\n]{0,40}|序章[^\n]{0,30}|楔子[^\n]{0,30}|前言[^\n]{0,30}|序言[^\n]{0,30}|引子[^\n]{0,30}|后记[^\n]{0,30}|尾声[^\n]{0,30}|番外[^\n]{0,30}|Chapter[ \t]+\d+[^\n]{0,40})[ \t　]*(?=\n|$)/g;

const SUPPORTED = new Set(['.txt', '.pdf']);

/* ------------------------------ 编码检测 ------------------------------ */

/** 检测采样上限：chardet 对大文件是 O(n) 且极慢（15MB ≈ 12s），采样 256KB 足够判断编码 */
const DETECT_SAMPLE = 256 * 1024;
const GARBLED_SAMPLE = 64 * 1024;

/** BOM 优先；其次 UTF-8 严格校验；再做 chardet（采样）；最后 GBK 兜底 */
function detectEncoding(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: 'UTF-8', fromBom: true };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { encoding: 'UTF-16LE', fromBom: true };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { encoding: 'UTF-16BE', fromBom: true };

  // UTF-16 无 BOM 的典型特征：大量 0x00 字节（ASCII 文本）
  let zeros = 0;
  const probeLen = Math.min(buf.length, 4096);
  for (let i = 0; i < probeLen; i++) if (buf[i] === 0) zeros++;
  if (probeLen > 0 && zeros / probeLen > 0.2) {
    // 偶数位为 0 -> LE，奇数位为 0 -> BE
    let evenZero = 0;
    let oddZero = 0;
    for (let i = 0; i < probeLen; i += 2) {
      if (buf[i] === 0) evenZero++;
      if (buf[i + 1] === 0) oddZero++;
    }
    return { encoding: oddZero >= evenZero ? 'UTF-16LE' : 'UTF-16BE', fromBom: false };
  }

  // 采样后优先做严格的 UTF-8 校验（中英混排的 UTF-8 几乎不可能误判为 GBK）
  const sample = buf.subarray(0, Math.min(buf.length, DETECT_SAMPLE));
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return { encoding: 'UTF-8', fromBom: false };
  } catch {
    /* 不是合法 UTF-8，继续用 chardet 判定 GBK / BIG5 */
  }

  let guess = null;
  try {
    guess = chardet.detect(sample);
  } catch {
    guess = null;
  }
  if (guess) {
    const g = String(guess).toUpperCase();
    if (g.includes('BIG5')) return { encoding: 'BIG5', fromBom: false };
    if (g.includes('UTF-16')) return { encoding: 'UTF-16LE', fromBom: false };
    if (g.includes('UTF-8')) return { encoding: 'UTF-8', fromBom: false };
  }
  return { encoding: 'GBK', fromBom: false };
}

/** GB18030 是 GBK 的超集，Node 的 TextDecoder 两者都支持；BIG5 同理 */
function decoderName(enc) {
  if (enc === 'GBK') return 'gb18030';
  if (enc === 'BIG5') return 'big5';
  if (enc === 'UTF-16BE') return 'utf-16be';
  if (enc === 'UTF-16LE') return 'utf-16le';
  return 'utf-8';
}

function decode(buf, encoding) {
  const name = decoderName(encoding);
  try {
    return new TextDecoder(name, { fatal: false }).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/** 乱码检测：只看文件头部采样，用正则统计而非逐字符 for-of（大文件 for-of 极慢） */
function looksGarbled(text) {
  const sample = text.slice(0, GARBLED_SAMPLE);
  if (!sample) return false;
  // \uFFFD 替换符 + 私用区 + NUL + Latin-1 控制区（GBK 被当 UTF-8 的典型症状）
  const bad = (sample.match(/[\uFFFD\u0000\uE000-\uF8FF]/g) || []).length;
  const ctrl = (sample.match(/[\u0080-\u00A0]/g) || []).length;
  return bad / sample.length > 0.02 || ctrl / sample.length > 0.05;
}

/* ------------------------------ 章节与分页 ------------------------------ */

function normalizeText(text) {
  // 单遍正则去掉 \r、NUL 与 BOM：\r 会导致换行计数不一致，BOM 会被 \S 当作「正文」
  // 从而让「相邻标题合并」失效（第一个字符位置的 BOM 是经典陷阱）。
  return text.replace(/[\r\u0000\uFEFF]/g, '');
}

/** 章节标题清洗：去掉常见前缀噪声，限定长度 */
function cleanTitle(raw) {
  return raw.replace(/[\s\u3000]+/g, ' ').trim().slice(0, 60);
}

/** 标题比对用的归一化：去掉空白与「第/章/回」等骨架字，只留序号与名字 */
function titleKey(title) {
  return title
    .replace(/[\s\u3000]/g, '')
    .replace(/[（(].*?[）)]/g, '')
    .replace(/^第/, '')
    .replace(/[章节回卷部集篇幕话]/, '|')
    .replace(/[零〇一二三四五六七八九十百千万两0-9]+/g, (s) => cn2num(s) || s);
}

const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNIT = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

/** 中文数字转阿拉伯数字（章节序号最高到万，够用了） */
function cn2num(s) {
  if (/^[0-9]+$/.test(s)) return String(Number(s));
  let total = 0;
  let section = 0;
  let num = 0;
  for (const ch of s) {
    if (ch in CN_DIGIT) {
      num = CN_DIGIT[ch];
    } else if (ch in CN_UNIT) {
      const unit = CN_UNIT[ch];
      if (unit === 10000) {
        section = (section + num) * unit;
        total += section;
        section = 0;
      } else {
        section += (num || 1) * unit;
      }
      num = 0;
    }
  }
  const v = total + section + num;
  return v > 0 ? String(v) : '';
}

/**
 * 章节识别：行首匹配 + 去重 + 平均跨度过滤。
 *
 * 注意两个真实世界里极常见的坑（否则目录会膨胀到几千条）：
 *  1. 同一条标题被重复插入：很多 TXT 是「补章名」工具处理过的，
 *     会在原始章节处再插一行同标题，形成
 *         第1章 山边小村
 *
 *         第1章 山边小村
 *         二愣子睁大着双眼…
 *     只看行首会得到「两条相邻且同名」的记录 —— 按「相邻同标题去重」即可。
 *  2. 正文里「第三回合」「第一章里就说过」这类词并不在标题行，
 *     用「平均每 N 字才出现一个章标题」的密度校验兜底整批丢弃。
 */
function detectChapters(text) {
  const raw = [];
  CHAPTER_RE.lastIndex = 0;
  let m;
  while ((m = CHAPTER_RE.exec(text)) !== null) {
    const title = cleanTitle(m[1]);
    if (!title) continue;
    const offset = m.index + (m[0].startsWith('\n') ? 1 : 0);
    raw.push({ title, offset });
    if (raw.length > 40000) break; // 防御性上限
  }
  if (raw.length < 2) return [];

  // 相邻去重：两条标题之间若没有正文（只剩空白），后一条必然是重复插入的标题行。
  // 例：不少 TXT 被「补章名」工具处理过，会在原始章节行前再插一行标题，
  // 且插入行用阿拉伯数字、原文用中文数字（第1233章 / 第一千二百二十七章），
  // 所以不能只靠标题相等判断，而是看「两条之间有没有正文」。
  // 相邻去重：两种情况都要处理
  //  (a) 两条标题行之间没有正文 -> 后一条是重复插入的标题行
  //  (b) 标题名归一化后相同、且中间只隔空白 -> 同一章的阿拉伯/中文两种编号
  const merged = [];
  for (const c of raw) {
    const prev = merged[merged.length - 1];
    if (prev) {
      // raw 的 offset 是「标题行行首」，所以间隙必须从上一行的换行之后算起；
      // 直接 slice(prev.offset, c.offset) 会把上一行标题本身算进间隙，永远判不出空白。
      const lineEnd = text.indexOf('\n', prev.offset);
      const gapFrom = lineEnd === -1 ? text.length : lineEnd + 1;
      if (gapFrom < c.offset) {
        const between = text.slice(gapFrom, c.offset);
        const blankBetween = !/\S/.test(between);
        if (blankBetween) {
          // 之间无正文：同一章的重复标题行，或另一种编号写法，保留首个位置
          if (c.title.length < prev.title.length) prev.title = c.title;
          continue;
        }
      }
    }
    merged.push({ ...c });
  }

  if (merged.length < 2) return [];

  const density = text.length / merged.length;
  if (density < 400) return [];

  if (merged.length > 50) {
    // 同一章标题重复出现（正文里引用章节名、多份合集拼在一个文件里）不算误判，
    // 只有「大半标题都是同一句话」才说明命中的是正文用词而非标题行。
    const uniq = new Set(merged.map((c) => titleKey(c.title))).size;
    if (uniq / merged.length < 0.05) return [];
  }

  return merged.map((c) => ({
    title: c.title,
    offset: c.offset,
    pageIndex: Math.floor(c.offset / PAGE_CHARS),
  }));
}

function pageCountOf(totalChars) {
  return Math.max(1, Math.ceil(totalChars / PAGE_CHARS));
}

/* ------------------------------ 对外接口 ------------------------------ */

/**
 * @param {string} absPath
 * @param {string} [forcedEncoding]
 * @param {{withText?: boolean}} [opts] withText=false 时只返回元信息（大文件先出首屏）
 */
function openTxt(absPath, forcedEncoding, opts = {}) {
  const withText = opts.withText !== false;
  const stat = fs.statSync(absPath);
  const buf = fs.readFileSync(absPath);
  const det = forcedEncoding
    ? { encoding: forcedEncoding, fromBom: false }
    : detectEncoding(buf);
  const text = normalizeText(decode(buf, det.encoding));

  const garbled = forcedEncoding ? false : looksGarbled(text);
  // 乱码时不做章节识别的昂贵扫描，等用户选定编码后重来
  const chapters = garbled ? [] : detectChapters(text);

  const result = {
    format: 'txt',
    size: stat.size,
    mtime: stat.mtimeMs,
    encoding: det.encoding,
    needEncodingChoice: garbled,
    garbled,
    totalChars: text.length,
    pageCount: pageCountOf(text.length),
    chapters,
  };
  if (withText) result.text = text;
  return result;
}

/**
 * 只取正文（两段式加载的第二段）。
 * 一次 IPC 传 830 万字约 16MB 的字符串，结构化克隆本身就要几百毫秒到数秒，
 * 所以首屏先用元信息渲染出来，正文再单独取，用户不会盯着「正在解析」。
 * @param {string} absPath
 * @param {string} encoding 已确定的编码（首段检测结果或用户手动选择）
 */
function readTxtText(absPath, encoding) {
  const buf = fs.readFileSync(absPath);
  return normalizeText(decode(buf, encoding || detectEncoding(buf).encoding));
}

async function openPdf(absPath) {
  const stat = fs.statSync(absPath);
  const buf = fs.readFileSync(absPath);
  if (buf.subarray(0, 1024).indexOf('%PDF-') === -1) {
    const err = new Error('文件不是有效的 PDF（缺少 %PDF 文件头）');
    err.code = 'E_PDF_INVALID';
    throw err;
  }
  // 轻量页数探测：统计 /Type /Page 出现次数，失败则交给 pdf.js
  let pageCount = 0;
  const raw = buf.toString('latin1');
  const m = raw.match(/\/Type\s*\/Pages?[^s]/g);
  if (m) pageCount = m.length;
  return {
    format: 'pdf',
    size: stat.size,
    mtime: stat.mtimeMs,
    pageCount: pageCount || 0,
    data: buf, // ArrayBuffer 化在 IPC 层完成
  };
}

/** 章节自动识别（仅 TXT 需要，供阅读视图侧边栏使用） */
function chapterize(text) {
  return detectChapters(text);
}

module.exports = {
  SUPPORTED,
  PAGE_CHARS,
  openTxt,
  readTxtText,
  openPdf,
  chapterize,
  detectEncoding,
  decode,
  pageCountOf,
  isSupported: (p) => SUPPORTED.has(path.extname(p).toLowerCase()),
};
