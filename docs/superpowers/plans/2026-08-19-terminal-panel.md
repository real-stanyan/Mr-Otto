# 会话内嵌 Terminal 面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Otto 会话里内嵌一个真 PTY 终端面板：用户自己敲命令、跑 `npm run dev`、Ctrl-C，输出与 agent 完全隔离。

**Architecture:** 终端能力作为可选面挂在 `ExecutionWorld` 上（v2 容器化时用户终端自动落进 bot 的容器）；主进程 `terminalHub` 持有 pty 注册表与回滚缓冲（关面板不杀进程的兑现物）；渲染层复用现成的右侧面板槽位，xterm 实例缓存在模块级 registry，组件卸载不 dispose。终端输出既不落事件日志也不进模型上下文。

**Tech Stack:** node-pty 1.1.0（主进程原生模块）· @xterm/xterm 6.0.0 + @xterm/addon-fit 0.11.0（渲染层）· Electron 43 · React 19 + Zustand · vitest

**依据文档：** `docs/superpowers/specs/2026-08-19-terminal-panel-design.md` · ADR-0031 · issue #107

## Global Constraints

- 依赖版本锁死：`node-pty@1.1.0`、`@xterm/xterm@6.0.0`、`@xterm/addon-fit@0.11.0`，三者都进 `dependencies`（不是 devDependencies —— `externalizeDepsPlugin()` 只把 `dependencies` 里的东西标 external，放错地方 node-pty 会被打进 bundle 而原生 `.node` 没法 bundle）。
- **`node-pty` 只允许在 `src/world/localWorld.ts` 里出现**，且必须是函数内的动态 `await import("node-pty")`，不能是顶层 import（顶层 import 会让所有跑到 localWorld 的 vitest 用例都依赖原生模块能在 Node ABI 下加载，`electron-rebuild` 之后就会集体炸）。其它任何文件 import 它 = 违反 AGENTS.md 硬规则。
- TypeScript strict。测试统一放 `tests/`，镜像 `src/` 结构，不与源码同目录。
- 门禁：`npm test`（当前基线 753 passed，必须保持全绿）。
- 注释写「为什么」，中文，与既有文件同一副嗓子（看 `localWorld.ts` / `rendererPush.ts` 的写法）。
- 终端输出**不得**出现在任何 `SessionEvent`、任何工具返回值、任何喂给模型的字符串里（ADR-0031）。
- 每个 task 结束时 `npm test` 必须全绿再 commit。

---

### Task 1: `ExecutionWorld` 长出终端这一面

**Files:**
- Modify: `src/world/executionWorld.ts`
- Modify: `package.json`（依赖 + `rebuild-native` 脚本）
- Test: `tests/world/executionWorld.test.ts`（新建）

**Interfaces:**
- Consumes: 无（第一个 task）
- Produces: `TerminalSession`、`OpenTerminalOptions`、`ExecutionWorld.openTerminal?`。后续 task 全部依赖这三个名字。

- [ ] **Step 1: 装依赖**

```bash
npm i node-pty@1.1.0 @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0
```

装完确认三个都落在 `package.json` 的 `dependencies` 里（`npm i` 默认如此；若不是，手动挪过去）。

- [ ] **Step 2: `rebuild-native` 带上 node-pty**

`package.json` 的 scripts 里，把

```json
"rebuild-native": "electron-rebuild -f -w better-sqlite3",
```

改成

```json
"rebuild-native": "electron-rebuild -f -w better-sqlite3 -w node-pty",
```

- [ ] **Step 3: 写失败的测试**

新建 `tests/world/executionWorld.test.ts`：

```ts
import { describe, it, expect, vi } from "vitest";
import {
  withAbortSignal,
  withExecOutput,
  type ExecutionWorld,
  type TerminalSession,
} from "../../src/world/executionWorld.js";

/** 最小假 world：只关心装饰器有没有把字段原样带过去 */
function fakeWorld(openTerminal?: ExecutionWorld["openTerminal"]): ExecutionWorld {
  return {
    fs: { read: async () => "", write: async () => {} },
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    http: { postJson: async () => ({}) },
    ...(openTerminal ? { openTerminal } : {}),
  };
}

const fakeSession = (): TerminalSession => ({
  write: () => {},
  resize: () => {},
  kill: () => {},
  onData: () => () => {},
  onExit: () => () => {},
});

describe("装饰器透传 openTerminal", () => {
  it("withAbortSignal 保住终端能力", async () => {
    const open = vi.fn(async () => fakeSession());
    const wrapped = withAbortSignal(fakeWorld(open), new AbortController().signal);
    expect(wrapped.openTerminal).toBeTypeOf("function");
    await wrapped.openTerminal!({ cols: 80, rows: 24 });
    expect(open).toHaveBeenCalledWith({ cols: 80, rows: 24 });
  });

  it("withExecOutput 保住终端能力", async () => {
    const open = vi.fn(async () => fakeSession());
    const wrapped = withExecOutput(fakeWorld(open), () => {});
    expect(wrapped.openTerminal).toBeTypeOf("function");
    await wrapped.openTerminal!({ cols: 100, rows: 30 });
    expect(open).toHaveBeenCalledWith({ cols: 100, rows: 30 });
  });

  it("世界本来就没有终端能力时，装饰后依然没有（不凭空造一个）", () => {
    const wrapped = withAbortSignal(fakeWorld(), new AbortController().signal);
    expect(wrapped.openTerminal).toBeUndefined();
  });
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `npx vitest run tests/world/executionWorld.test.ts`
Expected: FAIL —— `TerminalSession` 类型不存在 / `wrapped.openTerminal` 是 undefined。

- [ ] **Step 5: 实现接口与透传**

在 `src/world/executionWorld.ts` 里，`ExecutionWorld` 接口之前加：

```ts
/** 一个活着的交互终端（PTY）。与 exec 的一次性命令是两回事：
    它有生命周期、双向流、窗口尺寸。纯人用——agent 看不见它（ADR-0031） */
export interface TerminalSession {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /** 返回退订函数（与 ShellBridge 的订阅同构） */
  onData(cb: (data: string) => void): () => void;
  onExit(cb: (exitCode: number) => void): () => void;
}

export interface OpenTerminalOptions {
  cols: number;
  rows: number;
  /** 缺省 = $SHELL，再缺省 = /bin/zsh */
  shell?: string;
}
```

`ExecutionWorld` 接口末尾加一个可选成员：

```ts
  /** 可选：这个世界开不开得了交互终端。
      可选 = 向后兼容（旧实现和测试里的假 world 零改动，同 ExecOptions 的先例）；
      缺这个字段 = 该世界没有终端能力，UI 据此不显示入口。
      v2 SandboxWorld 把它实现成 docker exec，用户终端自动落进那个 bot 的容器 */
  openTerminal?(opts: OpenTerminalOptions): Promise<TerminalSession>;
