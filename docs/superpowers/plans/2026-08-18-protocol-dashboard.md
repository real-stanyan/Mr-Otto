# Protocol 只读仪表盘 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Otto 内新增只读「Protocol」视图，可视化目标仓库的 ADR（本地 markdown）与 GitHub issues/handoff（gh CLI），零写操作。

**Architecture:** 纯函数解析层放 `src/shared/protocol.ts`（类型 + 解析器 + gh JSON 映射，三边共 import）；主进程 `src/main/protocolService.ts` 做 fs 扫描 + gh 子进程（依赖注入，测试喂假实现，照抄 `skills.ts` 模式）；ShellBridge 扩四个只读方法；渲染层 zustand store 加 protocol 状态 + 独立组件 `ProtocolView.tsx`（不塞进 App.tsx）。

**Tech Stack:** TypeScript strict / Electron IPC / gh CLI（execFile 子进程）/ react-markdown + remark-gfm（已在依赖）/ vitest。

**Spec:** `docs/superpowers/specs/2026-08-18-protocol-dashboard-design.md`

## Global Constraints

- ESM 全仓：相对 import 一律带 `.js` 后缀（TS 源文件也是）
- 渲染进程只经 `window.otter`（ShellBridge），禁碰 Node API——AGENTS.md 硬规矩
- 测试放 `tests/` 镜像 `src/` 结构，Gate = `npm test`（vitest run），收班前必绿
- UI 只用现有 shadcn 组件（button/separator/skeleton/tooltip…，无 Tabs——分段切换用 Button 拼）+ Tailwind 语义令牌（`bg-card` / `text-muted-foreground` / `text-brand` 等），不写裸色值
- 注释风格跟仓库走：中文、讲 why 不讲 what
- 严格只读：本计划零写文件（除源码本身）、零 GitHub 写请求
- 提交小步走，message 讲 why；本活走当前分支 `claude/gearbox-mr-otto-integration-c759dc`，最终 PR + merge commit

---

### Task 0: 开 Task issue（协议合规）

**Files:** 无代码。

- [ ] **Step 1: 建 issue 并认领**

```bash
gh issue create --title "Protocol 只读仪表盘:gearbox 协议可视化第一刀(ADR/issues/handoff)" --body "$(cat <<'EOF'
Spec: docs/superpowers/specs/2026-08-18-protocol-dashboard-design.md
Plan: docs/superpowers/plans/2026-08-18-protocol-dashboard.md

只读三面板:ADR(本地 markdown 扫描)、GitHub issues(gh CLI)、handoff 五段式解析视图。
零写操作;第二刀(收班自动化)另立任务。
EOF
)"
gh issue edit <上一步返回的编号> --add-assignee @me
```

记下编号，最终 PR body 写 `Closes #<N>`。

---

### Task 1: shared 纯函数层（类型 + 解析器 + gh JSON 映射）

**Files:**
- Create: `src/shared/protocol.ts`
- Test: `tests/shared/protocol.test.ts`

**Interfaces:**
- Consumes: 无（零依赖纯模块）
- Produces（后续任务全靠这些签名）:
  - 类型 `AdrSummary { source: "adr" | "gearbox-adr"; id: string; title: string; path: string }`（path = 仓库相对路径）
  - 类型 `IssueRole = "task" | "memory" | "gap"`；`IssueSummary { number: number; title: string; state: "open" | "closed"; role: IssueRole; updatedAt: string }`
  - 类型 `IssueComment { author: string; createdAt: string; body: string }`；`IssueDetail { number; title; state; role; body: string; comments: IssueComment[] }`
  - 类型 `HandoffParts { done; blocked; next; closed; rationale }`（全 string）
  - 类型 `ProtocolErrorKind = "gh-missing" | "no-repo" | "gh-auth" | "gh-error"`
  - 类型 `IssuesResult = { ok: true; issues: IssueSummary[] } | { ok: false; kind: ProtocolErrorKind; detail: string }`
  - 类型 `IssueDetailResult = { ok: true; issue: IssueDetail } | { ok: false; kind: ProtocolErrorKind; detail: string }`
  - 函数 `adrIdFromFilename(name: string): string | null`
  - 函数 `extractAdrTitle(markdown: string, fallback: string): string`
  - 函数 `classifyIssueRole(title: string): IssueRole`
  - 函数 `parseHandoff(body: string): HandoffParts | null`
  - 函数 `mapIssueList(json: unknown): IssueSummary[]`（形状不对就 throw）
  - 函数 `mapIssueDetail(json: unknown): IssueDetail`（同上）
  - 函数 `classifyGhError(err: { code?: string; stderr?: string; message?: string }): { kind: ProtocolErrorKind; detail: string }`

- [ ] **Step 1: 写失败测试**

