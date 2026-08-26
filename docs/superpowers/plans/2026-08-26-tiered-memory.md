# 记忆分级（USER / MEMORY / PROJECT）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把模型自己维护的那份笔记从「一份全局文件」拆成三档，项目档按 git 仓库作用域，消除跨项目互相驱逐。

**Architecture:** 新增 `src/main/projectRoot.ts` 把 workspace 解析成项目根（worktree 折叠回主仓）并算出哈希目录名；`src/shared/memoryStore.ts` 的 `MemoryTarget` 加第三个值、常量路径映射改成纯函数 `memoryRelPath`；`memory_loaded` 事件加两个**可选**字段以保证旧日志逐字节重放；`memory` 工具的 `target` 枚举按有无项目根动态生成。

**Tech Stack:** TypeScript strict / Electron 主进程 / React + Zustand 渲染层 / vitest

**Spec:** `docs/superpowers/specs/2026-08-26-tiered-memory-design.md`

## Global Constraints

- **门禁**：`npm test`（= `tsc --noEmit` && `vitest run`）。每个 Task 结束前必须全绿。本机跑 npm 前先 `export PATH=/Users/stanyan/.hermes/node/bin:$PATH`。
- **硬规则 1**：`src/tools/**` 不得 import `fs` / `fs/promises` / `child_process`（`tests/architecture.test.ts` 会红）。工具只能通过 `world.config.read/write` 碰盘。
- **硬规则 2**：`src/shared/**` 不得 import **任何** node builtin（含 `node:crypto`）或 electron——手机端 RN 直接 import 这一层。所以哈希只能在 `src/main/`。
- **硬规则 3**：`SessionEvent` schema 变更必须向后兼容，旧日志必须永远可重放。只加**可选**字段，不加新事件类型（`assertReplayable` 会让旧版本拒读未知类型）。
- **字符上限**（写死常量，不做成配置）：`USER 1375` / `MEMORY 1100` / `PROJECT 2200`。
- **文件布局**：`memories/USER.md`、`memories/MEMORY.md`、`memories/projects/<sha256(projectRoot)[:16]>/{root.txt,MEMORY.md}`，路径均相对配置目录根（`~/.mr-otto`）。
- **测试位置**：`tests/` 镜像 `src/`，不与源码同目录。
- 每个 Task 单独 commit，message 说清 why。

---

### Task 1: 项目根解析（含 worktree 折叠）

**Files:**
- Create: `src/main/projectRoot.ts`
- Test: `tests/main/projectRoot.test.ts`

**Interfaces:**
- Consumes: 无（本任务是最底层）
- Produces:
  - `interface GitFsReader { readFile(path: string): string | null; exists(path: string): boolean }`
  - `resolveProjectRoot(workspace: string, reader?: GitFsReader): string | null`
  - `projectMemoryDir(projectRoot: string): string` —— 返回配置目录**相对路径**，形如 `memories/projects/1a2b3c4d5e6f7a8b`

背景：`.git` 在普通仓库里是**目录**，在 worktree 和 submodule 里是**文件**，内容形如 `gitdir: /abs/path`。`readFileSync` 读目录抛 `EISDIR`，所以 `readFile` 返回 `null` 就代表「存在但不是文件」= 普通仓库根。

- [ ] **Step 1: 写失败的测试**

创建 `tests/main/projectRoot.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { projectMemoryDir, resolveProjectRoot, type GitFsReader } from "../../src/main/projectRoot.js";

/** 假文件系统。值 = null 代表「这是个目录」（readFileSync 读目录会抛，真实现返回 null） */
function fakeFs(files: Record<string, string | null>): GitFsReader {
  return {
    readFile: (p) => (p in files ? (files[p] ?? null) : null),
    exists: (p) => p in files,
  };
}

describe("resolveProjectRoot", () => {
  it("普通仓库：.git 是目录，那一层就是项目根", () => {
    const fs = fakeFs({ "/repo/.git": null, "/repo/src/main/.keep": "" });
    expect(resolveProjectRoot("/repo/src/main", fs)).toBe("/repo");
  });

  it("worktree：.git 是文件且 gitdir 含 /worktrees/，折叠回主仓根", () => {
    const fs = fakeFs({
      "/repo/.claude/worktrees/wt-a/.git": "gitdir: /repo/.git/worktrees/wt-a\n",
    });
    expect(resolveProjectRoot("/repo/.claude/worktrees/wt-a", fs)).toBe("/repo");
  });

  it("worktree 的子目录也折叠回主仓根", () => {
    const fs = fakeFs({
      "/repo/.claude/worktrees/wt-a/.git": "gitdir: /repo/.git/worktrees/wt-a",
    });
    expect(resolveProjectRoot("/repo/.claude/worktrees/wt-a/src", fs)).toBe("/repo");
  });

  it("gitdir 是相对路径时，按 .git 文件所在目录解析", () => {
    const fs = fakeFs({ "/repo/wt/a/.git": "gitdir: ../../.git/worktrees/a" });
    expect(resolveProjectRoot("/repo/wt/a", fs)).toBe("/repo");
  });

  it("submodule：gitdir 含 /modules/，不折叠，就地当独立项目", () => {
    const fs = fakeFs({ "/repo/vendor/lib/.git": "gitdir: /repo/.git/modules/lib" });
    expect(resolveProjectRoot("/repo/vendor/lib", fs)).toBe("/repo/vendor/lib");
  });

  it("gitdir 认不出形状（既非 worktrees 也非 modules）：就地当项目根，不猜", () => {
    const fs = fakeFs({ "/repo/.git": "gitdir: /somewhere/else" });
    expect(resolveProjectRoot("/repo", fs)).toBe("/repo");
  });

  it("爬到文件系统顶都没有 .git：null = 没有项目档", () => {
    const fs = fakeFs({ "/tmp/scratch/a.txt": "" });
    expect(resolveProjectRoot("/tmp/scratch", fs)).toBeNull();
  });

  it("超过最大层数就停，不无限爬", () => {
    const deep = "/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o";
    const fs = fakeFs({ "/.git": null });
    expect(resolveProjectRoot(deep, fs)).toBeNull();
  });
});

describe("projectMemoryDir", () => {
  it("同一路径稳定、不同路径不同，且是 16 位十六进制", () => {
    const a = projectMemoryDir("/repo");
    expect(a).toBe(projectMemoryDir("/repo"));
    expect(a).not.toBe(projectMemoryDir("/repo2"));
    expect(a).toMatch(/^memories\/projects\/[0-9a-f]{16}$/);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
export PATH=/Users/stanyan/.hermes/node/bin:$PATH && npx vitest run tests/main/projectRoot.test.ts
```

