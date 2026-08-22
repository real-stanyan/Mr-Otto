# 灵动岛 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** macOS 屏幕顶部刘海位常驻一个透明悬浮小窗，镜像主窗当前会话的运行状态 / 审批 / 快捷输入。

**Architecture:** 第二个 `BrowserWindow` 加载独立渲染入口 `island.html`，走同一个 preload / `ShellBridge`；主进程 `createSend` fan-out 到主窗 + 岛窗；岛渲染层用纯函数 `reduceIsland` 从既有事件流投影出四态。不新增 SessionEvent 类型。

**Tech Stack:** Electron BrowserWindow（transparent / alwaysOnTop）、React + Tailwind + lucide-react、vitest。

**Spec:** `docs/superpowers/specs/2026-08-22-dynamic-island-design.md`

## Global Constraints

- 仅 `process.platform === "darwin"` 创建岛窗；其他平台所有岛 IPC 为空操作。
- 渲染层只通过 `window.otter`（ShellBridge）通信，禁止 import Node/Electron（`tests/architecture.test.ts` 会红）。
- 不新增 SessionEvent 类型；日志 schema 不动。
- 主进程所有推送走 `createSend`，禁止裸 `webContents.send`。
- 测试放 `tests/`，镜像 `src/` 结构。门禁 `npm test` = `tsc --noEmit` + `vitest run`。
- 分支 `claude/dynamic-island`，Task issue #175。commit 写 why。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/main/rendererPush.ts`（改） | `createSend(...targets)` 多目标 fan-out |
| `src/main/islandWindow.ts`（新） | `islandBounds` 纯函数 + `createIslandWindow` |
| `src/shared/shellBridge.ts`（改） | 新增 `IslandBoot`、`setActiveSession` / `islandBoot` / `islandResize` / `onActiveSessionChanged` + CHANNELS |
| `src/preload/index.ts`（改） | 转发上述四条 |
| `src/main/index.ts`（改） | 建岛窗、fan-out send、`activeSessionId` 状态与 handle、before-quit 销毁 |
| `src/renderer/island.html`（新） | 岛入口 HTML |
| `src/renderer/src/island/reduceIsland.ts`（新） | 纯投影：事件 → 岛状态 |
| `src/renderer/src/island/main.tsx`（新） | 岛 React 入口 |
| `src/renderer/src/island/Island.tsx`（新） | 四态 UI + 订阅 + 尺寸上报 |
| `src/renderer/src/store.ts`（改） | sessionId 变化 → `setActiveSession`；`approval_decision` 事件收卡 |
| `electron.vite.config.ts`（改） | renderer 第二入口 |
| `docs/adr/0059-灵动岛是第二个日志投影窗口.md`（新） | 决策记录 |
| `tests/e2e/island.e2e.ts`（新） | 岛窗存在 / alwaysOnTop / 主窗关后仍在 |

---

### Task 1: `createSend` 多目标

**Files:**
- Modify: `src/main/rendererPush.ts`
- Test: `tests/main/rendererPush.test.ts`（已存在则追加，否则新建）

**Interfaces:**
- Produces: `createSend(...targets: SendTarget[]): Send` —— 对每个未销毁目标 `webContents.send`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/main/rendererPush.test.ts（追加）
import { describe, it, expect, vi } from "vitest";
import { createSend, type SendTarget } from "../../src/main/rendererPush.js";

function fakeWin(destroyed = false): SendTarget & { sent: unknown[][] } {
  const sent: unknown[][] = [];
  return {
    sent,
    isDestroyed: () => destroyed,
    webContents: { isDestroyed: () => destroyed, send: (...a: unknown[]) => { sent.push(a); } },
  };
}

