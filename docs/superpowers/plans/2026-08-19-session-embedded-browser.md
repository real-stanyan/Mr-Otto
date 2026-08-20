# 会话内置浏览器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给会话加一个人和 agent 共用的内置浏览器 —— 人能开网页、登录、看 localhost；agent 只读地导航并抽正文。

**Architecture:** 主进程持有 `WebContentsView`（Electron 43，`win.contentView.addChildView()`），按渲染层上报的矩形定位。`browserHub`（纯逻辑，不 import electron）是注册表；`webContentsViewFactory`（唯一 import electron 的适配层）把真 webContents 包成 hub 认的窄接口。agent 侧走 `ExecutionWorld.browser?` 这个可选能力，由 `index.ts` 注入 —— 工具照旧只认 world。

**Tech Stack:** Electron 43 / TypeScript strict / React + Zustand / vitest（测试在 `tests/`，镜像 `src/`）

**Spec:** `docs/superpowers/specs/2026-08-19-session-embedded-browser-design.md`

## Global Constraints

- 渲染进程只经 `ShellBridge` 与后端通信，禁止直接触碰 Node / Electron API（AGENTS.md 硬规则）
- 工具实现只依赖 `ExecutionWorld` 接口，禁止 import electron / fs / child_process（AGENTS.md 硬规则）
- 测试统一放 `tests/`，镜像 `src/` 结构，不与源码同目录；文件名 `*.test.ts`（`vitest.config.ts` 的 include 只扫这个）
- 门禁：`npm test`，每个 Task 结束时必须是绿的
- 人的浏览不进事件日志、不进模型上下文（ADR-0031 延伸）；`browser_read` 是工具调用，照现有机制落盘
- `browser_read` 的 `requiresApproval: false`（照 `web_extract`）
- 全局持久 partition 名：`persist:otto-browser`
- 正文截断上限：`50_000` 字符；导航超时：`30_000` ms
- 一个会话一个浏览器（无多标签），但 `BrowserTabInfo.id` 保留在 schema 里

## 与 Spec 的三处偏差（已在实现中修正，spec 未回写）

1. **spec 第四节说抽正文要「先摘掉 script / style / noscript」** —— 实际不需要：`innerText` 按渲染结果取文本，天然不含未渲染节点。改用 `document.body.innerText` 直取，不克隆不改 DOM（克隆出来的游离节点没有 layout，`innerText` 恒为空串，照 spec 字面写反而是个 bug）。
2. **spec 第三节的 `BrowserTabInfo` 没有错误字段** —— 加 `lastError?: string`。加载失败必须让人在 URL 栏底下看得见，否则面板会静默白屏。
3. **spec 第七节说测「`BrowserPanel` 的矩形上报」** —— 本仓库没有 jsdom / testing-library，`vitest.config.ts` 的 include 只认 `*.test.ts`，组件渲染测不了。改为把矩形计算抽成纯函数 `src/renderer/src/lib/browserBounds.ts` 来测；组件里只剩「订阅 ResizeObserver → 调纯函数 → 发 bridge」这条接线。

## File Structure

**新建：**

| 文件 | 职责 |
|---|---|
| `src/shared/browser.ts` | `BrowserTabInfo` / `BrowserBounds` 数据形状 + `normalizeUrl` 纯函数。零运行时依赖，三边共 import |
| `src/main/browserHub.ts` | 会话 → 浏览器的注册表。开 / 关 / 导航 / 定位 / 读页面。**不 import electron**，只认注入的 `BrowserViewHandle` |
| `src/main/webContentsViewFactory.ts` | 唯一 import `WebContentsView` 的地方。把真 webContents 事件翻译成 `BrowserViewEvent` 窄联合 |
| `src/renderer/src/lib/browserBounds.ts` | `rectToBounds(rect, visible)` 纯函数：DOMRect → 主进程要的 bounds，不可见时返回 null |
| `src/renderer/src/components/BrowserPanel.tsx` | URL 栏 + 前进后退刷新 + 占位 div + ResizeObserver 接线 |
| `src/tools/browserRead.ts` | `browser_read` 工具 |
| `docs/adr/0033-browser-rides-the-world-seam.md` | 决策记录 |

**修改：**

| 文件 | 改动 |
|---|---|
| `src/world/executionWorld.ts` | 加 `BrowserCapability` / `BrowserReadResult` / `browser?` 字段；`withAbortSignal` / `withExecOutput` 透传；新增 `withBrowser` 装饰器 |
| `src/shared/shellBridge.ts` | 加 7 个方法 + 1 个订阅 + 对应 CHANNELS |
| `src/preload/index.ts` | 转发上述通道 |
| `src/main/index.ts` | 建 hub、接 ipcMain、注入 agent、窗口关闭时清理 |
| `src/main/agent.ts` | 加 `makeBrowser?` 注入点；工具表加 `browserReadTool` |
| `src/renderer/src/store.ts` | `browserPanelOpen` + open / close（与其它面板互斥） |
| `src/renderer/src/App.tsx` | panel 分发链加一支 |

---

### Task 1: 数据形状与 world seam（纯类型 + 一个纯函数）

只加接口和一个纯函数，无行为。这一步合完，后面每一步都能各自独立编译。

**Files:**
- Create: `src/shared/browser.ts`
- Create: `tests/shared/browser.test.ts`
- Modify: `src/world/executionWorld.ts`（尾部装饰器 + 接口）
- Modify: `tests/world/executionWorld.test.ts`
- Modify: `src/shared/shellBridge.ts`、`src/preload/index.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `BrowserTabInfo { id: string; sessionId: string; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; lastError?: string }`
  - `BrowserBounds { x: number; y: number; width: number; height: number }`
  - `normalizeUrl(input: string): string`
  - `BrowserReadOptions { url?: string; signal?: AbortSignal }`
  - `BrowserReadResult { url: string; title: string; text: string; truncated: boolean }`
  - `BrowserCapability { read(opts?: BrowserReadOptions): Promise<BrowserReadResult> }`
  - `ExecutionWorld.browser?: BrowserCapability`
  - `withBrowser(world: ExecutionWorld, browser: BrowserCapability): ExecutionWorld`
  - `ShellBridge` 新增：`browserOpen(sessionId)` / `browserNavigate(sessionId, url)` / `browserSetBounds(sessionId, bounds)` / `browserBack(sessionId)` / `browserForward(sessionId)` / `browserReload(sessionId)` / `browserClose(sessionId)` / `onBrowserState(cb)`

- [ ] **Step 1: 写 normalizeUrl 的失败测试**

创建 `tests/shared/browser.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { normalizeUrl } from "../../src/shared/browser.js";

describe("normalizeUrl", () => {
  it("裸域名补 https", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com");
  });

  it("已有协议原样保留", () => {
    expect(normalizeUrl("http://example.com/a?b=1")).toBe("http://example.com/a?b=1");
    expect(normalizeUrl("https://example.com")).toBe("https://example.com");
  });

  it("localhost 带端口补 http 而不是 https —— 本地开发服务器绝大多数不上 TLS，" +
     "补成 https 会直接连不上，而这正是这个浏览器的头号用途", () => {
    expect(normalizeUrl("localhost:5173")).toBe("http://localhost:5173");
    expect(normalizeUrl("127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080/x");
  });

  it("前后空白剃掉", () => {
    expect(normalizeUrl("  example.com  ")).toBe("https://example.com");
  });

  it("空串抛错 —— 空 URL 不是一次导航，是一次误触", () => {
    expect(() => normalizeUrl("   ")).toThrow();
  });

  it("file: 和 about: 原样放行", () => {
    expect(normalizeUrl("about:blank")).toBe("about:blank");
    expect(normalizeUrl("file:///tmp/a.html")).toBe("file:///tmp/a.html");
  });
});
```

- [ ] **Step 2: 跑测试确认它红**

Run: `npx vitest run tests/shared/browser.test.ts`
Expected: FAIL —— `Failed to resolve import "../../src/shared/browser.js"`

- [ ] **Step 3: 写 src/shared/browser.ts**

```ts
// 浏览器在渲染层可见的形态 + URL 归一化。
// 住在 shared/ 的理由同 terminal.ts:三边(main/renderer/preload)共 import,
// 零运行时依赖,不知道背后是 WebContentsView 还是别的什么。

/** 一个会话的浏览器。MVP 一个会话只有一个,但 id 留着——
    将来加多标签时 schema 不用动(向后兼容,同 SessionEvent 的规矩) */
export interface BrowserTabInfo {
  id: string;
  sessionId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** 上一次加载失败的人话。成功一次就清掉——
      失败必须看得见,否则面板只是静默白屏 */
  lastError?: string;
}

/** WebContentsView 的窗口内坐标(DIP)。null = 从窗口上摘下来(面板收起) */
export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

/** 地址栏输入 → 可加载的 URL。
    本地地址补 http:本地开发服务器基本不上 TLS,补 https 等于直接连不上,
    而"看 agent 改出来的页面"正是这个浏览器的头号用途。 */
export function normalizeUrl(input: string): string {
  const s = input.trim();
  if (!s) throw new Error("请输入网址");
  if (HAS_SCHEME.test(s)) return s;
  return (LOCAL_HOST.test(s) ? "http://" : "https://") + s;
}
```

- [ ] **Step 4: 跑测试确认它绿**

Run: `npx vitest run tests/shared/browser.test.ts`
Expected: PASS（6 个用例）

- [ ] **Step 5: 写 world seam 的失败测试**

在 `tests/world/executionWorld.test.ts` 末尾追加（先读一遍该文件里 `openTerminal` 透传那几条的写法，保持同款风格）：

```ts
import { withBrowser } from "../../src/world/executionWorld.js";

