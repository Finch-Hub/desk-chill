# 鱼塘（desk-chill）MVP v0.1

单窗口「本地阅读 + 内置浏览 + 贴边收起 + 老板键」的 Windows 桌面工具（鱼塘 / desk-chill）。
按《摸鱼一体工具 MVP PRD v0.1》P0 四件套实现，全部数据仅存本机。

## 功能（P0 四件套）

| 模块 | 说明 |
|------|------|
| 全局布局 | **流式响应式**：窗口可在 520×380 ~ 全屏任意长宽下使用；宽度 ≤900px 侧栏自动变抽屉（点遮罩关闭）、≤720px 隐藏品牌名收紧顶栏、≤600px 收掉次要信息；高度 ≤620px 压缩纵向留白；正文行宽上限 760px 居中，超宽屏不拉成横幅；所有断点均无横向滚动 |
| FR-1 本地阅读器 | TXT（UTF-8 / GBK / BIG5 / UTF-16 自动识别，乱码可手动换编码）、PDF（pdf.js 渲染、文本可复制、懒加载）；字号 / 行距 / 背景（白·米·护眼·暗）/ 字体；章节目录自动识别（第 X 章 / 序章…）；书签；全文搜索；进度自动保存与续读（节流 1s，原子写入） |
| FR-2 贴边收起 | 拖窗口到屏幕左/右/上边缘松开 → 收成 4px 边条（可调 2–8px）；**鼠标移到边条上自动展开，鼠标移开窗口自动收回边条**（展开位置吸附到边缘，不会跳回屏幕中间）；展开后拖动窗口或最大化即取消自动收起，也可用「固定展开」保持常开；方向、动画时长可调；重启恢复上次贴边状态 |
| FR-3 内置浏览器 | Chromium（WebContentsView）渲染；**工具栏全部为矢量图标（36×32 点击区、可用/禁用态清晰）**；多标签**每页带 × 关闭**、+ 新标签；地址栏 URL / 关键词搜索；前进后退刷新；B站 / 小红书 / 知乎 / 微博 / 抖音快捷入口（可编辑）；`persist:moyu` 会话保留登录态；断网 / 证书错误 / DNS 失败显示**带错误码与中文原因**的错误页（可重试、清缓存重试）；**拦截 `bytedance://`、`weixin://` 等客户端协议**（应用内提示，不弹 Microsoft Store，需要时可「用系统打开」）；**网络可调**：代理跟随系统 / 直连 / 手动、真实 Chrome UA、关闭 QUIC、证书错误可选信任 |
| FR-4 老板键与托盘 | 全局热键默认 F8（可改写，冲突会提示）；按下即窗口 + 任务栏入口消失，仅剩托盘图标；再按恢复到隐藏前状态（展开或贴边均可）；托盘菜单退出需二次确认，退出前强制保存进度 |

## 开发运行

```bash
npm install        # 已配置 Electron 镜像时无需额外操作
npm start          # 启动应用
npm run dev        # 启动 + DevTools
npm run check      # 渲染层 ESM 语法预检（build 前自动执行）
npm run test:dock  # 贴边状态机单测（不需要 GUI，可控时钟 + 可控光标）
npm run test:url   # 内置浏览器 URL 守卫单测（哪些协议放行 / 拦截）
npm run typecheck  # tsc --noEmit + 上面的语法预检
```

> 本机沙箱注入 `ELECTRON_RUN_AS_NODE=1` 会导致 electron postinstall 跳过二进制下载。
> 若 `node_modules/electron/path.txt` 不存在，执行：
> `unset ELECTRON_RUN_AS_NODE; ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`

### 自检脚本

```bash
MOYU_E2E=1 npm run dev           # 书库/阅读/PDF/贴边 + 15MB 大文件专项
MOYU_E2E_BROWSER=1 npm run dev   # 浏览器专项（首页/导航/查找/标签/错误页/真站点/快捷键）
MOYU_E2E_LAYOUT=1 npm run dev    # 响应式布局专项（8 组长宽 × 4 视图，检查横向溢出与越界）
MOYU_E2E_NET=1 npm run dev       # 网络专项（自签名证书站 + 真站点 + 信任证书开关）
```

> 跑 e2e 建议加 `--user-data-dir=...` 指向临时目录：既不碰你真实的书库/进度，
> 也避免单实例锁导致新实例静默退出（日志为空、exit=0）。