```

两个装饰器都是手写字段拷贝，各补一行（**这正是最容易静默丢能力的地方，上面那三条测试就是钉子**）：

`withAbortSignal` 的返回对象里加：

```ts
    ...(world.openTerminal ? { openTerminal: (o: OpenTerminalOptions) => world.openTerminal!(o) } : {}),
```

`withExecOutput` 的返回对象里加同样一行。

注意用条件展开而不是无脑 `openTerminal: world.openTerminal`：后者会在源 world 没有这个能力时留下一个 `undefined` 值的属性，`"openTerminal" in world` 之类的探测就会说谎。

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/world/executionWorld.test.ts`
Expected: PASS（3 passed）

- [ ] **Step 7: 跑全量门禁**

Run: `npm test`
Expected: 全绿（756 passed）

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/world/executionWorld.ts tests/world/executionWorld.test.ts
git commit -m "$(cat <<'EOF'
feat(world): ExecutionWorld 长出终端这一面

可选字段而非必选:旧实现和测试里的假 world 零改动(同 ExecOptions 先例)。
两个装饰器是手写字段拷贝,加字段不同步改就会静默丢掉终端能力——
三条测试钉住这件事,不是为了覆盖率。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: LocalWorld 用 node-pty 兑现终端 + 打包实测

**Files:**
- Modify: `src/world/localWorld.ts`
- Test: `tests/world/localWorldTerminal.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `TerminalSession` / `OpenTerminalOptions`
- Produces: `createLocalWorld({root}).openTerminal(opts)` —— Task 3 的 hub 靠它开进程

**这是全计划唯一的真风险点。** 若 Step 7 的打包实测过不了，停下来向维护者报告，走 spec 里写的回退方案（无 PTY 的管道面板），不要带着未验证的原生依赖继续往下写 UI。

- [ ] **Step 1: 写失败的测试**

新建 `tests/world/localWorldTerminal.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalWorld } from "../../src/world/localWorld.js";

// node-pty 是原生模块:跑过 electron-rebuild 之后它只认 Electron 的 ABI,
// Node 侧的 vitest 就加载不了了(better-sqlite3 同款处境)。
// 那种情况下跳过这一组,而不是让门禁变红——门禁该测的是我们的代码,
// 不是"此刻装的这份原生模块编给了谁"。假 pty 的单测(Task 3)照常保护逻辑。
const ptyLoadable = await import("node-pty").then(() => true).catch(() => false);

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "otter-pty-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(!ptyLoadable)("LocalWorld.openTerminal（真 PTY）", () => {
  it("跑一条命令，拿得到输出和退出码", async () => {
    const world = createLocalWorld({ root });
    const term = await world.openTerminal!({ cols: 80, rows: 24, shell: "/bin/sh" });

    let out = "";
    term.onData((d) => { out += d; });
    const exited = new Promise<number>((resolve) => term.onExit(resolve));

    term.write("echo otter-pty-ok\n");
    term.write("exit\n");

    const code = await exited;
    expect(out).toContain("otter-pty-ok");
    expect(code).toBe(0);
  }, 15_000);

  it("cwd 是工程文件夹", async () => {
    const world = createLocalWorld({ root });
    const term = await world.openTerminal!({ cols: 80, rows: 24, shell: "/bin/sh" });
    let out = "";
    term.onData((d) => { out += d; });
    const exited = new Promise<number>((resolve) => term.onExit(resolve));
    term.write("pwd\nexit\n");
    await exited;
    // macOS 的 /var 是 /private/var 的软链,tmpdir 两种写法都可能出现
    expect(out).toContain(root.replace(/^\/private/, ""));
  }, 15_000);

  it("kill 杀得掉常驻进程", async () => {
    const world = createLocalWorld({ root });
    const term = await world.openTerminal!({ cols: 80, rows: 24, shell: "/bin/sh" });
    const exited = new Promise<number>((resolve) => term.onExit(resolve));
    term.write("sleep 60\n");
    term.kill();
    await expect(exited).resolves.toBeTypeOf("number");
  }, 15_000);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/world/localWorldTerminal.test.ts`
Expected: FAIL —— `world.openTerminal is not a function`。

- [ ] **Step 3: 实现 `openTerminal`**

在 `src/world/localWorld.ts` 里，`http` 那块之后、`createLocalWorld` 返回对象内追加：

```ts
    async openTerminal(o): Promise<TerminalSession> {
      // 动态 import:node-pty 是原生模块,顶层 import 会让每个碰到 localWorld 的
      // 测试都必须能在当前 ABI 下加载它(electron-rebuild 之后就加载不了)。
      // 终端是低频入口,晚一点加载零代价。
      const pty = await import("node-pty");
      const spawn = (pty as unknown as { default?: typeof pty }).default?.spawn ?? pty.spawn;
      const shell = o.shell ?? process.env.SHELL ?? "/bin/zsh";
      const child = spawn(shell, [], {
        name: "xterm-256color",
        cols: o.cols,
        rows: o.rows,
        ...(root ? { cwd: root } : {}),
        // TERM 让 CLI 上色;其余原样继承——用户的 PATH/nvm/别名都在里面,
        // 剥干净了这个终端就不是"他自己的终端"了
        env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
      });
      return {
        write: (data) => child.write(data),
        resize: (cols, rows) => child.resize(cols, rows),
        // 已经死掉的进程再 kill 会抛;终端关闭路径上这是常态,不是错误
        kill: () => { try { child.kill(); } catch { /* 已经死了 */ } },
        onData: (cb) => { const d = child.onData(cb); return () => d.dispose(); },
        onExit: (cb) => { const d = child.onExit(({ exitCode }) => cb(exitCode)); return () => d.dispose(); },
      };
    },
```

顶部 import 补类型（**只补类型，不补 node-pty**）：

```ts
import type { ExecutionWorld, ExecResult, TerminalSession } from "./executionWorld.js";
```

文件头注释那句「整个项目里唯一允许 import node:fs / child_process 的地方」后面补一句：

```
// node-pty 同理：只在这里 import（动态），别处一律经 ExecutionWorld.openTerminal。
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/world/localWorldTerminal.test.ts`
Expected: PASS（3 passed）。若显示 skipped，说明当前装的 node-pty 不是 Node ABI —— 先 `npm i` 重装再跑一次，确认能真跑过。

- [ ] **Step 5: 跑全量门禁**

Run: `npm test`
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add src/world/localWorld.ts tests/world/localWorldTerminal.test.ts
git commit -m "$(cat <<'EOF'
feat(world): LocalWorld 用 node-pty 兑现 openTerminal

动态 import 而不是顶层:原生模块顶层 import 会把"能不能加载 node-pty"
变成所有 localWorld 测试的前置条件,electron-rebuild 之后集体炸。

env 原样继承宿主:剥干净了 PATH/nvm/别名都没了,这个终端就不是用户自己的终端。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: 打包实测（风险闸门，必须做）**

```bash
npm run rebuild-native && npm run dist:mac
```

打完包，打开 `dist/mac-arm64/Mr Otto.app`，确认 app 能正常启动（此时还没有终端 UI，验的是原生模块跟进包没把 app 打崩）。再确认 `.app` 里带上了 pty 的原生产物：

```bash
find "dist/mac-arm64/Mr Otto.app" -name "*.node" | grep -i pty
```

Expected: 至少一条命中。

**命中不了或 app 起不来 = 停在这里**，把现象报给维护者，走回退方案，不要继续 Task 3。

验完记得 `npm i` 把原生模块还原成 Node ABI，否则后续 `npm test` 会红。

---

### Task 3: 主进程 `terminalHub`

**Files:**
- Create: `src/main/terminalHub.ts`
- Test: `tests/main/terminalHub.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `TerminalSession` / `OpenTerminalOptions`
- Produces:
  - `createTerminalHub(deps: TerminalHubDeps): TerminalHub`
  - `TerminalInfo = { id: string; title: string; exited: boolean }`
  - `TerminalHub` 方法：`open(sessionId, workspace, cols, rows) => Promise<{id, snapshot}>`、`attach(id) => {snapshot}`、`list(sessionId) => TerminalInfo[]`、`input(id, data) => void`、`resize(id, cols, rows) => void`、`close(id) => void`、`killSession(sessionId) => void`、`killAll() => void`
  - Task 4 的 IPC 层逐条转发这些方法。

