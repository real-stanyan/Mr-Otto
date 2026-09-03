# 记忆跟账号走（云同步）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 记忆（USER / MEMORY / PROJECT / TOPIC 四档，含 `.label` 与 `root.txt`）跟 Supabase 账号走：本地文件是缓存，云端 `memory_docs` 表是账号级副本，后写胜（issue #852，spec §6）。

**Architecture:** 主进程新增一个**唯一的记忆文件读写口** `src/main/memoryFiles.ts`（accountConfig 下 `memories/` 前缀的所有读/写/删都经它，写完回调 `onWrite(rel)`）；`LocalWorld` 的 config 能力加一个 `onConfigWrite` 钩子（工具那条写路径），两条钩子都汇进 `src/main/memorySync.ts`：防抖上传（同 `pxEscrowSync` 的模式）、登录后全量对账（纯函数 `src/shared/memoryReconcile.ts` 决定谁胜）。云端一张表 `memory_docs(uid, key, content, updated_at)`，RLS 只允本人，薄 API 在 `src/main/supabaseMemoryDocsApi.ts`。架构测试钉住「碰 memories/ 路径的文件不许同时 import node:fs，除了 memoryFiles.ts」。

**Tech Stack:** TypeScript strict / Electron main / supabase-js（已有 `supabase.raw` client）/ vitest。

**Spec:** `docs/superpowers/specs/2026-09-02-topic-memory-design.md` §6（已批准）。

## Global Constraints

- 硬规则：工具只依赖 `ExecutionWorld`；`src/tools/memory.ts` **零改动**。`src/shared/**` 不 import `node:*`。
- 硬规则：渲染进程只经 `ShellBridge`；新增 IPC 三件套（`src/shared/shellBridge.ts` 接口 + `CHANNELS` / `src/preload/index.ts` / `src/main/index.ts` 的 `ipcMain.handle`）。
- 离线 / 未登录：只读写本地，**不阻塞会话开始**，不抛错到调用方；回线（下次登录恢复）补推。
- 登出**不清**本地抽屉（ADR-0187 的账号抽屉本来就按 uid 隔离）。
- 后写胜：比较云端 `updated_at` 与本地 mtime；**内容相同直接跳过**，不打网络。
- 从云端写到本地的那次写**不得**再触发上传（否则死循环）。
- 表名 `memory_docs`，列 `uid uuid / key text / content text / updated_at timestamptz`，主键 `(uid, key)`；`key` = `memoryRelPath` 的相对路径（`memories/USER.md` 这种）。migration 编号 **0018**（0017 已被订阅制占了，issue 里写的 0017 作废）。
- 提交信息说 why，结尾两行 trailer：
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015N1T6gUXP7aTA5qRNBgcxt
  ```
- 内循环 `npx vitest run <file>`；每个 task 结束前 `npm test` 全绿。

---

### Task 1: 纯函数对账 `src/shared/memoryReconcile.ts`

**Files:**
- Create: `src/shared/memoryReconcile.ts`
- Test: `tests/shared/memoryReconcile.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LocalDoc { key: string; content: string; mtimeMs: number }
  export interface CloudDoc { key: string; content: string; updatedAtMs: number }
  export interface ReconcilePlan { pull: CloudDoc[]; push: LocalDoc[] }
  export function planReconcile(local: readonly LocalDoc[], cloud: readonly CloudDoc[]): ReconcilePlan
  ```
  规则：同 key 内容相同 → 什么都不做；只有本地 → push；只有云端 → pull；两边都有且不同 → `updatedAtMs > mtimeMs` 则 pull，否则 push（相等按本地胜——本机刚写的更可能是用户想要的）。输出各自按 key 排序（可测）。

- [ ] **Step 1: 失败测试**

```ts
// tests/shared/memoryReconcile.test.ts
import { describe, expect, it } from "vitest";
import { planReconcile } from "../../src/shared/memoryReconcile.js";

describe("planReconcile —— 后写胜，内容相同不动", () => {
  it("只有本地 → push；只有云端 → pull", () => {
    const p = planReconcile(
      [{ key: "memories/USER.md", content: "a", mtimeMs: 10 }],
      [{ key: "memories/MEMORY.md", content: "b", updatedAtMs: 20 }],
    );
    expect(p.push.map((d) => d.key)).toEqual(["memories/USER.md"]);
    expect(p.pull.map((d) => d.key)).toEqual(["memories/MEMORY.md"]);
  });
  it("两边都有且内容相同 → 不动（不管时间）", () => {
    const p = planReconcile(
      [{ key: "k", content: "same", mtimeMs: 1 }],
      [{ key: "k", content: "same", updatedAtMs: 999 }],
    );
    expect(p).toEqual({ pull: [], push: [] });
  });
  it("内容不同：云端新 → pull；本地新或相等 → push", () => {
    const newer = planReconcile([{ key: "k", content: "l", mtimeMs: 1 }], [{ key: "k", content: "c", updatedAtMs: 2 }]);
    expect(newer.pull.map((d) => d.key)).toEqual(["k"]);
    expect(newer.push).toEqual([]);
    const older = planReconcile([{ key: "k", content: "l", mtimeMs: 3 }], [{ key: "k", content: "c", updatedAtMs: 2 }]);
    expect(older.push.map((d) => d.key)).toEqual(["k"]);
    const tie = planReconcile([{ key: "k", content: "l", mtimeMs: 2 }], [{ key: "k", content: "c", updatedAtMs: 2 }]);
    expect(tie.push.map((d) => d.key)).toEqual(["k"]);
  });
  it("输出按 key 排序，输入不改", () => {
    const local = [{ key: "z", content: "1", mtimeMs: 1 }, { key: "a", content: "1", mtimeMs: 1 }];
    const p = planReconcile(local, []);
    expect(p.push.map((d) => d.key)).toEqual(["a", "z"]);
    expect(local[0]!.key).toBe("z");
  });
});
```

- [ ] **Step 2: 跑 fail** → **Step 3: 实现**

```ts
// src/shared/memoryReconcile.ts
// 记忆云同步的对账（#852，spec §6）：本地文件 vs 云端 memory_docs，谁新谁胜。纯函数，
// 主进程用；手机端将来读同一张表时也能用同一份规则。
//
// 「后写胜」是有损的（两台机同时改同一桶，晚的盖早的）——接受：记忆是策展文本
// 不是账本，真丢了 memory_user_edit 里有 before（ADR-0206）。
// 内容相同直接跳过：不比时间——时间戳来自两台钟，内容才是事实。

