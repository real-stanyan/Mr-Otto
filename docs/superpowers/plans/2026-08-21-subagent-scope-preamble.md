# 子智能体：作用域与前置提示词 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 子智能体可以属于用户级或工作区级；前置提示词分全局／单个覆盖／工作区文档注入三层可配；设置页那一栏改叫「子智能体」。

**Architecture:** 作用域是扫描根目录的一层（工作区盖用户），在组装根 `createSessionAgent` 里按会话 workspace 绑定，工具层签名不变。前置词拼装抽成纯函数 `composeSubagentPrompt`，读盘以 reader 接口注入。重建历史子会话改为只信 `subagent_briefed` 快照。

**Tech Stack:** TypeScript strict（`exactOptionalPropertyTypes`）、Electron 主进程 + React/Zustand 渲染进程、vitest。

**Spec:** `docs/superpowers/specs/2026-08-21-subagent-scope-preamble-design.md`
**ADR:** `docs/adr/0048-子智能体的作用域与三层前置词.md`
**Issue:** #144

## Global Constraints

- `src/` 内的 import 一律带 `.js` 后缀（ESM）。
- `exactOptionalPropertyTypes: true`：可选字段用 `...(cond ? { f: v } : {})`，永远不要把 `undefined` 赋给可选字段。
- 测试放 `tests/`，镜像 `src/` 结构，**不与源码同目录**（ADR-0016）。
- 渲染进程只通过 `ShellBridge` 与后端通信，禁止直接碰 Node API。
- 工具实现只依赖 `ExecutionWorld`，禁止直接 import `fs` / `child_process`（`src/main/` 下的组装根模块不受此限）。
- `SessionEvent` schema 本次**不改**；老日志必须永远可重放。
- 面向用户的中文一律说「子智能体」；`task`、`tools`、`description`、`preamble`、`context` 这些代码/字段名保持原文。
- 门禁：`npm test`（必须与 `.github/workflows/ci.yml` 字节一致，本次不改门禁）。
- 工作区里有**另一条 lane 未提交的改动**（`src/renderer/src/App.tsx`、`src/renderer/src/components/SidebarNub.tsx`、`src/renderer/src/components/ui/sidebar.tsx`、`src/renderer/src/lib/sidebarNarrow.ts`、`tests/renderer/sidebarNarrow.test.ts`）。**这五个文件一律不改、一律不 `git add`**；提交时只写明确路径，永远不要 `git add -A` / `git add .`。

---

### Task 1: shared 类型与解析器（作用域、前置词三态、context 白名单）

**Files:**
- Modify: `src/shared/subagent.ts`
- Modify: `src/main/subagents.ts`
- Modify: `src/main/index.ts`（`createSubagent` handler 里那个字面量补新字段，让 tsc 绿）
- Test: `tests/main/subagents.test.ts`（解析）、`tests/main/subagentSerialize.test.ts`（往返）

**Interfaces:**
- Consumes: 无
- Produces: `SubagentScope`、`SubagentPreamble`、`DEFAULT_PREAMBLE`、`isSafeContextFile`；`SubagentDef` 新增 `scope` / `preamble` / `context` 三个**必填**字段；`parseSubagentMd(text, opts)` 的 `opts` 新增 `scope: SubagentScope`。

- [ ] **Step 1: 先写失败的测试**

在 `tests/main/subagents.test.ts` 末尾追加：

```ts
describe("preamble 块标量", () => {
  const parse = (text: string) =>
    parseSubagentMd(text, {
      fallbackName: "x",
      knownTools: ["read_file"],
      path: "/r/x.md",
      source: "/r",
      readOnly: false,
      scope: "user",
    });

  it("不写 preamble = 用全局", () => {
    const def = parse("---\nname: a\ndescription: d\n---\n正文");
    expect(def?.preamble).toEqual({ mode: "default" });
  });

  it("preamble: off = 一段都不加", () => {
    const def = parse("---\nname: a\npreamble: off\n---\n正文");
    expect(def?.preamble).toEqual({ mode: "off" });
  });

  it("块标量吃掉缩进更深的连续行，并去掉公共缩进", () => {
    const def = parse("---\nname: a\npreamble: |\n  第一行\n  第二行\napproval: ask\n---\n正文");
    expect(def?.preamble).toEqual({ mode: "custom", text: "第一行\n第二行" });
    // 块结束后的键照常解析，不被块吞掉
    expect(def?.approval).toBe("ask");
  });

  it("块中间的空行留在内容里", () => {
    const def = parse("---\nname: a\npreamble: |\n  上\n\n  下\n---\n正文");
    expect(def?.preamble).toEqual({ mode: "custom", text: "上\n\n下" });
  });

  it("空块退回默认——写了个 | 却什么都没写，不该变成空前置词", () => {
    const def = parse("---\nname: a\npreamble: |\n---\n正文");
    expect(def?.preamble).toEqual({ mode: "default" });
  });
});

describe("context 只收 basename", () => {
  const parse = (ctx: string) =>
    parseSubagentMd(`---\nname: a\ncontext: ${ctx}\n---\n正文`, {
      fallbackName: "x",
      knownTools: [],
      path: "/r/x.md",
      source: "/r",
      readOnly: false,
      scope: "user",
    });

  it("留下正常文件名", () => {
    expect(parse("AGENTS.md, CLAUDE.md")?.context).toEqual(["AGENTS.md", "CLAUDE.md"]);
  });

  it("带路径分隔符的一律丢掉——定义文件不能是任意文件读取原语", () => {
    expect(parse("../../etc/passwd, /etc/passwd, a/b, ..")?.context).toEqual([]);
  });

  it("不写 context = 空数组", () => {
    const def = parseSubagentMd("---\nname: a\n---\n正文", {
      fallbackName: "x",
      knownTools: [],
      path: "/r/x.md",
      source: "/r",
      readOnly: false,
      scope: "workspace",
    });
    expect(def?.context).toEqual([]);
    expect(def?.scope).toBe("workspace");
  });
});

describe("序列化往返", () => {
  const parse = (text: string) =>
    parseSubagentMd(text, {
      fallbackName: "x",
      knownTools: ["read_file", "bash"],
      path: "/r/x.md",
      source: "/r",
      readOnly: false,
      scope: "user",
    });

  it("parse ∘ serialize ∘ parse 与 parse 同结果（块标量的公共缩进不是内容）", () => {
    const src =
      "---\nname: a\ndescription: d\ntools: read_file, bash\napproval: ask\n" +
      "context: AGENTS.md\npreamble: |\n  第一行\n  第二行\n---\n\n正文\n";
    const once = parse(src);
    expect(once).not.toBeNull();
    const twice = parse(serializeSubagent(once!));
    expect(twice).toEqual(once);
  });

  it("preamble 为 default 时整行不写", () => {
    const def = parse("---\nname: a\ndescription: d\ntools: read_file\n---\n正文")!;
    expect(serializeSubagent(def)).not.toContain("preamble:");
  });
});
```

- [ ] **Step 2: 跑一遍确认它红**

Run: `npx vitest run tests/main/subagents.test.ts`
Expected: FAIL（`scope` 不是 `parseSubagentMd` 的合法 opts、`preamble`/`context` 不存在）。同时既有用例也会因为 opts 缺 `scope` 而报类型错——这是预期的，Step 4 一并修。

- [ ] **Step 3: 改 `src/shared/subagent.ts`**

在 `SubagentApproval` 定义之后、`DEFAULT_SUBAGENT_TOOLS` 之前插入：

