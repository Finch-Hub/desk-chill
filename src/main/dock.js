'use strict';
/**
 * 贴边收起窗口引擎（核心差异化，PRD FR-2）
 *
 * 四态状态机：NORMAL（展开） ↔ DOCKED（贴边条） → TRAY（托盘隐藏） → EXITING
 *
 * 关键实现取舍（Windows）：
 *  1) 收起后窗口**不会缩成 4px**，而是整体移出屏幕、只在边缘留出 peek 像素。
 *     原因：4px 宽的窗口在 Windows 上极难命中、也不像「工具条」；
 *     移出屏幕后保留完整尺寸，展开时 setBounds 一步回到原位，最稳、无重排抖动。
 *  2) 鼠标位置用主进程轮询 screen.getCursorScreenPoint()（约 50ms），
 *     无需 robotjs 等原生模块，避免编译与杀软麻烦。
 *  3) 「拖动」与「移动」的区分：主进程每 40ms 采样窗口 bounds，
 *     记录「最近 500ms 内是否发生过连续位移」，只有拖动结束时才判定是否贴边。
 *  4) 动画用缓动插值逐帧 setBounds（ease-out cubic），并在动画期间临时切到
 *     'toolbar' + alwaysOnTop，避免 Windows 对普通窗口 setBounds 的边缘捕捉/节流。
 */
const { BrowserWindow, screen } = require('electron');
const store = require('./store');

const STATE = { NORMAL: 'NORMAL', DOCKED: 'DOCKED', TRAY: 'TRAY' };
const EDGES = ['left', 'right', 'top'];
const DOCK_THRESHOLD = 8; // 主边缘距屏幕边缘 <= 8px 判定贴边（PRD 初始值）
const TRIGGER_SLACK = 30; // 判定「拖动」的最小平移距离，低于此视为普通移动

class DockEngine {
  /**
   * @param {import('electron').BrowserWindow} win
   * @param {object} opts
   */
  constructor(win, opts) {
    this.win = win;
    this.opts = Object.assign(
      {
        enabled: true,
        edge: 'left', // 期望贴边方向（设置项），实际以最后所贴边缘为准
        peek: 4, // 露出像素
        anim: 300, // 动画时长 ms
        autoDockOnLeave: false, // 移出即收起（默认关，按 QQ 行为保持收起）
        onState: () => {},
        logEvent: () => {},
      },
      opts || {},
    );

    this.state = STATE.NORMAL;
    this.restoreBounds = null; // 收起前的窗口 bounds
    this.pinned = false; // 固定展开，不自动收起
    this.activeEdge = this.opts.edge;

    this._animToken = 0;
    this._lastBounds = null;
    this._moveAge = 0; // 上次发生位移的时刻
    this._dragOrigin = null; // 本次「拖动段」的起点
    this._dragging = false;
    /**
     * 鼠标最近一次真实移动的时刻。
     * 用来区分「用户拖动窗口」与「程序自己 setBounds」：
     * 缩放窗口/最大化/DPI 重排会让窗口坐标大幅变化，但鼠标并不动，
     * 只看位移会把 resize 误判成拖动，从而在窗口贴近屏幕边缘时自动贴边。
     */
    this._lastCursor = null;
    this._cursorMovedAt = 0;
    this._suppressUntilMove = false; // 程序性 setBounds 后，等用户真的拖动再判定
    this._suppressAt = 0;
    this._pollTimer = null;
    this._insideSince = 0;
    this._outsideSince = 0;
    this._busy = false;

    /**
     * 「从边条临时展开」的标记：
     *  - 值为展开前所贴的边缘（null 表示当前不是临时展开）
     *  - 鼠标移开窗口后自动收回该边缘（这是「收成边条模式」的固有语义）
     *  - 用户拖动窗口 / 最大化 / 固定展开会清掉它
     */
    this._peekEdge = null;
    this._peekAt = 0;
    this._peekOutsideSince = 0;
    /** 暂停自动收起到这个时刻（原生文件对话框等场景，鼠标必然在窗口外） */
    this._suspendUntil = 0;

    this._bindWindow();
    this._startPolling();

  }

  /* ------------------------------ 事件绑定 ------------------------------ */

  _bindWindow() {
    const win = this.win;
    win.on('move', () => this._onWindowMove());

    // 用户通过系统菜单最大化/最小化等情况：重置拖动追踪
    win.on('maximize', () => {
      this._resetDrag();
      this._peekEdge = null; // 最大化是「认真用」，不要自动收起
    });
    win.on('unmaximize', () => this._resetDrag());
    win.on('restore', () => this._resetDrag());
  }