预期：FAIL，`Failed to resolve import "../../src/main/projectRoot.js"`

- [ ] **Step 3: 写实现**

创建 `src/main/projectRoot.ts`：

```ts
// 项目根解析：把 workspace 映射到「这份记忆属于哪个项目」。
//
// 与 projectInstructions.ts 的爬升逻辑同源但**结论不同**：那边找的是「该读哪几份
// AGENTS.md」，worktree 里就该读 worktree 那份；这边找的是记忆的作用域，worktree
// 必须折叠回主仓——worktree 合并后就被 prune 删掉，不折叠的话项目记忆跟着每次
// 换班出生死亡，永远学不到东西。所以两边不共用函数。
//
// 主进程模块（组装根特权可碰 fs）；fs 以接口注入，测试喂假实现（同 projectInstructions）。

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** 注意 readFile 的语义：读不到**或不是文件**（目录）都返回 null。
    普通仓库的 .git 是目录，worktree/submodule 的 .git 是文件——这个差别就是判据 */
export interface GitFsReader {
  readFile(path: string): string | null;
  exists(path: string): boolean;
}

const nodeReader: GitFsReader = {
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null; // ENOENT 或 EISDIR（.git 是目录）
    }
  },
  exists(path) {
    return existsSync(path);
  },
};

/** 向上找的最大层数（同 projectInstructions 的 MAX_ASCEND，防挂载点/深目录爬到天荒地老） */
const MAX_ASCEND = 12;

/** 从 .git 文件的 `gitdir:` 指向反推项目根。认不出形状就返回 null（调用方就地当根，不猜） */
function rootFromGitdir(gitFileDir: string, content: string): string | null {
  const m = /^\s*gitdir:\s*(.+?)\s*$/m.exec(content);
  if (!m) return null;
  const target = m[1]!;
  const abs = isAbsolute(target) ? target : resolve(gitFileDir, target);
  // worktree：<主仓>/.git/worktrees/<名> —— 剥两层得 <主仓>/.git，再取父目录
  const wt = abs.lastIndexOf("/.git/worktrees/");
  if (wt >= 0) return abs.slice(0, wt);
  // submodule：<父仓>/.git/modules/<名> —— 子模块是独立仓库，不折叠
  if (abs.includes("/.git/modules/")) return null;
  return null;
}

/** workspace 所属的项目根。null = 一路没有 .git，这个会话没有项目档 */
export function resolveProjectRoot(
  workspace: string,
  reader: GitFsReader = nodeReader
): string | null {
  let dir = workspace;
  for (let i = 0; i <= MAX_ASCEND; i++) {
    const gitPath = join(dir, ".git");
    if (reader.exists(gitPath)) {
      const content = reader.readFile(gitPath);
      if (content === null) return dir; // .git 是目录 = 普通仓库根
      return rootFromGitdir(dir, content) ?? dir; // 认不出就就地当根
    }
    const parent = dirname(dir);
    if (parent === dir) break; // 到文件系统顶了
    dir = parent;
  }
  return null;
}

/** 项目记忆目录（配置目录相对路径）。绝对路径的 sha256 前 16 位——路径里的
    斜杠/空格/中文不适合直接当目录名（同 world/checkpoints.ts 的 workspaceStoreName） */
export function projectMemoryDir(projectRoot: string): string {
  const h = createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
  return `memories/projects/${h}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
export PATH=/Users/stanyan/.hermes/node/bin:$PATH && npx vitest run tests/main/projectRoot.test.ts
```

预期：PASS，9 个用例全绿

- [ ] **Step 5: 跑全量门禁**

```bash
export PATH=/Users/stanyan/.hermes/node/bin:$PATH && npm test
```

预期：全绿（本任务是纯新增，不该动到任何存量）

- [ ] **Step 6: 提交**

```bash
git add src/main/projectRoot.ts tests/main/projectRoot.test.ts
git commit -m "feat(memory): 项目根解析，worktree 折叠回主仓

记忆的作用域键。与 projectInstructions 的爬升同源但结论不同：那边 worktree
就该读 worktree 那份 AGENTS.md，这边必须折叠——worktree 合并后被 prune 删掉，
不折叠的话项目记忆跟着每次换班出生死亡，比不分级更差。

submodule 刻意不折叠：子模块是独立仓库，它的约定不属于父仓。"
```

---

### Task 2: memoryStore 三档

**Files:**
- Modify: `src/shared/memoryStore.ts`
- Test: `tests/shared/memoryStore.test.ts`（扩充现有文件）

**Interfaces:**
- Consumes: 无（`projectMemoryDir` 的结果以字符串形式传入，本层不算哈希——`src/shared` 不许 import `node:crypto`）
- Produces:
  - `type MemoryTarget = "memory" | "user" | "project"`
  - `MEMORY_LIMITS: { memory: 1100; user: 1375; project: 2200 }`
  - `memoryRelPath(target: MemoryTarget, projectDir?: string | null): string` —— 取代 `MEMORY_FILES` 常量映射
  - `PROJECT_MEMORY_FILE = "MEMORY.md"` / `PROJECT_ROOT_FILE = "root.txt"`
  - `withMemoryFileLock(relPath: string, fn)` —— 锁 key 从 target 改成**文件相对路径**

- [ ] **Step 1: 写失败的测试**

在 `tests/shared/memoryStore.test.ts` 末尾追加：

```ts
import { memoryRelPath, MEMORY_LIMITS, isMemoryTarget, withMemoryFileLock } from "../../src/shared/memoryStore.js";

describe("三档路径与上限", () => {
  it("memoryRelPath：三档各自的相对路径", () => {
    expect(memoryRelPath("user")).toBe("memories/USER.md");
    expect(memoryRelPath("memory")).toBe("memories/MEMORY.md");
    expect(memoryRelPath("project", "memories/projects/abc123")).toBe("memories/projects/abc123/MEMORY.md");
  });

  it("memoryRelPath：project 没给 projectDir 就抛——绝不静默落到全局档", () => {
    expect(() => memoryRelPath("project")).toThrow(/projectDir/);
    expect(() => memoryRelPath("project", null)).toThrow(/projectDir/);
  });

  it("isMemoryTarget 认得第三档", () => {
    expect(isMemoryTarget("project")).toBe(true);
    expect(isMemoryTarget("projects")).toBe(false);
  });

  it("三档上限：全局档让位给项目档", () => {
    expect(MEMORY_LIMITS).toEqual({ memory: 1100, user: 1375, project: 2200 });
  });

  it("project 超限的报错文案带 PROJECT 字样", () => {
    const long = "x".repeat(2300);
    const r = applyOps("project", [], [{ action: "add", target: "project", content: long }]);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("PROJECT") });
    expect((r as { error: string }).error).toContain("2200");
  });
});