```ts
/** 定义住在哪一层。工作区级只在本工程的会话里可用（ADR-0048） */
export type SubagentScope = "user" | "workspace";

/** 一个子智能体的前置词取哪儿来。
    custom 是**覆盖**全局而不是追加：追加的话它和 instructions 拼起来对模型
    完全一样，那它就只是 UI 分栏，没有 instructions 表达不了的能力 */
export type SubagentPreamble =
  | { mode: "default" }
  | { mode: "off" }
  | { mode: "custom"; text: string };

/** 内置的全局前置词。用户没在 ~/.otter/subagent-preamble.md 写自己的那份时用它。
    放 shared 不放 runner：设置页要拿它当「恢复默认」后显示的正文 */
export const DEFAULT_PREAMBLE =
  "你是被派来做一件具体任务的子 agent。你的最终一段文本就是返回值——" +
  "它会直接交回给派你来的那个 agent，不是给人看的消息。" +
  "做完就把结论写出来，不要寒暄，不要问「还需要什么帮助吗」。" +
  "你看不到派你来的那个 agent 和用户的对话，任务里没写的背景你就是不知道；" +
  "缺信息时在汇报里说清缺什么，别猜。";

/** context 只收 basename。这是安全边界不是格式洁癖：定义文件可能是用户从别处
    抄来的，收全路径就等于让一份 .md 变成任意文件读取原语。
    解析时挡一次、运行时读盘前再挡一次（两处独立判断比互相信任更皮实） */
export function isSafeContextFile(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !/[/\\]/.test(name);
}
```

在 `SubagentDef` 里，`approval: SubagentApproval;` 之后插入：

```ts
  /** 前置词从哪儿来。缺席的老文件解析成 { mode: "default" } */
  preamble: SubagentPreamble;
  /** 派活时按会话 workspace 读进来拼在正文前的文档（basename，已过滤） */
  context: string[];
  /** 用户级还是工作区级。由扫到它的那条根目录决定，不来自文件内容 */
  scope: SubagentScope;
```

- [ ] **Step 4: 改 `src/main/subagents.ts`**

① import 补上新符号：

```ts
import {
  DEFAULT_SUBAGENT_TOOLS,
  isSafeContextFile,
  type SubagentApproval,
  type SubagentDef,
  type SubagentPreamble,
  type SubagentScope,
} from "../shared/subagent.js";
```

② `parseFrontmatter` 整个替换成带块标量分支的版本：

```ts
/** 缩进宽度（只数前导空白的字符数，tab 按一个字符算——frontmatter 里混 tab
    本来就不该有，这里不为它设计） */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** 解析 frontmatter 的 `键: 值`。不引 YAML 库——字段就这几个（同 parseSkillMd）。
    唯一的例外是块标量 `键: |`：前置词是散文，塞进单行里没法写。
    只认 `|` 这一种块写法，`>` / `|-` / `|+` 照旧当普通单行值处理 */
function parseFrontmatter(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (!kv?.[1]) continue;
    const key = kv[1];
    const value = kv[2] ?? "";
    if (value === "|") {
      const body: string[] = [];
      const keyIndent = indentOf(line);
      // 吃掉后续缩进比键行深的连续行。空行留在块里（块中间的空行是内容的一部分），
      // 块尾多余的空行由末尾的 trimEnd 收走
      while (i + 1 < lines.length) {
        const next = lines[i + 1] ?? "";
        if (next.trim() !== "" && indentOf(next) <= keyIndent) break;
        body.push(next);
        i++;
      }
      const indents = body.filter((s) => s.trim() !== "").map(indentOf);
      const common = indents.length > 0 ? Math.min(...indents) : 0;
      const text = body.map((s) => s.slice(common)).join("\n").trimEnd();
      // 空块 = 什么都没写，退回"这个键没写过"——不是"前置词是空字符串"
      if (text) out[key] = text;
      continue;
    }
    if (value) out[key] = value;
  }
  return out;
}
```

③ `parseSubagentMd` 的 `opts` 类型加 `scope: SubagentScope;`，并在 `const approval = fm["approval"];` 之后插入：

```ts
  const preambleRaw = fm["preamble"];
  // "off" 是保留字：想让自定义前置词正好是 off 两个字母的用户，得用块标量写法
  const preamble: SubagentPreamble =
    preambleRaw === undefined
      ? { mode: "default" }
      : preambleRaw === "off"
        ? { mode: "off" }
        : { mode: "custom", text: preambleRaw };
```

④ 返回的对象里，`approval: ...` 那一项之后插入：

```ts
    preamble,
    context: splitList(fm["context"]).filter(isSafeContextFile),
    scope: opts.scope,
```

⑤ `serializeSubagent` 里，`approval` 那行之后补两项，并新增一个 helper：

```ts
    `approval: ${def.approval}`,
    ...(def.context.length > 0 ? [`context: ${def.context.join(", ")}`] : []),
    ...preambleLines(def.preamble),
```

```ts
/** preamble 写回：default 整行不写（老文件读进来是什么样，写回去还是什么样）；
    off 一行；custom 写块标量，每行两格缩进，空行不缩进——缩进的空行会被解析时
    的公共缩进算法当成内容行，往返就不对称了 */
function preambleLines(p: SubagentPreamble): string[] {
  if (p.mode === "default") return [];
  if (p.mode === "off") return ["preamble: off"];
  return ["preamble: |", ...p.text.split(/\r?\n/).map((l) => (l.trim() === "" ? "" : `  ${l}`))];
}
```

- [ ] **Step 5: 补齐既有调用点，让 tsc 绿**

- `src/main/subagents.ts` 的 `scanSubagents`：`roots` 的元素类型加 `scope`，调 `parseSubagentMd` 时透传（Task 2 会把 roots 的构造挪走，这一步先让类型对上）：把签名里的 `readonly { root: string; readOnly: boolean }[]` 改成 `readonly { root: string; readOnly: boolean; scope: SubagentScope }[]`，并在 `parseSubagentMd({...})` 的 opts 里加 `scope`。
- `src/main/index.ts` 里 `subagentRoots` 那个常量数组的两项各补 `scope: "user"`。
- `src/main/index.ts` 的 `CHANNELS.createSubagent` handler 里那个 `writeSubagent({...})` 字面量补：

```ts
      preamble: { mode: "default" },
      context: [],
      scope: "user",
```

- `tests/` 里所有构造 `SubagentDef` 字面量或调 `parseSubagentMd` 的地方补上三个新字段 / `scope` opt。已知的四处：`tests/main/subagents.test.ts`、`tests/main/subagentSerialize.test.ts`、`tests/main/subagentRunner.test.ts`（顶部那个 `def()` 工厂）、`tests/main/subagentAgent.test.ts`。用 `npx tsc --noEmit` 找齐，一个不落。

- [ ] **Step 6: 跑测试**

Run: `npx vitest run tests/main/subagents.test.ts && npx tsc --noEmit`
Expected: PASS，tsc 无输出。

- [ ] **Step 7: 提交**

```bash
git add src/shared/subagent.ts src/main/subagents.ts src/main/index.ts tests/main/subagents.test.ts tests/main/subagentSerialize.test.ts tests/main/subagentRunner.test.ts tests/main/subagentAgent.test.ts
git commit -m "feat(subagent): 定义里多出作用域、前置词三态和工作区文档声明

前置词是散文，塞不进单行 frontmatter，所以解析器认一种块标量 |。
只认这一种：> / |- / |+ 这些 YAML 变体照旧当单行值，宁可少认也不
自己长成半个 YAML 库。context 只收 basename——定义文件可能是用户
从别处抄来的，收全路径等于让一份 .md 变成任意文件读取原语。"
```

---

### Task 2: 扫描根按作用域分层 + `listSubagents(workspace)`

