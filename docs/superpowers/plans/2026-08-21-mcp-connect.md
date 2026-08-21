# MCP 连接 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Otto 能连 MCP 服务器，把外部 server 的 tools / resources / prompts 接进 agent 与 UI。

**Architecture:** MCP 是 `ExecutionWorld` 上的一个可选能力（第四次复述 ADR-0008 / 0031 / 0035）。工具层只认 `McpCapability` 接口；`@modelcontextprotocol/sdk` 只允许 `src/main/mcpClient.ts` 一个文件 import；`src/main/mcpHub.ts` 管状态机、不碰 SDK（`connect` 以接口注入，测试喂假实现）。不新增 SessionEvent。

**Tech Stack:** TypeScript strict / Node / Electron 主进程 / vitest / React + Zustand + Tailwind + shadcn（渲染层）/ `@modelcontextprotocol/sdk`

**Spec:** `docs/superpowers/specs/2026-08-21-mcp-design.md`

## Global Constraints

- **工作区**：本计划在 worktree `../Mr_Otto-mcp`、分支 `claude/mcp-connect` 上执行。主仓工作区被另一条 lane 占着，不要在那里改文件。
- **门禁**：`npm test`。每个 Task 的最后一步 commit 之前必须全绿。
- **硬规则**：工具实现只依赖 `ExecutionWorld` 接口，禁止直接 import `fs` / `child_process`。`src/tools/` 下的新文件一行都不许出现这两个模块。
- **硬规则**：append-only 事件日志是唯一事实来源。本计划**不新增任何 SessionEvent**，`src/session/events.ts` 一字不改。
- **硬规则**：渲染进程只通过 `ShellBridge` 与后端通信，禁止直接触碰 Node API。
- **SDK 隔离**：`@modelcontextprotocol/sdk` 只允许出现在 `src/main/mcpClient.ts`。别处一律 import 本仓自己的接口类型。
- **凭据不过桥**：`env` / `headers` 的值是凭据，过桥前必须用 `maskKey`（`src/shared/keyMask.ts`）遮罩。真值只在主进程。凭据不进事件日志。
- **测试位置**：统一放 `tests/`，镜像 `src/` 结构（ADR-0016）。不与源码同目录。
- **工具名前缀**：`mcp__<server>__<tool>`，与 Claude Code 一致。
- **import 后缀**：本仓所有相对 import 带 `.js` 后缀（NodeNext）。新文件照做。
- **注释语言**：本仓注释是中文，讲"为什么"而不是"是什么"。新文件照做。
- **Phase 2 阻塞**：Task 8–10 改 `src/renderer/src/store.ts` 与 `App.tsx`，另一条 lane（Subagent，issue #129）正在改同样两行。**Task 8 开始前必须先确认 Subagent 的 PR 已合进 `main` 并把本分支 rebase/merge 上去**。Task 1–7 与那条 lane 文件零重叠，可立即执行。

---

## File Structure

**新建：**

| 文件 | 职责 |
|---|---|
| `src/shared/mcp.ts` | 三边共用的类型 + 纯函数（工具名拼装、content 压字符串、遮罩）。零运行时依赖 |
| `src/main/mcpConfig.ts` | `~/.otter/mcp.json` 的解析与写回。纯函数 + fs 接口注入 |
| `src/main/mcpClient.ts` | **唯一** import SDK 的文件。把一台 server 连起来，返回 `McpClientConn` |
| `src/main/mcpHub.ts` | 状态机：谁在连、谁连上了、谁挂了。`connect` 以接口注入 |
| `src/tools/mcpTool.ts` | 把 server 的 tool 包成 `Tool` |
| `src/tools/mcpReadResource.ts` | 内置工具 `mcp_read_resource` |
| `src/renderer/src/components/McpSettings.tsx` | 设置页 MCP 栏目 |
| `src/renderer/src/components/elements/mcp-server-panel.tsx` | 上游 element（`shadcn add` 贴入后手改 import） |
| `src/renderer/src/components/elements/prompt-library.tsx` | 上游 element（同上） |

**修改：**

| 文件 | 改什么 |
|---|---|
| `src/world/executionWorld.ts` | 加 `McpCapability` / `mcp?:` 字段 / `withMcp`；`withAbortSignal` 与 `withExecOutput` 补透传 |
| `src/main/agent.ts` | 拼工具表前 `await world.mcp.ready()`；展开 `createMcpTools` |
| `src/main/index.ts` | 造 hub，`withMcp` 焊进 world；注册 IPC |
| `src/preload/index.ts` | 暴露新桥方法 |
| `src/shared/shellBridge.ts` | 新增方法签名 + 频道名 |
| `src/main/approvalPreview.ts` | MCP 工具的审批预览分支 |
| `src/renderer/src/store.ts` | `SettingsSection` 加 `"mcp"`；MCP 状态与 action |
| `src/renderer/src/App.tsx` | 设置页栏目导航加一档 + 路由 |
| `AGENTS.md` | 范围声明 + Tech stack（**L1，最后一个 Task，需维护者同意**） |

---

# Phase 1 —— 后端（Task 1–7，可立即执行）

## Task 1: 共享类型与纯函数

**Files:**
- Create: `src/shared/mcp.ts`
- Test: `tests/shared/mcp.test.ts`

**Interfaces:**
- Consumes: `maskKey` from `src/shared/keyMask.ts`
- Produces: `McpTransportKind`, `McpStatus`, `McpStdioConfig`, `McpHttpConfig`, `McpServerConfig`, `McpContent`, `McpToolInfo`, `McpResourceInfo`, `McpPromptInfo`, `McpServerStatus`, `mcpToolName()`, `renderMcpContent()`, `maskMcpConfig()`

- [ ] **Step 1: 写失败的测试**

新建 `tests/shared/mcp.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import {
  mcpToolName,
  renderMcpContent,
  maskMcpConfig,
  type McpServerConfig,
} from "../../src/shared/mcp.js";

describe("mcpToolName", () => {
  it("拼成 mcp__<server>__<tool>", () => {
    expect(mcpToolName("github", "create_pr")).toBe("mcp__github__create_pr");
  });

  it("非法字符换成下划线 —— 模型的工具名只认 [A-Za-z0-9_-]", () => {
    expect(mcpToolName("my server!", "do.thing")).toBe("mcp__my_server___do_thing");
  });

  it("超长时截断，且截断后仍然唯一（尾部挂 4 位哈希）", () => {
    const long = "x".repeat(80);
    const a = mcpToolName("s", long + "a");
    const b = mcpToolName("s", long + "b");
    expect(a.length).toBeLessThanOrEqual(64);
    expect(b.length).toBeLessThanOrEqual(64);
    expect(a).not.toBe(b);
  });
});

describe("renderMcpContent", () => {
  it("多段 text 用空行接起来", () => {
    expect(renderMcpContent([
      { kind: "text", text: "第一段" },
      { kind: "text", text: "第二段" },
    ])).toBe("第一段\n\n第二段");
  });

  it("image 折成一行说明 —— 本版不进视觉桥，但要让模型知道有这么个东西", () => {
    const out = renderMcpContent([{ kind: "image", data: "AAAA", mimeType: "image/png" }]);
    expect(out).toContain("image/png");
    expect(out).not.toContain("AAAA");
  });

  it("resource 有正文就给正文，并标出 uri", () => {
    const out = renderMcpContent([
      { kind: "resource", uri: "file:///a.txt", text: "内容", mimeType: "text/plain" },
    ]);
    expect(out).toContain("file:///a.txt");
    expect(out).toContain("内容");
  });

  it("空数组 = 一句人话，不是空串（空串会让模型以为工具坏了）", () => {
    expect(renderMcpContent([])).toBe("(工具没有返回任何内容)");
  });
});

describe("maskMcpConfig", () => {
  it("stdio 的 env 值遮罩，键名原样留着", () => {
    const cfg: McpServerConfig = {
      kind: "stdio",
      command: "npx",
      args: ["-y", "server"],
      env: { GITHUB_TOKEN: "ghp_abcdefghijklmnop" },
      enabled: true,
    };
    const masked = maskMcpConfig(cfg);
    expect(masked.kind).toBe("stdio");
    if (masked.kind !== "stdio") throw new Error("窄化失败");
    expect(Object.keys(masked.env)).toEqual(["GITHUB_TOKEN"]);
    expect(masked.env["GITHUB_TOKEN"]).not.toContain("abcdefgh".slice(4));
    expect(masked.env["GITHUB_TOKEN"]).toContain("*****");
    expect(masked.command).toBe("npx");
  });

  it("http 的 headers 值遮罩", () => {
    const cfg: McpServerConfig = {
      kind: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer sk-1234567890abcdef" },
      enabled: true,
    };
    const masked = maskMcpConfig(cfg);
    if (masked.kind !== "http") throw new Error("窄化失败");
    expect(masked.headers["Authorization"]).toContain("*****");
    expect(masked.url).toBe("https://mcp.linear.app/mcp");
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
cd ../Mr_Otto-mcp && npx vitest run tests/shared/mcp.test.ts
```

Expected: FAIL —— `Failed to resolve import "../../src/shared/mcp.js"`

- [ ] **Step 3: 写最小实现**

新建 `src/shared/mcp.ts`：

```ts
// MCP 的共享世界 —— 类型 + 纯函数，零运行时依赖，主进程/渲染层/工具层共 import。
// 与 shellBridge.ts 同一个定位：桥两头都要认的形状放这儿。

import { maskKey } from "./keyMask.js";

export type McpTransportKind = "stdio" | "http";

/** 一台 server 的四种活法。UI 的状态灯直接读它 */
export type McpStatus = "connecting" | "connected" | "needs-auth" | "failed";

export interface McpStdioConfig {
  kind: "stdio";
  command: string;
  args: string[];
  /** 值是凭据 —— 过桥前必过 maskMcpConfig */
  env: Record<string, string>;
  enabled: boolean;
}

export interface McpHttpConfig {
  kind: "http";
  url: string;
  /** 值是凭据 —— 同上 */
  headers: Record<string, string>;
  enabled: boolean;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

/** MCP 返回的内容块。工具层把它压成喂模型的字符串（renderMcpContent） */
export type McpContent =
  | { kind: "text"; text: string }
  | { kind: "image"; data: string; mimeType: string }
  | { kind: "resource"; uri: string; text?: string; mimeType?: string };

export interface McpToolInfo {
  /** server 自报的原始名（未加前缀） */
  name: string;
  description: string;
  /** JSON Schema，原样透给模型 */
  inputSchema: unknown;
}

export interface McpResourceInfo {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptInfo {
  name: string;
  description?: string;
  arguments: readonly { name: string; description?: string; required?: boolean }[];
}

/** 过桥给渲染层的一台 server —— 配置已遮罩，能力清单是快照 */
export interface McpServerStatus {
  id: string;
  status: McpStatus;
  /** 连不上时的人话原因；连上了 = undefined */
  error?: string;
  config: McpServerConfig;
  tools: McpToolInfo[];
  resources: McpResourceInfo[];
  prompts: McpPromptInfo[];
}

const NAME_MAX = 64;

/** 4 位十六进制指纹。截断后还要唯一 —— 两个前 60 个字符相同的长工具名
    不能塌成同一个名字，那会让模型调 A 实际执行 B */
function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").slice(0, 4);
}

/** 工具名：mcp__<server>__<tool>，与 Claude Code 一致。
    加前缀是为了避开与内置工具撞名 —— 某台 server 完全可能提供一个叫 bash 的工具。
    模型侧的工具名只认 [A-Za-z0-9_-] 且有长度上限，越界的部分在这里收口。 */
export function mcpToolName(server: string, tool: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  const full = `mcp__${safe(server)}__${safe(tool)}`;
  if (full.length <= NAME_MAX) return full;
  return `${full.slice(0, NAME_MAX - 5)}_${fingerprint(full)}`;
}

/** content 数组压成喂给模型的字符串。
    image 本版不进视觉桥（ADR-0009 的附件库是另一条路），折成一行说明 ——
    但必须说出来：模型该知道"有一张图我没给你看"，而不是以为工具返回了空。 */
export function renderMcpContent(content: readonly McpContent[]): string {
  if (content.length === 0) return "(工具没有返回任何内容)";
  return content
    .map((c) => {
      if (c.kind === "text") return c.text;
      if (c.kind === "image") return `(server 返回了一张 ${c.mimeType} 图片，本版不展开)`;
      const head = `[${c.uri}${c.mimeType ? ` · ${c.mimeType}` : ""}]`;
      return c.text ? `${head}\n${c.text}` : `${head}(无正文)`;
    })
    .join("\n\n");
}

/** 遮罩凭据。键名保留 —— 用户要认出"这一格配的是哪一把"（同 ADR-0044 的判断） */
export function maskMcpConfig(cfg: McpServerConfig): McpServerConfig {
  const maskAll = (r: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, maskKey(v)]));
  return cfg.kind === "stdio"
    ? { ...cfg, env: maskAll(cfg.env) }
    : { ...cfg, headers: maskAll(cfg.headers) };
}
```