describe("createSend 多目标", () => {
  it("推给所有活着的窗口,已销毁的静默跳过", () => {
    const a = fakeWin(), dead = fakeWin(true), b = fakeWin();
    const send = createSend(a, dead, b);
    send("ch", 1);
    expect(a.sent).toEqual([["ch", 1]]);
    expect(b.sent).toEqual([["ch", 1]]);
    expect(dead.sent).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx vitest run tests/main/rendererPush.test.ts`
Expected: FAIL（`createSend` 只收一个参数，b 没收到）。

- [ ] **Step 3: 实现**

```ts
// src/main/rendererPush.ts —— 替换 createSend
/** 多目标:主窗 + 岛窗都是日志的投影窗口,每条推送两边都要到。
    每个目标各自查 destroyed —— 主窗 Cmd+W 关了,岛照常收 */
export function createSend(...targets: SendTarget[]): Send {
  return (channel, ...args) => {
    for (const win of targets) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send(channel, ...args);
    }
  };
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `npx vitest run tests/main/rendererPush.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/rendererPush.ts tests/main/rendererPush.test.ts
git commit -m "refactor(push): createSend 接受多个窗口 —— 岛窗是第二个投影目标（#175）"
```

---

### Task 2: ShellBridge 新增岛相关接口

**Files:**
- Modify: `src/shared/shellBridge.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface IslandBoot { activeSessionId: string | null; model: string | null; }
  setActiveSession(sessionId: string | null): Promise<void>;
  islandBoot(): Promise<IslandBoot>;
  islandResize(size: { w: number; h: number }): Promise<void>;
  onActiveSessionChanged(cb: (info: IslandBoot) => void): Unsubscribe;
  ```
  CHANNELS: `setActiveSession: "otter:setActiveSession"`, `islandBoot: "otter:islandBoot"`, `islandResize: "otter:islandResize"`, `activeSessionChanged: "otter:activeSessionChanged"`.

- [ ] **Step 1: 加类型与方法**

在 `ShellBridge` 接口 `onWindowFullscreen` 之后追加：

```ts
  /** 主窗当前看着哪个会话(null = welcome)。岛只投影这一个会话 */
  setActiveSession(sessionId: string | null): Promise<void>;
  /** 岛窗首帧快照:当前会话 + 它的模型 */
  islandBoot(): Promise<IslandBoot>;
  /** 岛窗内容尺寸变了 → 主进程 setBounds(透明窗的窗体要跟 DOM 同步) */
  islandResize(size: { w: number; h: number }): Promise<void>;
  /** 主窗切会话 / 切模型 → 推给岛窗 */
  onActiveSessionChanged(cb: (info: IslandBoot) => void): Unsubscribe;
```

在文件靠后的类型区追加：

```ts
/** 岛窗的首帧 / 变化推送都是这一份 */
export interface IslandBoot {
  activeSessionId: string | null;
  model: string | null;
}
```

CHANNELS 追加四条（见 Interfaces）。

- [ ] **Step 2: preload 转发**

```ts
  setActiveSession: (sessionId) => ipcRenderer.invoke(CHANNELS.setActiveSession, sessionId),
  islandBoot: () => ipcRenderer.invoke(CHANNELS.islandBoot),
  islandResize: (size) => ipcRenderer.invoke(CHANNELS.islandResize, size),
  onActiveSessionChanged: subscribe(CHANNELS.activeSessionChanged),
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 报错只来自主进程还没实现 handle 的地方不会有（handle 不受接口约束），应全绿。若 `tests/` 里有假 bridge 对象实现 `ShellBridge` 报缺字段，给它补四个 `vi.fn()`。

- [ ] **Step 4: Commit**

```bash
git add src/shared/shellBridge.ts src/preload/index.ts tests
git commit -m "feat(bridge): 岛窗四条接口 —— activeSession 快照/推送、尺寸上报（#175）"
```

---

### Task 3: `islandWindow.ts` —— 位置纯函数 + 建窗

**Files:**
- Create: `src/main/islandWindow.ts`
- Test: `tests/main/islandWindow.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function islandBounds(display: { x: number; y: number; width: number }, size: { w: number; h: number }): { x: number; y: number; width: number; height: number };
  export function createIslandWindow(opts: { preload: string; rendererUrl?: string; rendererFile?: string }): BrowserWindow;
  ```

- [ ] **Step 1: 写失败测试**

```ts
// tests/main/islandWindow.test.ts
import { describe, it, expect } from "vitest";
import { islandBounds } from "../../src/main/islandWindow.js";

describe("islandBounds", () => {
  it("水平居中、贴显示器顶边", () => {
    expect(islandBounds({ x: 0, y: 0, width: 1440 }, { w: 200, h: 36 }))
      .toEqual({ x: 620, y: 0, width: 200, height: 36 });
  });
  it("外接屏有偏移时按该屏原点算", () => {
    expect(islandBounds({ x: 1440, y: -200, width: 1000 }, { w: 100, h: 30 }))
      .toEqual({ x: 1890, y: -200, width: 100, height: 30 });
  });
});
```

- [ ] **Step 2: 确认红**

Run: `npx vitest run tests/main/islandWindow.test.ts`
Expected: FAIL "Cannot find module".

- [ ] **Step 3: 实现**

```ts
// src/main/islandWindow.ts
// 灵动岛:第二个 BrowserWindow,贴主屏顶部居中。它和主窗一样只是日志的投影窗口
// (ADR-0059),主进程推送两边都到(createSend 多目标),审批/发消息走同一套 IPC。
// 为什么不是原生 NSPanel:引 native 构建链,签名分发翻倍,透明 alwaysOnTop 已够用。
import { BrowserWindow, screen } from "electron";

/** 纯函数:给显示器工作区和内容尺寸,算窗体位置。单测只测这个 */
export function islandBounds(
  display: { x: number; y: number; width: number },
  size: { w: number; h: number }
): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.round(display.x + (display.width - size.w) / 2),
    y: display.y,
    width: size.w,
    height: size.h,
  };
}

const INITIAL = { w: 220, h: 40 };

export function createIslandWindow(opts: {
  preload: string;
  rendererUrl?: string;
  rendererFile?: string;
}): BrowserWindow {
  const { bounds } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    ...islandBounds(bounds, INITIAL),
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    // 折叠态不抢焦点;进输入态时由 islandResize 的调用方 setFocusable(true)
    focusable: false,
    webPreferences: {
      preload: opts.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // screen-saver 级:压过全屏 app 和菜单栏
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.once("ready-to-show", () => win.showInactive());
  // 显示器拔插 / 分辨率变 → 重新贴顶居中,尺寸沿用当前
  const relayout = () => {
    if (win.isDestroyed()) return;
    const { width, height } = win.getBounds();
    win.setBounds(islandBounds(screen.getPrimaryDisplay().bounds, { w: width, h: height }));
  };
  screen.on("display-metrics-changed", relayout);
  win.on("closed", () => screen.removeListener("display-metrics-changed", relayout));

  if (opts.rendererUrl) void win.loadURL(`${opts.rendererUrl}/island.html`);
  else if (opts.rendererFile) void win.loadFile(opts.rendererFile);
  return win;
}

/** islandResize 的主进程侧:改尺寸并保持贴顶居中;输入态顺便放开焦点 */
export function resizeIsland(win: BrowserWindow, size: { w: number; h: number }, focusable: boolean): void {
  if (win.isDestroyed()) return;
  win.setBounds(islandBounds(screen.getPrimaryDisplay().bounds, size));
  win.setFocusable(focusable);
  if (focusable) win.focus();
}
```

- [ ] **Step 4: 确认绿**

Run: `npx vitest run tests/main/islandWindow.test.ts`
Expected: PASS（vitest 里 `electron` 是 externalized 的 stub；若 import 报错，测试文件顶部加 `vi.mock("electron", () => ({ BrowserWindow: class {}, screen: { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 0 } }), on() {}, removeListener() {} } }))`）。

- [ ] **Step 5: Commit**

```bash
git add src/main/islandWindow.ts tests/main/islandWindow.test.ts
git commit -m "feat(island): 岛窗建窗与贴顶居中纯函数（#175）"
```

---

### Task 4: 主进程接线

**Files:**
- Modify: `src/main/index.ts`（`createWindow` 之后、`createSend(win)` 处、`getWindowFullscreen` handle 旁、`before-quit`）
- Modify: `electron.vite.config.ts`

**Interfaces:**
- Consumes: Task 1 `createSend(...targets)`、Task 3 `createIslandWindow` / `resizeIsland`、Task 2 CHANNELS。
- Produces: 主进程状态 `activeSessionId: string | null`；推送 `activeSessionChanged`。

- [ ] **Step 1: vite 第二入口**

```ts
// electron.vite.config.ts renderer.build 内追加
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          island: resolve(__dirname, "src/renderer/island.html"),
        },
      },
