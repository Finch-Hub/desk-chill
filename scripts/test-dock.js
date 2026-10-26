#!/usr/bin/env node
'use strict';
/**
 * DockEngine 状态机单测（不启动 GUI、不移动真实鼠标）
 *
 * 用假的 electron / store 模块 + 可控时钟 + 可控光标坐标驱动 _tick()，
 * 覆盖「收成边条 → 鼠标移入展开 → 移开自动收起」主路径，
 * 以及它的回归点：展开动画后 _suppressUntilMove 卡死导致永不收起。
 *
 * 运行：node scripts/test-dock.js
 */
const path = require('node:path');
const Module = require('node:module');

/* ------------------------------ 可控环境 ------------------------------ */

let now = 1_000_000;
const realNow = Date.now;
Date.now = () => now;

const WA = { x: 0, y: 0, width: 1920, height: 1040 };
let cursor = { x: 500, y: 500 };
let bounds = { x: 300, y: 120, width: 950, height: 682 };
let maximized = false;
let skipTaskbar = false;
let alwaysOnTop = false;

const fakeWin = {
  on() {},
  getBounds: () => ({ ...bounds }),
  setBounds: (b) => { bounds = { x: b.x, y: b.y, width: b.width, height: b.height }; },
  isDestroyed: () => false,
  isVisible: () => true,
  isMinimized: () => false,
  isMaximized: () => maximized,
  isFullScreen: () => false,
  setSkipTaskbar: (v) => { skipTaskbar = !!v; },
  isAlwaysOnTop: () => alwaysOnTop,
  setAlwaysOnTop: (v) => { alwaysOnTop = !!v; },
  moveTop: () => {},
};

const fakeScreen = {
  getCursorScreenPoint: () => ({ ...cursor }),
  getDisplayMatching: () => ({ workArea: { ...WA } }),
  getPrimaryDisplay: () => ({ workArea: { ...WA } }),
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { BrowserWindow: function () {}, screen: fakeScreen };
  if (request === './store') return { readJson: () => ({}), writeJson: () => {}, logEvent: () => {} };
  return origLoad.call(this, request, parent, isMain);
};

const { DockEngine } = require(path.resolve(__dirname, '../src/main/dock.js'));

/* ------------------------------ 断言工具 ------------------------------ */

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    console.log(`  \u2717 ${name}${extra ? '  -> ' + JSON.stringify(extra) : ''}`);
  }
}

const clock = () => now;

/** 按真实 50ms 轮询节奏推进若干毫秒 */
function run(ms, engine) {
  const end = now + ms;
  while (now < end) {
    now = Math.min(end, now + 50);
    engine._tick();
  }
}
/** 等 async 的 undock/_animate 落定 */
const settle = () => new Promise((r) => setImmediate(r));

/* ------------------------------ 用例 ------------------------------ */