- [ ] **Step 4: 跑测试确认它通过**

```bash
cd ../Mr_Otto-mcp && npx vitest run tests/shared/mcp.test.ts
```

Expected: PASS（10 个 it 全绿）

- [ ] **Step 5: 跑全量门禁**

```bash
cd ../Mr_Otto-mcp && npm test
```

Expected: 全绿，之前的 1383 个测试一个不掉

- [ ] **Step 6: 提交**

```bash
cd ../Mr_Otto-mcp
git add src/shared/mcp.ts tests/shared/mcp.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): 共享类型 + 三个纯函数（工具名/内容压平/凭据遮罩）

工具名加 mcp__<server>__<tool> 前缀是为了避开撞名 —— 某台 server
完全可能提供一个叫 bash 的工具。超长截断挂 4 位指纹：两个前缀相同的
长工具名塌成一个名字，会让模型调 A 实际执行 B。

renderMcpContent 对 image 折行但明说 —— 模型该知道"有张图我没给你看"，
而不是以为工具返回了空。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 配置文件读写

**Files:**
- Create: `src/main/mcpConfig.ts`
- Test: `tests/main/mcpConfig.test.ts`

**Interfaces:**
- Consumes: `McpServerConfig` from Task 1
- Produces: `McpConfigReader`（fs 接口）、`parseMcpConfig(text): { servers, errors }`、`serializeMcpConfig(prevText, servers): string`、`loadMcpConfig(path, reader?)`、`saveMcpConfig(path, servers, reader?)`

- [ ] **Step 1: 写失败的测试**

新建 `tests/main/mcpConfig.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { parseMcpConfig, serializeMcpConfig } from "../../src/main/mcpConfig.js";

describe("parseMcpConfig", () => {
  it("有 command = stdio", () => {
    const { servers, errors } = parseMcpConfig(JSON.stringify({
      mcpServers: { github: { command: "npx", args: ["-y", "s"], env: { T: "1" } } },
    }));
    expect(errors).toEqual([]);
    expect(servers["github"]).toEqual({
      kind: "stdio", command: "npx", args: ["-y", "s"], env: { T: "1" }, enabled: true,
    });
  });

  it("有 url = http", () => {
    const { servers } = parseMcpConfig(JSON.stringify({
      mcpServers: { linear: { url: "https://x/mcp", headers: { A: "b" } } },
    }));
    expect(servers["linear"]).toEqual({
      kind: "http", url: "https://x/mcp", headers: { A: "b" }, enabled: true,
    });
  });

  it("command 和 url 都有 = 报错，不猜", () => {
    const { servers, errors } = parseMcpConfig(JSON.stringify({
      mcpServers: { bad: { command: "npx", url: "https://x" } },
    }));
    expect(servers["bad"]).toBeUndefined();
    expect(errors.join()).toContain("bad");
  });

  it("两个都没有 = 报错", () => {
    const { errors } = parseMcpConfig(JSON.stringify({ mcpServers: { bad: { args: [] } } }));
    expect(errors.join()).toContain("bad");
  });

  it("enabled: false 认得", () => {
    const { servers } = parseMcpConfig(JSON.stringify({
      mcpServers: { off: { command: "x", enabled: false } },
    }));
    expect(servers["off"]!.enabled).toBe(false);
  });

  it("缺省字段补齐 —— args/env/headers 缺了就是空", () => {
    const { servers } = parseMcpConfig(JSON.stringify({ mcpServers: { s: { command: "x" } } }));
    expect(servers["s"]).toEqual({ kind: "stdio", command: "x", args: [], env: {}, enabled: true });
  });

  it("坏 JSON = 空清单 + 一条错，不抛", () => {
    const { servers, errors } = parseMcpConfig("{ 这不是 json");
    expect(servers).toEqual({});
    expect(errors).toHaveLength(1);
  });

  it("文件不存在（空串）= 空清单、零错误 —— 没配过不是错", () => {
    expect(parseMcpConfig("")).toEqual({ servers: {}, errors: [] });
  });

  it("一台坏的不带垮其它台", () => {
    const { servers, errors } = parseMcpConfig(JSON.stringify({
      mcpServers: { good: { command: "x" }, bad: {} },
    }));
    expect(servers["good"]).toBeDefined();
    expect(errors).toHaveLength(1);
  });
});

describe("serializeMcpConfig", () => {
  it("保留用户手写的未知顶层字段 —— 不能替他删", () => {
    const prev = JSON.stringify({ $schema: "https://x", mcpServers: {}, myNote: 1 });
    const out = JSON.parse(serializeMcpConfig(prev, {
      s: { kind: "stdio", command: "x", args: [], env: {}, enabled: true },
    }));
    expect(out["$schema"]).toBe("https://x");
    expect(out["myNote"]).toBe(1);
  });

  it("保留某台 server 上的未知字段", () => {
    const prev = JSON.stringify({ mcpServers: { s: { command: "old", timeout: 99 } } });
    const out = JSON.parse(serializeMcpConfig(prev, {
      s: { kind: "stdio", command: "new", args: [], env: {}, enabled: true },
    }));
    expect(out["mcpServers"]["s"]["timeout"]).toBe(99);
    expect(out["mcpServers"]["s"]["command"]).toBe("new");
  });

  it("删掉的 server 真的没了", () => {
    const prev = JSON.stringify({ mcpServers: { a: { command: "x" }, b: { command: "y" } } });
    const out = JSON.parse(serializeMcpConfig(prev, {
      a: { kind: "stdio", command: "x", args: [], env: {}, enabled: true },
    }));
    expect(Object.keys(out["mcpServers"])).toEqual(["a"]);
  });

  it("enabled 为 true 时不写进文件 —— 那是缺省值，写了是噪音", () => {
    const out = JSON.parse(serializeMcpConfig("", {
      s: { kind: "stdio", command: "x", args: [], env: {}, enabled: true },
    }));
    expect(out["mcpServers"]["s"]["enabled"]).toBeUndefined();
  });

  it("enabled 为 false 时写进去", () => {
    const out = JSON.parse(serializeMcpConfig("", {
      s: { kind: "stdio", command: "x", args: [], env: {}, enabled: false },
    }));
    expect(out["mcpServers"]["s"]["enabled"]).toBe(false);
  });

  it("prev 是坏 JSON 时不吞掉这次保存 —— 从空对象重建", () => {
    const out = JSON.parse(serializeMcpConfig("{ 坏", {
      s: { kind: "http", url: "https://x", headers: {}, enabled: true },
    }));
    expect(out["mcpServers"]["s"]["url"]).toBe("https://x");
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
cd ../Mr_Otto-mcp && npx vitest run tests/main/mcpConfig.test.ts
```

Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写最小实现**

新建 `src/main/mcpConfig.ts`：

```ts
// MCP server 清单 —— ~/.otter/mcp.json 的解析与写回。
// 格式与 Claude Code 的 .mcp.json 兼容（同名字段同语义），用户能把已有配置直接粘过来。
// 解析是纯函数，fs 以接口注入（抄 skills.ts 的 SkillDirReader 形状），测试喂假实现。
// 主进程模块（组装根特权可碰 fs）。

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { McpServerConfig } from "../shared/mcp.js";

export interface McpConfigReader {
  /** 文件全文；不存在/读不了 = 空串（"没配过"不是错） */
  readFile(path: string): string;
  writeFile(path: string, text: string): void;
}

const nodeReader: McpConfigReader = {
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  },
  writeFile(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    // 0600：文件里有 env/headers 里的凭据，与 keys.json 同一档待遇
    writeFileSync(path, text, { mode: 0o600 });
    chmodSync(path, 0o600); // mode 只在新建时生效，已有文件补一刀
  },
};

type Raw = Record<string, unknown>;

const asRecord = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});
const asStringMap = (v: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(asRecord(v)).map(([k, x]) => [k, String(x)]));
const asStringArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/** 解析。一台坏的不带垮其它台 —— 用户手写的文件，一个 typo 不该让全部 server 消失。
    错误结构化回流，由设置页显示，不抛（同 protocolListIssues 的降级口径）。 */
export function parseMcpConfig(text: string): {
  servers: Record<string, McpServerConfig>;
  errors: string[];
} {
  if (text.trim() === "") return { servers: {}, errors: [] };

  let root: Raw;
  try {
    root = asRecord(JSON.parse(text));
  } catch {
    return { servers: {}, errors: ["mcp.json 不是合法 JSON，整份配置本次被忽略"] };
  }

  const servers: Record<string, McpServerConfig> = {};
  const errors: string[] = [];

  for (const [id, node] of Object.entries(asRecord(root["mcpServers"]))) {
    const s = asRecord(node);
    const hasCommand = typeof s["command"] === "string" && s["command"] !== "";
    const hasUrl = typeof s["url"] === "string" && s["url"] !== "";
    const enabled = s["enabled"] !== false;

    if (hasCommand && hasUrl) {
      errors.push(`${id}：command 和 url 同时给了，无法判断走 stdio 还是 http（不猜，本台跳过）`);
      continue;
    }
    if (hasCommand) {
      servers[id] = {
        kind: "stdio",
        command: String(s["command"]),
        args: asStringArray(s["args"]),
        env: asStringMap(s["env"]),
        enabled,
      };
    } else if (hasUrl) {
      servers[id] = {
        kind: "http",
        url: String(s["url"]),
        headers: asStringMap(s["headers"]),
        enabled,
      };
    } else {
      errors.push(`${id}：既没有 command 也没有 url，不知道怎么连（本台跳过）`);
    }
  }

  return { servers, errors };
}

/** 写回。**在 prev 的基础上改**，不是重新生成 ——
    用户可能手写了本版不认识的键（timeout、$schema、注释性字段），替他删掉是数据损失。 */
export function serializeMcpConfig(
  prevText: string,
  servers: Record<string, McpServerConfig>
): string {
  let root: Raw;
  try {
    root = prevText.trim() === "" ? {} : asRecord(JSON.parse(prevText));
  } catch {
    root = {}; // prev 坏了不能吞掉这次保存，从空对象重建
  }

  const prevServers = asRecord(root["mcpServers"]);
  const next: Raw = {};

  for (const [id, cfg] of Object.entries(servers)) {
    const keep = asRecord(prevServers[id]);
    // 本版认识的键全部重写，其余原样留着
    for (const k of ["command", "args", "env", "url", "headers", "enabled"]) delete keep[k];
    const written: Raw =
      cfg.kind === "stdio"
        ? { command: cfg.command, args: cfg.args, env: cfg.env }
        : { url: cfg.url, headers: cfg.headers };
    if (!cfg.enabled) written["enabled"] = false; // true 是缺省，写了是噪音
    next[id] = { ...keep, ...written };
  }

  root["mcpServers"] = next;
  return `${JSON.stringify(root, null, 2)}\n`;
}

export function loadMcpConfig(
  path: string,
  reader: McpConfigReader = nodeReader
): { servers: Record<string, McpServerConfig>; errors: string[] } {
  return parseMcpConfig(reader.readFile(path));
}

export function saveMcpConfig(
  path: string,
  servers: Record<string, McpServerConfig>,
  reader: McpConfigReader = nodeReader
): void {
  reader.writeFile(path, serializeMcpConfig(reader.readFile(path), servers));
}
```

- [ ] **Step 4: 跑测试确认它通过**

```bash
cd ../Mr_Otto-mcp && npx vitest run tests/main/mcpConfig.test.ts
```

Expected: PASS（15 个 it 全绿）

- [ ] **Step 5: 跑全量门禁**

```bash
cd ../Mr_Otto-mcp && npm test
```

- [ ] **Step 6: 提交**

```bash
cd ../Mr_Otto-mcp
git add src/main/mcpConfig.ts tests/main/mcpConfig.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): ~/.otter/mcp.json 的解析与写回

格式与 Claude Code 的 .mcp.json 兼容，用户能把已有配置直接粘过来。

两个刻意的决定：
- command 与 url 同时给了 = 报错跳过这一台，不猜。猜错的后果是
  连到一个用户没打算连的地方
- 写回在 prev 基础上改而不是重新生成 —— 用户可能手写了本版不认识的
  键（timeout / $schema），替他删掉是数据损失

一台坏的不带垮其它台：手写文件里一个 typo 不该让全部 server 消失。
错误结构化回流给设置页，不抛。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `McpCapability` 上 World 接缝

**Files:**
- Modify: `src/world/executionWorld.ts`
- Test: `tests/world/executionWorld.test.ts`（在已有文件里加一个 describe）

