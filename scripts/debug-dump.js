// 开发期调试：定时把窗口/鼠标/贴边状态写入文件（仅 MOYU_DEBUG 环境变量开启时加载）
const fs = require('fs');
const lines = [];
global.__dockTrace = (m) => {
  lines.push(`${Date.now() % 100000} ${m}`);
  if (lines.length > 80) lines.shift();
  try { fs.writeFileSync('D:/app/reader/.debug-trace.log', lines.join('\n')); } catch (e) { /* 忽略 */ }
};
module.exports = (getInfo) => {
  const write = () => {
    try {
      const info = getInfo();
      const extra = global.__dockDebug ? global.__dockDebug() : null;
      fs.writeFileSync('D:/app/reader/.debug.json', JSON.stringify({ ...info, ...extra, trace: lines.slice() }, null, 2));
    } catch (e) { /* 忽略 */ }
  };
  setTimeout(write, 2500);
  setInterval(write, 1500);
};