`tests/shared/protocol.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import {
  adrIdFromFilename, extractAdrTitle, classifyIssueRole, parseHandoff,
  mapIssueList, mapIssueDetail, classifyGhError,
} from "../../src/shared/protocol.js";

describe("adrIdFromFilename", () => {
  it("标准 ADR 文件名取四位编号", () => {
    expect(adrIdFromFilename("0007-skill-injection.md")).toBe("0007");
  });
  it("非 ADR 命名 = null(README、无编号、非 md)", () => {
    expect(adrIdFromFilename("README.md")).toBeNull();
    expect(adrIdFromFilename("notes.md")).toBeNull();
    expect(adrIdFromFilename("0007-skill.txt")).toBeNull();
  });
});

describe("extractAdrTitle", () => {
  it("取第一个 # 标题", () => {
    expect(extractAdrTitle("---\nfoo\n---\n# ADR-0007: skill 注入\n\n正文", "fb")).toBe("ADR-0007: skill 注入");
  });
  it("无标题退回 fallback", () => {
    expect(extractAdrTitle("没有标题的文件", "0007-skill-injection")).toBe("0007-skill-injection");
  });
});

describe("classifyIssueRole", () => {
  it("handoff/交接 = memory", () => {
    expect(classifyIssueRole("Handoff: 2026-08-18 shift")).toBe("memory");
    expect(classifyIssueRole("交接:sidebar 完工")).toBe("memory");
  });
  it("protocol gap/协议缺口 = gap", () => {
    expect(classifyIssueRole("Protocol gap: 前端样式无规矩")).toBe("gap");
    expect(classifyIssueRole("协议缺口:xx")).toBe("gap");
  });
  it("其余 = task", () => {
    expect(classifyIssueRole("shadcn/ui 接入")).toBe("task");
  });
});

describe("parseHandoff", () => {
  const std = "① 完成了 A 和 B\n② 无阻塞\n③ 下一步做 C\n④ 已关闭 #7\n⑤ 无非默认决策";
  it("标准五段全解析", () => {
    expect(parseHandoff(std)).toEqual({
      done: "完成了 A 和 B", blocked: "无阻塞", next: "下一步做 C",
      closed: "已关闭 #7", rationale: "无非默认决策",
    });
  });
  it("缺段 = null(回退原文)", () => {
    expect(parseHandoff("① A\n② B\n③ C\n④ D")).toBeNull();
  });
  it("乱序 = null(不猜作者意图)", () => {
    expect(parseHandoff("② B\n① A\n③ C\n④ D\n⑤ E")).toBeNull();
  });
  it("普通评论 = null", () => {
    expect(parseHandoff("LGTM,合了")).toBeNull();
  });
});

describe("mapIssueList", () => {
  it("gh JSON 映射 + 角色判定 + state 小写化", () => {
    const json = [
      { number: 9, title: "Protocol gap: 样式无规矩", state: "CLOSED", updatedAt: "2026-08-17T12:00:00Z" },
      { number: 16, title: "新任务", state: "OPEN", updatedAt: "2026-08-18T01:00:00Z" },
    ];
    expect(mapIssueList(json)).toEqual([
      { number: 9, title: "Protocol gap: 样式无规矩", state: "closed", role: "gap", updatedAt: "2026-08-17T12:00:00Z" },
      { number: 16, title: "新任务", state: "open", role: "task", updatedAt: "2026-08-18T01:00:00Z" },
    ]);
  });
  it("非数组/字段缺失 = throw", () => {
    expect(() => mapIssueList({})).toThrow();
    expect(() => mapIssueList([{ title: "没有 number" }])).toThrow();
  });
});

describe("mapIssueDetail", () => {
  it("正文 + 评论(author.login 摊平)", () => {
    const json = {
      number: 5, title: "Handoff: shift", state: "OPEN", body: "现状与建议",
      comments: [{ author: { login: "stanyan" }, createdAt: "2026-08-17T10:00:00Z", body: "① A\n② B\n③ C\n④ D\n⑤ E" }],
    };
    expect(mapIssueDetail(json)).toEqual({
      number: 5, title: "Handoff: shift", state: "open", role: "memory", body: "现状与建议",
      comments: [{ author: "stanyan", createdAt: "2026-08-17T10:00:00Z", body: "① A\n② B\n③ C\n④ D\n⑤ E" }],
    });
  });
  it("comments 缺省 = 空数组", () => {
    expect(mapIssueDetail({ number: 1, title: "t", state: "OPEN", body: "" }).comments).toEqual([]);
  });
});

describe("classifyGhError", () => {
  it("ENOENT = gh 未安装", () => {
    expect(classifyGhError({ code: "ENOENT", message: "spawn gh ENOENT" }).kind).toBe("gh-missing");
  });
  it("非 git 仓库 / 无 remote = no-repo", () => {
    expect(classifyGhError({ stderr: "fatal: not a git repository" }).kind).toBe("no-repo");
    expect(classifyGhError({ stderr: "no git remotes found" }).kind).toBe("no-repo");
  });
  it("未登录 = gh-auth", () => {
    expect(classifyGhError({ stderr: "To get started with GitHub CLI, please run:  gh auth login" }).kind).toBe("gh-auth");
  });
  it("其余 = gh-error,detail 带 stderr", () => {
    const r = classifyGhError({ stderr: "HTTP 500" });
    expect(r.kind).toBe("gh-error");
    expect(r.detail).toContain("HTTP 500");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/shared/protocol.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写实现**

`src/shared/protocol.ts`：

```ts
// Protocol 仪表盘 — 共享世界:类型 + 纯函数(ADR 文件名/标题解析、issue 角色判定、
// handoff 五段式解析、gh JSON 映射、gh 错误分类)。零 Node 依赖,三边可 import,全部可测。
// 只读第一刀:这里没有任何"写"的概念(spec: docs/superpowers/specs/2026-08-18-protocol-dashboard-design.md)。

export interface AdrSummary {
  source: "adr" | "gearbox-adr";
  id: string;
  title: string;
  /** 仓库相对路径(readAdr 的凭证,主进程校验必须落在 ADR 目录内) */
  path: string;
}

/** gearbox 三角色(AGENTS.md "Roles of issues & PRs"),靠标题启发式猜——猜不中归 task */
export type IssueRole = "task" | "memory" | "gap";

export interface IssueSummary {
  number: number;
  title: string;
  state: "open" | "closed";
  role: IssueRole;
  updatedAt: string;
}

export interface IssueComment {
  author: string;
  createdAt: string;
  body: string;
}

export interface IssueDetail {
  number: number;
  title: string;
  state: "open" | "closed";
  role: IssueRole;
  body: string;
  comments: IssueComment[];
}

/** gearbox Memory 五段式(ADR-0004):① 做完 ② 阻塞 ③ 下一步 ④ 关单 ⑤ 决策理由 */
export interface HandoffParts {
  done: string;
  blocked: string;
  next: string;
  closed: string;
  rationale: string;
}

export type ProtocolErrorKind = "gh-missing" | "no-repo" | "gh-auth" | "gh-error";

/** issues 面板独立降级的载体:错误不 throw 过 IPC,而是结构化回流,渲染层按 kind 给指引 */
export type IssuesResult =
  | { ok: true; issues: IssueSummary[] }
  | { ok: false; kind: ProtocolErrorKind; detail: string };

export type IssueDetailResult =
  | { ok: true; issue: IssueDetail }
  | { ok: false; kind: ProtocolErrorKind; detail: string };

/** ADR 文件名 = NNNN-slug.md(两个 ADR 目录同规);不合命名的不是 ADR,返回 null 跳过 */
export function adrIdFromFilename(name: string): string | null {
  const m = name.match(/^(\d{4})-.+\.md$/);
  return m ? m[1]! : null;
}

/** 列表标题 = 文件里第一个 `# ` 行(ADR 惯例首行即标题);没有就退回文件名去后缀 */
export function extractAdrTitle(markdown: string, fallback: string): string {
  for (const line of markdown.split(/\r?\n/)) {
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) return m[1]!;
  }
  return fallback;
}

export function classifyIssueRole(title: string): IssueRole {
  const t = title.toLowerCase();
  if (t.includes("handoff") || title.includes("交接")) return "memory";
  if (t.includes("protocol gap") || title.includes("协议缺口")) return "gap";
  return "task";
}

const HANDOFF_MARKS = ["①", "②", "③", "④", "⑤"] as const;