  /** 窗口 move 事件：区分「用户拖动」与「程序自身 setBounds」 */
  _onWindowMove() {
    if (this._busy || this.state !== STATE.NORMAL) return;
    const b = this.win.getBounds();
    const prev = this._lastBounds;
    this._lastBounds = b;
    if (!prev) {
      this._dragOrigin = b;
      return;
    }
    const moved = Math.abs(b.x - prev.x) + Math.abs(b.y - prev.y);
    if (moved <= 0) return;

    this._moveAge = Date.now();
    // 用户拖动判定（两层）：
    //  1) 鼠标此刻要落在窗口内（排除程序性 setBounds / 最大化 / DPI 重排）
    //  2) 自「拖动起点」起累计位移超过阈值
    // 累计位移是必要的：Windows 下无边框窗口的 move 事件可能每次只报 0~1px 位移。
    const pt = screen.getCursorScreenPoint();
    const pointerInside = this._pointInRect(pt, b);
    // 这里也采样一次光标：move 事件可能比 50ms 轮询更密集，
    // 只看轮询结果会把「快速拖动」的中间帧当成鼠标静止。
    const prevCursor = this._lastCursor;
    this._lastCursor = { x: pt.x, y: pt.y };
    if (!prevCursor || Math.abs(pt.x - prevCursor.x) + Math.abs(pt.y - prevCursor.y) > 2) {
      this._cursorMovedAt = Date.now();
    }
    // 真拖动一定伴随鼠标移动；纯位移多半是程序性 setBounds（缩放/最大化）
    const cursorMoving = Date.now() - this._cursorMovedAt < 300;
    if (this._suppressUntilMove && !pointerInside) return;
    if (!cursorMoving) {
      // 鼠标没动：把这一帧当成新的基准，别让 resize 的位移累积成「拖动行程」
      this._dragOrigin = b;
      this._dragTravel = 0;
      return;
    }
    if (!this._dragging) {
      if (!this._dragOrigin) this._dragOrigin = b;
      this._dragTravel = (this._dragTravel || 0) + moved;
      const travel = Math.abs(b.x - this._dragOrigin.x) + Math.abs(b.y - this._dragOrigin.y);
      if (pointerInside && (travel >= TRIGGER_SLACK || this._dragTravel >= TRIGGER_SLACK)) {
        this._dragging = true;
        this._suppressUntilMove = false;
        // 用户在拖动窗口本体 = 想换个位置好好用，取消「临时展开」的自动收起
        this._peekEdge = null;
      }
    }
  }

  _resetDrag() {
    this._lastBounds = this.win.getBounds();
    this._dragOrigin = this._lastBounds;
    this._dragging = false;
    this._dragTravel = 0;
  }

  /**
   * 程序自身 setBounds 之后调用：丢掉上一帧采样，并标记「等用户真正拖动再判定」，
   * 避免动画/展开后的残留位移被误判成一次拖动而再次贴边。
   *
   * 注意：这个标记必须能被**时间**解除。早先只在「用户拖动超过阈值」时清除，
   * 结果展开动画之后标记一直是 true，_tick 里后续的自动收起逻辑永远走不到——
   * 表现就是「移出即收起」开关形同虚设。
   */
  _forgetProgrammaticMove() {
    this._lastBounds = this.win.getBounds();
    this._dragOrigin = this._lastBounds;
    this._dragging = false;
    this._dragTravel = 0;
    this._suppressUntilMove = true;
    this._suppressAt = Date.now();
    this._moveAge = 0;
  }

  /* ------------------------------ 轮询 ------------------------------ */

  _startPolling() {
    this._pollTimer = setInterval(() => this._tick(), 50);
  }

