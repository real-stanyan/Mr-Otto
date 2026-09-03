# Default 按会话分格 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每个任务会话在内置 Default 下拿自己的子文件夹 `<内置 Default>/<sessionId>/`，取代所有任务会话共写一个平铺 Default（issue #851，spec §4）。

**Architecture:** 一个纯函数模块 `src/shared/defaultWorkspace.ts` 同时回答主进程和渲染层的「这是不是任务会话」（父目录 = 内置 Default，或旧日志里直接等于 Default 根）。主进程在 `startSession` / 两条导入路径先铸 sessionId、再算子目录、再 mkdir，把 id 经 `presetSessionId` 递进 `createAgent`。渲染层七处 `s.workspace === builtin` 全换成同一个纯函数。岛的分组镜头把子目录折回 Default 根。设置页加「清理空的任务文件夹」。

**Tech Stack:** TypeScript strict / Electron main / React + Zustand / vitest（tests/ 镜像 src/）。

**Spec:** `docs/superpowers/specs/2026-09-02-topic-memory-design.md` §4（已批准）。

## Global Constraints

- 硬规则：投影必须可从日志推导；`session_created.workspaceKind: "default"` 照旧在建会话那一刻落盘，任何投影不现场读设置。
- 硬规则：渲染进程只经 `ShellBridge`；新增 IPC 三件套（`src/shared/shellBridge.ts` 接口 + `CHANNELS` / `src/preload/index.ts` / `src/main/index.ts` 的 `ipcMain.handle`）。
- 硬规则：`src/shared/**` 不 import `node:*`（`tests/architecture.test.ts` 会红）。
- 旧日志兼容：旧会话的 workspace 直接等于 Default 根，**照旧算任务会话**。
- **Ruling（推翻 spec 的「sessionId 前 8 位」）**：sessionId 形如 `s-20260903111128-a1b2c3d4`（`src/main/agent.ts:142`），前 8 位是 `s-202609`，同月全撞。子目录名 = **完整 sessionId**。理由：唯一、Finder 里按时间排序、能直接对上会话。写进 ADR。
- **Ruling**：`PACKAGE_NUDGE`（`src/session/deriveMessages.ts`）本轮**不改**。它只是 workspaceKind 的函数，改了旧会话（共写根目录）的提示也跟着变；防串扰那几句在独占文件夹里无害。写进 ADR。
- 用户自定义默认工作文件夹（`settings.defaultWorkspace !== null`）**不分格**。
- 归档不删子目录；清理只删**空**目录，且只删名字像 sessionId 的目录。
- 提交信息说 why，结尾两行 trailer：
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015N1T6gUXP7aTA5qRNBgcxt
  ```
- 内循环 `npx vitest run <file>`；每个 task 结束前 `npm test` 全绿。

---

### Task 1: 纯函数 `src/shared/defaultWorkspace.ts`

**Files:**
- Create: `src/shared/defaultWorkspace.ts`
- Test: `tests/shared/defaultWorkspace.test.ts`

**Interfaces:**
- Produces:
  - `parentDir(p: string): string | null` — 去掉末尾分隔符后取父目录；`/` 与 `\` 都认；没有父目录回 null
  - `isDefaultWorkspace(workspace: string | null, builtin: string | null): boolean` — `workspace === builtin || parentDir(workspace) === builtin`
  - `sessionWorkspaceUnder(builtin: string, sessionId: string): string` — `${builtin}/${sessionId}`，分隔符跟 builtin 里已有的走（含 `\` 用 `\`，否则 `/`）
  - `SESSION_FOLDER_RE = /^s-\d{14}-[0-9a-f]{8}$/`，`isSessionFolderName(name: string): boolean`

- [ ] **Step 1: 写失败测试**

```ts
// tests/shared/defaultWorkspace.test.ts
import { describe, expect, it } from "vitest";
import {
  isDefaultWorkspace,
  isSessionFolderName,
  parentDir,
  sessionWorkspaceUnder,
} from "../../src/shared/defaultWorkspace.js";