describe("browser 能力（可选）", () => {
  const fakeBrowser = { read: vi.fn(async () => ({ url: "u", title: "t", text: "x", truncated: false })) };
  const base = (): ExecutionWorld => ({
    fs: { read: async () => "", write: async () => {} },
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    http: { postJson: async () => ({}) },
  });

  it("withBrowser 把能力焊上去，其余面原样", async () => {
    const w = withBrowser(base(), fakeBrowser);
    expect(w.browser).toBeDefined();
    await w.browser!.read({ url: "https://a" });
    expect(fakeBrowser.read).toHaveBeenCalledWith({ url: "https://a" });
  });

  it("withAbortSignal 透传 browser 并把信号焊进 read —— " +
     "漏了这条,turn 中断时页面还在加载,工具挂到超时才回来", async () => {
    const ac = new AbortController();
    const w = withAbortSignal(withBrowser(base(), fakeBrowser), ac.signal);
    await w.browser!.read({ url: "https://b" });
    expect(fakeBrowser.read).toHaveBeenLastCalledWith({ url: "https://b", signal: ac.signal });
  });

  it("withExecOutput 原样透传 browser", () => {
    const w = withExecOutput(withBrowser(base(), fakeBrowser), () => {});
    expect(w.browser).toBeDefined();
  });

  it("没有 browser 的 world 过装饰器后仍然没有 —— 可选就是可选，不能凭空长出来", () => {
    expect(withAbortSignal(base(), new AbortController().signal).browser).toBeUndefined();
    expect(withExecOutput(base(), () => {}).browser).toBeUndefined();
  });
});
```

- [ ] **Step 6: 跑测试确认它红**

Run: `npx vitest run tests/world/executionWorld.test.ts`
Expected: FAIL —— `withBrowser` 不是导出成员

- [ ] **Step 7: 改 src/world/executionWorld.ts**

在 `ExecutionWorld` 接口上方加类型：

```ts
/** 读一次内置浏览器。url 给了 = 先导航再读;不给 = 读当前页 */
export interface BrowserReadOptions {
  url?: string;
  signal?: AbortSignal;
}

export interface BrowserReadResult {
  /** 读完那一刻的实际 URL(重定向之后的) */
  url: string;
  title: string;
  text: string;
  /** 正文超上限被截断了。截了就明说,不假装读全了 */
  truncated: boolean;
}

/** 浏览器能力。只读——导航 + 抽正文,不点不打字(本期边界,工具名已把它划在名字里) */
export interface BrowserCapability {
  read(opts?: BrowserReadOptions): Promise<BrowserReadResult>;
}
```

在 `ExecutionWorld` 接口里，`openTerminal?` 后面加：

```ts
  /** 可选:这个世界有没有内置浏览器。
      可选的理由同 openTerminal(旧实现和测试里的假 world 零改动)。
      v1 的实现不在 LocalWorld 里——WebContentsView 是 Electron 主进程的东西,
      LocalWorld 是纯 Node 模块,造不出来,所以由 index.ts 从 browserHub 注入(withBrowser)。
      这与终端的方向是反的(终端是 hub 去调 world),因为 pty 是 LocalWorld 自己能干的活。
      v2 SandboxWorld 若在容器里跑浏览器,可以自己实现这个字段,注入那条线就自然退场。 */
  browser?: BrowserCapability;
```

给两个既有装饰器补透传（`withAbortSignal` 里 `openTerminal` 那行后面）：

```ts
    ...(world.browser
      ? { browser: { read: (o?: BrowserReadOptions) => world.browser!.read({ ...o, signal }) } }
      : {}),
```

`withExecOutput` 里同位置：

```ts
    ...(world.browser ? { browser: world.browser } : {}),
```

文件末尾加新装饰器：

```ts
/** 把浏览器能力焊进 world——withAbortSignal 同款手法。
    index.ts 按会话包一层(read 里绑好 sessionId),工具照旧只调 world.browser.read,
    对 hub 的存在无感(硬规则原样成立)。 */
export function withBrowser(world: ExecutionWorld, browser: BrowserCapability): ExecutionWorld {
  return { ...world, browser };
}
```

- [ ] **Step 8: 跑测试确认它绿**

Run: `npx vitest run tests/world/executionWorld.test.ts`
Expected: PASS

- [ ] **Step 9: 加 bridge 面（无测试，纯类型转发）**

`src/shared/shellBridge.ts` —— 顶部随 `TerminalInfo` 一起 import 并 re-export：

```ts
import type { BrowserTabInfo, BrowserBounds } from "./browser.js";
export type { BrowserTabInfo, BrowserBounds };
```

在 `terminalClose` 那一组后面加：

```ts
  /** 开/取本会话的浏览器。幂等:已存在则不重建,一律返回当前快照
      (面板挂载时调一次——agent 可能已经先开着某一页了) */
  browserOpen(sessionId: string): Promise<BrowserTabInfo>;
  /** 地址栏回车。url 未归一化的原始输入,主进程侧过 normalizeUrl */
  browserNavigate(sessionId: string, url: string): Promise<void>;
  /** 面板位置/尺寸同步。null = 面板收起,把 view 从窗口上摘下来(不销毁) */
  browserSetBounds(sessionId: string, bounds: BrowserBounds | null): Promise<void>;
  browserBack(sessionId: string): Promise<void>;
  browserForward(sessionId: string): Promise<void>;
  browserReload(sessionId: string): Promise<void>;
  /** 关浏览器 = 销毁 webContents,登录态之外的一切(历史/前进后退)都没了 */
  browserClose(sessionId: string): Promise<void>;
```

在 `onTerminalExit` 后面加订阅：

```ts
  /** 浏览器状态变了(导航/标题/加载中/失败)。渲染层按 sessionId 分流 */
  onBrowserState(cb: (info: BrowserTabInfo) => void): Unsubscribe;
```

`CHANNELS` 里，`terminalExit` 后面加：

```ts
  browserOpen: "otter:browserOpen",
  browserNavigate: "otter:browserNavigate",
  browserSetBounds: "otter:browserSetBounds",
  browserBack: "otter:browserBack",
  browserForward: "otter:browserForward",
  browserReload: "otter:browserReload",
  browserClose: "otter:browserClose",
  browserState: "otter:browserState",
```

`src/preload/index.ts` —— `terminalClose` 那行后面：

```ts
  browserOpen: (sessionId) => ipcRenderer.invoke(CHANNELS.browserOpen, sessionId),
  browserNavigate: (sessionId, url) => ipcRenderer.invoke(CHANNELS.browserNavigate, sessionId, url),
  browserSetBounds: (sessionId, bounds) => ipcRenderer.invoke(CHANNELS.browserSetBounds, sessionId, bounds),
  browserBack: (sessionId) => ipcRenderer.invoke(CHANNELS.browserBack, sessionId),
  browserForward: (sessionId) => ipcRenderer.invoke(CHANNELS.browserForward, sessionId),
  browserReload: (sessionId) => ipcRenderer.invoke(CHANNELS.browserReload, sessionId),
  browserClose: (sessionId) => ipcRenderer.invoke(CHANNELS.browserClose, sessionId),
```

`onTerminalExit` 那行后面：

```ts
  onBrowserState: subscribe(CHANNELS.browserState),
```

- [ ] **Step 10: 跑全量门禁**

Run: `npm test`
Expected: PASS。若报 `ShellBridge` 未实现新方法，说明还有第三处实现（渲染层的假 bridge 或测试替身）——搜 `terminalClose` 找齐所有实现点补上。

- [ ] **Step 11: Commit**

```bash
git add src/shared/browser.ts src/world/executionWorld.ts src/shared/shellBridge.ts src/preload/index.ts tests/shared/browser.test.ts tests/world/executionWorld.test.ts
git commit -m "feat(browser): 数据形状与 world seam

ExecutionWorld 加可选 browser 能力,照 openTerminal 的先例(可选 = 旧实现
和假 world 零改动)。方向与终端相反:pty 是 LocalWorld 自己能干的活,
WebContentsView 不是,所以 v1 由 index.ts 从 hub 注入。

normalizeUrl 对本地地址补 http 而不是 https——本地开发服务器基本不上 TLS,
补 https 直接连不上,而看 localhost 正是这个浏览器的头号用途。"
```

---

### Task 2: browserHub 核心（导航 / 定位 / 状态推送 / 关闭）

不含 `read()`。这一步的产物是「一个能被驱动、能报状态的注册表」，纯逻辑，不碰 electron。

**Files:**
- Create: `src/main/browserHub.ts`
- Create: `tests/main/browserHub.test.ts`

**Interfaces:**
- Consumes: `BrowserTabInfo` / `BrowserBounds` / `normalizeUrl`（Task 1）
- Produces:
  - `BrowserViewEvent`（窄联合，见下）
  - `BrowserViewHandle`（hub 认的视图接口，Task 3 的 electron 适配层要实现它）
  - `createBrowserHub(deps: BrowserHubDeps)` → `{ open, navigate, setBounds, back, forward, reload, close, closeAll, info }`

- [ ] **Step 1: 写失败测试**

创建 `tests/main/browserHub.test.ts`：

```ts
import { describe, it, expect, vi } from "vitest";
import { createBrowserHub, type BrowserViewHandle, type BrowserViewEvent } from "../../src/main/browserHub.js";
import type { BrowserBounds } from "../../src/shared/browser.js";

