# MCP 连接器目录页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 MCP 设置页上方加一张可浏览、可搜索、点一下就装上的连接器目录页——上面是仓内人工策展的精选层（零网络），下面是 `registry.modelcontextprotocol.io` 公开注册表的搜索长尾（标注未核验）。

**Architecture:** 一层纯映射（`src/shared/mcpRegistry.ts`，把注册表 JSON 折成仓内既有的 `CatalogEntry`）+ 一层主进程取数（`src/main/mcpRegistry.ts`，唯一打注册表的地方）+ 一层 UI（`McpDirectory.tsx`，挂在 `McpSettings` 上方）。水獭那侧的 `mcp_catalog` 工具经 `world.http.getJson` 走同一个映射层。

**Tech Stack:** TypeScript strict / React + Zustand / vitest / Electron IPC（ShellBridge）

**Spec:** `docs/superpowers/specs/2026-08-28-mcp-connector-directory-design.md`

**Issue:** [#661](https://github.com/real-stanyan/Mr-Otto/issues/661)

## Global Constraints

- **`src/shared/` 不碰 node builtin / electron**——手机端 Expo/RN 直接 import 同一份源码（`tests/architecture.test.ts` 第 5 条）。映射层只用纯 JS。
- **工具实现只依赖 `ExecutionWorld`**，禁止直接 import fs / child_process，禁止直接 `fetch`（AGENTS.md Hard rules，`tests/architecture.test.ts` 第 1 条）。`src/tools/` 目前零处 `fetch(`，不要破例。
- **渲染进程只通过 `ShellBridge` 与后端通信**，禁止直接触碰 Node API（Hard rule）。渲染进程不得出现指向注册表或任意第三方的 `fetch` / `<img src>`。
- **注册表基址**：`https://registry.modelcontextprotocol.io`，搜索路径 `/v0/servers?search=<q>&limit=50`。
- **`isLatest` 过滤路径**：`record._meta["io.modelcontextprotocol.registry/official"].isLatest === true`。这个 `_meta` 键名是字符串字面量，一字不能改。
- **门禁**：`npm test`（`tsc --noEmit` + `vitest run`）。内循环用 `npx vitest --watch`。
- **测试放 `tests/`**，镜像 `src/` 结构，不与源码同目录。
- **不打真网的测试**：所有单测喂固定 JSON，不发请求。真打注册表的验证不进门禁。
- ADR 编号在合并前认领（项目 ADR-0074）。当前 `docs/adr/` 最大号是 **0161**。

## 与 spec 的两处细化

写计划时读代码读出来的，两处都比 spec 原文更省：

1. **`world.http.getJson` 是可选字段（`getJson?`），不是必填**。spec 4.5 没说必填与否。仓里有 35 处测试假 world 写着 `http: { postJson: async () => ({}) }`，必填会让它们全红——而这些红跟本功能毫无关系。仓内已有先例：`execDetached?` / `openTerminal?` / `browser?` / `simulator?` 都是可选，理由原文写着「可选 = 向后兼容（假 world 零改动）」。照抄这个先例，工具侧检查缺席并给一句人话。
2. **不做远程图标代理**。spec 4.4 原方案是「有 `icons` 的由主进程代下」。但只有 7% 的注册表条目有图标，为这 7% 造一条下载 + 缓存 + 失败兜底的链路不划算。改成：**长尾层一律首字母色块**（本来 93% 就走这条），**精选层用打进包的本地 SVG**。零远程图片、零代理子系统，安全边界从「代理后可控」收紧成「压根不出网」。

## File Structure

| 文件 | 责任 | 任务 |
|---|---|---|
| `src/shared/mcpRegistry.ts` | 创建。注册表 JSON → `CatalogEntry[]` 的纯映射。零依赖、零 IO | 1 |
| `tests/shared/mcpRegistry.test.ts` | 创建。映射层单测，喂内联固定 JSON | 1 |
| `tests/fixtures/mcpRegistry.sample.json` | 创建。一份真实注册表响应，只做"不炸 + 形状没变"的冒烟 | 1 |
| `src/world/executionWorld.ts` | 修改。`http` 上加可选 `getJson`；两个装饰器透传 | 2 |
| `src/world/localWorld.ts` | 修改。`getJson` 实现，镜像 `postJson` | 2 |
| `tests/world/localWorld.test.ts` | 修改。`getJson` 的用例 | 2 |
| `src/main/mcpRegistry.ts` | 创建。唯一打注册表的地方 | 3 |
| `src/shared/shellBridge.ts` | 修改。`searchMcpRegistry` 方法 + channel | 3 |
| `src/main/index.ts` | 修改。ipcMain handler | 3 |
| `src/preload/index.ts` | 修改。桥接一行 | 3 |
| `src/renderer/src/store.ts` | 修改。store action | 3 |
| `src/shared/mcpCatalog.ts` | 修改。加 `icon?` 字段；精选层扩到 ~20 条 | 4 |
| `tests/shared/mcpCatalog.test.ts` | 修改。新条目照旧过既有断言 | 4 |
| `src/renderer/src/assets/mcp/*.svg` | 创建。精选层图标 | 4 |
| `src/renderer/src/lib/mcpDirectory.ts` | 创建。目录页纯逻辑（合并/排序/分组） | 5 |
| `tests/renderer/mcpDirectory.test.ts` | 创建 | 5 |
| `src/renderer/src/components/McpDirectory.tsx` | 创建。卡片网格 + 搜索框 + 安装流 | 5 |
| `src/renderer/src/components/McpSettings.tsx` | 修改。把目录页挂上去 | 5 |
| `src/tools/mcpCatalog.ts` | 修改。精选没命中回退注册表 | 6 |
| `tests/tools/mcpCatalog.test.ts` | 创建（当前不存在） | 6 |
| `docs/adr/0162-连接器目录分两层.md` | 创建 | 6 |

---

### Task 1: 注册表映射层（纯逻辑）

**Files:**
- Create: `src/shared/mcpRegistry.ts`
- Create: `tests/shared/mcpRegistry.test.ts`
- Create: `tests/fixtures/mcpRegistry.sample.json`

**Interfaces:**
- Consumes: `CatalogEntry` / `CatalogParam` from `src/shared/mcpCatalog.ts`（现有，不改）
- Produces:
  - `export function mapRegistryResponse(json: unknown): CatalogEntry[]`
  - `export function mapRegistryServer(record: unknown): CatalogEntry | null`
  - `export const REGISTRY_BASE = "https://registry.modelcontextprotocol.io"`
  - `export function registrySearchUrl(query: string, limit?: number): string`

现有的 `CatalogEntry`（`src/shared/mcpCatalog.ts:9-30`，本任务**不改它**）：

```ts
export interface CatalogParam {
  name: string;
  description: string;
  required: boolean;
}

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args?: readonly string[];
  params: readonly CatalogParam[];
  auth: "oauth" | "token" | "none";
  authNote: string;
}
```

- [ ] **Step 1: 抓一份真实的注册表响应当冒烟样本**

```bash
mkdir -p tests/fixtures
curl -sS -m 30 'https://registry.modelcontextprotocol.io/v0/servers?limit=30' \
  -o tests/fixtures/mcpRegistry.sample.json
python3 -c "import json;d=json.load(open('tests/fixtures/mcpRegistry.sample.json'));print(len(d['servers']),'条')"
```

这份样本只用来断言"真数据喂进去不抛、且至少映出一条"。**行为断言不靠它**——真数据会变，靠它会做出一个哪天注册表改内容就无故变红的测试。行为断言全部用 Step 2 的内联 JSON。

- [ ] **Step 2: 写失败的测试**

创建 `tests/shared/mcpRegistry.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  mapRegistryResponse,
  mapRegistryServer,
  registrySearchUrl,
} from "../../src/shared/mcpRegistry.js";

/** 一条 remote 形态的条目：带一把必填的 secret header */
const REMOTE_WITH_TOKEN = {
  server: {
    name: "ai.smithery/smithery-notion",
    title: "Notion",
    description: "A Notion workspace is a collaborative environment",
    version: "1.0.0",
    repository: { url: "https://github.com/smithery-ai/mcp-servers", source: "github" },
    remotes: [
      {
        type: "streamable-http",
        url: "https://server.smithery.ai/@smithery/notion/mcp",
        headers: [
          {
            name: "Authorization",
            value: "Bearer {smithery_api_key}",
            description: "Bearer token for Smithery authentication",
            isRequired: true,
            isSecret: true,
          },
        ],
      },
    ],
  },
  _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
};

/** 一条 remote 形态、无 header 的条目 */
const REMOTE_NO_AUTH = {
  server: {
    name: "com.example/plain",
    title: "Plain",
    description: "没有任何凭据要求",
    version: "2.0.0",
    remotes: [{ type: "streamable-http", url: "https://plain.example/mcp" }],
  },
  _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true } },
};

/** 一条 stdio 形态的条目 */
const STDIO_PKG = {
  server: {
    name: "com.mcparmory/notion",
    description: "Create, update, and manage pages",
    version: "1.0.1",
    packages: [
      {
        registryType: "pypi",
        identifier: "mcparmory-notion",
        version: "1.0.1",
        runtimeHint: "uvx",
        transport: { type: "stdio" },
        environmentVariables: [
          { name: "NOTION_TOKEN", description: "Notion integration token", isRequired: true, isSecret: true },
          { name: "NOTION_LOCALE", description: "可选语言", isRequired: false },
        ],
      },
    ],
  },
  _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true } },
};

/** 同一个 name 的旧版本 —— isLatest: false，必须被丢掉 */
const STALE_VERSION = {
  server: {
    name: "com.example/plain",
    title: "Plain（旧版）",
    description: "旧版本",
    version: "1.0.0",
    remotes: [{ type: "streamable-http", url: "https://plain.example/old" }],
  },
  _meta: { "io.modelcontextprotocol.registry/official": { isLatest: false } },
};

/** 既没有 remotes 也没有 packages —— 装不了，必须被丢掉 */
const UNINSTALLABLE = {
  server: { name: "com.example/nothing", description: "空条目", version: "1.0.0" },
  _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true } },
};

function wrap(...records: unknown[]) {
  return { servers: records, metadata: { count: records.length } };
}

describe("registrySearchUrl", () => {
  it("查询词做 URL 编码，带上 limit", () => {
    const url = registrySearchUrl("hello world", 50);
    expect(url).toBe(
      "https://registry.modelcontextprotocol.io/v0/servers?search=hello+world&limit=50"
    );
  });

  it("limit 缺省是 50", () => {
    expect(registrySearchUrl("x")).toContain("limit=50");
  });
});

describe("mapRegistryServer —— remote 形态", () => {
  it("streamable-http 映成 http 传输，url 原样带过来", () => {
    const e = mapRegistryServer(REMOTE_WITH_TOKEN)!;
    expect(e.transport).toBe("http");
    expect(e.url).toBe("https://server.smithery.ai/@smithery/notion/mcp");
  });

  it("id 取 name 的末段做 slug —— 点和斜杠都不是合法 server id", () => {
    expect(mapRegistryServer(REMOTE_WITH_TOKEN)!.id).toBe("smithery-notion");
  });

  it("没有 title 就退回 name 的末段当显示名", () => {
    expect(mapRegistryServer(STDIO_PKG)!.name).toBe("notion");
  });

  it("必填的 header 变成 param，取模板占位符的名字", () => {
    const e = mapRegistryServer(REMOTE_WITH_TOKEN)!;
    expect(e.params).toEqual([
      {
        name: "smithery_api_key",
        description: "Bearer token for Smithery authentication",
        required: true,
      },
    ]);
  });

  it("有 secret 凭据 = auth token", () => {
    expect(mapRegistryServer(REMOTE_WITH_TOKEN)!.auth).toBe("token");
  });

  it("没有任何凭据要求 = auth none，不猜 oauth", () => {
    const e = mapRegistryServer(REMOTE_NO_AUTH)!;
    expect(e.auth).toBe("none");
    expect(e.params).toEqual([]);
  });

  it("authNote 兜底说清楚来路", () => {
    expect(mapRegistryServer(REMOTE_NO_AUTH)!.authNote).toBe(
      "这台 server 来自公开注册表，配置未经核验"
    );
  });
});

describe("mapRegistryServer —— stdio 形态", () => {
  it("runtimeHint + identifier 映成 command / args", () => {
    const e = mapRegistryServer(STDIO_PKG)!;
    expect(e.transport).toBe("stdio");
    expect(e.command).toBe("uvx");
    expect(e.args).toEqual(["mcparmory-notion"]);
  });

  it("必填的环境变量变成 param，可选的不进", () => {
    expect(mapRegistryServer(STDIO_PKG)!.params).toEqual([
      { name: "NOTION_TOKEN", description: "Notion integration token", required: true },
    ]);
  });

  it("npm 包的 runtimeHint 缺席时退回 npx -y", () => {
    const npmPkg = {
      server: {
        name: "com.example/thing",
        description: "npm 包",
        version: "1.0.0",
        packages: [
          { registryType: "npm", identifier: "@example/thing", version: "1.0.0", transport: { type: "stdio" } },
        ],
      },
      _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true } },
    };
    const e = mapRegistryServer(npmPkg)!;
    expect(e.command).toBe("npx");
    expect(e.args).toEqual(["-y", "@example/thing"]);
  });
});

describe("mapRegistryServer —— 丢弃的情况", () => {
  it("isLatest 不为 true 的丢掉", () => {
    expect(mapRegistryServer(STALE_VERSION)).toBeNull();
  });

  it("既无 remotes 也无 packages 的丢掉 —— 装不了", () => {
    expect(mapRegistryServer(UNINSTALLABLE)).toBeNull();
  });

  it("形状不对的丢掉，不抛", () => {
    expect(mapRegistryServer(null)).toBeNull();
    expect(mapRegistryServer({})).toBeNull();
    expect(mapRegistryServer({ server: "字符串" })).toBeNull();
  });
});

describe("mapRegistryResponse", () => {
  it("过滤 + 映射一整页", () => {
    const out = mapRegistryResponse(wrap(REMOTE_WITH_TOKEN, STALE_VERSION, UNINSTALLABLE, STDIO_PKG));
    expect(out.map((e) => e.id)).toEqual(["smithery-notion", "notion"]);
  });

  it("同一个 name 出现两次只留第一条", () => {
    const dup = { ...REMOTE_NO_AUTH };
    const out = mapRegistryResponse(wrap(REMOTE_NO_AUTH, dup));
    expect(out).toHaveLength(1);
  });

  it("id 撞了就补数字后缀 —— 不同 name 可能 slug 成同一个 id", () => {
    const a = { ...REMOTE_NO_AUTH, server: { ...REMOTE_NO_AUTH.server, name: "com.a/plain" } };
    const b = { ...REMOTE_NO_AUTH, server: { ...REMOTE_NO_AUTH.server, name: "com.b/plain" } };
    expect(mapRegistryResponse(wrap(a, b)).map((e) => e.id)).toEqual(["plain", "plain-2"]);
  });

  it("整体形状不对返回空数组，不抛", () => {
    expect(mapRegistryResponse(null)).toEqual([]);
    expect(mapRegistryResponse({ servers: "不是数组" })).toEqual([]);
  });
});

describe("真实响应样本", () => {
  // 只断言"不炸 + 映得出东西"。真数据会变，行为断言全在上面的内联 JSON 里
  it("喂一份真抓下来的响应不抛，且至少映出一条", () => {
    const raw = JSON.parse(
      readFileSync(join(__dirname, "..", "fixtures", "mcpRegistry.sample.json"), "utf8")
    );
    const out = mapRegistryResponse(raw);
    expect(out.length).toBeGreaterThan(0);
    for (const e of out) {
      expect(e.id).not.toBe("");
      if (e.transport === "http") expect(e.url).toBeTruthy();
      else expect(e.command).toBeTruthy();
    }
  });
});
```

- [ ] **Step 3: 跑测试，确认它红**

```bash
npx vitest run tests/shared/mcpRegistry.test.ts
```

期望：`Failed to resolve import "../../src/shared/mcpRegistry.js"`。

- [ ] **Step 4: 写实现**

创建 `src/shared/mcpRegistry.ts`：

```ts
// registry.modelcontextprotocol.io 的响应 → 仓内既有的 CatalogEntry。
//
// 为什么要这一层：注册表的形状（remotes/packages/headers/environmentVariables）
// 和本仓的 CatalogEntry 不是一回事，而下游有三个消费者——目录页 UI、
// mcp_catalog 工具、mcp_configure 落盘。折成同一个形状，三者共用一套渲染与
// 校验，而不是各自解一遍注册表的 JSON。
//
// 纯逻辑、零 IO：src/shared 手机端会直接 import（tests/architecture.test.ts
// 第 5 条），碰 node builtin 就断了那条路。取数在 src/main/mcpRegistry.ts。

import type { CatalogEntry, CatalogParam } from "./mcpCatalog.js";

export const REGISTRY_BASE = "https://registry.modelcontextprotocol.io";

/** 官方注册表往 _meta 里塞状态的键名。字面量，一字不能改 */
const OFFICIAL_META = "io.modelcontextprotocol.registry/official";

export function registrySearchUrl(query: string, limit = 50): string {
  const p = new URLSearchParams({ search: query, limit: String(limit) });
  return `${REGISTRY_BASE}/v0/servers?${p.toString()}`;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** 反向域名的末段做 id：ai.smithery/smithery-notion → smithery-notion。
    注册表的 name 带点和斜杠，不是合法的 mcp.json 对象键（也没法当 UI 里的
    稳定短名）。撞名由 mapRegistryResponse 统一补后缀 */
function slugId(name: string): string {
  const tail = name.split("/").pop() ?? name;
  const slug = tail
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "server" : slug;
}

/** header 的 value 模板形如 "Bearer {smithery_api_key}"——占位符的名字才是
    要问用户的东西，header 自己的名字（Authorization）不是 */
function paramNameFromHeader(h: Record<string, unknown>): string | undefined {
  const template = str(h.value);
  const hole = template?.match(/\{(\w+)\}/)?.[1];
  return hole ?? str(h.name);
}

function paramsFromHeaders(headers: unknown[]): CatalogParam[] {
  const out: CatalogParam[] = [];
  for (const h of headers) {
    if (!isObj(h) || h.isRequired !== true) continue;
    const name = paramNameFromHeader(h);
    if (name === undefined) continue;
    out.push({ name, description: str(h.description) ?? `${name} 的值`, required: true });
  }
  return out;
}

function paramsFromEnv(vars: unknown[]): CatalogParam[] {
  const out: CatalogParam[] = [];
  for (const v of vars) {
    if (!isObj(v) || v.isRequired !== true) continue;
    const name = str(v.name);
    if (name === undefined) continue;
    out.push({ name, description: str(v.description) ?? `${name} 的值`, required: true });
  }
  return out;
}

/** 包管理器 → 启动命令。runtimeHint 是注册表给的建议，缺席时按 registryType
    兜底（npm → npx -y，pypi → uvx）。认不出来的返回 null = 这条装不了 */
function commandFor(pkg: Record<string, unknown>): { command: string; args: string[] } | null {
  const identifier = str(pkg.identifier);
  if (identifier === undefined) return null;
  const hint = str(pkg.runtimeHint);
  if (hint === "uvx") return { command: "uvx", args: [identifier] };
  if (hint === "npx") return { command: "npx", args: ["-y", identifier] };
  if (hint !== undefined) return { command: hint, args: [identifier] };
  const type = str(pkg.registryType);
  if (type === "npm") return { command: "npx", args: ["-y", identifier] };
  if (type === "pypi") return { command: "uvx", args: [identifier] };
  return null;
}

const UNVERIFIED_NOTE = "这台 server 来自公开注册表，配置未经核验";

/** 一条注册表记录 → CatalogEntry；映不出来（旧版本 / 装不了 / 形状不对）返回 null */
export function mapRegistryServer(record: unknown): CatalogEntry | null {
  if (!isObj(record)) return null;
  const meta = isObj(record._meta) ? record._meta[OFFICIAL_META] : undefined;
  // 同一个 server 的每个历史版本都是一条记录，只要最新那条
  if (!isObj(meta) || meta.isLatest !== true) return null;

  const s = record.server;
  if (!isObj(s)) return null;
  const fullName = str(s.name);
  if (fullName === undefined) return null;

  const id = slugId(fullName);
  const name = str(s.title) ?? id;
  const description = str(s.description) ?? "";

  const remote = arr(s.remotes).find(
    (r) => isObj(r) && r.type === "streamable-http" && str(r.url) !== undefined
  );
  if (isObj(remote)) {
    const params = paramsFromHeaders(arr(remote.headers));
    const secret = arr(remote.headers).some((h) => isObj(h) && h.isSecret === true);
    return {
      id,
      name,
      description,
      transport: "http",
      url: str(remote.url)!,
      params,
      auth: secret || params.length > 0 ? "token" : "none",
      authNote: params[0]?.description ?? UNVERIFIED_NOTE,
    };
  }

  for (const p of arr(s.packages)) {
    if (!isObj(p)) continue;
    const cmd = commandFor(p);
    if (cmd === null) continue;
    const params = paramsFromEnv(arr(p.environmentVariables));
    return {
      id,
      name,
      description,
      transport: "stdio",
      command: cmd.command,
      args: cmd.args,
      params,
      auth: params.length > 0 ? "token" : "none",
      authNote: params[0]?.description ?? UNVERIFIED_NOTE,
    };
  }

  // 既没有能连的远程端点，也没有能跑的包 —— 装不了，不摆出来
  return null;
}

/** 一整页响应 → CatalogEntry[]。去重两道：先按注册表的 name（同名多条只留
    第一条），再按 slug 出来的 id（不同 name 可能 slug 成同一个 id，撞了补后缀，
    否则两张卡片的 key 和落盘的对象键都会撞） */
export function mapRegistryResponse(json: unknown): CatalogEntry[] {
  if (!isObj(json)) return [];
  const records = arr(json.servers);
  const seenNames = new Set<string>();
  const usedIds = new Set<string>();
  const out: CatalogEntry[] = [];
  for (const record of records) {
    const fullName = isObj(record) && isObj(record.server) ? str(record.server.name) : undefined;
    if (fullName !== undefined) {
      if (seenNames.has(fullName)) continue;
      seenNames.add(fullName);
    }
    const entry = mapRegistryServer(record);
    if (entry === null) continue;
    let id = entry.id;
    for (let n = 2; usedIds.has(id); n += 1) id = `${entry.id}-${n}`;
    usedIds.add(id);
    out.push(id === entry.id ? entry : { ...entry, id });
  }
  return out;
}
```

- [ ] **Step 5: 跑测试，确认它绿**

```bash
npx vitest run tests/shared/mcpRegistry.test.ts
```

期望：全部 PASS。

- [ ] **Step 6: 跑全门禁**

```bash
npm test
```

期望：exit 0。

- [ ] **Step 7: 提交**

```bash
git add src/shared/mcpRegistry.ts tests/shared/mcpRegistry.test.ts tests/fixtures/mcpRegistry.sample.json
git commit -m "$(cat <<'EOF'
feat(mcp): 注册表响应 → CatalogEntry 的纯映射层（issue #661）

折成本仓已有的 CatalogEntry 而不是新造一个类型：下游有三个消费者——目录页
UI、mcp_catalog 工具、mcp_configure 落盘，共用一个形状就共用一套渲染与校验。

两道过滤是注册表形状逼出来的，不是洁癖：① 同一个 server 的每个历史版本都是
一条记录，不按 _meta 的 isLatest 过滤，首页两条都会是同一台；② 既没有
remotes 也没有 packages 的条目装不了，摆出来是给用户一个点了没用的按钮。

行为断言全部喂内联 JSON。tests/fixtures 那份真抓的响应只做"不炸 + 至少映出
一条"的冒烟——拿真数据断行为，注册表哪天改内容测试就无故变红。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `world.http.getJson` 接缝

**Files:**
- Modify: `src/world/executionWorld.ts:261-263`（接口）、`:316-318`（`withAbortSignal`）、`:366`（`withExecOutput`）
- Modify: `src/world/localWorld.ts:180-203`
- Modify: `tests/world/localWorld.test.ts`（在 `describe("http.postJson")` 之后追加）

**Interfaces:**
- Consumes: 无（本任务不依赖 Task 1）
- Produces: `ExecutionWorld["http"]["getJson"]?: (url: string, opts?: HttpPostOptions) => Promise<unknown>`

**为什么是可选字段**：仓内 35 处测试假 world 写着 `http: { postJson: async () => ({}) }`，必填会让它们全红——而这些红跟本功能无关。仓内先例是 `execDetached?` / `openTerminal?` / `browser?`，注释原文写着「可选 = 向后兼容（假 world 零改动）」。

- [ ] **Step 1: 写失败的测试**

在 `tests/world/localWorld.test.ts` 里，`describe("http.postJson", ...)` 这一块**之后**追加：

```ts
describe("http.getJson", () => {
  it("发 GET，不带 body，解析 JSON", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const world = createLocalWorld({
      cwd: "/tmp",
      fetchImpl: async (url: string, init: RequestInit) => {
        seen = { url, init };
        return new Response(JSON.stringify({ servers: [] }), { status: 200 });
      },
    } as never);
    const out = await world.http.getJson!("https://x.test/v0/servers?search=a");
    expect(out).toEqual({ servers: [] });
    expect(seen!.url).toBe("https://x.test/v0/servers?search=a");
    expect(seen!.init.method).toBe("GET");
    expect(seen!.init.body).toBeUndefined();
  });

  it("非 2xx 抛，错误里带状态码和响应片段", async () => {
    const world = createLocalWorld({
      cwd: "/tmp",
      fetchImpl: async () => new Response("upstream exploded", { status: 503 }),
    } as never);
    await expect(world.http.getJson!("https://x.test/v0/servers")).rejects.toThrow(
      /503.*upstream exploded/s
    );
  });

  it("外部中断穿透，报错含「中断」", async () => {
    const ac = new AbortController();
    const world = createLocalWorld({
      cwd: "/tmp",
      fetchImpl: (_u: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    } as never);
    const pending = world.http.getJson!("https://x.test/v0/servers", { signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toThrow(/中断/);
  });

  it("withAbortSignal 把 signal 焊进 http.getJson", async () => {
    const ac = new AbortController();
    const world = createLocalWorld({
      cwd: "/tmp",
      fetchImpl: (_u: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    } as never);
    const wrapped = withAbortSignal(world, ac.signal);
    const pending = wrapped.http.getJson!("https://x.test/v0/servers");
    ac.abort();
    await expect(pending).rejects.toThrow(/中断/);
  });
});
```

如果 `withAbortSignal` / `createLocalWorld` 在这个测试文件里还没被 import，照文件顶部既有的 import 补上。上面几处 `createLocalWorld({...} as never)` 的参数形状要跟同文件 `describe("http.postJson")` 里的写法保持一致——照抄它那几行的构造方式，不要自创。

- [ ] **Step 2: 跑测试，确认它红**

```bash
npx vitest run tests/world/localWorld.test.ts -t "getJson"
```

期望：`world.http.getJson is not a function`。

- [ ] **Step 3: 接口上加可选字段**

`src/world/executionWorld.ts`，把 `:261-263` 那段改成：

```ts
  /** JSON POST——工具的全部网络面。v1 LocalWorld 用 fetch;v2 Docker 按 bot 走代理/断网 */
  http: {
    postJson(url: string, body: unknown, opts?: HttpPostOptions): Promise<unknown>;
    /** 可选：JSON GET。可选的理由同 execDetached/openTerminal——仓里几十处测试
        假 world 只实现了 postJson，必填会让它们全红，而那些红跟网络能力无关。
        缺席 = 这个世界不提供 GET，调用方（tools/mcpCatalog.ts）据此说人话。
        v2 Docker 世界若要断网，不实现这个字段即可 */
    getJson?(url: string, opts?: HttpPostOptions): Promise<unknown>;
  };
```

- [ ] **Step 4: 两个装饰器透传**

`src/world/executionWorld.ts` 的 `withAbortSignal`（`:316-318`），把 `http` 那一块改成：

```ts
    http: {
      postJson: (url, body, opts) => world.http.postJson(url, body, { ...opts, signal }),
      ...(world.http.getJson
        ? { getJson: (url: string, opts?: HttpPostOptions) => world.http.getJson!(url, { ...opts, signal }) }
        : {}),
    },
```

`withExecOutput`（`:366`）那一行是 `http: world.http`，整个对象透传，**不用改**。

- [ ] **Step 5: LocalWorld 实现**

`src/world/localWorld.ts`，在 `http: {` 块里 `postJson` **之后**加：

```ts
      async getJson(url, o) {
        const fetchImpl = opts.fetchImpl ?? fetch;
        // 30s 超时与外部中断信号合并;两者都能掐死请求（同 postJson）
        const timeout = AbortSignal.timeout(30_000);
        const signal = o?.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
        let res: Response;
        try {
          res = await fetchImpl(url, { method: "GET", headers: { ...o?.headers }, signal });
        } catch (err) {
          // 中断是外力,不是请求自身失败——语义对齐 exec(ADR-0006)
          if (o?.signal?.aborted) throw new Error("请求被中断：用户停止了 turn");
          throw err;
        }
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        }
        return res.json();
      },
```

- [ ] **Step 6: 跑测试，确认它绿**

```bash
npx vitest run tests/world/localWorld.test.ts
```

期望：全部 PASS，含既有的 postJson 用例。

- [ ] **Step 7: 跑全门禁**

```bash
npm test
```

期望：exit 0。特别确认 `tests/architecture.test.ts` 与 `tests/world/executionWorld.test.ts` 没红。

- [ ] **Step 8: 提交**

```bash
git add src/world/executionWorld.ts src/world/localWorld.ts tests/world/localWorld.test.ts
git commit -m "$(cat <<'EOF'
feat(world): http 接缝上加可选的 getJson（issue #661）

mcp_catalog 要查 registry.modelcontextprotocol.io，而工具只能依赖
ExecutionWorld（硬规则）——现有接缝只有 postJson，注册表是 GET。把新能力加到
缝上，而不是在工具里绕过缝（ADR-0050 的正常延伸）。

刻意做成可选字段：仓里 35 处测试假 world 写着 http: { postJson: ... }，必填
会让它们全红，而那些红跟网络能力毫无关系。execDetached / openTerminal /
browser 已经立了这个先例，注释原文就是「可选 = 向后兼容（假 world 零改动）」。
缺席的语义是「这个世界不提供 GET」，调用方据此说人话——v2 Docker 世界要断网，
不实现即可。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 主进程取数 + ShellBridge 接线

**Files:**
- Create: `src/main/mcpRegistry.ts`
- Modify: `src/shared/shellBridge.ts`（`:583` 附近加方法、`:1112` 附近加 channel）
- Modify: `src/main/index.ts`（`:2231` 附近加 handler）
- Modify: `src/preload/index.ts`（`:74` 附近加一行）
- Modify: `src/renderer/src/store.ts`（`:427` 附近加接口、`:970` 附近加实现）

**Interfaces:**
- Consumes: `mapRegistryResponse` / `registrySearchUrl` from `src/shared/mcpRegistry.ts`（Task 1）
- Produces:
  - `src/main/mcpRegistry.ts`: `export async function searchMcpRegistry(query: string, signal?: AbortSignal): Promise<CatalogEntry[]>`
  - ShellBridge: `searchMcpRegistry(query: string): Promise<CatalogEntry[]>`
  - store: `searchMcpRegistry(query: string): Promise<CatalogEntry[]>`

- [ ] **Step 1: 写主进程取数模块**

创建 `src/main/mcpRegistry.ts`：

```ts
// 唯一打 registry.modelcontextprotocol.io 的地方。
//
// 不落盘、不做全量同步、不做过期刷新：全量拉的成本已经验掉了（循环翻页
// limit=100 跑两分钟没到底），而它换来的「离线可浏览」对一个装上也要联网才能
// 用的东西没价值。搜索走 live query，debounce 在渲染进程侧做。
//
// 映射逻辑不在这儿——在 src/shared/mcpRegistry.ts，因为 mcp_catalog 工具走
// world.http 那条路，两边共用同一份折叠规则。

import { mapRegistryResponse, registrySearchUrl } from "../shared/mcpRegistry.js";
import type { CatalogEntry } from "../shared/mcpCatalog.js";

const TIMEOUT_MS = 15_000;

export async function searchMcpRegistry(
  query: string,
  signal?: AbortSignal
): Promise<CatalogEntry[]> {
  const q = query.trim();
  // 空查询不打网：注册表按字母序返回，首屏拿到的是一堆无关条目，
  // 而目录页的空查询状态本来就该显示仓内精选层
  if (q === "") return [];
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetch(registrySearchUrl(q), {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: merged,
  });
  if (!res.ok) throw new Error(`注册表返回 HTTP ${res.status}`);
  return mapRegistryResponse(await res.json());
}
```

- [ ] **Step 2: ShellBridge 加方法与 channel**

`src/shared/shellBridge.ts`，在 `saveMcpServer`（`:583`）那一行**之后**加：

```ts
  /** 搜公开注册表。空查询返回空数组（目录页的空状态显示仓内精选层，不打网）。
      网络失败原样抛给渲染进程——目录页要能显示「搜不动」而不是假装没结果 */
  searchMcpRegistry(query: string): Promise<CatalogEntry[]>;
```

同文件 `CHANNELS`（`:1112` 附近的 `saveMcpServer: "otter:saveMcpServer",`）之后加：

```ts
  searchMcpRegistry: "otter:searchMcpRegistry",
```

文件顶部的 import 补上 `CatalogEntry`（照该文件既有的 import 风格，从 `./mcpCatalog.js`）。

- [ ] **Step 3: 主进程 handler**

`src/main/index.ts`，在 `ipcMain.handle(CHANNELS.saveMcpServer, ...)`（`:2231`）那一块**之后**加：

```ts
  ipcMain.handle(CHANNELS.searchMcpRegistry, async (_e, query: string): Promise<CatalogEntry[]> => {
    return searchMcpRegistry(query);
  });
```

顶部 import 补：`import { searchMcpRegistry } from "./mcpRegistry.js";` 和 `CatalogEntry` 类型（若该文件尚未 import）。

- [ ] **Step 4: preload 桥接**

`src/preload/index.ts`，在 `saveMcpServer` 那一行（`:74`）之后加：

```ts
  searchMcpRegistry: (query) => ipcRenderer.invoke(CHANNELS.searchMcpRegistry, query),
```

- [ ] **Step 5: store action**

`src/renderer/src/store.ts`，接口部分（`:427` 的 `saveMcpServer` 之后）加：

```ts
  searchMcpRegistry(query: string): Promise<CatalogEntry[]>;
```

实现部分（`:970` 的 `async saveMcpServer` 之后）加：

```ts
  // 不进 store 状态：搜索结果是瞬时的，组件自己拿着就行。放进 store 等于
  // 给一份会被下一次输入立刻作废的数据造一个全局家
  async searchMcpRegistry(query) {
    return window.otter.searchMcpRegistry(query);
  },
```

顶部 import 补 `CatalogEntry` 类型。

- [ ] **Step 6: 跑门禁**

```bash
npm test
```

期望：exit 0。`tsc --noEmit` 会抓出任何一处漏接的桥（接口加了但 preload 没加，等等）——五个点必须全接上才编得过。

- [ ] **Step 7: 真打一次注册表确认接线活着**

```bash
npx tsx -e "import('./src/main/mcpRegistry.js').then(async m => { const r = await m.searchMcpRegistry('notion'); console.log(r.length, '条'); console.log(JSON.stringify(r.slice(0,2), null, 2)); })"
```

期望：打印出条数与前两条的映射结果。**这一步不进门禁**（依赖外部网络），是接线的人自己确认一次。若 `npx tsx` 在本仓不可用，改用 `npm test` 之外的任意 node 运行方式跑同样一行；跑不起来就跳过这一步，Task 5 的 UI 会验到同一条路径。

- [ ] **Step 8: 提交**

```bash
git add src/main/mcpRegistry.ts src/shared/shellBridge.ts src/main/index.ts src/preload/index.ts src/renderer/src/store.ts
git commit -m "$(cat <<'EOF'
feat(mcp): 注册表搜索接上 ShellBridge（issue #661）

不落盘、不全量同步、不做过期刷新：全量拉的成本验过了——循环翻页 limit=100
两分钟没到底；而它换来的「离线可浏览」对一个装上也要联网才能用的东西没价值。

空查询不打网直接返回空数组：注册表按字母序返回，首屏拿到的是 ac.inference.sh
这类无关条目，没有任何排名信号。目录页的空状态显示的是仓内精选层。

网络失败原样抛给渲染进程，不吞成空数组——目录页要能显示「搜不动」，
而不是假装搜到了零条。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 精选层扩容 + 图标字段

**Files:**
- Modify: `src/shared/mcpCatalog.ts`
- Modify: `tests/shared/mcpCatalog.test.ts`
- Create: `src/renderer/src/assets/mcp/*.svg`

**Interfaces:**
- Consumes: 无
- Produces: `CatalogEntry.icon?: string`（**打进包的本地资源键**，不是 URL）

**为什么 icon 是资源键而不是 URL**：渲染进程加载注册表条目里的任意 URL，等于每翻一次目录就把用户 IP 交给一批由投稿者自由填写的服务器。长尾层一律首字母色块（注册表 93% 的条目本来就没有 `icons`），精选层用打进包的 SVG。零远程图片。

- [ ] **Step 1: 加 icon 字段**

`src/shared/mcpCatalog.ts` 的 `CatalogEntry` 接口里，`authNote` 之后加：

```ts
  /** 可选：打进包的本地图标资源键（不是 URL）。渲染进程用它查
      src/renderer/src/assets/mcp/ 下的 SVG；缺席就画首字母色块。
      **刻意不接受远程 URL**：注册表条目的 icons 由投稿者自由填写，让渲染进程
      去加载等于每翻一次目录就把用户 IP 交给一批陌生服务器。长尾层一律色块 */
  icon?: string;
```

- [ ] **Step 2: 精选条目补 icon 键并扩容**

给现有 9 条各加 `icon` 键（值 = 条目 id，例如 `icon: "supabase"`），并按同样的字面量格式补齐到约 20 条。补的这批只填**官方**端点，不填中间商包装的：

```ts
  {
    id: "github",
    name: "GitHub",
    description: "读写 issue / PR / 仓库内容",
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权，在浏览器里同意 GitHub 的授权请求",
    icon: "github",
  },
```

要补的（每条都按上面的形状写全九个字段）：Slack、Figma、Atlassian、Asana、Canva、HubSpot、Google Drive、Sentry（已有）之外的 Cloudflare、Vercel、PostgreSQL（stdio）、Git（stdio）、Fetch（stdio）。**每条的 `url` / `command` / `args` 必须是实际验证过的**——本步骤开始前，对每个候选跑一次：

```bash
curl -sS -m 10 -o /dev/null -w '%{http_code}\n' <该条目的 url>
```

401 / 405 都算活着（需要授权 / 不接受 GET），404 / DNS 失败就不要把这条写进精选层——精选层的全部价值就是"人工核过"，写进一条没验过的等于把这个价值抹掉。stdio 条目验包存在：

```bash
npm view <包名> version   # 或 pip index versions <包名>
```

- [ ] **Step 3: 放图标资源**

把每条精选条目对应的官方 SVG 放进 `src/renderer/src/assets/mcp/<icon 键>.svg`。用各家品牌资源页提供的官方 SVG。找不到官方 SVG 的条目**不填 `icon` 字段**——它会退回首字母色块，这是设计好的兜底，不是缺陷。

- [ ] **Step 4: 测试补一条断言**

`tests/shared/mcpCatalog.test.ts` 里追加：

```ts
  it("填了 icon 的条目，资源文件必须真的在", () => {
    // icon 是资源键不是 URL（见 CatalogEntry.icon 的注释）。填了键却没放文件，
    // UI 上是一个静默的空白格——这类失败不会自己冒头，只能靠断言抓
    const dir = join(__dirname, "..", "..", "src", "renderer", "src", "assets", "mcp");
    for (const e of MCP_CATALOG) {
      if (e.icon === undefined) continue;
      expect(existsSync(join(dir, `${e.icon}.svg`)), `${e.id} 的图标`).toBe(true);
    }
  });
```

文件顶部补 import：

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
```

（测试文件在 `tests/` 下，碰 node builtin 没问题——`tests/architecture.test.ts` 第 5 条约束的是 `src/shared/`。）

- [ ] **Step 5: 跑测试**

```bash
npx vitest run tests/shared/mcpCatalog.test.ts
```

期望：全部 PASS。既有的三条断言（id 唯一 / http 有 url、stdio 有 command / 占位符都在 params 里声明过）会自动覆盖新加的条目——新条目写错了会在这里红。

- [ ] **Step 6: 跑全门禁**

```bash
npm test
```

期望：exit 0。

- [ ] **Step 7: 提交**

```bash
git add src/shared/mcpCatalog.ts tests/shared/mcpCatalog.test.ts src/renderer/src/assets/mcp/
git commit -m "$(cat <<'EOF'
feat(mcp): 精选层扩到 ~20 条，加本地图标字段（issue #661）

icon 是打进包的资源键，不是 URL：注册表条目的 icons 由投稿者自由填写，让渲染
进程去加载等于每翻一次目录就把用户 IP 交给一批陌生服务器。长尾层一律首字母
色块（注册表 93% 的条目本来就没有 icons），精选层用打进包的 SVG。零远程图片。

补的条目全部填官方端点、逐个验过存活，不填中间商包装的——精选层的全部价值
就是「人工核过」，写进一条没验过的等于把这个价值抹掉。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 目录页 UI

**Files:**
- Create: `src/renderer/src/lib/mcpDirectory.ts`
- Create: `tests/renderer/mcpDirectory.test.ts`
- Create: `src/renderer/src/components/McpDirectory.tsx`
- Modify: `src/renderer/src/components/McpSettings.tsx:84-141`

**Interfaces:**
- Consumes: `searchCatalog` / `MCP_CATALOG` / `CatalogEntry`（`src/shared/mcpCatalog.ts`）、`searchMcpRegistry`（store，Task 3）、`mcpServerIdError`（`src/renderer/src/lib/mcpForm.ts`）
- Produces:
  - `export interface DirectoryItem { entry: CatalogEntry; verified: boolean; installed: boolean }`
  - `export function buildDirectory(opts): { curated: DirectoryItem[]; longTail: DirectoryItem[] }`
  - `export function needsInstallConfirm(item: DirectoryItem): boolean`

**为什么 `verified` 在 `DirectoryItem` 上而不是 `CatalogEntry` 上**：核验与否是**来路**的性质，不是条目自身的属性——同一条配置从精选层拿是核过的，从注册表拿就不是。放在包装类型上，`MCP_CATALOG` 那 20 条字面量一个字都不用改。

- [ ] **Step 1: 写纯逻辑的失败测试**

创建 `tests/renderer/mcpDirectory.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import {
  buildDirectory,
  needsInstallConfirm,
  type DirectoryItem,
} from "../../src/renderer/src/lib/mcpDirectory.js";
import type { CatalogEntry } from "../../src/shared/mcpCatalog.js";

const http = (id: string): CatalogEntry => ({
  id,
  name: id,
  description: `${id} 的说明`,
  transport: "http",
  url: `https://${id}.test/mcp`,
  params: [],
  auth: "none",
  authNote: "",
});

const stdio = (id: string): CatalogEntry => ({
  id,
  name: id,
  description: `${id} 的说明`,
  transport: "stdio",
  command: "npx",
  args: ["-y", id],
  params: [],
  auth: "none",
  authNote: "",
});

describe("buildDirectory", () => {
  it("空查询：精选全出，长尾为空", () => {
    const out = buildDirectory({
      query: "",
      curated: [http("a"), http("b")],
      registry: [http("z")],
      installedIds: [],
    });
    expect(out.curated.map((i) => i.entry.id)).toEqual(["a", "b"]);
    expect(out.longTail).toEqual([]);
  });

  it("精选项一律 verified，长尾项一律不 verified", () => {
    const out = buildDirectory({
      query: "a",
      curated: [http("a")],
      registry: [http("z")],
      installedIds: [],
    });
    expect(out.curated[0]!.verified).toBe(true);
    expect(out.longTail[0]!.verified).toBe(false);
  });

  it("已装的标出来 —— UI 据此画 ✓ 而不是 +", () => {
    const out = buildDirectory({
      query: "",
      curated: [http("a"), http("b")],
      registry: [],
      installedIds: ["b"],
    });
    expect(out.curated.map((i) => i.installed)).toEqual([false, true]);
  });

  it("长尾里跟精选撞 id 的剔掉 —— 同一台 server 不该出现两次", () => {
    const out = buildDirectory({
      query: "a",
      curated: [http("notion")],
      registry: [http("notion"), http("other")],
      installedIds: [],
    });
    expect(out.longTail.map((i) => i.entry.id)).toEqual(["other"]);
  });
});

describe("needsInstallConfirm", () => {
  it("长尾的 stdio 要确认 —— 会在本机跑陌生人发布的包", () => {
    expect(needsInstallConfirm({ entry: stdio("x"), verified: false, installed: false })).toBe(true);
  });

  it("精选的 stdio 不要 —— 已人工核过", () => {
    expect(needsInstallConfirm({ entry: stdio("x"), verified: true, installed: false })).toBe(false);
  });

  it("长尾的 http 不要 —— 代码跑在对方机器上，不在用户机器上", () => {
    expect(needsInstallConfirm({ entry: http("x"), verified: false, installed: false })).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试，确认它红**

```bash
npx vitest run tests/renderer/mcpDirectory.test.ts
```

期望：`Failed to resolve import`。

- [ ] **Step 3: 写纯逻辑**

创建 `src/renderer/src/lib/mcpDirectory.ts`：

```ts
// 目录页的判断题——组件只管渲染（同 mcpForm.ts 的分工）。
//
// 两层的分野在这里落地：精选层来自仓内常量（人工核过、进过 PR review），
// 长尾层来自公开注册表（开放投稿，搜 notion 头两条是中间商包装）。
// verified 是**来路**的性质而不是条目自身的属性——同一份配置从精选层拿是
// 核过的，从注册表拿就不是——所以它在这个包装类型上，不在 CatalogEntry 上。

import type { CatalogEntry } from "../../../shared/mcpCatalog.js";

export interface DirectoryItem {
  entry: CatalogEntry;
  /** 来自仓内精选层 = 人工核过 */
  verified: boolean;
  /** 已经装上了 —— UI 画 ✓ 而不是 + */
  installed: boolean;
}

export interface BuildDirectoryOptions {
  query: string;
  /** 精选层命中的条目（调用方用 searchCatalog 算好） */
  curated: readonly CatalogEntry[];
  /** 注册表返回的条目 */
  registry: readonly CatalogEntry[];
  /** 已装 server 的 id */
  installedIds: readonly string[];
}

export function buildDirectory(opts: BuildDirectoryOptions): {
  curated: DirectoryItem[];
  longTail: DirectoryItem[];
} {
  const installed = new Set(opts.installedIds);
  const curatedIds = new Set(opts.curated.map((e) => e.id));
  const wrap = (entry: CatalogEntry, verified: boolean): DirectoryItem => ({
    entry,
    verified,
    installed: installed.has(entry.id),
  });
  return {
    curated: opts.curated.map((e) => wrap(e, true)),
    // 空查询不出长尾（调用方本来就不会去打网，这里是第二道保险）；
    // 跟精选撞 id 的剔掉——同一台 server 不该在一屏里出现两次
    longTail:
      opts.query.trim() === ""
        ? []
        : opts.registry.filter((e) => !curatedIds.has(e.id)).map((e) => wrap(e, false)),
  };
}

/** 装之前要不要弹确认卡。
    判据只有一条：这条是不是「未经核验的 stdio」。stdio 装上意味着 Otto 会
    npx/uvx 从公共包仓库下载并在用户本机执行代码，而注册表是开放投稿的——
    从搜索结果里点一下，跟用户自己在新建对话框里敲命令不是一回事，点击的人
    未必知道自己触发了什么。
    远程条目不弹：代码跑在对方机器上，不在用户机器上。
    精选条目不弹：已人工核过（这正是精选层存在的意义）。 */
export function needsInstallConfirm(item: DirectoryItem): boolean {
  return !item.verified && item.entry.transport === "stdio";
}
```

- [ ] **Step 4: 跑测试，确认它绿**

```bash
npx vitest run tests/renderer/mcpDirectory.test.ts
```

期望：全部 PASS。

- [ ] **Step 5: 写组件**

创建 `src/renderer/src/components/McpDirectory.tsx`。要点，按现有 `McpSettings.tsx` 的 Tailwind/shadcn 风格写（尺寸、圆角、色 token 照抄该文件既有写法，不要自创）：

- 顶部一个搜索输入框，`placeholder="搜索连接器"`
- 输入 **debounce 250ms** 后调 `searchMcpRegistry(query)`；每次新查询前 `AbortController.abort()` 掉上一次，回来的结果若不属于当前 query 就丢弃（避免慢的旧请求盖掉新结果）
- 用 `searchCatalog(query)` 算精选命中，连同注册表结果一起喂 `buildDirectory`
- 精选区标题「精选」，每张卡片右上角一个「已核验」角标
- 长尾区标题分隔线，文案固定为：**「以下来自公开注册表，未经核验」**
- 卡片：左侧图标（`entry.icon` 有就渲染 `src/renderer/src/assets/mcp/<icon>.svg`，没有就画首字母色块——色块背景色由 `entry.id` 哈希取一个固定色板里的颜色，保证同一条目每次颜色一致）/ 名字 / 描述一行 / 右侧 `+` 或 ✓
- 搜索失败（`searchMcpRegistry` 抛）时长尾区显示一行「注册表搜不动：<错误信息>」，**不要**吞成"没有结果"
- 点 `+` 的三条路：
  1. `needsInstallConfirm(item)` 为真 → 先弹确认对话框。正文固定为：**「这会从 <npm/PyPI> 下载 `<包名>` 并在你的电脑上运行它。这台 server 来自公开注册表，未经核验。」**，附 `entry.command` + `entry.args` 全文；用户确认后走 2 或 3
  2. `entry.params.length > 0` → 弹一个小表单，每个 param 一格输入框（`required` 的必填），提交时把值代进 `url` / `args` 里的 `{占位符}`
  3. 否则直接落盘：调 `saveMcpServer(id, cfg)`，`id` 先过 `mcpServerIdError(entry.id, installedIds)`，报错（撞名）就在 id 后补数字重试；落盘后若 `entry.transport === "http"` 再调 `authorizeMcpServer(id)`
- 已装的卡片（`installed`）右侧画 ✓，点击不做任何事（管理走下面既有的 `McpServerRow`）

- [ ] **Step 6: 挂进设置页**

`src/renderer/src/components/McpSettings.tsx`，在 `<section className={SETTINGS_BODY}>` 内部、错误横幅**之后**、已装列表**之前**插入：

```tsx
        <McpDirectory installedIds={snapshot.servers.map((s) => s.id)} />
```

把 `snapshot.servers.length === 0` 那个空状态块删掉——目录页本身就是最好的空状态（有东西可点，比一句"还没配置任何 MCP server"有用）。顶部 import 补 `McpDirectory`。

- [ ] **Step 7: 跑门禁**

```bash
npm test
```

期望：exit 0。

- [ ] **Step 8: 真机看一眼**

```bash
npm run dev
```

打开设置 → MCP。确认：① 不搜也能看到精选网格 ② 搜 `notion` 后长尾区出现且带"未经核验"分隔 ③ 点一个长尾 stdio 条目会弹确认卡 ④ 点一个精选 http 条目直接装上并弹出授权浏览器。

- [ ] **Step 9: 提交**

```bash
git add src/renderer/src/lib/mcpDirectory.ts tests/renderer/mcpDirectory.test.ts src/renderer/src/components/McpDirectory.tsx src/renderer/src/components/McpSettings.tsx
git commit -m "$(cat <<'EOF'
feat(mcp): 设置页上方加连接器目录（issue #661）

不搜也能看：首屏是仓内精选层，零网络。注册表当不了首屏——它按字母序返回，
第一条是 ac.inference.sh，没有任何排名信号。

verified 放在 DirectoryItem 上而不是 CatalogEntry 上：核验与否是**来路**的
性质，不是条目自身的属性——同一份配置从精选层拿是核过的，从注册表拿就不是。
这样 MCP_CATALOG 那批字面量一个字都不用改。

长尾的 stdio 装之前弹确认卡：装上意味着 npx/uvx 从公共包仓库下载并在用户本机
执行代码，而注册表是开放投稿的。用户在新建对话框里自己敲命令是一回事，从搜索
结果里点一下是另一回事——点击的人未必知道自己触发了什么。远程条目不弹（代码
跑在对方机器上），精选条目不弹（已人工核过）。

搜索失败显示「搜不动」而不是吞成零结果——分不清「没有」和「没搜着」，用户会
以为这台 server 不存在。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: agent 侧回退注册表 + ADR

**Files:**
- Modify: `src/tools/mcpCatalog.ts:57-77`（`run` 方法）
- Create: `tests/tools/mcpCatalog.test.ts`
- Create: `docs/adr/0162-连接器目录分两层.md`

**Interfaces:**
- Consumes: `registrySearchUrl` / `mapRegistryResponse`（Task 1）、`world.http.getJson`（Task 2）
- Produces: 无（终点）

**注意**：`mcpCatalogTool.run` 当前签名是 `async run(args)`，不接 `world`。`Tool` 接口的 `run` 第二个参数是 `world: ExecutionWorld`（`src/tools/tool.ts:59`），改成 `async run(args, world)` 即可。`parallelSafe: true` 与 `requiresApproval: false` **保持不变**——查询仍是只读，没有副作用。

- [ ] **Step 1: 写失败的测试**

创建 `tests/tools/mcpCatalog.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { mcpCatalogTool } from "../../src/tools/mcpCatalog.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

function worldWith(getJson?: (url: string) => Promise<unknown>): ExecutionWorld {
  return {
    fs: {} as never,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    http: {
      postJson: async () => ({}),
      ...(getJson ? { getJson: async (url: string) => getJson(url) } : {}),
    },
  } as unknown as ExecutionWorld;
}

const REGISTRY_HIT = {
  servers: [
    {
      server: {
        name: "com.example/widgets",
        title: "Widgets",
        description: "管理 widget",
        version: "1.0.0",
        remotes: [{ type: "streamable-http", url: "https://widgets.example/mcp" }],
      },
      _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true } },
    },
  ],
};

describe("mcp_catalog", () => {
  it("精选命中就不打注册表", async () => {
    let called = false;
    const out = await mcpCatalogTool.run(
      { query: "supabase" },
      worldWith(async () => {
        called = true;
        return { servers: [] };
      })
    );
    expect(String(out)).toContain("Supabase");
    expect(called).toBe(false);
  });

  it("精选没命中就查注册表，结果里带上未核验的话", async () => {
    const out = String(await mcpCatalogTool.run({ query: "widgets" }, worldWith(async () => REGISTRY_HIT)));
    expect(out).toContain("Widgets");
    expect(out).toContain("https://widgets.example/mcp");
    expect(out).toContain("未经核验");
  });

  it("查询词进了 URL", async () => {
    let seen = "";
    await mcpCatalogTool.run(
      { query: "widgets" },
      worldWith(async (url) => {
        seen = url;
        return REGISTRY_HIT;
      })
    );
    expect(seen).toContain("search=widgets");
  });

  it("注册表也没有就退回 web_search 的话术", async () => {
    const out = String(
      await mcpCatalogTool.run({ query: "绝无此物xyzzy" }, worldWith(async () => ({ servers: [] })))
    );
    expect(out).toContain("web_search");
  });

  it("注册表打不通不抛，退回 web_search 的话术", async () => {
    const out = String(
      await mcpCatalogTool.run(
        { query: "绝无此物xyzzy" },
        worldWith(async () => {
          throw new Error("ENOTFOUND");
        })
      )
    );
    expect(out).toContain("web_search");
  });

  it("世界不提供 getJson 时不炸，退回 web_search 的话术", async () => {
    const out = String(await mcpCatalogTool.run({ query: "绝无此物xyzzy" }, worldWith()));
    expect(out).toContain("web_search");
  });
});
```

- [ ] **Step 2: 跑测试，确认它红**

```bash
npx vitest run tests/tools/mcpCatalog.test.ts
```

期望：后五条红（精选那条会绿——它不依赖新代码）。

- [ ] **Step 3: 改 run**

`src/tools/mcpCatalog.ts`，把 `async run(args) { ... }` 整块替换成：

```ts
  async run(args, world) {
    const q = (args as { query?: unknown } | null)?.query;
    const query = typeof q === "string" ? q : "";
    const hits = searchCatalog(query);
    if (hits.length > 0) {
      // 末尾这一句是 deferred 那两把刀的引子：它们不在初始工具表里，模型得先
      // 知道有这么两把才会去调（终审 A Critical——入口 direct 了，链条后半段
      // 也要在文案里点名，不能指望模型凭空想起来）
      return (
        hits.map(render).join("\n\n") +
        "\n\n下一步：调 mcp_configure 把它写进配置（会弹审批卡请用户确认）；" +
        "http 传输的通常还要再调一次 mcp_authorize 授权。"
      );
    }

    // 精选没命中 → 查公开注册表。原来这里直接叫模型去 web_search，而本文件
    // 顶部记着那个取舍的代价：web_search「每次多花几秒、还可能拿到错 URL」，
    // 而「让用户在审批卡上判断一个 URL 对不对，等于把认知负担又还给了用户」。
    // 注册表返回的是结构化配置，比从网页里读出来的 URL 准。
    const found = query === "" ? [] : await searchRegistry(world, query);
    if (found.length > 0) {
      return (
        found.slice(0, 8).map(render).join("\n\n") +
        "\n\n以上来自公开注册表（registry.modelcontextprotocol.io），**未经核验**——" +
        "任何人都可以往里投稿，同一个服务名下常有第三方包装的条目。" +
        "装之前把发布者说给用户听，让用户确认这是不是他要的那一台。" +
        "\n下一步：调 mcp_configure 把它写进配置（会弹审批卡请用户确认）；" +
        "http 传输的通常还要再调一次 mcp_authorize 授权。"
      );
    }

    return (
      `目录和公开注册表里都没有「${query}」。用 web_search 查一下它的 MCP server 地址` +
      `（关键词：<服务名> MCP server url），拿到之后再调 mcp_configure。`
    );
  },
```

在同文件 `render` 函数**之后**加这个私有 helper：

```ts
/** 查公开注册表。任何失败都吞成空数组——这是一条回退路径，它自己失败不该
    让整个工具调用失败；调用方拿到空数组会退到 web_search 那句话，链条不断。
    world.http.getJson 是可选字段（见 executionWorld.ts 的注释），缺席 =
    这个世界不提供 GET，同样退回 web_search */
async function searchRegistry(world: ExecutionWorld, query: string): Promise<CatalogEntry[]> {
  if (world.http.getJson === undefined) return [];
  try {
    return mapRegistryResponse(await world.http.getJson(registrySearchUrl(query)));
  } catch {
    return [];
  }
}
```

顶部 import 补：

```ts
import type { ExecutionWorld } from "../world/executionWorld.js";
import { mapRegistryResponse, registrySearchUrl } from "../shared/mcpRegistry.js";
```

（`CatalogEntry` 该文件已经 import 了。）

- [ ] **Step 4: 跑测试，确认它绿**

```bash
npx vitest run tests/tools/mcpCatalog.test.ts
```

期望：全部 PASS。

- [ ] **Step 5: 写 ADR**

先认领编号——合并前重新 fetch，若 `docs/adr/` 已经有 0162 就改成 `max + 1` 并在文件顶部加一行 `原为 ADR-0162`（项目 ADR-0074）：

```bash
git fetch origin && ls docs/adr/ | sed -n 's/^\([0-9]\{4\}\).*/\1/p' | sort -n | tail -1
```

创建 `docs/adr/0162-连接器目录分两层.md`，覆盖 spec 四、决策与理由的六节（4.1 分层与信任边界 / 4.2 live search / 4.3 stdio 确认卡 / 4.4 图标不外链 / 4.5 `world.http.getJson` / 4.6 agent 侧回退）。每节保留 spec 里的「被否掉的」与「推翻它的前提」——这两块才是 ADR 的价值，不是结论本身。同时记下计划期的两处细化（`getJson` 做成可选字段的理由；图标改成打进包的本地资源、砍掉远程代理子系统的理由）。

- [ ] **Step 6: 跑全门禁**

```bash
npm test
```

期望：exit 0。`tests/docs/adrNumbers.test.ts` 会抓撞号。

- [ ] **Step 7: 提交**

```bash
git add src/tools/mcpCatalog.ts tests/tools/mcpCatalog.test.ts docs/adr/
git commit -m "$(cat <<'EOF'
feat(mcp): mcp_catalog 精选没命中改为回退注册表（issue #661，ADR-0162）

原来的回退是「叫模型去 web_search」，而 shared/mcpCatalog.ts 的文件头自己
写着这个取舍的代价：web_search「每次多花几秒、还可能拿到错 URL」，且「让用户
在审批卡上判断一个 URL 对不对，等于把认知负担又还给了用户」。注册表返回的是
结构化配置，比从网页里读出来的 URL 准。这是对既有取舍的改进，不是新增一条路。

注册表的任何失败都吞成空数组：这是一条回退路径，它自己失败不该让整个工具调用
失败——拿到空数组就退到 web_search 那句话，链条不断。world.http.getJson 缺席
（世界不提供 GET）走同一条路。

工具仍 requiresApproval: false —— 查询是只读的，没有副作用；装依旧过
mcp_configure 的审批门（ADR-0118 不变）。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## 收尾（Task 6 之后）

- [ ] 开 PR，body 里写 `Closes #661`
- [ ] CI 绿了自己合（merge commit，不 squash 不 rebase）
- [ ] 合并前重新 `git fetch origin`，确认 ADR 编号没被别的 PR 抢走
- [ ] 按 AGENTS.md「On ending a shift」开交接 issue，Memory 五段式

## Self-Review

**Spec 覆盖**：

| spec 章节 | 落在哪 |
|---|---|
| 4.1 分两层 | Task 4（精选扩容）+ Task 5（`buildDirectory` 的 verified） |
| 4.2 live search | Task 3（`searchMcpRegistry` 不落盘） |
| 4.3 stdio 确认卡 | Task 5（`needsInstallConfirm` + Step 5 的确认文案） |
| 4.4 图标不外链 | Task 4（`icon` 是资源键）+ Task 5（色块兜底） |
| 4.5 `getJson` | Task 2 |
| 4.6 agent 侧回退 | Task 6 |
| 五、映射规则 | Task 1 |
| 五、`id` / `auth` / `authNote` 取法 | Task 1 Step 2 的三条断言 |
| 六、测试 | Task 1（映射 + 样本）、Task 4（精选断言）、Task 5（目录纯逻辑）、Task 6（工具） |
| 七、拆分 | Task 1 = PR1，Task 2 = PR2，Task 3-5 = PR3，Task 6 = PR4 |
| 八、不做的 | 全程未出现全量同步 / 热门度排序 / 分类筛选 / 抓 Anthropic 目录 |

**类型一致性**：`CatalogEntry`（Task 1 消费，Task 4 加 `icon?`）；`mapRegistryResponse` / `registrySearchUrl`（Task 1 产出，Task 3 与 Task 6 消费，名字一致）；`searchMcpRegistry`（Task 3 在 main / bridge / preload / store 四处同名）；`DirectoryItem` / `buildDirectory` / `needsInstallConfirm`（Task 5 内部自洽）。

**与 spec 的偏差**：两处，已在文首「与 spec 的两处细化」写明理由，Task 6 Step 5 要求把它们记进 ADR。