/** 五段式解析:①—⑤ 必须齐全且按序出现,否则 null(渲染层回退原文——宁可不解析,不猜作者意图) */
export function parseHandoff(body: string): HandoffParts | null {
  const idx = HANDOFF_MARKS.map((m) => body.indexOf(m));
  if (idx.some((i) => i < 0)) return null;
  for (let i = 1; i < idx.length; i++) if (idx[i]! <= idx[i - 1]!) return null;
  const seg = (i: number) =>
    body.slice(idx[i]! + 1, i + 1 < idx.length ? idx[i + 1]! : undefined).trim();
  return { done: seg(0), blocked: seg(1), next: seg(2), closed: seg(3), rationale: seg(4) };
}

function toState(raw: unknown): "open" | "closed" {
  return String(raw).toLowerCase() === "closed" ? "closed" : "open";
}

/** gh issue list --json 的映射。形状不对就 throw——调用方(service)统一兜成 gh-error */
export function mapIssueList(json: unknown): IssueSummary[] {
  if (!Array.isArray(json)) throw new Error("gh 输出不是数组");
  return json.map((raw) => {
    const r = raw as Record<string, unknown>;
    if (typeof r.number !== "number" || typeof r.title !== "string") {
      throw new Error("issue 字段缺失(number/title)");
    }
    return {
      number: r.number,
      title: r.title,
      state: toState(r.state),
      role: classifyIssueRole(r.title),
      updatedAt: String(r.updatedAt ?? ""),
    };
  });
}

/** gh issue view --json 的映射。author.login 摊平成 string,comments 缺省给空数组 */
export function mapIssueDetail(json: unknown): IssueDetail {
  const r = json as Record<string, unknown>;
  if (typeof r.number !== "number" || typeof r.title !== "string") {
    throw new Error("issue 字段缺失(number/title)");
  }
  const comments = Array.isArray(r.comments)
    ? r.comments.map((c) => {
        const cc = c as Record<string, unknown>;
        const author = (cc.author as Record<string, unknown> | undefined)?.login;
        return {
          author: typeof author === "string" ? author : "unknown",
          createdAt: String(cc.createdAt ?? ""),
          body: String(cc.body ?? ""),
        };
      })
    : [];
  return {
    number: r.number,
    title: r.title,
    state: toState(r.state),
    role: classifyIssueRole(r.title),
    body: String(r.body ?? ""),
    comments,
  };
}

/** gh 子进程错误分类——kind 决定渲染层给哪种指引(装 gh / 连 remote / 登录 / 通用错误) */
export function classifyGhError(err: {
  code?: string;
  stderr?: string;
  message?: string;
}): { kind: ProtocolErrorKind; detail: string } {
  const stderr = err.stderr ?? "";
  const detail = stderr.trim() || err.message || "unknown gh error";
  if (err.code === "ENOENT") return { kind: "gh-missing", detail };
  const s = stderr.toLowerCase();
  if (s.includes("not a git repository") || s.includes("no git remotes") || s.includes("could not determine"))
    return { kind: "no-repo", detail };
  if (s.includes("auth login") || s.includes("authentication") || s.includes("not logged in"))
    return { kind: "gh-auth", detail };
  return { kind: "gh-error", detail };
}
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `npx vitest run tests/shared/protocol.test.ts`
Expected: PASS 全部。

- [ ] **Step 5: Commit**

```bash
git add src/shared/protocol.ts tests/shared/protocol.test.ts
git commit -m "feat(protocol): 共享纯函数层——ADR/issue/handoff 解析与 gh 映射

五段式宁缺毋滥(缺段/乱序回退原文),错误分类结构化回流不 throw 过 IPC,
为面板独立降级铺底。零 Node 依赖,三边共 import。"
```

---

### Task 2: 主进程 ProtocolService（fs 扫描 + gh 子进程）

**Files:**
- Create: `src/main/protocolService.ts`
- Test: `tests/main/protocolService.test.ts`

**Interfaces:**
- Consumes: Task 1 的全部类型与函数
- Produces:
  - `interface ProtocolDeps { listFiles(dir: string): string[]; readFile(path: string): string | null; execGh(args: string[], cwd: string): Promise<{ stdout: string }> }`
  - `function createProtocolService(deps?: ProtocolDeps): ProtocolService`
  - `interface ProtocolService { listAdrs(repoDir: string): AdrSummary[]; readAdr(repoDir: string, relPath: string): { markdown: string }; listIssues(repoDir: string): Promise<IssuesResult>; getIssue(repoDir: string, n: number): Promise<IssueDetailResult> }`
  - `readAdr` 对越界/缺失路径 throw（IPC 层自然变 rejected Promise）

- [ ] **Step 1: 写失败测试**