**Interfaces:**
- Consumes: `McpToolInfo` / `McpResourceInfo` / `McpPromptInfo` / `McpContent` / `McpStatus` from Task 1
- Produces: `McpServerHandle`、`McpCapability`、`ExecutionWorld.mcp?`、`withMcp(world, mcp)`

- [ ] **Step 1: 写失败的测试**

在 `tests/world/executionWorld.test.ts` **末尾追加**（不动已有内容），并把顶部 import 补上 `withMcp` 与类型：

```ts
// —— 文件顶部 import 补充 ——
// import { withMcp, type McpCapability } from "../../src/world/executionWorld.js";

const fakeMcp = (): McpCapability => ({
  ready: async () => {},
  servers: () => [
    {
      id: "github",
      name: "github",
      status: "connected",
      live: true,
      tools: [{ name: "create_pr", description: "开 PR", inputSchema: {} }],
      resources: [],
      prompts: [],
    },
  ],
  callTool: async () => [{ kind: "text", text: "ok" }],
  readResource: async () => [{ kind: "text", text: "料" }],
  getPrompt: async () => "展开后的提示词",
});

describe("装饰器透传 mcp", () => {
  it("withMcp 焊上能力", () => {
    const w = withMcp(fakeWorld(), fakeMcp());
    expect(w.mcp?.servers()).toHaveLength(1);
  });

  it("withAbortSignal 保住 MCP 能力，并把 signal 绑进 callTool", async () => {
    const callTool = vi.fn(async () => [{ kind: "text" as const, text: "ok" }]);
    const ac = new AbortController();
    const w = withAbortSignal(withMcp(fakeWorld(), { ...fakeMcp(), callTool }), ac.signal);
    expect(w.mcp).toBeTypeOf("object");
    await w.mcp!.callTool("github", "create_pr", { a: 1 });
    expect(callTool).toHaveBeenCalledWith("github", "create_pr", { a: 1 }, ac.signal);
  });

  it("withAbortSignal 也把 signal 绑进 readResource", async () => {
    const readResource = vi.fn(async () => [{ kind: "text" as const, text: "料" }]);
    const ac = new AbortController();
    const w = withAbortSignal(withMcp(fakeWorld(), { ...fakeMcp(), readResource }), ac.signal);
    await w.mcp!.readResource("github", "file:///a");
    expect(readResource).toHaveBeenCalledWith("github", "file:///a", ac.signal);
  });

  it("withExecOutput 保住 MCP 能力 —— 它是逐字段重建 world 的，最容易漏", () => {
    const w = withExecOutput(withMcp(fakeWorld(), fakeMcp()), () => {});
    expect(w.mcp?.servers()).toHaveLength(1);
  });

  it("世界本来没有 MCP 时，装饰后依然没有（不凭空造一个）", () => {
    expect(withAbortSignal(fakeWorld(), new AbortController().signal).mcp).toBeUndefined();
    expect(withExecOutput(fakeWorld(), () => {}).mcp).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
cd ../Mr_Otto-mcp && npx vitest run tests/world/executionWorld.test.ts
```

Expected: FAIL —— `withMcp` 不存在

- [ ] **Step 3: 写最小实现**

在 `src/world/executionWorld.ts` 顶部加 import：

```ts
import type {
  McpContent, McpPromptInfo, McpResourceInfo, McpStatus, McpToolInfo,
} from "../shared/mcp.js";
```

在 `ExecutionWorld` 接口**之前**插入：

```ts
/** 一台**配置过**的 server 及其能力。三个 list 是快照，不是订阅——
    server 发 list_changed 通知时由 hub 重新拉，工具层永远只看到当下这份。
    没连上时三个 list 是空的，live 为 false —— 工具层靠它决定 Tool.available()。 */
export interface McpServerHandle {
  id: string;
  name: string;
  status: McpStatus;
  /** status === "connected" 的糖。工具层只关心这一个布尔 */
  live: boolean;
  tools: readonly McpToolInfo[];
  resources: readonly McpResourceInfo[];
  prompts: readonly McpPromptInfo[];
}

export interface McpCapability {
  /** 把所有 enabled 的 server 连一遍，全部落定后 resolve。幂等：已连上的不重连。
      agent.ts 拼工具表之前 await 它 —— 工具表是一次性拼好的（挂载一次定终身），
      拼的时候必须已经知道每台提供了什么。 */
  ready(): Promise<void>;
  /** 全部**配置过**的 server，连没连上都在。
      挂载需要全集，可用性由每台的 live 决定。 */
  servers(): readonly McpServerHandle[];
  callTool(serverId: string, tool: string, args: unknown, signal?: AbortSignal): Promise<McpContent[]>;
  readResource(serverId: string, uri: string, signal?: AbortSignal): Promise<McpContent[]>;
  getPrompt(serverId: string, name: string, args: Record<string, string>): Promise<string>;
}
```

在 `ExecutionWorld` 接口里，`browser?: BrowserCapability;` 之后加：

```ts
  /** 可选:这个世界能不能连 MCP server。
      注入方向同 browser —— hub 要管子进程生命周期、要向渲染层推状态,
      LocalWorld 造不出来,由 index.ts 用 withMcp 焊进来(ADR-0035 同款)。
      v2 SandboxWorld 把 stdio server spawn 进容器,这一层接口一字不改。 */
  mcp?: McpCapability;
```

在 `withAbortSignal` 的返回对象里，`browser` 那一行之后加：

```ts
    ...(world.mcp
      ? {
          mcp: {
            ready: () => world.mcp!.ready(),
            servers: () => world.mcp!.servers(),
            callTool: (id: string, tool: string, args: unknown) =>
              world.mcp!.callTool(id, tool, args, signal),
            readResource: (id: string, uri: string) => world.mcp!.readResource(id, uri, signal),
            getPrompt: (id: string, name: string, args: Record<string, string>) =>
              world.mcp!.getPrompt(id, name, args),
          },
        }
      : {}),
```

在 `withExecOutput` 的返回对象里，`browser` 那一行之后加：

```ts
    ...(world.mcp ? { mcp: world.mcp } : {}),
```

在文件末尾加：

```ts
/** 把 MCP 能力焊进 world —— withBrowser 同款手法。
    index.ts 从 mcpHub 注入,工具照旧只调 world.mcp.callTool,对 hub 的存在无感
    (硬规则原样成立)。 */
export function withMcp(world: ExecutionWorld, mcp: McpCapability): ExecutionWorld {
  return { ...world, mcp };
}
```

- [ ] **Step 4: 跑测试确认它通过**

```bash
cd ../Mr_Otto-mcp && npx vitest run tests/world/executionWorld.test.ts
```

Expected: PASS（新加 5 个 it，已有的一个不掉）

- [ ] **Step 5: 跑全量门禁**

```bash
cd ../Mr_Otto-mcp && npm test
```

- [ ] **Step 6: 提交**

```bash
cd ../Mr_Otto-mcp
git add src/world/executionWorld.ts tests/world/executionWorld.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): McpCapability 骑上 ExecutionWorld 接缝

第四次复述 ADR-0008/0031/0035：工具只认接口，不知道背后是本机
spawn 还是容器。stdio 要 spawn 子进程，注入 client 进工具层就破了
硬规则，且 v2 容器化时那条线得重写。

两个装饰器是逐字段枚举重建 world 的（不是 spread），新字段必须
手工补透传 —— 专门为此加了回归测试：漏了就静默丢能力，很难查。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 把 MCP tool 包成 `Tool`

**Files:**
- Create: `src/tools/mcpTool.ts`
- Test: `tests/tools/mcpTool.test.ts`

**Interfaces:**
- Consumes: `McpCapability` / `McpServerHandle`（Task 3）、`mcpToolName` / `renderMcpContent`（Task 1）、`Tool` from `src/tools/tool.ts`
- Produces: `createMcpTools(mcp: McpCapability): Tool[]`

**注意：本文件不许 import `fs` / `child_process` / SDK。它只认 `ExecutionWorld` 与 `McpCapability`。**

- [ ] **Step 1: 写失败的测试**

新建 `tests/tools/mcpTool.test.ts`：

```ts
import { describe, it, expect, vi } from "vitest";
import { createMcpTools } from "../../src/tools/mcpTool.js";
import type { ExecutionWorld, McpCapability, McpServerHandle } from "../../src/world/executionWorld.js";

function handle(over: Partial<McpServerHandle> = {}): McpServerHandle {
  return {
    id: "github",
    name: "github",
    status: "connected",
    live: true,
    tools: [{ name: "create_pr", description: "开一个 PR", inputSchema: { type: "object" } }],
    resources: [],
    prompts: [],
    ...over,
  };
}

function capWith(
  servers: McpServerHandle[],
  callTool: McpCapability["callTool"] = async () => [{ kind: "text", text: "ok" }]
): McpCapability {
  return {
    ready: async () => {},
    servers: () => servers,
    callTool,
    readResource: async () => [],
    getPrompt: async () => "",
  };
}

const worldWith = (mcp: McpCapability): ExecutionWorld => ({
  fs: { read: async () => "", write: async () => {} },
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
  mcp,
});