export interface LocalDoc {
  key: string;
  content: string;
  mtimeMs: number;
}

export interface CloudDoc {
  key: string;
  content: string;
  updatedAtMs: number;
}

export interface ReconcilePlan {
  /** 云端更新 → 写本地 */
  pull: CloudDoc[];
  /** 本地更新 / 云端没有 → 推上去 */
  push: LocalDoc[];
}

export function planReconcile(local: readonly LocalDoc[], cloud: readonly CloudDoc[]): ReconcilePlan {
  const byKeyLocal = new Map(local.map((d) => [d.key, d]));
  const byKeyCloud = new Map(cloud.map((d) => [d.key, d]));
  const pull: CloudDoc[] = [];
  const push: LocalDoc[] = [];
  for (const l of local) {
    const c = byKeyCloud.get(l.key);
    if (!c) {
      push.push(l);
      continue;
    }
    if (c.content === l.content) continue;
    if (c.updatedAtMs > l.mtimeMs) pull.push(c);
    else push.push(l);
  }
  for (const c of cloud) {
    if (!byKeyLocal.has(c.key)) pull.push(c);
  }
  const byKey = (a: { key: string }, b: { key: string }) => a.key.localeCompare(b.key);
  return { pull: pull.sort(byKey), push: push.sort(byKey) };
}
```

- [ ] **Step 4: 跑 pass；`npm test`** → **Step 5: Commit** — `feat(memory): 云同步对账纯函数 planReconcile（#852）`

---

### Task 2: 唯一读写口 `src/main/memoryFiles.ts` + index.ts 改走它

**Files:**
- Create: `src/main/memoryFiles.ts`
- Modify: `src/main/index.ts`：`readMemoryFile` / `readMemoryFiles`（~2020-2045）、`memoryEditDeps`（~2050-2067）、`annotateAndAppend` 里 `readTopics(join(accountConfig, TOPICS_DIR))`（~1076）、`listProjectMemories` / `deleteProjectMemory` / `listTopicMemories` / `deleteTopicMemory` / `setTopicLabel` 五个 handler（~2710-2765）、`memorySettings` 之类读 `readMemoryFile(memoryRelPath(...))` 的地方（~2674）
- Test: `tests/main/memoryFiles.test.ts`（真临时目录，`os.tmpdir()` + `mkdtempSync`）

**Interfaces:**
- Produces:
  ```ts
  export const MEMORY_PREFIX = "memories/";
  export interface MemoryFiles {
    root: string;
    /** 读；ENOENT → ""（别的错误抛） */
    read(rel: string): Promise<string>;
    /** 同步读；ENOENT → ""；别的错误 console.error 后回 ""（会话装配那条路不能因为记忆文件坏了起不来） */
    readSync(rel: string): string;
    write(rel: string, content: string): Promise<void>;
    /** 删文件；不存在不报错 */
    remove(rel: string): Promise<void>;
    /** 删整个目录（项目档） */
    removeDir(relDir: string): Promise<void>;
    /** memories/ 下所有文件（递归）：{ rel, content, mtimeMs }；目录不存在 → [] */
    walk(): Promise<{ rel: string; content: string; mtimeMs: number }[]>;
    readTopics(): MemoryTopicSnapshot[];              // = readTopics(join(root, TOPICS_DIR))
    listProjects(): Promise<{ root: string; text: string }[]>;
    deleteProject(projectRoot: string): Promise<void>;
    deleteTopic(slug: string): Promise<void>;          // rm .md + .label（调用方先 applyUserEdit 落证）
    setTopicLabel(slug: string, label: string): Promise<void>; // 空白 → 删 .label
    readTiers(workspace: string): { memory: string; user: string; project?: string; projectRoot?: string; topics: MemoryTopicSnapshot[] };
  }
  export function createMemoryFiles(root: string, hooks?: { onWrite?: (rel: string) => void }): MemoryFiles
  ```
  - 所有 `write / remove / removeDir / deleteProject / deleteTopic / setTopicLabel` 完成后对每个受影响的 rel 调 `hooks.onWrite(rel)`（removeDir/deleteProject 对目录下每个文件各调一次，先 walk 目录再删）。
  - 围栏：`rel` 必须以 `memories/` 开头且解析后仍在 `root` 内，否则抛 `Error("记忆路径越界：" + rel)`。
  - `readTiers` = 现 `readMemoryFiles` 的搬家（用 `resolveProjectRoot` + `projectMemoryDir`）。

- [ ] **Step 1: 失败测试**