`tests/main/protocolService.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { createProtocolService, type ProtocolDeps } from "../../src/main/protocolService.js";

/** 假文件系统:路径 → 内容;假 gh:按 args 决定吐 stdout 还是炸 */
function fakeDeps(init: {
  files?: Record<string, string>;
  gh?: (args: string[]) => { stdout: string } | { err: { code?: string; stderr?: string; message?: string } };
} = {}): ProtocolDeps {
  const files = init.files ?? {};
  return {
    listFiles(dir) {
      const prefix = dir.endsWith("/") ? dir : dir + "/";
      const names = Object.keys(files)
        .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
        .map((p) => p.slice(prefix.length));
      return names;
    },
    readFile(path) {
      return files[path] ?? null;
    },
    async execGh(args) {
      const r = init.gh?.(args);
      if (!r) throw new Error("unexpected gh call");
      if ("err" in r) throw Object.assign(new Error(r.err.message ?? "gh failed"), r.err);
      return r;
    },
  };
}

describe("listAdrs", () => {
  it("双目录合并,各自排序,project adr 在前;非 ADR 命名跳过", () => {
    const svc = createProtocolService(fakeDeps({
      files: {
        "/repo/docs/adr/0002-b.md": "# ADR-0002: B",
        "/repo/docs/adr/0001-a.md": "# ADR-0001: A",
        "/repo/docs/adr/README.md": "# 目录说明",
        "/repo/docs/gearbox-adr/0001-x.md": "# GX-0001",
      },
    }));
    expect(svc.listAdrs("/repo")).toEqual([
      { source: "adr", id: "0001", title: "ADR-0001: A", path: "docs/adr/0001-a.md" },
      { source: "adr", id: "0002", title: "ADR-0002: B", path: "docs/adr/0002-b.md" },
      { source: "gearbox-adr", id: "0001", title: "GX-0001", path: "docs/gearbox-adr/0001-x.md" },
    ]);
  });
  it("目录不存在 = 空数组(ADR 面板空态,不炸)", () => {
    expect(createProtocolService(fakeDeps()).listAdrs("/repo")).toEqual([]);
  });
});

describe("readAdr", () => {
  const svc = createProtocolService(fakeDeps({
    files: { "/repo/docs/adr/0001-a.md": "# ADR-0001: A\n正文" },
  }));
  it("合法路径读全文", () => {
    expect(svc.readAdr("/repo", "docs/adr/0001-a.md")).toEqual({ markdown: "# ADR-0001: A\n正文" });
  });
  it("越界路径拒绝(目录外 / .. 逃逸)", () => {
    expect(() => svc.readAdr("/repo", "src/main/index.ts")).toThrow(/越界/);
    expect(() => svc.readAdr("/repo", "docs/adr/../../secrets.md")).toThrow(/越界/);
  });
  it("不存在 = throw", () => {
    expect(() => svc.readAdr("/repo", "docs/adr/0099-nope.md")).toThrow(/不存在/);
  });
});

describe("listIssues", () => {
  it("gh 正常输出 = ok + 映射", async () => {
    const svc = createProtocolService(fakeDeps({
      gh: () => ({ stdout: JSON.stringify([{ number: 1, title: "t", state: "OPEN", updatedAt: "" }]) }),
    }));
    const r = await svc.listIssues("/repo");
    expect(r).toEqual({ ok: true, issues: [{ number: 1, title: "t", state: "open", role: "task", updatedAt: "" }] });
  });
  it("gh 不在 = gh-missing", async () => {
    const svc = createProtocolService(fakeDeps({ gh: () => ({ err: { code: "ENOENT", message: "spawn gh ENOENT" } }) }));
    expect(await svc.listIssues("/repo")).toMatchObject({ ok: false, kind: "gh-missing" });
  });
  it("未登录 = gh-auth", async () => {
    const svc = createProtocolService(fakeDeps({ gh: () => ({ err: { stderr: "please run gh auth login" } }) }));
    expect(await svc.listIssues("/repo")).toMatchObject({ ok: false, kind: "gh-auth" });
  });
  it("非法 JSON = gh-error", async () => {
    const svc = createProtocolService(fakeDeps({ gh: () => ({ stdout: "not json" }) }));
    expect(await svc.listIssues("/repo")).toMatchObject({ ok: false, kind: "gh-error" });
  });
});

describe("getIssue", () => {
  it("正常输出 = ok + 详情映射", async () => {
    const svc = createProtocolService(fakeDeps({
      gh: (args) => {
        expect(args).toContain("view");
        return { stdout: JSON.stringify({ number: 5, title: "交接:x", state: "OPEN", body: "b", comments: [] }) };
      },
    }));
    const r = await svc.getIssue("/repo", 5);
    expect(r).toMatchObject({ ok: true, issue: { number: 5, role: "memory" } });
  });
  it("gh 炸 = 结构化错误", async () => {
    const svc = createProtocolService(fakeDeps({ gh: () => ({ err: { stderr: "HTTP 500" } }) }));
    expect(await svc.getIssue("/repo", 5)).toMatchObject({ ok: false, kind: "gh-error" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/main/protocolService.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写实现**

`src/main/protocolService.ts`：

```ts
// Protocol 仪表盘 — 主进程数据源:ADR 走 fs 扫描,issues 走 gh CLI 子进程。
// 这是 app 功能不是 agent 工具,主进程直用 fs/child_process 合规(同 SQLite 日志先例,
// 不经 ExecutionWorld;见 spec §2)。依赖注入照抄 skills.ts 模式:测试喂假实现。
// 严格只读:gh 只调 list/view,永不写。

import { readdirSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, normalize } from "node:path";
import {
  classifyGhError, mapIssueDetail, mapIssueList, adrIdFromFilename, extractAdrTitle,
  type AdrSummary, type IssueDetailResult, type IssuesResult,
} from "../shared/protocol.js";

export interface ProtocolDeps {
  /** dir 下的文件名(不含子目录);目录不存在/读不了 = [] */
  listFiles(dir: string): string[];
  /** 文件全文;不存在/读不了 = null */
  readFile(path: string): string | null;
  /** gh 子进程;reject 的错误对象带 code/stderr(classifyGhError 的输入形状) */
  execGh(args: string[], cwd: string): Promise<{ stdout: string }>;
}

const nodeDeps: ProtocolDeps = {
  listFiles(dir) {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => d.name);
    } catch {
      return [];
    }
  },
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  execGh(args, cwd) {
    return new Promise((resolve, reject) => {
      execFile("gh", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr: String(stderr) }));
        else resolve({ stdout: String(stdout) });
      });
    });
  },
};

/** 两个 ADR 目录写死:project ADR 在前(阅读优先级),gearbox 协议 ADR 在后 */
const ADR_DIRS: { rel: string; source: AdrSummary["source"] }[] = [
  { rel: "docs/adr", source: "adr" },
  { rel: "docs/gearbox-adr", source: "gearbox-adr" },
];

export interface ProtocolService {
  listAdrs(repoDir: string): AdrSummary[];
  readAdr(repoDir: string, relPath: string): { markdown: string };
  listIssues(repoDir: string): Promise<IssuesResult>;
  getIssue(repoDir: string, n: number): Promise<IssueDetailResult>;
}

export function createProtocolService(deps: ProtocolDeps = nodeDeps): ProtocolService {
  return {
    listAdrs(repoDir) {
      const out: AdrSummary[] = [];
      for (const { rel, source } of ADR_DIRS) {
        for (const name of deps.listFiles(join(repoDir, rel)).sort()) {
          const id = adrIdFromFilename(name);
          if (!id) continue; // README 等非 ADR 命名不是 ADR
          const md = deps.readFile(join(repoDir, rel, name));
          if (md === null) continue;
          out.push({ source, id, title: extractAdrTitle(md, name.replace(/\.md$/, "")), path: `${rel}/${name}` });
        }
      }
      return out;
    },

    readAdr(repoDir, relPath) {
      // 渲染层传来的路径只是"凭证",必须钉死在两个 ADR 目录内——防任意文件读
      const norm = normalize(relPath);
      const inside = ADR_DIRS.some(({ rel }) => norm.startsWith(rel + "/")) && !norm.includes("..");
      if (!inside) throw new Error(`ADR 路径越界: ${relPath}`);
      const md = deps.readFile(join(repoDir, norm));
      if (md === null) throw new Error(`ADR 不存在: ${relPath}`);
      return { markdown: md };
    },

    async listIssues(repoDir) {
      try {
        const { stdout } = await deps.execGh(
          ["issue", "list", "--state", "all", "--limit", "200", "--json", "number,title,state,updatedAt"],
          repoDir
        );
        return { ok: true, issues: mapIssueList(JSON.parse(stdout)) };
      } catch (e) {
        return { ok: false, ...classifyGhError(e as { code?: string; stderr?: string; message?: string }) };
      }
    },

    async getIssue(repoDir, n) {
      try {
        const { stdout } = await deps.execGh(
          ["issue", "view", String(n), "--json", "number,title,state,body,comments"],
          repoDir
        );
        return { ok: true, issue: mapIssueDetail(JSON.parse(stdout)) };
      } catch (e) {
        return { ok: false, ...classifyGhError(e as { code?: string; stderr?: string; message?: string }) };
      }
    },
  };
}
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `npx vitest run tests/main/protocolService.test.ts`
Expected: PASS 全部。