async function main() {
  const events = [];
  const engine = new DockEngine(fakeWin, {
    enabled: true,
    edge: 'left',
    peek: 4,
    anim: 0,
    autoDockOnLeave: false,
    onState: (s) => events.push(s.state),
    logEvent: () => {},
  });
  // 接管定时器：手动推进时钟，避免真实 50ms 抖动影响断言
  clearInterval(engine._pollTimer);
  engine._pollTimer = -1;

  console.log('\n用例 1：手动收成边条');
  await engine.dock('left', 'manual');
  check('状态为 DOCKED', engine.state === 'DOCKED', { state: engine.state });
  check('窗口移出屏幕、只留 4px', bounds.x === WA.x - bounds.width + 4, bounds);
  check('任务栏不占位', skipTaskbar === true);

  console.log('\n用例 2：鼠标移到边条上 -> 展开');
  cursor = { x: 2, y: 400 };
  run(100, engine);
  await settle();
  check('状态回到 NORMAL', engine.state === 'NORMAL', { state: engine.state });
  check('标记为「临时展开」', engine._peekEdge === 'left', { peekEdge: engine._peekEdge });
  check('展开后吸附到边缘（不跳回屏幕中间）', bounds.x === WA.x, bounds);
  check('任务栏恢复占位', skipTaskbar === false);

  console.log('\n用例 3：鼠标移开窗口 -> 自动收回边条（本次修复的关键路径）');
  check('鼠标在窗口内 -> 静默期随即解除', engine._suppressUntilMove === false);
  cursor = { x: 1500, y: 900 };
  run(300, engine);
  check('宽限期内不收起', engine.state === 'NORMAL', { state: engine.state });
  run(700, engine);
  check('静默期不会挡住自动收起（回归点）', engine.state === 'DOCKED', { state: engine.state });
  check('收回的是原边缘', engine.activeEdge === 'left');
  check('收回后仍是 4px 边条', bounds.x === WA.x - bounds.width + 4, bounds);

  console.log('\n用例 4：收起后鼠标仍在远端 -> 不误展开');
  run(2000, engine);
  check('保持 DOCKED', engine.state === 'DOCKED', { state: engine.state });

  console.log('\n用例 5：鼠标在窗口内活动 -> 不自动收起');
  cursor = { x: 2, y: 400 };
  run(100, engine);
  await settle();
  check('再次展开', engine.state === 'NORMAL');
  cursor = { x: 800, y: 400 };
  run(3000, engine);
  check('鼠标停留在窗口内，保持展开', engine.state === 'NORMAL', { state: engine.state });

  console.log('\n用例 6：固定展开（pinned）后不再自动收起');
  engine.togglePin();
  check('pinned = true', engine.pinned === true);
  check('pinned 时清掉临时展开标记', engine._peekEdge === null);
  cursor = { x: 1500, y: 900 };
  run(3000, engine);
  check('pinned 状态不收起', engine.state === 'NORMAL', { state: engine.state });
  engine.togglePin();

  console.log('\n用例 7：展开后拖动窗口 -> 取消临时展开，不再自动收起');
  await engine.dock('left', 'manual');
  cursor = { x: 2, y: 400 };
  run(100, engine);
  await settle();
  check('重新进入临时展开', engine._peekEdge === 'left');
  // 模拟真实拖动：窗口位移 + 鼠标跟着走
  const step = (dx) => {
    bounds = { ...bounds, x: bounds.x + dx };
    cursor = { x: cursor.x + dx, y: 300 };
    engine._onWindowMove();
  };
  for (let i = 0; i < 6; i++) step(10); // 累计 60px > 30px 阈值
  check('拖动被识别', engine._dragging === true);
  check('拖动后取消临时展开', engine._peekEdge === null);
  cursor = { x: 1800, y: 1000 };
  run(3000, engine);
  check('拖动后移开鼠标不收起', engine.state === 'NORMAL', { state: engine.state });

  console.log('\n用例 8：最大化时不收起');
  if (engine.state === 'DOCKED') { await engine.undock('test-reset'); await settle(); }
  maximized = true;
  engine._peekEdge = 'left';
  engine._peekAt = clock() - 5000;
  cursor = { x: 1800, y: 1000 };
  run(3000, engine);
  check('最大化时不自动收起', engine.state === 'NORMAL', { state: engine.state });
  maximized = false;

  console.log('\n用例 9：设置项「移出即收起」兜底路径（窗口贴着边缘）');
  engine._peekEdge = null;
  engine.opts.autoDockOnLeave = true;
  bounds = { x: 0, y: 120, width: 950, height: 682 };
  cursor = { x: 1500, y: 900 };
  run(1200, engine);
  check('贴边 + 移出 -> 收起', engine.state === 'DOCKED', { state: engine.state });

  console.log('\n用例 10：关闭边缘收纳后不再收起');
  engine.opts.autoDockOnLeave = false;
  await engine.undock('renderer');
  await settle();
  engine.update({ enabled: false });
  cursor = { x: 1800, y: 1000 };
  run(3000, engine);
  check('enabled=false 不自动收起', engine.state === 'NORMAL', { state: engine.state });

  console.log('\n用例 11：原生文件对话框期间暂停自动收起');
  engine.update({ enabled: true });
  await engine.dock('left', 'manual');
  cursor = { x: 2, y: 400 };
  run(100, engine);
  await settle();
  check('进入临时展开', engine._peekEdge === 'left');
  engine.suspendAutoHide(5000);
  cursor = { x: 1800, y: 1000 };  // 鼠标在文件对话框上
  run(3000, engine);
  check('暂停期内不收起', engine.state === 'NORMAL', { state: engine.state });
  run(3000, engine);
  check('暂停结束后恢复自动收起', engine.state === 'DOCKED', { state: engine.state });

  engine.dispose();
  Date.now = realNow;
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  Date.now = realNow;
  console.error('测试异常', err);
  process.exit(1);
});