  _tick() {
    if (this._pollTimer === null) return;
    const win = this.win;
    if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return;

    const pt = screen.getCursorScreenPoint();
    const now = Date.now();

    // 记录鼠标是否真的在动（程序性 resize 时鼠标是静止的）
    const prevCursor = this._lastCursor;
    this._lastCursor = { x: pt.x, y: pt.y };
    if (prevCursor && Math.abs(pt.x - prevCursor.x) + Math.abs(pt.y - prevCursor.y) > 2) {
      this._cursorMovedAt = now;
    }

    /* ---- DOCKED：鼠标进入边条热区 -> 展开；移出后保持收起 ---- */
    if (this.state === STATE.DOCKED) {
      if (this._busy) return;
      if (this._inTriggerZone(pt)) {
        this.undock('hover');
      }
      return;
    }

    /* ---- NORMAL ---- */
    if (this.state !== STATE.NORMAL) return;

    // 自动收起先于拖动采样判断：这两段不依赖拖动状态，
    // 否则会被「程序性移动静默期」挡住（曾导致移出收起永不触发）。
    this._tickAutoHide(pt, now);
    if (this.state !== STATE.NORMAL) return; // 可能刚被收起

    // 程序性 setBounds 之后：等一段时间或鼠标进入窗口后解除静默
    if (this._suppressUntilMove) {
      const insideNow = this._pointInRect(pt, win.getBounds());
      if (insideNow || now - this._suppressAt > 500) {
        this._suppressUntilMove = false;
        this._dragOrigin = win.getBounds();
        this._lastBounds = win.getBounds();
      } else {
        return;
      }
    }

    // 拖动结束判定（松手后 260ms 内无位移）
    if (this._dragging && now - this._moveAge > 260) {
      this._dragging = false;
      const b = win.getBounds();
      this._maybeDock(b);
      this._dragOrigin = win.getBounds();
      this._lastBounds = win.getBounds();
      return;
    }
  }

  /**
   * 自动收起（两个来源）：
   *  1) 从边条临时展开的窗口 —— 鼠标移开就收回原边缘。这是「收成边条模式」的核心体验：
   *     鼠标扫过边条 → 展开看一眼 → 移开 → 自动收起，不用再点任何按钮。
   *  2) 设置项「移出即收起」—— 窗口停在屏幕边缘时，鼠标移开也收起
   *     （没有贴边过、只是靠近边缘的情况，用最近边缘兜底）。
   */
  _tickAutoHide(pt, now) {
    if (!this.opts.enabled || this.pinned || this._busy) return;
    const win = this.win;
    if (win.isMaximized() || win.isFullScreen()) return;
    // 原生对话框（选文件/确认框）会把鼠标带走，期间不要收起
    if (now < this._suspendUntil) return;

    const b = win.getBounds();
    const inside = this._pointInRect(pt, b);

    // (1) 边条临时展开 -> 移开自动收回
    if (this._peekEdge) {
      // 展开瞬间鼠标就在窗口边缘，给一个宽限期，避免「刚展开就缩回去」闪一下
      if (now - this._peekAt < 400) return;
      if (inside) {
        this._peekOutsideSince = 0;
        return;
      }
      if (!this._peekOutsideSince) this._peekOutsideSince = now;
      if (now - this._peekOutsideSince >= 500) {
        const edge = this._peekEdge;
        this._peekEdge = null;
        this._peekOutsideSince = 0;
        this.dock(edge, 'leave');
      }
      return;
    }

    // (2) 设置项：窗口贴着边缘时，移出即收起
    if (!this.opts.autoDockOnLeave) return;
    if (inside) {
      this._outsideSince = 0;
      return;
    }
    if (!this._outsideSince) this._outsideSince = now;
    if (now - this._outsideSince > 700) {
      // 允许用「上次贴边的边缘」兜底：手动点「贴边」收起再展开时，
      // restoreBounds 往往在屏幕中间，只按 8px 阈值判断会永远判定不到边缘。
      const edge = this._nearestEdge(b) || this.activeEdge;
      this._outsideSince = 0;
      this.dock(edge, 'auto');
    }
  }

  _pointInRect(p, r) {
    return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
  }

  /** 边条热区：边条所在边缘 6px 厚 × 窗口高度（展开时略微加宽方便命中） */
  _inTriggerZone(pt) {
    const b = this.restoreBounds;
    if (!b) return false;
    const d = screen.getDisplayMatching(b);
    const wa = d.workArea;
    const pad = 6;
    if (this.activeEdge === 'left') {
      return pt.x >= wa.x - 2 && pt.x <= wa.x + Math.max(this.opts.peek, 2) + pad && pt.y >= b.y && pt.y <= b.y + b.height;
    }
    if (this.activeEdge === 'right') {
      const right = wa.x + wa.width;
      return pt.x <= right + 2 && pt.x >= right - Math.max(this.opts.peek, 2) - pad && pt.y >= b.y && pt.y <= b.y + b.height;
    }
    // top
    return pt.y >= wa.y - 2 && pt.y <= wa.y + Math.max(this.opts.peek, 2) + pad && pt.x >= b.x && pt.x <= b.x + b.width;
  }