const DEF = "/Users/x/Documents/Mr Otto/Default";

describe("parentDir", () => {
  it("posix / windows 都认，末尾分隔符先剥", () => {
    expect(parentDir("/a/b/c")).toBe("/a/b");
    expect(parentDir("/a/b/c/")).toBe("/a/b");
    expect(parentDir("C:\\a\\b")).toBe("C:\\a");
    expect(parentDir("/")).toBeNull();
    expect(parentDir("")).toBeNull();
  });
});

describe("isDefaultWorkspace —— 任务会话的唯一判据", () => {
  it("旧形状：workspace 直接等于 Default 根", () => {
    expect(isDefaultWorkspace(DEF, DEF)).toBe(true);
  });
  it("新形状：父目录 = Default 根", () => {
    expect(isDefaultWorkspace(`${DEF}/s-20260903111128-a1b2c3d4`, DEF)).toBe(true);
  });
  it("孙目录 / 别的项目 / null 都不算", () => {
    expect(isDefaultWorkspace(`${DEF}/s-1/deeper`, DEF)).toBe(false);
    expect(isDefaultWorkspace("/p/x", DEF)).toBe(false);
    expect(isDefaultWorkspace(null, DEF)).toBe(false);
    expect(isDefaultWorkspace(DEF, null)).toBe(false);
  });
  it("前缀撞名不算：Default2 不是 Default 的孩子", () => {
    expect(isDefaultWorkspace(`${DEF}2/s-1`, DEF)).toBe(false);
  });
});

describe("sessionWorkspaceUnder", () => {
  it("分隔符跟 builtin 走", () => {
    expect(sessionWorkspaceUnder(DEF, "s-1")).toBe(`${DEF}/s-1`);
    expect(sessionWorkspaceUnder("C:\\Docs\\Default", "s-1")).toBe("C:\\Docs\\Default\\s-1");
  });
  it("与 isDefaultWorkspace 互为逆", () => {
    expect(isDefaultWorkspace(sessionWorkspaceUnder(DEF, "s-20260903111128-a1b2c3d4"), DEF)).toBe(true);
  });
});

describe("isSessionFolderName —— 清理只认这个形状", () => {
  it("完整 sessionId 认，别的一律不认", () => {
    expect(isSessionFolderName("s-20260903111128-a1b2c3d4")).toBe(true);
    expect(isSessionFolderName("report")).toBe(false);
    expect(isSessionFolderName("s-202609")).toBe(false);
    expect(isSessionFolderName("s-20260903111128-A1B2C3D4")).toBe(false);
  });
});
```

- [ ] **Step 2: 跑，确认 fail**（模块不存在）

`npx vitest run tests/shared/defaultWorkspace.test.ts`

- [ ] **Step 3: 实现**

```ts
// src/shared/defaultWorkspace.ts
// 任务会话与内置 Default 的关系（#851，spec §4）——纯函数，主进程与渲染层共用一份。
//
// 为什么判据是「父目录 = Default 根」而不是「等于 Default 根」：#851 之后每个任务
// 会话拿自己的子文件夹 <Default>/<sessionId>/，而旧日志里的会话 workspace 直接就是
// Default 根——两种形状都得算任务会话，不然升级后旧任务全部跳到「项目」栏。
// 为什么不用 path 模块：src/shared 不 import node:*（架构测试），且渲染层也要用。

/** 末尾分隔符先剥，再取父目录；没有父目录（根 / 空串）回 null */
export function parentDir(p: string): string | null {
  const trimmed = p.replace(/[\\/]+$/, "");
  if (!trimmed) return null;
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx <= 0) return null;
  return trimmed.slice(0, idx);
}

/** 这个 workspace 是不是任务会话的工作区：等于 Default 根（旧形状）或父目录是它（新形状） */
export function isDefaultWorkspace(workspace: string | null, builtin: string | null): boolean {
  if (!workspace || !builtin) return false;
  if (workspace === builtin) return true;
  return parentDir(workspace) === builtin;
}