describe("createMcpTools", () => {
  it("每个 server 的每个 tool 各出一把刀，名字带前缀", () => {
    const tools = createMcpTools(capWith([handle()]));
    expect(tools.map((t) => t.def.name)).toEqual(["mcp__github__create_pr"]);
  });

  it("description 与 inputSchema 原样透给模型", () => {
    const [t] = createMcpTools(capWith([handle()]));
    expect(t!.def.description).toBe("开一个 PR");
    expect(t!.def.parameters).toEqual({ type: "object" });
  });

  it("全部要审批 —— server 是外部代码，readOnlyHint 是它自报的，不采信", () => {
    const [t] = createMcpTools(capWith([handle()]));
    expect(t!.requiresApproval).toBe(true);
  });

  it("run 把调用转给 world.mcp.callTool，带上 serverId 与原始工具名", async () => {
    const callTool = vi.fn(async () => [{ kind: "text" as const, text: "开好了" }]);
    const cap = capWith([handle()], callTool);
    const [t] = createMcpTools(cap);
    const out = await t!.run({ title: "x" }, worldWith(cap), { toolCallId: "c1" });
    expect(callTool).toHaveBeenCalledWith("github", "create_pr", { title: "x" }, undefined);
    expect(out).toBe("开好了");
  });

  it("signal 从 ctx 透下去（turn 中断要能杀掉在飞的调用）", async () => {
    const callTool = vi.fn(async () => [{ kind: "text" as const, text: "ok" }]);
    const cap = capWith([handle()], callTool);
    const [t] = createMcpTools(cap);
    const ac = new AbortController();
    await t!.run({}, worldWith(cap), { toolCallId: "c1", signal: ac.signal });
    expect(callTool).toHaveBeenCalledWith("github", "create_pr", {}, ac.signal);
  });

  it("live 的 server，available() 为 true", () => {
    const [t] = createMcpTools(capWith([handle()]));
    expect(t!.available?.()).toBe(true);
  });

  it("server 掉线后 available() 转 false —— 刀还挂着，只是不进声明表", () => {
    const servers = [handle()];
    const [t] = createMcpTools(capWith(servers));
    servers[0] = handle({ live: false, status: "failed" });
    expect(t!.available?.()).toBe(false);
  });

  it("掉线时调用它，报的是人话而不是崩", async () => {
    const servers = [handle()];
    const cap = capWith(servers);
    const [t] = createMcpTools(cap);
    servers[0] = handle({ live: false, status: "failed" });
    await expect(t!.run({}, worldWith(cap), { toolCallId: "c1" })).rejects.toThrow(/github/);
  });

  it("装配时没连上的 server 不出刀 —— 没有清单就无从挂起", () => {
    const tools = createMcpTools(capWith([handle({ live: false, status: "failed", tools: [] })]));
    expect(tools).toEqual([]);
  });

  it("两台 server 各自的同名工具不撞名", () => {
    const tools = createMcpTools(capWith([
      handle({ id: "a", name: "a" }),
      handle({ id: "b", name: "b" }),
    ]));
    expect(tools.map((t) => t.def.name)).toEqual(["mcp__a__create_pr", "mcp__b__create_pr"]);
  });

  it("world 上没有 mcp 时 run 报人话（裸装配的兜底）", async () => {
    const cap = capWith([handle()]);
    const [t] = createMcpTools(cap);
    const bare: ExecutionWorld = {
      fs: { read: async () => "", write: async () => {} },
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      http: { postJson: async () => ({}) },
    };
    await expect(t!.run({}, bare, { toolCallId: "c1" })).rejects.toThrow(/MCP/);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
cd ../Mr_Otto-mcp && npx vitest run tests/tools/mcpTool.test.ts
```

Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写最小实现**

新建 `src/tools/mcpTool.ts`：

```ts
// MCP 工具 —— 把一台 server 自报的每个 tool 包成本仓的 Tool 形状。
// 只依赖 ExecutionWorld / McpCapability（AGENTS.md 硬规则）：
// 这里不知道背后是 stdio 子进程还是远程 HTTP，也不知道 SDK 长什么样。

import type { Tool } from "./tool.js";
import type { McpCapability } from "../world/executionWorld.js";
import { mcpToolName, renderMcpContent } from "../shared/mcp.js";

/** 装配时把每台**已连上**的 server 的工具全挂上。
    没连上的不出刀 —— 它的工具清单是空的，没有 def 就无从挂起（spec §四第 3 点）。
    挂上之后能不能用由 available() 管：掉线时从模型看到的声明表里消失，
    但留在 toolsByName 里，这样掉线前发出的调用还能收到一句人话（engine.ts:208 的语义）。 */
export function createMcpTools(mcp: McpCapability): Tool[] {
  return mcp.servers().flatMap((server) =>
    server.tools.map<Tool>((t) => ({
      def: {
        name: mcpToolName(server.name, t.name),
        description: t.description,
        parameters: t.inputSchema,
      },
      // 全部要审批：server 是外部代码，MCP 协议里的 readOnlyHint 是它自报的，
      // 不采信（同"不采信页面自报 URL"的判断）。授权记忆按完整工具名记，
      // 所以"永久允许读 issue"不会顺带允许"建 PR"（ADR-0041）
      requiresApproval: true,
      available: () => mcp.servers().some((s) => s.id === server.id && s.live),
      async run(args, world, ctx) {
        if (!world.mcp) throw new Error("这个装配没有 MCP 能力，工具用不了");
        if (!world.mcp.servers().some((s) => s.id === server.id && s.live)) {
          throw new Error(`MCP server「${server.name}」当前没连上，这次调用没发出去`);
        }
        const content = await world.mcp.callTool(server.id, t.name, args, ctx?.signal);
        return renderMcpContent(content);
      },
    }))
  );
}
```

- [ ] **Step 4: 跑测试确认它通过**

```bash
cd ../Mr_Otto-mcp && npx vitest run tests/tools/mcpTool.test.ts
```

Expected: PASS（11 个 it 全绿）

- [ ] **Step 5: 确认没有违反硬规则**

```bash
cd ../Mr_Otto-mcp && grep -nE "node:fs|node:child_process|modelcontextprotocol" src/tools/mcpTool.ts
```

Expected: 无输出（grep 退出码 1）

- [ ] **Step 6: 跑全量门禁并提交**

```bash
cd ../Mr_Otto-mcp && npm test
git add src/tools/mcpTool.ts tests/tools/mcpTool.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): 把 server 的 tool 包成本仓的 Tool

全部 requiresApproval=true：server 是外部代码，协议里的 readOnlyHint
是它自报的，不采信 —— 同"不采信页面自报 URL"的判断。授权记忆按完整
工具名记（mcp__github__create_pr），"永久允许读 issue"不会顺带
允许"建 PR"。

掉线的处理分两种，别混：装配时没连上 = 不出刀（没清单无从挂起）；
装配后掉线 = 刀还挂着，available() 转 false 从声明表消失，
掉线前发出的调用仍收到一句人话而不是"未知工具"。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `mcp_read_resource` 工具

**Files:**
- Create: `src/tools/mcpReadResource.ts`
- Test: `tests/tools/mcpReadResource.test.ts`

**Interfaces:**
- Consumes: `McpCapability`（Task 3）、`renderMcpContent`（Task 1）
- Produces: `createMcpReadResourceTool(mcp: McpCapability): Tool`

- [ ] **Step 1: 写失败的测试**

新建 `tests/tools/mcpReadResource.test.ts`：

```ts
import { describe, it, expect, vi } from "vitest";
import { createMcpReadResourceTool } from "../../src/tools/mcpReadResource.js";
import type { ExecutionWorld, McpCapability, McpServerHandle } from "../../src/world/executionWorld.js";

function handle(resources: McpServerHandle["resources"]): McpServerHandle {
  return { id: "fs", name: "fs", status: "connected", live: true, tools: [], resources, prompts: [] };
}

function capWith(
  servers: McpServerHandle[],
  readResource: McpCapability["readResource"] = async () => [{ kind: "text", text: "料" }]
): McpCapability {
  return { ready: async () => {}, servers: () => servers, callTool: async () => [], readResource, getPrompt: async () => "" };
}

const worldWith = (mcp: McpCapability): ExecutionWorld => ({
  fs: { read: async () => "", write: async () => {} },
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
  mcp,
});

const RES = [{ uri: "file:///a.txt", name: "A", description: "第一份" }];

describe("mcp_read_resource", () => {
  it("不审批 —— 纯读，照 browser_read / web_extract", () => {
    expect(createMcpReadResourceTool(capWith([handle(RES)])).requiresApproval).toBe(false);
  });

  it("可读清单进 description，模型才知道有什么可读", () => {
    const t = createMcpReadResourceTool(capWith([handle(RES)]));
    expect(t.def.description).toContain("file:///a.txt");
    expect(t.def.description).toContain("第一份");
  });

  it("一台 resource 都没有时 available() 为 false —— 不给模型一把没用的刀", () => {
    expect(createMcpReadResourceTool(capWith([handle([])])).available?.()).toBe(false);
  });

  it("有 resource 时 available() 为 true", () => {
    expect(createMcpReadResourceTool(capWith([handle(RES)])).available?.()).toBe(true);
  });

  it("清单超上限时截断，并明说截了", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ uri: `file:///f${i}`, name: `F${i}` }));
    const t = createMcpReadResourceTool(capWith([handle(many)]));
    expect(t.def.description).toContain("还有");
    expect(t.def.description).not.toContain("file:///f199");
  });

  it("run 把 server + uri 转给 world.mcp.readResource", async () => {
    const readResource = vi.fn(async () => [{ kind: "text" as const, text: "正文" }]);
    const cap = capWith([handle(RES)], readResource);
    const t = createMcpReadResourceTool(cap);
    const out = await t.run({ server: "fs", uri: "file:///a.txt" }, worldWith(cap), { toolCallId: "c" });
    expect(readResource).toHaveBeenCalledWith("fs", "file:///a.txt", undefined);
    expect(out).toBe("正文");
  });

  it("signal 透传", async () => {
    const readResource = vi.fn(async () => [{ kind: "text" as const, text: "x" }]);
    const cap = capWith([handle(RES)], readResource);
    const ac = new AbortController();
    await createMcpReadResourceTool(cap).run(
      { server: "fs", uri: "file:///a.txt" }, worldWith(cap), { toolCallId: "c", signal: ac.signal }
    );
    expect(readResource).toHaveBeenCalledWith("fs", "file:///a.txt", ac.signal);
  });

  it("认不得的 server 名报人话，并列出认得哪些", async () => {
    const cap = capWith([handle(RES)]);
    await expect(
      createMcpReadResourceTool(cap).run({ server: "nope", uri: "x" }, worldWith(cap), { toolCallId: "c" })
    ).rejects.toThrow(/fs/);
  });

  it("参数缺 uri 时报人话，不是 undefined 一路传下去", async () => {
    const cap = capWith([handle(RES)]);
    await expect(
      createMcpReadResourceTool(cap).run({ server: "fs" }, worldWith(cap), { toolCallId: "c" })
    ).rejects.toThrow(/uri/);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
cd ../Mr_Otto-mcp && npx vitest run tests/tools/mcpReadResource.test.ts
```

Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写最小实现**

新建 `src/tools/mcpReadResource.ts`：

```ts
// mcp_read_resource —— 读 MCP server 暴露的资源。
//
// 为什么是"模型主动读"而不是"连上就注入上下文"：自动注入会造出一份模型看得见、
// 却不在事件日志里的内容,直接撞硬规则「先落盘再喂模型」。要合规就得为"注入了哪些
// resource"造新 SessionEvent,还得保证重放时拿回**当时那一版**内容(server 上的文件
// 早变了)——代价远大于收益。走工具调用则天然合规：读取就是一次
// ToolExecutionStarted + ToolResult,内容原样落盘,重放拿到的是当时读到的那一份。

import type { Tool } from "./tool.js";
import type { McpCapability } from "../world/executionWorld.js";
import { renderMcpContent } from "../shared/mcp.js";

/** 清单进 description 的条数上限。再多模型也读不完,而 description 是每轮都要
    进上下文的常驻成本 —— 截断了就明说,不假装列全了(同 browser_read 的 truncated) */
const LIST_MAX = 40;

function describeResources(mcp: McpCapability): string {
  const rows: string[] = [];
  let total = 0;
  for (const s of mcp.servers()) {
    if (!s.live) continue;
    for (const r of s.resources) {
      total++;
      if (rows.length < LIST_MAX) {
        rows.push(`- server=${s.name} uri=${r.uri} — ${r.name}${r.description ? `：${r.description}` : ""}`);
      }
    }
  }
  const head = "读一份 MCP server 暴露的资源。当前可读的有：";
  const tail = total > rows.length ? `\n（还有 ${total - rows.length} 份没列出来）` : "";
  return rows.length === 0 ? "读一份 MCP server 暴露的资源。当前没有任何可读资源。" : `${head}\n${rows.join("\n")}${tail}`;
}

export function createMcpReadResourceTool(mcp: McpCapability): Tool {
  const hasAny = () => mcp.servers().some((s) => s.live && s.resources.length > 0);
  return {
    def: {
      name: "mcp_read_resource",
      // 活的：每轮拼声明表时现算,server 增删/掉线都能反映出来
      get description() {
        return describeResources(mcp);
      },
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "server 名（见工具描述里的 server=）" },
          uri: { type: "string", description: "资源 uri（见工具描述里的 uri=）" },
        },
        required: ["server", "uri"],
      },
    },
    // 纯读不落地,照 browser_read / web_extract
    requiresApproval: false,
    // 一份资源都没有时不给模型这把刀 —— 空刀只会诱导它乱调
    available: hasAny,
    async run(args, world, ctx) {
      if (!world.mcp) throw new Error("这个装配没有 MCP 能力，工具用不了");
      const a = (args ?? {}) as { server?: unknown; uri?: unknown };
      const server = typeof a.server === "string" ? a.server : "";
      const uri = typeof a.uri === "string" ? a.uri : "";
      if (!uri) throw new Error("缺少参数 uri —— 要读哪一份资源");

      const hit = world.mcp.servers().find((s) => s.live && s.name === server);
      if (!hit) {
        const live = world.mcp.servers().filter((s) => s.live).map((s) => s.name);
        throw new Error(
          `没有连上名叫「${server}」的 MCP server。当前连着的是：${live.join("、") || "（一台都没有）"}`
        );
      }
      return renderMcpContent(await world.mcp.readResource(hit.id, uri, ctx?.signal));
    },
  };
}
```

> **注意**：`def.description` 用的是 getter。若 `ToolDefinition` 的类型不允许 getter（它只是 `description: string`，getter 在结构上兼容），无需改类型；`engine.ts:211` 每轮都重新 `map(t => t.def)`，getter 天然被求值。

- [ ] **Step 4: 跑测试确认它通过**

```bash
cd ../Mr_Otto-mcp && npx vitest run tests/tools/mcpReadResource.test.ts
```

Expected: PASS（9 个 it 全绿）

- [ ] **Step 5: 跑全量门禁并提交**

```bash
cd ../Mr_Otto-mcp && npm test
git add src/tools/mcpReadResource.ts tests/tools/mcpReadResource.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): mcp_read_resource —— resource 走模型主动读

不做"连上就注入上下文"：自动注入会造出模型看得见、却不在事件日志里的
内容，直接撞硬规则「先落盘再喂模型」。要合规就得造新 SessionEvent，
还得保证重放时拿回当时那一版内容（server 上的文件早变了）——代价远
大于收益。走工具调用则天然合规。

清单进 description 且截断时明说，同 browser_read 的 truncated 口径。
一份资源都没有时 available() 为 false —— 空刀只会诱导模型乱调。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: SDK 客户端 + 连接状态机

**Files:**
- Create: `src/main/mcpClient.ts`（**唯一** import SDK 的文件）
- Create: `src/main/mcpHub.ts`
- Test: `tests/main/mcpHub.test.ts`
- Modify: `package.json`（加依赖）

**Interfaces:**
- Consumes: `McpServerConfig`（Task 1）、`loadMcpConfig` / `saveMcpConfig`（Task 2）、`McpCapability` / `McpServerHandle`（Task 3）
- Produces: `McpClientConn`、`McpAuthRequiredError`、`connectMcpClient(id, cfg)`、`createMcpHub(opts): McpHub`（`McpHub extends McpCapability` 且多出 `list()` / `save()` / `remove()` / `reconnect()` / `onChange()` / `closeAll()`）

- [ ] **Step 1: 装依赖**

```bash
cd ../Mr_Otto-mcp && npm install @modelcontextprotocol/sdk
```