/** 假 view:能被导航、能被外部驱动着发事件、能被摘下来/销毁 */
function fakeView() {
  let emit: ((e: BrowserViewEvent) => void) | null = null;
  const loaded: string[] = [];
  const boundsLog: Array<BrowserBounds | null> = [];
  let url = "";
  let title = "";
  let destroyed = false;
  let backable = false;
  const nav = { back: 0, forward: 0, reload: 0 };
  const handle: BrowserViewHandle = {
    loadURL: async (u) => { loaded.push(u); url = u; },
    getURL: () => url,
    getTitle: () => title,
    canGoBack: () => backable,
    canGoForward: () => false,
    goBack: () => { nav.back++; },
    goForward: () => { nav.forward++; },
    reload: () => { nav.reload++; },
    executeJavaScript: async () => "{}",
    setBounds: (b) => { boundsLog.push(b); },
    on: (cb) => { emit = cb; return () => { emit = null; }; },
    destroy: () => { destroyed = true; },
  };
  return {
    handle,
    fire: (e: BrowserViewEvent) => emit?.(e),
    setTitle: (t: string) => { title = t; },
    setBackable: (v: boolean) => { backable = v; },
    get loaded() { return loaded; },
    get boundsLog() { return boundsLog; },
    get destroyed() { return destroyed; },
    get nav() { return nav; },
  };
}

function makeHub() {
  const views: ReturnType<typeof fakeView>[] = [];
  const state = vi.fn();
  const hub = createBrowserHub({
    createView: () => { const v = fakeView(); views.push(v); return v.handle; },
    push: { state },
  });
  return { hub, views, state };
}