/** 分隔符跟 builtin 走：路径来自 Electron 的 app.getPath，Windows 上是反斜杠 */
export function sessionWorkspaceUnder(builtin: string, sessionId: string): string {
  const sep = builtin.includes("\\") && !builtin.includes("/") ? "\\" : "/";
  return `${builtin.replace(/[\\/]+$/, "")}${sep}${sessionId}`;
}

/** sessionId 的形状（src/main/agent.ts newSessionId）：清理空文件夹只认这个 */
export const SESSION_FOLDER_RE = /^s-\d{14}-[0-9a-f]{8}$/;

export function isSessionFolderName(name: string): boolean {
  return SESSION_FOLDER_RE.test(name);
}

```

- [ ] **Step 4: 跑，确认 pass**；`npm test`
- [ ] **Step 5: Commit** — `feat(workspace): 任务会话判据抽成纯函数 isDefaultWorkspace（#851）`

---

### Task 2: 主进程分配子文件夹（startSession + 两条导入 + createAgent.presetSessionId）

**Files:**
- Create: `src/main/taskWorkspace.ts`
- Modify: `src/main/agent.ts`（`createAgent` opts + sessionId 铸造行，约 :204 与 :307）
- Modify: `src/main/index.ts`（`createSessionAgent` :2087-2114 的 `isDefaultWorkspace`；`startSession` :2477-2503；`workspaceImportSession` :3272-3276；`importSharedSession` :3369-3373）
- Test: `tests/main/taskWorkspace.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `isDefaultWorkspace` / `sessionWorkspaceUnder`；`newSessionId()`（`src/main/agent.ts:142`，已 export）
- Produces:
  - `src/main/taskWorkspace.ts`:
    ```ts
    export interface WorkspaceInfoLike { defaultWorkspace: string; builtin: boolean; builtinWorkspace: string }
    export interface AllocatedWorkspace { workspace: string; sessionId: string | null }
    /** 渲染层递来的 workspace 若是「当前兜底」：内置 Default → 铸 id、算子目录、mkdir；
        自定义兜底 → 只 mkdir 不分格；其它路径原样回、不 mkdir */
    export function allocateSessionWorkspace(
      requested: string,
      info: WorkspaceInfoLike,
      deps: { mint: () => string; mkdir: (abs: string) => void },
    ): AllocatedWorkspace
    ```
  - `createAgent` 新 opt `presetSessionId?: string`：`const sessionId = opts.resumeSessionId ?? opts.presetSessionId ?? newSessionId();`
  - `createSessionAgent` 新 arg `presetSessionId?: string`，透传进 `base`

- [ ] **Step 1: 写失败测试**

```ts
// tests/main/taskWorkspace.test.ts
import { describe, expect, it } from "vitest";
import { allocateSessionWorkspace } from "../../src/main/taskWorkspace.js";

const BUILTIN = "/docs/Mr Otto/Default";
const builtinInfo = { defaultWorkspace: BUILTIN, builtin: true, builtinWorkspace: BUILTIN };
const customInfo = { defaultWorkspace: "/me/work", builtin: false, builtinWorkspace: BUILTIN };

function deps() {
  const made: string[] = [];
  return { made, mint: () => "s-20260903111128-a1b2c3d4", mkdir: (abs: string) => made.push(abs) };
}