**Files:**
- Modify: `src/main/subagents.ts`（新增 `subagentRoots(home, workspace)`）
- Modify: `src/main/index.ts`
- Test: `tests/main/subagents.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `SubagentScope`、带 `scope` 的 `scanSubagents`
- Produces: `subagentRoots(home: string, workspace: string | null): SubagentRoot[]`；`listSubagents` 在 index.ts 内变成 `(workspace: string | null) => SubagentDef[]`

- [ ] **Step 1: 先写失败的测试**

追加到 `tests/main/subagents.test.ts`：

```ts
describe("subagentRoots", () => {
  it("有工作区时四条，工作区排在用户前面（同名先到先得 = 工作区盖用户）", () => {
    expect(subagentRoots("/home/u", "/work/proj")).toEqual([
      { root: "/work/proj/.otter/agents", readOnly: false, scope: "workspace" },
      { root: "/work/proj/.claude/agents", readOnly: true, scope: "workspace" },
      { root: "/home/u/.otter/agents", readOnly: false, scope: "user" },
      { root: "/home/u/.claude/agents", readOnly: true, scope: "user" },
    ]);
  });

  it("没有工作区就只有用户那两条", () => {
    expect(subagentRoots("/home/u", null).map((r) => r.scope)).toEqual(["user", "user"]);
  });
});

describe("scanSubagents 的覆盖顺序", () => {
  it("同名时工作区那份赢，且 scope 跟着赢的那条根走", () => {
    const files: Record<string, string[]> = {
      "/work/.otter/agents": ["r.md"],
      "/home/.otter/agents": ["r.md"],
    };
    const reader = {
      listFiles: (root: string) => files[root] ?? [],
      readFile: (path: string) =>
        path.startsWith("/work")
          ? "---\nname: r\ndescription: 工作区那份\n---\n正文"
          : "---\nname: r\ndescription: 用户那份\n---\n正文",
    };
    const defs = scanSubagents(subagentRoots("/home", "/work"), ["read_file"], reader);
    expect(defs).toHaveLength(1);
    expect(defs[0]?.description).toBe("工作区那份");
    expect(defs[0]?.scope).toBe("workspace");
  });
});
```

`subagentRoots` 要加进该测试文件顶部的 import。

- [ ] **Step 2: 跑一遍确认它红**

Run: `npx vitest run tests/main/subagents.test.ts`
Expected: FAIL with "subagentRoots is not a function"（或 import 报错）。

- [ ] **Step 3: 在 `src/main/subagents.ts` 里实现**

文件顶部 import 已有 `join`。在 `SubagentDirReader` 之后插入：

```ts
export interface SubagentRoot {
  root: string;
  readOnly: boolean;
  scope: SubagentScope;
}

/** 扫描根，按覆盖优先级排（同名先到先得，所以工作区排在用户前面 = 工作区盖用户）。
    workspace 为 null（设置页选「用户」、探针装配）时只有用户那两条。
    `.claude/agents/` 是 Claude Code 的配置，只读——我们不去改用户别的工具的文件 */
export function subagentRoots(home: string, workspace: string | null): SubagentRoot[] {
  return [
    ...(workspace
      ? [
          { root: join(workspace, ".otter", "agents"), readOnly: false, scope: "workspace" as const },
          { root: join(workspace, ".claude", "agents"), readOnly: true, scope: "workspace" as const },
        ]
      : []),
    { root: join(home, ".otter", "agents"), readOnly: false, scope: "user" as const },
    { root: join(home, ".claude", "agents"), readOnly: true, scope: "user" as const },
  ];
}
```

把 `scanSubagents` 的 `roots` 参数类型换成 `readonly SubagentRoot[]`。

- [ ] **Step 4: 改 `src/main/index.ts` 的接线**

① 删掉写死的 `subagentRoots` 常量数组，import 换成 `import { scanSubagents, subagentRoots, writeSubagent } from "./subagents.js";`。

② `const listSubagents = () => scanSubagents(subagentRoots, TOOL_NAMES);` 换成：

```ts
  /** 现扫磁盘的清单。workspace 决定要不要带上工作区那两条根（ADR-0048）。
      null = 只看用户级（设置页的「用户」视图、探针装配） */
  const listSubagents = (workspace: string | null) =>
    scanSubagents(subagentRoots(homedir(), workspace), TOOL_NAMES);
```

③ `createSessionAgent` 里，`const base = {...}` 之前插入一行，并把两处 `listSubagents` 换掉：

```ts
    // 运行时的清单绑定在会话的 workspace 上：工作区级的定义只在本工程的会话里
    // 进得了 task 工具的清单。绑定点放在组装根，SubagentRunner / createTaskTool
    // 的签名一个字不用改——工具那层不需要知道有"作用域"这回事
    const listForSession = () => listSubagents(args.workspace);