```

- [ ] **Step 2: 建岛窗 + fan-out**

在 `const win = createWindow(); mainWindow = win;` 之后、`const send = createSend(win);` 替换为：

```ts
  // 灵动岛只在 mac 上有(ADR-0059)。建失败不能拖死启动链 —— 同 dock 图标的处理
  let island: BrowserWindow | null = null;
  if (process.platform === "darwin") {
    try {
      island = createIslandWindow({
        preload: join(import.meta.dirname, "../preload/index.mjs"),
        ...(process.env["ELECTRON_RENDERER_URL"]
          ? { rendererUrl: process.env["ELECTRON_RENDERER_URL"] }
          : { rendererFile: join(import.meta.dirname, "../renderer/island.html") }),
      });
    } catch (e) {
      console.warn("灵动岛没起来:", e instanceof Error ? e.message : e);
    }
  }
  const send = island ? createSend(win, island) : createSend(win);
```

顶部 import 追加：`import { createIslandWindow, resizeIsland } from "./islandWindow.js";`

- [ ] **Step 3: activeSession 状态与 handle**

在 `ipcMain.handle(CHANNELS.getWindowFullscreen, ...)` 旁追加：

```ts
  // 岛只跟主窗当前会话。主进程存这一个 id:岛窗 boot 时问,变化时推
  let activeSessionId: string | null = null;
  const islandSnapshot = (): IslandBoot => ({
    activeSessionId,
    model: activeSessionId ? (agents.get(activeSessionId)?.model ?? null) : null,
  });
  ipcMain.handle(CHANNELS.setActiveSession, (_e, sessionId: string | null) => {
    activeSessionId = sessionId;
    send(CHANNELS.activeSessionChanged, islandSnapshot());
  });
  ipcMain.handle(CHANNELS.islandBoot, () => islandSnapshot());
  ipcMain.handle(CHANNELS.islandResize, (_e, size: { w: number; h: number; focusable?: boolean }) => {
    if (island) resizeIsland(island, size, size.focusable ?? false);
  });