- [ ] **Step 1: 写失败的测试**

新建 `tests/main/terminalHub.test.ts`：

```ts
import { describe, it, expect, vi } from "vitest";
import { createTerminalHub } from "../../src/main/terminalHub.js";
import type { TerminalSession } from "../../src/world/executionWorld.js";

/** 假 pty：能被写入、能被外部驱动着吐输出、能被杀 */
function fakePty() {
  let onData: ((d: string) => void) | null = null;
  let onExit: ((c: number) => void) | null = null;
  const written: string[] = [];
  const resized: Array<[number, number]> = [];
  let killed = false;
  const session: TerminalSession = {
    write: (d) => { written.push(d); },
    resize: (c, r) => { resized.push([c, r]); },
    kill: () => { killed = true; onExit?.(0); },
    onData: (cb) => { onData = cb; return () => { onData = null; }; },
    onExit: (cb) => { onExit = cb; return () => { onExit = null; }; },
  };
  return {
    session,
    emit: (d: string) => onData?.(d),
    die: (code: number) => onExit?.(code),
    get written() { return written; },
    get resized() { return resized; },
    get killed() { return killed; },
  };
}

function makeHub(opts: { bufferBytes?: number; maxPerSession?: number } = {}) {
  const ptys: ReturnType<typeof fakePty>[] = [];
  const data = vi.fn();
  const exit = vi.fn();
  const hub = createTerminalHub({
    openTerminal: async () => {
      const p = fakePty();
      ptys.push(p);
      return p.session;
    },
    push: { data, exit },
    ...opts,
  });
  return { hub, ptys, data, exit };
}

describe("terminalHub 注册表", () => {
  it("开出来的终端能在本会话列到", async () => {
    const { hub } = makeHub();
    const { id } = await hub.open("s1", "/tmp/w", 80, 24);
    expect(hub.list("s1").map((t) => t.id)).toEqual([id]);
  });

  it("会话隔离：A 会话列不到 B 会话的终端", async () => {
    const { hub } = makeHub();
    await hub.open("s1", "/tmp/w", 80, 24);
    await hub.open("s2", "/tmp/w", 80, 24);
    expect(hub.list("s1")).toHaveLength(1);
    expect(hub.list("s2")).toHaveLength(1);
  });

  it("标题带序号，人能分清哪个是哪个", async () => {
    const { hub } = makeHub();
    await hub.open("s1", "/tmp/w", 80, 24);
    await hub.open("s1", "/tmp/w", 80, 24);
    expect(hub.list("s1").map((t) => t.title)).toEqual(["终端 1", "终端 2"]);
  });

  it("每会话上限 8，第 9 个报人话错误", async () => {
    const { hub } = makeHub({ maxPerSession: 2 });
    await hub.open("s1", "/tmp/w", 80, 24);
    await hub.open("s1", "/tmp/w", 80, 24);
    await expect(hub.open("s1", "/tmp/w", 80, 24)).rejects.toThrow(/最多/);
  });
});

describe("terminalHub 直播与缓冲", () => {
  it("pty 的输出推给渲染层，同时进缓冲", async () => {
    const { hub, ptys, data } = makeHub();
    const { id } = await hub.open("s1", "/tmp/w", 80, 24);
    ptys[0].emit("hello");
    expect(data).toHaveBeenCalledWith(id, "hello");
    expect(hub.attach(id).snapshot).toBe("hello");
  });

  it("缓冲只留尾部：超上限后开头被丢掉", async () => {
    const { hub, ptys } = makeHub({ bufferBytes: 10 });
    const { id } = await hub.open("s1", "/tmp/w", 80, 24);
    ptys[0].emit("aaaaaaaaaa"); // 10
    ptys[0].emit("bbbbb");      // 再 5，总 15 > 10
    const snap = hub.attach(id).snapshot;
    expect(snap.length).toBeLessThanOrEqual(10);
    expect(snap.endsWith("bbbbb")).toBe(true);
  });

  it("attach 拿的是快照，不重放给别人；新开的终端快照是空的", async () => {
    const { hub } = makeHub();
    const { id, snapshot } = await hub.open("s1", "/tmp/w", 80, 24);
    expect(snapshot).toBe("");
    expect(hub.attach(id).snapshot).toBe("");
  });

  it("认不出的 id：attach 抛错，input/resize/close 静默无视", async () => {
    const { hub } = makeHub();
    expect(() => hub.attach("nope")).toThrow(/终端不存在/);
    expect(() => hub.input("nope", "x")).not.toThrow();
    expect(() => hub.resize("nope", 1, 1)).not.toThrow();
    expect(() => hub.close("nope")).not.toThrow();
  });
});

describe("terminalHub 转发输入", () => {
  it("input / resize 转给对应的 pty", async () => {
    const { hub, ptys } = makeHub();
    const { id } = await hub.open("s1", "/tmp/w", 80, 24);
    hub.input(id, "ls\n");
    hub.resize(id, 120, 40);
    expect(ptys[0].written).toEqual(["ls\n"]);
    expect(ptys[0].resized).toEqual([[120, 40]]);
  });
});

describe("terminalHub 生命周期", () => {
  it("进程自己死掉：推 exit、标记 exited，缓冲还留着给人看遗言", async () => {
    const { hub, ptys, exit } = makeHub();
    const { id } = await hub.open("s1", "/tmp/w", 80, 24);
    ptys[0].emit("boom");
    ptys[0].die(1);
    expect(exit).toHaveBeenCalledWith(id, 1);
    expect(hub.list("s1")[0].exited).toBe(true);
    expect(hub.attach(id).snapshot).toBe("boom");
  });

  it("close 杀进程并摘出注册表", async () => {
    const { hub, ptys } = makeHub();
    const { id } = await hub.open("s1", "/tmp/w", 80, 24);
    hub.close(id);
    expect(ptys[0].killed).toBe(true);
    expect(hub.list("s1")).toHaveLength(0);
  });

  it("killSession 只杀该会话名下的", async () => {
    const { hub, ptys } = makeHub();
    await hub.open("s1", "/tmp/w", 80, 24);
    await hub.open("s2", "/tmp/w", 80, 24);
    hub.killSession("s1");
    expect(ptys[0].killed).toBe(true);
    expect(ptys[1].killed).toBe(false);
    expect(hub.list("s1")).toHaveLength(0);
    expect(hub.list("s2")).toHaveLength(1);
  });

  it("killAll 全杀（app 退出不留孤儿 dev server）", async () => {
    const { hub, ptys } = makeHub();
    await hub.open("s1", "/tmp/w", 80, 24);
    await hub.open("s2", "/tmp/w", 80, 24);
    hub.killAll();
    expect(ptys.every((p) => p.killed)).toBe(true);
    expect(hub.list("s1")).toHaveLength(0);
    expect(hub.list("s2")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/main/terminalHub.test.ts`
