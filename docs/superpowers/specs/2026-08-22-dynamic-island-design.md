# 灵动岛（macOS Dynamic Island）设计

日期：2026-08-22

## 目标

macOS 上在屏幕顶部刘海位常驻一个悬浮小窗（"岛"），镜像主窗**当前选中会话**的三件事：
agent 运行状态、危险操作审批、快捷输入。主窗失焦 / 最小化 / Cmd+W 关闭后岛仍在。

## 不做

- 多会话聚合（岛只跟 `activeSessionId`）
- 好友消息 / 邀请进岛（继续走 `friendNotifier` 系统通知）
- 非 darwin 平台
- 设置页开关（常驻；后续需要再加）
- 原生 NSPanel / node addon

## 方案：第二个 BrowserWindow + 独立渲染入口

主进程建第二个窗口加载 `island.html`，走同一个 preload / `ShellBridge`。
岛 = 又一个从 append-only 日志投影出来的 UI，主进程推送改为 fan-out 到主窗 + 岛窗。
不新增 SessionEvent 类型，日志 schema 不动。

否决的替代方案：
- 主窗渲染层算好"岛状态"再转发 —— 投影源变成另一个投影，且主窗关了岛就瞎。
- 原生 NSPanel —— 引 native 构建链，签名 / 分发复杂度翻倍，Electron 透明 alwaysOnTop 已达 95% 观感。

## 1. 窗口

`src/main/islandWindow.ts`

- `createIslandWindow(preloadPath, rendererUrlOrFile)`：
  `frame:false, transparent:true, hasShadow:false, resizable:false, skipTaskbar:true,
  alwaysOnTop` 设 `'screen-saver'` 级，`setVisibleOnAllWorkspaces(true, {visibleOnFullScreen:true})`。
- `focusable` 按态切换：胶囊 / 活动 / 审批态 `false`（不抢焦点）；输入态 `true`。
- 位置：纯函数 `islandBounds(display: {x,y,width}, size: {w,h})` → `{x: 居中, y: display.y}`。
  `screen.on('display-metrics-changed')` 重算。
- 尺寸由岛渲染层决定：`islandResize({w,h,focusable})` IPC → 主进程 `setBounds` + `setFocusable`。
- 仅 `process.platform === 'darwin'` 创建；其他平台所有岛相关 IPC 为空操作。
- 生命周期：`app.whenReady` 后随主窗一起建；主窗销毁岛不销毁；`before-quit` 一起销毁。

## 2. 三态（岛渲染层）

`src/renderer/island/`（独立 React 入口，复用 Tailwind + shadcn）

| 态 | 触发 | 内容 | focusable |
|---|---|---|---|
| 胶囊 | 空闲 | otto 图标 + 当前模型名；hover 微放大 | no |
| 活动 | turn 进行中 | 工具图标 + 工具名 + 呼吸点 + 耗时 | no |
| 审批 | `approvalRequest` 到达 | 工具 + 摘要（复用 `approvalPreview`）+ 允许 / 本会话允许 / 拒绝 | no |
| 输入 | 点胶囊 | 输入框；Enter → `sendMessage(activeSessionId, text)`；Esc 收起 | yes |

- 审批：主窗卡片同时仍在，任一侧点了两边都收（`UIApprover.resolve` 对重复 resolve 已忽略；
  主进程在 resolve 后推 `approvalResolved(toolCallId)` 让另一侧收卡 —— 若现有通道已覆盖则复用）。
- 输入：`activeSessionId === null` 时输入禁用，文案"主窗里先开会话"。
- 工具文案复用既有 `src/renderer/src/lib/toolSummary.ts`（同一 renderer 构建，无需抽到 shared）。

## 3. 数据流

- 新增 `ShellBridge.setActiveSession(sessionId | null)`：主窗渲染层切会话 / 关会话时调。
  主进程保存 `activeSessionId`，推 `activeSessionChanged`；岛 boot 时拿快照。
- `createSend` 改为 `createSend(...targets: SendTarget[])`，逐个检查 destroyed 后 send。
  主进程其余代码零改动（仍只认一个 `send`）。
- 岛渲染层订阅既有 `sessionEvent` 流，按 `activeSessionId` 过滤，
  纯函数 `reduceIsland(state, event)` 得出 `{phase, currentTool, turnStartedAt, pendingApproval}`。
  切会话时重置并从 `readSessionEvents` 重放当前会话尾部得到首帧。

## 4. 错误处理

- 岛窗创建失败（如无显示器）：`console.warn`，不影响主窗启动链（同 dock 图标的处理思路）。
- 推送目标已销毁：静默丢弃（`createSend` 既有语义）。
- 岛上 `sendMessage` 失败：岛内 toast 一行错误，不落日志（主进程那一侧照常落盘）。

## 5. 测试

- `tests/main/islandWindow.test.ts`：`islandBounds` 居中计算；`createSend` 多目标 + 其中一个 destroyed。
- `tests/renderer/island/reduceIsland.test.ts`：事件序列 → 四态、切会话重置、审批 resolve 收卡。
- `tests/architecture.test.ts` 自动覆盖新文件越界 import。
- `tests/e2e/`：岛窗存在、`isAlwaysOnTop()`、主窗关闭后岛仍在（不进 gate，PR 贴结果）。

## 6. 文件清单

新增：`src/main/islandWindow.ts`、`src/renderer/island.html`、`src/renderer/src/island/*`、
`docs/adr/0059-灵动岛是第二个日志投影窗口.md`。
改动：`src/main/index.ts`（建岛窗、fan-out send、activeSession handle）、
`src/main/rendererPush.ts`、`src/shared/shellBridge.ts`、`src/preload/index.ts`、
`electron.vite.config.*`（第二个 renderer 入口）、主窗切会话处调 `setActiveSession`。