- [ ] **Step 2: 写失败的测试**

新建 `tests/main/mcpHub.test.ts`。**hub 不起真进程**：`connect` 以接口注入，测试喂假实现。

```ts
import { describe, it, expect, vi } from "vitest";
import { createMcpHub, type McpConnect } from "../../src/main/mcpHub.js";
import { McpAuthRequiredError, type McpClientConn } from "../../src/main/mcpClient.js";
import type { McpServerConfig } from "../../src/shared/mcp.js";

const stdio = (command = "npx"): McpServerConfig => ({
  kind: "stdio", command, args: [], env: {}, enabled: true,
});

function conn(over: Partial<McpClientConn> = {}): McpClientConn {
  return {
    tools: [{ name: "t1", description: "一把刀", inputSchema: {} }],
    resources: [],
    prompts: [],
    callTool: async () => [{ kind: "text", text: "ok" }],
    readResource: async () => [{ kind: "text", text: "料" }],
    getPrompt: async () => "提示词",
    onListChanged: () => {},
    close: async () => {},
    ...over,
  };
}

/** 内存里的配置源 —— 不碰磁盘 */
function memStore(initial: Record<string, McpServerConfig> = {}) {
  let servers = { ...initial };
  return {
    load: () => ({ servers, errors: [] as string[] }),
    save: (next: Record<string, McpServerConfig>) => { servers = { ...next }; },
  };
}

describe("createMcpHub", () => {
  it("ready() 把 enabled 的 server 连上，状态转 connected", async () => {
    const connect: McpConnect = vi.fn(async () => conn());
    const hub = createMcpHub({ ...memStore({ a: stdio() }), connect });
    await hub.ready();
    const [s] = hub.servers();
    expect(s!.status).toBe("connected");
    expect(s!.live).toBe(true);
    expect(s!.tools.map((t) => t.name)).toEqual(["t1"]);
  });

  it("enabled: false 的不连，但仍出现在清单里（设置页要显示它）", async () => {
    const connect: McpConnect = vi.fn(async () => conn());
    const hub = createMcpHub({ ...memStore({ off: { ...stdio(), enabled: false } }), connect });
    await hub.ready();
    expect(connect).not.toHaveBeenCalled();
    expect(hub.servers()).toHaveLength(1);
    expect(hub.servers()[0]!.live).toBe(false);
  });

  it("连不上 = failed + 人话原因，不抛（一台挂了不该拖垮 ready）", async () => {
    const connect: McpConnect = async () => { throw new Error("spawn npx ENOENT"); };
    const hub = createMcpHub({ ...memStore({ a: stdio() }), connect });
    await expect(hub.ready()).resolves.toBeUndefined();
    const [s] = hub.servers();
    expect(s!.status).toBe("failed");
    expect(s!.error).toContain("ENOENT");
  });

  it("401 映射成 needs-auth 而不是 failed —— UI 要据此显示 Authorize", async () => {
    const connect: McpConnect = async () => { throw new McpAuthRequiredError("要授权"); };
    const hub = createMcpHub({ ...memStore({ a: stdio() }), connect });
    await hub.ready();
    expect(hub.servers()[0]!.status).toBe("needs-auth");
  });

  it("一台挂了不影响另一台连上", async () => {
    const connect: McpConnect = async (id) => {
      if (id === "bad") throw new Error("炸了");
      return conn();
    };
    const hub = createMcpHub({ ...memStore({ bad: stdio(), good: stdio() }), connect });
    await hub.ready();
    const byId = Object.fromEntries(hub.servers().map((s) => [s.id, s.status]));
    expect(byId["bad"]).toBe("failed");
    expect(byId["good"]).toBe("connected");
  });

  it("ready() 幂等 —— 已连上的不重连", async () => {
    const connect: McpConnect = vi.fn(async () => conn());
    const hub = createMcpHub({ ...memStore({ a: stdio() }), connect });
    await hub.ready();
    await hub.ready();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("并发调 ready() 只连一次", async () => {
    const connect: McpConnect = vi.fn(async () => conn());
    const hub = createMcpHub({ ...memStore({ a: stdio() }), connect });
    await Promise.all([hub.ready(), hub.ready(), hub.ready()]);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("failed 的 server 下次 ready() 会重试 —— 用户可能刚把 npx 装上", async () => {
    let fail = true;
    const connect: McpConnect = vi.fn(async () => {
      if (fail) throw new Error("炸了");
      return conn();
    });
    const hub = createMcpHub({ ...memStore({ a: stdio() }), connect });
    await hub.ready();
    expect(hub.servers()[0]!.status).toBe("failed");
    fail = false;
    await hub.ready();
    expect(hub.servers()[0]!.status).toBe("connected");
  });

  it("callTool 转给对应的 conn", async () => {
    const callTool = vi.fn(async () => [{ kind: "text" as const, text: "结果" }]);
    const hub = createMcpHub({ ...memStore({ a: stdio() }), connect: async () => conn({ callTool }) });
    await hub.ready();
    const out = await hub.callTool("a", "t1", { x: 1 });
    expect(callTool).toHaveBeenCalledWith("t1", { x: 1 }, undefined);
    expect(out).toEqual([{ kind: "text", text: "结果" }]);
  });

  it("对没连上的 server 调 callTool 报人话", async () => {
    const hub = createMcpHub({ ...memStore({ a: stdio() }), connect: async () => { throw new Error("x"); } });
    await hub.ready();
    await expect(hub.callTool("a", "t1", {})).rejects.toThrow(/a/);
  });

  it("list_changed 通知触发重拉清单", async () => {
    let fire = () => {};
    let tools = [{ name: "t1", description: "", inputSchema: {} }];
    const connect: McpConnect = async () => ({
      ...conn(),
      get tools() { return tools; },
      onListChanged: (cb: () => void) => { fire = cb; },
    });
    const hub = createMcpHub({ ...memStore({ a: stdio() }), connect });
    await hub.ready();
    expect(hub.servers()[0]!.tools).toHaveLength(1);
    tools = [...tools, { name: "t2", description: "", inputSchema: {} }];
    fire();
    await vi.waitFor(() => expect(hub.servers()[0]!.tools).toHaveLength(2));
  });

  it("onChange 在状态变化时被叫到（渲染层靠它刷新）", async () => {
    const seen = vi.fn();
    const hub = createMcpHub({ ...memStore({ a: stdio() }), connect: async () => conn() });
    hub.onChange(seen);
    await hub.ready();
    expect(seen).toHaveBeenCalled();
  });

  it("save() 存配置并重连那一台", async () => {
    const store = memStore();
    const connect: McpConnect = vi.fn(async () => conn());
    const hub = createMcpHub({ ...store, connect });
    await hub.save("a", stdio());
    expect(store.load().servers["a"]).toBeDefined();
    expect(hub.servers()[0]!.status).toBe("connected");
  });

  it("remove() 关掉连接并从清单里去掉", async () => {
    const close = vi.fn(async () => {});
    const hub = createMcpHub({ ...memStore({ a: stdio() }), connect: async () => conn({ close }) });
    await hub.ready();
    await hub.remove("a");
    expect(close).toHaveBeenCalled();
    expect(hub.servers()).toEqual([]);
  });

  it("closeAll() 关掉每一条连接（退出时用）", async () => {
    const close = vi.fn(async () => {});
    const hub = createMcpHub({ ...memStore({ a: stdio(), b: stdio() }), connect: async () => conn({ close }) });
    await hub.ready();
    await hub.closeAll();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("list() 过桥的配置里凭据是遮罩过的 —— 真值不出主进程", async () => {
    const secret: McpServerConfig = {
      kind: "stdio", command: "npx", args: [], env: { TOKEN: "ghp_abcdefghijklmnop" }, enabled: true,
    };
    const hub = createMcpHub({ ...memStore({ a: secret }), connect: async () => conn() });
    const [row] = hub.list();
    expect(row!.config.kind).toBe("stdio");
    if (row!.config.kind !== "stdio") throw new Error("窄化失败");
    expect(row!.config.env["TOKEN"]).toContain("*****");
    expect(JSON.stringify(hub.list())).not.toContain("ghp_abcdefghijklmnop");
  });
});
```

- [ ] **Step 3: 跑测试确认它失败**

```bash
cd ../Mr_Otto-mcp && npx vitest run tests/main/mcpHub.test.ts
```

Expected: FAIL —— 模块不存在

- [ ] **Step 4: 写 `src/main/mcpClient.ts`**

```ts
// MCP 客户端 —— **本仓唯一** import @modelcontextprotocol/sdk 的文件。
// 把 SDK 锁在一个文件里的理由：依赖树上多一棵树是有成本的,将来换实现只动这一处;
// 而且 mcpHub 因此可以完全不碰 SDK,状态机能用假 connect 测干净。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  McpContent, McpPromptInfo, McpResourceInfo, McpServerConfig, McpToolInfo,
} from "../shared/mcp.js";

/** 需要授权 —— hub 据此把状态标成 needs-auth 而不是 failed。
    两者对用户的意思完全不同：一个是"你去点一下授权",一个是"这台坏了"。 */
export class McpAuthRequiredError extends Error {}

/** 一条连上的 MCP 连接。hub 只认这个形状,不认 SDK。 */
export interface McpClientConn {
  readonly tools: McpToolInfo[];
  readonly resources: McpResourceInfo[];
  readonly prompts: McpPromptInfo[];
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpContent[]>;
  readResource(uri: string, signal?: AbortSignal): Promise<McpContent[]>;
  getPrompt(name: string, args: Record<string, string>): Promise<string>;
  /** server 说"我的清单变了" —— hub 收到就重拉 */
  onListChanged(cb: () => void): void;
  close(): Promise<void>;
}

type RawContent = { type: string; text?: string; data?: string; mimeType?: string; resource?: { uri?: string; text?: string; mimeType?: string } };

/** SDK 的 content 形状 → 本仓的 McpContent。认不得的类型折成一行说明,不静默丢 */
function toContent(raw: unknown): McpContent[] {
  const arr = Array.isArray(raw) ? (raw as RawContent[]) : [];
  return arr.map((c): McpContent => {
    if (c.type === "text") return { kind: "text", text: c.text ?? "" };
    if (c.type === "image") return { kind: "image", data: c.data ?? "", mimeType: c.mimeType ?? "image/png" };
    if (c.type === "resource") {
      return {
        kind: "resource",
        uri: c.resource?.uri ?? "",
        ...(c.resource?.text !== undefined ? { text: c.resource.text } : {}),
        ...(c.resource?.mimeType !== undefined ? { mimeType: c.resource.mimeType } : {}),
      };
    }
    return { kind: "text", text: `(server 返回了本版认不得的内容类型：${c.type})` };
  });
}

const looksLikeAuth = (e: unknown): boolean => {
  const msg = e instanceof Error ? e.message : String(e);
  return /\b401\b|unauthor|forbidden|\b403\b/i.test(msg);
};

/** 连一台 server,握手 + 拉三份清单。失败原样抛(hub 负责分类) */
export async function connectMcpClient(id: string, cfg: McpServerConfig): Promise<McpClientConn> {
  const client = new Client({ name: "mr-otto", version: "1.0.0" }, { capabilities: {} });

  const transport =
    cfg.kind === "stdio"
      ? new StdioClientTransport({
          command: cfg.command,
          args: cfg.args,
          // 继承当前环境再叠用户配的 —— npx 要 PATH 才跑得起来
          env: { ...(process.env as Record<string, string>), ...cfg.env },
        })
      : new StreamableHTTPClientTransport(new URL(cfg.url), {
          requestInit: { headers: cfg.headers },
        });

  try {
    await client.connect(transport);
  } catch (e) {
    if (looksLikeAuth(e)) throw new McpAuthRequiredError(`${id} 需要授权：${String(e)}`);
    throw e;
  }

  // 三份清单：server 没声明对应 capability 时 SDK 会抛,那不是错,是"这台没有这项"
  const safe = async <T>(f: () => Promise<T>, empty: T): Promise<T> => {
    try {
      return await f();
    } catch {
      return empty;
    }
  };

  const conn: McpClientConn = {
    tools: [],
    resources: [],
    prompts: [],
    async callTool(name, args, signal) {
      const r = await client.callTool(
        { name, arguments: (args ?? {}) as Record<string, unknown> },
        undefined,
        signal ? { signal } : undefined
      );
      return toContent((r as { content?: unknown }).content);
    },
    async readResource(uri, signal) {
      const r = await client.readResource({ uri }, signal ? { signal } : undefined);
      const contents = (r as { contents?: { uri?: string; text?: string; mimeType?: string }[] }).contents ?? [];
      return contents.map((c) => ({
        kind: "resource" as const,
        uri: c.uri ?? uri,
        ...(c.text !== undefined ? { text: c.text } : {}),
        ...(c.mimeType !== undefined ? { mimeType: c.mimeType } : {}),
      }));
    },
    async getPrompt(name, args) {
      const r = await client.getPrompt({ name, arguments: args });
      const msgs = (r as { messages?: { content?: unknown }[] }).messages ?? [];
      return msgs.flatMap((m) => toContent([m.content])).map((c) => (c.kind === "text" ? c.text : "")).join("\n\n").trim();
    },
    onListChanged(cb) {
      client.setNotificationHandler({ method: "notifications/tools/list_changed" } as never, () => { cb(); });
      client.setNotificationHandler({ method: "notifications/resources/list_changed" } as never, () => { cb(); });
      client.setNotificationHandler({ method: "notifications/prompts/list_changed" } as never, () => { cb(); });
    },
    close: () => client.close(),
  };

  // refresh 是可变的：list_changed 之后 hub 会再叫一次
  const mutable = conn as { tools: McpToolInfo[]; resources: McpResourceInfo[]; prompts: McpPromptInfo[] };
  const refresh = async () => {
    const t = await safe(() => client.listTools(), { tools: [] });
    const r = await safe(() => client.listResources(), { resources: [] });
    const p = await safe(() => client.listPrompts(), { prompts: [] });
    mutable.tools = (t.tools ?? []).map((x) => ({
      name: x.name, description: x.description ?? "", inputSchema: x.inputSchema ?? { type: "object" },
    }));
    mutable.resources = (r.resources ?? []).map((x) => ({
      uri: x.uri, name: x.name ?? x.uri,
      ...(x.description !== undefined ? { description: x.description } : {}),
      ...(x.mimeType !== undefined ? { mimeType: x.mimeType } : {}),
    }));
    mutable.prompts = (p.prompts ?? []).map((x) => ({
      name: x.name,
      ...(x.description !== undefined ? { description: x.description } : {}),
      arguments: (x.arguments ?? []).map((a) => ({
        name: a.name,
        ...(a.description !== undefined ? { description: a.description } : {}),
        ...(a.required !== undefined ? { required: a.required } : {}),
      })),
    }));
  };
  await refresh();
  (conn as { refresh?: () => Promise<void> }).refresh = refresh;

  return conn;
}
```