Expected: FAIL —— 模块 `src/main/terminalHub.ts` 不存在。

- [ ] **Step 3: 实现 hub**

新建 `src/main/terminalHub.ts`：

```ts
// terminalHub — 主进程的 pty 注册表。
//
// 为什么缓冲在这儿而不在渲染层:产品前提是"关面板不杀进程"。面板一关,
// 渲染层的 xterm 实例就没了,而 pty 还在吐输出——得有人接住,重开面板时
// 一次性灌回去,用户看到的才是连续的。放渲染层等于没放。
//
// 终端输出不进事件日志、不进模型上下文(ADR-0031):它不是某个事实的投影,
// 是人的旁路工具。日志推不出它,也不需要推出它。

import { randomUUID } from "node:crypto";
import type { OpenTerminalOptions, TerminalSession } from "../world/executionWorld.js";

/** 渲染层看得见的终端形态(标签行用) */
export interface TerminalInfo {
  id: string;
  title: string;
  /** 进程已经退了。标签还留着——遗言得让人看得见,是用户点 × 才消失 */
  exited: boolean;
}

export interface TerminalHubDeps {
  /** 由 index.ts 注入(内部走 LocalWorld.openTerminal)。注入而非直接 import:
      测试要能塞假 pty,v2 要能换成容器世界 */
  openTerminal(workspace: string, opts: OpenTerminalOptions): Promise<TerminalSession>;
  push: {
    data(id: string, data: string): void;
    exit(id: string, exitCode: number): void;
  };
  /** 每会话标签上限,防手滑刷出一堆 shell。缺省 8 */
  maxPerSession?: number;
  /** 每终端回滚缓冲字节数,缺省 200 KB */
  bufferBytes?: number;
}

interface Record_ {
  id: string;
  sessionId: string;
  title: string;
  session: TerminalSession;
  chunks: string[];
  size: number;
  exited: boolean;
  /** 退订函数,close 时解掉——pty 死了还挂着监听器就是泄漏 */
  offs: Array<() => void>;
}

export function createTerminalHub(deps: TerminalHubDeps) {
  const maxPerSession = deps.maxPerSession ?? 8;
  const bufferBytes = deps.bufferBytes ?? 200_000;
  const terms = new Map<string, Record_>();

  const ofSession = (sessionId: string) =>
    [...terms.values()].filter((t) => t.sessionId === sessionId);

  /** 环形缓冲:整段整段地丢最老的,丢到总量落回上限内。
      按 chunk 丢会让快照从半个转义序列开始,xterm 会渲出乱码,
      所以最后一段还要按字符裁 */
  const remember = (rec: Record_, data: string) => {
    rec.chunks.push(data);
    rec.size += data.length;
    while (rec.size > bufferBytes && rec.chunks.length > 1) {
      rec.size -= rec.chunks.shift()!.length;
    }
    if (rec.size > bufferBytes) {
      const only = rec.chunks[0]!.slice(rec.size - bufferBytes);
      rec.chunks = [only];
      rec.size = only.length;
    }
  };

  const drop = (rec: Record_) => {
    for (const off of rec.offs) off();
    rec.offs = [];
    rec.session.kill();
    terms.delete(rec.id);
  };

  return {
    async open(sessionId: string, workspace: string, cols: number, rows: number) {
      const mine = ofSession(sessionId);
      if (mine.length >= maxPerSession) {
        throw new Error(`一个会话最多开 ${maxPerSession} 个终端，先关掉一个再开`);
      }
      const id = randomUUID();
      const session = await deps.openTerminal(workspace, { cols, rows });
      const rec: Record_ = {
        id,
        sessionId,
        title: `终端 ${mine.length + 1}`,
        session,
        chunks: [],
        size: 0,
        exited: false,
        offs: [],
      };
      rec.offs.push(
        session.onData((d) => {
          remember(rec, d);
          deps.push.data(id, d);
        }),
        session.onExit((code) => {
          rec.exited = true;
          deps.push.exit(id, code);
        })
      );
      terms.set(id, rec);
      return { id, snapshot: "" };
    },

    attach(id: string) {
      const rec = terms.get(id);
      if (!rec) throw new Error("终端不存在（可能已经关掉了）");
      return { snapshot: rec.chunks.join("") };
    },

    list(sessionId: string): TerminalInfo[] {
      return ofSession(sessionId).map((t) => ({ id: t.id, title: t.title, exited: t.exited }));
    },

    // 下面三个对未知 id 静默无视:渲染层的键盘事件和 resize 可能比
    // "终端已经关了"这个消息跑得快,为一次竞态抛错没有意义
    input(id: string, data: string) {
      terms.get(id)?.session.write(data);
    },
    resize(id: string, cols: number, rows: number) {
      terms.get(id)?.session.resize(cols, rows);
    },
    close(id: string) {
      const rec = terms.get(id);
      if (rec) drop(rec);
    },

    /** 会话被删 = 它名下的终端一起走(ADR-0002 的物理抹除延伸到进程) */
    killSession(sessionId: string) {
      for (const rec of ofSession(sessionId)) drop(rec);
    },

    /** app 退出。孤儿 dev server 占着端口而没人知道是谁占的,是最难查的一类问题 */
    killAll() {
      for (const rec of [...terms.values()]) drop(rec);
    },
  };
}

export type TerminalHub = ReturnType<typeof createTerminalHub>;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/main/terminalHub.test.ts`
Expected: PASS（13 passed）

- [ ] **Step 5: 跑全量门禁**

Run: `npm test`
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add src/main/terminalHub.ts tests/main/terminalHub.test.ts
git commit -m "$(cat <<'EOF'
feat(main): terminalHub —— pty 注册表 + 回滚缓冲

缓冲放主进程是因为产品前提是"关面板不杀进程":面板一关 xterm 实例就没了,
pty 还在吐,得有人接住。放渲染层等于没放。