  /** 计算窗口当前最贴近的工作区边缘（阈值内），否则 null */
  _nearestEdge(b) {
    const d = screen.getDisplayMatching(b);
    const wa = d.workArea;
    if (b.x - wa.x <= DOCK_THRESHOLD && b.x - wa.x >= -DOCK_THRESHOLD) return 'left';
    if (wa.x + wa.width - (b.x + b.width) <= DOCK_THRESHOLD && wa.x + wa.width - (b.x + b.width) >= -DOCK_THRESHOLD) return 'right';
    if (b.y - wa.y <= DOCK_THRESHOLD && b.y - wa.y >= -DOCK_THRESHOLD) return 'top';
    // 允许窗口被拖出屏幕边界一点也算贴边
    if (b.x < wa.x + DOCK_THRESHOLD) return 'left';
    if (b.x + b.width > wa.x + wa.width - DOCK_THRESHOLD) return 'right';
    if (b.y < wa.y + DOCK_THRESHOLD) return 'top';
    return null;
  }

  /* ------------------------------ 状态迁移 ------------------------------ */

  _maybeDock(b) {
    if (!this.opts.enabled) return;
    const edge = this._nearestEdge(b);
    if (!edge) return;
    this.dock(edge, 'drag');
  }

  /** 收起：窗口整体移出屏幕，只留 peek 像素 */
  async dock(edge, reason = 'drag') {
    if (this.state !== STATE.NORMAL || this._busy) return;
    const win = this.win;
    const b = win.getBounds();
    const d = screen.getDisplayMatching(b);
    const wa = d.workArea;
    const peek = Math.max(2, Math.min(8, this.opts.peek));

    this.activeEdge = edge;
    this.pinned = false;
    // 展开位置必须吸附到所选边缘：否则「手动收起」时窗口可能停在屏幕中间，
    // 鼠标在边缘热区展开后窗口却跳到中间 —— 光标落在窗口外，会立刻又被收起。
    const restore = { ...b };
    if (edge === 'left') restore.x = wa.x;
    else if (edge === 'right') restore.x = wa.x + wa.width - b.width;
    else restore.y = wa.y;
    this.restoreBounds = restore;
    this.state = STATE.DOCKED;
    this._insideSince = 0;
    // 已经收成边条，不再是「临时展开」
    this._peekEdge = null;
    this._peekOutsideSince = 0;
    this._outsideSince = 0;

    const target = { ...b };
    if (edge === 'left') target.x = wa.x - b.width + peek;
    else if (edge === 'right') target.x = wa.x + wa.width - peek;
    else target.y = wa.y - b.height + peek;

    await this._animate(target, Math.min(220, this.opts.anim));

    try {
      win.setSkipTaskbar(true); // 收成边条时任务栏不占位，更像工具条
    } catch { /* 忽略 */ }
    this.opts.logEvent('dock_dock', { edge, reason });
    this.opts.onState(this.snapshot());
  }

  /** 展开：回到收起前的位置与尺寸 */
  async undock(reason = 'click') {
    if (this.state !== STATE.DOCKED || this._busy) return;
    const win = this.win;
    const target = this.restoreBounds || this._defaultBounds();
    this.state = STATE.NORMAL;
    win.setSkipTaskbar(false);
    const started = Date.now();
    // 由边条触发的展开 = 临时展开：鼠标移开就自动收回同一边缘。
    // 托盘唤回 / 退出 / 关闭贴边 不算，避免用户刚点开就被莫名收起。
    const fromStrip = reason === 'hover' || reason === 'click' || reason === 'renderer';
    this._peekEdge = fromStrip ? this.activeEdge : null;
    this._peekAt = Date.now();
    this._peekOutsideSince = 0;
    await this._animate(target, this.opts.anim);
    // 宽限期从「展开动画结束」开始算，否则动画本身就把宽限吃掉了
    this._peekAt = Date.now();
    // 从 4px 边条展开时，窗口很可能被别的窗口盖着；提到最前才看得见内容
    try {
      win.moveTop();
    } catch { /* 忽略 */ }
    // 展开时鼠标常常正好落在窗口内，重置「移出计时」避免立即又被收起
    this._outsideSince = 0;
    this.opts.logEvent('dock_undock', {
      edge: this.activeEdge,
      reason,
      duration: Date.now() - started,
      peek: fromStrip,
    });
    this.opts.onState(this.snapshot());
  }

