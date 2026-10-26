// 临时调试脚本：注入后把窗口/鼠标/状态导出到文件
const { app, BrowserWindow, screen } = require('electron');
module.exports = () => {
  setTimeout(async () => {
    const fs = require('fs');
    const w = BrowserWindow.getAllWindows()[0];
    const out = { bounds: w.getBounds(), visible: w.isVisible(), cursor: screen.getCursorScreenPoint(),
      workArea: screen.getPrimaryDisplay().workArea, state: w.__dockSnap || null };
    fs.writeFileSync('D:/app/reader/.e2e.json', JSON.stringify(out, null, 2));
  }, 6000);
};