```ts
// tests/main/memoryFiles.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryFiles, type MemoryFiles } from "../../src/main/memoryFiles.js";

let root: string;
let files: MemoryFiles;
let writes: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "otto-memfiles-"));
  writes = [];
  files = createMemoryFiles(root, { onWrite: (rel) => writes.push(rel) });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("memoryFiles —— memories/ 的唯一读写口（#852）", () => {
  it("write 建目录并回调 onWrite；read 读回；readSync 同", async () => {
    await files.write("memories/USER.md", "hi");
    expect(await files.read("memories/USER.md")).toBe("hi");
    expect(files.readSync("memories/USER.md")).toBe("hi");
    expect(writes).toEqual(["memories/USER.md"]);
  });
  it("没有的文件读成空串，不抛", async () => {
    expect(await files.read("memories/MEMORY.md")).toBe("");
    expect(files.readSync("memories/MEMORY.md")).toBe("");
  });
  it("remove 不存在不报错，存在则删并回调", async () => {
    await files.remove("memories/topics/x.md");
    await files.write("memories/topics/x.md", "1");
    await files.remove("memories/topics/x.md");
    expect(await files.read("memories/topics/x.md")).toBe("");
    expect(writes).toEqual(["memories/topics/x.md", "memories/topics/x.md"]);
  });
  it("walk 递归列出 memories/ 下所有文件，带内容与 mtime；空目录 → []", async () => {
    expect(await files.walk()).toEqual([]);
    await files.write("memories/USER.md", "u");
    await files.write("memories/topics/work.md", "w");
    const w = await files.walk();
    expect(w.map((d) => d.rel).sort()).toEqual(["memories/USER.md", "memories/topics/work.md"]);
    expect(w.every((d) => typeof d.mtimeMs === "number" && d.mtimeMs > 0)).toBe(true);
  });
  it("围栏：不以 memories/ 开头或越界一律抛", async () => {
    await expect(files.write("config.json", "x")).rejects.toThrow(/越界/);
    await expect(files.write("memories/../auth.json", "x")).rejects.toThrow(/越界/);
  });
  it("deleteTopic 删 .md 与 .label 并各回调一次；setTopicLabel 空白 = 删 .label", async () => {
    await files.write("memories/topics/work.md", "w");
    await files.setTopicLabel("work", "工作");
    expect(await files.read("memories/topics/work.label")).toBe("工作");
    await files.setTopicLabel("work", "  ");
    expect(await files.read("memories/topics/work.label")).toBe("");
    await files.deleteTopic("work");
    expect(await files.read("memories/topics/work.md")).toBe("");
    expect(writes.filter((r) => r === "memories/topics/work.label").length).toBe(3);
  });
  it("listProjects 只列有 root.txt 的目录；deleteProject 整目录删并按文件回调", async () => {
    await files.write("memories/projects/abc/root.txt", "/p/x");
    await files.write("memories/projects/abc/MEMORY.md", "m");
    await files.write("memories/projects/orphan/MEMORY.md", "o");
    expect(await files.listProjects()).toEqual([{ root: "/p/x", text: "m" }]);
    writes.length = 0;
    await files.deleteProject("/p/x");
    expect(await files.listProjects()).toEqual([]);
    expect(writes.sort()).toEqual(["memories/projects/abc/MEMORY.md", "memories/projects/abc/root.txt"].sort());
  });
});
```
`deleteProject(root)` 用 `projectMemoryDir(root)` 算目录（`src/main/projectRoot.ts`），测试里 `/p/x` 对应的目录名由它算——测试不猜哈希，只看 `listProjects` 前后与回调的 rel 里含 `root.txt` / `MEMORY.md`：把最后那条断言改成
```ts
    expect(writes.map((r) => r.split("/").pop()).sort()).toEqual(["MEMORY.md", "root.txt"]);
```
并把前两条 `write` 的目录改成 `projectMemoryDir("/p/x")`（import 自 `../../src/main/projectRoot.js`）。

- [ ] **Step 2: 跑 fail** → **Step 3: 实现 `src/main/memoryFiles.ts`**

```ts
// src/main/memoryFiles.ts
// memories/ 前缀的唯一读写口（#852，ADR-0206）。云同步要在「每次本地写完」这个点挂钩，
// 而写路径原本散在四处（memoryEditDeps / 三个设置页 handler 的裸 rm/writeFile /
// LocalWorld 的 config 能力）——散着挂就会漏，漏一处云端就少一份。这里收成一个对象，
// 架构测试（tests/architecture.test.ts）钉住：碰 memories/ 路径的文件不许再 import node:fs。
// 工具那条写路径（LocalWorld.config.write）不经这里，它用 onConfigWrite 钩子汇进同一个 sync。
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { memoryRelPath, PROJECT_MEMORY_FILE, PROJECT_ROOT_FILE } from "../shared/memoryStore.js";
import { TOPICS_DIR, topicLabelRelPath, topicRelPath, type MemoryTopicSnapshot } from "../shared/memoryTopics.js";
import { readTopics } from "./memoryTopics.js";
import { projectMemoryDir, resolveProjectRoot } from "./projectRoot.js";

export const MEMORY_PREFIX = "memories/";

export interface MemoryFiles {
  root: string;
  read(rel: string): Promise<string>;
  readSync(rel: string): string;
  write(rel: string, content: string): Promise<void>;
  remove(rel: string): Promise<void>;
  removeDir(relDir: string): Promise<void>;
  walk(): Promise<{ rel: string; content: string; mtimeMs: number }[]>;
  readTopics(): MemoryTopicSnapshot[];
  listProjects(): Promise<{ root: string; text: string }[]>;
  deleteProject(projectRoot: string): Promise<void>;
  deleteTopic(slug: string): Promise<void>;
  setTopicLabel(slug: string, label: string): Promise<void>;
  readTiers(workspace: string): {
    memory: string;
    user: string;
    project?: string;
    projectRoot?: string;
    topics: MemoryTopicSnapshot[];
  };
}

export function createMemoryFiles(root: string, hooks: { onWrite?: (rel: string) => void } = {}): MemoryFiles {
  const notify = (rel: string) => hooks.onWrite?.(rel);
  const fence = (rel: string): string => {
    const abs = resolve(root, rel);
    const inside = abs === resolve(root, MEMORY_PREFIX.slice(0, -1)) || abs.startsWith(resolve(root, MEMORY_PREFIX));
    if (!rel.startsWith(MEMORY_PREFIX) || !inside) throw new Error(`记忆路径越界：${rel}`);
    return abs;
  };
  const toRel = (abs: string) => relative(root, abs).split(sep).join("/");
  const isEnoent = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";

  async function walkDir(absDir: string, out: { rel: string; content: string; mtimeMs: number }[]): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if (isEnoent(err)) return;
      throw err;
    }
    for (const e of entries) {
      const abs = join(absDir, e.name);
      if (e.isDirectory()) await walkDir(abs, out);
      else if (e.isFile()) {
        const [content, st] = await Promise.all([readFile(abs, "utf8"), stat(abs)]);
        out.push({ rel: toRel(abs), content, mtimeMs: st.mtimeMs });
      }
    }
  }

  const files: MemoryFiles = {
    root,
    async read(rel) {
      try {
        return await readFile(fence(rel), "utf8");
      } catch (err) {
        if (isEnoent(err)) return "";
        throw err;
      }
    },
    readSync(rel) {
      try {
        return readFileSync(fence(rel), "utf8");
      } catch (err) {
        if (!isEnoent(err)) console.error(`读记忆文件 ${rel} 失败（按空处理）`, err);
        return "";
      }
    },
    async write(rel, content) {
      const abs = fence(rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
      notify(rel);
    },
    async remove(rel) {
      await rm(fence(rel), { force: true });
      notify(rel);
    },
    async removeDir(relDir) {
      const abs = fence(relDir);
      const gone: { rel: string }[] = [];
      await walkDir(abs, gone as { rel: string; content: string; mtimeMs: number }[]);
      await rm(abs, { recursive: true, force: true });
      for (const g of gone) notify(g.rel);
    },
    async walk() {
      const out: { rel: string; content: string; mtimeMs: number }[] = [];
      await walkDir(resolve(root, MEMORY_PREFIX), out);
      return out;
    },
    readTopics: () => readTopics(join(root, TOPICS_DIR)),
    async listProjects() {
      const dir = join(root, "memories", "projects");
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return [];
      }
      const out: { root: string; text: string }[] = [];
      for (const n of names) {
        const projectRoot = await files.read(`memories/projects/${n}/${PROJECT_ROOT_FILE}`);
        if (!projectRoot) continue; // 没有 root.txt = 不自描述的孤儿目录，不列
        out.push({ root: projectRoot.trim(), text: await files.read(`memories/projects/${n}/${PROJECT_MEMORY_FILE}`) });
      }
      return out.sort((a, b) => a.root.localeCompare(b.root));
    },
    deleteProject: (projectRoot) => files.removeDir(projectMemoryDir(projectRoot)),
    async deleteTopic(slug) {
      await files.remove(topicRelPath(slug));
      await files.remove(topicLabelRelPath(slug));
    },
    async setTopicLabel(slug, label) {
      const rel = topicLabelRelPath(slug);
      if (!label.trim()) await files.remove(rel);
      else await files.write(rel, label.trim());
    },
    readTiers(workspace) {
      const base = {
        memory: files.readSync(memoryRelPath("memory")),
        user: files.readSync(memoryRelPath("user")),
        topics: files.readTopics(),
      };
      const projectRoot = resolveProjectRoot(workspace);
      if (!projectRoot) return base;
      return { ...base, project: files.readSync(memoryRelPath("project", projectMemoryDir(projectRoot))), projectRoot };
    },
  };
  return files;
}
```
注意 `listProjects` 里 `read` 对空文件回 `""`，与原实现「root.txt 不存在才跳过」有一处差异：root.txt 存在但为空也会跳过——可接受（空 root 本来就不可用）。`removeDir` 的 `gone` 类型写法按 tsc 意见调整（可直接用完整类型的数组）。