killSession / killAll 不是收尾洁癖:孤儿 dev server 占着端口而没人知道
是谁占的,是最难查的一类问题。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: ShellBridge 新面 + IPC 接线

**Files:**
- Modify: `src/shared/shellBridge.ts`（类型 + `CHANNELS`）
- Modify: `src/preload/index.ts`
- Modify: `src/main/index.ts`
- Test: 无新增自动测试（纯接线层，逻辑已在 Task 3 覆盖）；门禁靠 `npm test` 保持全绿 + Step 6 的手动 smoke。

**Interfaces:**
- Consumes: Task 3 的 `createTerminalHub` / `TerminalInfo`
- Produces: `window.otter.terminalList / terminalOpen / terminalAttach / terminalInput / terminalResize / terminalClose`、`onTerminalData` / `onTerminalExit` —— Task 5 的 UI 全靠它们

- [ ] **Step 1: `shellBridge.ts` 加类型与频道**

顶部 import 区加：

```ts
import type { TerminalInfo } from "../main/terminalHub.js";
```

（纯类型 import，不会把主进程模块拖进渲染层 bundle —— 与文件里既有的 `SessionSummary` 同款做法。）

`export type { SessionSummary };` 旁边加一行：

```ts
export type { TerminalInfo };
```

`ShellBridge` 接口里，`gitStatus` 之后插入：

```ts
  /** 本会话已开的终端(标签行用)。终端不进事件日志——它不是投影,是人的旁路工具(ADR-0031) */
  terminalList(sessionId: string): Promise<TerminalInfo[]>;
  /** 新开一个终端(cwd = 会话的工程文件夹)。snapshot 恒为空串,形状与 attach 对齐 */
  terminalOpen(sessionId: string, cols: number, rows: number): Promise<{ id: string; snapshot: string }>;
  /** 接上已有终端,拿回滚缓冲一次性灌进 xterm(这就是"关面板不杀进程"给用户的兑现) */
  terminalAttach(id: string): Promise<{ snapshot: string }>;
  /** 键盘输入透传给 pty */
  terminalInput(id: string, data: string): Promise<void>;
  /** 面板拖拽/展开后同步窗口尺寸 */
  terminalResize(id: string, cols: number, rows: number): Promise<void>;
  /** 关标签 = 杀进程,不可逆 */
  terminalClose(id: string): Promise<void>;
```

订阅区（`onToolOutput` 附近）加：

```ts
  onTerminalData(cb: (chunk: { id: string; data: string }) => void): Unsubscribe;
  onTerminalExit(cb: (info: { id: string; exitCode: number }) => void): Unsubscribe;
```

`CHANNELS` 里（`gitStatus` 附近）加：

```ts
  terminalList: "otter:terminalList",
  terminalOpen: "otter:terminalOpen",
  terminalAttach: "otter:terminalAttach",
  terminalInput: "otter:terminalInput",
  terminalResize: "otter:terminalResize",
  terminalClose: "otter:terminalClose",
  terminalData: "otter:terminalData",
  terminalExit: "otter:terminalExit",
```

- [ ] **Step 2: preload 转发**

`src/preload/index.ts` 的 `bridge` 对象里，`gitStatus` 那行之后加：

```ts
  terminalList: (sessionId) => ipcRenderer.invoke(CHANNELS.terminalList, sessionId),
  terminalOpen: (sessionId, cols, rows) => ipcRenderer.invoke(CHANNELS.terminalOpen, sessionId, cols, rows),
  terminalAttach: (id) => ipcRenderer.invoke(CHANNELS.terminalAttach, id),
  terminalInput: (id, data) => ipcRenderer.invoke(CHANNELS.terminalInput, id, data),
  terminalResize: (id, cols, rows) => ipcRenderer.invoke(CHANNELS.terminalResize, id, cols, rows),
  terminalClose: (id) => ipcRenderer.invoke(CHANNELS.terminalClose, id),
```

订阅区（`onToolOutput` 那行之后）加：

```ts
  onTerminalData: subscribe(CHANNELS.terminalData),
  onTerminalExit: subscribe(CHANNELS.terminalExit),
```

- [ ] **Step 3: 主进程接线**

`src/main/index.ts` 顶部 import 区加：

```ts
import { createTerminalHub } from "./terminalHub.js";
```

在 `const agents = new Map...` 那一带（hub 是 app 级资源，和 store / attachmentStore 同层）加：

```ts
  // 终端注册表:app 级资源。openTerminal 注入而非直接 import node-pty——
  // 硬规则说了,原生模块只在 LocalWorld 里出现
  const terminals = createTerminalHub({
    openTerminal: (workspace, opts) => createLocalWorld({ root: workspace }).openTerminal!(opts),
    push: {
      data: (id, data) => send(CHANNELS.terminalData, { id, data }),
      exit: (id, exitCode) => send(CHANNELS.terminalExit, { id, exitCode }),
    },
  });
```

`createLocalWorld` 若尚未在 `index.ts` 引入，补：

```ts
import { createLocalWorld } from "../world/localWorld.js";
```

IPC handlers（挨着 `gitStatus` 那批放）：

```ts
  ipcMain.handle(CHANNELS.terminalList, (_e, sessionId: string) => terminals.list(sessionId));

  ipcMain.handle(CHANNELS.terminalOpen, (_e, sessionId: string, cols: number, rows: number) => {
    const agent = agents.get(sessionId);
    if (!agent) throw new Error("会话不存在，开不了终端");
    // cwd 取会话的工程文件夹:终端是"这个会话的终端",不是随便一个 shell
    return terminals.open(sessionId, agent.workspace, cols, rows);
  });

  ipcMain.handle(CHANNELS.terminalAttach, (_e, id: string) => terminals.attach(id));
  ipcMain.handle(CHANNELS.terminalInput, (_e, id: string, data: string) => terminals.input(id, data));
  ipcMain.handle(CHANNELS.terminalResize, (_e, id: string, cols: number, rows: number) =>
    terminals.resize(id, cols, rows)
  );
  ipcMain.handle(CHANNELS.terminalClose, (_e, id: string) => terminals.close(id));
```

`deleteSession` 的 handler 里，`store.purge(sessionId);` 之前加一行：

```ts
    terminals.killSession(sessionId); // 会话没了,它名下的终端也不该继续跑
```

`before-quit` 那行改成：

```ts
  app.on("before-quit", () => {
    terminals.killAll(); // 孤儿 dev server 会占着端口而没人知道是谁占的
    store.close();
  });
```

- [ ] **Step 4: 跑全量门禁**

Run: `npm test`
Expected: 全绿（接线层没加测试，这一步是确认没碰坏既有的）

- [ ] **Step 5: 编译确认（类型层，vitest 不查类型）**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 无报错。有报错就地修完再往下。

- [ ] **Step 6: 手动 smoke（UI 还没有，走控制台）**

```bash
npm run dev
```

