'use strict';
/**
 * 本地数据层：JSON 原子写入（先写临时文件再 rename），避免异常退出导致文件损坏。
 * 存储口径：%APPDATA%/moyu/（PRD「字段与数据模型」）
 */
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const DATA_DIR = path.join(app.getPath('userData'), 'data');
const LOG_DIR = path.join(app.getPath('userData'), 'logs');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function filePath(name) {
  ensureDir(DATA_DIR);
  return path.join(DATA_DIR, `${name}.json`);
}

/** 读取 JSON；文件缺失或损坏时返回 fallback（损坏文件自动备份为 .corrupt） */
function readJson(name, fallback) {
  const p = filePath(name);
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    try {
      fs.copyFileSync(p, `${p}.corrupt-${Date.now()}`);
    } catch { /* 忽略备份失败 */ }
    console.error(`[store] 读取 ${name}.json 失败，已回退默认值`, err);
    return fallback;
  }
}

/** 原子写入：临时文件 -> fsync -> rename */
function writeJson(name, data) {
  const p = filePath(name);
  const tmp = `${p}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2), null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
}

/* ------------------------------ 埋点日志 ------------------------------ */
function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 全部事件仅本地记录，不上传（PRD「埋点需求」） */
function logEvent(event, props = {}) {
  try {
    ensureDir(LOG_DIR);
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...props });
    fs.appendFileSync(path.join(LOG_DIR, `${today()}.log`), line + '\n', 'utf8');
    pruneLogs();
  } catch (err) {
    console.error('[events] 写入失败', err);
  }
}

/** 日志按日轮转，保留 30 天（低频检查即可） */
let lastPrune = 0;
function pruneLogs() {
  const now = Date.now();
  if (now - lastPrune < 6 * 3600 * 1000) return;
  lastPrune = now;
  try {
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!f.endsWith('.log')) continue;
      const p = path.join(LOG_DIR, f);
      if (now - fs.statSync(p).mtimeMs > 30 * 24 * 3600 * 1000) fs.unlinkSync(p);
    }
  } catch { /* 忽略 */ }
}

function logDir() {
  ensureDir(LOG_DIR);
  return LOG_DIR;
}

module.exports = { DATA_DIR, readJson, writeJson, logEvent, logDir, today, ensureDir };