- [ ] **Step 4: index.ts 改走它**

在 `accountConfig` 算出来之后、第一次用到记忆的地方之前（`readMemoryFile` 定义处附近）：
```ts
  const memoryFiles = createMemoryFiles(accountConfig, { onWrite: (rel) => memorySyncTouched?.(rel) });
  /** Task 5 接线：memorySync 建好后填进来。先声明是因为 memoryFiles 在它之前就得存在 */
  let memorySyncTouched: ((rel: string) => void) | null = null;
```
然后：
- 删掉 `readMemoryFile` 与 `readMemoryFiles`，调用处改成 `memoryFiles.readTiers(workspace)`（形状一致）。
- `memoryEditDeps` 改为 `{ store, readFile: (rel) => memoryFiles.read(rel), writeFile: (rel, c) => memoryFiles.write(rel, c) }`。
- `~1076` 的 `readTopics(join(accountConfig, TOPICS_DIR))` → `memoryFiles.readTopics()`。
- `listProjectMemories` → `memoryFiles.listProjects()`；`deleteProjectMemory` → `memoryFiles.deleteProject(root)`；`listTopicMemories` → `memoryFiles.readTopics().map(...)`；`deleteTopicMemory` 的两行 `rm` → `await memoryFiles.deleteTopic(slug)`；`setTopicLabel` 的 mkdir/writeFile/rm → `await memoryFiles.setTopicLabel(slug, label)`。
- `~2674` 等其它 `readMemoryFile(memoryRelPath(...))` → `memoryFiles.readSync(memoryRelPath(...))`——**不行**，index.ts 之后不许再出现 `memoryRelPath`（Task 3 的架构断言）。改成 `memoryFiles.readTiers(...)` 取字段，或给 `MemoryFiles` 加 `readTier(target: MemoryTarget, projectDir?: string | null, topic?: string | null): Promise<string>`（内部 `memoryRelPath`），`forgetMemory` handler 里的 `memoryEditDeps.readFile(memoryRelPath(target, project?.dir, topic))` 也改成它。
- index.ts 最终**不再 import** `memoryRelPath / TOPICS_DIR / topicRelPath / topicLabelRelPath / PROJECT_ROOT_FILE / PROJECT_MEMORY_FILE`；`projectMemoryDir`（纯目录名函数，给 `createMemoryTool` 用）可以留。`isMemoryTarget / parseEntries / formatEntries / topicIndexOf / isTopicSlug / SEED_TOPICS` 照留。

- [ ] **Step 5: `npm test`** → **Step 6: Commit** — `refactor(memory): memories/ 的读写收成 memoryFiles 一个口，给云同步一个挂钩点（#852）`

---

### Task 3: 架构断言 + LocalWorld 的 `onConfigWrite` 钩子

**Files:**
- Modify: `tests/architecture.test.ts`（新 it）
- Modify: `src/world/localWorld.ts`（`createLocalWorld` opts 加 `onConfigWrite?: (rel: string) => void`，`config.write` 完成后调）
- Modify: `src/main/agent.ts`（`createAgent` opts 加 `onConfigWrite?`，随 `configRoot` 一起递给 `createLocalWorld`）
- Test: `tests/world/localWorldConfig.test.ts`（追加）