describe("browserHub 注册表", () => {
  it("open 是幂等的:同一会话只造一个 view", () => {
    const { hub, views } = makeHub();
    const a = hub.open("s1");
    const b = hub.open("s1");
    expect(views).toHaveLength(1);
    expect(b.id).toBe(a.id);
  });

  it("会话隔离:两个会话各有各的 view", () => {
    const { hub, views } = makeHub();
    expect(hub.open("s1").id).not.toBe(hub.open("s2").id);
    expect(views).toHaveLength(2);
  });

  it("navigate 归一化后加载", async () => {
    const { hub, views } = makeHub();
    hub.open("s1");
    await hub.navigate("s1", "example.com");
    expect(views[0].loaded).toEqual(["https://example.com"]);
  });

  it("navigate 会自己 ensure:没 open 过也能直接导航(agent 先到的情况)", async () => {
    const { hub, views } = makeHub();
    await hub.navigate("s1", "example.com");
    expect(views).toHaveLength(1);
  });

  it("后来者赢:连发两次导航,最终 URL 是后一个", async () => {
    const { hub, views } = makeHub();
    await hub.navigate("s1", "a.com");
    await hub.navigate("s1", "b.com");
    expect(views[0].loaded).toEqual(["https://a.com", "https://b.com"]);
    expect(hub.info("s1")!.url).toBe("https://b.com");
  });

  it("视图事件变成状态推送", () => {
    const { hub, views, state } = makeHub();
    hub.open("s1");
    views[0].fire({ type: "loading", loading: true });
    expect(state).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: "s1", loading: true }));
    views[0].fire({ type: "navigated", url: "https://x.com" });
    views[0].setTitle("X 站");
    views[0].fire({ type: "title", title: "X 站" });
    expect(state).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: "https://x.com", title: "X 站" })
    );
  });

  it("加载失败落进 lastError 并推给渲染层——静默白屏是最难查的那种坏", () => {
    const { hub, views, state } = makeHub();
    hub.open("s1");
    views[0].fire({ type: "failed", errorCode: -105, errorDescription: "NAME_NOT_RESOLVED", url: "https://nope.invalid" });
    expect(state).toHaveBeenLastCalledWith(
      expect.objectContaining({ loading: false, lastError: expect.stringContaining("NAME_NOT_RESOLVED") })
    );
    expect(hub.info("s1")!.lastError).toContain("-105");
  });

  it("加载成功清掉上一次的错——错误是状态不是历史", () => {
    const { hub, views } = makeHub();
    hub.open("s1");
    views[0].fire({ type: "failed", errorCode: -105, errorDescription: "NAME_NOT_RESOLVED", url: "https://nope.invalid" });
    views[0].fire({ type: "loaded" });
    expect(hub.info("s1")!.lastError).toBeUndefined();
  });

  it("setBounds 透传;null = 摘下来但不销毁(关面板不杀页面)", () => {
    const { hub, views } = makeHub();
    hub.open("s1");
    hub.setBounds("s1", { x: 10, y: 20, width: 300, height: 400 });
    hub.setBounds("s1", null);
    expect(views[0].boundsLog).toEqual([{ x: 10, y: 20, width: 300, height: 400 }, null]);
    expect(views[0].destroyed).toBe(false);
    expect(hub.info("s1")).not.toBeNull();
  });

  it("setBounds 对不存在的会话是静默 no-op —— 面板卸载时的收尾调用" +
     "可能晚于 close 到达,不该炸", () => {
    const { hub } = makeHub();
    expect(() => hub.setBounds("ghost", null)).not.toThrow();
  });

  it("back/forward/reload 透传", () => {
    const { hub, views } = makeHub();
    hub.open("s1");
    hub.back("s1"); hub.forward("s1"); hub.reload("s1");
    expect(views[0].nav).toEqual({ back: 1, forward: 1, reload: 1 });
  });

  it("canGoBack 跟着视图走", () => {
    const { hub, views } = makeHub();
    hub.open("s1");
    views[0].setBackable(true);
    views[0].fire({ type: "navigated", url: "https://x.com" });
    expect(hub.info("s1")!.canGoBack).toBe(true);
  });

  it("close 销毁 view、解监听、从表里摘掉", () => {
    const { hub, views } = makeHub();
    hub.open("s1");
    hub.close("s1");
    expect(views[0].destroyed).toBe(true);
    expect(hub.info("s1")).toBeNull();
  });

  it("closeAll 清场(窗口关闭时用)", () => {
    const { hub, views } = makeHub();
    hub.open("s1"); hub.open("s2");
    hub.closeAll();
    expect(views.every((v) => v.destroyed)).toBe(true);
    expect(hub.info("s1")).toBeNull();
  });

  it("close 之后再 open 是一个新 view,不复活旧的", () => {
    const { hub, views } = makeHub();
    const first = hub.open("s1").id;
    hub.close("s1");
    expect(hub.open("s1").id).not.toBe(first);
    expect(views).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 跑测试确认它红**

Run: `npx vitest run tests/main/browserHub.test.ts`
Expected: FAIL —— 解析不到 `../../src/main/browserHub.js`

- [ ] **Step 3: 写 src/main/browserHub.ts**

```ts
// browserHub —— 主进程的浏览器注册表(一个会话一个)。
//
// 这里刻意不 import electron:真 WebContentsView 由 webContentsViewFactory 包成
// BrowserViewHandle 注入进来。好处不是"解耦"这种漂亮话,是这一整套逻辑
// (幂等 ensure / 状态投影 / 失败落 lastError / 摘下来但不销毁)全部能在
// 普通 vitest 里跑,不用起 Electron。
//
// 人的浏览不进事件日志、不进模型上下文(ADR-0031 终端先例的延伸):
// 它是人的旁路工具,不是某个事实的投影。agent 的 read() 是工具调用,照旧落盘。

import { randomUUID } from "node:crypto";
import { normalizeUrl, type BrowserBounds, type BrowserTabInfo } from "../shared/browser.js";

/** 视图往外发的事件。窄联合而不是照搬 webContents 的事件名:
    hub 只关心这四件事,适配层负责把 Electron 那一堆翻译过来 */
export type BrowserViewEvent =
  | { type: "navigated"; url: string }
  | { type: "title"; title: string }
  | { type: "loading"; loading: boolean }
  | { type: "loaded" }
  | { type: "failed"; errorCode: number; errorDescription: string; url: string };

/** hub 眼里的一个视图。真身是 WebContentsView,测试里是个普通对象 */
export interface BrowserViewHandle {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  executeJavaScript(code: string): Promise<unknown>;
  /** null = 从窗口上摘下来(不销毁) */
  setBounds(bounds: BrowserBounds | null): void;
  /** 返回退订函数(与 TerminalSession 的订阅同构) */
  on(cb: (e: BrowserViewEvent) => void): () => void;
  destroy(): void;
}

export interface BrowserHubDeps {
  createView(): BrowserViewHandle;
  push: { state(info: BrowserTabInfo): void };
}

interface BrowserRecord {
  id: string;
  sessionId: string;
  view: BrowserViewHandle;
  title: string;
  loading: boolean;
  lastError?: string;
  off: () => void;
}

export function createBrowserHub(deps: BrowserHubDeps) {
  const browsers = new Map<string, BrowserRecord>();

  // 快照每次现算:url / canGoBack 这些的事实在 view 里,
  // 在 record 里再存一份就会有两个真相,而它们迟早对不上
  const snapshot = (r: BrowserRecord): BrowserTabInfo => ({
    id: r.id,
    sessionId: r.sessionId,
    url: r.view.getURL(),
    title: r.title || r.view.getTitle(),
    loading: r.loading,
    canGoBack: r.view.canGoBack(),
    canGoForward: r.view.canGoForward(),
    ...(r.lastError ? { lastError: r.lastError } : {}),
  });

  function ensure(sessionId: string): BrowserRecord {
    const existing = browsers.get(sessionId);
    if (existing) return existing;
    const view = deps.createView();
    const record: BrowserRecord = {
      id: randomUUID(),
      sessionId,
      view,
      title: "",
      loading: false,
      off: () => {},
    };
    record.off = view.on((e) => {
      switch (e.type) {
        case "navigated":
          record.title = "";
          break;
        case "title":
          record.title = e.title;
          break;
        case "loading":
          record.loading = e.loading;
          break;
        case "loaded":
          record.loading = false;
          // 成功一次就把上次的错抹掉:lastError 是状态不是历史
          delete record.lastError;
          break;
        case "failed":
          record.loading = false;
          record.lastError = `${e.errorDescription}（${e.errorCode}）: ${e.url}`;
          break;
      }
      deps.push.state(snapshot(record));
    });
    browsers.set(sessionId, record);
    return record;
  }

  return {
    /** 幂等:已有就返回已有的快照(面板挂载时调,agent 可能已经先开着某页了) */
    open(sessionId: string): BrowserTabInfo {
      return snapshot(ensure(sessionId));
    },

    /** 后来者赢,不加锁:agent 和人抢同一块屏是特性——人看得见它去了哪 */
    async navigate(sessionId: string, url: string): Promise<void> {
      const r = ensure(sessionId);
      const target = normalizeUrl(url);
      delete r.lastError;
      await r.view.loadURL(target);
      deps.push.state(snapshot(r));
    },

    /** null = 面板收起。摘下来但不销毁——照终端"关面板不杀进程"的前提:
        重开时页面还在,登录态还在。会话不存在时静默返回:
        面板卸载的收尾调用可能晚于 close 到达 */
    setBounds(sessionId: string, bounds: BrowserBounds | null): void {
      browsers.get(sessionId)?.view.setBounds(bounds);
    },

    back(sessionId: string): void { browsers.get(sessionId)?.view.goBack(); },
    forward(sessionId: string): void { browsers.get(sessionId)?.view.goForward(); },
    reload(sessionId: string): void { browsers.get(sessionId)?.view.reload(); },

    /** 关 = 销毁。解监听再销毁——挂着监听器的死 view 就是泄漏 */
    close(sessionId: string): void {
      const r = browsers.get(sessionId);
      if (!r) return;
      r.off();
      r.view.destroy();
      browsers.delete(sessionId);
    },

    /** 窗口关闭时清场 */
    closeAll(): void {
      for (const id of [...browsers.keys()]) this.close(id);
    },

    info(sessionId: string): BrowserTabInfo | null {
      const r = browsers.get(sessionId);
      return r ? snapshot(r) : null;
    },
  };
}

export type BrowserHub = ReturnType<typeof createBrowserHub>;
```

- [ ] **Step 4: 跑测试确认它绿**

Run: `npx vitest run tests/main/browserHub.test.ts`
Expected: PASS（15 个用例）

注意：`closeAll` 里用了 `this.close` —— 返回的是对象字面量，`this` 在方法调用下正常。若 TypeScript strict 抱怨 `this` 隐式 any，把 hub 先赋给 `const api = {...}` 再 `return api`，`closeAll` 里改调 `api.close(id)`。

- [ ] **Step 5: 跑全量门禁 + Commit**

Run: `npm test`

```bash
git add src/main/browserHub.ts tests/main/browserHub.test.ts
git commit -m "feat(browser): browserHub 注册表(导航/定位/状态/关闭)

刻意不 import electron:真 WebContentsView 由适配层包成 BrowserViewHandle
注入。这样幂等 ensure、状态投影、失败落 lastError、摘下来但不销毁
这几条全都能在普通 vitest 里跑。

快照现算不缓存:url/canGoBack 的事实在 view 里,存两份迟早对不上。"
```

---

### Task 3: Electron 适配层 + 主进程接线

把真 `WebContentsView` 接上，人这一侧从此可用（但还没有 UI —— 下个 Task 才有）。这一步没有单元测试：它全是 Electron 边界，测的成本远高于收益；正确性靠 Task 4 的手动验收。

**Files:**
- Create: `src/main/webContentsViewFactory.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `BrowserViewHandle` / `BrowserViewEvent` / `createBrowserHub`（Task 2），`CHANNELS`（Task 1）
- Produces: `createWebContentsViewHandle(win: BrowserWindow, partition: string): BrowserViewHandle`；`index.ts` 里的 `browsers` hub 实例

- [ ] **Step 1: 写 src/main/webContentsViewFactory.ts**

```ts
// 全项目唯一 import WebContentsView 的地方。
// 职责只有一件:把 Electron 的 webContents 包成 browserHub 认的窄接口,
// 顺手把它那一堆事件翻译成 BrowserViewEvent 五件套。
// 隔离这一层的收益很实在——browserHub 那边整套逻辑因此能脱离 Electron 跑测试。

import { WebContentsView, type BrowserWindow } from "electron";
import type { BrowserViewHandle, BrowserViewEvent } from "./browserHub.js";
import type { BrowserBounds } from "../shared/browser.js";

export function createWebContentsViewHandle(win: BrowserWindow, partition: string): BrowserViewHandle {
  const view = new WebContentsView({
    webPreferences: {
      // 独立 partition:登录态跨会话跨重启活着(痛点之一),
      // 且与 app 自己的 session 分家——网页的 cookie 不该和 Otto 的搅在一起
      partition,
      // 网页是不可信内容,一律关到最紧
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const wc = view.webContents;
  let attached = false;

  // 新窗口一律拦下,在当前 view 里打开:内置浏览器只有一块屏,
  // 放任 window.open 会飘出一个 Otto 管不着的裸窗口
  wc.setWindowOpenHandler(({ url }) => {
    void wc.loadURL(url);
    return { action: "deny" };
  });

  return {
    loadURL: (url) => wc.loadURL(url),
    getURL: () => wc.getURL(),
    getTitle: () => wc.getTitle(),
    canGoBack: () => wc.navigationHistory.canGoBack(),
    canGoForward: () => wc.navigationHistory.canGoForward(),
    goBack: () => wc.navigationHistory.goBack(),
    goForward: () => wc.navigationHistory.goForward(),
    reload: () => wc.reload(),
    executeJavaScript: (code) => wc.executeJavaScript(code, true),

    setBounds: (b: BrowserBounds | null) => {
      if (!b || b.width <= 0 || b.height <= 0) {
        if (attached) {
          win.contentView.removeChildView(view);
          attached = false;
        }
        return;
      }
      if (!attached) {
        win.contentView.addChildView(view);
        attached = true;
      }
      view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
    },

    on: (cb: (e: BrowserViewEvent) => void) => {
      const onNavigate = (_e: unknown, url: string) => cb({ type: "navigated", url });
      const onInPageNavigate = (_e: unknown, url: string) => cb({ type: "navigated", url });
      const onTitle = (_e: unknown, title: string) => cb({ type: "title", title });
      const onStart = () => cb({ type: "loading", loading: true });
      const onStop = () => cb({ type: "loading", loading: false });
      const onFinish = () => cb({ type: "loaded" });
      const onFail = (
        _e: unknown,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame: boolean
      ) => {
        // 子框架(广告 iframe 之类)加载失败不是这一页失败,报上去只会误导人
        if (!isMainFrame) return;
        // -3 = ABORTED,用户/我们自己中途换页触发的,不是错
        if (errorCode === -3) return;
        cb({ type: "failed", errorCode, errorDescription, url: validatedURL });
      };
      wc.on("did-navigate", onNavigate);
      wc.on("did-navigate-in-page", onInPageNavigate);
      wc.on("page-title-updated", onTitle);
      wc.on("did-start-loading", onStart);
      wc.on("did-stop-loading", onStop);
      wc.on("did-finish-load", onFinish);
      wc.on("did-fail-load", onFail);
      return () => {
        wc.off("did-navigate", onNavigate);
        wc.off("did-navigate-in-page", onInPageNavigate);
        wc.off("page-title-updated", onTitle);
        wc.off("did-start-loading", onStart);
        wc.off("did-stop-loading", onStop);
        wc.off("did-finish-load", onFinish);
        wc.off("did-fail-load", onFail);
      };
    },

    destroy: () => {
      if (attached) {
        win.contentView.removeChildView(view);
        attached = false;
      }
      wc.close();
    },
  };
}
```

- [ ] **Step 2: 在 index.ts 建 hub**

在 `const terminals = createTerminalHub({...});` 那一段后面加：

```ts
  // 浏览器注册表:app 级资源,一个会话一个。
  // 与终端的接线方向相反——终端是 hub 去调 agent.world.openTerminal(pty 是
  // LocalWorld 自己能干的活),浏览器是 hub 造好能力反过来注入进 world:
  // WebContentsView 只有主进程 + 窗口造得出来,LocalWorld 是纯 Node 模块,造不出来。
  // seam 仍然成立:工具只认 world.browser,不知道 hub 的存在(ADR-0033)。
  const browsers = createBrowserHub({
    createView: () => {
      if (!mainWindow) throw new Error("窗口还没建好，开不了浏览器");
      return createWebContentsViewHandle(mainWindow, "persist:otto-browser");
    },
    push: { state: (info) => send(CHANNELS.browserState, info) },
  });
```

顶部补 import：

```ts
import { createBrowserHub } from "./browserHub.js";
import { createWebContentsViewHandle } from "./webContentsViewFactory.js";
```

- [ ] **Step 3: 接 ipcMain**

在 `ipcMain.handle(CHANNELS.terminalClose, ...)` 后面加：

```ts
  ipcMain.handle(CHANNELS.browserOpen, (_e, sessionId: string) => browsers.open(sessionId));
  ipcMain.handle(CHANNELS.browserNavigate, (_e, sessionId: string, url: string) =>
    browsers.navigate(sessionId, url)
  );
  ipcMain.handle(CHANNELS.browserSetBounds, (_e, sessionId: string, bounds: BrowserBounds | null) =>
    browsers.setBounds(sessionId, bounds)
  );
  ipcMain.handle(CHANNELS.browserBack, (_e, sessionId: string) => browsers.back(sessionId));
  ipcMain.handle(CHANNELS.browserForward, (_e, sessionId: string) => browsers.forward(sessionId));
  ipcMain.handle(CHANNELS.browserReload, (_e, sessionId: string) => browsers.reload(sessionId));
  ipcMain.handle(CHANNELS.browserClose, (_e, sessionId: string) => browsers.close(sessionId));
```

`BrowserBounds` 加进 `shellBridge.js` 那行 import 的类型列表。

- [ ] **Step 4: 接生命周期清理**

删会话的 handler 里（搜 `CHANNELS.deleteSession` 的 handle），在删 agent 的同一处加一行：

```ts
    browsers.close(sessionId); // 会话没了,它的浏览器也该没
```

窗口关闭处（搜 `mainWindow = null` 或 `on("closed"`）加：

```ts
    browsers.closeAll(); // 窗口没了,挂在它 contentView 上的 view 全部收掉
```

- [ ] **Step 5: 编译验证**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 无报错。（若报 `navigationHistory` 不存在，说明 Electron 类型版本对不上 —— 退回 `wc.canGoBack()` / `wc.goBack()` 这组旧 API，行为一致。）

Run: `npm test`
Expected: PASS（本 Task 不加测试，确认没打破既有的）

- [ ] **Step 6: Commit**

```bash
git add src/main/webContentsViewFactory.ts src/main/index.ts
git commit -m "feat(browser): Electron 适配层 + 主进程接线

webContentsViewFactory 是全项目唯一 import WebContentsView 的地方,
把 webContents 那堆事件翻译成 BrowserViewEvent 五件套。browserHub 因此
能脱离 Electron 跑测试。

did-fail-load 过滤两种噪音:子框架失败不是本页失败;errorCode -3(ABORTED)
是我们自己中途换页触发的,不是错。window.open 一律拦回当前 view——
内置浏览器只有一块屏。"
```

---

### Task 4: BrowserPanel + 矩形上报

人这一侧到此可用。合完这个 Task 就可以先开一个 PR。

**Files:**
- Create: `src/renderer/src/lib/browserBounds.ts`
- Create: `tests/renderer/browserBounds.test.ts`
- Create: `src/renderer/src/components/BrowserPanel.tsx`
- Modify: `src/renderer/src/store.ts`
- Modify: `src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: `ShellBridge.browser*`（Task 1），`BrowserTabInfo`
- Produces: `rectToBounds(rect: DOMRectLike, visible: boolean): BrowserBounds | null`；store 的 `browserPanelOpen` / `openBrowserPanel()` / `closeBrowserPanel()`

- [ ] **Step 1: 写矩形计算的失败测试**

创建 `tests/renderer/browserBounds.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { rectToBounds } from "../../src/renderer/src/lib/browserBounds.js";

describe("rectToBounds", () => {
  it("可见时按 DOMRect 取整", () => {
    expect(rectToBounds({ x: 10.4, y: 20.6, width: 300.2, height: 400.8 }, true))
      .toEqual({ x: 10, y: 21, width: 300, height: 401 });
  });

  it("不可见 = null(面板收起,view 从窗口摘下来)", () => {
    expect(rectToBounds({ x: 0, y: 0, width: 300, height: 400 }, false)).toBeNull();
  });

  it("零尺寸 = null —— 首帧布局还没算完时 DOMRect 是全 0," +
     "照原样报上去会让 view 在左上角闪一下", () => {
    expect(rectToBounds({ x: 0, y: 0, width: 0, height: 0 }, true)).toBeNull();
    expect(rectToBounds({ x: 5, y: 5, width: 300, height: 0 }, true)).toBeNull();
  });

  it("负坐标钳到 0 —— 面板被拖出窗口左沿时,负 x 会让 view 盖住窗口外的桌面", () => {
    expect(rectToBounds({ x: -12, y: -3, width: 300, height: 400 }, true))
      .toEqual({ x: 0, y: 0, width: 300, height: 400 });
  });
});
```

- [ ] **Step 2: 跑测试确认它红**

Run: `npx vitest run tests/renderer/browserBounds.test.ts`
Expected: FAIL —— 解析不到模块

- [ ] **Step 3: 写 src/renderer/src/lib/browserBounds.ts**

```ts
// 占位 div 的 DOMRect → 主进程要的 bounds。
// 抽成纯函数不是为了好看:WebContentsView 是浮在 React 之上的真图层,
// 位置算错的表现是"网页盖在了不该盖的地方",而这类 bug 在组件里极难复现。
// 抽出来就是几条断言的事(而且本仓库没有 jsdom,组件本身测不了)。

import type { BrowserBounds } from "../../../shared/browser.js";

export interface DOMRectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** visible=false 或尺寸为零 → null(= 把 view 从窗口上摘下来)。
    坐标钳到非负:面板拖出窗口左沿时,负 x 会让网页盖到窗口外面去 */
export function rectToBounds(rect: DOMRectLike, visible: boolean): BrowserBounds | null {
  if (!visible) return null;
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  if (width <= 0 || height <= 0) return null;
  return { x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), width, height };
}
```

- [ ] **Step 4: 跑测试确认它绿**

Run: `npx vitest run tests/renderer/browserBounds.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 5: 加 store 槽位**

`src/renderer/src/store.ts`，照 `terminalPanelOpen` 的每一处依样画葫芦：

1. 状态接口里 `terminalPanelOpen: boolean;` 旁边加 `browserPanelOpen: boolean;`
2. actions 接口里 `openTerminalPanel(): void; closeTerminalPanel(): void;` 旁边加 `openBrowserPanel(): void; closeBrowserPanel(): void;`
3. 两处初始值（搜 `terminalPanelOpen: false`，共 4 处含互斥重置）各加 `browserPanelOpen: false`
4. 所有把 `terminalPanelOpen: false` 写进 `set({...})` 的互斥重置里，一并加 `browserPanelOpen: false`
5. action 实现照 `openTerminalPanel` 抄：

```ts
  openBrowserPanel: () =>
    set({
      browserPanelOpen: true,
      terminalPanelOpen: false, protocolOpen: false, gitGraphOpen: false,
      settingsSection: null, friendChat: null, // 互斥:同一块主区
    }),
  closeBrowserPanel: () => set({ browserPanelOpen: false }),
```

6. `openTerminalPanel` 的互斥列表里补上 `browserPanelOpen: false`

- [ ] **Step 6: 写 BrowserPanel.tsx**

```tsx
// 浏览器面板 —— 人和 agent 共用的那一块屏。
//
// 特别之处:真正的网页不在 React 树里,而是主进程挂在窗口 contentView 上的
// WebContentsView,浮在这个组件之上。这里的 <div ref={hostRef}> 是个占位符,
// 唯一职责是"量出自己在哪、多大",报给主进程去摆 view。
//
// 由此带来两条纪律:
// ① 卸载时必须报 null,否则面板关了网页还浮在屏幕上;
// ② 任何会改变占位符位置的动作(拖宽/全屏/窗口 resize)都得重新量。

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, RotateCw, X, Maximize2, Minimize2 } from "lucide-react";
import { useChat } from "../store.js";
import { Button } from "./ui/button.js";
import { rectToBounds } from "../lib/browserBounds.js";
import type { BrowserTabInfo } from "../../../shared/shellBridge.js";

export function BrowserPanel() {
  const sessionId = useChat((s) => s.sessionId);
  const closePanel = useChat((s) => s.closeBrowserPanel);
  const panelWide = useChat((s) => s.panelWide);
  const togglePanelWide = useChat((s) => s.togglePanelWide);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const [info, setInfo] = useState<BrowserTabInfo | null>(null);
  const [draft, setDraft] = useState("");

  // 挂载:拿这个会话浏览器的当前快照(agent 可能已经先开着某一页了)
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    void window.otter.browserOpen(sessionId).then((i) => {
      if (!alive) return;
      setInfo(i);
      setDraft(i.url);
    });
    return () => { alive = false; };
  }, [sessionId]);

  // 状态推送:只认自己这个会话的
  useEffect(() => {
    return window.otter.onBrowserState((i) => {
      if (i.sessionId !== sessionId) return;
      setInfo(i);
      // 地址栏跟着导航走,但别打断正在输入的人:只在没聚焦时同步
      if (document.activeElement?.getAttribute("data-browser-url") !== "1") setDraft(i.url);
    });
  }, [sessionId]);

  // 矩形上报:占位符自己变了(ResizeObserver)、窗口变了(resize)都重量一次。
  // 卸载时报 null——这一句就是"关面板网页也跟着消失"的全部实现
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !sessionId) return;
    const report = (visible: boolean) => {
      const bounds = rectToBounds(host.getBoundingClientRect(), visible);
      void window.otter.browserSetBounds(sessionId, bounds);
    };
    const ro = new ResizeObserver(() => report(true));
    ro.observe(host);
    const onWinResize = () => report(true);
    window.addEventListener("resize", onWinResize);
    report(true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onWinResize);
      void window.otter.browserSetBounds(sessionId, null);
    };
  }, [sessionId, panelWide]);

  const go = () => {
    if (!sessionId) return;
    void window.otter.browserNavigate(sessionId, draft);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <Button variant="ghost" size="icon" disabled={!info?.canGoBack}
          onClick={() => sessionId && void window.otter.browserBack(sessionId)}>
          <ArrowLeft className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" disabled={!info?.canGoForward}
          onClick={() => sessionId && void window.otter.browserForward(sessionId)}>
          <ArrowRight className="size-4" />
        </Button>
        <Button variant="ghost" size="icon"
          onClick={() => sessionId && void window.otter.browserReload(sessionId)}>
          <RotateCw className={`size-4 ${info?.loading ? "animate-spin" : ""}`} />
        </Button>
        <input
          data-browser-url="1"
          className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-sm outline-none focus:ring-1"
          value={draft}
          placeholder="localhost:5173 或 example.com"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") go(); }}
        />
        <Button variant="ghost" size="icon" onClick={togglePanelWide}>
          {panelWide ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </Button>
        <Button variant="ghost" size="icon" onClick={closePanel}>
          <X className="size-4" />
        </Button>
      </div>

      {info?.lastError && (
        <div className="border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          打不开：{info.lastError}
        </div>
      )}

      {/* 占位符。真正的网页由主进程浮在这块矩形上——这里保持空白且不加边框,
          有边框会和上面那层视觉打架(view 盖不住边框,边框会从网页底下透出来) */}
      <div ref={hostRef} className="min-h-0 flex-1" />
    </div>
  );
}
```

- [ ] **Step 7: 接进 App.tsx**

顶部 import：

```ts
import { BrowserPanel } from "./components/BrowserPanel.js";
```

在 `const browserPanelOpen = useChat((s) => s.browserPanelOpen);` 加到 `terminalPanelOpen` 那两处旁边（第 1213 行附近和第 1922 行附近各一处），然后 panel 分发链（第 2043 行附近）加一支：

```ts
  const panel = friendChat ? <FriendChatView />
    : browserPanelOpen ? <BrowserPanel />
    : terminalPanelOpen ? <TerminalView />
    : gitGraphOpen ? <GitGraphView />
    : protocolOpen ? <ProtocolView /> : null;