  /** 固定/取消固定（固定后不再自动收起） */
  togglePin() {
    if (this.state !== STATE.NORMAL) return this.pinned;
    this.pinned = !this.pinned;
    if (this.pinned) this._peekEdge = null; // 固定 = 放弃临时展开语义
    this.opts.onState(this.snapshot());
    return this.pinned;
  }

  /**
   * 暂停自动收起一段时间。
   * 用于打开系统原生文件对话框：对话框是独立窗口，鼠标必然离开主窗口，
   * 不暂停的话会出现「选完文件回来，窗口已经缩成边条」的怪异体验。
   */
  suspendAutoHide(ms = 1500) {
    this._suspendUntil = Date.now() + Math.max(0, ms | 0);
    this._peekOutsideSince = 0;
    this._outsideSince = 0;
  }

  /** 供 TRAY 恢复使用：不播放动画，直接复原 */
  restoreInstant() {
    if (this.state !== STATE.DOCKED) return;
    const win = this.win;
    this.state = STATE.NORMAL;
    win.setSkipTaskbar(false);
    this._peekEdge = null; // 从托盘恢复 = 用户想用，不自动收起
    this._peekOutsideSince = 0;
    if (this.restoreBounds) this._setBoundsBusy(this.restoreBounds);
    this._forgetProgrammaticMove();
    this.opts.onState(this.snapshot());
  }

  _defaultBounds() {
    const d = screen.getPrimaryDisplay();
    const wa = d.workArea;
    const width = Math.min(1100, Math.round(wa.width * 0.62));
    const height = Math.min(760, Math.round(wa.height * 0.78));
    return {
      x: wa.x + Math.round((wa.width - width) / 2),
      y: wa.y + Math.round((wa.height - height) / 2),
      width,
      height,
    };
  }

  /* ------------------------------ 动画 ------------------------------ */

  _setBoundsBusy(b) {
    this._busy = true;
    try {
      this.win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
    } catch { /* 忽略 */ }
    this._busy = false;
    this._forgetProgrammaticMove();
  }

  _animate(target, duration) {
    const win = this.win;
    return new Promise((resolve) => {
      const token = ++this._animToken;
      const from = win.getBounds();
      const dur = Math.max(0, duration | 0);
      this._busy = true;
      let wasOnTop = false;
      try {
        wasOnTop = win.isAlwaysOnTop();
        win.setAlwaysOnTop(true, 'pop-up-menu');
      } catch { /* 忽略 */ }

      const finish = () => {
        if (token !== this._animToken) return;
        this._busy = false;
        try {
          if (!wasOnTop) win.setAlwaysOnTop(false);
        } catch { /* 忽略 */ }
        this._forgetProgrammaticMove();
        resolve();
      };

      if (dur === 0) {
        this._busySet(target);
        finish();
        return;
      }
      const t0 = Date.now();
      const step = () => {
        if (token !== this._animToken) return;
        const p = Math.min(1, (Date.now() - t0) / dur);
        const e = 1 - Math.pow(1 - p, 3); // ease-out cubic
        this._busySet({
          x: Math.round(from.x + (target.x - from.x) * e),
          y: Math.round(from.y + (target.y - from.y) * e),
          width: Math.round(from.width + (target.width - from.width) * e),
          height: Math.round(from.height + (target.height - from.height) * e),
        });
        if (p < 1) setImmediate(step);
        else {
          this._busySet(target);
          finish();
        }
      };
      step();
    });
  }

  _busySet(b) {
    const was = this._busy;
    this._busy = true;
    try {
      this.win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
    } catch { /* 窗口可能已销毁 */ }
    this._busy = was;
  }

  /* ------------------------------ 配置与快照 ------------------------------ */

  update(opts = {}) {
    Object.assign(this.opts, opts);
    // 停用边缘收纳时，若正处于收起状态则立刻展开
    if (!this.opts.enabled && this.state === STATE.DOCKED) this.undock('disabled');
  }

  snapshot() {
    return {
      state: this.state,
      edge: this.activeEdge,
      pinned: this.pinned,
      /** 当前是否为「从边条临时展开」：鼠标移开会自动收回 */
      peek: !!this._peekEdge,
      enabled: this.opts.enabled,
      peekWidth: this.opts.peek,
      anim: this.opts.anim,
      autoDockOnLeave: this.opts.autoDockOnLeave,
    };
  }

  dispose() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = null;
    this._animToken++;
  }
}

module.exports = { DockEngine, STATE, DOCK_THRESHOLD, store };
