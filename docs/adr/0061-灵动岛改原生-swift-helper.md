# 0061 灵动岛改原生 Swift helper

日期：2026-08-22 · 设计：docs/superpowers/specs/2026-08-22-notch-island-swift-design.md

**Supersedes ADR-0059**（灵动岛是第二个日志投影窗口）。

## 背景

ADR-0059 用第二个透明 `BrowserWindow`（alwaysOnTop、贴顶居中）做灵动岛，随 PR #181 合入 main。实测折叠态即使按机型查表拿到刘海宽（16" = 220pt）盖住物理刘海，仍到不了原生水准：

- Electron 无 `NSScreen.auxiliaryTopLeftArea/auxiliaryTopRightArea` API，拿不到精确刘海几何（[electron#31478](https://github.com/electron/electron/issues/31478) 仍开着），只能按机型硬编码查表——换台机器就错。
- 凹角过渡（刘海两侧的 concave flare）、展开/收起的 spring 物理手感，CSS 到不了原生 SwiftUI + Core Animation 的水平。
- 用户反复否决"药丸感"，明确要求"真正融入 macOS 刘海"。

原生 Swift 还顺带降运行时压力：去掉一个 Chromium 渲染进程（约 60–150MB），换成一个约 5–15MB 的原生进程。代价在工程：多一条 Swift 构建链、跨进程 IPC 桥、打包时随 app 签名。

## 决定

删除 Electron 第二窗口实现，改用原生 Swift helper：

- **`native/MrOttoIsland/`**：SPM 包，依赖 [DynamicNotchKit](https://github.com/MrKai77/DynamicNotchKit)（MIT），`platforms: [.macOS(.v13)]`，独立 executable target。拿真实 `NSScreen` 刘海几何、四态 SwiftUI 渲染、spring 动画、hover 展开、非 notch 机走 `.floating` 兜底。
- **stdio 子进程桥**：Electron 主进程 `child_process.spawn` 该二进制（`LSUIElement`/`.accessory`，不进 dock 不抢焦点），`stdio: ['pipe','pipe','pipe']`。主进程写 NDJSON 状态快照到 helper stdin，helper 写 NDJSON 命令（`send`/`approve`/`deny`/`ready`）到 stdout。解析失败的一侧记一行日志、跳过该行、保管道不崩。
- **主进程算投影、推扁平快照**：`islandSnapshot()` 由主进程（事件日志所有者）在 active session 变、turnStatus 变、工具开始/结束、审批请求/裁决、model 变时算好，整包（非增量）序列化后 push；Swift 侧是纯渲染层，不持有权威状态，只做 diff 驱动动画。

## 否决项

- **继续 Electron（沿用 0059）**：CSS/透明窗口到不了原生刘海几何与 spring 手感的天花板，且 electron#31478 短期内不会关闭——这是本次重写的直接触发原因。
- **XPC**：macOS 原生 IPC 机制，但要求 helper 是签名的 XPC service bundle，跨进程双向调用的样板代码和调试复杂度远超一个单向 NDJSON 管道；本场景只需"推快照、收命令"这种简单单向流，XPC 的能力（双向异步调用、连接生命周期管理）用不上。
- **Unix domain socket**：比 stdio 多一层地址管理（临时文件路径、清理、权限），子进程天然就有 stdin/stdout 两个已建好的管道，没有引入 socket 的必要性。
- **Swift 侧重写 `reduceIsland`**：让 Swift 也拿事件流自己投影，会导致 TS 和 Swift 各写一份投影逻辑、手动保持同步——跨语言重复 reducer 是维护地雷。主进程已经在跟踪 running/pendingApproval，只需补 `phase`/`currentTool`/`turnStartedAt` 三个字段即可算出完整岛快照，没有理由让 Swift 重复这份逻辑。

## 后果

- 多一条 Swift 构建链：`scripts/build-island.mjs` 跑 `swift build`（dev 用 debug 产物，打包用 release），CI/开发机都要装 Swift toolchain。
- 打包多一步：`electron-builder.yml` 的 `afterPack`（`scripts/afterPack.cjs`）把 release 二进制拷进 `<app>/Contents/Resources/MrOttoIsland` 并 ad-hoc 签（与主 app 同签名策略，见 docs/distribution-macos.md）。
- Swift 侧无权威状态：岛崩溃或二进制缺失不影响主进程/主窗——`resolveIslandBinPath()` 找不到二进制就返回 `null`，岛静默不启动，app 无回归。
- 跨进程 stdio 桥比同进程内的 `BrowserWindow`/IPC 多一层序列化/反序列化和进程生命周期管理（限次重启 ≤3、指数退避、超限即不亮岛）。

## 投影模型说明（新 ADR 关键点）

主进程算好整包快照推给 Swift，这**不是** ADR-0059 否决的"投影的投影"：

- 0059 否决的是**主窗**（一个渲染进程，本身就是一份投影）再算一遍状态转发给岛——主窗一关岛就瞎，这是"投影的投影"链路脆弱的地方。
- 这里算投影的是**主进程**，它就是事件日志的所有者、唯一事实源。在源头（日志所有者）算一次投影推出去，是**权威投影**，不是二次投影——链路是 `日志 → 主进程投影 → Swift 渲染`，一环，不是 `日志 → 主窗投影 → 岛投影` 两环。
- 对齐 AGENTS.md Hard rule："append-only 事件日志是唯一事实来源……任何投影（模型上下文/UI）必须可从日志推导"：岛上显示的一切都能从主进程的日志投影推导，Swift 侧只是这份投影的最后一层渲染，不引入新的事实来源。

## Hard rules 自检

- append-only 日志唯一事实源、投影可从日志推导：快照由主进程从日志算，Swift 无权威状态。✓
- 渲染进程只通过 ShellBridge：Swift helper 非 Electron 渲染进程，不适用；它是主进程独占的新 seam，本 ADR 明记。✓
- 工具实现只依赖 ExecutionWorld：不涉及。✓
- SessionEvent schema 向后兼容：不新增 SessionEvent，桥协议是投影的传输格式，不是新事实。✓

## 相关

- 设计文档：`docs/superpowers/specs/2026-08-22-notch-island-swift-design.md`
- 打包细节：`docs/distribution-macos.md`「灵动岛 helper」节
- 手动冒烟清单：`docs/island-smoke.md`