```

`import type { IslandBoot } from "../shared/shellBridge.js";`（并入既有 type import）。`islandResize` 的 bridge 签名在 Task 2 改为 `islandResize(size: { w: number; h: number; focusable?: boolean })`。

`switchModel` handle 里（`agent.switchModel(...)` 之后）追加 `send(CHANNELS.activeSessionChanged, islandSnapshot());`，胶囊态的模型名才跟得上。

- [ ] **Step 4: 退出时销毁**

`app.on("before-quit", () => {` 体内首行追加：`island?.destroy();`

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts electron.vite.config.ts src/shared/shellBridge.ts src/preload/index.ts
git commit -m "feat(island): 主进程建岛窗、推送 fan-out、activeSession 快照与推送（#175）"
```

---

### Task 5: `reduceIsland` 纯投影

**Files:**
- Create: `src/renderer/src/island/reduceIsland.ts`
- Test: `tests/renderer/island/reduceIsland.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type IslandPhase = "idle" | "active" | "approval";
  export interface IslandState {
    sessionId: string | null;
    phase: IslandPhase;
    currentTool: ToolCallRequest | null;
    turnStartedAt: number | null;
    pendingApproval: ApprovalRequest | null;
    callsById: Record<string, ToolCallRequest>;
  }
  export type IslandInput =
    | { kind: "event"; event: SessionEvent }
    | { kind: "turnStatus"; update: TurnStatusUpdate; now: number }
    | { kind: "approvalRequest"; req: ApprovalRequest }
    | { kind: "activeSession"; sessionId: string | null };
  export const initialIsland: IslandState;
  export function reduceIsland(s: IslandState, input: IslandInput): IslandState;
  ```
  （"输入态"是 UI 局部状态，不进 reducer。）

- [ ] **Step 1: 写失败测试**

```ts
// tests/renderer/island/reduceIsland.test.ts
import { describe, it, expect } from "vitest";
import { initialIsland, reduceIsland, type IslandState } from "../../../src/renderer/src/island/reduceIsland.js";
import type { SessionEvent } from "../../../src/session/events.js";

const S = "s1";
const base = { seq: 0, sessionId: S, ts: 0 };
const ev = (e: Omit<SessionEvent, "seq" | "sessionId" | "ts">) => ({ ...base, ...e }) as SessionEvent;
const call = { id: "c1", name: "bash", args: { cmd: "ls" } };
const active = (): IslandState => reduceIsland(initialIsland, { kind: "activeSession", sessionId: S });

describe("reduceIsland", () => {
  it("turn running → active,记开始时间", () => {
    const s = reduceIsland(active(), { kind: "turnStatus", update: { sessionId: S, status: "running" }, now: 100 });
    expect(s.phase).toBe("active");
    expect(s.turnStartedAt).toBe(100);
  });

  it("assistant_message 记下 toolCalls,tool_execution_started 定位当前工具,tool_result 清掉", () => {
    let s = reduceIsland(active(), { kind: "turnStatus", update: { sessionId: S, status: "running" }, now: 1 });
    s = reduceIsland(s, { kind: "event", event: ev({ type: "assistant_message", content: "", toolCalls: [call], model: "m" }) });
    s = reduceIsland(s, { kind: "event", event: ev({ type: "tool_execution_started", toolCallId: "c1" }) });
    expect(s.currentTool).toEqual(call);
    s = reduceIsland(s, { kind: "event", event: ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "" }) });
    expect(s.currentTool).toBeNull();
    expect(s.phase).toBe("active");
  });

  it("approvalRequest → approval 态;approval_decision 同 id → 回 active", () => {
    const req = { sessionId: S, call, toolDescription: "跑命令" };
    let s = reduceIsland(active(), { kind: "turnStatus", update: { sessionId: S, status: "running" }, now: 1 });
    s = reduceIsland(s, { kind: "approvalRequest", req });
    expect(s.phase).toBe("approval");
    expect(s.pendingApproval).toEqual(req);
    s = reduceIsland(s, { kind: "event", event: ev({ type: "approval_decision", toolCallId: "c1", decision: "approved" }) });
    expect(s.phase).toBe("active");
    expect(s.pendingApproval).toBeNull();
  });

  it("turn idle → 全清回 idle", () => {
    let s = reduceIsland(active(), { kind: "approvalRequest", req: { sessionId: S, call, toolDescription: "" } });
    s = reduceIsland(s, { kind: "turnStatus", update: { sessionId: S, status: "idle" }, now: 5 });
    expect(s).toMatchObject({ phase: "idle", currentTool: null, pendingApproval: null, turnStartedAt: null });
  });

  it("别的会话的输入一律丢", () => {
    const s = active();
    expect(reduceIsland(s, { kind: "turnStatus", update: { sessionId: "other", status: "running" }, now: 1 })).toBe(s);
    expect(reduceIsland(s, { kind: "approvalRequest", req: { sessionId: "other", call, toolDescription: "" } })).toBe(s);
  });

  it("切会话 → 重置为该会话的 idle", () => {
    let s = reduceIsland(active(), { kind: "turnStatus", update: { sessionId: S, status: "running" }, now: 1 });
    s = reduceIsland(s, { kind: "activeSession", sessionId: "s2" });
    expect(s).toEqual({ ...initialIsland, sessionId: "s2" });
  });
});
```

- [ ] **Step 2: 确认红**

Run: `npx vitest run tests/renderer/island`
Expected: FAIL "Cannot find module".

- [ ] **Step 3: 实现**

```ts
// src/renderer/src/island/reduceIsland.ts
// 岛的投影:从既有事件流 + turnStatus + approvalRequest 推出四态里的三态
// (输入态是 UI 局部状态,不是日志能推出来的事实,所以不在这里)。
// 纯函数,全部可单测;不新增 SessionEvent —— 岛是日志的又一个投影(ADR-0059)。
import type { SessionEvent, ToolCallRequest } from "../../../session/events.js";
import type { ApprovalRequest, TurnStatusUpdate } from "../../../shared/shellBridge.js";

export type IslandPhase = "idle" | "active" | "approval";

export interface IslandState {
  sessionId: string | null;
  phase: IslandPhase;
  currentTool: ToolCallRequest | null;
  turnStartedAt: number | null;
  pendingApproval: ApprovalRequest | null;
  /** tool_execution_started 只带 id,名字要从 assistant_message.toolCalls 里找 */
  callsById: Record<string, ToolCallRequest>;
}

export type IslandInput =
  | { kind: "event"; event: SessionEvent }
  | { kind: "turnStatus"; update: TurnStatusUpdate; now: number }
  | { kind: "approvalRequest"; req: ApprovalRequest }
  | { kind: "activeSession"; sessionId: string | null };

export const initialIsland: IslandState = {
  sessionId: null,
  phase: "idle",
  currentTool: null,
  turnStartedAt: null,
  pendingApproval: null,
  callsById: {},
};

export function reduceIsland(s: IslandState, input: IslandInput): IslandState {
  switch (input.kind) {
    case "activeSession":
      return { ...initialIsland, sessionId: input.sessionId };
    case "turnStatus": {
      if (input.update.sessionId !== s.sessionId) return s;
      if (input.update.status === "running") {
        return { ...s, phase: s.pendingApproval ? "approval" : "active", turnStartedAt: s.turnStartedAt ?? input.now };
      }
      // turn 谢幕:挂起的审批已被主进程 resolve 成 denied,卡跟着收
      return { ...initialIsland, sessionId: s.sessionId };
    }
    case "approvalRequest":
      if (input.req.sessionId !== s.sessionId) return s;
      return { ...s, phase: "approval", pendingApproval: input.req };
    case "event": {
      const e = input.event;
      if (e.sessionId !== s.sessionId) return s;
      switch (e.type) {
        case "assistant_message": {
          if (!e.toolCalls?.length) return s;
          const callsById = { ...s.callsById };
          for (const c of e.toolCalls) callsById[c.id] = c;
          return { ...s, callsById };
        }
        case "tool_execution_started":
          return { ...s, phase: "active", currentTool: s.callsById[e.toolCallId] ?? null };
        case "tool_result":
          return s.currentTool?.id === e.toolCallId ? { ...s, currentTool: null } : s;
        case "approval_decision":
          if (s.pendingApproval?.call.id !== e.toolCallId) return s;
          return { ...s, phase: "active", pendingApproval: null };
        default:
          return s;
      }
    }
  }
}
```

- [ ] **Step 4: 确认绿**

Run: `npx vitest run tests/renderer/island`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/island/reduceIsland.ts tests/renderer/island/reduceIsland.test.ts
git commit -m "feat(island): reduceIsland 纯投影 —— 事件流推出 idle/active/approval（#175）"
```

---

### Task 6: 岛渲染层 UI

**Files:**
- Create: `src/renderer/island.html`
- Create: `src/renderer/src/island/main.tsx`
- Create: `src/renderer/src/island/Island.tsx`

**Interfaces:**
- Consumes: Task 5 `reduceIsland`；`window.otter.islandBoot / onActiveSessionChanged / onEvent / onTurnStatus / onApprovalRequest / decideApproval / sendMessage / islandResize`；`@/lib/toolSummary` 的 `toolSummary`。

- [ ] **Step 1: island.html**

```html
<!doctype html>
<html lang="zh" class="dark">
  <head>
    <meta charset="UTF-8" />
    <title>Mr Otto Island</title>
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' ws://localhost:5173 ws://127.0.0.1:5173; img-src 'self' data:"
    />
    <style>html,body,#root{background:transparent;margin:0;overflow:hidden}</style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/island/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: main.tsx**

```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { Island } from "./Island.js";
import "../app.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Island />
  </React.StrictMode>
);
```

- [ ] **Step 3: Island.tsx**

```tsx
// 灵动岛 UI:四态 —— 胶囊(idle) / 活动 / 审批 / 输入。
// 状态三态来自 reduceIsland(日志投影);输入态是本组件局部状态。
// 窗体尺寸跟 DOM 走:ResizeObserver 量根节点,islandResize 上报给主进程 setBounds。
import { useEffect, useReducer, useRef, useState } from "react";
import { Check, Loader2, Send, Terminal, X } from "lucide-react";
import { toolSummary } from "@/lib/toolSummary.js";
import { initialIsland, reduceIsland, type IslandInput } from "./reduceIsland.js";

function useIsland() {
  const [s, dispatch] = useReducer(reduceIsland, initialIsland);
  const [model, setModel] = useState<string | null>(null);
  useEffect(() => {
    const offs = [
      window.otter.onActiveSessionChanged((b) => { setModel(b.model); dispatch({ kind: "activeSession", sessionId: b.activeSessionId }); }),
      window.otter.onEvent((event) => dispatch({ kind: "event", event })),
      window.otter.onTurnStatus((update) => dispatch({ kind: "turnStatus", update, now: Date.now() })),
      window.otter.onApprovalRequest((req) => dispatch({ kind: "approvalRequest", req })),
    ];
    void window.otter.islandBoot().then((b) => { setModel(b.model); dispatch({ kind: "activeSession", sessionId: b.activeSessionId }); });
    return () => offs.forEach((off) => off());
  }, []);
  return { s, model, dispatch: dispatch as (i: IslandInput) => void };
}

/** 根节点尺寸 → 主进程 setBounds。输入态放开焦点 */
function useReportSize(ref: React.RefObject<HTMLDivElement | null>, focusable: boolean) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      void window.otter.islandResize({ w: Math.ceil(r.width), h: Math.ceil(r.height), focusable });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, focusable]);
}

function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  return <span className="tabular-nums text-white/60">{Math.floor((Date.now() - since) / 1000)}s</span>;
}

export function Island() {
  const { s, model } = useIsland();
  const [composing, setComposing] = useState(false);
  const [text, setText] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  useReportSize(rootRef, composing);

  const submit = async () => {
    if (!s.sessionId || !text.trim()) return;
    const body = text.trim();
    setText(""); setComposing(false);
    try { await window.otter.sendMessage(s.sessionId, body); }
    catch (e) { console.error("岛上发消息失败", e); }
  };
  const decide = (decision: "approved" | "denied", grant?: "session") => {
    if (!s.sessionId || !s.pendingApproval) return;
    void window.otter.decideApproval(s.sessionId, s.pendingApproval.call.id, { decision, ...(grant ? { grant } : {}) });
  };

  const shell = "inline-flex items-center gap-2 rounded-full bg-black text-white text-[12px] px-3 py-1.5 shadow-lg select-none";

  return (
    <div ref={rootRef} className="inline-block p-1">
      {composing ? (
        <form className={shell} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { setComposing(false); setText(""); } }}
            disabled={!s.sessionId}
            placeholder={s.sessionId ? "对 Otto 说…" : "主窗里先开会话"}
            className="w-64 bg-transparent outline-none placeholder:text-white/40"
          />
          <button type="submit" disabled={!s.sessionId} className="opacity-70 hover:opacity-100"><Send size={14} /></button>
        </form>
      ) : s.phase === "approval" && s.pendingApproval ? (
        <div className={shell}>
          <span className="text-amber-300">审批</span>
          <span className="max-w-56 truncate">{toolSummary(s.pendingApproval.call).verb} {toolSummary(s.pendingApproval.call).target}</span>
          <button onClick={() => decide("approved")} title="允许" className="text-green-400"><Check size={14} /></button>
          <button onClick={() => decide("approved", "session")} title="本会话允许" className="text-green-400/70 text-[10px]">会话</button>
          <button onClick={() => decide("denied")} title="拒绝" className="text-red-400"><X size={14} /></button>
        </div>
      ) : s.phase === "active" ? (
        <button className={shell} onClick={() => setComposing(true)}>
          {s.currentTool ? <Terminal size={14} className="opacity-80" /> : <Loader2 size={14} className="animate-spin" />}
          <span className="max-w-56 truncate">{s.currentTool ? `${toolSummary(s.currentTool).verb} ${toolSummary(s.currentTool).target}` : "思考中…"}</span>
          {s.turnStartedAt && <Elapsed since={s.turnStartedAt} />}
        </button>
      ) : (
        <button className={`${shell} hover:scale-105 transition-transform`} onClick={() => setComposing(true)}>
          <span className="size-2 rounded-full bg-white/70" />
          <span className="text-white/70">{model ?? "Otto"}</span>
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 类型检查 + 门禁**

Run: `npm test`
Expected: PASS（含 `tests/architecture.test.ts` —— 岛目录没有 Node/Electron import）。

- [ ] **Step 5: 真机看一眼**

Run: `npm run dev`
Expected: 屏幕顶部居中出现黑色胶囊；点它变输入框；Esc 收起。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/island.html src/renderer/src/island
git commit -m "feat(island): 岛渲染层 —— 胶囊/活动/审批/输入四态（#175）"
```

---

### Task 7: 主窗 store 接线（上报会话 + 审批跨窗收卡）

**Files:**
- Modify: `src/renderer/src/store.ts`（`useChat.subscribe` workspace 那段旁；`onEvent` 处理器）
- Test: `tests/renderer/island/approvalDecisionClears.test.ts`

**Interfaces:**
- Consumes: Task 2 `setActiveSession`。
- Produces: 导出纯函数 `clearApprovalOnDecision(approvals: Record<string, ApprovalRequest>, e: SessionEvent): Record<string, ApprovalRequest>`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/renderer/island/approvalDecisionClears.test.ts
import { describe, it, expect } from "vitest";
import { clearApprovalOnDecision } from "../../../src/renderer/src/store.js";
import type { SessionEvent } from "../../../src/session/events.js";

const req = { sessionId: "s1", call: { id: "c1", name: "bash", args: {} }, toolDescription: "" };
const decision = (toolCallId: string): SessionEvent =>
  ({ seq: 1, sessionId: "s1", ts: 0, type: "approval_decision", toolCallId, decision: "approved" }) as SessionEvent;

describe("clearApprovalOnDecision(岛上点了,主窗那张卡也得收)", () => {
  it("同 toolCallId 的 approval_decision 收掉该会话的卡", () => {
    expect(clearApprovalOnDecision({ s1: req }, decision("c1"))).toEqual({});
  });
  it("id 对不上 / 非审批事件不动", () => {
    expect(clearApprovalOnDecision({ s1: req }, decision("zzz"))).toEqual({ s1: req });
  });
});
```

- [ ] **Step 2: 确认红**

Run: `npx vitest run tests/renderer/island/approvalDecisionClears.test.ts`
Expected: FAIL（没有该导出）。

- [ ] **Step 3: 实现**

store.ts 顶层（`enterChat` 附近）追加：

```ts
/** 审批在另一个窗口(岛)被点掉 → approval_decision 流回来,主窗这张卡也收。
    以前只有"自己点了收卡"和"turn idle 兜底收卡"两条路,岛来了就多了第三个点按钮的地方 */
export const clearApprovalOnDecision = (
  approvals: Record<string, ApprovalRequest>,
  e: SessionEvent
): Record<string, ApprovalRequest> => {
  if (e.type !== "approval_decision") return approvals;
  const cur = approvals[e.sessionId];
  return cur?.call.id === e.toolCallId ? without(approvals, e.sessionId) : approvals;
};
```

`window.otter.onEvent((e) => { set((s) => {` 里，返回对象加一项 `approvals: clearApprovalOnDecision(s.approvals, e),`（放在分流 `if (e.sessionId !== s.sessionId)` 之前计算，因为后台会话的卡也要收）。

workspace 那段 `useChat.subscribe` 之后追加：

```ts
    // 主窗看着哪个会话 → 告诉主进程,岛只投影这一个("" = welcome,报 null)
    useChat.subscribe((s, prev) => {
      if (s.sessionId === prev.sessionId) return;
      void window.otter.setActiveSession(s.sessionId || null);
    });
```

- [ ] **Step 4: 确认绿 + 门禁**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/store.ts tests/renderer/island/approvalDecisionClears.test.ts
git commit -m "feat(island): 主窗上报当前会话;approval_decision 事件跨窗收卡（#175）"
```

---

### Task 8: ADR + e2e + 文档

**Files:**
- Create: `docs/adr/0059-灵动岛是第二个日志投影窗口.md`
- Create: `tests/e2e/island.e2e.ts`
- Modify: `AGENTS.md`「Where to find things」（加一行 `src/main/islandWindow.ts`，L2）

- [ ] **Step 1: ADR**

```markdown
# 0059 灵动岛是第二个日志投影窗口

日期：2026-08-22 · Issue #175

## 背景
主窗失焦/最小化后用户看不到 agent 在干什么、审批卡等在那里没人点。

## 决定
macOS 上建第二个 BrowserWindow（透明、alwaysOnTop、贴顶居中）加载独立渲染入口，
走同一个 preload/ShellBridge；主进程 `createSend` fan-out 到两个窗口；岛用纯函数
`reduceIsland` 从既有事件流投影状态。不新增 SessionEvent。只跟主窗当前会话
（`setActiveSession`）。审批在任一窗点击后靠 `approval_decision` 事件让另一窗收卡。

## 否决
- 主窗算好状态转发给岛：投影的投影，且主窗关了岛就瞎。
- 原生 NSPanel：native 构建链 + 签名分发成本，透明 alwaysOnTop 已达 95% 观感。

## 后果
- 主进程多一个窗口生命周期；`window-all-closed` 在 mac 上本就不退出，岛不改变这点。
- 推送多一份拷贝；靠 sessionId 过滤，丢弃成本可忽略。
- 失效前提：若将来岛要聚合多会话，`activeSessionId` 单值模型要改成集合。
```

- [ ] **Step 2: e2e**

```ts
// tests/e2e/island.e2e.ts —— 岛窗起得来、置顶、主窗关了它还在。不在 gate 里
import { _electron as electron, expect, test } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test.skip(process.platform !== "darwin", "灵动岛只在 mac");

test("岛窗存在、置顶、主窗关闭后仍在", async () => {
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env: { ...process.env, OTTO_PROFILE: "e2e" } });
  try {
    await app.firstWindow();
    await expect.poll(() => app.windows().length, { timeout: 20_000 }).toBe(2);
    const info = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => ({ title: w.getTitle(), top: w.isAlwaysOnTop() }))
    );
    const island = info.find((w) => w.title.includes("Island"));
    expect(island?.top).toBe(true);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => !w.getTitle().includes("Island"))?.close();
    });
    await expect.poll(() => app.windows().length).toBe(1);
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 3: 跑 e2e**

Run: `npm run e2e`
Expected: 两条 e2e 绿；输出贴进 PR。

- [ ] **Step 4: AGENTS.md 索引**

「Where to find things」追加：`- src/main/islandWindow.ts — macOS 灵动岛窗口（ADR-0059）`

- [ ] **Step 5: 门禁 + Commit**

Run: `npm test`
Expected: PASS

```bash
git add docs/adr/0059-灵动岛是第二个日志投影窗口.md tests/e2e/island.e2e.ts AGENTS.md
git commit -m "docs(adr): 0059 灵动岛是第二个日志投影窗口;e2e 冒烟岛窗（#175）"
```

---

### Task 9: PR

- [ ] `git push -u origin claude/dynamic-island`
- [ ] `gh pr create --title "feat(island): macOS 灵动岛 —— 当前会话状态/审批/快捷输入悬浮窗" --body "Closes #175。设计 docs/superpowers/specs/2026-08-22-dynamic-island-design.md，ADR-0059。e2e 输出：<粘贴>"`，body 末尾带 `🤖 Generated with [Claude Code](https://claude.com/claude-code)` 与 session 链接。
- [ ] CI 绿后 merge commit 合并（不 squash）。