```

第 1364 行那个 `isActive={...}` 长条件里，跟着 `!terminalPanelOpen` 补一个 `&& !browserPanelOpen`。

入口按钮：找到打开终端面板的那个按钮（搜 `openTerminalPanel`），在它旁边照抄一个调 `openBrowserPanel` 的，图标用 `lucide-react` 的 `Globe`。

- [ ] **Step 8: 跑门禁**

Run: `npm test`
Expected: PASS

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 无报错

- [ ] **Step 9: 手动验收（这个 Task 的真正门禁）**

Run: `npm run dev`

逐条确认：
1. 开一个会话 → 点浏览器入口 → 面板出现，地址栏空
2. 输 `example.com` 回车 → 网页出现在占位区，标题栏/地址栏跟着更新
3. 输 `nope.invalid` 回车 → 红条显示 `NAME_NOT_RESOLVED（-105）`
4. 再输一个能开的地址 → 红条消失
5. 前进后退刷新三个按钮工作，不可用时是灰的
6. 拖动面板宽度 / 点全屏切换 → 网页跟着走，不残留在旧位置
7. 缩放窗口 → 网页跟着走
8. 关面板 → 网页立刻消失，不浮在聊天区上面
9. 重开面板 → 刚才那一页还在（关面板不杀页面）
10. 切到另一个会话再开面板 → 是一块新的空白页，不是上一个会话那页

- [ ] **Step 10: Commit**

```bash
git add src/renderer/src/lib/browserBounds.ts tests/renderer/browserBounds.test.ts src/renderer/src/components/BrowserPanel.tsx src/renderer/src/store.ts src/renderer/src/App.tsx
git commit -m "feat(browser): 浏览器面板与矩形上报