截图落在 `.shots/`。注意：`webContents.capturePage()` **不包含** `WebContentsView`
这类原生子视图，判断「网页是否真的显示在屏幕上」要看脚本里的整屏截图（`.shots/b-*-screen.png`）。

## 打包

```bash
npm run build:win     # dist/ 下产出 NSIS 安装包 + 便携版 exe
npm run build:dir     # 仅输出未打包目录（调试用）
```

- 安装包：安装向导 + 桌面快捷方式 + 开始菜单 + 卸载入口（中文界面）
- 便携版：单文件 exe，双击即用
- ⚠️ **杀软误报提示**：未做代码签名的 Electron 程序可能被 Windows Defender / 360 等误报。
  个人使用可加白名单；对外分发建议购买代码签名证书。

## 数据与隐私

- 全部数据在 `%APPDATA%/desk-chill/`：
  - `data/library.json` 书库、`data/progress.json` 进度与书签、`data/settings.json` 设置、`data/window.json` 窗口状态（均原子写入）
  - `logs/YYYY-MM-DD.log` 本地埋点（按日轮转，保留 30 天，可在设置导出/打开目录）
- 无账号、无云端、埋点不上传。

## 快捷键

| 键 | 作用 |
|----|------|
| F8 | 老板键：隐藏 / 恢复（可改） |
| Ctrl+1 / Ctrl+2 / Ctrl+, | 书库 / 浏览 / 设置 |
| Ctrl+O | 导入文件 |
| ←/→ / PgUp/PgDn / 空格 | 翻页 |
| Ctrl+= / Ctrl+- | 字号 +/- |
| Ctrl+F | 全文搜索（阅读）/ 页内查找（浏览） |
| 浏览器内 Ctrl+T / Ctrl+W / Ctrl+L / Ctrl+R / Ctrl+=/-/0 | 新标签 / 关标签 / 聚焦地址栏 / 刷新 / 缩放（焦点在网页里也生效） |
| Esc（浏览） | 关查找条，否则回阅读（焦点在网页里也生效） |

## 已知边界（与 PRD 一致）

- PDF 大纲目录依赖文件自带书签；扫描版 PDF 无文本层时无法搜索/复制
- 贴边收起为「驻留式」：防人眼不防企业网络审计（PRD 明确不做对抗审计）
- 小红书等网页登录态在同一次运行内保留；退出应用即清会话
- 本机已强制关闭 GPU 加速（`disable-gpu` + `disable-gpu-compositing` + `disable-gpu-sandbox`），
  规避图形环境共享上下文崩溃问题；阅读/工具类 UI 无感知
- 内置浏览器的渲染子进程**不能开 `sandbox: true`**：本机环境下会一启动就
  `render-process-gone('crashed')`，表现为「浏览页面一片空白 / 页面崩溃」。
  已改为 `sandbox: false` + `contextIsolation: true` + `nodeIntegration: false`，
  远程网页依旧拿不到 Node 能力
- 内置浏览器只渲染网页协议（http/https/file/about/data/blob）。抖音、微信等页面的
  「打开 APP」按钮用的是 `bytedance://` / `snssdk1128://` / `weixin://` 这类客户端协议，
  默认**在应用内拦截并提示**——否则会被 Windows 当成「未注册协议」，
  弹出「获取打开此'bytedance'链接的应用 / 请在 Microsoft Store 中查找」。
  装了对应客户端时，可点提示条上的「用系统打开」显式交给系统
- 窗口最小尺寸 520×380（`minWidth/minHeight`），布局按此下限适配；更小的尺寸 Windows 不允许
- **网页打不开的排查顺序**：① 设置 → 网络 → 点「检查代理与连通性」，先看**实际生效**是 `PROXY xxx` 还是
  `DIRECT`（很多人以为在用代理，实际应用在直连）；② 代理软件只开本地端口时，选「手动指定」填
  `http://127.0.0.1:7890`（按实际端口）；③ 公司网络做 HTTPS 中间人导致证书报错，可开启「信任证书错误」
  （会降低安全性）；④ 「清空缓存」。错误页也提供「用系统浏览器打开」兜底
- `ERR_CONNECTION_RESET` / `handshake failed ... net_error -101` = 连接在 TLS 阶段被中间设备重置，
  基本都与「没走代理」或网络策略有关，不是页面代码问题；先看联网诊断里的「实际生效」一行
- 证书错误**默认拒绝**（安全）。此前的实现只 `preventDefault()` 未调用 callback，会让 Electron 永久挂起
  —— 表现为「一直转圈、错误页都不出」，已修复为显式回调