在渲染进程 devtools 控制台里：

```js
const b = await window.otter.boot();
const t = await window.otter.terminalOpen(b.sessionId, 80, 24);
window.otter.onTerminalData(({ data }) => console.log("PTY:", data));
await window.otter.terminalInput(t.id, "echo hi\n");
```

Expected: 控制台打出带 `hi` 的输出。看不到就停下来查，别带着断掉的桥去写 UI。

- [ ] **Step 7: Commit**

```bash
git add src/shared/shellBridge.ts src/preload/index.ts src/main/index.ts
git commit -m "$(cat <<'EOF'
feat(bridge): 终端的六个方法两条订阅接上 IPC

open 的 cwd 取会话 workspace:终端是"这个会话的终端",不是随便一个 shell。
deleteSession 与 before-quit 都连带杀进程——会话没了/app 关了还留着
跑的 dev server,是没人能查的那种端口占用。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: xterm 实例 registry（渲染层，可测的那一半）

**Files:**
- Create: `src/renderer/src/lib/xtermRegistry.ts`
- Test: `tests/renderer/xtermRegistry.test.ts`（新建）

**Interfaces:**
- Consumes: 无（纯逻辑，工厂注入）
- Produces: `createXtermRegistry(factory)` → `{ get(id), dispose(id), disposeAll() }`。Task 6 的 `TerminalView` 用它拿 xterm 实例。

**为什么单独拆一个 task：** 「组件卸载不 dispose、只有关标签才 dispose」是这个功能里最容易写错、又最容易在手工点击中漏测的一条 —— 写错了表现是「切走再切回来滚动历史全没了」，而不是报错。把它抽成不依赖 DOM 的纯模块，用假工厂钉死。

- [ ] **Step 1: 写失败的测试**

新建 `tests/renderer/xtermRegistry.test.ts`：

```ts
import { describe, it, expect, vi } from "vitest";
import { createXtermRegistry } from "../../src/renderer/src/lib/xtermRegistry.js";

function fakeFactory() {
  const disposed: string[] = [];
  const made: string[] = [];
  return {
    disposed,
    made,
    factory: (id: string) => {
      made.push(id);
      return { dispose: () => disposed.push(id) };
    },
  };
}