- [ ] **Step 5: 全量门禁**

Run: `npm test`
Expected: 全绿（确认没碰坏别人）。

- [ ] **Step 6: Commit**

```bash
git add src/main/protocolService.ts tests/main/protocolService.test.ts
git commit -m "feat(protocol): 主进程 ProtocolService——fs 扫 ADR + gh CLI 读 issues

依赖注入照 skills.ts 模式;readAdr 路径钉死 ADR 目录防任意读;
gh 错误结构化回流(不 throw 过 IPC),面板得以独立降级。"
```

---

### Task 3: ShellBridge 扩桥（shared 类型 + preload + 主进程 handler）

**Files:**
- Modify: `src/shared/shellBridge.ts`（接口 + CHANNELS）
- Modify: `src/preload/index.ts`（四行转发）
- Modify: `src/main/index.ts`（四个 ipcMain.handle）

**Interfaces:**
- Consumes: Task 1 类型、Task 2 `createProtocolService`
- Produces（渲染层此后可用）:
  - `window.otter.protocolListAdrs(repoDir: string): Promise<AdrSummary[]>`
  - `window.otter.protocolReadAdr(repoDir: string, relPath: string): Promise<{ markdown: string }>`
  - `window.otter.protocolListIssues(repoDir: string): Promise<IssuesResult>`
  - `window.otter.protocolGetIssue(repoDir: string, number: number): Promise<IssueDetailResult>`

- [ ] **Step 1: shellBridge.ts 加类型**

顶部 import 区加：

```ts
import type { AdrSummary, IssueDetailResult, IssuesResult } from "./protocol.js";
```

`ShellBridge` 接口内（`listSkills` 之后）加：

```ts
  /** Protocol 仪表盘(只读):扫目标仓库 docs/adr + docs/gearbox-adr。目录缺失 = 空数组 */
  protocolListAdrs(repoDir: string): Promise<AdrSummary[]>;
  /** 读单篇 ADR 全文。路径必须落在 ADR 目录内,越界主进程拒绝 */
  protocolReadAdr(repoDir: string, relPath: string): Promise<{ markdown: string }>;
  /** gh CLI 读 issues(open+closed)。错误不 reject——结构化回流,渲染层按 kind 降级 */
  protocolListIssues(repoDir: string): Promise<IssuesResult>;
  /** 单 issue 详情(正文 + 评论,handoff 解析在渲染层做) */
  protocolGetIssue(repoDir: string, number: number): Promise<IssueDetailResult>;
```

`CHANNELS` 加：

```ts
  protocolListAdrs: "otter:protocolListAdrs",
  protocolReadAdr: "otter:protocolReadAdr",
  protocolListIssues: "otter:protocolListIssues",
  protocolGetIssue: "otter:protocolGetIssue",
```

- [ ] **Step 2: preload/index.ts 加四行**

bridge 对象内（`listSkills` 之后）：

```ts
  protocolListAdrs: (repoDir) => ipcRenderer.invoke(CHANNELS.protocolListAdrs, repoDir),
  protocolReadAdr: (repoDir, relPath) => ipcRenderer.invoke(CHANNELS.protocolReadAdr, repoDir, relPath),
  protocolListIssues: (repoDir) => ipcRenderer.invoke(CHANNELS.protocolListIssues, repoDir),
  protocolGetIssue: (repoDir, number) => ipcRenderer.invoke(CHANNELS.protocolGetIssue, repoDir, number),
```

- [ ] **Step 3: main/index.ts 注册 handler**

import 区加：

```ts
import { createProtocolService } from "./protocolService.js";
```

`ipcMain.handle(CHANNELS.listSkills, ...)` 附近加：

```ts
  // Protocol 仪表盘(只读):service 无状态,建一次全局复用
  const protocol = createProtocolService();
  ipcMain.handle(CHANNELS.protocolListAdrs, (_e, repoDir: string) => protocol.listAdrs(repoDir));
  ipcMain.handle(CHANNELS.protocolReadAdr, (_e, repoDir: string, relPath: string) =>
    protocol.readAdr(repoDir, relPath)
  );
  ipcMain.handle(CHANNELS.protocolListIssues, (_e, repoDir: string) => protocol.listIssues(repoDir));
  ipcMain.handle(CHANNELS.protocolGetIssue, (_e, repoDir: string, n: number) => protocol.getIssue(repoDir, n));
```

注意：`const protocol = ...` 放在与其他 handle 注册同一作用域（跟 `manager`/`store` 平级），别放进某个 handler 里。

- [ ] **Step 4: 类型检查 + 门禁**

Run: `npx tsc --noEmit 2>/dev/null || npx tsx --version && npm test`
（仓库若无独立 tsc 脚本，以 `npm test` + `npm run build` 为准：）

Run: `npm test && npm run build`
Expected: 测试全绿，build 无类型错误。

- [ ] **Step 5: Commit**

```bash
git add src/shared/shellBridge.ts src/preload/index.ts src/main/index.ts
git commit -m "feat(protocol): ShellBridge 扩四个只读方法——渲染层唯一通道不破

protocolListAdrs/ReadAdr/ListIssues/GetIssue;错误结构化回流,
只有 readAdr 越界才 reject(那是调用方 bug 不是环境降级)。"
```

---

### Task 4: 渲染层 store——protocol 状态与动作

**Files:**
- Modify: `src/renderer/src/store.ts`

**Interfaces:**
- Consumes: Task 3 的 `window.otter.protocol*`、Task 1 类型
- Produces（ProtocolView 靠这些）:
  - 状态：`protocolOpen: boolean`、`protocolRepo: string | null`、`adrs: AdrSummary[]`、`adrView: { path: string; markdown: string } | null`、`issues: IssuesResult | null`（null = 加载中）、`issueView: IssueDetailResult | null`
  - 动作：`openProtocol(): Promise<void>`、`closeProtocol(): void`、`pickProtocolRepo(): Promise<void>`、`refreshProtocol(): Promise<void>`、`openAdr(path: string): Promise<void>`、`openIssue(number: number): Promise<void>`