describe("withMemoryFileLock 按文件路径加锁", () => {
  it("同一路径串行", async () => {
    const order: string[] = [];
    const p = "memories/MEMORY.md";
    const a = withMemoryFileLock(p, async () => { order.push("a-in"); await Promise.resolve(); order.push("a-out"); });
    const b = withMemoryFileLock(p, async () => { order.push("b-in"); });
    await Promise.all([a, b]);
    expect(order).toEqual(["a-in", "a-out", "b-in"]);
  });

  it("不同项目的项目档互不阻塞（锁 key 是路径不是 target）", async () => {
    const order: string[] = [];
    let releaseA!: () => void;
    const gate = new Promise<void>((r) => (releaseA = r));
    const a = withMemoryFileLock("memories/projects/aaa/MEMORY.md", async () => { order.push("a-in"); await gate; order.push("a-out"); });
    const b = withMemoryFileLock("memories/projects/bbb/MEMORY.md", async () => { order.push("b-in"); });
    await b;
    expect(order).toEqual(["a-in", "b-in"]); // b 没被 a 堵住
    releaseA();
    await a;
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
export PATH=/Users/stanyan/.hermes/node/bin:$PATH && npx vitest run tests/shared/memoryStore.test.ts
```

预期：FAIL，`memoryRelPath is not a function`

- [ ] **Step 3: 改实现**

在 `src/shared/memoryStore.ts` 里做四处替换。

① `MemoryTarget` 与守卫：

```ts
export type MemoryTarget = "memory" | "user" | "project";

/** 运行时守卫（issue #186）：IPC/工具入参都是 unknown，非法值会一路传进文件路径拼接 */
export function isMemoryTarget(v: unknown): v is MemoryTarget {
  return v === "memory" || v === "user" || v === "project";
}
```

② 上限与路径（**删掉** `MEMORY_FILES` 常量映射，换成函数）：

```ts
// 三档预算（ADR 见 docs/adr/）。全局 MEMORY 从 2200 降到 1100：三档之后它的职责
// 变窄了——项目约定全搬去项目档，它只装「换个项目也成立」的事（本机环境、工具怪癖）。
// 不做成配置：紧上限不是为了省 token，是为了逼出策展；可配置会诱导调数字而非合并条目。
export const MEMORY_LIMITS: Record<MemoryTarget, number> = { memory: 1100, user: 1375, project: 2200 };

export const MEMORY_DIR = "memories";
/** 项目记忆目录里的两个文件。root.txt 让目录自描述（设置页要显示「这份记忆属于
    哪个项目」），不引入中心索引——索引是派生物，会和磁盘现实脱节 */
export const PROJECT_MEMORY_FILE = "MEMORY.md";
export const PROJECT_ROOT_FILE = "root.txt";

/** 记忆文件的配置目录相对路径。projectDir 由主进程算好传进来（形如
    "memories/projects/<hash16>"）——src/shared 不许 import node:crypto（手机端要跑这一层） */
export function memoryRelPath(target: MemoryTarget, projectDir?: string | null): string {
  if (target === "user") return `${MEMORY_DIR}/USER.md`;
  if (target === "memory") return `${MEMORY_DIR}/MEMORY.md`;
  if (!projectDir) throw new Error("project 档需要 projectDir——没有项目根时不该走到这里");
  return `${projectDir}/${PROJECT_MEMORY_FILE}`;
}
```

③ 锁 key 换成路径：

```ts
// 写互斥（issue #185）：memory 工具与设置页 applyUserEdit 都是 read-modify-write。
// key 是**文件相对路径**而不是 target——三档之后两个不同项目的项目档是两个文件，
// 按 target 加锁会把它们无谓地串起来。
const fileLocks = new Map<string, Promise<unknown>>();

export function withMemoryFileLock<T>(relPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(relPath) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  fileLocks.set(relPath, run.catch(() => {}));
  return run;
}
```

④ 报错文案的档名：

```ts
const LABEL: Record<MemoryTarget, string> = { memory: "MEMORY", user: "USER", project: "PROJECT" };
```

- [ ] **Step 4: 跑测试确认通过**

```bash
export PATH=/Users/stanyan/.hermes/node/bin:$PATH && npx vitest run tests/shared/memoryStore.test.ts
```

预期：PASS。若 `tsc` 报别处引用了已删除的 `MEMORY_FILES`，**先不修**——Task 4/5 会改那些调用点。本步只保证本文件的测试绿。

- [ ] **Step 5: 让 tsc 过：临时兜住存量调用点**

`MEMORY_FILES` 有三个调用点（`src/tools/memory.ts`、`src/main/memoryEdit.ts`、`src/main/index.ts`）。把它们就地改成 `memoryRelPath(target)`（两档路径行为完全等价），并把 `withMemoryFileLock(target, …)` 改成 `withMemoryFileLock(rel, …)`。逐个文件改，改完跑：

```bash
export PATH=/Users/stanyan/.hermes/node/bin:$PATH && npm test
```

预期：全绿。这一步不引入新行为，只是把常量映射换成函数调用。

- [ ] **Step 6: 提交**

```bash
git add src/shared/memoryStore.ts src/tools/memory.ts src/main/memoryEdit.ts src/main/index.ts tests/shared/memoryStore.test.ts
git commit -m "feat(memory): memoryStore 三档，锁 key 改成文件路径

MEMORY_FILES 常量映射撑不住第三档——项目档路径依赖运行时 projectRoot，
换成 memoryRelPath(target, projectDir)。哈希不在这一层算：src/shared 手机端
要 import，不许碰 node:crypto。

全局 MEMORY 2200 降到 1100：三档后它只装「换个项目也成立」的事。

锁 key 从 target 换成文件相对路径，否则两个不同项目的项目档会被同一把
'project' 锁无谓串起来。"
```

---

### Task 3: 事件与投影（向后兼容）

**Files:**
- Modify: `src/session/events.ts`（`MemoryLoadedEvent`）
- Modify: `src/session/deriveMessages.ts`（`renderMemoryBlocks` / `renderMemoryPrompt` / `case "memory_loaded"`）
- Modify: `src/shared/contextEstimate.ts`（`contextBreakdown` 里的 `renderMemoryPrompt` 调用）
- Test: `tests/session/deriveMessages.test.ts`（扩充）

**Interfaces:**
- Consumes: Task 2 的 `MEMORY_LIMITS`
- Produces:
  - `MemoryLoadedEvent` 多两个可选字段 `project?: string` / `projectRoot?: string`
  - `renderMemoryBlocks(memory: string, user: string, project?: string): string`
  - `renderMemoryPrompt(memory: string, user: string, project?: string, projectRoot?: string): string`

- [ ] **Step 1: 写失败的测试**

在 `tests/session/deriveMessages.test.ts` 追加：

```ts
import { renderMemoryBlocks, renderMemoryPrompt } from "../../src/session/deriveMessages.js";

describe("记忆分级的投影", () => {
  it("旧日志（无 project 字段）的投影与两档时代逐字节一致", () => {
    // 硬规则的可执行版：旧日志必须永远可重放。三档改动不许动到两档的输出。
    const before = renderMemoryBlocks("笔记一", "用户住悉尼");
    expect(before).toContain("MEMORY (your personal notes)");
    expect(before).toContain("USER (about the user)");
    expect(before).not.toContain("PROJECT");
  });

  it("有 project 时渲三块，标题带项目根", () => {
    const out = renderMemoryBlocks("笔记一", "用户住悉尼", "本项目门禁是 npm test");
    expect(out).toContain("MEMORY (your personal notes)");
    expect(out).toContain("USER (about the user)");
    expect(out).toContain("PROJECT (this project only)");
    expect(out).toContain("本项目门禁是 npm test");
  });

  it("project 是空串时不渲那一块（同 memory/user 的语义）", () => {
    expect(renderMemoryBlocks("a", "b", "")).not.toContain("PROJECT");
  });

  it("三个都空 = 空串（投影与无记忆逐字节一致）", () => {
    expect(renderMemoryBlocks("", "", "")).toBe("");
  });

  it("有项目根时，机制说明里点名当前项目；没有时不提项目档", () => {
    const withP = renderMemoryPrompt("a", "b", "c", "/repo");
    expect(withP).toContain("/repo");
    expect(withP).toContain("项目");
    const noP = renderMemoryPrompt("a", "b");
    expect(noP).not.toContain("PROJECT");
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
export PATH=/Users/stanyan/.hermes/node/bin:$PATH && npx vitest run tests/session/deriveMessages.test.ts
```

预期：FAIL（`renderMemoryBlocks` 只接两个参数，第三块不出现）

- [ ] **Step 3: 改事件定义**

`src/session/events.ts`，替换 `MemoryLoadedEvent`：

```ts
/** 额外 14：长期记忆快照（ADR-0060）。session 开头把记忆文件的内容落盘——模型整个
    session 看到的就是这一份（投影拼进 system 尾部），中途写盘下个 session 才可见
    （前缀缓存不被打穿，hermes 同款取舍）。快照语义同 skill_invoked：文件后来
    改了/丢了，重放不失真。
    project/projectRoot 是**可选**字段（记忆分级）：旧日志没有它们 ⇒ 投影与今天
    逐字节一致；反过来新日志被旧版本读到时，assertReplayable 拒的是未知**事件类型**，
    已知类型上的多余字段它认得——所以绝不能新开一个 project_memory_loaded 类型 */
export interface MemoryLoadedEvent extends SessionEventBase {
  type: "memory_loaded";
  memory: string;
  user: string;
  /** 项目档内容。缺席 = 这个会话没有项目根（workspace 一路没有 .git） */
  project?: string;
  /** 项目档归属的项目根绝对路径（UI 显示 + 审计） */
  projectRoot?: string;
}
```

- [ ] **Step 4: 改投影**

`src/session/deriveMessages.ts`，替换 `renderMemoryBlocks` 与 `renderMemoryPrompt`：

```ts
/** memory_loaded 渲成 system 尾部的三块。全空 = 空串（投影与无记忆逐字节一致）。
    标题带占用百分比：模型看得见自己还剩多少地方，超限报错时不至于意外 */
export function renderMemoryBlocks(memory: string, user: string, project?: string): string {
  const m = memoryBlock("MEMORY (your personal notes)", memory, MEMORY_LIMITS.memory);
  const u = memoryBlock("USER (about the user)", user, MEMORY_LIMITS.user);
  const p = project ? memoryBlock("PROJECT (this project only)", project, MEMORY_LIMITS.project) : "";
  if (!m && !u && !p) return "";
  return `\n${m}${u}${p}${MEMORY_RULE}`;
}

export function renderMemoryPrompt(memory: string, user: string, project?: string, projectRoot?: string): string {
  const tiers = projectRoot
    ? `记忆分三档：PROJECT 记只在当前项目（${projectRoot}）为真的事；MEMORY 记换个项目也成立的事（本机环境、工具怪癖）；USER 记关于用户本人的事。拿不准就写 MEMORY——错放全局只是噪音，错放项目档是丢失。`
    : `记忆分两档（这个工作区不在任何 git 仓库里，没有项目档）：MEMORY 是你的笔记，USER 是关于用户。`;
  return (
    `\n你有跨会话的长期记忆（本消息末尾的记忆块），用 memory 工具维护：记用户偏好、环境细节、工具怪癖、稳定约定，优先记能减少用户再次纠正你的事；` +
    `不记任务进度、PR/issue 号、commit、一周内会过期的东西。${tiers}` +
    `过去做过什么、进度到哪、当时怎么决定的——用 session_search 查历史会话。` +
    `写陈述句不写祈使句（「用户偏好简短回复」对，「总是简短回复」错——祈使句下次会被当成指令）；流程和步骤归 skill 不归记忆。` +
    `\n记忆的工作机制（被问到时照实说，别脑补）：会话开始时整份快照注入（就是下面的记忆块），没有按相关性检索；` +
    (projectRoot ? `项目档按当前工作区所属的 git 仓库挑，换项目换一份（worktree 折叠回主仓）；` : ``) +
    `本会话中途写入的下个会话才可见；用户可在设置页查看和手动编辑这几份笔记；` +
    `session_search 查的是历史会话正文，和记忆是分开的两条路。` +
    renderMemoryBlocks(memory, user, project)
  );
}
```

同文件 `case "memory_loaded"` 里传参改为：

```ts
renderMemoryPrompt(event.memory, event.user, event.project, event.projectRoot)
```

- [ ] **Step 5: 改上下文估算**

`src/shared/contextEstimate.ts` 的 `contextBreakdown`：

```ts
          (memoryEvent
            ? renderMemoryPrompt(memoryEvent.memory, memoryEvent.user, memoryEvent.project, memoryEvent.projectRoot)
            : "")
```

- [ ] **Step 6: 跑测试确认通过**

```bash
export PATH=/Users/stanyan/.hermes/node/bin:$PATH && npm test
```

预期：全绿。若 `tests/shared/contextEstimate.test.ts` 里有对 system token 数的精确断言因文案变化而红，更新那个期望值——文案本来就跟着这次改动变。

- [ ] **Step 7: 提交**

```bash
git add src/session/events.ts src/session/deriveMessages.ts src/shared/contextEstimate.ts tests/session/deriveMessages.test.ts
git commit -m "feat(memory): memory_loaded 加可选 project 字段，投影渲三块

只加可选字段不加新事件类型，理由双向：旧日志没这两个字段 ⇒ 投影逐字节不变
（硬规则：旧日志必须永远可重放）；新日志被旧版本读到时 assertReplayable 拒的是
未知事件类型，已知类型上的多余字段它认得——新开 project_memory_loaded 会让
旧版本直接拒读整个会话。

renderMemoryPrompt 里那段照实讲机制的话跟着改：留旧描述等于让它说谎。"
```

---

### Task 4: 工具契约（动态枚举）

**Files:**
- Modify: `src/tools/memory.ts`
- Test: `tests/tools/memory.test.ts`（扩充）

**Interfaces:**
- Consumes: Task 2 的 `memoryRelPath` / `MEMORY_LIMITS`
- Produces:
  - `createMemoryTool(project: { root: string; dir: string } | null): Tool`
  - `project.dir` = `projectMemoryDir()` 的返回值（配置目录相对路径）。工具不算哈希——`src/tools` 不该知道哈希算法

- [ ] **Step 1: 写失败的测试**

在 `tests/tools/memory.test.ts` 追加（沿用该文件已有的假 world helper）：

```ts
describe("项目档", () => {
  it("没有项目根时，target 枚举里不出现 project", () => {
    const tool = createMemoryTool(null);
    const target = (tool.def.parameters as any).properties.target;
    expect(target.enum).toEqual(["memory", "user"]);
    expect(tool.def.description).not.toContain("PROJECT");
  });

  it("有项目根时枚举含 project，描述里带判据", () => {
    const tool = createMemoryTool({ root: "/repo", dir: "memories/projects/abc123" });
    const target = (tool.def.parameters as any).properties.target;
    expect(target.enum).toEqual(["memory", "user", "project"]);
    expect(tool.def.description).toContain("只在当前项目为真");
  });

  it("写 project 落到项目目录，并写 root.txt 让目录自描述", async () => {
    const world = fakeWorld();
    const tool = createMemoryTool({ root: "/repo", dir: "memories/projects/abc123" });
    await tool.run({ target: "project", action: "add", content: "本项目门禁是 npm test" }, world);
    expect(await world.config!.read("memories/projects/abc123/MEMORY.md")).toBe("本项目门禁是 npm test");
    expect(await world.config!.read("memories/projects/abc123/root.txt")).toBe("/repo");
  });

  it("没有项目根却写 project：报错，绝不静默落到全局档", async () => {
    const world = fakeWorld();
    const tool = createMemoryTool(null);
    await expect(tool.run({ target: "project", action: "add", content: "x" }, world))
      .rejects.toThrow(/没有项目/);
    expect(await world.config!.read("memories/MEMORY.md")).toBeNull();
  });

  it("project 超限报错带 2200", async () => {
    const world = fakeWorld();
    const tool = createMemoryTool({ root: "/repo", dir: "memories/projects/abc123" });
    await expect(tool.run({ target: "project", action: "add", content: "x".repeat(2300) }, world))
      .rejects.toThrow(/2200/);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
export PATH=/Users/stanyan/.hermes/node/bin:$PATH && npx vitest run tests/tools/memory.test.ts
```

预期：FAIL，`createMemoryTool` 不接参数 / 枚举里没有 project

- [ ] **Step 3: 改实现**

`src/tools/memory.ts`：

① `createMemoryTool` 签名与 project 守卫：

```ts
/** project 由组装根传入（root = 项目根绝对路径，dir = 配置目录相对路径）。
    null = 这个会话的 workspace 不在任何 git 仓库里 ⇒ 不给模型看 project 这个选项：
    看不见的档就不会误写，比给它一个必然报错的选项干净 */
export function createMemoryTool(project: { root: string; dir: string } | null): Tool {
  let consecutiveFailures = 0;

  async function execute(args: unknown, world: ExecutionWorld): Promise<string> {
    if (!world.config) throw new Error("这个世界没有长期记忆能力（配置目录不可用）");
    const { target, ops } = parseOps(args, project !== null);
    // ...（威胁扫描原样保留）

    const rel = memoryRelPath(target, project?.dir);
```

② `parseOps` 多一个参数，拒掉无项目时的 project：

```ts
function parseOps(args: unknown, hasProject: boolean): { target: MemoryTarget; ops: MemoryOp[] } {
  const a = (args ?? {}) as Record<string, unknown>;
  if (!isMemoryTarget(a["target"])) throw new Error("target 必填，且只能是 memory / user / project");
  const target = a["target"];
  if (target === "project" && !hasProject) {
    throw new Error("当前工作区不在任何 git 仓库里，没有项目档；写 memory 或 user");
  }
  // 以下原样保留：raw/ops 的归一化、content 与 new_text 的别名、
  // add/replace/remove 三个 case 的映射——这次只改 target 的校验
```

③ 写盘时顺带落 `root.txt`（在拿到锁的那段里，紧跟 MEMORY.md 之后）：

```ts
      await world.config!.write(rel, formatEntries(r.entries));
      // 目录自描述（设置页要显示「这份记忆属于哪个项目」）。每次写都覆盖同样内容，
      // 幂等；不做存在性检查是为了不引入「先读后写」的第二条竞态路径
      if (target === "project" && project) {
        await world.config!.write(`${project.dir}/${PROJECT_ROOT_FILE}`, project.root);
      }
```

④ 工具描述按有无项目档分叉：

```ts
  const tierRule = project
    ? "三档：project = 只在当前项目为真的事（该项目的门禁命令、构建怪癖、约定）；" +
      "memory = 换个项目也成立的事（本机环境、工具怪癖）；user = 关于用户本人。" +
      "拿不准就写 memory——错放全局只是噪音，错放项目档是丢失。"
    : "两档：memory = 你的笔记，user = 关于用户。";
```

把 `tierRule` 拼进 `description`，并把 `target` 的 `enum` 改成：

```ts
          target: {
            type: "string",
            enum: project ? ["memory", "user", "project"] : ["memory", "user"],
            description: "写哪个文件",
          },
```

⑤ 终态那句话的档名：

```ts
    const label = { memory: "MEMORY", user: "USER", project: "PROJECT" }[result.target];
    return `已更新 ${label}（${n} 处，${result.used}/${result.limit} 字符）。\n${formatMemoryResultLine(result)}`;
```

- [ ] **Step 4: 跑测试确认通过**

```bash
export PATH=/Users/stanyan/.hermes/node/bin:$PATH && npx vitest run tests/tools/memory.test.ts
```

预期：PASS

- [ ] **Step 5: 修 tsc（唯一调用点在 agent.ts）**

`src/main/agent.ts` 的 `createMemoryTool()` 暂时传 `null`，Task 5 再接真值：

```ts
    ...(world.config ? [createMemoryTool(null)] : []),
```

```bash
export PATH=/Users/stanyan/.hermes/node/bin:$PATH && npm test
```

预期：全绿

- [ ] **Step 6: 提交**

```bash
git add src/tools/memory.ts src/main/agent.ts tests/tools/memory.test.ts
git commit -m "feat(memory): memory 工具的 target 枚举按有无项目根动态生成

没有项目根时 project 这个选项对模型不可见——看不见的档就不会误写，比给它
一个必然报错的选项干净。工具不算哈希（dir 由组装根传入）：src/tools 不该
知道目录名怎么来的。

写项目档时顺带覆盖 root.txt，目录自描述，不引入中心索引。"
```

---

### Task 5: 装配接线

**Files:**
- Modify: `src/main/index.ts`（`readMemoryFiles`、装配处的 `memory:` 字段）
- Modify: `src/main/agent.ts`（`AgentOptions.memory`、`memory_loaded` 落盘、`createMemoryTool` 传参）
- Test: `tests/main/agent.test.ts`（扩充）

**Interfaces:**
- Consumes: Task 1 的 `resolveProjectRoot` / `projectMemoryDir`；Task 4 的 `createMemoryTool(project)`
- Produces:
  - `AgentOptions.memory?: { memory: string; user: string; project?: string; projectRoot?: string }`
  - `readMemoryFiles(workspace: string)` 返回同一形状

- [ ] **Step 1: 写失败的测试**

在 `tests/main/agent.test.ts` 追加：

本文件顶部已有 `push` / `attachments` 两个共享常量和 `createLocalWorld` / `tempDir` 的 import，直接复用（照 "新 session：session_created 之后紧跟 memory_loaded" 那个既有用例的写法）：

```ts
it("memory 快照带项目档时，落盘的 memory_loaded 带 project/projectRoot", () => {
  const store = new EventStore(":memory:");
  const world = createLocalWorld({ configRoot: tempDir("otter-agent-config-") });
  const memory = { memory: "全局", user: "用户", project: "项目", projectRoot: "/repo" };

  const a = createAgent({ store, workspace: "/repo", push, attachments, world, memory });
  const ev = store.load(a.sessionId).find((e) => e.type === "memory_loaded");
  expect(ev).toMatchObject({ memory: "全局", user: "用户", project: "项目", projectRoot: "/repo" });
  store.close();
});

it("没有项目根时，memory_loaded 不带那两个字段（旧日志形状）", () => {
  const store = new EventStore(":memory:");
  const world = createLocalWorld({ configRoot: tempDir("otter-agent-config-") });
  const memory = { memory: "全局", user: "用户" };

  const a = createAgent({ store, workspace: "/tmp/scratch", push, attachments, world, memory });
  const ev = store.load(a.sessionId).find((e) => e.type === "memory_loaded")!;
  expect("project" in ev).toBe(false);
  expect("projectRoot" in ev).toBe(false);
  store.close();
});
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
export PATH=/Users/stanyan/.hermes/node/bin:$PATH && npx vitest run tests/main/agent.test.ts
```

预期：FAIL（`project` 字段没被落盘）

- [ ] **Step 3: 改 agent.ts**

① `AgentOptions.memory` 类型：

```ts
  /** 新 session 的长期记忆快照（ADR-0060）。由 index.ts 在造 agent 之前读好——
      createAgent 是同步的。resume 时忽略：日志里那条 memory_loaded 才是模型看过的。
      project/projectRoot 缺席 = 这个 workspace 不在任何 git 仓库里 */
  memory?: { memory: string; user: string; project?: string; projectRoot?: string };
```

② 落盘时条件展开（**不能无条件写 `project: undefined`**——那会让事件对象多出 key，破坏「旧日志形状」的断言与 JSON 序列化的逐字节一致）：

```ts
      store.append({
        sessionId,
        ts: Date.now(),
        type: "memory_loaded",
        memory: opts.memory.memory,
        user: opts.memory.user,
        ...(opts.memory.projectRoot
          ? { project: opts.memory.project ?? "", projectRoot: opts.memory.projectRoot }
          : {}),
      });
```

③ 工具装配传真值：

```ts
  const memoryProject =
    opts.memory?.projectRoot
      ? { root: opts.memory.projectRoot, dir: projectMemoryDir(opts.memory.projectRoot) }
      : null;
  // …
    ...(world.config ? [createMemoryTool(memoryProject)] : []),
```

顶部加 `import { projectMemoryDir } from "./projectRoot.js";`

> 注意：resume 的会话 `opts.memory` 被忽略（日志里那条才算数），但**工具**仍需要项目档路径。resume 时从日志里那条 `memory_loaded` 取 `projectRoot`：

```ts
  const loadedProjectRoot =
    opts.memory?.projectRoot ??
    (resumeLog?.find((e): e is MemoryLoadedEvent => e.type === "memory_loaded")?.projectRoot);
```

用 `loadedProjectRoot` 算 `memoryProject`。

- [ ] **Step 4: 改 index.ts**

`readMemoryFiles` 带上 workspace：

```ts
  const readMemoryFiles = (
    workspace: string
  ): { memory: string; user: string; project?: string; projectRoot?: string } => {
    const root = configDir(homedir());
    const read = (rel: string): string => {
      try {
        return readFileSync(join(root, rel), "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(`读记忆文件 ${rel} 失败（按空快照继续）`, err);
        }
        return "";
      }
    };
    const base = { memory: read(memoryRelPath("memory")), user: read(memoryRelPath("user")) };
    const projectRoot = resolveProjectRoot(workspace);
    if (!projectRoot) return base;
    return { ...base, project: read(memoryRelPath("project", projectMemoryDir(projectRoot))), projectRoot };
  };
```

装配处：`memory: readMemoryFiles(args.workspace),`

`CHANNELS.getMemory` 的 handler 没有 workspace——设置页读的是两档全局文件。改成：

```ts
  ipcMain.handle(CHANNELS.getMemory, () => {
    const root = configDir(homedir());
    const read = (rel: string): string => {
      try { return readFileSync(join(root, rel), "utf8"); } catch { return ""; }
    };
    return { memory: read(memoryRelPath("memory")), user: read(memoryRelPath("user")) };
  });
```

（项目档的读取走 Task 6 新增的 `listProjectMemories`。）

- [ ] **Step 5: 跑门禁**

```bash
export PATH=/Users/stanyan/.hermes/node/bin:$PATH && npm test
```

预期：全绿

- [ ] **Step 6: 提交**

```bash
git add src/main/agent.ts src/main/index.ts tests/main/agent.test.ts
git commit -m "feat(memory): 装配接线，项目档进 memory_loaded 快照

条件展开而不是无条件写 project: undefined —— 后者会让没有项目根的会话
事件对象多出两个 key，破坏「旧日志形状逐字节不变」这条断言。

resume 时 opts.memory 被忽略（日志里那条才算数），但工具仍需要项目档路径，
所以从日志里那条 memory_loaded 取 projectRoot。"
```

---

### Task 6: 设置页与 IPC

**Files:**
- Modify: `src/shared/shellBridge.ts`（bridge 接口 + CHANNELS）
- Modify: `src/main/memoryEdit.ts`（`applyUserEdit` 带 projectDir）
- Modify: `src/main/index.ts`（新 handler）
- Modify: `src/renderer/src/components/MemorySettings.tsx`
- Modify: `src/renderer/src/aui/memoryChips.ts` + `src/renderer/src/components/elements/memory-chips.tsx`
- Test: `tests/main/memoryEdit.test.ts`（扩充）

**Interfaces:**
- Consumes: Task 1 `projectMemoryDir`；Task 2 `memoryRelPath` / `PROJECT_ROOT_FILE`
- Produces（`ShellBridge` 新增/扩展）：
  - `listProjectMemories(): Promise<{ root: string; text: string }[]>`
  - `saveMemory(target: MemoryTarget, text: string, sessionId?: string, projectRoot?: string): Promise<void>`
  - `forgetMemory(target: MemoryTarget, entry: string, sessionId: string, projectRoot?: string): Promise<void>`
  - `deleteProjectMemory(root: string): Promise<void>`

- [ ] **Step 1: 写失败的测试**

在 `tests/main/memoryEdit.test.ts` 追加：

```ts
it("项目档的手编也落 memory_user_edit，target 是 project", async () => {
  const files = new Map<string, string>();
  const store = new EventStore(":memory:");
  const deps = {
    store,
    readFile: async (rel: string) => files.get(rel) ?? "",
    writeFile: async (rel: string, c: string) => void files.set(rel, c),
  };
  await applyUserEdit(deps, "project", "本项目门禁是 npm test", "s1", "memories/projects/abc123");
  expect(files.get("memories/projects/abc123/MEMORY.md")).toBe("本项目门禁是 npm test");
  const ev = store.load("s1").find((e) => e.type === "memory_user_edit");
  expect(ev).toMatchObject({ target: "project", after: "本项目门禁是 npm test" });
});

it("project 没给 projectDir 就抛，绝不落到全局档", async () => {
  const files = new Map<string, string>();
  const deps = {
    store: new EventStore(":memory:"),
    readFile: async (rel: string) => files.get(rel) ?? "",
    writeFile: async (rel: string, c: string) => void files.set(rel, c),
  };
  await expect(applyUserEdit(deps, "project", "x", "s1")).rejects.toThrow(/projectDir/);
  expect(files.get("memories/MEMORY.md")).toBeUndefined();
});
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
export PATH=/Users/stanyan/.hermes/node/bin:$PATH && npx vitest run tests/main/memoryEdit.test.ts
```

预期：FAIL（`applyUserEdit` 只接四个参数）

- [ ] **Step 3: 改 memoryEdit.ts**

```ts
export async function applyUserEdit(
  deps: MemoryEditDeps,
  target: MemoryTarget,
  text: string,
  sessionId: string = MEMORY_EDITS_SESSION,
  projectDir?: string | null
): Promise<void> {
  if (!isMemoryTarget(target)) throw new Error(`target 只能是 memory / user / project，收到 ${String(target)}`);
  const rel = memoryRelPath(target, projectDir); // project 缺 projectDir 时在这里抛
  await withMemoryFileLock(rel, async () => {
    // …（其余原样，把 MEMORY_FILES[target] 换成 rel）
```

- [ ] **Step 4: 加 IPC handler**

`src/shared/shellBridge.ts` 的 `CHANNELS` 加两条：

```ts
  listProjectMemories: "otter:listProjectMemories",
  deleteProjectMemory: "otter:deleteProjectMemory",
```

`ShellBridge` 接口按上面 Produces 改签名，并加注释说明 `projectRoot` 缺省 = 全局档。

`src/main/index.ts`：

```ts
  ipcMain.handle(CHANNELS.listProjectMemories, async () => {
    const dir = join(configDir(homedir()), "memories", "projects");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return []; // 还没有任何项目记忆，不是故障
    }
    const out: { root: string; text: string }[] = [];
    for (const n of names) {
      const read = async (f: string) => {
        try { return await readFile(join(dir, n, f), "utf8"); } catch { return null; }
      };
      const root = await read(PROJECT_ROOT_FILE);
      if (root === null) continue; // 没有 root.txt = 不自描述的孤儿目录，不列
      out.push({ root: root.trim(), text: (await read(PROJECT_MEMORY_FILE)) ?? "" });
    }
    return out.sort((a, b) => a.root.localeCompare(b.root));
  });

  ipcMain.handle(CHANNELS.deleteProjectMemory, async (_e, root: unknown) => {
    if (typeof root !== "string" || !root) throw new Error("root 必须是非空字符串");
    await rm(join(configDir(homedir()), projectMemoryDir(root)), { recursive: true, force: true });
  });
```

`saveMemory` / `forgetMemory` 两个 handler 多接一个 `projectRoot`，转成 `projectDir`：

```ts
  ipcMain.handle(CHANNELS.saveMemory, (_e, target: MemoryTarget, text: string, sessionId?: string, projectRoot?: string) =>
    applyUserEdit(memoryEditDeps, target, text, sessionId, projectRoot ? projectMemoryDir(projectRoot) : null));

  ipcMain.handle(CHANNELS.forgetMemory, async (_e, target: MemoryTarget, entry: string, sessionId: string, projectRoot?: string) => {
    if (!isMemoryTarget(target)) throw new Error(`target 只能是 memory / user / project，收到 ${String(target)}`);
    const dir = projectRoot ? projectMemoryDir(projectRoot) : null;
    const cur = parseEntries(await memoryEditDeps.readFile(memoryRelPath(target, dir)));
    await applyUserEdit(memoryEditDeps, target, formatEntries(cur.filter((x) => x !== entry)), sessionId, dir);
  });
```

- [ ] **Step 5: 改设置页**

`MemorySettings.tsx`：在现有两个编辑区之后加第三个区。骨架：

```tsx
const [projects, setProjects] = useState<{ root: string; text: string }[]>([]);
const [picked, setPicked] = useState<string | null>(null);

useEffect(() => { void bridge.listProjectMemories().then(setProjects); }, []);

const current = projects.find((p) => p.root === picked) ?? projects[0] ?? null;
```

渲染：一个 `<select>` 列出 `projects.map(p => p.root)`，下面复用现有的编辑区组件（`value={current?.text ?? ""}`，保存时 `bridge.saveMemory("project", text, undefined, current.root)`），旁边一个「删掉这个项目的记忆」按钮调 `deleteProjectMemory(current.root)` 后重新 `listProjectMemories()`。`projects.length === 0` 时显示「还没有任何项目记忆」。

在 MEMORY 区的每个条目旁加「移到项目档」下拉（选一个项目根）：

```tsx
async function moveToProject(entry: string, root: string) {
  const target = projects.find((p) => p.root === root);
  const nextProject = target?.text ? `${target.text}\n§\n${entry}` : entry;
  await bridge.saveMemory("project", nextProject, undefined, root);
  await bridge.forgetMemory("memory", entry, MEMORY_EDITS_SESSION);
  setProjects(await bridge.listProjectMemories());
}
```

> 顺序是「先写入项目档、再从全局删」：中途失败宁可重复一条（用户看得见能删），不可丢失。

`memoryChips.ts` / `memory-chips.tsx`：「忘掉」按钮的调用带上当前会话的 `projectRoot`（从 store 里那条 `memory_loaded` 取）。

- [ ] **Step 6: 跑门禁 + e2e**

```bash
export PATH=/Users/stanyan/.hermes/node/bin:$PATH && npm test
```

```bash
export PATH=/Users/stanyan/.hermes/node/bin:$PATH && npm run e2e
```

预期：`npm test` 全绿；e2e 全绿（GUI 改动的 PR 按 ADR-0058 要贴 e2e 结果）

- [ ] **Step 7: 提交**

```bash
git add src/shared/shellBridge.ts src/main/memoryEdit.ts src/main/index.ts src/renderer/src tests/main/memoryEdit.test.ts
git commit -m "feat(memory): 设置页三区 + 项目切换 + 移到项目档

项目档那区必须能切换看哪个项目，否则只看得见当前会话那份，历史项目的记忆
变成看不见的黑洞。列表从 projects/*/root.txt 现扫（目录自描述，无中心索引）；
没有 root.txt 的孤儿目录不列。

「移到项目档」是「不写迁移代码」那个决策的配套。先写入项目档再从全局删：
中途失败宁可重复一条，不可丢失。"
```

---

### Task 7: memory-reviewer 认三档

**Files:**
- Modify: `src/main/builtinSubagents.ts`（memory-reviewer 的指令）
- Modify: `src/main/subagentRunner.ts` 或 nudge 派活处（把项目档一起喂给 reviewer）
- Test: `tests/main/builtinSubagents.test.ts`（扩充）

**Interfaces:**
- Consumes: Task 3 的 `MemoryLoadedEvent.project` / `projectRoot`
- Produces: 无新导出，只改提示词与喂给 reviewer 的转写内容

- [ ] **Step 1: 写失败的测试**

```ts
it("memory-reviewer 的指令写明三档判据", () => {
  const def = builtinSubagents().find((s) => s.name === "memory-reviewer")!;
  expect(def.instructions).toContain("PROJECT");
  expect(def.instructions).toContain("拿不准");
});
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
export PATH=/Users/stanyan/.hermes/node/bin:$PATH && npx vitest run tests/main/builtinSubagents.test.ts
```

预期：FAIL

- [ ] **Step 3: 改 reviewer 指令**

在 memory-reviewer 的 instructions 里，「当前 MEMORY / 当前 USER」那段之后加：

```
当前 PROJECT（{projectRoot}）：
{project}

三档判据：PROJECT 记只在这个项目为真的事（该项目的门禁命令、构建怪癖、约定）；
MEMORY 记换个项目也成立的事（本机环境、工具怪癖）；USER 记关于用户本人的事。
拿不准就写 MEMORY——错放全局只是噪音，错放项目档是丢失。
没有项目档时（工作区不在 git 仓库里）只有两档，别提 PROJECT。
```

nudge 派活处把 `project` / `projectRoot` 一起拼进给 reviewer 的转写（读的是**当前磁盘最新版**，同现有 `nudgeMemory` 的做法，不是喂旧投影）。

- [ ] **Step 4: 跑门禁**

```bash
export PATH=/Users/stanyan/.hermes/node/bin:$PATH && npm test
```

预期：全绿

- [ ] **Step 5: 提交**

```bash
git add src/main/builtinSubagents.ts src/main/subagentRunner.ts tests/main/builtinSubagents.test.ts
git commit -m "feat(memory): memory-reviewer 认三档

不改的话 nudge 派出去的整理会把项目级条目往全局档塞，正好和这次改动反着来。"
```

---

## 收尾（不是 Task，是协议动作）

- [ ] 写 ADR 进 `docs/adr/`（编号 merge 时认领，当前最大 0108）：记「记忆按项目分级」这个决策 + 五条决策理由 + 各自的推翻前提。推翻 `docs/superpowers/specs/2026-08-22-memory-design.md` 决策表里的「不分 workspace」。
- [ ] 更新 `AGENTS.md` 的「Where to find things」索引，加 `src/main/projectRoot.ts` 一行（L2 自治层，随本 PR 走）。
- [ ] 开 Task issue，PR 里写 `closes #N`。
- [ ] PR 描述贴 `npm test` 与 `npm run e2e` 结果（ADR-0058）。