describe("xtermRegistry", () => {
  it("同一个 id 只造一次实例（切走再切回来拿回同一个）", () => {
    const f = fakeFactory();
    const reg = createXtermRegistry(f.factory);
    const a = reg.get("t1");
    const b = reg.get("t1");
    expect(a).toBe(b);
    expect(f.made).toEqual(["t1"]);
  });

  it("不同 id 各造各的", () => {
    const f = fakeFactory();
    const reg = createXtermRegistry(f.factory);
    expect(reg.get("t1")).not.toBe(reg.get("t2"));
    expect(f.made).toEqual(["t1", "t2"]);
  });

  it("dispose 只在显式调用时发生——这就是‘关面板不丢滚动历史’的实现", () => {
    const f = fakeFactory();
    const reg = createXtermRegistry(f.factory);
    reg.get("t1");
    expect(f.disposed).toEqual([]); // 没人调 dispose，实例就活着
    reg.dispose("t1");
    expect(f.disposed).toEqual(["t1"]);
  });

  it("dispose 之后再 get 是一个全新实例", () => {
    const f = fakeFactory();
    const reg = createXtermRegistry(f.factory);
    const a = reg.get("t1");
    reg.dispose("t1");
    const b = reg.get("t1");
    expect(b).not.toBe(a);
    expect(f.made).toEqual(["t1", "t1"]);
  });

  it("dispose 不存在的 id 不炸", () => {
    const f = fakeFactory();
    const reg = createXtermRegistry(f.factory);
    expect(() => reg.dispose("nope")).not.toThrow();
  });

  it("disposeAll 清空所有实例", () => {
    const f = fakeFactory();
    const reg = createXtermRegistry(f.factory);
    reg.get("t1");
    reg.get("t2");
    reg.disposeAll();
    expect(f.disposed.sort()).toEqual(["t1", "t2"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/renderer/xtermRegistry.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 registry**

新建 `src/renderer/src/lib/xtermRegistry.ts`：

```ts
// xterm 实例的存放处。
//
// 为什么不让 React 组件持有:终端面板会被卸载(关面板、切去看 Git Graph),
// 而 pty 还活着。实例跟着组件走的话,切回来时滚动历史、光标位置、
// 正在编辑的那半行命令全没了——用户会以为进程也死了。
//
// 所以生命周期由 id 决定,不由组件决定:只有"关标签"和"会话删除"才 dispose。
// 工厂注入 = 这个模块不依赖 DOM,能在 vitest 里用假实例测。

export interface Disposable {
  dispose(): void;
}

export function createXtermRegistry<T extends Disposable>(factory: (id: string) => T) {
  const instances = new Map<string, T>();
  return {
    get(id: string): T {
      let inst = instances.get(id);
      if (!inst) {
        inst = factory(id);
        instances.set(id, inst);
      }
      return inst;
    },
    dispose(id: string) {
      instances.get(id)?.dispose();
      instances.delete(id);
    },
    disposeAll() {
      for (const inst of instances.values()) inst.dispose();
      instances.clear();
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/renderer/xtermRegistry.test.ts`
Expected: PASS（6 passed）

- [ ] **Step 5: 跑全量门禁**

Run: `npm test`
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/lib/xtermRegistry.ts tests/renderer/xtermRegistry.test.ts
git commit -m "$(cat <<'EOF'
feat(renderer): xterm 实例按 id 存活,不跟组件生死

组件持有实例的话,关面板再回来滚动历史和正在敲的半行命令全没了,
用户会以为进程也死了。生命周期由 id 决定:只有关标签才 dispose。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: TerminalView + 面板槽位 + 入口

**Files:**
- Create: `src/renderer/src/components/TerminalView.tsx`
- Modify: `src/renderer/src/store.ts`（`terminalOpen` 槽位 + 互斥）
- Modify: `src/renderer/src/App.tsx`（面板宿主 + 菜单入口 + 快捷键）
- Test: 无新增（xterm 的 DOM 渲染不测，收益低；逻辑部分已由 Task 3/5 覆盖）

**Interfaces:**
- Consumes: Task 4 的 `window.otter.terminal*` / `onTerminalData` / `onTerminalExit`；Task 5 的 `createXtermRegistry`
- Produces: `useChat` 的 `terminalPanelOpen: boolean` / `openTerminalPanel()` / `closeTerminalPanel()`

**命名注意：** store 里的字段叫 `terminalPanelOpen`，**不叫** `terminalOpen` —— 后者已经是 ShellBridge 上「开一个新终端」的方法名，两个同名不同义的东西放一起，下一个人一定会调错。

- [ ] **Step 1: store 加槽位**

`src/renderer/src/store.ts` 的 state 接口里，`gitGraphOpen` 附近加：

```ts
  /** 终端面板开关(与 Protocol / Git Graph / DM 互斥:同一个右侧槽位)。
      注意别和 ShellBridge 的 terminalOpen(开一个新终端)混为一谈 */
  terminalPanelOpen: boolean;
```

初始值区（`gitGraphOpen: false` 那几处，共 3 处：初始 state、切设置页时的重置、切会话时的重置）各加 `terminalPanelOpen: false`。

actions 区（`closeGitGraph` 附近）加：

```ts
  openTerminalPanel: () =>
    set({
      terminalPanelOpen: true,
      // 互斥:同一块右侧槽位
      protocolOpen: false, gitGraphOpen: false, settingsSection: null, friendChat: null,
    }),

  closeTerminalPanel: () => set({ terminalPanelOpen: false }),
```

同时在既有的 `openProtocol` / `openGitGraph` / 打开 DM 那三处的互斥字段列表里，各补上 `terminalPanelOpen: false`（**漏了这一步会出现两个面板抢同一个槽位**）。

- [ ] **Step 2: 写 TerminalView**

新建 `src/renderer/src/components/TerminalView.tsx`：

```tsx
// 终端面板 —— 纯人用的旁路工具:输出不进事件日志、不进模型上下文(ADR-0031)。
// 想让 Otto 看某段输出,用户自己复制粘贴。
//
// 面板宿主复用 Protocol/GitGraph 那套右侧槽位(半屏可拖 / 可全屏 / 记位置),
// 这里只管标签行 + xterm 的挂载。

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Plus, X, Maximize2, Minimize2 } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { useChat } from "../store.js";
import { createXtermRegistry } from "../lib/xtermRegistry.js";
import { Button } from "./ui/button.js";
import type { TerminalInfo } from "../../../shared/shellBridge.js";

/** 一个终端在渲染层的全部家当:实例 + fit 插件 + 是否已经灌过快照 */
interface Slot {
  term: Terminal;
  fit: FitAddon;
  attached: boolean;
  dispose(): void;
}

// 模块级:组件卸载不带走它(见 xtermRegistry 顶部注释)
const registry = createXtermRegistry<Slot>(() => {
  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    fontSize: 12,
    cursorBlink: true,
    // 取当前主题的底色/前景,别用 xterm 默认的纯黑——深色四色底盘里会显得脏
    theme: {
      background: "transparent",
      foreground: getComputedStyle(document.documentElement).getPropertyValue("--foreground") || "#e5e5e5",
    },
    allowTransparency: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  return { term, fit, attached: false, dispose: () => term.dispose() };
});

export function TerminalView() {
  const sessionId = useChat((s) => s.sessionId);
  const closePanel = useChat((s) => s.closeTerminalPanel);
  const panelWide = useChat((s) => s.panelWide);
  const togglePanelWide = useChat((s) => s.togglePanelWide);

  const [tabs, setTabs] = useState<TerminalInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const hostRef = useRef<HTMLDivElement | null>(null);

  // 开面板:先看这个会话有没有已经在跑的终端(关面板不杀进程,大概率有),
  // 没有才开新的
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    void (async () => {
      const existing = await window.otter.terminalList(sessionId);
      if (!alive) return;
      if (existing.length > 0) {
        setTabs(existing);
        setActiveId(existing[0]!.id);
        return;
      }
      try {
        const { id } = await window.otter.terminalOpen(sessionId, 80, 24);
        if (!alive) return;
        setTabs(await window.otter.terminalList(sessionId));
        setActiveId(id);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, [sessionId]);

  // 挂载当前标签的 xterm 到 DOM,并把回滚缓冲灌进去(只灌一次)
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !activeId) return;
    const slot = registry.get(activeId);
    host.replaceChildren();
    slot.term.open(host);
    slot.fit.fit();
    window.otter.terminalResize(activeId, slot.term.cols, slot.term.rows);

    if (!slot.attached) {
      slot.attached = true;
      void window.otter
        .terminalAttach(activeId)
        .then(({ snapshot }) => { if (snapshot) slot.term.write(snapshot); })
        .catch(() => { /* 终端已经关了,标签行随后会刷新掉 */ });
      slot.term.onData((data) => void window.otter.terminalInput(activeId, data));
    }
    slot.term.focus();
  }, [activeId]);

  // 输出直播:所有终端的都收,按 id 写进各自的实例(后台标签也在攒输出)
  useEffect(() => {
    const offData = window.otter.onTerminalData(({ id, data }) => {
      registry.get(id).term.write(data);
    });
    const offExit = window.otter.onTerminalExit(({ id, exitCode }) => {
      registry.get(id).term.write(`\r\n\x1b[2m[进程已退出，代码 ${exitCode}]\x1b[0m\r\n`);
      if (sessionId) void window.otter.terminalList(sessionId).then(setTabs);
    });
    return () => { offData(); offExit(); };
  }, [sessionId]);

  // 面板宽度变了(拖拽 / 展开全屏)要重算行列,否则 vim 之类的会画歪
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !activeId) return;
    const ro = new ResizeObserver(() => {
      const slot = registry.get(activeId);
      slot.fit.fit();
      void window.otter.terminalResize(activeId, slot.term.cols, slot.term.rows);
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [activeId]);

  const newTab = async () => {
    if (!sessionId) return;
    try {
      const { id } = await window.otter.terminalOpen(sessionId, 80, 24);
      setTabs(await window.otter.terminalList(sessionId));
      setActiveId(id);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const closeTab = async (id: string) => {
    await window.otter.terminalClose(id);
    registry.dispose(id); // 关标签才 dispose——这是唯一该 dispose 的时机
    const rest = sessionId ? await window.otter.terminalList(sessionId) : [];
    setTabs(rest);
    if (activeId === id) setActiveId(rest[0]?.id ?? null);
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveId(t.id)}
              className={`group flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs ${
                t.id === activeId ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50"
              }`}
            >
              <span className={t.exited ? "line-through opacity-60" : ""}>{t.title}</span>
              <X
                className="h-3 w-3 opacity-0 group-hover:opacity-100"
                onClick={(e) => { e.stopPropagation(); void closeTab(t.id); }}
              />
            </button>
          ))}
          <Button variant="ghost" size="sm" onClick={() => void newTab()} title="新终端">
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
        <Button variant="ghost" size="sm" onClick={togglePanelWide} title={panelWide ? "收回半屏" : "展开全屏"}>
          {panelWide ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </Button>
        <Button variant="ghost" size="sm" onClick={closePanel} title="关闭面板">
          <X className="h-3.5 w-3.5" />
        </Button>
      </header>
      {error && <div className="px-3 py-2 text-xs text-destructive">{error}</div>}
      <div ref={hostRef} className="min-h-0 flex-1 px-2 py-1" />
    </div>
  );
}
```

- [ ] **Step 3: App.tsx 接进面板宿主**

顶部 import 加：

```tsx
import { TerminalView } from "./components/TerminalView.js";
```

lucide 那行 import 里加 `Terminal as TerminalIcon`（`SquareTerminal` 已被 Work 档位用掉，别复用，两处含义不同）。

`const panel = ...` 那行改成（终端排在 friendChat 之后、gitGraph 之前，与 store 的互斥顺序一致）：

```tsx
  const panel = friendChat ? <FriendChatView />
    : terminalPanelOpen ? <TerminalView />
    : gitGraphOpen ? <GitGraphView />
    : protocolOpen ? <ProtocolView /> : null;
```

同一个组件里取 state：

```tsx
  const terminalPanelOpen = useChat((s) => s.terminalPanelOpen);
  const openTerminalPanel = useChat((s) => s.openTerminalPanel);
```

头部 `Ellipsis` 下拉里，`Git Graph` 那条之后加：

```tsx
            <DropdownMenuItem onClick={() => openTerminalPanel()}>
              <TerminalIcon /> 终端
            </DropdownMenuItem>
```

- [ ] **Step 4: 快捷键 ⌃`**

在 App.tsx 里 Esc 那个 `useEffect` 旁边加：

```tsx
  // ⌃` = 开/关终端面板(VS Code 同款肌肉记忆)。挂 window:焦点可能在
  // xterm 里,输入框收不到
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        if (useChat.getState().terminalPanelOpen) useChat.getState().closeTerminalPanel();
        else useChat.getState().openTerminalPanel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
```

- [ ] **Step 5: 跑门禁 + 类型检查**

Run: `npm test`
Expected: 全绿

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 无报错

- [ ] **Step 6: 手动验收（这一步是这个功能真正的验证）**

```bash
npm run dev
```

依次确认：

1. 头部「⋯」→「终端」能开出面板，提示符是彩色的、`echo $TERM` 显示 `xterm-256color`
2. `pwd` 输出 = 会话的工程文件夹
3. `npm run dev`（或 `sleep 60`）跑着 → 关面板 → 切去 Git Graph → 再开终端面板：**输出连续、进程没死**
4. `＋` 开第二个标签，两个标签各跑各的，互不串台；切标签时各自的滚动历史都在
5. 拖面板分隔线改宽度 → `vim` 里画面不歪（`fit` 生效）
6. 关标签 → 进程死掉；关整个 app → `ps aux | grep 'npm run dev'` 查不到孤儿
7. ⌃` 开关面板

任何一条不过，就地修，修完重跑 `npm test`。

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/TerminalView.tsx src/renderer/src/store.ts src/renderer/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(ui): 会话内嵌终端面板

面板宿主复用 Protocol/GitGraph 那套右侧槽位,半屏拖拽/全屏/记位置全是白拿的。
store 里叫 terminalPanelOpen 而不是 terminalOpen:后者已经是 ShellBridge 上
"开一个新终端"的方法名,同名不同义早晚有人调错。

输出直播对所有终端都收,不只当前标签——后台标签的 dev server 也在吐东西,
切回去时该看到完整的,不是从切回去那一刻开始的。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: 收口（CONTEXT.md + PR）

**Files:**
- Modify: `CONTEXT.md`
- Test: 无

- [ ] **Step 1: CONTEXT.md 补两个词**

在词表里加：

```markdown
- **终端面板（Terminal panel）**：会话里内嵌的真 PTY 终端，纯人用。输出不进事件日志、
  不进模型上下文（ADR-0031）——它不是任何事实的投影，是人的旁路工具。
- **回滚缓冲（terminal ring buffer）**：主进程为每个终端保留的末尾约 200 KB 输出。
  面板关掉时渲染层的 xterm 实例就没了而 pty 还在吐，靠它接住；重开面板一次性灌回去。
  内存态，不落盘，与 pty 进程同生共死。
```

- [ ] **Step 2: 跑门禁**

Run: `npm test`
Expected: 全绿

- [ ] **Step 3: Commit + push**

```bash
git add CONTEXT.md
git commit -m "$(cat <<'EOF'
docs: CONTEXT.md 收录终端面板与回滚缓冲

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
git push
```

- [ ] **Step 4: 开 PR**

```bash
gh pr create --title "feat: 会话内嵌 Terminal 面板（PTY + 右侧面板多标签）" --body "Closes #107

依据 \`docs/superpowers/specs/2026-08-19-terminal-panel-design.md\` 与 ADR-0031。

- \`ExecutionWorld\` 长出可选的 \`openTerminal\`（v2 容器化时用户终端自动落进 bot 的容器）
- \`terminalHub\` 持 pty 注册表 + 200KB 回滚缓冲，deleteSession / before-quit 连带杀
- 右侧面板多标签，复用 Protocol/GitGraph 的槽位；xterm 实例按 id 存活，关面板不丢滚动历史
- 终端输出不进事件日志、不进模型上下文

手动验收项见 plan 的 Task 6 Step 6，七条全过。"
```

- [ ] **Step 5: CI 绿了自己合**

merge commit，不 squash（AGENTS.md 的 PR disposition）。这是功能改动，不是协议改动，L1 不适用，作者自己合。

```bash
gh pr merge --merge
```

---

## Self-Review

**Spec 覆盖：**

| spec 要求 | 落在哪个 task |
|---|---|
| `ExecutionWorld.openTerminal` 可选面 + 装饰器透传 | Task 1 |
| LocalWorld / node-pty / `$SHELL -l` / cwd | Task 2 |
| 打包实测（风险闸门） | Task 2 Step 7 |
| terminalHub 注册表 / 上限 8 / 200KB 缓冲 / 连带清理 | Task 3 |
| ShellBridge 六方法两订阅 + CHANNELS + preload + 接线 | Task 4 |
| xterm 实例卸载不 dispose | Task 5 |
| 右侧面板槽位互斥 / 标签行 / fit / 入口 / ⌃\` | Task 6 |
| 测试（hub 假 pty、真 PTY、装饰器透传） | Task 1 / 2 / 3 / 5 |
| CONTEXT.md 术语 | Task 7 |

**偏离 spec 处（有意，已在对应 task 说明）：**
- spec 写 `shell` 缺省用 `$SHELL -l`（login shell）。实现里用 `$SHELL` 不加 `-l`：login shell 会重跑 `.zprofile`，在已经继承了完整 env 的子进程里重复初始化（nvm 尤其慢），非 login 的交互 shell 已经会读 `.zshrc`，够用。
- spec 的「electron-vite 要把 node-pty 标 external」实际不需要改配置：`externalizeDepsPlugin()` 已经把 `dependencies` 里的东西全标 external，所以约束落在「node-pty 必须装进 dependencies」，已写进 Global Constraints。

**类型一致性核对：** `TerminalSession` / `OpenTerminalOptions`（Task 1 定义）→ Task 2 实现 → Task 3 消费；`TerminalInfo`（Task 3 定义）→ Task 4 re-export → Task 6 消费；`createXtermRegistry`（Task 5）→ Task 6 消费。store 字段统一为 `terminalPanelOpen`，与 bridge 的 `terminalOpen` 方法名区分开，全文一致。