- [ ] **Step 1: 架构断言（先写，应当直接绿——Task 2 已把 index.ts 清干净；若红，修 index.ts 不改断言）**

```ts
  // #852：memories/ 的写路径必须只有一个口（src/main/memoryFiles.ts），云同步挂在它后面。
  // 判据：一个文件既 import 了 node:fs 又提到记忆路径符号，就是在绕过那个口。
  // memoryTopics.ts 是只读的组装根、projectRoot.ts 只定义目录名函数——白名单。
  it("碰 memories/ 路径的文件不 import node:fs —— 记忆写路径只有 memoryFiles.ts 一个口（#852）", () => {
    const MEMORY_PATH_SYMBOLS = /\b(memoryRelPath|topicRelPath|topicLabelRelPath|TOPICS_DIR|MEMORY_DIR|PROJECT_ROOT_FILE|PROJECT_MEMORY_FILE)\b|["'`]memories\//;
    const allow = new Set(["main/memoryFiles.ts", "main/memoryTopics.ts", "main/projectRoot.ts"]);
    const bad = walk(ROOT)
      .filter((f) => !allow.has(relative(ROOT, f)))
      .filter((f) => imports(f).some((s) => /^node:fs(\/promises)?$/.test(s) || s === "fs" || s === "fs/promises"))
      .filter((f) => MEMORY_PATH_SYMBOLS.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f));
    expect(
      bad,
      `这些文件同时 import 了 node:fs 又碰记忆路径:\n  ${bad.join("\n  ")}\n` +
        "修法:读写 memories/ 一律走 src/main/memoryFiles.ts(createMemoryFiles);" +
        "它写完会通知 memorySync,绕过它 = 云端少一份"
    ).toEqual([]);
  });
```
`walk / imports / ROOT / readFileSync / relative` 用该文件已有的 helper 与 import（缺哪个补哪个）。`ROOT` 在该文件里指 `src/`；确认后再写路径。

- [ ] **Step 2: 跑；红则修 index.ts 直到绿**

- [ ] **Step 3: LocalWorld 钩子测试**（追加到 `tests/world/localWorldConfig.test.ts`，照该文件已有的 configRoot 用法）

```ts
  it("config.write 完成后调 onConfigWrite(rel)（#852 云同步挂钩）", async () => {
    const seen: string[] = [];
    const world = createLocalWorld({ root, configRoot, onConfigWrite: (rel) => seen.push(rel) });
    await world.config!.write("memories/USER.md", "x");
    expect(seen).toEqual(["memories/USER.md"]);
  });
```

- [ ] **Step 4: 实现**：`localWorld.ts` opts 加
```ts
    /** config.write 落盘后回调（#852）：记忆云同步挂在这里，工具那条写路径不经 memoryFiles */
    onConfigWrite?: (rel: string) => void;
```
`write` 末尾 `opts.onConfigWrite?.(rel);`。`agent.ts` opts 加同名字段（注释指向 configRoot 那条先例），`createLocalWorld({...})` 里 `...(opts.onConfigWrite ? { onConfigWrite: opts.onConfigWrite } : {})`。

- [ ] **Step 5: `npm test`** → **Step 6: Commit** — `feat(world): config.write 加 onConfigWrite 钩子；架构断言钉住记忆写路径只有一个口（#852）`

---

### Task 4: 表 + 薄 API

**Files:**
- Create: `supabase/migrations/0018_memory_docs.sql`
- Create: `src/main/supabaseMemoryDocsApi.ts`
- Create: `src/main/memoryDocsApi.ts`（接口，给 memorySync 与测试用）

**Interfaces:**
```ts
// src/main/memoryDocsApi.ts
export interface MemoryDocRow { key: string; content: string; updated_at: string }
export interface MemoryDocsApi {
  listAll(uid: string): Promise<MemoryDocRow[]>;
  upsert(uid: string, key: string, content: string, updatedAtIso: string): Promise<void>;
  remove(uid: string, key: string): Promise<void>;
}
```

- [ ] **Step 1: migration**（风格照 `0011_remote_devices.sql`）

```sql
-- 0018_memory_docs.sql — 记忆跟账号走（#852，ADR-0206）
-- 本地 ~/.mr-otto/accounts/<hash>/memories/** 是缓存；这张表是账号级副本，后写胜。
-- key = memoryRelPath 的相对路径（memories/USER.md、memories/topics/work.md、
-- memories/projects/<hash16>/MEMORY.md、…/root.txt、…/<slug>.label）。

create table if not exists public.memory_docs (
  uid        uuid        not null references auth.users(id) on delete cascade,
  key        text        not null,
  content    text        not null,
  updated_at timestamptz not null default now(),
  primary key (uid, key)
);

alter table public.memory_docs enable row level security;

drop policy if exists "memory_docs_select_own" on public.memory_docs;
create policy "memory_docs_select_own" on public.memory_docs
  for select to authenticated using (auth.uid() = uid);

drop policy if exists "memory_docs_insert_own" on public.memory_docs;
create policy "memory_docs_insert_own" on public.memory_docs
  for insert to authenticated with check (auth.uid() = uid);

drop policy if exists "memory_docs_update_own" on public.memory_docs;
create policy "memory_docs_update_own" on public.memory_docs
  for update to authenticated using (auth.uid() = uid) with check (auth.uid() = uid);

drop policy if exists "memory_docs_delete_own" on public.memory_docs;
create policy "memory_docs_delete_own" on public.memory_docs
  for delete to authenticated using (auth.uid() = uid);
```

- [ ] **Step 2: 接口文件 + 真实现**

