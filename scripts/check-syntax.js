#!/usr/bin/env node
'use strict';
/**
 * 渲染层语法检查。
 *
 * 背景：renderer 走的是浏览器原生 ES module，一旦有语法错误，
 * 整个模块图会静默失败 —— 页面看起来「能开」，但所有事件都没绑上，
 * 表现为「一直显示正在解析」这类诡异现象（曾经真的踩过）。
 * 这里用 Node 的 ESM 解析器把每个入口文件都 parse 一遍，构建前拦下来。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const DIRS = [path.join(ROOT, 'src/renderer/js'), path.join(ROOT, 'scripts')];

function collect(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
    .map((f) => path.join(dir, f));
}

let failed = 0;
const sandbox = vm.createContext({});
for (const dir of DIRS) {
  for (const file of collect(dir)) {
    const src = fs.readFileSync(file, 'utf8');
    try {
      if (typeof vm.SourceTextModule === 'function') {
        new vm.SourceTextModule(src, { identifier: file, context: sandbox });
      } else {
        new vm.Script(src, { filename: file });
      }
    } catch (err) {
      failed++;
      const rel = path.relative(ROOT, file);
      console.error(`✗ ${rel}: ${err.message}`);
    }
  }
}

if (failed) {
  console.error(`\n渲染层语法检查失败（${failed} 个文件）`);
  process.exit(1);
}
console.log('渲染层语法检查通过');