网页不在 React 树里,是浮在面板之上的 WebContentsView;组件里那个 div
只是个量尺寸的占位符。由此两条纪律写进注释:卸载必须报 null(否则关了面板
网页还浮着),任何改变占位符位置的动作都要重量。

矩形计算抽成纯函数单独测:算错的表现是网页盖在不该盖的地方,
这类 bug 在组件里极难复现,抽出来就是几条断言。"
```

---

### Task 5: hub.read()

**Files:**
- Modify: `src/main/browserHub.ts`
- Modify: `tests/main/browserHub.test.ts`

**Interfaces:**
- Consumes: Task 2 的 hub 内部结构
- Produces: `hub.read(sessionId: string, opts?: { url?: string; signal?: AbortSignal }): Promise<BrowserReadResult>`；导出常量 `EXTRACT_JS`

- [ ] **Step 1: 写失败测试**

在 `tests/main/browserHub.test.ts` 末尾追加。先扩充 `fakeView`：给 handle 的 `executeJavaScript` 换成可编程的，并暴露出来。改法是在 `fakeView()` 里加：

```ts
  let script: () => Promise<unknown> = async () =>
    JSON.stringify({ title: "T", url: "https://x.com", text: "正文" });
```

把 handle 里那行改成 `executeJavaScript: () => script(),`，并在返回对象里加 `setScript: (f: () => Promise<unknown>) => { script = f; }`。

然后追加：

```ts
describe("browserHub.read", () => {
  it("不给 url = 读当前页,不导航", async () => {
    const { hub, views } = makeHub();
    hub.open("s1");
    const r = await hub.read("s1");
    expect(views[0].loaded).toEqual([]);
    expect(r).toEqual({ url: "https://x.com", title: "T", text: "正文", truncated: false });
  });

  it("给了 url = 先导航,等 loaded 再读", async () => {
    const { hub, views } = makeHub();
    const pending = hub.read("s1", { url: "a.com" });
    await Promise.resolve(); // 让 loadURL 落地
    expect(views[0].loaded).toEqual(["https://a.com"]);
    views[0].fire({ type: "loaded" });
    await expect(pending).resolves.toMatchObject({ text: "正文" });
  });

  it("agent 先到时自己 ensure 出 view —— 面板没开过也要能读", async () => {
    const { hub, views } = makeHub();
    const pending = hub.read("s1", { url: "a.com" });
    await Promise.resolve();
    views[0].fire({ type: "loaded" });
    await pending;
    expect(views).toHaveLength(1);
  });

  it("加载失败 = 抛,不返回假装成功的空字符串", async () => {
    const { hub, views } = makeHub();
    const pending = hub.read("s1", { url: "nope.invalid" });
    await Promise.resolve();
    views[0].fire({ type: "failed", errorCode: -105, errorDescription: "NAME_NOT_RESOLVED", url: "https://nope.invalid" });
    await expect(pending).rejects.toThrow(/-105|NAME_NOT_RESOLVED/);
  });

  it("超时 = 抛", async () => {
    vi.useFakeTimers();
    const { hub } = makeHub();
    const pending = hub.read("s1", { url: "slow.com" });
    const assertion = expect(pending).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    vi.useRealTimers();
  });

  it("中断 = reject,且不伪装成加载失败(ADR-0006 语义)", async () => {
    const { hub } = makeHub();
    const ac = new AbortController();
    const pending = hub.read("s1", { url: "a.com", signal: ac.signal });
    const assertion = expect(pending).rejects.toThrow(/中断/);
    ac.abort();
    await assertion;
  });

  it("已经 abort 的信号:立刻 reject,不发起导航", async () => {
    const { hub, views } = makeHub();
    hub.open("s1");
    await expect(hub.read("s1", { url: "a.com", signal: AbortSignal.abort() })).rejects.toThrow(/中断/);
    expect(views[0].loaded).toEqual([]);
  });

  it("超上限截断,并在结果里明说截了", async () => {
    const { hub, views } = makeHub();
    hub.open("s1");
    views[0].setScript(async () =>
      JSON.stringify({ title: "T", url: "https://x.com", text: "字".repeat(60_000) })
    );
    const r = await hub.read("s1");
    expect(r.truncated).toBe(true);
    expect(r.text).toHaveLength(50_000);
  });

  it("页面脚本返回的不是预期形状 = 抛,而不是把 undefined 当正文喂给模型", async () => {
    const { hub, views } = makeHub();
    hub.open("s1");
    views[0].setScript(async () => "not json");
    await expect(hub.read("s1")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认它红**

Run: `npx vitest run tests/main/browserHub.test.ts`
Expected: FAIL —— `hub.read is not a function`

- [ ] **Step 3: 实现 read**

`src/main/browserHub.ts` 顶部加常量与超时：

```ts
const READ_TIMEOUT_MS = 30_000;
const MAX_TEXT_CHARS = 50_000;

/** 页面里跑的抽取脚本。
    直接用 innerText 而不是先克隆再删 script/style:innerText 按渲染结果取文本,
    未渲染的节点天然不在里面;而克隆出来的游离节点没有 layout,innerText 恒为空串
    ——照"先摘掉 script/style"的字面写法反而会读出一片空白。 */
export const EXTRACT_JS = `JSON.stringify({
  title: document.title || "",
  url: location.href,
  text: (document.body && document.body.innerText || "").replace(/\\n{3,}/g, "\\n\\n").trim()
})`;
```

import 补上 `BrowserReadOptions` / `BrowserReadResult`：

```ts
import type { BrowserReadOptions, BrowserReadResult } from "../world/executionWorld.js";
```

在返回对象里加（`info` 之前）：

```ts
    /** agent 的读。导航失败/超时/中断一律抛——
        返回一个假装成功的空字符串,会让模型以为"这页没内容",
        比报错难查一个数量级 */
    async read(sessionId: string, opts?: BrowserReadOptions): Promise<BrowserReadResult> {
      const signal = opts?.signal;
      if (signal?.aborted) throw new Error("读取被中断：用户停止了 turn");
      const r = ensure(sessionId);

      if (opts?.url) {
        const target = normalizeUrl(opts.url);
        // 先挂好监听再发起导航:loadURL 之后才订阅的话,
        // 快到离谱的本地页面(localhost 常见)可能在订阅前就 loaded 完了
        const settled = new Promise<void>((resolve, reject) => {
          let done = false;
          const finish = (fn: () => void) => {
            if (done) return;
            done = true;
            off();
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            fn();
          };
          const off = r.view.on((e) => {
            if (e.type === "loaded") finish(resolve);
            else if (e.type === "failed") {
              finish(() => reject(new Error(`页面加载失败：${e.errorDescription}（${e.errorCode}）: ${e.url}`)));
            }
          });
          const timer = setTimeout(
            () => finish(() => reject(new Error(`页面加载超时（${READ_TIMEOUT_MS / 1000}s）：${target}`))),
            READ_TIMEOUT_MS
          );
          const onAbort = () => finish(() => reject(new Error("读取被中断：用户停止了 turn")));
          signal?.addEventListener("abort", onAbort, { once: true });
        });
        delete r.lastError;
        await r.view.loadURL(target);
        await settled;
      }

      const raw = await r.view.executeJavaScript(EXTRACT_JS);
      let parsed: { title?: unknown; url?: unknown; text?: unknown };
      try {
        parsed = JSON.parse(String(raw)) as typeof parsed;
      } catch {
        throw new Error("读取页面失败：抽取脚本没有返回预期的 JSON");
      }
      if (typeof parsed.text !== "string" || typeof parsed.url !== "string") {
        throw new Error("读取页面失败：抽取脚本返回的形状不对");
      }
      const truncated = parsed.text.length > MAX_TEXT_CHARS;
      return {
        url: parsed.url,
        title: typeof parsed.title === "string" ? parsed.title : "",
        text: truncated ? parsed.text.slice(0, MAX_TEXT_CHARS) : parsed.text,
        truncated,
      };
    },
```

注意：`r.view.on(...)` 在这里是**第二个**订阅者。`fakeView` 的 `on` 只存一个回调，会把 hub 的常驻监听挤掉 —— 所以 `fakeView` 的 `on` 要改成支持多订阅：

```ts
  const subs = new Set<(e: BrowserViewEvent) => void>();
  // handle.on:
  on: (cb) => { subs.add(cb); return () => { subs.delete(cb); }; },
  // fire:
  fire: (e: BrowserViewEvent) => { for (const cb of [...subs]) cb(e); },
```

真适配层（Task 3 的 `createWebContentsViewHandle`）本来就是每次 `on()` 各挂各的监听器，天然支持多订阅，无需改动。

- [ ] **Step 4: 跑测试确认它绿**

Run: `npx vitest run tests/main/browserHub.test.ts`
Expected: PASS（15 + 9 = 24 个用例）

- [ ] **Step 5: 跑全量门禁 + Commit**

Run: `npm test`

```bash
git add src/main/browserHub.ts tests/main/browserHub.test.ts
git commit -m "feat(browser): hub.read —— 导航并抽正文

三条失败语义各自有测试兜着:加载失败抛、超时抛、中断抛且不伪装成
加载失败(ADR-0006)。返回假装成功的空字符串会让模型以为这页没内容,
比报错难查一个数量级。

抽取脚本直接用 innerText:它按渲染结果取文本,script/style 天然不在里面;
先克隆再删标签那种写法读出来恒为空串(游离节点没有 layout)。

监听先挂再导航:localhost 这种快到离谱的页面可能在订阅前就 loaded 完。"
```

---

### Task 6: browser_read 工具 + 注入 agent

**Files:**
- Create: `src/tools/browserRead.ts`
- Create: `tests/tools/browserRead.test.ts`
- Modify: `src/main/agent.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `ExecutionWorld.browser`（Task 1），`hub.read`（Task 5）
- Produces: `browserReadTool: Tool`；`createAgent` 新增可选参数 `makeBrowser?: (sessionId: string) => BrowserCapability`

- [ ] **Step 1: 写失败测试**

创建 `tests/tools/browserRead.test.ts`：

```ts
import { describe, it, expect, vi } from "vitest";
import { browserReadTool } from "../../src/tools/browserRead.js";
import type { ExecutionWorld, BrowserReadResult } from "../../src/world/executionWorld.js";

function worldWith(read: (o?: unknown) => Promise<BrowserReadResult>): ExecutionWorld {
  return {
    fs: { read: async () => "", write: async () => {} },
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    http: { postJson: async () => ({}) },
    browser: { read },
  };
}

const bare: ExecutionWorld = {
  fs: { read: async () => "", write: async () => {} },
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};

describe("browser_read 工具", () => {
  it("不审批 —— 纯读不落地,照 web_extract", () => {
    expect(browserReadTool.requiresApproval).toBe(false);
  });

  it("把 url 透传给 world.browser.read", async () => {
    const read = vi.fn(async () => ({ url: "https://a.com", title: "A", text: "正文", truncated: false }));
    const out = await browserReadTool.run({ url: "https://a.com" }, worldWith(read));
    expect(read).toHaveBeenCalledWith({ url: "https://a.com" });
    expect(String(out)).toContain("正文");
    expect(String(out)).toContain("https://a.com");
  });

  it("不给 url = 读当前页", async () => {
    const read = vi.fn(async () => ({ url: "https://cur.com", title: "当前", text: "内容", truncated: false }));
    await browserReadTool.run({}, worldWith(read));
    expect(read).toHaveBeenCalledWith({});
  });

  it("截断了要在输出里说 —— 不说的话模型会把半页当整页用", async () => {
    const read = async () => ({ url: "https://a.com", title: "A", text: "长", truncated: true });
    const out = String(await browserReadTool.run({}, worldWith(read)));
    expect(out).toContain("截断");
  });

  it("world 没有浏览器能力 = 抛,不静默返回空", async () => {
    await expect(browserReadTool.run({}, bare)).rejects.toThrow(/浏览器/);
  });

  it("url 不是 http(s) = 抛 —— file:// 能读到本机任意文件,不该由模型随口指定", async () => {
    const read = vi.fn(async () => ({ url: "", title: "", text: "", truncated: false }));
    await expect(browserReadTool.run({ url: "file:///etc/passwd" }, worldWith(read))).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it("底层抛什么就往上抛什么 —— 错误信息是给模型下一步决策用的", async () => {
    const read = async () => { throw new Error("页面加载失败：NAME_NOT_RESOLVED（-105）"); };
    await expect(browserReadTool.run({ url: "https://nope.invalid" }, worldWith(read)))
      .rejects.toThrow(/NAME_NOT_RESOLVED/);
  });
});
```

- [ ] **Step 2: 跑测试确认它红**

Run: `npx vitest run tests/tools/browserRead.test.ts`
Expected: FAIL —— 解析不到模块

- [ ] **Step 3: 写 src/tools/browserRead.ts**

```ts
// browser_read —— 读内置浏览器的当前页面。纯读不落地,不需要审批(同 web_extract)。
//
// 与 web_extract 的分工:web_extract 走第三方 API 抓公开网页的正文,便宜、无状态;
// 这个走用户自己的浏览器,能读登录态之后的页面、重度 JS 渲染的页面,以及 localhost。
//
// 只读:导航 + 抽正文,不点不打字。工具名里的 read 就是这条边界。

import type { Tool } from "./tool.js";

export const browserReadTool: Tool = {
  def: {
    name: "browser_read",
    description:
      "读内置浏览器页面的正文。给了 url 就先导航过去再读,不给就读用户当前正看的那一页。" +
      "它用的是用户自己的浏览器:能读需要登录的页面、重度 JS 渲染的页面,以及 localhost 上的本地服务。" +
      "公开网页的正文用 web_extract 更省;这个工具留给 web_extract 拿不到的场合。" +
      "导航会改变用户屏幕上正显示的那一页。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "要打开的 http(s) 网址。省略 = 读当前页面" },
      },
      required: [],
    },
  },
  requiresApproval: false,

  async run(args, world) {
    const { url } = (args ?? {}) as { url?: unknown };
    if (url !== undefined) {
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
        // file:// 能读到本机任意文件,不该由模型随口指定——要读文件有 read_file,
        // 那条路上有工作区围栏
        throw new Error("browser_read: 参数 url 必须是 http(s) 网址");
      }
    }
    if (!world.browser) {
      throw new Error("browser_read: 这个世界没有内置浏览器");
    }
    const r = await world.browser.read(url === undefined ? {} : { url });
    const head = `# ${r.title || "(无标题)"}\n${r.url}\n\n`;
    const tail = r.truncated ? "\n\n[正文超长已截断,以上不是全文]" : "";
    return head + r.text + tail;
  },
};
```

- [ ] **Step 4: 跑测试确认它绿**

Run: `npx vitest run tests/tools/browserRead.test.ts`
Expected: PASS（7 个用例）

- [ ] **Step 5: 注入 agent**

`src/main/agent.ts`：

1. 顶部 import：

```ts
import { browserReadTool } from "../tools/browserRead.js";
import { withBrowser, type BrowserCapability } from "../world/executionWorld.js";
```

2. `createAgent` 的 opts 里，`getAccessToken?` 后面加：

```ts
  /** 浏览器能力工厂(index.ts 注入,按 sessionId 绑到 browserHub)。
      不给 = 这个装配没有浏览器,browser_read 会明确报错(测试和裸装配照旧) */
  makeBrowser?: (sessionId: string) => BrowserCapability;
```

3. `const world = createLocalWorld({ root: opts.workspace });` 那行 —— 注意它在 `sessionId` 之后，可以直接用：

```ts
  // world 先于 approver：审批预览要借它的 fs 读旧文件（围栏天然生效）
  const base = createLocalWorld({ root: opts.workspace });
  // 浏览器能力从外面注入:WebContentsView 只有主进程造得出来,LocalWorld 造不出来
  // (与 openTerminal 的方向相反,见 ADR-0033)。工具照旧只认 world.browser
  const world = opts.makeBrowser ? withBrowser(base, opts.makeBrowser(sessionId)) : base;
```

4. `tools` 数组，`createWebExtractTool(...)` 后面加一行：

```ts
    browserReadTool,
```

- [ ] **Step 6: 在 index.ts 接上工厂**

搜 `createAgent({`（可能有多处：新建会话、resume），每一处的 opts 里加：

```ts
    makeBrowser: (sid) => ({ read: (o) => browsers.read(sid, o) }),
```

- [ ] **Step 7: 跑门禁**

Run: `npm test`
Expected: PASS。`tests/main/agent.test.ts` 若断言了工具表长度或名字列表，跟着更新（这是产品代码带出来的测试改动，L2 例行开发）。

Run: `npx tsc --noEmit -p tsconfig.json`

- [ ] **Step 8: 手动验收**

Run: `npm run dev`

1. 开面板，登录任意一个需要登录才能看内容的站（或就开 `localhost` 上的本地服务）
2. 关面板，回到聊天，让 otter：「用 browser_read 读一下当前页面」
3. 确认：返回的正文是登录后的内容；面板重开时停在那一页
4. 让 otter：「用 browser_read 打开 https://example.com 并总结」
5. 确认：面板重开后停在 example.com（agent 的导航改了人这块屏，这是设计如此）
6. 让 otter 读一个不存在的域名 → 时间线上是 error 结果，错误信息里有 errorCode
7. 中途点停止按钮打断一次正在加载的读 → 确认报的是「中断」不是「加载失败」

- [ ] **Step 9: Commit**

```bash
git add src/tools/browserRead.ts tests/tools/browserRead.test.ts src/main/agent.ts src/main/index.ts
git commit -m "feat(browser): browser_read 工具接上 world seam

与 web_extract 分工写进 description:公开网页走 web_extract(便宜、无状态),
登录态/JS 渲染/localhost 走这个。description 里明说导航会改变用户
屏幕上那一页——模型该知道自己这次调用是有旁观者的。

url 只收 http(s):file:// 能读到本机任意文件,不该由模型随口指定,
要读文件有 read_file,那条路上有工作区围栏。"
```

---

### Task 7: ADR + issue + PR

**Files:**
- Create: `docs/adr/0033-browser-rides-the-world-seam.md`

- [ ] **Step 1: 开 Task issue**

```bash
gh issue create --title "会话内置浏览器：人和 agent 共用一块屏" --body "$(cat <<'EOF'
人能在 Otto 里开网页、登录、看 localhost；agent 只读地导航并抽正文。

设计：`docs/superpowers/specs/2026-08-19-session-embedded-browser-design.md`
计划：`docs/superpowers/plans/2026-08-19-session-embedded-browser.md`

范围内：WebContentsView 面板、browserHub、browser_read 工具（只读）
范围外（YAGNI）：多标签、agent 点击/输入、Readability、每会话 cookie 隔离
EOF
)"
```

- [ ] **Step 2: 写 ADR**

创建 `docs/adr/0033-browser-rides-the-world-seam.md`。注意编号：`docs/adr/` 里 0031 已经撞号（terminal 与 thinking 各一份），本次不顺手改别人的编号，直接走 0033。

内容要点（照既有 ADR 的格式：背景 / 决策 / 后果）：

- **决策一：WebContentsView 而非 `<webview>` 标签。** agent 侧要走 ExecutionWorld seam，主进程直接持有 webContents 才是直路；webview 要绕 `did-attach-webview`。代价是它浮在 React 之上，矩形要同步、弹窗盖不住它。
- **决策二：注入方向与终端相反。** 终端是 hub 去调 `agent.world.openTerminal`（pty 是 LocalWorld 自己能干的活）；浏览器是 hub 造好能力反过来 `withBrowser` 注入进 world（WebContentsView 只有主进程 + 窗口造得出来）。seam 仍然成立 —— 工具只认 `world.browser`。v2 SandboxWorld 若自带浏览器，注入这条线自然退场。
- **决策三：人的浏览不进事件日志**，ADR-0031 的直接延伸；agent 的 `browser_read` 是工具调用，照旧落盘。
- **决策四：`browser_read` 不审批**，照 `web_extract`。明记代价：它带着用户登录 cookie，且够得着 localhost 和内网。改主意的改动面 = 一个 `requiresApproval` 字段 + 一段审批预览文案。
- **决策五：全局持久 partition `persist:otto-browser`**，登录一次全局可用；代价是会话之间没有凭据隔离墙，v2 Docker 时按 bot 分家。

- [ ] **Step 3: 门禁 + 开 PR**

Run: `npm test`

```bash
git add docs/adr/0033-browser-rides-the-world-seam.md
git commit -m "docs(adr): 0033 浏览器骑 world seam

记五个决定,其中两个是本次真正的分叉点:注入方向与终端相反(WebContentsView
只有主进程造得出来),以及 browser_read 不审批的代价(带着登录 cookie、
够得着内网)——后者写进 ADR 是为了将来改主意时有账可查。"
git push -u origin HEAD
gh pr create --fill
```

PR 描述里带上 `Closes #<issue 号>`。CI 绿了自己合（merge commit，不 squash 不 rebase）。

---

## Self-Review

**Spec 覆盖核对：**

| Spec 章节 | 落在哪个 Task |
|---|---|
| 二、WebContentsView 路线 | Task 3（适配层） |
| 三、模块与边界（5 个新文件） | Task 1 / 2 / 3 / 4 / 6 |
| 三、三条硬边界 | Task 1（seam）、Task 2（不 import electron）、Task 4（渲染层只经 bridge） |
| 三、登录态 partition | Task 3 Step 1 |
| 三、事件日志 | 无代码改动（不落日志 = 不接 store）；写进 Task 7 的 ADR |
| 四、人这一侧数据流 | Task 2 + Task 4 |
| 四、agent 这一侧数据流 | Task 5 + Task 6 |
| 四、懒创建 + browserOpen 幂等 | Task 2 Step 1（前两条测试） |
| 五、后来者赢 / 失败即抛 / 中断即 reject | Task 2（后来者赢）、Task 5（另两条） |
| 六、不审批 | Task 6 Step 1（第一条测试） |
| 七、测试 | Task 1 / 2 / 5 / 6 各自的测试步；渲染层那条见「与 Spec 的三处偏差」第 3 点 |
| 八、落地顺序 | Task 1→6 即是（spec 的第 3 步拆成了 Task 3 + Task 4：适配层和 UI 是两个能被分别否掉的东西） |
| 九、协议动作 | Task 7 |
| 十、明确不做 | 无 Task（就是不做）；写进 issue 正文 |

无遗漏。

**占位符扫描：** 无 TBD / TODO / "similar to Task N" / "add error handling"。每个代码步都是可直接粘贴的完整内容。唯一没给逐字代码的是 Task 7 的 ADR 正文（给了五条要点 + 既有格式指引）—— ADR 是论证文字，逐字写死反而会让实现者照抄一份和实际代码对不上的东西。

**类型一致性核对：**

- `BrowserTabInfo` 字段（Task 1 定义）→ Task 2 的 `snapshot()` 逐字段构造 ✓ → Task 4 组件读 `canGoBack` / `loading` / `lastError` / `url` ✓
- `BrowserBounds` → Task 2 `setBounds` / Task 3 适配层 / Task 4 `rectToBounds` 返回值 ✓
- `BrowserViewHandle` 十二个方法 → Task 2 的 `fakeView` 全部实现 ✓ → Task 3 的真适配层全部实现 ✓
- `BrowserReadResult { url, title, text, truncated }` → Task 5 返回 ✓ → Task 6 工具读这四个字段 ✓
- `BrowserCapability.read(opts?)` → Task 1 定义 → Task 6 工具调 `world.browser.read({url})` ✓ → Task 6 Step 6 的 `makeBrowser` 返回 `{ read: (o) => browsers.read(sid, o) }`，与 `hub.read(sessionId, opts?)` 签名对齐 ✓
- `withBrowser` → Task 1 定义、Task 6 使用 ✓
- CHANNELS 八个键 → Task 1 定义、Task 3 全部 handle（七个 invoke + 一个 send）✓
- 一处需要实现者留意（已在 Task 5 Step 3 写明）：`fakeView.on` 必须支持多订阅，否则 `read()` 的临时监听会挤掉 hub 的常驻监听 —— 这是 Task 2 的假件在 Task 5 才暴露出的不足，改动写在 Task 5 里。