- [ ] **Step 1: 加 import 与状态**

import 区加：

```ts
import type { AdrSummary, IssueDetailResult, IssuesResult } from "../../shared/protocol.js";
```

（路径以 store.ts 现有对 shared 的 import 写法为准——先看文件里 `shellBridge` 是怎么 import 的，照抄相对深度。）

State 接口与初始值加（挨着 `settingsSection` 一族）：

```ts
  /** Protocol 仪表盘开关(覆盖在任意 phase 之上,与设置模式互斥) */
  protocolOpen: boolean;
  /** 仪表盘目标仓库(绝对路径):localStorage 记忆 ?? 当前会话 workspace */
  protocolRepo: string | null;
  adrs: AdrSummary[];
  adrView: { path: string; markdown: string } | null;
  /** null = 正在加载(骨架屏);ok:false = 按 kind 降级 */
  issues: IssuesResult | null;
  issueView: IssueDetailResult | null;
```

初始值：`protocolOpen: false, protocolRepo: null, adrs: [], adrView: null, issues: null, issueView: null,`

- [ ] **Step 2: 加动作**

```ts
  async openProtocol() {
    // 目标仓库:上次手选的记忆优先,否则跟当前会话的工程文件夹
    const repo = localStorage.getItem("otter-protocol-repo") ?? get().workspace ?? null;
    set({ protocolOpen: true, settingsSection: null, protocolRepo: repo, adrView: null, issueView: null });
    if (repo) await get().refreshProtocol();
  },
  closeProtocol: () => set({ protocolOpen: false }),
  async pickProtocolRepo() {
    const dir = await window.otter.pickWorkspace();
    if (!dir) return; // 用户取消 = 保持现状
    localStorage.setItem("otter-protocol-repo", dir);
    set({ protocolRepo: dir, adrView: null, issueView: null });
    await get().refreshProtocol();
  },
  async refreshProtocol() {
    const repo = get().protocolRepo;
    if (!repo) return;
    set({ issues: null, adrs: [] }); // 回加载态,刷新肉眼可见
    const [adrs, issues] = await Promise.all([
      window.otter.protocolListAdrs(repo),
      window.otter.protocolListIssues(repo),
    ]);
    set({ adrs, issues });
  },
  async openAdr(path: string) {
    const repo = get().protocolRepo;
    if (!repo) return;
    const { markdown } = await window.otter.protocolReadAdr(repo, path);
    set({ adrView: { path, markdown }, issueView: null });
  },
  async openIssue(number: number) {
    const repo = get().protocolRepo;
    if (!repo) return;
    set({ issueView: null });
    set({ issueView: await window.otter.protocolGetIssue(repo, number), adrView: null });
  },
```

- [ ] **Step 3: 互斥收口**

三处现有代码补 `protocolOpen: false`：

1. `openSettings` 的 set()（约 store.ts:191–195 三个分支）——进设置就退出仪表盘
2. 侧栏点会话那条动作（store.ts:122 附近注释「侧栏点会话 = 想看聊天」的那个 set）——看聊天就退出仪表盘
3. 新会话 composer 那条（store.ts:331 附近「＋新会话退出设置模式」）——同理

- [ ] **Step 4: 门禁**

Run: `npm test && npm run build`
Expected: 全绿 + build 通过（store 无独立单测，类型即测试；解析逻辑已在 Task 1/2 全测）。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/store.ts
git commit -m "feat(protocol): store 加仪表盘状态——目标仓库记忆 + 三视图互斥

