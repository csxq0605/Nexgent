# @nexgent/desktop

Nexgent 桌面应用（Electron）。主进程持有 `@nexgent/sdk` 的实例；渲染进程只是界面，经 preload 暴露的 `window.nexgent` 调用 SDK。边界规则见 `docs/spec/permissions.md` §本地 IPC 与访问令牌，SDK 接口见 `packages/sdk/src/api.ts`。

归属：计划步骤 2。主进程、preload 与打包是 W5（「桌面主进程」，`src/main/**`、`src/preload/**`、`electron-builder.yml`、`package.json`、`docs/install.md`）；界面是 W6（「桌面界面」，`src/renderer/**`、`index.html`、`vite.config.*`）。安装与运行步骤见 `docs/install.md`。

## 结构

| 文件 | 内容 |
| --- | --- |
| `src/main/index.ts` | 入口：单实例、窗口、`app://nexgent/` 协议、导航与权限拦截、`nexgent:call` 处理、事件推送、关闭协议 |
| `src/main/ipc-guard.ts` | 每窗口令牌（`TokenRegistry`）与调用检查：发送方框架与来源 → 令牌 → 白名单 → 参数；失败返回 `approval/denied` 并记一行日志（不记令牌和参数） |
| `src/main/validate.ts` | 每个白名单方法的参数规则（必填、类型、绝对路径、快照内相对路径、不认识的字段拒绝） |
| `src/main/origin.ts` | 页面来源、导航判定、`app://` 到 `dist/renderer/` 的文件映射、CSP |
| `src/main/window-config.ts` | 窗口 `webPreferences`（隔离、沙箱、无 Node）及其核对 |
| `src/main/shutdown.ts` | 关闭协议：有进行中的轮次先确认，确认后取消、等 `turn.end`、释放 SDK，再退出 |
| `src/main/dialogs.ts` | 文件对话框（打开项目、添加资料、导出目录）；`sessions.export` 的目录由主进程对话框决定 |
| `src/main/logger.ts` | 日志：`<NEXGENT_HOME>/logs/desktop-YYYY-MM-DD.log`，按本地日期滚动，保留 14 天 |
| `src/main/sdk-loader.ts` | 取得 SDK：`@nexgent/sdk` 的 `createSdk`（开发构建可用 `NEXGENT_DESKTOP_SDK_MODULE` 换成脚本化 SDK） |
| `src/main/launch-args.ts` | 启动参数 `--project <绝对路径>`（`nexgent app` 的约定）：启动时经 `projects.open` 打开并初始化，排在 `projects.recent` 第一位；第二次启动把项目交给已运行的实例 |
| `src/main/ipc-types.ts` | 通道名、令牌参数、调用的请求与应答类型、页面看到的 `NexgentBridge` 类型 |
| `src/preload/index.cts` | 沙箱 preload（单个 CommonJS 文件，只 `require('electron')`） |
| `scripts/package.mjs` | 打包：`pnpm deploy` 暂存到 `build/app`，再用 electron-builder 产出到 `release/` |

## 界面（`src/renderer/`）

React 18 + Vite。`index.html` 与 `vite.config.ts` 在包根，`pnpm --filter @nexgent/desktop build`（或 `build:renderer`）产出 `dist/renderer/`；开发时 `pnpm --filter @nexgent/desktop dev:renderer` 起 `http://127.0.0.1:5173`，再用 `NEXGENT_DESKTOP_DEV_URL` 启动 Electron。仓库根的 `pnpm build` 只做 `tsc` 类型检查（含 `src/renderer/tsconfig.json`），不产出界面。

| 文件 | 内容 |
| --- | --- |
| `bridge.ts` | `window.nexgent` 的类型与 `SdkClient`：把 preload 的 reject（普通 `ErrorInfo`）和 IPC 断开都变成 `SdkCallError` |
| `store.ts` | 界面状态与全部用户操作（打开项目、会话、发送、停止、审批、资料、反馈、目标、设置、密钥）；失败一律变成顶部错误条，不抛出 |
| `timeline.ts` | 会话历史 + 实时事件 → 对话条目（流式文本追加、`assistant.message` 定稿、中断保留已流出文本、工具块配对） |
| `strings.ts` | 全部中文文案 |
| `components/` | 开始页、左栏（项目切换、对话列表）、中栏（时间线、工具块、成果卡片、Composer 的 `@` 资料引用、停止）、右栏（资料、成果、文件、目标）、审批对话框、成果查看与 v(n-1)→vn 差异、反馈表单、设置页、错误边界 |
| `testing/fake-bridge.ts` | 组件测试用的假 `window.nexgent`（不进打包产物） |

测试：`src/renderer/__tests__/`（vitest + Testing Library，jsdom）；`tests/ui-e2e.spec.ts` 用 Playwright 拉起真实 Electron + 真实 SDK + 脚本化模型服务端，按用户操作跑完整条链（设 `NEXGENT_UI_SCREENSHOTS=<目录>` 保存截图）。

## 渲染进程怎么用

```ts
import type { NexgentBridge } from '../main/ipc-types.js'   // 同一个包内，只取类型
declare global { interface Window { nexgent: NexgentBridge } }

const info = await window.nexgent.invoke('app.info', {})
const off = window.nexgent.onEvent((event) => { /* SdkEvent */ })
```

- `invoke` 失败时 reject 的是普通对象 `ErrorInfo`（`{ name, code, message, details? }`），不是 `Error`：`contextBridge` 会把 `Error` 削成只剩 message。被主进程拦下的调用 `code` 为 `approval/denied`，`details.check` 是 `sender` / `token` / `method` / `input` 之一。
- 界面构建产物放在 `dist/renderer/`（`index.html` 为入口），主进程从 `app://nexgent/` 提供；没有时显示占位页。页面带 CSP，脚本只能来自 `'self'`，不能内联。
- `sessions.export` 的 `outDir` 只是对话框的起点，实际目录由用户在主进程对话框里选；取消时 reject `approval/denied`（`details.cancelled: true`）。

## 环境变量

| 变量 | 作用 | 打包后 |
| --- | --- | --- |
| `NEXGENT_HOME` | 代替 `~/.nexgent`（日志、Chromium 配置目录与单实例锁、SDK 的 home） | 生效 |
| `NEXGENT_LOG_LEVEL` | `debug` / `info`（默认）/ `warn` / `error` | 生效 |
| `NEXGENT_DESKTOP_DEV_URL` | 从本机 vite 开发服务器加载界面（只接受 `http://localhost:<端口>` 或 `127.0.0.1`） | 忽略 |
| `NEXGENT_DESKTOP_RENDERER_DIR` | 用这个目录代替 `dist/renderer` 提供 `app://nexgent/` | 忽略 |
| `NEXGENT_DESKTOP_SDK_MODULE` | 一个导出 `createSdk` 的模块（端到端测试用的脚本化 SDK） | 忽略 |

## 测试

`pnpm --filter @nexgent/desktop test`（先在仓库根 `pnpm build`）。单元测试覆盖参数规则、令牌与检查顺序、导航与协议映射、窗口配置、日志、关闭协议、preload（在模拟的沙箱里加载编译产物）；`tests/e2e.spec.ts` 用 Playwright 拉起真实 Electron（`tests/fixtures/` 的页面与脚本化 SDK），Linux 没有 `DISPLAY` 时自己起 Xvfb。以 root 运行时加 `--no-sandbox`（Chromium 不允许 root 开沙箱）。