> **执行提示**：SDK 的具体方法名与返回形状以安装到的版本为准。跑 `npx tsc --noEmit` 校对；若签名对不上，改的是这一个文件，`McpClientConn` 的形状不动 —— 那是 hub 与工具层认的契约。

- [ ] **Step 5: 写 `src/main/mcpHub.ts`**

```ts
// MCP hub —— 谁在连、谁连上了、谁挂了。对照 browserHub.ts / terminalHub.ts。
// **不 import SDK**：connect 以接口注入,测试喂假实现,状态机能测干净。

import { maskMcpConfig, type McpServerConfig, type McpServerStatus, type McpStatus } from "../shared/mcp.js";
import { McpAuthRequiredError, type McpClientConn } from "./mcpClient.js";
import type { McpCapability, McpServerHandle } from "../world/executionWorld.js";

export type McpConnect = (id: string, cfg: McpServerConfig) => Promise<McpClientConn>;

export interface McpHub extends McpCapability {
  /** 过桥给渲染层：配置已遮罩 */
  list(): McpServerStatus[];
  save(id: string, cfg: McpServerConfig): Promise<void>;
  remove(id: string): Promise<void>;
  reconnect(id: string): Promise<void>;
  onChange(cb: () => void): () => void;
  closeAll(): Promise<void>;
}

interface Entry {
  cfg: McpServerConfig;
  status: McpStatus;
  error?: string;
  conn?: McpClientConn;
}

export function createMcpHub(opts: {
  load(): { servers: Record<string, McpServerConfig>; errors: string[] };
  save(servers: Record<string, McpServerConfig>): void;
  connect: McpConnect;
}): McpHub {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let readying: Promise<void> | null = null;

  const emit = () => { for (const cb of listeners) cb(); };

  /** 从磁盘同步一次清单：新增的进来，删掉的关连接。已在的保留连接状态 */
  function syncFromDisk(): void {
    const { servers } = opts.load();
    for (const [id, cfg] of Object.entries(servers)) {
      const cur = entries.get(id);
      if (!cur) {
        // 未连接的初始态一律记 failed —— McpStatus 只有四态，"没连过"和"停用"
        // 都归在这里，区别写进 error 那句人话里给 UI 显示
        entries.set(id, { cfg, status: "failed", error: cfg.enabled ? "还没连过" : "已停用" });
      } else {
        cur.cfg = cfg;
      }
    }
    for (const id of [...entries.keys()]) {
      if (!(id in servers)) {
        void entries.get(id)?.conn?.close();
        entries.delete(id);
      }
    }
  }

  async function connectOne(id: string): Promise<void> {
    const e = entries.get(id);
    if (!e || !e.cfg.enabled || e.status === "connected") return;
    e.status = "connecting";
    delete e.error;
    emit();
    try {
      const conn = await opts.connect(id, e.cfg);
      // list_changed：server 说清单变了,重拉一次再推 UI。
      // 重拉失败不改状态 —— 连接还活着,只是这次没拉到
      conn.onListChanged(() => {
        void (async () => {
          await (conn as { refresh?: () => Promise<void> }).refresh?.();
          emit();
        })();
      });
      e.conn = conn;
      e.status = "connected";
    } catch (err) {
      e.status = err instanceof McpAuthRequiredError ? "needs-auth" : "failed";
      e.error = err instanceof Error ? err.message : String(err);
    }
    emit();
  }

  function handleOf(id: string, e: Entry): McpServerHandle {
    const live = e.status === "connected" && !!e.conn;
    return {
      id,
      name: id,
      status: e.status,
      live,
      tools: live ? e.conn!.tools : [],
      resources: live ? e.conn!.resources : [],
      prompts: live ? e.conn!.prompts : [],
    };
  }

  function liveConn(id: string): McpClientConn {
    const e = entries.get(id);
    if (!e?.conn || e.status !== "connected") {
      throw new Error(`MCP server「${id}」当前没连上（状态：${e?.status ?? "不存在"}）`);
    }
    return e.conn;
  }

  return {
    async ready() {
      // 并发调只连一次；连完清空,下次 ready() 会重试 failed 的那些
      // ——用户可能刚把 npx 装上,或者刚把网连回来
      if (readying) return readying;
      readying = (async () => {
        syncFromDisk();
        await Promise.all([...entries.keys()].map((id) => connectOne(id)));
      })().finally(() => { readying = null; });
      return readying;
    },

    servers: () => [...entries.entries()].map(([id, e]) => handleOf(id, e)),

    callTool: (id, tool, args, signal) => liveConn(id).callTool(tool, args, signal),
    readResource: (id, uri, signal) => liveConn(id).readResource(uri, signal),
    getPrompt: (id, name, args) => liveConn(id).getPrompt(name, args),

    list: () =>
      [...entries.entries()].map(([id, e]) => {
        const h = handleOf(id, e);
        return {
          id,
          status: e.status,
          ...(e.error !== undefined ? { error: e.error } : {}),
          // 凭据永不过桥（同 ADR-0044 的口径）
          config: maskMcpConfig(e.cfg),
          tools: [...h.tools],
          resources: [...h.resources],
          prompts: [...h.prompts],
        };
      }),

    async save(id, cfg) {
      syncFromDisk();
      const next = Object.fromEntries([...entries.entries()].map(([k, e]) => [k, e.cfg]));
      next[id] = cfg;
      opts.save(next);
      // 配置变了就断开重连 —— 旧连接用的是旧 env/url,留着只会骗人
      const cur = entries.get(id);
      if (cur?.conn) await cur.conn.close();
      entries.set(id, { cfg, status: "failed", error: "还没连过" });
      await connectOne(id);
    },

    async remove(id) {
      syncFromDisk();
      const cur = entries.get(id);
      if (cur?.conn) await cur.conn.close();
      entries.delete(id);
      opts.save(Object.fromEntries([...entries.entries()].map(([k, e]) => [k, e.cfg])));
      emit();
    },

    async reconnect(id) {
      const cur = entries.get(id);
      if (cur?.conn) await cur.conn.close();
      if (cur) { delete cur.conn; cur.status = "failed"; }
      await connectOne(id);
    },

    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    async closeAll() {
      await Promise.all([...entries.values()].map((e) => e.conn?.close()));
      for (const e of entries.values()) { delete e.conn; e.status = "failed"; }
    },
  };
}
```

- [ ] **Step 6: 跑测试确认它通过**

```bash
cd ../Mr_Otto-mcp && npx vitest run tests/main/mcpHub.test.ts && npx tsc --noEmit
```

Expected: PASS（16 个 it 全绿）+ tsc 无错

- [ ] **Step 7: 跑全量门禁并提交**