repo 解析:localStorage 手选记忆 ?? 当前会话 workspace;
protocol/设置/聊天三态互斥,进谁谁收口另外两个。"
```

---

### Task 5: ProtocolView 组件 + 侧栏入口 + App 接线

**Files:**
- Create: `src/renderer/src/components/ProtocolView.tsx`
- Modify: `src/renderer/src/App.tsx`（main 区分支 + SidebarFooter 入口按钮）

**Interfaces:**
- Consumes: Task 4 的全部 store 状态/动作、Task 1 的 `parseHandoff`、react-markdown + remark-gfm（App.tsx 已有同款用法可参照）
- Produces: `<ProtocolView />`（无 props，全部从 store 取）

- [ ] **Step 1: 写 ProtocolView.tsx**

```tsx
// Protocol 仪表盘(只读) — gearbox 协议可视化第一刀:ADR / issues / handoff。
// 全部数据从 store 取(store 背后是 ShellBridge);本组件零 IPC、零业务逻辑,纯投影。
// 降级哲学(spec §3):每块独立坏、独立给指引,任何一块坏不拖垮整页。

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { RefreshCw, FolderOpen, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { useChat } from "../store.js";
import { parseHandoff, type IssueRole, type IssuesResult } from "../../../shared/protocol.js";

/** 角色标签:gearbox 三角色的视觉词汇。染色只用语义令牌,不写裸色 */
const ROLE_BADGE: Record<IssueRole, { label: string; cls: string }> = {
  task: { label: "Task", cls: "bg-muted text-muted-foreground" },
  memory: { label: "Handoff", cls: "bg-brand/15 text-brand" },
  gap: { label: "Protocol gap", cls: "bg-destructive/15 text-destructive" },
};

function RoleBadge({ role }: { role: IssueRole }) {
  const b = ROLE_BADGE[role];
  return <span className={`shrink-0 rounded px-[6px] py-px text-[11px] ${b.cls}`}>{b.label}</span>;
}

/** issues 面板的降级指引:按错误 kind 给能行动的下一步,不甩原始报错 */
function IssuesError({ result }: { result: Extract<IssuesResult, { ok: false }> }) {
  const guide: Record<string, string> = {
    "gh-missing": "未找到 gh CLI。安装:brew install gh,然后 gh auth login。",
    "no-repo": "此目录不是 git 仓库或未连 GitHub remote。ADR 面板不受影响。",
    "gh-auth": "gh 未登录。终端跑一次:gh auth login。",
    "gh-error": "GitHub 请求失败(网络/限流?)。可点刷新重试。",
  };
  return (
    <div className="px-3 py-6 text-sm text-muted-foreground">
      <p>{guide[result.kind]}</p>
      <p className="mt-2 font-mono text-xs opacity-70 break-all">{result.detail}</p>
    </div>
  );
}

/** handoff 评论:五段式解析成卡片;解析不出整条回退原文渲染(宁可不解析,不猜) */
function CommentBody({ body }: { body: string }) {
  const parts = parseHandoff(body);
  if (!parts) return <Markdown remarkPlugins={[remarkGfm]}>{body}</Markdown>;
  const rows: { label: string; text: string }[] = [
    { label: "① 做完了什么", text: parts.done },
    { label: "② 什么被阻塞", text: parts.blocked },
    { label: "③ 下一步", text: parts.next },
    { label: "④ 关单情况", text: parts.closed },
    { label: "⑤ 决策与理由", text: parts.rationale },
  ];
  return (
    <div className="grid gap-2">
      {rows.map((r) => (
        <div key={r.label} className="rounded border border-border bg-muted/40 px-3 py-2">
          <div className="text-[11px] font-semibold text-brand">{r.label}</div>
          <div className="text-sm whitespace-pre-wrap">{r.text}</div>
        </div>
      ))}
    </div>
  );
}

export function ProtocolView() {
  const {
    protocolRepo, adrs, adrView, issues, issueView,
    closeProtocol, pickProtocolRepo, refreshProtocol, openAdr, openIssue,
  } = useChat();
  const tab = useChat((s) => s.protocolTab);
  const setTab = useChat((s) => s.setProtocolTab);

  if (!protocolRepo) {
    return (
      <main className="flex-1 min-w-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
        <p>还没有目标仓库——选一个含 docs/adr 或连着 GitHub 的文件夹。</p>
        <Button onClick={() => void pickProtocolRepo()}>
          <FolderOpen /> 选择仓库
        </Button>
      </main>
    );
  }

  return (
    <main className="flex-1 min-w-0 flex flex-col">
      {/* 头部:仓库路径 + 换目录/刷新/关闭 */}
      <header className="flex items-center gap-2 border-b border-border px-4 py-2">
        <span className="font-mono text-xs text-muted-foreground truncate">{protocolRepo}</span>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => void pickProtocolRepo()} title="换目标仓库">
          <FolderOpen />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void refreshProtocol()} title="重新拉取 ADR 与 issues">
          <RefreshCw />
        </Button>
        <Button variant="ghost" size="sm" onClick={closeProtocol} title="关闭仪表盘">
          <X />
        </Button>
      </header>

      <div className="flex-1 min-h-0 flex">
        {/* 左列:ADR / Issues 列表(无 shadcn Tabs,两颗 Button 拼分段开关) */}
        <div className="w-[300px] shrink-0 border-r border-border flex flex-col">
          <div className="flex gap-1 p-2">
            <Button variant={tab === "adr" ? "secondary" : "ghost"} size="sm" className="flex-1" onClick={() => setTab("adr")}>
              ADR
            </Button>
            <Button variant={tab === "issues" ? "secondary" : "ghost"} size="sm" className="flex-1" onClick={() => setTab("issues")}>
              Issues
            </Button>
          </div>
          <Separator />
          <div className="flex-1 min-h-0 overflow-y-auto">
            {tab === "adr" ? (
              adrs.length === 0 ? (
                <p className="px-3 py-6 text-sm text-muted-foreground">此仓库没有 docs/adr 或 docs/gearbox-adr。</p>
              ) : (
                adrs.map((a) => (
                  <button
                    key={a.path}
                    className={`block w-full px-3 py-2 text-left text-sm hover:bg-accent ${adrView?.path === a.path ? "bg-accent" : ""}`}
                    onClick={() => void openAdr(a.path)}
                  >
                    <span className="font-mono text-xs text-muted-foreground">
                      {a.source === "gearbox-adr" ? "GX-" : ""}{a.id}
                    </span>
                    <span className="block truncate">{a.title}</span>
                  </button>
                ))
              )
            ) : issues === null ? (
              <div className="grid gap-2 p-3">
                <Skeleton className="h-8" /><Skeleton className="h-8" /><Skeleton className="h-8" />
              </div>
            ) : !issues.ok ? (
              <IssuesError result={issues} />
            ) : (
              issues.issues.map((i) => (
                <button
                  key={i.number}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent ${i.state === "closed" ? "opacity-55" : ""}`}
                  onClick={() => void openIssue(i.number)}
                >
                  <span className="font-mono text-xs text-muted-foreground shrink-0">#{i.number}</span>
                  <span className="flex-1 min-w-0 truncate">{i.title}</span>
                  <RoleBadge role={i.role} />
                </button>
              ))
            )}
          </div>
        </div>

        {/* 右区:选中的 ADR 全文或 issue 详情 */}
        <div className="flex-1 min-w-0 overflow-y-auto px-6 py-4">
          {adrView ? (
            <article className="prose-otter max-w-[760px]">
              <Markdown remarkPlugins={[remarkGfm]}>{adrView.markdown}</Markdown>
            </article>
          ) : issueView === null && tab === "issues" && issues?.ok ? (
            <p className="text-sm text-muted-foreground">左边点一个 issue 看详情。</p>
          ) : issueView ? (
            !issueView.ok ? (
              <IssuesError result={issueView} />
            ) : (
              <article className="max-w-[760px]">
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold">
                    <span className="font-mono text-muted-foreground">#{issueView.issue.number}</span> {issueView.issue.title}
                  </h2>
                  <RoleBadge role={issueView.issue.role} />
                  <span className="text-xs text-muted-foreground">{issueView.issue.state}</span>
                </div>
                <div className="mt-3">
                  <Markdown remarkPlugins={[remarkGfm]}>{issueView.issue.body || "_(无正文)_"}</Markdown>
                </div>
                {issueView.issue.comments.map((c, idx) => (
                  <div key={idx} className="mt-4 rounded border border-border bg-card px-4 py-3">
                    <div className="mb-2 text-xs text-muted-foreground">
                      <span className="font-semibold text-foreground">{c.author}</span>
                      {" · "}{c.createdAt ? new Date(c.createdAt).toLocaleString() : ""}
                    </div>
                    <CommentBody body={c.body} />
                  </div>
                ))}
              </article>
            )
          ) : (
            <p className="text-sm text-muted-foreground">左边选一篇 ADR 或一个 issue。</p>
          )}
        </div>
      </div>
    </main>
  );
}
```

实施注意：
- `protocolTab` / `setProtocolTab` 是本 Task 顺手加进 store 的一对小状态：`protocolTab: "adr" | "issues"`（初始 `"adr"`）+ `setProtocolTab: (t) => set({ protocolTab: t })`——纯 UI 态，放 Task 4 的状态块旁边
- markdown 样式类（示例里的 `prose-otter`）以 App.tsx 现有 Markdown 用法为准：先看 App.tsx 里 `<Markdown>` 外层套了什么类，照抄，没有就不套
- shared import 相对深度（`../../../shared/protocol.js`)以该文件实际位置编译通过为准

- [ ] **Step 2: App.tsx 接线**

1. import：`import { ProtocolView } from "./components/ProtocolView.js";` + lucide 的 `BookMarked`
2. AppShell（约 1361 行起）取 `const protocolOpen = useChat((s) => s.protocolOpen);`
3. main 区分支（约 1447 行）最前面加一档：

```tsx
  const main = protocolOpen ? (
    <ProtocolView />
  ) : settingsSection === "account" ? (
```

4. AppSidebar 的 SidebarFooter（约 1068 行「用户卡片 + 齿轮」那行）齿轮旁边加一颗同风格按钮：

```tsx
          <button
            className="p-1 text-muted-foreground hover:text-foreground"
            onClick={() => void openProtocol()}
            title="Protocol 仪表盘:ADR / issues / handoff"
          >
            <BookMarked className="w-4 h-4" />
          </button>
```

（`openProtocol` 从 `useChat` 取；按钮的具体类名照抄旁边齿轮按钮,保持同风格。）

5. 会话高亮判定（约 1002 行 `isActive={phase === "chat" && settingsSection === null && ...}`）补 `&& !protocolOpen`。

- [ ] **Step 3: 门禁 + build**

Run: `npm test && npm run build`
Expected: 全绿。

- [ ] **Step 4: 手工验证（dev 实跑）**

先杀旧实例（用户约定：防多开吃内存）：

```bash
pkill -f "electron.*mr-otto" 2>/dev/null; pkill -f "electron-vite" 2>/dev/null; npm run dev
```

核对清单（拿 Otter 仓库自己当目标——完工即自用）：
1. 侧栏底部新按钮进 Protocol 视图
2. ADR 面板列出 0001–0012（project）+ GX 系列（gearbox），点开渲染 markdown
3. Issues 面板列出本仓 open/closed，角色标签正确（#9 应是 Protocol gap）
4. 点开一个带五段式评论的 issue，handoff 卡片解析出五段
5. 换目录到一个非 git 文件夹：issues 面板给 no-repo 指引，ADR 面板独立存活
6. 刷新钮、关闭钮、设置/聊天/Protocol 三态互斥正常
7. light/dark 两主题下检查一遍配色

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/ProtocolView.tsx src/renderer/src/App.tsx src/renderer/src/store.ts
git commit -m "feat(protocol): ProtocolView 三面板落地——ADR/issues/handoff 只读可视化

独立组件不进 App.tsx(1683 行已够大);handoff 五段卡片,
错误按 kind 给可行动指引;侧栏底部入口,三视图互斥。"
```

---

### Task 6: ADR-0012 + spec 修订 + PR

**Files:**
- Create: `docs/adr/0012-protocol-dashboard.md`
- Modify: `docs/superpowers/specs/2026-08-18-protocol-dashboard-design.md`（smoke 一行）

- [ ] **Step 1: 写 ADR-0012**

```markdown
# ADR-0012: Protocol 只读仪表盘——gearbox 协议可视化进 Otto

日期:2026-08-18
状态:已接受

## 背景

把 gearbox 协议功能融入 Mr Otto,让使用者脱离 gearbox 工具链也能获得协议价值
(换班记忆/决策记录/任务追踪)。完整讨论见 spec:
docs/superpowers/specs/2026-08-18-protocol-dashboard-design.md。

## 决策

1. **协议产物不建 Otto 私有储存**:ADR 读仓库 markdown(docs/adr + docs/gearbox-adr),
   任务/交接直接读 GitHub issues——Otto 是协议的 GUI 客户端,不是协议的替代储存。
   保住 gearbox 的灵魂:repo 是唯一共享记忆,Claude Code 等其他 agent 共享同一条 issue 流。
2. **issues 走 gh CLI**(execFile 子进程,复用用户已有认证,私有仓库可用),
   不引 octokit/token 管理——少背一棵依赖树 + 不碰凭证存储。
3. **第一刀严格只读**:零写文件、零 GitHub 写请求。第二刀(收班自动化:从事件日志
   生成 handoff 草稿)另立 spec。
4. **「harness 完工前无新 UI 面」约束豁免**:只读面板不触 harness 核心,
   且 Otter 仓库自身即 gearbox 仓库——完工即自用,狗粮闭环。豁免仅此一项,约束仍在。

## 后果

- 主进程新增 protocolService(fs + gh 子进程;app 功能不经 ExecutionWorld,同 SQLite 先例)
- ShellBridge 扩四个只读方法;错误结构化回流(不 throw),面板独立降级
- 依赖 gh CLI 存在与登录;纯离线只有 ADR 面板可用——接受,降级路径已铺
- handoff 五段式解析是启发式(①—⑤ 齐全按序),解析不出回退原文——宁可不解析,不猜
```

- [ ] **Step 2: spec 修订 smoke 一行**

spec §4 中「UI 轻量 smoke:Protocol 视图挂载不炸」改为：

```
- UI 无组件级测试(仓库无 jsdom/testing-library,为一个 smoke 背两棵依赖不值——YAGNI):
  逻辑全下沉纯函数层已测,视图以 dev 实跑核对清单验收(见 plan Task 5)
```

- [ ] **Step 3: 门禁 + 提交 + PR**

```bash
npm test
git add docs/adr/0012-protocol-dashboard.md docs/superpowers/specs/2026-08-18-protocol-dashboard-design.md
git commit -m "docs(adr): ADR-0012 protocol-dashboard——四决策入档 + spec smoke 一行修订"
git push -u origin claude/gearbox-mr-otto-integration-c759dc
gh pr create --title "Protocol 只读仪表盘:gearbox 协议可视化第一刀" --body "$(cat <<'EOF'
Closes #<Task 0 的编号>

ADR/issues/handoff 只读三面板。spec + plan + ADR-0012 见 docs/。
纯函数解析层全测;gh 错误结构化回流,面板独立降级;零写操作。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

CI 绿后按 PR disposition 规则 merge commit 合并（作者 agent 自合，非协议变更 = 无需 L1）。

---

## Self-Review 记录

- **Spec 覆盖**:三面板(Task 5)、四桥方法(Task 3)、gh CLI + 注入测试(Task 2)、五段式/角色/映射(Task 1)、降级表四情形(Task 1 错误分类 + Task 5 IssuesError)、路径校验(Task 2 readAdr)、ADR-0012(Task 6)、Task issue(Task 0)——全覆盖。spec 的「UI smoke」不可行,Task 6 修订(理由:无 jsdom 依赖,YAGNI)。
- **Placeholder 扫描**:无 TBD/TODO;两处「以现有代码为准」是对既有文件事实的引用(import 深度、Markdown 外层类),非未定设计。
- **类型一致性**:`AdrSummary/IssuesResult/IssueDetailResult/ProtocolDeps` 各任务签名核对一致;`protocolTab` 在 Task 5 引入并注明补进 store。
