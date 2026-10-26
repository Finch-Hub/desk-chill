'use strict';
/**
 * preload：唯一的系统能力入口（白名单）。
 * 渲染进程处于 contextIsolation，只能看到 window.moyu 上的这组方法。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel, cb) => {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('moyu', {
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    quit: () => ipcRenderer.invoke('app:quit'),
    openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),
    openLogDir: () => ipcRenderer.invoke('app:open-log-dir'),
    zoom: (delta) => ipcRenderer.invoke('app:zoom', delta),
    onBeforeQuit: (cb) => on('app:before-quit', cb),
    onGoto: (cb) => on('app:goto', cb),
    onTray: (cb) => on('app:tray', cb),
  },
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:maximize-toggle'),
    close: () => ipcRenderer.send('win:close'),
    boss: () => ipcRenderer.send('win:boss'),
    state: () => ipcRenderer.invoke('win:state'),
    onLayout: (cb) => on('win:layout', cb),
    /** 窗口置顶（钉在最上层） */
    alwaysOnTop: () => ipcRenderer.invoke('win:always-on-top'),
    setAlwaysOnTop: (on) => ipcRenderer.invoke('win:always-on-top-set', on),
    toggleAlwaysOnTop: () => ipcRenderer.invoke('win:always-on-top-toggle'),
    onAlwaysOnTop: (cb) => on('win:always-on-top', cb),
  },
  dock: {
    state: () => ipcRenderer.invoke('dock:state'),
    togglePin: () => ipcRenderer.invoke('dock:pin-toggle'),
    undock: () => ipcRenderer.invoke('dock:undock'),
    dock: (edge) => ipcRenderer.invoke('dock:dock', edge),
    apply: (edge) => ipcRenderer.invoke('dock:apply', edge),
    onState: (cb) => on('dock:state', cb),
  },
  view: {
    set: (name) => ipcRenderer.invoke('view:set', name),
  },
  library: {
    list: () => ipcRenderer.invoke('library:list'),
    pick: () => ipcRenderer.invoke('library:pick'),
    importPaths: (paths) => ipcRenderer.invoke('library:import-paths', paths),
    remove: (bookId) => ipcRenderer.invoke('library:remove', bookId),
    rename: (bookId, title) => ipcRenderer.invoke('library:rename', { bookId, title }),
    pathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return '';
      }
    },
  },
  book: {
    open: (bookId, encoding, opts) =>
      ipcRenderer.invoke('book:open', { bookId, encoding, metaOnly: !!(opts && opts.metaOnly) }),
    text: (bookId, encoding) => ipcRenderer.invoke('book:text', { bookId, encoding }),
    detectEncoding: (bookId) => ipcRenderer.invoke('book:detect-encoding', { bookId }),
  },
  progress: {
    save: (bookId, data) => ipcRenderer.invoke('progress:save', { bookId, data }),
    get: (bookId) => ipcRenderer.invoke('progress:get', bookId),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch) => ipcRenderer.invoke('settings:update', patch),
    onChange: (cb) => on('settings:changed', cb),
    reset: () => ipcRenderer.invoke('settings:reset'),
    chooseImportDir: () => ipcRenderer.invoke('dialog:choose-import-dir'),
  },
  browser: {
    navigate: (url) => ipcRenderer.invoke('browser:navigate', url),
    back: () => ipcRenderer.invoke('browser:back'),
    forward: () => ipcRenderer.invoke('browser:forward'),
    reload: () => ipcRenderer.invoke('browser:reload'),
    stop: () => ipcRenderer.invoke('browser:stop'),
    currentUrl: () => ipcRenderer.invoke('browser:current-url'),
    find: (opts) => ipcRenderer.invoke('browser:find', opts),
    zoom: (delta) => ipcRenderer.invoke('browser:zoom', delta),
    resetZoom: () => ipcRenderer.invoke('browser:reset-zoom'),
    setVisible: (visible) => ipcRenderer.invoke('browser:set-visible', visible),
    setBounds: (rect) => ipcRenderer.send('browser:bounds', rect),
    openExternal: (url) => ipcRenderer.invoke('browser:open-external', url),
    clearCache: () => ipcRenderer.invoke('browser:clear-cache'),
    retry: () => ipcRenderer.invoke('browser:retry'),
    netCheck: () => ipcRenderer.invoke('browser:net-check'),
    debug: () => ipcRenderer.invoke('browser:debug'),
    onLoading: (cb) => on('browser:loading', cb),
    onNavigated: (cb) => on('browser:navigated', cb),
    onTitle: (cb) => on('browser:title', cb),
    onFavicon: (cb) => on('browser:favicon', cb),
    onError: (cb) => on('browser:error', cb),
    onCrash: (cb) => on('browser:crash', cb),
    onOpenUrl: (cb) => on('browser:open-url', cb),
    onCommand: (cb) => on('browser:command', cb),
    onBlocked: (cb) => on('browser:blocked', cb),
  },
  clipboard: {
    write: (text) => ipcRenderer.invoke('clipboard:write', text),
  },
  shell: {
    openPath: (p) => ipcRenderer.invoke('shell:open-path', p),
  },
  misc: {
    onToast: (cb) => on('toast', cb),
    onHotkeyConflict: (cb) => on('hotkey:conflict', cb),
  },
});