```ts
// src/main/supabaseMemoryDocsApi.ts — MemoryDocsApi 的真 supabase 实现（薄到无逻辑，错误原样上抛；
// 收敛在 memorySync 里）。同 supabaseUserProfileApi.ts 的纪律。
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MemoryDocRow, MemoryDocsApi } from "./memoryDocsApi.js";

function unwrap<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

export function createSupabaseMemoryDocsApi(client: SupabaseClient): MemoryDocsApi {
  return {
    async listAll(uid) {
      const res = await client.from("memory_docs").select("key,content,updated_at").eq("uid", uid);
      return (unwrap(res) ?? []) as MemoryDocRow[];
    },
    async upsert(uid, key, content, updatedAtIso) {
      unwrap(await client.from("memory_docs").upsert({ uid, key, content, updated_at: updatedAtIso }));
    },
    async remove(uid, key) {
      unwrap(await client.from("memory_docs").delete().eq("uid", uid).eq("key", key));
    },
  };
}
```

- [ ] **Step 3: `npm test`（tsc）** → **Step 4: Commit** — `feat(memory): memory_docs 表 + 薄 API（#852）`

---

### Task 5: `src/main/memorySync.ts` + 接线

**Files:**
- Create: `src/main/memorySync.ts`
- Modify: `src/main/index.ts`（建 sync、填 `memorySyncTouched`、`createAgent` 的 `onConfigWrite`、account `onChange` 登录后 `pullNow`）
- Test: `tests/main/memorySync.test.ts`

**Interfaces:**
```ts
export type MemorySyncState = { kind: "off" } | { kind: "idle"; lastSyncedAt: number } | { kind: "syncing" } | { kind: "error"; message: string; lastSyncedAt: number | null };
export interface MemorySyncDeps {
  files: Pick<MemoryFiles, "walk" | "read" | "write" | "remove">;
  api: MemoryDocsApi;
  uid: () => string | null;         // 没登录 → null
  debounceMs?: number;              // 默认 800
  retryMs?: number;                 // 默认 30_000
  now?: () => number;
  onState?: (s: MemorySyncState) => void;
}
export interface MemorySync {
  touched(rel: string): void;       // 本地写完了（memoryFiles.onWrite / LocalWorld.onConfigWrite 都调它）
  pullNow(): Promise<"synced" | "skipped" | "failed">;   // 登录恢复后全量对账
  flushNow(): Promise<void>;        // 把 pending 推完（测试用 / 退出前）
  state(): MemorySyncState;
  dispose(): void;
}
export function createMemorySync(deps: MemorySyncDeps): MemorySync
```
行为：
- `touched(rel)`：`muted` 时忽略（从云端写本地那一刻）；否则 `pending.add(rel)`，重设防抖 timer。
- flush：`uid()` 为 null → 保留 pending 直接返回（状态 `off`）；否则对每个 rel：`content = await files.read(rel)`；`""` 且文件不存在 → `api.remove`，否则 `api.upsert(uid, rel, content, new Date(now()).toISOString())`。（用 `read` 回空串判「删」：空文件与不存在都当删——记忆空了云端也不该留一份空的。）成功 → `idle`；失败 → `error` + 把 rel 放回 pending + 起 retry timer。
- `pullNow`：uid null → `skipped`；`syncing`；`cloud = api.listAll(uid)` → `planReconcile(local(await files.walk()), cloud.map(updatedAtMs = Date.parse(updated_at)))`；`muted = true` 写 pull 的每一份到本地，`finally muted = false`；push 的每一份 `api.upsert`；成功 `idle`，失败 `error` 回 `failed`（不抛）。
- **不做定时轮询**（同 pxAuditSync 的取舍）：触发点只有本地写 + 登录恢复。

- [ ] **Step 1: 失败测试**

```ts
// tests/main/memorySync.test.ts
import { describe, expect, it } from "vitest";
import { createMemorySync } from "../../src/main/memorySync.js";
import type { MemoryDocRow } from "../../src/main/memoryDocsApi.js";

function fakeFiles() {
  const disk = new Map<string, { content: string; mtimeMs: number }>();
  let clock = 1000;
  return {
    disk,
    files: {
      walk: async () => [...disk].map(([rel, d]) => ({ rel, ...d })),
      read: async (rel: string) => disk.get(rel)?.content ?? "",
      write: async (rel: string, content: string) => { disk.set(rel, { content, mtimeMs: ++clock }); },
      remove: async (rel: string) => { disk.delete(rel); },
    },
    tick: () => ++clock,
  };
}
function fakeApi(rows: MemoryDocRow[] = []) {
  const calls: string[] = [];
  let fail = false;
  return {
    calls,
    setFail: (v: boolean) => { fail = v; },
    api: {
      listAll: async () => { if (fail) throw new Error("net"); return rows; },
      upsert: async (_u: string, key: string, content: string) => { if (fail) throw new Error("net"); calls.push(`up ${key}=${content}`); },
      remove: async (_u: string, key: string) => { if (fail) throw new Error("net"); calls.push(`rm ${key}`); },
    },
  };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("memorySync（#852）", () => {
  it("touched → 防抖后 upsert；空/不存在 → remove", async () => {
    const f = fakeFiles();
    const a = fakeApi();
    const s = createMemorySync({ files: f.files, api: a.api, uid: () => "u1", debounceMs: 1 });
    await f.files.write("memories/USER.md", "hi");
    s.touched("memories/USER.md");
    s.touched("memories/topics/x.md"); // 不存在
    await sleep(10);
    expect(a.calls.sort()).toEqual(["rm memories/topics/x.md", "up memories/USER.md=hi"]);
    expect(s.state().kind).toBe("idle");
    s.dispose();
  });
  it("没登录：pending 留着、不打网络、状态 off；登录后 flush 推出去", async () => {
    const f = fakeFiles();
    const a = fakeApi();
    let uid: string | null = null;
    const s = createMemorySync({ files: f.files, api: a.api, uid: () => uid, debounceMs: 1 });
    await f.files.write("memories/USER.md", "hi");
    s.touched("memories/USER.md");
    await sleep(10);
    expect(a.calls).toEqual([]);
    expect(s.state().kind).toBe("off");
    uid = "u1";
    await s.flushNow();
    expect(a.calls).toEqual(["up memories/USER.md=hi"]);
    s.dispose();
  });
  it("网络失败：状态 error、pending 保留、retry 后成功", async () => {
    const f = fakeFiles();
    const a = fakeApi();
    a.setFail(true);
    const s = createMemorySync({ files: f.files, api: a.api, uid: () => "u1", debounceMs: 1, retryMs: 5 });
    await f.files.write("memories/USER.md", "hi");
    s.touched("memories/USER.md");
    await sleep(3);
    expect(s.state().kind).toBe("error");
    a.setFail(false);
    await sleep(15);
    expect(a.calls).toEqual(["up memories/USER.md=hi"]);
    expect(s.state().kind).toBe("idle");
    s.dispose();
  });
  it("pullNow：云端新的写本地且不回推；本地新的推上去；相同不动", async () => {
    const f = fakeFiles();
    await f.files.write("memories/MEMORY.md", "local-old");   // mtime 1001
    await f.files.write("memories/USER.md", "local-new");     // mtime 1002
    await f.files.write("memories/topics/same.md", "same");   // mtime 1003
    const a = fakeApi([
      { key: "memories/MEMORY.md", content: "cloud-new", updated_at: new Date(5000).toISOString() },
      { key: "memories/USER.md", content: "cloud-old", updated_at: new Date(1).toISOString() },
      { key: "memories/topics/same.md", content: "same", updated_at: new Date(9999).toISOString() },
      { key: "memories/topics/only-cloud.md", content: "oc", updated_at: new Date(1).toISOString() },
    ]);
    const s = createMemorySync({ files: f.files, api: a.api, uid: () => "u1", debounceMs: 1 });
    expect(await s.pullNow()).toBe("synced");
    expect(f.disk.get("memories/MEMORY.md")?.content).toBe("cloud-new");
    expect(f.disk.get("memories/topics/only-cloud.md")?.content).toBe("oc");
    expect(a.calls).toEqual(["up memories/USER.md=local-new"]);
    await sleep(10); // 从云端写本地那两次不得触发上传
    expect(a.calls).toEqual(["up memories/USER.md=local-new"]);
    s.dispose();
  });
  it("pullNow 没登录 → skipped；失败 → failed 不抛", async () => {
    const f = fakeFiles();
    const a = fakeApi();
    const s1 = createMemorySync({ files: f.files, api: a.api, uid: () => null });
    expect(await s1.pullNow()).toBe("skipped");
    a.setFail(true);
    const s2 = createMemorySync({ files: f.files, api: a.api, uid: () => "u1" });
    expect(await s2.pullNow()).toBe("failed");
    expect(s2.state().kind).toBe("error");
    s1.dispose(); s2.dispose();
  });
});
```

