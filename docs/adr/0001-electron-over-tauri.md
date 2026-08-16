# ADR-0001: 桌面壳选 Electron（而非 Tauri）

- Date: 2026-08-14
- Status: accepted

## Context

otter 是 macOS 桌面 GUI agent 工具（作品集项目，4-6 周 MVP 窗口）。核心栈全是 Node 生态：agent loop（TypeScript）、better-sqlite3 事件日志、dockerode（v2 沙箱）。壳的候选是 Tauri 和 Electron。

Tauri 优势（包体 ~5MB、内存省、mac 质感）在 mac-only 下成立，但 agent loop 必须以 sidecar 进程跑 + IPC 胶水，多一层架构成本；社区体量小，冷门问题自担。Electron 主进程即 Node，核心依赖零胶水直跑，生态答案齐全。

## Decision

MVP 用 Electron。Node 核心（agent loop / SQLite / dockerode）跑在主进程，React + Zustand 跑在渲染进程。前端与后端通信收敛到单一 `ShellBridge` 接口（TauriBridge / ElectronBridge 可互换），渲染进程禁止直接触碰 Node API。

## Consequences

- 换来：4-6 周窗口内时间烧在真正亮点（事件日志、审批管线、ExecutionWorld），不烧在 Rust sidecar 胶水。
- 代价：包体 100MB+、内存占用高。作品集 demo 场景可接受。
- `ShellBridge` 纪律是后悔药：守住"渲染进程只走 bridge"，未来迁 Tauri 是几天的活；破了纪律就是逐处拆弹。看到前端绕远路走 bridge 的代码，这是原因，勿"优化"回直连。