```

`self = createAgent({ ... listSubagents, subagentRunner: createSubagentRunner({ ... list: listSubagents, ...`
→ `listSubagents: listForSession,` 和 `list: listForSession,`。

④ IPC handler 三个都带上作用域参数：

```ts
  ipcMain.handle(CHANNELS.listSubagents, (_e, workspace: string | null) =>
    listSubagents(workspace)
  );

  ipcMain.handle(CHANNELS.saveSubagent, (_e, def: SubagentDef, workspace: string | null) => {
    // def.path / def.readOnly 是渲染层传来的,不可信（同下）——落地地址必须从
    // 信任侧（现扫一遍磁盘的清单）按名字查出来。作用域也一起传进来：同名可以
    // 两层各一份,不带作用域查就可能在工作区里改一改、写穿到用户级那份上去
    const found = listSubagents(workspace).find((d) => d.name === def.name);
    if (!found) throw new Error(`没有名叫「${def.name}」的子智能体`);
    if (found.readOnly) throw new Error(`${found.name} 是只读的（来自 ${found.source}），不能保存`);
    writeSubagent({ ...def, path: found.path, source: found.source, readOnly: found.readOnly, scope: found.scope });
    return listSubagents(workspace);
  });

  ipcMain.handle(CHANNELS.createSubagent, (_e, name: string, workspace: string | null) => {
    const clean = name.trim();
    const nameError = subagentNameError(clean);
    if (nameError) throw new Error(nameError);
    if (listSubagents(workspace).some((d) => d.name === clean)) {
      throw new Error(`已经有一个叫「${clean}」的子智能体了，换个名字`);
    }
    // 建在选中作用域**可写**的那条根里：工作区级 = <工作区>/.otter/agents，
    // 用户级 = ~/.otter/agents。.claude/agents 是只读的，永远不是落点
    const root = subagentRoots(homedir(), workspace)[0]!.root;
    writeSubagent({
      name: clean,
      description: "",
      instructions: "",
      tools: [...DEFAULT_SUBAGENT_TOOLS],
      unknownTools: [],
      approval: "deny",
      preamble: { mode: "default" },
      context: [],
      scope: workspace ? "workspace" : "user",
      path: join(root, `${clean}.md`),
      source: root,
      readOnly: false,
    });
    return listSubagents(workspace);
  });
```

⑤ `resumeSession` 里 `childAgentConfig(events, listSubagents())` 暂时改成 `childAgentConfig(events, listSubagents(null))`（Task 5 会把第二个参数整个去掉）。

⑥ TOOL_NAMES 探针不受影响（它不调 listSubagents）。

- [ ] **Step 5: 桥面签名跟着改**

`src/shared/shellBridge.ts`：

```ts
  /** 本机定义的子智能体（现扫磁盘，零缓存）。
      workspace = null 只看用户级；给了工作区就带上该工程的两条根（工作区盖用户） */
  listSubagents(workspace: string | null): Promise<SubagentDef[]>;
  /** 写回那份 .md，返回保存后的整份清单（省一次往返）。
      workspace 决定在哪一层里查这个名字——同名可以两层各一份 */
  saveSubagent(def: SubagentDef, workspace: string | null): Promise<SubagentDef[]>;
  /** 按模板新建一个，返回整份清单。建在该作用域可写的那条根里 */
  createSubagent(name: string, workspace: string | null): Promise<SubagentDef[]>;
```

`src/preload/index.ts`：

```ts
  listSubagents: (workspace) => ipcRenderer.invoke(CHANNELS.listSubagents, workspace),
  saveSubagent: (def, workspace) => ipcRenderer.invoke(CHANNELS.saveSubagent, def, workspace),
  createSubagent: (name, workspace) => ipcRenderer.invoke(CHANNELS.createSubagent, name, workspace),
```

`src/renderer/src/store.ts`：state 加 `subagentScope: string | null`（初值 `null`），三个 action 带上它，并加一个切换器。在 `subagents: []` 附近加 `subagentScope: null,`；action 部分：

```ts
  async refreshSubagents() {
    set({ subagents: await window.otter.listSubagents(get().subagentScope) });
  },
  async saveSubagent(def) {
    set({ subagents: await window.otter.saveSubagent(def, get().subagentScope) });
  },
  async createSubagent(name) {
    set({ subagents: await window.otter.createSubagent(name, get().subagentScope) });
  },
  /** 切作用域 = 换一份清单。先把旧清单清空再拉新的，避免切换瞬间显示的是
      上一个作用域的内容（那会让用户以为工作区里已经有这些定义了） */
  async setSubagentScope(workspace) {
    set({ subagentScope: workspace, subagents: [] });
    set({ subagents: await window.otter.listSubagents(workspace) });
  },
```

对应的接口声明（`store.ts` 约 282 行那一块）加 `subagentScope: string | null;` 与 `setSubagentScope(workspace: string | null): Promise<void>;`。

- [ ] **Step 6: 跑测试**

Run: `npm test`
Expected: PASS（`tests/main/subagents.test.ts` 新用例绿，其余不回归）。

- [ ] **Step 7: 提交**

```bash
git add src/main/subagents.ts src/main/index.ts src/shared/shellBridge.ts src/preload/index.ts src/renderer/src/store.ts tests/main/subagents.test.ts
git commit -m "feat(subagent): 扫描根分成用户级和工作区级，运行时按会话工作区过滤

绑定点放在组装根 createSessionAgent（那里已经有 args.workspace），
SubagentRunner 和 createTaskTool 的签名一个字没改——工具那层不需要
知道有作用域这回事。saveSubagent/createSubagent 的 IPC 也带上作用域：
同名可以两层各一份,不带作用域查就会在工作区里改一改、写穿到用户级
那份上去。"
```

---

### Task 3: 前置词拼装（纯函数 + 读盘接缝）

**Files:**
- Create: `src/main/subagentPrompt.ts`
- Test: `tests/main/subagentPrompt.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `SubagentDef.preamble` / `.context`、`DEFAULT_PREAMBLE`、`isSafeContextFile`
- Produces: `composeSubagentPrompt(opts)`、`readGlobalPreamble(path, reader?)`、`readContextDocs(workspace, files, reader?)`、`GLOBAL_PREAMBLE_PATH`、`CONTEXT_DOC_LIMIT`、`nodeFileReader`、类型 `FileReader` / `ContextDoc`

- [ ] **Step 1: 先写失败的测试**

新建 `tests/main/subagentPrompt.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  CONTEXT_DOC_LIMIT,
  composeSubagentPrompt,
  readContextDocs,
  readGlobalPreamble,
} from "../../src/main/subagentPrompt.js";
import { DEFAULT_PREAMBLE, type SubagentDef } from "../../src/shared/subagent.js";

const base: SubagentDef = {
  name: "a",
  description: "d",
  instructions: "正文",
  tools: ["read_file"],
  unknownTools: [],
  approval: "deny",
  preamble: { mode: "default" },
  context: [],
  scope: "user",
  path: "/r/a.md",
  source: "/r",
  readOnly: false,
};

describe("composeSubagentPrompt", () => {
  it("default = 用全局那段", () => {
    const out = composeSubagentPrompt({ def: base, globalPreamble: "全局", docs: [] });
    expect(out).toBe("全局\n\n正文");
  });

  it("off = 一段前置词都不加", () => {
    const def = { ...base, preamble: { mode: "off" } as const };
    expect(composeSubagentPrompt({ def, globalPreamble: "全局", docs: [] })).toBe("正文");
  });

  it("custom 覆盖全局，不是追加", () => {
    const def = { ...base, preamble: { mode: "custom", text: "只输出 JSON" } as const };
    const out = composeSubagentPrompt({ def, globalPreamble: "全局", docs: [] });
    expect(out).toBe("只输出 JSON\n\n正文");
    expect(out).not.toContain("全局");
  });

  it("文档夹在前置词和正文中间，各自带标题", () => {
    const out = composeSubagentPrompt({
      def: base,
      globalPreamble: "全局",
      docs: [{ file: "AGENTS.md", text: "规矩", truncated: false }],
    });
    expect(out).toBe("全局\n\n## 工作区文档：AGENTS.md\n\n规矩\n\n正文");
  });

  it("截断这件事写进正文,不藏", () => {
    const out = composeSubagentPrompt({
      def: base,
      globalPreamble: "",
      docs: [{ file: "AGENTS.md", text: "长", truncated: true }],
    });
    expect(out).toContain("（本文件过长，已截断）");
  });
});

describe("readGlobalPreamble", () => {
  it("文件不在 = 内置默认", () => {
    expect(readGlobalPreamble("/p", { readFile: () => null })).toBe(DEFAULT_PREAMBLE);
  });

  it("空白文件 = 内置默认（存了个空文件不等于要空前置词）", () => {
    expect(readGlobalPreamble("/p", { readFile: () => "  \n\n " })).toBe(DEFAULT_PREAMBLE);
  });

  it("有内容就用它", () => {
    expect(readGlobalPreamble("/p", { readFile: () => "我的\n" })).toBe("我的");
  });
});

describe("readContextDocs", () => {
  it("读不到就跳过,不报错", () => {
    expect(readContextDocs("/w", ["AGENTS.md"], { readFile: () => null })).toEqual([]);
  });

  it("运行时再挡一次 basename——解析时挡过了,这里是第二道", () => {
    const seen: string[] = [];
    const docs = readContextDocs("/w", ["../../etc/passwd", "a/b"], {
      readFile: (p) => {
        seen.push(p);
        return "内容";
      },
    });
    expect(docs).toEqual([]);
    expect(seen).toEqual([]); // 一次盘都没读
  });

  it("超长截断并打标记", () => {
    const long = "x".repeat(CONTEXT_DOC_LIMIT + 10);
    const docs = readContextDocs("/w", ["AGENTS.md"], { readFile: () => long });
    expect(docs[0]?.truncated).toBe(true);
    expect(docs[0]?.text).toHaveLength(CONTEXT_DOC_LIMIT);
  });
});
```

- [ ] **Step 2: 跑一遍确认它红**

Run: `npx vitest run tests/main/subagentPrompt.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写 `src/main/subagentPrompt.ts`**

```ts
// 子智能体的 system prompt 拼装（ADR-0048 §3）。
//
// 拼装本身是纯函数，读盘缩在两个小函数里、reader 以接口注入：这一段的返回值
// 就是落进 subagent_briefed 快照的那一段，也就是"模型看到的全部"——它必须能
// 在测试里不碰磁盘地跑遍每一条分支。

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PREAMBLE, isSafeContextFile, type SubagentDef } from "../shared/subagent.js";

/** 单份工作区文档的上限。一份 AGENTS.md 不该把子 agent 的上下文吃光；
    而"悄悄少读一半"比"读不到"更难查，所以截断这件事要写进正文 */
export const CONTEXT_DOC_LIMIT = 64 * 1024;

/** 全局前置词落在 ~/.otter/ 而不是 ~/.otter/agents/：agents/ 下每个 .md 都会被
    scanSubagents 读一遍（没有 frontmatter 会被丢掉，不至于显示成一个子智能体），
    但让配置文件和定义文件混住是在等一个未来的坑 */
export const GLOBAL_PREAMBLE_PATH = join(homedir(), ".otter", "subagent-preamble.md");

export interface FileReader {
  /** 读不到 = null */
  readFile(path: string): string | null;
}

export const nodeFileReader: FileReader = {
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
};

/** 全局前置词。文件不在／读不到／去空白后为空 = 内置默认。
    空文件退回默认而不是"空前置词"：存了个空文件更像是失手，不像是意图 */
export function readGlobalPreamble(path: string, reader: FileReader = nodeFileReader): string {
  const text = reader.readFile(path);
  return text && text.trim() ? text.trim() : DEFAULT_PREAMBLE;
}

export interface ContextDoc {
  file: string;
  text: string;
  truncated: boolean;
}

/** 按会话 workspace 读 def.context 声明的那几份文档。
    basename 在解析时已经过滤过一遍，这里再过滤一遍——两处独立判断比互相信任
    更皮实（同 saveSubagent 收权的理由）。读不到就跳过：一个工程没有 AGENTS.md
    是常态，不该因此派不出活 */
export function readContextDocs(
  workspace: string,
  files: readonly string[],
  reader: FileReader = nodeFileReader
): ContextDoc[] {
  const out: ContextDoc[] = [];
  for (const file of files) {
    if (!isSafeContextFile(file)) continue;
    const text = reader.readFile(join(workspace, file));
    if (text === null) continue;
    const truncated = text.length > CONTEXT_DOC_LIMIT;
    out.push({ file, text: truncated ? text.slice(0, CONTEXT_DOC_LIMIT) : text, truncated });
  }
  return out;
}

/** 模型看到的全部 = 前置词 + 工作区文档 + 正文。
    custom 是覆盖全局而不是追加（ADR-0048：追加的话它和 instructions 拼起来
    对模型完全一样，就只是 UI 分栏） */
export function composeSubagentPrompt(opts: {
  def: SubagentDef;
  globalPreamble: string;
  docs: readonly ContextDoc[];
}): string {
  const p = opts.def.preamble;
  const preamble =
    p.mode === "off" ? "" : p.mode === "custom" ? p.text.trim() : opts.globalPreamble.trim();

  const blocks: string[] = [];
  if (preamble) blocks.push(preamble);
  for (const doc of opts.docs) {
    const tail = doc.truncated ? "\n\n（本文件过长，已截断）" : "";
    blocks.push(`## 工作区文档：${doc.file}\n\n${doc.text.trim()}${tail}`);
  }
  const body = opts.def.instructions.trim();
  if (body) blocks.push(body);
  return blocks.join("\n\n");
}
```

- [ ] **Step 4: 跑测试**

Run: `npx vitest run tests/main/subagentPrompt.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/subagentPrompt.ts tests/main/subagentPrompt.test.ts
git commit -m "feat(subagent): 前置词拼装抽成纯函数,读盘以 reader 注入

这段的返回值就是落进 subagent_briefed 快照的那一段——模型看到的全部。
它必须能在测试里不碰磁盘地跑遍每条分支,所以拼装是纯的,读盘缩在两个
小函数里。context 的 basename 在这里再挡一次:解析时挡过了,这是第二道。"
```

---

### Task 4: runner 用上三层前置词

**Files:**
- Modify: `src/main/subagentRunner.ts`
- Test: `tests/main/subagentRunner.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `composeSubagentPrompt` / `readGlobalPreamble` / `readContextDocs` / `GLOBAL_PREAMBLE_PATH`
- Produces: `SubagentRunnerDeps` 新增可选 `composePrompt?: (def: SubagentDef, workspace: string) => string`

- [ ] **Step 1: 先写失败的测试**

在 `tests/main/subagentRunner.test.ts` 的 `describe("createSubagentRunner", ...)` 里追加（`fixtures()` 与 `def()` 都是该文件顶部已有的工厂）：

```ts
  it("subagent_briefed 记的是拼装后的全文,不是文件里那段正文", async () => {
    const { store, attachments, push, parent, seen } = fixtures();
    const runner = createSubagentRunner({
      store,
      attachments,
      push,
      list: () => [def({ instructions: "正文" })],
      parent,
      composePrompt: (d, workspace) => `[前置@${workspace}]${d.instructions}`,
      runTurn: async (agent) => {
        store.append({
          sessionId: agent.sessionId,
          ts: Date.now(),
          type: "assistant_message",
          content: "done",
          model: "deepseek-chat",
        });
      },
    });
    const out = await runner.run({ agent: "searcher", task: "t", parentToolCallId: "call_1" });

    const briefed = store
      .load(out.childSessionId)
      .find((e) => e.type === "subagent_briefed");
    expect(briefed?.type === "subagent_briefed" && briefed.instructions).toBe(
      `[前置@${parent().workspace}]正文`
    );
    expect(seen.some((e) => e.type === "subagent_briefed")).toBe(true);
  });
```

- [ ] **Step 2: 跑一遍确认它红**

Run: `npx vitest run tests/main/subagentRunner.test.ts`
Expected: FAIL —— `composePrompt` 不是 deps 的合法字段。

- [ ] **Step 3: 改 `src/main/subagentRunner.ts`**

① 删掉文件里那个 `PREAMBLE` 常量（连同它上面的注释块——那段理由搬进 `DEFAULT_PREAMBLE` 的注释里了）。

② import 补：

```ts
import {
  GLOBAL_PREAMBLE_PATH,
  composeSubagentPrompt,
  readContextDocs,
  readGlobalPreamble,
} from "./subagentPrompt.js";
```

③ `SubagentRunnerDeps` 里加：

```ts
  /** 拼好的 system prompt。以函数注入而不是传一份拼好的字符串：读盘要发生在
      **派活那一刻**（工作区文档改了，下次派活就是新的），而不是接线那一刻。
      测试喂假实现 */
  composePrompt?: (def: SubagentDef, workspace: string) => string;
```

④ 在 `createSubagentRunner` 里 `const runTurn = ...` 旁边加：

```ts
  const composePrompt =
    deps.composePrompt ??
    ((def: SubagentDef, workspace: string) =>
      composeSubagentPrompt({
        def,
        globalPreamble: readGlobalPreamble(GLOBAL_PREAMBLE_PATH),
        docs: readContextDocs(workspace, def.context),
      }));
```

⑤ `instructions: PREAMBLE + def.instructions,` 换成：

```ts
          instructions: composePrompt(def, parent.workspace),
```

- [ ] **Step 4: 跑测试**

Run: `npx vitest run tests/main/subagentRunner.test.ts && npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/subagentRunner.ts tests/main/subagentRunner.test.ts
git commit -m "feat(subagent): 派活时按三层拼前置词,快照记拼装后的全文

composePrompt 以函数注入而不是传一份拼好的字符串:读盘要发生在派活
那一刻(工作区文档改了下次派活就是新的),不是接线那一刻。"
```

---

### Task 5: 重建历史子会话一律信快照（关闭 #140）

**Files:**
- Modify: `src/main/resumeChild.ts`
- Modify: `src/main/index.ts`（调用点去掉第二个参数）
- Test: `tests/main/resumeChild.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `childAgentConfig(events: readonly SessionEvent[]): ChildAgentConfig | null`（**单参数**）

- [ ] **Step 1: 改测试（既有用例要跟着改签名）**

`tests/main/resumeChild.test.ts` 里所有 `childAgentConfig(events, defs)` 去掉第二个参数，并把「磁盘定义优先」那一组用例换成：

```ts
it("磁盘上还有同名定义,也不采信它——重建只信快照", () => {
  const events = [
    { type: "session_created", spawnedBy: { sessionId: "p", toolCallId: "t", agent: "r" } },
    { type: "subagent_briefed", agent: "r", instructions: "x", tools: ["read_file"], model: "m" },
  ] as unknown as SessionEvent[];
  const cfg = childAgentConfig(events);
  expect(cfg).toEqual({ agent: "r", allowTools: ["read_file"], deny: true });
});

it("没有快照(理论不可达) = 零工具 + deny", () => {
  const events = [
    { type: "session_created", spawnedBy: { sessionId: "p", toolCallId: "t", agent: "r" } },
  ] as unknown as SessionEvent[];
  expect(childAgentConfig(events)).toEqual({ agent: "r", allowTools: [], deny: true });
});

it("不是子会话 = null", () => {
  const events = [{ type: "session_created" }] as unknown as SessionEvent[];
  expect(childAgentConfig(events)).toBeNull();
});
```

- [ ] **Step 2: 跑一遍确认它红**

Run: `npx vitest run tests/main/resumeChild.test.ts`
Expected: FAIL（多传/少传参数的类型错，或「磁盘优先」那条断言不成立）。

- [ ] **Step 3: 改 `src/main/resumeChild.ts`**

`childAgentConfig` 整个替换（连同它上面的文档注释）：

```ts
/**
 * 从一份会话日志里认出"这是谁派出来的子会话"，并把它当初那副装备找回来。
 *
 * 不是子会话 → null（调用方照旧按主会话装配）。
 *
 * **只信 `subagent_briefed` 快照，不读磁盘定义**（ADR-0048 决策 3）。快照是
 * append-only 日志的一部分 —— 事实来源；磁盘上那份 .md 是可变的外部状态，用它
 * 重建等于让一个历史会话的内容随文件改动而改写，与"任何投影必须可从日志推导"
 * 直接冲突。曾经这里是"磁盘优先、快照兜底"，代价是用户改一改 tools 就能给一个
 * 历史子会话换副装备。
 *
 * 审批档快照里没有（它从来没落过盘），所以重建一律按最严的 deny —— 推不出来
 * 就不能替用户假设它松。
 *
 * **不存在"认不出就当主 agent 建"这条退路**——那等于删掉一个 md 文件
 * 就能把一个只读搜索员提权成带 bash + task 的全权 agent。
 */
export function childAgentConfig(events: readonly SessionEvent[]): ChildAgentConfig | null {
  const first = events[0];
  if (!first || first.type !== "session_created" || !first.spawnedBy) return null;
  const briefed = events.find((e) => e.type === "subagent_briefed");
  return {
    agent: first.spawnedBy.agent,
    // 连快照都没有（理论不可达：briefed 是子会话的第 1 条）= 一把工具都不给。
    // 宁可这个会话只能看不能动，也不给它一副来路不明的装备
    allowTools: briefed?.type === "subagent_briefed" ? briefed.tools : [],
    deny: true,
  };
}
```

顶部 `import type { SubagentDef } from "../shared/subagent.js";` 已无人用，删掉。

- [ ] **Step 4: 改调用点**

`src/main/index.ts`：`const child = childAgentConfig(events, listSubagents(null));` → `const child = childAgentConfig(events);`

- [ ] **Step 5: 跑测试**

Run: `npm test && npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/main/resumeChild.ts src/main/index.ts tests/main/resumeChild.test.ts
git commit -m "fix(subagent): 重建历史子会话只信快照,不读磁盘定义

关闭 #140。快照是 append-only 日志的一部分(事实来源),磁盘上那份 .md
是可变外部状态——用它重建等于让历史会话随文件改动而改写,跟'任何投影
必须可从日志推导'直接冲突。这次让磁盘定义变肥(多了三层前置词),赌注
比 #140 开出来的时候更大,所以一并拍掉。

顺带收权:磁盘那条分支能带出 ask/auto,去掉之后重建的子会话一律 deny。"
```

---

### Task 6: 全局前置词的 IPC 通道

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/shared/shellBridge.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/store.ts`

**Interfaces:**
- Consumes: Task 3 的 `GLOBAL_PREAMBLE_PATH` / `nodeFileReader`；Task 1 的 `DEFAULT_PREAMBLE`
- Produces: 桥面 `getSubagentPreamble()` / `saveSubagentPreamble(text: string | null)`，都返回 `{ text: string; isDefault: boolean }`；store 的 `subagentPreamble` 状态与两个 action

- [ ] **Step 1: `src/shared/shellBridge.ts`**

在 `createSubagent` 声明之后插入：

```ts
  /** 全局前置词（~/.otter/subagent-preamble.md）。isDefault = 文件不在／是空的,
      正文是内置默认那段 */
  getSubagentPreamble(): Promise<{ text: string; isDefault: boolean }>;
  /** 写回全局前置词。text === null 或全空白 = 删掉文件 = 恢复内置默认 */
  saveSubagentPreamble(text: string | null): Promise<{ text: string; isDefault: boolean }>;
```

`CHANNELS` 里 `createSubagent` 之后加：

```ts
  getSubagentPreamble: "otter:getSubagentPreamble",
  saveSubagentPreamble: "otter:saveSubagentPreamble",
```

- [ ] **Step 2: `src/main/index.ts`**

import 补 `rmSync`（`node:fs`）、`DEFAULT_PREAMBLE`（`../shared/subagent.js`）、`GLOBAL_PREAMBLE_PATH` 与 `nodeFileReader`（`./subagentPrompt.js`）；`dirname`（`node:path`）。在 `createSubagent` handler 之后插入：

```ts
  /** 全局前置词此刻的状态。isDefault 按**文件在不在**判断,不按内容比对——
      用户存了一段正好和内置默认一字不差的文本时,他确实是自己存过一份,
      界面不该说"你用的是内置默认" */
  const preambleState = (): { text: string; isDefault: boolean } => {
    const raw = nodeFileReader.readFile(GLOBAL_PREAMBLE_PATH);
    const custom = raw !== null && raw.trim() !== "";
    return { text: custom ? raw.trim() : DEFAULT_PREAMBLE, isDefault: !custom };
  };

  ipcMain.handle(CHANNELS.getSubagentPreamble, () => preambleState());

  ipcMain.handle(CHANNELS.saveSubagentPreamble, (_e, text: string | null) => {
    if (text === null || text.trim() === "") {
      // 删文件而不是写一份内容等于默认的:只有"文件不在"才是真的恢复默认——
      // 以后内置默认那段改了,没删文件的人会被钉在旧版本上
      try {
        rmSync(GLOBAL_PREAMBLE_PATH);
      } catch {
        // 本来就没有 = 已经是默认,不是错误
      }
    } else {
      mkdirSync(dirname(GLOBAL_PREAMBLE_PATH), { recursive: true });
      writeFileSync(GLOBAL_PREAMBLE_PATH, `${text.trim()}\n`, "utf8");
    }
    return preambleState();
  });
```

（`mkdirSync` / `writeFileSync` 若 index.ts 尚未 import，一并补上。）

- [ ] **Step 3: `src/preload/index.ts`**

```ts
  getSubagentPreamble: () => ipcRenderer.invoke(CHANNELS.getSubagentPreamble),
  saveSubagentPreamble: (text) => ipcRenderer.invoke(CHANNELS.saveSubagentPreamble, text),
```

- [ ] **Step 4: `src/renderer/src/store.ts`**

state：`subagentPreamble: { text: string; isDefault: boolean } | null;`（初值 `null` = 还没问过）。action：

```ts
  async refreshSubagentPreamble() {
    set({ subagentPreamble: await window.otter.getSubagentPreamble() });
  },
  async saveSubagentPreamble(text) {
    set({ subagentPreamble: await window.otter.saveSubagentPreamble(text) });
  },
```

接口声明同步加两条。

- [ ] **Step 5: 编译 + 跑门禁**

Run: `npx tsc --noEmit && npm test`
Expected: 无输出 / PASS。

- [ ] **Step 6: 提交**

```bash
git add src/main/index.ts src/shared/shellBridge.ts src/preload/index.ts src/renderer/src/store.ts
git commit -m "feat(subagent): 全局前置词过桥,恢复默认 = 删文件

isDefault 按文件在不在判断,不按内容比对:用户存了一段正好和内置默认
一字不差的文本时,他确实是自己存过一份。恢复默认删文件而不是写一份
内容等于默认的——以后内置那段改了,没删文件的人会被钉在旧版本上。"
```

---

### Task 7: 设置页 —— 改名、作用域下拉、全局前置词卡、行内两块新控件

**Files:**
- Modify: `src/renderer/src/components/SubagentSettings.tsx`
- Test: `tests/renderer/subagentSettings.test.tsx`（若不存在则新建；只测纯逻辑部分，见 Step 1）
- Modify: `src/renderer/src/lib/subagentScopes.ts`（新建，纯函数）
- Test: `tests/renderer/subagentScopes.test.ts`（新建）

> **不要碰** `src/renderer/src/App.tsx`、`components/SidebarNub.tsx`、`components/ui/sidebar.tsx`、`lib/sidebarNarrow.ts`、`tests/renderer/sidebarNarrow.test.ts` —— 另一条 lane 的未提交改动住在里面（见 Global Constraints）。

**Interfaces:**
- Consumes: Task 2 的 `subagentScope` / `setSubagentScope`、Task 6 的 `subagentPreamble` / 两个 action、Task 1 的 `SubagentPreamble` / `DEFAULT_PREAMBLE`
- Produces: 无（终端任务）

- [ ] **Step 1: 先写失败的测试（作用域候选的纯逻辑）**

新建 `tests/renderer/subagentScopes.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { subagentScopeOptions } from "../../src/renderer/src/lib/subagentScopes.js";
import type { SessionSummary } from "../../src/shared/shellBridge.js";

const s = (workspace: string | null, lastTs: number): SessionSummary =>
  ({ workspace, lastTs, spawnedFrom: null }) as unknown as SessionSummary;

describe("subagentScopeOptions", () => {
  it("第一项永远是「用户」", () => {
    expect(subagentScopeOptions([])[0]).toEqual({ workspace: null, label: "用户" });
  });

  it("工作区按最近用过排在后面,短名取路径末段", () => {
    const opts = subagentScopeOptions([s("/a/proj-x", 2), s("/a/proj-y", 5)]);
    expect(opts.slice(1)).toEqual([
      { workspace: "/a/proj-y", label: "proj-y" },
      { workspace: "/a/proj-x", label: "proj-x" },
    ]);
  });

  it("同一个工作区只出现一次", () => {
    expect(subagentScopeOptions([s("/a/p", 1), s("/a/p", 9)])).toHaveLength(2);
  });

  it("没有工作区的史前会话不入选", () => {
    expect(subagentScopeOptions([s(null, 1)])).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑一遍确认它红**

Run: `npx vitest run tests/renderer/subagentScopes.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写 `src/renderer/src/lib/subagentScopes.ts`**

```ts
// 设置页作用域下拉的候选。
// 候选来自"有过会话的工程文件夹"——不新开一条 IPC 去列目录:会话列表本来就在
// store 里,而一个从没开过会话的文件夹,用户也没有在那儿建子智能体的由头。
// 代价写在 ADR-0048「接受的代价」里:要先在那个工程开一次会话。

import { groupSessionsByWorkspace } from "../sessionGroups.js";
import type { SessionSummary } from "../../../shared/shellBridge.js";

export interface SubagentScopeOption {
  /** null = 用户级 */
  workspace: string | null;
  label: string;
}

export function subagentScopeOptions(sessions: readonly SessionSummary[]): SubagentScopeOption[] {
  return [
    { workspace: null, label: "用户" },
    ...groupSessionsByWorkspace([...sessions]).map((g) => ({
      workspace: g.workspace,
      label: g.label,
    })),
  ];
}
```

- [ ] **Step 4: 跑测试**

Run: `npx vitest run tests/renderer/subagentScopes.test.ts`
Expected: PASS。

- [ ] **Step 5: 改 `src/renderer/src/components/SubagentSettings.tsx` —— 改名与作用域**

① 文件顶部注释块里的「Subagent 栏目」改成「子智能体栏目」，正文里对用户说的话统一改口。

② 头部标题 `Subagent` → `子智能体`，并在标题右侧插入作用域下拉。`SubagentSettings` 组件里加：

```tsx
  const sessions = useChat((s) => s.sessions);
  const scope = useChat((s) => s.subagentScope);
  const setScope = useChat((s) => s.setSubagentScope);
  const scopeOptions = useMemo(() => subagentScopeOptions(sessions), [sessions]);
  const current = scopeOptions.find((o) => o.workspace === scope) ?? scopeOptions[0]!;
```

`useEffect` 改成 `void refreshSubagents();` 之外再加 `void refreshSubagentPreamble();`。

头部 JSX（`<span className="font-[650] ...">子智能体</span>` 之后、「新建」按钮之前）：

```tsx
        <label className="sr-only" htmlFor="subagent-scope">作用域</label>
        <select
          id="subagent-scope"
          value={scope ?? ""}
          onChange={(e) => void setScope(e.target.value === "" ? null : e.target.value)}
          className="press-scale border border-border rounded-md bg-card px-2 py-1 text-[12.5px] text-foreground transition-colors duration-150"
          title={scope ?? "所有工程都能用的那一层"}
        >
          {scopeOptions.map((o) => (
            <option key={o.workspace ?? "user"} value={o.workspace ?? ""}>
              {o.label}
            </option>
          ))}
        </select>
```

③ `SETTINGS_BODY` 里那段 `HINT` 说明改写（把作用域讲清楚）：

```tsx
        <p className={HINT}>
          主 agent 靠 <code>task</code> 工具把子任务派给这里定义的某一个子智能体。
          「用户」这一层处处可用；选中某个工程时看到的是它自己那一层（
          <code>&lt;工程&gt;/.otter/agents/</code>），只在该工程的会话里派得出去，
          同名时盖过用户级那份。子智能体没人盯着屏幕，审批档缺省是「直接拒绝」。
        </p>
        {scope && <p className={cn(HINT, "font-mono text-[11px]")}>{scope}</p>}
```

④ 空态文案里的「subagent」改成「子智能体」，目录按当前作用域给：`{scope ? `${scope}/.otter/agents` : "~/.otter/agents"}`。

⑤ `NewSubagentDialog` 标题改「新建子智能体」，`DialogDescription` 加一句建在哪：

```tsx
            先起个名字，其余字段（description / 工具 / 审批档 / 前置词 / 正文）建好之后在列表里展开填。
            建在<b>{scopeLabel}</b>这一层。
```

（`scopeLabel` 由 `SubagentSettings` 作为 prop 传进来。）

- [ ] **Step 6: 全局前置词卡**

在 `SETTINGS_BODY` 里、说明段之后、列表之前插入 `<GlobalPreambleCard />`，并在文件末尾加：

```tsx
/** 全局前置词 —— 拼在每个子智能体正文前面的那一段。单个子智能体可以覆盖它。
    「恢复默认」是删文件不是写一份等于默认的内容:以后内置默认那段改了,
    只有真的删掉文件的人才会跟着更新 */
function GlobalPreambleCard() {
  const state = useChat((s) => s.subagentPreamble);
  const savePreamble = useChat((s) => s.saveSubagentPreamble);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 后端回来的状态是这个输入框的真相来源；用户改到一半时不要被它冲掉,
  // 所以只在"这一份状态是新的"时同步（用 isDefault + text 一起当身份）
  useEffect(() => {
    if (state) setDraft(state.text);
  }, [state?.text, state?.isDefault]);

  if (!state) return null;

  const dirty = draft.trim() !== state.text.trim();

  const run = async (text: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await savePreamble(text);
    } catch (e) {
      setError(bridgeErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-border rounded-[10px] px-[14px] py-4 flex flex-col gap-[6px]">
      <label className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">
        全局前置词
      </label>
      <p className={HINT}>
        拼在每个子智能体正文前面；单个子智能体可以在下面覆盖它。存在{" "}
        <code>~/.otter/subagent-preamble.md</code>，也可以直接用编辑器改。
      </p>
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="font-mono text-[12.5px] min-h-32"
      />
      {error && <p className={ERR_TXT}>{error}</p>}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!dirty || busy} onClick={() => void run(draft)}>
          {busy ? "保存中…" : dirty ? "保存" : "已保存"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={state.isDefault || busy}
          onClick={() => void run(null)}
        >
          恢复默认
        </Button>
        <span className={HINT}>{state.isDefault ? "用的是内置默认" : "已自定义"}</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: 行内两块新控件**

`SubagentRow` 里：

① state：

```tsx
  const [preambleMode, setPreambleMode] = useState<SubagentPreamble["mode"]>(def.preamble.mode);
  const [preambleText, setPreambleText] = useState(
    def.preamble.mode === "custom" ? def.preamble.text : ""
  );
  const [context, setContext] = useState<string[]>(def.context);
```

② `preamble` 的组装（放在 `dirty` 之前）：

```tsx
  // custom 但正文是空的 = 等同于没覆盖,存成 default——否则文件里会留一个空块标量,
  // 读回来又变成 default,界面上那个"自定义"档下次打开就自己跳回去了
  const preamble: SubagentPreamble =
    preambleMode === "custom" && preambleText.trim()
      ? { mode: "custom", text: preambleText.trim() }
      : preambleMode === "off"
        ? { mode: "off" }
        : { mode: "default" };
```

③ `dirty` 追加：

```tsx
    preamble.mode !== def.preamble.mode ||
    (preamble.mode === "custom" &&
      def.preamble.mode === "custom" &&
      preamble.text !== def.preamble.text) ||
    context.length !== def.context.length ||
    context.some((c) => !def.context.includes(c)) ||
```

④ `resetDraft` 追加三行；`save` 的请求体追加 `preamble,` 与 `context,`；`copyToOtterAgents` 的两处请求体也追加 `preamble: def.preamble, context: def.context, scope: def.scope,`（`scope` 会被后端按名字查到的那份覆盖，传值只是让类型完整、不撒谎）。

⑤ JSX：在「审批」那块之后、「正文」之前插入：

```tsx
        <div className="flex flex-col gap-[6px]">
          <label className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">
            前置词
          </label>
          <div
            role="radiogroup"
            aria-label="前置词"
            className="inline-flex gap-1 rounded-[10px] border border-border bg-card p-1 w-fit"
          >
            {PREAMBLE_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={preambleMode === o.value}
                disabled={def.readOnly}
                className={cn(
                  "press-scale rounded-[7px] px-3 py-[5px] text-[12.5px] transition-colors duration-150 disabled:opacity-50",
                  preambleMode === o.value
                    ? "bg-foreground/[0.10] font-[550] text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
                onClick={() => setPreambleMode(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
          {preambleMode === "custom" ? (
            <Textarea
              value={preambleText}
              disabled={def.readOnly}
              onChange={(e) => setPreambleText(e.target.value)}
              className="font-mono text-[12.5px] min-h-24"
              placeholder="这一段会替代全局前置词，只对这个子智能体生效"
            />
          ) : (
            <p className={HINT}>
              {preambleMode === "off"
                ? "一段前置词都不加——它连「最终一段文本就是返回值」这条都不知道，正文里要自己写清楚"
                : "用上面那份全局前置词"}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-[6px]">
          <label className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">
            工作区文档
          </label>
          <div className="flex flex-wrap gap-[6px]">
            {CONTEXT_FILES.map((f) => {
              const checked = context.includes(f);
              return (
                <button
                  key={f}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  disabled={def.readOnly}
                  className={cn(
                    "press-scale rounded-full border px-[10px] py-[3px] text-[12px] font-mono transition-colors duration-150 disabled:opacity-50",
                    checked
                      ? "border-transparent bg-foreground/[0.10] text-foreground font-[550]"
                      : "border-border text-muted-foreground hover:text-foreground"
                  )}
                  onClick={() =>
                    setContext((prev) => (checked ? prev.filter((n) => n !== f) : [...prev, f]))
                  }
                >
                  {f}
                </button>
              );
            })}
          </div>
          <p className={HINT}>
            派活时按会话所在的工程读这些文件，拼在正文前面；读不到就跳过。
            用户级的子智能体也能勾——它在哪个工程里被派出去，读的就是哪个工程的。
          </p>
        </div>
```

⑥ 文件顶部常量区加：

```tsx
const PREAMBLE_OPTIONS: { value: SubagentPreamble["mode"]; label: string }[] = [
  { value: "default", label: "用全局" },
  { value: "off", label: "不加" },
  { value: "custom", label: "自定义" },
];

/** 可勾选的工作区文档。只给这两个:frontmatter 里手写任意 basename 照样认,
    但界面上摊开一个自由输入框等于邀请用户去踩 basename 那条限制 */
const CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
```

⑦ 「正文」那个 `Textarea` 的 placeholder 改成：`"system prompt 本体（前置词在上面单独配，这里不用重复写「你是一个子智能体」之类的话）"`。

- [ ] **Step 8: 编译 + 门禁**

Run: `npx tsc --noEmit && npm test`
Expected: 无输出 / PASS。

- [ ] **Step 9: 提交**

```bash
git add src/renderer/src/components/SubagentSettings.tsx src/renderer/src/lib/subagentScopes.ts tests/renderer/subagentScopes.test.ts
git commit -m "feat(ui): 子智能体设置页 —— 改名、作用域下拉、全局前置词卡、行内前置词与文档注入

作用域候选来自会话列表(有过会话的工程文件夹),不新开 IPC 去列目录。
工作区文档只给 AGENTS.md / CLAUDE.md 两个勾选:frontmatter 里手写
任意 basename 照样认,但界面上摊开自由输入框等于邀请用户去踩那条限制。
不新增动画——设置页是低频且用户正盯着看的界面,多一段 200ms 只是让人等。"
```

---

## 收尾

- [ ] `npm test` 全绿 + `npx tsc --noEmit` 干净
- [ ] 手工验收（GUI）：切作用域、建工作区级子智能体、改全局前置词并「恢复默认」、勾上 `AGENTS.md` 派一次活并在子会话时间线上确认注入生效、打开一个历史子会话确认它是只读 deny 的
- [ ] PR 引用 #144，合并时关闭 #144 与 #140
- [ ] 合并前重新 `git fetch`：**ADR 编号在合并时才算数**，另一条 lane 可能先占了 0048（上一轮就撞过一次，而且号撞不表现为合并冲突）