- [ ] **Step 2: 跑 fail** → **Step 3: 实现**

```ts
// src/main/memorySync.ts
// 记忆跟账号走（#852，ADR-0206）：本地 memories/** 是缓存，云端 memory_docs 是账号级副本。
// 两个触发点——本地写完（memoryFiles.onWrite / LocalWorld.onConfigWrite）→ 防抖上传；
// 登录恢复 → 全量对账（planReconcile）。刻意不做定时轮询（同 pxAuditSync）。
// 离线/未登录：pending 留着不打网络，会话照常开始——「先落盘再喂模型」的节奏不变。
// 从云端写本地那一刻 muted：否则写本地 → touched → 再推回去，死循环。
import { planReconcile } from "../shared/memoryReconcile.js";
import type { MemoryDocsApi } from "./memoryDocsApi.js";
import type { MemoryFiles } from "./memoryFiles.js";

export type MemorySyncState =
  | { kind: "off" }
  | { kind: "idle"; lastSyncedAt: number }
  | { kind: "syncing" }
  | { kind: "error"; message: string; lastSyncedAt: number | null };

export interface MemorySyncDeps {
  files: Pick<MemoryFiles, "walk" | "read" | "write" | "remove">;
  api: MemoryDocsApi;
  uid: () => string | null;
  debounceMs?: number;
  retryMs?: number;
  now?: () => number;
  onState?: (s: MemorySyncState) => void;
}

export interface MemorySync {
  touched(rel: string): void;
  pullNow(): Promise<"synced" | "skipped" | "failed">;
  flushNow(): Promise<void>;
  state(): MemorySyncState;
  dispose(): void;
}

export function createMemorySync(deps: MemorySyncDeps): MemorySync {
  const debounceMs = deps.debounceMs ?? 800;
  const retryMs = deps.retryMs ?? 30_000;
  const now = deps.now ?? Date.now;
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let muted = false;
  let disposed = false;
  let lastSyncedAt: number | null = null;
  let current: MemorySyncState = { kind: "off" };
  const setState = (s: MemorySyncState) => {
    current = s;
    deps.onState?.(s);
  };
  const fail = (err: unknown) => {
    setState({ kind: "error", message: err instanceof Error ? err.message : String(err), lastSyncedAt });
    if (retry !== null) clearTimeout(retry);
    retry = setTimeout(() => {
      retry = null;
      void flush();
    }, retryMs);
  };

  async function flush(): Promise<void> {
    if (disposed) return;
    const uid = deps.uid();
    if (!uid) {
      setState({ kind: "off" });
      return;
    }
    if (pending.size === 0) return;
    const batch = [...pending];
    pending.clear();
    setState({ kind: "syncing" });
    try {
      for (const rel of batch) {
        const content = await deps.files.read(rel);
        if (content === "") await deps.api.remove(uid, rel);
        else await deps.api.upsert(uid, rel, content, new Date(now()).toISOString());
      }
      lastSyncedAt = now();
      setState({ kind: "idle", lastSyncedAt });
    } catch (err) {
      for (const rel of batch) pending.add(rel);
      fail(err);
    }
  }

  return {
    touched(rel) {
      if (disposed || muted) return;
      pending.add(rel);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, debounceMs);
    },
    async pullNow() {
      if (disposed) return "skipped";
      const uid = deps.uid();
      if (!uid) {
        setState({ kind: "off" });
        return "skipped";
      }
      setState({ kind: "syncing" });
      try {
        const cloud = (await deps.api.listAll(uid)).map((r) => ({
          key: r.key,
          content: r.content,
          updatedAtMs: Date.parse(r.updated_at),
        }));
        const local = (await deps.files.walk()).map((d) => ({ key: d.rel, content: d.content, mtimeMs: d.mtimeMs }));
        const plan = planReconcile(local, cloud);
        muted = true;
        try {
          for (const c of plan.pull) await deps.files.write(c.key, c.content);
        } finally {
          muted = false;
        }
        for (const l of plan.push) await deps.api.upsert(uid, l.key, l.content, new Date(l.mtimeMs).toISOString());
        lastSyncedAt = now();
        setState({ kind: "idle", lastSyncedAt });
        // 对账期间攒下的 pending 顺手推掉
        if (pending.size > 0) await flush();
        return "synced";
      } catch (err) {
        fail(err);
        return "failed";
      }
    },
    flushNow: () => flush(),
    state: () => current,
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      if (retry !== null) clearTimeout(retry);
    },
  };
}
```