describe("allocateSessionWorkspace（#851）", () => {
  it("内置 Default：铸 id、子目录、mkdir 子目录", () => {
    const d = deps();
    const r = allocateSessionWorkspace(BUILTIN, builtinInfo, d);
    expect(r).toEqual({ workspace: `${BUILTIN}/s-20260903111128-a1b2c3d4`, sessionId: "s-20260903111128-a1b2c3d4" });
    expect(d.made).toEqual([`${BUILTIN}/s-20260903111128-a1b2c3d4`]);
  });
  it("自定义兜底：不分格，只 mkdir 本身，不铸 id", () => {
    const d = deps();
    const r = allocateSessionWorkspace("/me/work", customInfo, d);
    expect(r).toEqual({ workspace: "/me/work", sessionId: null });
    expect(d.made).toEqual(["/me/work"]);
  });
  it("别的路径：原样回、不 mkdir（别替渲染层传来的任意路径建目录）", () => {
    const d = deps();
    expect(allocateSessionWorkspace("/p/x", builtinInfo, d)).toEqual({ workspace: "/p/x", sessionId: null });
    expect(d.made).toEqual([]);
  });
  it("自定义兜底生效时递来内置 Default 路径也不分格（它此刻不是兜底）", () => {
    const d = deps();
    expect(allocateSessionWorkspace(BUILTIN, customInfo, d)).toEqual({ workspace: BUILTIN, sessionId: null });
    expect(d.made).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑，确认 fail**
- [ ] **Step 3: 实现 `src/main/taskWorkspace.ts`**

```ts
// src/main/taskWorkspace.ts
// 任务会话的工作区分配（#851）：内置 Default 下按会话分格。
// 只在「渲染层递来的正是当前兜底路径」时动手——别替任意路径 mkdir（#559 的旧规矩不变）。
// sessionId 在这里先铸出来再递给 createAgent（presetSessionId）：子目录名要用它，
// 而 createAgent 原本是在里面才铸 id 的。
import { sessionWorkspaceUnder } from "../shared/defaultWorkspace.js";

export interface WorkspaceInfoLike {
  defaultWorkspace: string;
  builtin: boolean;
  builtinWorkspace: string;
}

export interface AllocatedWorkspace {
  workspace: string;
  /** 分格了才有：子目录名 = 这个 id，建会话时必须用同一个 */
  sessionId: string | null;
}

export function allocateSessionWorkspace(
  requested: string,
  info: WorkspaceInfoLike,
  deps: { mint: () => string; mkdir: (abs: string) => void },
): AllocatedWorkspace {
  if (requested !== info.defaultWorkspace) return { workspace: requested, sessionId: null };
  if (!info.builtin) {
    // 用户自己的文件夹：往里塞哈希子目录是越界（spec §4）
    deps.mkdir(requested);
    return { workspace: requested, sessionId: null };
  }
  const sessionId = deps.mint();
  const workspace = sessionWorkspaceUnder(info.builtinWorkspace, sessionId);
  deps.mkdir(workspace);
  return { workspace, sessionId };
}
```

- [ ] **Step 4: `createAgent` 加 `presetSessionId`**

`src/main/agent.ts` opts 接口（`resumeSessionId?: string;` 附近）加：
```ts
  /** 建会话前就铸好的 id（#851：Default 子目录名要用它）。resume 优先；两者都没给才现铸 */
  presetSessionId?: string;
```
铸造行改为：
```ts
  const sessionId = opts.resumeSessionId ?? opts.presetSessionId ?? newSessionId();
```

- [ ] **Step 5: `createSessionAgent`**

args 加 `presetSessionId?: string;`；`isDefaultWorkspace` 判定改为：
```ts
    const isDefaultWorkspace =
      !args.child && !args.sideOf &&
      isDefaultWorkspaceOf(args.workspace, builtinDefaultWorkspace(app.getPath("documents")));
```
（`import { isDefaultWorkspace as isDefaultWorkspaceOf } from "../shared/defaultWorkspace.js";` 避免与局部常量撞名）。`base` 里加 `...(args.presetSessionId ? { presetSessionId: args.presetSessionId } : {}),`。

- [ ] **Step 6: `startSession` handler**

把 :2481-2486 那段 mkdir 换成：
```ts
    // 兜底工作区惰性创建（#559）+ 内置 Default 按会话分格（#851）：
    // 只在「等于当前兜底路径」时动手，别替渲染层传来的任意路径 mkdir
    const alloc = allocateSessionWorkspace(opts.workspace, workspaceSettingsInfo(), {
      mint: newSessionId,
      mkdir: (abs) => mkdirSync(abs, { recursive: true }),
    });
```
后面 `shouldIsolate` / `createSessionAgent` 里所有 `opts.workspace` 换成 `alloc.workspace`，并在 `createSessionAgent` 的 args 里加 `...(alloc.sessionId ? { presetSessionId: alloc.sessionId } : {})`。

- [ ] **Step 7: 两条导入路径**

`workspaceImportSession`（:3272-3276）：
```ts
    const alloc = allocateSessionWorkspace(workspaceSettingsInfo().defaultWorkspace, workspaceSettingsInfo(), {
      mint: newSessionId,
      mkdir: (abs) => mkdirSync(abs, { recursive: true }),
    });
```
然后 `importWorkspaceSession(...)` 用 `alloc.workspace` 当工作目录；它的 deps 里 `newSessionId` 改为 `() => alloc.sessionId ?? newSessionId()`（读一下该调用处 deps 的形状再改，`importWorkspaceSession` 在 `src/main/workspaceSessionShare.ts:163`）。

`importSharedSession` handler（:3369-3373）同法：`workspace` 非空且等于兜底时走 `allocateSessionWorkspace`，deps 的 `newSessionId` 回预铸 id（`src/main/sessionShareReceive.ts:22` 的 `deps.newSessionId`）。**两处都要保证：分格了的话，子目录名与新会话 id 一致**。

- [ ] **Step 8: `npm test` 全绿；手动 grep**

`grep -n 'opts.workspace' src/main/index.ts` 确认 startSession 里没漏改。

- [ ] **Step 9: Commit** — `feat(workspace): 内置 Default 按会话分格——startSession 与两条导入先铸 id 再 mkdir 子目录（#851）`

---

### Task 3: 渲染层任务栏判据换纯函数

**Files:**
- Modify: `src/renderer/src/sessionGroups.ts:93-104`（`taskSessions` / `archivedTaskSessions`）
- Modify: `src/renderer/src/App.tsx`（:1720、:1735、:1826、:1901 四处 `=== builtin` / `!== builtin`；:1879 与 :1995、:2734、:3476 只读一眼确认不用改——它们传的是 builtin 根本身，主进程负责分配子目录）
- Test: `tests/renderer/sessionGroups.test.ts`

**Interfaces:**
- Consumes: Task 1 `isDefaultWorkspace`

- [ ] **Step 1: 写失败测试**（追加到 `tests/renderer/sessionGroups.test.ts` 的 `taskSessions` describe 里）

```ts
  it("#851：Default 子目录里的会话也算任务；旧形状（等于根）照旧", () => {
    const list = taskSessions([s("new", `${DEF}/s-20260903111128-a1b2c3d4`, 300), s("old", DEF, 200), s("proj", "/p/x", 100)], DEF);
    expect(list.map((x) => x.sessionId)).toEqual(["new", "old"]);
  });
  it("#851：归档那半同一判据", () => {
    const a = { ...s("x", `${DEF}/s-20260903111128-a1b2c3d4`, 1), archived: true };
    expect(archivedTaskSessions([a], DEF).map((x) => x.sessionId)).toEqual(["x"]);
  });
```

- [ ] **Step 2: 跑，确认 fail**
- [ ] **Step 3: 实现**

`sessionGroups.ts` 两个函数的 `s.workspace === builtin` 换成 `isDefaultWorkspace(s.workspace, builtin)`（import 自 `../../shared/defaultWorkspace.js`，路径按文件位置算）。

`App.tsx`：
- :1720 `s.workspace !== builtin` → `!isDefaultWorkspace(s.workspace, builtin)`
- :1735 `sessions.filter((s) => s.workspace !== builtin)` → `!isDefaultWorkspace(...)`
- :1826 `s.workspace === builtin &&` → `isDefaultWorkspace(s.workspace, builtin) &&`
- :1901 同 :1720

- [ ] **Step 4: `npm test`**；`grep -n '=== builtin\|!== builtin' src/renderer/src/App.tsx src/renderer/src/sessionGroups.ts` 应为 0 命中
- [ ] **Step 5: Commit** — `feat(sidebar): 任务栏判据换 isDefaultWorkspace，子目录会话不再掉进项目栏（#851）`

---

### Task 4: 岛的分组镜头把子目录折回 Default

**Files:**
- Modify: `src/main/workspaceLens.ts`（加 `withDefaultFold`）
- Modify: `src/main/index.ts:927`（`createWorkspaceLens()` 外面包一层）
- Test: `tests/main/workspaceLens.test.ts`（已存在则追加，不存在则新建）

**Interfaces:**
- Produces: `withDefaultFold(lens: WorkspaceLens, builtin: string): WorkspaceLens` — `isDefaultWorkspace(ws, builtin)` 时回 `{ projectRoot: builtin, branch: null }`，否则透传

- [ ] **Step 1: 失败测试**

```ts
import { describe, expect, it } from "vitest";
import { localWorkspaceLens, withDefaultFold } from "../../src/main/workspaceLens.js";

const DEF = "/docs/Mr Otto/Default";

describe("withDefaultFold（#851）", () => {
  it("Default 子目录折回 Default 根：岛上所有任务一组", () => {
    const lens = withDefaultFold(localWorkspaceLens, DEF);
    expect(lens(`${DEF}/s-20260903111128-a1b2c3d4`)).toEqual({ projectRoot: DEF, branch: null });
    expect(lens(DEF)).toEqual({ projectRoot: DEF, branch: null });
  });
  it("别的路径透传给内层镜头", () => {
    const inner = (ws: string) => ({ projectRoot: `root-of:${ws}`, branch: "b" });
    expect(withDefaultFold(inner, DEF)("/p/x")).toEqual({ projectRoot: "root-of:/p/x", branch: "b" });
  });
});
```

- [ ] **Step 2: 跑 fail** → **Step 3: 实现**

```ts
/** #851：Default 子目录在岛上折回 Default 根——组头回答「这是哪个项目」，
    而所有任务会话都属于同一个「Default」。不折的话每个任务各占一组 */
export function withDefaultFold(lens: WorkspaceLens, builtin: string): WorkspaceLens {
  return (workspace) =>
    isDefaultWorkspace(workspace, builtin) ? { projectRoot: builtin, branch: null } : lens(workspace);
}
```
index.ts :927 → `const workspaceLens = withDefaultFold(createWorkspaceLens(), builtinDefaultWorkspace(app.getPath("documents")));`

- [ ] **Step 4: `npm test`** → **Step 5: Commit** — `feat(island): Default 子目录折回一组（#851）`

---

### Task 5: 设置页「清理空的任务文件夹」

**Files:**
- Create: `src/main/taskFolderPrune.ts`
- Modify: `src/shared/shellBridge.ts`（接口 + `CHANNELS`）、`src/preload/index.ts`、`src/main/index.ts`（handler）
- Modify: `src/renderer/src/store.ts`（一个 action）、`src/renderer/src/components/WorkspaceSettings.tsx`
- Test: `tests/main/taskFolderPrune.test.ts`

**Interfaces:**
- ShellBridge: `pruneEmptyTaskFolders(): Promise<{ removed: number; kept: number }>`；channel `pruneEmptyTaskFolders: "otter:pruneEmptyTaskFolders"`
- `src/main/taskFolderPrune.ts`:
  ```ts
  export interface PruneFs {
    list(dir: string): { name: string; isDir: boolean }[];   // 目录不存在回 []
    rmdirIfEmpty(abs: string): boolean;                       // 空则删回 true；非空/失败回 false
  }
  export function pruneEmptyTaskFolders(builtin: string, fs: PruneFs): { removed: number; kept: number }
  export const nodePruneFs: PruneFs  // readdirSync withFileTypes + rmdirSync（非递归，ENOTEMPTY 回 false）
  ```

- [ ] **Step 1: 失败测试**

```ts
import { describe, expect, it } from "vitest";
import { pruneEmptyTaskFolders, type PruneFs } from "../../src/main/taskFolderPrune.js";

const DEF = "/docs/Mr Otto/Default";
function fakeFs(entries: { name: string; isDir: boolean; empty: boolean }[]): PruneFs & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    list: () => entries.map((e) => ({ name: e.name, isDir: e.isDir })),
    rmdirIfEmpty: (abs) => {
      const e = entries.find((x) => abs.endsWith(x.name));
      if (!e || !e.empty) return false;
      removed.push(abs);
      return true;
    },
  };
}

describe("pruneEmptyTaskFolders（#851）", () => {
  it("只删名字像 sessionId 且为空的目录；非空的记 kept；别的名字碰都不碰", () => {
    const fs = fakeFs([
      { name: "s-20260903111128-a1b2c3d4", isDir: true, empty: true },
      { name: "s-20260903111129-b1b2c3d4", isDir: true, empty: false },
      { name: "report.md", isDir: false, empty: true },
      { name: "my-notes", isDir: true, empty: true },
    ]);
    expect(pruneEmptyTaskFolders(DEF, fs)).toEqual({ removed: 1, kept: 1 });
    expect(fs.removed).toEqual([`${DEF}/s-20260903111128-a1b2c3d4`]);
  });
  it("Default 还没出生：0/0", () => {
    expect(pruneEmptyTaskFolders(DEF, fakeFs([]))).toEqual({ removed: 0, kept: 0 });
  });
});
```

- [ ] **Step 2: fail** → **Step 3: 实现**

```ts
// src/main/taskFolderPrune.ts
// 设置页「清理空的任务文件夹」（#851）：归档不删子目录（用户产物不因归档消失），
// 于是空壳会攒起来。只删两个条件都满足的：名字是 sessionId 形状 + 目录为空。
// rmdir 非递归——非空目录 ENOTEMPTY 就是「留着」，不是错误。
import { readdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { isSessionFolderName, sessionWorkspaceUnder } from "../shared/defaultWorkspace.js";

export interface PruneFs {
  list(dir: string): { name: string; isDir: boolean }[];
  rmdirIfEmpty(abs: string): boolean;
}

export function pruneEmptyTaskFolders(builtin: string, fs: PruneFs): { removed: number; kept: number } {
  let removed = 0;
  let kept = 0;
  for (const e of fs.list(builtin)) {
    if (!e.isDir || !isSessionFolderName(e.name)) continue;
    if (fs.rmdirIfEmpty(sessionWorkspaceUnder(builtin, e.name))) removed++;
    else kept++;
  }
  return { removed, kept };
}

export const nodePruneFs: PruneFs = {
  list(dir) {
    try {
      return readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, isDir: d.isDirectory() }));
    } catch {
      return [];
    }
  },
  rmdirIfEmpty(abs) {
    try {
      rmdirSync(abs);
      return true;
    } catch {
      return false;
    }
  },
};
```
`join` 若未用则不要 import。

- [ ] **Step 4: IPC 三件套**

`shellBridge.ts` 接口（放在 `setDefaultWorkspace` 旁）：
```ts
  /** 删掉内置 Default 下空的任务文件夹（#851）。只删空的、只删名字像 sessionId 的 */
  pruneEmptyTaskFolders(): Promise<{ removed: number; kept: number }>;
```
`CHANNELS` 加 `pruneEmptyTaskFolders: "otter:pruneEmptyTaskFolders",`；preload 照 `setDefaultWorkspace` 的写法加一行；index.ts：
```ts
  ipcMain.handle(CHANNELS.pruneEmptyTaskFolders, () =>
    pruneEmptyTaskFolders(builtinDefaultWorkspace(app.getPath("documents")), nodePruneFs)
  );
```

- [ ] **Step 5: 渲染层**

`store.ts` 在 `setDefaultWorkspace` 旁加 `pruneEmptyTaskFolders: () => bridge.pruneEmptyTaskFolders()`（按该文件既有 action 的写法与类型声明）。

`WorkspaceSettings.tsx`：
- 提示文案 `水獭做出来的东西会放在「文档 › Mr Otto › Default」里，随时打开文件夹就能看到。` → `水獭做出来的东西会放在「文档 › Mr Otto › Default」里，每个任务一个子文件夹，随时打开就能看到。`
- 在那张卡片下面加一行（不管 builtin 与否都显示——内置 Default 的路径恒定）：
```tsx
        <div className="flex items-center gap-3 rounded-[10px] border border-border px-[14px] py-3">
          <div className="flex flex-col gap-0.5 flex-1 min-w-0">
            <span className="text-[13px] font-medium">清理空的任务文件夹</span>
            <span className={HINT}>
              归档不会删掉任务的文件夹。这里只删空的，里面有东西的一律留着。
            </span>
            {pruned && (
              <span className={HINT}>
                {pruned.removed === 0 ? "没有空文件夹" : `已清理 ${pruned.removed} 个`}
                {pruned.kept > 0 ? `，${pruned.kept} 个有内容留着` : ""}
              </span>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={() => void prune()}>
            清理
          </Button>
        </div>
```
组件里：
```tsx
  const pruneEmptyTaskFolders = useChat((s) => s.pruneEmptyTaskFolders);
  const [pruned, setPruned] = useState<{ removed: number; kept: number } | null>(null);
  const prune = async () => setPruned(await pruneEmptyTaskFolders());
```
不加动画：设置页里偶尔点一次的按钮，用既有 `Button` 的按压反馈即可。

- [ ] **Step 6: `npm test`** → **Step 7: Commit** — `feat(settings): 清理空的任务文件夹（#851）`

---

### Task 6: ADR + CONTEXT.md + AGENTS.md 索引

**Files:**
- Create: `docs/adr/0205-内置Default按会话分格.md`（编号合并时再核，ADR-0074）
- Modify: `CONTEXT.md`（产品/技术术语表加一行「任务文件夹」）
- Modify: `AGENTS.md`（Where to find things：`src/main/projectPackager.ts` 那行末尾追加 `src/shared/defaultWorkspace.ts` / `src/main/taskWorkspace.ts` / `taskFolderPrune.ts` 的指针）

- [ ] **Step 1: 写 ADR**，结构照 `docs/adr/0204-*.md`：标题、日期 2026-09-03、状态 已定、关联 #851 / ADR-0135（推进：workspaceKind 判定变了）/ ADR-0204。内容：
  1. 决定：会话工作区 = `<内置 Default>/<sessionId>/`，惰性 mkdir，只对内置 Default；`isDefaultWorkspace` 纯函数两种形状都认；`presetSessionId` 先铸后建。
  2. **子目录名用完整 sessionId 不用前 8 位**（spec 的假设是 uuid 形状，实际 id 有时间戳前缀，前 8 位同月全撞）。
  3. **PACKAGE_NUDGE 不改**（投影只是 workspaceKind 的函数，旧会话仍共写根目录；防串扰句在独占目录里无害）。
  4. 岛上折回一组（`withDefaultFold`）。
  5. 归档不删、清理只删空且名字像 id 的。
  6. 被否的路（抄 spec §4）。
  7. 什么前提垮了要重看：sessionId 形状变了 → `SESSION_FOLDER_RE` 与清理一起改；Default 不再是文档区固定路径 → `isDefaultWorkspace` 的判据重审。
- [ ] **Step 2: CONTEXT.md 一行**：`| 任务文件夹 | 内置 Default 下每个任务会话一个子目录 \`<Default>/<sessionId>/\`，旧会话直接等于 Default 根也算任务；归档不删，设置页可清空壳 | ADR-0205、#851 |`
- [ ] **Step 3: AGENTS.md 索引**（L2，随 PR 走）
- [ ] **Step 4: `npm test`**（adrNumbers 测试要过）→ **Step 5: Commit** — `docs(adr): 内置 Default 按会话分格（ADR-0205，#851）`