```bash
cd ../Mr_Otto-mcp && npm test
git add package.json package-lock.json src/main/mcpClient.ts src/main/mcpHub.ts tests/main/mcpHub.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): SDK 客户端 + 连接状态机

SDK 只允许 mcpClient.ts 一个文件 import。理由有两条：依赖树上多一棵
树是有成本的，将来换实现只动这一处；而且 mcpHub 因此完全不碰 SDK，
状态机能用假 connect 测干净，不起真进程。

401 映射成 needs-auth 而不是 failed —— 对用户是两件完全不同的事：
一个是"你去点一下授权"，一个是"这台坏了"。

一台连不上不拖垮 ready()：并发连，各自记各自的状态。failed 的下次
ready() 会重试 —— 用户可能刚把 npx 装上。

list() 过桥的配置里 env/headers 是遮罩过的，真值不出主进程（ADR-0044）。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: 接进 agent 与 Electron

**Files:**
- Modify: `src/main/agent.ts`
- Modify: `src/main/index.ts`
- Modify: `src/shared/shellBridge.ts`
- Modify: `src/preload/index.ts`
- Test: `tests/main/agent.test.ts`（加一个 describe）

**Interfaces:**
- Consumes: `createMcpTools`（Task 4）、`createMcpReadResourceTool`（Task 5）、`createMcpHub` / `McpHub`（Task 6）、`withMcp`（Task 3）
- Produces: `createAgent` 多一个可选参数 `mcp?: McpCapability`；`ShellBridge` 多 7 个方法

- [ ] **Step 1: 写失败的测试**

在 `tests/main/agent.test.ts` 末尾追加。本文件既有的装配写法是把参数直接内联
（`createAgent({ store, workspace, push, attachments })`），沿用它；工具名从
**已有的** `agent.toolDefs` 取（`src/main/agent.ts:330`），不需要新增 API。

```ts
describe("MCP 接进装配", () => {
  const cap = (live = true) => ({
    ready: vi.fn(async () => {}),
    servers: () => [{
      id: "gh", name: "gh", status: (live ? "connected" : "failed") as const, live,
      tools: live ? [{ name: "create_pr", description: "开 PR", inputSchema: {} }] : [],
      resources: [], prompts: [],
    }],
    callTool: async () => [{ kind: "text" as const, text: "ok" }],
    readResource: async () => [],
    getPrompt: async () => "",
  });

  const names = (a: { toolDefs: { name: string }[] }) => a.toolDefs.map((d) => d.name);

  it("给了 mcp，工具表里出现 mcp__gh__create_pr", () => {
    const store = new EventStore(":memory:");
    const agent = createAgent({ store, workspace: "/proj/x", push, attachments, mcp: cap() });
    expect(names(agent)).toContain("mcp__gh__create_pr");
    store.close();
  });

  it("同时挂上 mcp_read_resource", () => {
    const store = new EventStore(":memory:");
    const agent = createAgent({ store, workspace: "/proj/x", push, attachments, mcp: cap() });
    expect(names(agent)).toContain("mcp_read_resource");
    store.close();
  });

  it("装配时叫过 ready() —— 不等就拿不到清单", async () => {
    const store = new EventStore(":memory:");
    const m = cap();
    createAgent({ store, workspace: "/proj/x", push, attachments, mcp: m });
    await vi.waitFor(() => expect(m.ready).toHaveBeenCalled());
    store.close();
  });

  it("装配时那台没连上 = 一把 mcp 工具都不出（没清单无从挂起）", () => {
    const store = new EventStore(":memory:");
    const agent = createAgent({ store, workspace: "/proj/x", push, attachments, mcp: cap(false) });
    expect(names(agent).some((n) => n.startsWith("mcp__"))).toBe(false);
    store.close();
  });

  it("不给 mcp，工具表一字不变（裸装配照旧）", () => {
    const store = new EventStore(":memory:");
    const agent = createAgent({ store, workspace: "/proj/x", push, attachments });
    expect(names(agent).some((n) => n.startsWith("mcp"))).toBe(false);
    store.close();
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
cd ../Mr_Otto-mcp && npx vitest run tests/main/agent.test.ts
```

Expected: FAIL

- [ ] **Step 3: 改 `src/main/agent.ts`**

顶部加 import：

```ts
import { createMcpTools } from "../tools/mcpTool.js";
import { createMcpReadResourceTool } from "../tools/mcpReadResource.js";
import { withMcp, type McpCapability } from "../world/executionWorld.js";
```

`createAgent` 的参数对象里，`makeBrowser` 之后加：

```ts
  /** MCP 能力（index.ts 从 mcpHub 注入）。hub 要管子进程生命周期、要向渲染层推状态，
      LocalWorld 造不出来 —— 同 makeBrowser 的注入方向（ADR-0035）。
      不给 = 这个装配没有 MCP（测试和裸装配照旧） */
  mcp?: McpCapability;
```

world 组装那两行改成：

```ts
  const withB = opts.makeBrowser ? withBrowser(base, opts.makeBrowser(sessionId)) : base;
  const world = opts.mcp ? withMcp(withB, opts.mcp) : withB;
```

工具表拼装（`agent.ts:277` 那个 `const tools`）改成：先等 ready，再展开。因为 `createAgent` 是同步函数，`ready()` 不能直接 await —— 改法：

```ts
  // 工具表是一次性拼好的（挂载一次定终身，见 tool.ts 的注释），
  // 拼之前必须已经知道每台 server 提供了什么。createAgent 是同步的，
  // 所以 ready() 在 index.ts 里、造 agent 之前就 await 过了；
  // 这里再叫一次是幂等的兜底（并发调只连一次，见 mcpHub）
  void opts.mcp?.ready();

  const tools: Tool[] = [
    // ...既有的那一串保持原样
    ...(opts.mcp ? createMcpTools(opts.mcp) : []),
    ...(opts.mcp ? [createMcpReadResourceTool(opts.mcp)] : []),
  ];
```

返回对象**不用改**：`toolDefs`（`agent.ts:330`）已经把工具声明暴露出去了，测试从它取名字。

> **注意 `mcp_read_resource` 的 `description` 是 getter**：`toolDefs: tools.map(t => t.def)`
> 拿到的是同一个 `def` 对象，getter 原样留着；`engine.ts:211` 每轮重新 map 时才求值，
> 所以清单是活的（server 增删都能反映出来）。别在这里 `structuredClone` 或展开成新对象，
> 那会把 getter 拍成拼装那一刻的死字符串。

- [ ] **Step 4: 改 `src/shared/shellBridge.ts`**

顶部加 import：

```ts
import type { McpPromptInfo, McpServerConfig, McpServerStatus } from "./mcp.js";
```

并 re-export（与 `TerminalInfo` 同一行做法）：

```ts
export type { McpPromptInfo, McpServerConfig, McpServerStatus };
```

在 `listSkills()` 之后加方法：

```ts
  /** MCP server 清单 + 各自状态。配置里的 env/headers 已遮罩（真值不出主进程） */
  listMcpServers(): Promise<McpServerStatus[]>;
  /** 存一台 server 的配置并立刻重连它。返回全量刷新后的清单 ——
      存完立刻拿到最新镜像，不用再补一次 refresh */
  saveMcpServer(id: string, cfg: McpServerConfig): Promise<McpServerStatus[]>;
  removeMcpServer(id: string): Promise<McpServerStatus[]>;
  /** 手动重连（failed 的那台，用户修好环境后自己点） */
  reconnectMcpServer(id: string): Promise<McpServerStatus[]>;
  /** 所有连上的 server 的 prompt 合起来（composer 的斜杠面用） */
  listMcpPrompts(): Promise<(McpPromptInfo & { server: string })[]>;
  /** 把一个 MCP prompt 按参数展开成文本，落进输入框。
      展开后就是普通用户消息，进 UserMessage 事件，重放零特殊化 */
  expandMcpPrompt(server: string, name: string, args: Record<string, string>): Promise<string>;
  /** hub 状态变了就推一次全量清单。返回退订函数（与其它订阅同构） */
  onMcpChanged(cb: (servers: McpServerStatus[]) => void): () => void;
```

在频道名常量表（`listSkills: "otter:listSkills",` 附近）加：

```ts
  listMcpServers: "otter:listMcpServers",
  saveMcpServer: "otter:saveMcpServer",
  removeMcpServer: "otter:removeMcpServer",
  reconnectMcpServer: "otter:reconnectMcpServer",
  listMcpPrompts: "otter:listMcpPrompts",
  expandMcpPrompt: "otter:expandMcpPrompt",
  mcpChanged: "otter:mcpChanged",
```

- [ ] **Step 5: 改 `src/main/index.ts`**

按本文件已有的 `browserHub` / `listSkills` 写法照抄。造 hub（在 app ready 之后、造 agent 之前）：

```ts
import { createMcpHub } from "./mcpHub.js";
import { connectMcpClient } from "./mcpClient.js";
import { loadMcpConfig, saveMcpConfig } from "./mcpConfig.js";

const mcpConfigPath = join(homedir(), ".otter", "mcp.json");
const mcpHub = createMcpHub({
  load: () => loadMcpConfig(mcpConfigPath),
  save: (servers) => saveMcpConfig(mcpConfigPath, servers),
  connect: connectMcpClient,
});
```

造 agent 处：先 `await mcpHub.ready()`，再把 hub 传下去：

```ts
await mcpHub.ready();
const agent = createAgent({ /* ...既有 */, mcp: mcpHub });
```

注册 IPC（照本文件既有的 `ipcMain.handle` 写法）：

```ts
ipcMain.handle(CH.listMcpServers, () => mcpHub.list());
ipcMain.handle(CH.saveMcpServer, async (_e, id: string, cfg: McpServerConfig) => {
  await mcpHub.save(id, cfg);
  return mcpHub.list();
});
ipcMain.handle(CH.removeMcpServer, async (_e, id: string) => {
  await mcpHub.remove(id);
  return mcpHub.list();
});
ipcMain.handle(CH.reconnectMcpServer, async (_e, id: string) => {
  await mcpHub.reconnect(id);
  return mcpHub.list();
});
ipcMain.handle(CH.listMcpPrompts, () =>
  mcpHub.servers().filter((s) => s.live).flatMap((s) => s.prompts.map((p) => ({ ...p, server: s.name })))
);
ipcMain.handle(CH.expandMcpPrompt, (_e, server: string, name: string, args: Record<string, string>) => {
  const hit = mcpHub.servers().find((s) => s.live && s.name === server);
  if (!hit) throw new Error(`没有连上名叫「${server}」的 MCP server`);
  return mcpHub.getPrompt(hit.id, name, args);
});

// hub 状态变了推给渲染层（照 rendererPush 既有做法）
mcpHub.onChange(() => { pushToRenderer(CH.mcpChanged, mcpHub.list()); });

// 退出时关掉所有连接，stdio 子进程跟着走
app.on("before-quit", () => { void mcpHub.closeAll(); });
```

- [ ] **Step 6: 改 `src/preload/index.ts`**

在 `listSkills:` 那一行（`preload/index.ts:26`）附近加六个 invoke：

```ts
  listMcpServers: () => ipcRenderer.invoke(CHANNELS.listMcpServers),
  saveMcpServer: (id: string, cfg: unknown) => ipcRenderer.invoke(CHANNELS.saveMcpServer, id, cfg),
  removeMcpServer: (id: string) => ipcRenderer.invoke(CHANNELS.removeMcpServer, id),
  reconnectMcpServer: (id: string) => ipcRenderer.invoke(CHANNELS.reconnectMcpServer, id),
  listMcpPrompts: () => ipcRenderer.invoke(CHANNELS.listMcpPrompts),
  expandMcpPrompt: (server: string, name: string, args: Record<string, string>) =>
    ipcRenderer.invoke(CHANNELS.expandMcpPrompt, server, name, args),
```

在订阅那一段（`onEvent: subscribe(...)` 那一串，`preload/index.ts:79` 起）加一行：

```ts
  onMcpChanged: subscribe(CHANNELS.mcpChanged),
```

- [ ] **Step 7: 跑测试 + 类型检查**

```bash
cd ../Mr_Otto-mcp && npx vitest run tests/main/agent.test.ts && npx tsc --noEmit && npm test
```

Expected: 全绿

- [ ] **Step 8: 真机验证**

```bash
cd ../Mr_Otto-mcp
cat > ~/.otter/mcp.json <<'JSON'
{ "mcpServers": { "everything": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"] } } }
JSON
npm run dev
```

在会话里让模型调 `mcp__everything__echo`，确认：审批卡弹出 → 批准 → 拿到结果 → 事件日志里是普通的 `tool_execution_started` + `tool_result`。

- [ ] **Step 9: 提交**

```bash
cd ../Mr_Otto-mcp
git add src/main/agent.ts src/main/index.ts src/shared/shellBridge.ts src/preload/index.ts tests/main/agent.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): 接进 agent 装配与 Electron 主进程

hub 在造 agent 之前 await ready()：工具表是一次性拼好的（挂载一次
定终身），拼的时候必须已经知道每台 server 提供了什么。createAgent
本身是同步的，所以那里的 ready() 只是幂等兜底。

冷启动不连，会话装配时才连 —— 不该让 5 个 npx 拖住启动。

桥上七个方法：三个写操作都返回全量刷新后的清单，存完立刻拿到最新镜像。
配置里的 env/headers 过桥前已遮罩。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Phase 2 —— UI 与协议（Task 8–11）

> **开始前必做**：确认 Subagent（issue #129）的 PR 已合进 `main`，然后
> ```bash
> cd ../Mr_Otto-mcp && git fetch origin && git merge origin/main
> ```
> 否则 Task 8 会与那条 lane 在 `store.ts` / `App.tsx` 的同一行上撞车。

## Task 8: 贴入两个 element + 设置页 MCP 栏目

**Files:**
- Create: `src/renderer/src/components/elements/mcp-server-panel.tsx`（`shadcn add` 生成后手改）
- Create: `src/renderer/src/components/McpSettings.tsx`
- Modify: `src/renderer/src/store.ts`
- Modify: `src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: `listMcpServers` / `saveMcpServer` / `removeMcpServer` / `reconnectMcpServer` / `onMcpChanged`（Task 7）
- Produces: `McpSettings` 组件；store 上的 `mcpServers` / `refreshMcpServers()` / `saveMcpServer()` / `removeMcpServer()` / `reconnectMcpServer()`

- [ ] **Step 1: 贴入上游 element**

```bash
cd ../Mr_Otto-mcp && npx shadcn@latest add @assistant-ui/elements-mcp-server-panel
```

- [ ] **Step 2: 手改 import（贴入后必做，与仓里已有 31 个 element 同样的改法）**

在 `src/renderer/src/components/elements/mcp-server-panel.tsx` 里：
- `from "./surfaces"` → `from "@/lib/surfaces.js"`
- `from "@/lib/utils"` → `from "@/lib/utils.js"`

```bash
cd ../Mr_Otto-mcp && npx tsc --noEmit
```

Expected: 无错

- [ ] **Step 3: store 加状态与 action**

`src/renderer/src/store.ts`：

```ts
// SettingsSection 那一行 union 加 "mcp"
export type SettingsSection = "account" | "keys" | "appearance" | "skills" | "mcp";

// ChatState 里加
  /** 本机配置的 MCP server + 各自状态（进栏目时刷一次，之后由主进程推）。
      配置里的 env/headers 是遮罩过的 —— 渲染层拿不到凭据真值 */
  mcpServers: McpServerStatus[];

  refreshMcpServers(): Promise<void>;
  /** 三个写操作都直接返回全量重刷后的清单，组件不用再补一次 refresh */
  saveMcpServer(id: string, cfg: McpServerConfig): Promise<void>;
  removeMcpServer(id: string): Promise<void>;
  reconnectMcpServer(id: string): Promise<void>;
```

实现照 `refreshWallet` / `skills` 的既有写法；并在 boot 里订阅 `onMcpChanged`，回调里 `set({ mcpServers })`。

- [ ] **Step 4: 写 `McpSettings.tsx`**

骨架复用 `App.tsx` 导出的 `MAIN_COL` / `HEADER` / `SETTINGS_BODY` / `HINT`（另一条 lane 已把它们导出）。主体：

```tsx
<McpServerPanel
  servers={mcpServers.map((s) => ({
    id: s.id,
    name: s.id,
    transport: s.config.kind === "stdio" ? "stdio" : "streamable-http",
    status: s.status,
    tools: s.tools.map((t) => t.name),
  }))}
  expandedId={expandedId}
  onToggle={setExpandedId}
  onAuthorize={(id) => void reconnectMcpServer(id)}
/>
```

展开的那台下面挂 `SpecSheet`（transport / command 或 url / env 键名 + 遮罩值）与 `DataTable`（tools 与 resources 清单）。底下一行提示文案：

> 新增或删除 server 需要重开会话才生效。装配时没连上的 server，它的工具这一整个会话都不存在。

- [ ] **Step 5: App.tsx 接线**

```tsx
// SETTINGS_SECTIONS 数组里加
{ id: "mcp", label: "MCP" },

// 路由分支里加
) : settingsSection === "mcp" ? (
  <McpSettings />
```

- [ ] **Step 6: 门禁 + 真机验证**

```bash
cd ../Mr_Otto-mcp && npm test && npx tsc --noEmit && npm run dev
```

进设置页 → MCP 栏目：确认状态灯、展开、增删改、断了能重连。

- [ ] **Step 7: 提交**

```bash
cd ../Mr_Otto-mcp
git add src/renderer/src/components/elements/mcp-server-panel.tsx src/renderer/src/components/McpSettings.tsx src/renderer/src/store.ts src/renderer/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(mcp): 设置页 MCP 栏目

主体直接用上游的 mcp-server-panel —— 它本来就是为 MCP 画的：
transport 字段正好是 stdio/streamable-http，needs-auth 那一态自带
Authorize 钮。贴入后按仓里既有 31 个 element 同样的改法修 import。

展开的那台挂 SpecSheet + DataTable（都是仓里已有的），不再新造组件。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: MCP prompt 进 composer 斜杠面

**Files:**
- Create: `src/renderer/src/components/elements/prompt-library.tsx`（`shadcn add` 后手改）
- Modify: `src/renderer/src/components/assistant-ui/composer-trigger-popover.tsx`
- Modify: `src/renderer/src/store.ts`

**Interfaces:**
- Consumes: `listMcpPrompts` / `expandMcpPrompt`（Task 7）
- Produces: store 上的 `mcpPrompts` / `refreshMcpPrompts()` / `insertMcpPrompt(server, name, args)`

- [ ] **Step 1: 贴入 element 并手改 import**

```bash
cd ../Mr_Otto-mcp && npx shadcn@latest add @assistant-ui/elements-prompt-library
```

同 Task 8 Step 2 的改法（`./surfaces` → `@/lib/surfaces.js`，补 `.js`）。

- [ ] **Step 2: store 加状态**

```ts
  /** 连上的 server 提供的 prompt（打开斜杠面时刷一次） */
  mcpPrompts: (McpPromptInfo & { server: string })[];
  refreshMcpPrompts(): Promise<void>;
  /** 按参数展开成文本。展开后就是普通用户消息，进 UserMessage 事件，重放零特殊化 */
  insertMcpPrompt(server: string, name: string, args: Record<string, string>): Promise<string>;
```

- [ ] **Step 3: 接进斜杠面**

在 `composer-trigger-popover.tsx` 的命令列表里，内置命令之后追加一组 "MCP"，每项映射成 `SavedPrompt`：

```ts
{ id: `${p.server}/${p.name}`, name: `${p.server}:${p.name}`, body: p.description ?? "", variables: p.arguments.map((a) => a.name) }
```

选中带参数的项时先弹参数表单（复用 `ElicitationForm`，它的 `fields` 形状正好对得上 `arguments`），填完调 `insertMcpPrompt`，把返回的文本落进输入框。

- [ ] **Step 4: 门禁 + 真机验证**

```bash
cd ../Mr_Otto-mcp && npm test && npx tsc --noEmit && npm run dev
```

敲 `/`，确认 MCP 那一组出现；选一个带参数的，填完参数文本落进输入框。

- [ ] **Step 5: 提交**

```bash
cd ../Mr_Otto-mcp
git add src/renderer/src/components/elements/prompt-library.tsx src/renderer/src/components/assistant-ui/composer-trigger-popover.tsx src/renderer/src/store.ts
git commit -m "$(cat <<'EOF'
feat(mcp): MCP prompt 进 composer 斜杠面

不走 skill 注入面（ADR-0007）：MCP prompt 带参数，skill 是无参数的
纯文本包，硬塞进去会丢掉参数这一层。走斜杠面则能先填参数再展开。

展开后就是普通用户消息，进 UserMessage 事件，不新增事件类型，
重放零特殊化。

参数表单复用已有的 ElicitationForm —— 它的 fields 形状正好对得上
MCP 的 arguments。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: 审批预览 + 凭据遮罩

**Files:**
- Modify: `src/main/approvalPreview.ts`
- Test: `tests/main/approvalPreview.test.ts`

**Interfaces:**
- Consumes: `buildApprovalPreview(call, world)` 既有签名
- Produces: MCP 工具的预览分支

- [ ] **Step 1: 写失败的测试**

在 `tests/main/approvalPreview.test.ts` 末尾追加：

```ts
describe("MCP 工具的审批预览", () => {
  it("显示 server 名与工具名", async () => {
    const p = await buildApprovalPreview(
      { id: "c1", name: "mcp__github__create_pr", args: { title: "x" } } as never,
      bareWorld
    );
    expect(JSON.stringify(p)).toContain("github");
    expect(JSON.stringify(p)).toContain("create_pr");
  });

  it("参数里疑似凭据的字段显示遮罩 —— 审批卡也是一块屏，凭据不该整串亮出来", async () => {
    const p = await buildApprovalPreview(
      { id: "c1", name: "mcp__x__y", args: { token: "ghp_abcdefghijklmnop", title: "正常" } } as never,
      bareWorld
    );
    const s = JSON.stringify(p);
    expect(s).not.toContain("ghp_abcdefghijklmnop");
    expect(s).toContain("正常");
  });

  it("键名带 secret / password / api_key 的一样遮", async () => {
    const p = await buildApprovalPreview(
      { id: "c1", name: "mcp__x__y", args: { apiKey: "sk-1234567890abcdef", myPassword: "hunter22222" } } as never,
      bareWorld
    );
    const s = JSON.stringify(p);
    expect(s).not.toContain("sk-1234567890abcdef");
    expect(s).not.toContain("hunter22222");
  });

  it("非 MCP 工具的预览一字不变（回归）", async () => {
    const p = await buildApprovalPreview({ id: "c1", name: "bash", args: { cmd: "ls" } } as never, bareWorld);
    expect(JSON.stringify(p)).toContain("ls");
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
cd ../Mr_Otto-mcp && npx vitest run tests/main/approvalPreview.test.ts
```

- [ ] **Step 3: 实现**

在 `src/main/approvalPreview.ts` 里加：

```ts
import { maskKey } from "../shared/keyMask.js";

/** 审批卡也是一块屏 —— 参数里的凭据不该整串亮出来。
    按键名判断:这是启发式,漏判的代价是多显示一串(卡是给人看的,不进日志),
    误判的代价是少显示一串 —— 两边都不致命,所以宁可多遮 */
const SECRET_KEY = /token|secret|password|passwd|api[-_]?key|credential|authorization/i;

function maskArgs(args: unknown): unknown {
  if (Array.isArray(args)) return args.map(maskArgs);
  if (args && typeof args === "object") {
    return Object.fromEntries(
      Object.entries(args as Record<string, unknown>).map(([k, v]) =>
        SECRET_KEY.test(k) && typeof v === "string" ? [k, maskKey(v)] : [k, maskArgs(v)]
      )
    );
  }
  return args;
}
```

并在 `buildApprovalPreview` 顶部加一支：工具名以 `mcp__` 开头时，拆出 server 与 tool，返回带这两项 + `maskArgs(call.args)` 的预览。

- [ ] **Step 4: 跑测试 + 门禁 + 提交**

```bash
cd ../Mr_Otto-mcp && npx vitest run tests/main/approvalPreview.test.ts && npm test
git add src/main/approvalPreview.ts tests/main/approvalPreview.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): 审批卡显示 server + 工具名，参数里的凭据遮罩

按键名判断是不是凭据，这是启发式：漏判的代价是多显示一串（卡是给人
看的，不进日志），误判的代价是少显示一串 —— 两边都不致命，所以宁可多遮。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: 两篇 ADR + 改 AGENTS.md（**L1，需维护者同意**）

**Files:**
- Create: `docs/adr/0047-mcp-进入范围.md`
- Create: `docs/adr/0048-mcp-骑在-world-接缝上.md`
- Modify: `AGENTS.md`
- Modify: `CONTEXT.md`

> **编号在合并时认领**（ADR-0048 并行 lane 条款）。0046 被 Subagent 那条 lane 占着。
> 合并前 `git fetch origin`；若有别的协议 PR 先落地，在本 PR 内重编号并重算版本号。

- [ ] **Step 1: 写 `docs/adr/0047-mcp-进入范围.md`**

照本仓 ADR 格式（`# ADR-00XX: 标题` / 日期状态 / 背景 / 决定 / 理由 / 代价）。要点：

- 背景：`AGENTS.md` 原文把 MCP 列在「明确不做」里；那条边界是为了守住 MVP，不是判定 MCP 有害
- 决定：v1.x 做 **MCP client**（不做 server）；tools / resources / prompts 三样都接
- 「不做插件系统」为何仍成立：MCP server 是跨进程外部程序，走标准协议对话，**不向 Otto 进程注入任何代码**。与 skill（纯提示词注入，ADR-0007）是同一种克制的两种形态 —— 可执行扩展面在进程外，不在进程内
- 本版不做：sampling（server 反过来花你的钱，授权模型要单独设计）、roots、完整 OAuth
- 代价：多一棵依赖树（锁在 `mcpClient.ts` 一个文件里）；冷启动之后的首个会话装配会多等一次连接

- [ ] **Step 2: 写 `docs/adr/0048-mcp-骑在-world-接缝上.md`**

要点：

- 这是同一句话的第四次复述（ADR-0008 http / ADR-0031 terminal / ADR-0035 browser）
- 被否掉的两条路，写清为什么：**闭包注入 client 进工具层**（stdio 要 spawn，破硬规则，v2 容器化时那条线得重写）；**单个通用 `mcp_call` 工具**（模型看不见工具描述等于盲选，而 MCP 生态的价值大半在 schema 上）
- 两个装饰器是逐字段枚举重建 world 的，新增能力必须手工补透传 —— 已加回归测试
- 什么前提被推翻会掀掉这个决定：如果 v2 决定 MCP server 一律跑在宿主机而不进容器，那接缝就没必要了

- [ ] **Step 3: 改 `AGENTS.md`（两处，L1）**

第一段的范围声明：

```
明确不做：多 agent 编排、插件系统（skill 库是纯提示词注入，不算插件系统，见 docs/adr/0007）。
MCP 做 client 那一半（接外部 server 的 tools/resources/prompts，见 docs/adr/0047），不做 server。
```

Tech stack 那一节加一行：

```
`@modelcontextprotocol/sdk`（MCP 客户端；只允许 `src/main/mcpClient.ts` import，见 docs/adr/0048）
```

- [ ] **Step 4: 改 `CONTEXT.md`**

加四条词条：`MCP`、`MCP server`、`transport（stdio / streamable-http）`、`elicitation`。

- [ ] **Step 5: 门禁 + 提交 + 开 PR**

```bash
cd ../Mr_Otto-mcp && npm test
git add docs/adr/0047-mcp-进入范围.md docs/adr/0048-mcp-骑在-world-接缝上.md AGENTS.md CONTEXT.md
git commit -m "$(cat <<'EOF'
docs(mcp): ADR-0047/0048 + AGENTS.md 范围声明与 Tech stack（L1）

范围声明从「明确不做 MCP」改为「做 client 那一半，不做 server」。
「不做插件系统」保持不变：MCP server 是跨进程外部程序，走标准协议
对话，不向 Otto 进程注入任何代码。

Tech stack 加 @modelcontextprotocol/sdk，并写明只允许 mcpClient.ts
一个文件 import。

两处都是 L1（ADR-0006/0012），合并前需要 stanyan 在 PR 评论里同意。

Closes #132

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
git push
gh pr create --title "feat(mcp): 接 MCP 服务器 —— tools / resources / prompts" --body "实现 docs/superpowers/specs/2026-08-21-mcp-design.md。Closes #132。

**这是 L1 协议改动**（改 AGENTS.md 的范围声明 + Tech stack），需要 @stanyan 在本 PR 评论里明确写「同意」才能合并（ADR-0006 / ADR-0034）。

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01RQkCFf8XK3GwqsPQ9HSxae"
```

- [ ] **Step 6: 等维护者同意后合并（merge commit，不 squash 不 rebase）**

```bash
cd ../Mr_Otto-mcp && gh pr merge --merge
```

---

## 收尾（shift-end，AGENTS.md 要求）

- [ ] 门禁全绿
- [ ] commit + push
- [ ] 关掉 #132
- [ ] 开一个 handoff issue（Task 型，保持 open），正文写当前状态 + 下一步建议，本班 Memory 用五段式评论落在里面
- [ ] `node scripts/gearbox-prune`
- [ ] 删掉 worktree：`git worktree remove ../Mr_Otto-mcp`