- [ ] **Step 4: 接线（index.ts）**

在 `memoryFiles` 之后、`supabase` client 建好之后（`const supabase = createSupabaseAuthClient(authFilePath)` 约 :544 之后；`memoryFiles` 若定义得更晚就把它也提前到这里——它只依赖 `accountConfig`）：
```ts
  const memorySync = createMemorySync({
    files: memoryFiles,
    api: createSupabaseMemoryDocsApi(supabase.raw),
    uid: () => friends.currentUid(),
  });
  memorySyncTouched = (rel) => memorySync.touched(rel);
```
（`friends.currentUid()` 是现有的 uid 来源，见 :1504；若 `friends` 在这一点还没建，改用 `sessionIdentity(authFilePath, nodeIO).uid`——`src/main/authStorage.ts:66`——它同步离线可读。）

account `onChange`（:656 那行）：`if (info.signedIn) { remoteRetryNow?.(); proxyResumeNow?.(); hostedQuotaRefresh?.(); void memorySync.pullNow(); }`。

`createAgent(...)` 主会话装配那处（`configRoot: accountConfig` 所在，约 :2215）加 `onConfigWrite: (rel) => memorySync.touched(rel),`。

`app.on("before-quit")` 或现有退出钩子处：`void memorySync.flushNow()`（尽力而为，不 await 阻塞退出）。找不到合适钩子就跳过并在报告里说明。

- [ ] **Step 5: `npm test`** → **Step 6: Commit** — `feat(memory): 记忆云同步 memorySync——本地写完防抖上传、登录后全量对账（#852）`

---

### Task 6: ShellBridge 状态 + 设置页一行

**Files:**
- Modify: `src/shared/shellBridge.ts`（接口 + `CHANNELS`）、`src/preload/index.ts`、`src/main/index.ts`（handler）
- Modify: `src/renderer/src/store.ts`（action）、`src/renderer/src/components/MemorySettings.tsx`（header 里一行）

**Interfaces:**
- `memorySyncStatus(): Promise<MemorySyncState>`；channel `memorySyncStatus: "otter:memorySyncStatus"`；`MemorySyncState` 类型搬到 `src/shared/memorySyncState.ts`（memorySync.ts 从那里 import 并 re-export），shellBridge import 它。

- [ ] **Step 1: 三件套 + store action `memorySyncStatus`**（照 `listTopicMemories` 的写法）
- [ ] **Step 2: `MemorySettings.tsx`**：`MemorySettings()` 里 `useEffect` 拉一次 `memorySyncStatus`，header 的 `SettingsTitle` 右边放一个 `<span className={HINT}>`：
  - `off` → `记忆只在这台电脑上（登录后会跟账号同步）`
  - `idle` → `已与账号同步`
  - `syncing` → `同步中…`
  - `error` → `同步失败，会自动重试`（`title` 放 message）
  不加动画（设置页读一次的状态行）。
- [ ] **Step 3: `npm test`** → **Step 4: Commit** — `feat(settings): 记忆页显示云同步状态（#852）`

---

### Task 7: ADR + CONTEXT.md + AGENTS.md 索引 + 迁移说明

**Files:**
- Create: `docs/adr/0206-记忆跟账号走云端memory_docs后写胜.md`（编号合并时再核，ADR-0074）
- Modify: `CONTEXT.md`（产品/技术术语表加「记忆云同步」）、`AGENTS.md`（索引一行：`src/main/memoryFiles.ts` / `memorySync.ts` / `src/shared/memoryReconcile.ts` / `supabase/migrations/0018_memory_docs.sql`）

- [ ] **Step 1: ADR**，结构照 `docs/adr/0204-*.md`：关联 #852、ADR-0116（推翻其隐含的「记忆在本机」）、ADR-0187（抽屉）、ADR-0197（pxEscrowSync 的防抖模式）。决定：① 表与 key；② 本地是缓存、后写胜、内容相同不动；③ 唯一写口 memoryFiles + LocalWorld 钩子，架构断言；④ 触发点两个不轮询；⑤ 离线不阻塞、登出不清；⑥ 天花板：后写胜有损（before 在 memory_user_edit）、项目档 key 含路径哈希实际不跨机（另开 issue，ADR-0116 作用域键重审）、手机端不做 UI。被否的路：CRDT/三路合并（记忆是策展文本，代价不值）、每次会话开始先拉云端（断网会卡会话开始，违背先落盘再喂模型）。什么前提垮了要重看：memories/ 之外出现新的记忆落点；`memoryRelPath` 形状变了（key 跟着变，云端旧 key 成孤儿）。
- [ ] **Step 2: CONTEXT.md / AGENTS.md**
- [ ] **Step 3: 开一个 follow-up issue**：「项目档记忆 key 换成 remote URL 哈希，让项目记忆跨机」，正文引用 ADR-0206 天花板第二条，`Blocked by: #852`。
- [ ] **Step 4: `npm test`** → **Step 5: Commit** — `docs(adr): 记忆跟账号走（ADR-0206，#852）`

> 迁移 `0018_memory_docs.sql` 要在 Cloud 真库执行一次（PR 合并后由控制者按 `~/.claude/.../memory/local-profiles-and-cloud-db-access.md` 记的办法跑；PR 正文里写明「表未建前同步静默失败、只在本地」）。
