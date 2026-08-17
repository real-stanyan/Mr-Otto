# web-search-v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 agent 加 `web_search` / `web_extract` 两个原生工具,anysearch 云 API 后端,网络能力经 ExecutionWorld 新 seam。

**Architecture:** ExecutionWorld 加 `http.postJson` capability(LocalWorld 用全局 fetch 实现);工具只碰 `world.http`,anysearch JSON-RPC 细节收在 `src/tools/anysearch.ts`;API key 经现有 keyVault(`ANYSEARCH_API_KEY`),工具通过主进程注入的 `getKey` 闭包拿 key,key 不进参数不进日志。

**Tech Stack:** TypeScript strict / vitest / 全局 fetch(不引任何新依赖)。

**Spec:** `docs/superpowers/specs/2026-08-17-web-search-design.md`

## Global Constraints

- 工具实现禁止 import fs / child_process / 直接用 fetch——只依赖 `ExecutionWorld`(AGENTS.md 硬规则)
- key 不进事件日志、不回流渲染层(渲染层只见布尔)
- SessionEvent schema 零变更(本 feature 只新增工具名,天然向后兼容)
- 测试放 `tests/` 镜像 `src/` 结构;不打真 anysearch API
- Gate = `npm test`(vitest + tsc),每个 Task 结束必须全绿
- 分支 `feat/web-search`,Task issue = GitHub #4

---

### Task 1: ExecutionWorld http seam + LocalWorld 实现

**Files:**
- Modify: `src/world/executionWorld.ts`(接口 + 两个装饰器)
- Modify: `src/world/localWorld.ts`
- Test: `tests/world/localWorld.test.ts`(追加)

**Interfaces:**
- Produces: `ExecutionWorld.http.postJson(url: string, body: unknown, opts?: HttpPostOptions): Promise<unknown>`,`HttpPostOptions = { headers?: Record<string, string>; signal?: AbortSignal }`;`createLocalWorld` 新可选项 `fetchImpl?: typeof fetch`(测试注入)

- [ ] **Step 1: 写失败测试**(追加到 `tests/world/localWorld.test.ts`)

```ts
describe("http.postJson", () => {
  const okResponse = (json: unknown) =>
    ({ ok: true, status: 200, json: async () => json, text: async () => "" }) as Response;

  it("POST JSON body,带 Content-Type 与自定义 header,返回解析后的 JSON", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return okResponse({ hello: "world" });
    }) as typeof fetch;
    const world = createLocalWorld({ fetchImpl });

    const out = await world.http.postJson("https://x.test/rpc", { a: 1 }, { headers: { Authorization: "Bearer k" } });

    expect(out).toEqual({ hello: "world" });
    expect(calls[0]!.url).toBe("https://x.test/rpc");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe(JSON.stringify({ a: 1 }));
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Authorization"]).toBe("Bearer k");
  });

  it("非 2xx 抛错并带状态码与响应片段", async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 429, json: async () => ({}), text: async () => "rate limited" }) as Response) as typeof fetch;
    const world = createLocalWorld({ fetchImpl });
    await expect(world.http.postJson("https://x.test/rpc", {})).rejects.toThrow(/429.*rate limited/s);
  });

  it("中断:signal abort 时 reject,不伪装成正常失败", async () => {
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init!.signal!.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError")));
      })) as unknown as typeof fetch;
    const world = createLocalWorld({ fetchImpl });
    const ac = new AbortController();
    const pending = world.http.postJson("https://x.test/rpc", {}, { signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toThrow(/中断/);
  });
});

describe("装饰器透传 http", () => {
  it("withAbortSignal 把 signal 焊进 http.postJson", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const base = createLocalWorld({
      fetchImpl: (async (_u: string | URL | Request, init?: RequestInit) => {
        seen.push(init?.signal ?? undefined);
        return { ok: true, status: 200, json: async () => ({}), text: async () => "" } as Response;
      }) as typeof fetch,
    });
    const ac = new AbortController();
    const world = withAbortSignal(base, ac.signal);
    await world.http.postJson("https://x.test/rpc", {});
    expect(seen[0]).toBeDefined(); // signal 已注入(实现里可能是 AbortSignal.any 的合成信号)
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npx vitest run tests/world/localWorld.test.ts`
Expected: FAIL——`http` 不存在 / `fetchImpl` 未知选项(tsc 报错也算失败)

- [ ] **Step 3: 实现接口与 LocalWorld**

`src/world/executionWorld.ts` 追加:

```ts
export interface HttpPostOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}
```

`ExecutionWorld` 接口加:

```ts
  /** JSON POST——工具的全部网络面。v1 LocalWorld 用 fetch;v2 Docker 按 bot 走代理/断网 */
  http: {
    postJson(url: string, body: unknown, opts?: HttpPostOptions): Promise<unknown>;
  };
```

`withAbortSignal` 改为(http 一并焊 signal;工具无感):

```ts
export function withAbortSignal(world: ExecutionWorld, signal: AbortSignal): ExecutionWorld {
  return {
    fs: world.fs,
    exec: (cmd, opts) => world.exec(cmd, { ...opts, signal }),
    http: {
      postJson: (url, body, opts) => world.http.postJson(url, body, { ...opts, signal }),
    },
  };
}
```

`withExecOutput` 加一行 `http: world.http,`(直播与网络无关,原样透传)。

`src/world/localWorld.ts`:`createLocalWorld(opts: { root?: string; fetchImpl?: typeof fetch } = {})`,返回对象加:

```ts
    http: {
      async postJson(url, body, o) {
        const fetchImpl = opts.fetchImpl ?? fetch;
        // 30s 超时与外部中断信号合并;两者都能掐死请求
        const timeout = AbortSignal.timeout(30_000);
        const signal = o?.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
        let res: Response;
        try {
          res = await fetchImpl(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...o?.headers },
            body: JSON.stringify(body),
            signal,
          });
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
    },
```

注意:接口新增成员会让所有实现/假 world 编译报错——本仓库其他假 world 在 `tests/` 里,tsc 会点名,逐个补 `http`(测试里补 `http: { postJson: async () => ({}) }` 即可)。

- [ ] **Step 4: 跑测确认通过**

Run: `npx vitest run tests/world/localWorld.test.ts` 然后 `npm test`
Expected: 全 PASS(npm test 里 tsc 会揪出所有漏补 http 的假 world,补完再跑)

- [ ] **Step 5: Commit**

```bash
git add src/world/ tests/
git commit -m "feat: ExecutionWorld 加 http.postJson seam——网络成为 capability

工具层拿网络只能经 world.http,v2 Docker 时可按 bot 隔离出站。
withAbortSignal 一并焊进 http:搜索请求随 turn 中断。"
```

---

### Task 2: anysearch 客户端 + web_search / web_extract 工具

**Files:**
- Create: `src/tools/anysearch.ts`(JSON-RPC 组装/解析,两工具共用)
- Create: `src/tools/webSearch.ts`
- Create: `src/tools/webExtract.ts`
- Test: `tests/tools/webSearch.test.ts`

**Interfaces:**
- Consumes: `world.http.postJson`(Task 1)
- Produces: `createWebSearchTool(getKey: () => string | undefined): Tool`、`createWebExtractTool(getKey: () => string | undefined): Tool`(Task 3 在 agent.ts 调用);工具名 `web_search` / `web_extract`

- [ ] **Step 1: 写失败测试**(`tests/tools/webSearch.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { createWebSearchTool } from "../../src/tools/webSearch.js";
import { createWebExtractTool } from "../../src/tools/webExtract.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

/** 假 world:只录 http 调用,返回 canned 响应 */
function fakeWorld(response: unknown) {
  const calls: { url: string; body: unknown; headers: Record<string, string> | undefined }[] = [];
  const world: ExecutionWorld = {
    fs: { read: async () => "", write: async () => {} },
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    http: {
      postJson: async (url, body, opts) => {
        calls.push({ url, body, headers: opts?.headers });
        return response;
      },
    },
  };
  return { world, calls };
}

const ok = (texts: string[]) => ({
  result: { content: texts.map((t) => ({ type: "text", text: t })) },
});

describe("web_search", () => {
  it("组装 JSON-RPC tools/call 并拼接 content 文本", async () => {
    const { world, calls } = fakeWorld(ok(["结果A", "结果B"]));
    const tool = createWebSearchTool(() => undefined);
    const out = await tool.run({ query: "electron ipc", max_results: 3 }, world);

    expect(out).toBe("结果A\n\n结果B");
    expect(calls[0]!.url).toBe("https://api.anysearch.com/mcp");
    expect(calls[0]!.body).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "search", arguments: { query: "electron ipc", max_results: 3 } },
    });
  });

  it("无 key 匿名(不带 Authorization);有 key 带 Bearer", async () => {
    const anon = fakeWorld(ok(["x"]));
    await createWebSearchTool(() => undefined).run({ query: "q" }, anon.world);
    expect(anon.calls[0]!.headers?.["Authorization"]).toBeUndefined();

    const keyed = fakeWorld(ok(["x"]));
    await createWebSearchTool(() => "as_sk_test").run({ query: "q" }, keyed.world);
    expect(keyed.calls[0]!.headers?.["Authorization"]).toBe("Bearer as_sk_test");
  });

  it("max_results 缺省 5,越界(0 / 11 / 非整数)抛错", async () => {
    const { world, calls } = fakeWorld(ok(["x"]));
    const tool = createWebSearchTool(() => undefined);
    await tool.run({ query: "q" }, world);
    expect(
      (calls[0]!.body as { params: { arguments: { max_results: number } } }).params.arguments.max_results
    ).toBe(5);
    await expect(tool.run({ query: "q", max_results: 0 }, world)).rejects.toThrow(/max_results/);
    await expect(tool.run({ query: "q", max_results: 11 }, world)).rejects.toThrow(/max_results/);
    await expect(tool.run({ query: "q", max_results: 2.5 }, world)).rejects.toThrow(/max_results/);
  });

  it("query 空/非字符串抛错", async () => {
    const { world } = fakeWorld(ok(["x"]));
    const tool = createWebSearchTool(() => undefined);
    await expect(tool.run({ query: "" }, world)).rejects.toThrow(/query/);
    await expect(tool.run({}, world)).rejects.toThrow(/query/);
  });

  it("JSON-RPC error 响应抛错;content 缺失/无文本抛错", async () => {
    const errWorld = fakeWorld({ error: { message: "quota exceeded" } });
    await expect(createWebSearchTool(() => undefined).run({ query: "q" }, errWorld.world)).rejects.toThrow(
      /quota exceeded/
    );
    const emptyWorld = fakeWorld({ result: { content: [] } });
    await expect(createWebSearchTool(() => undefined).run({ query: "q" }, emptyWorld.world)).rejects.toThrow(
      /没有.*文本|无.*内容|响应/
    );
  });

  it("不需要审批(纯读,与 read_file 同级)", () => {
    expect(createWebSearchTool(() => undefined).requiresApproval).toBe(false);
    expect(createWebExtractTool(() => undefined).requiresApproval).toBe(false);
  });
});

describe("web_extract", () => {
  it("组装 extract 调用并返回 markdown 文本", async () => {
    const { world, calls } = fakeWorld(ok(["# 页面标题\n\n正文"]));
    const tool = createWebExtractTool(() => undefined);
    const out = await tool.run({ url: "https://example.com/a" }, world);
    expect(out).toBe("# 页面标题\n\n正文");
    expect(calls[0]!.body).toMatchObject({
      params: { name: "extract", arguments: { url: "https://example.com/a" } },
    });
  });

  it("url 空/非 http(s) 抛错", async () => {
    const { world } = fakeWorld(ok(["x"]));
    const tool = createWebExtractTool(() => undefined);
    await expect(tool.run({ url: "" }, world)).rejects.toThrow(/url/);
    await expect(tool.run({ url: "file:///etc/passwd" }, world)).rejects.toThrow(/url/);
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npx vitest run tests/tools/webSearch.test.ts`
Expected: FAIL——模块不存在

- [ ] **Step 3: 实现**

`src/tools/anysearch.ts`:

```ts
// anysearch — web_search / web_extract 共用的云端 JSON-RPC 客户端。
// anysearch 只是后端插头:换 SearXNG/Tavily 只改这个文件,工具名/参数/日志不动(spec)。
// key 经主进程注入的闭包进来,不进工具参数——参数会落事件日志,key 进去 = 永久泄漏。

import type { ExecutionWorld } from "../world/executionWorld.js";

export const ANYSEARCH_ENDPOINT = "https://api.anysearch.com/mcp";

export type GetKey = () => string | undefined;

interface RpcResponse {
  result?: { content?: { type?: string; text?: string }[] };
  error?: { message?: string };
}

export async function callAnysearch(
  world: ExecutionWorld,
  tool: "search" | "extract",
  args: Record<string, unknown>,
  getKey: GetKey
): Promise<string> {
  const key = getKey();
  const headers: Record<string, string> = { "X-Anysearch-Client": "otter/0.1" };
  if (key) headers["Authorization"] = `Bearer ${key}`;

  const data = (await world.http.postJson(
    ANYSEARCH_ENDPOINT,
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } },
    { headers }
  )) as RpcResponse;

  if (data.error) throw new Error(`anysearch 报错: ${data.error.message ?? "未知错误"}`);
  const texts = (data.result?.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text!);
  if (texts.length === 0) throw new Error("anysearch 响应里没有文本内容");
  return texts.join("\n\n");
}
```

`src/tools/webSearch.ts`:

```ts
// web_search — 联网搜索。纯读不落地,不需要审批(与 read_file 同级)。

import type { Tool } from "./tool.js";
import { callAnysearch, type GetKey } from "./anysearch.js";

export function createWebSearchTool(getKey: GetKey): Tool {
  return {
    def: {
      name: "web_search",
      description: "联网搜索。返回适合直接阅读的文本结果(含标题/摘要/链接)",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词" },
          max_results: { type: "number", description: "结果条数,1-10,默认 5" },
        },
        required: ["query"],
      },
    },
    requiresApproval: false,

    async run(args, world) {
      const { query, max_results } = args as { query?: unknown; max_results?: unknown };
      if (typeof query !== "string" || query.length === 0) {
        throw new Error("web_search: 参数 query 必须是非空字符串");
      }
      const n = max_results === undefined ? 5 : max_results;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 10) {
        throw new Error("web_search: max_results 必须是 1-10 的整数");
      }
      return callAnysearch(world, "search", { query, max_results: n }, getKey);
    },
  };
}
```

`src/tools/webExtract.ts`:

```ts
// web_extract — 抓整页正文转 markdown。纯读不落地,不需要审批。

import type { Tool } from "./tool.js";
import { callAnysearch, type GetKey } from "./anysearch.js";

export function createWebExtractTool(getKey: GetKey): Tool {
  return {
    def: {
      name: "web_extract",
      description: "抓取网页完整正文,转成 markdown 返回。搜索结果的摘要不够时用它读全文",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "http(s) 网址" },
        },
        required: ["url"],
      },
    },
    requiresApproval: false,

    async run(args, world) {
      const { url } = args as { url?: unknown };
      if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
        throw new Error("web_extract: 参数 url 必须是 http(s) 网址");
      }
      return callAnysearch(world, "extract", { url }, getKey);
    },
  };
}
```

- [ ] **Step 4: 跑测确认通过**

Run: `npx vitest run tests/tools/webSearch.test.ts` 然后 `npm test`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/anysearch.ts src/tools/webSearch.ts src/tools/webExtract.ts tests/tools/webSearch.test.ts
git commit -m "feat: web_search / web_extract 工具——anysearch JSON-RPC 后端

工厂函数收 getKey 闭包:key 由主进程注入,不进工具参数(参数落日志,
key 进去 = 永久泄漏)。anysearch 细节收在一个文件,后端可整体替换。"
```

---

### Task 3: 主进程接线 + key 白名单 + KeysPage 行

**Files:**
- Modify: `src/main/agent.ts:9-11`(import)与 `:124`(tools 数组)
- Modify: `src/main/index.ts:232`(allowedKeyEnvs)
- Modify: `src/renderer/src/App.tsx`(KeysPage,~line 610)

**Interfaces:**
- Consumes: `createWebSearchTool` / `createWebExtractTool`(Task 2)、现有 `KeyRow` 组件、keyVault 管线(零改动)

- [ ] **Step 1: agent.ts 接线**

import 区加:

```ts
import { createWebSearchTool } from "../tools/webSearch.js";
import { createWebExtractTool } from "../tools/webExtract.js";
```

tools 数组处(现 `tools: [readFileTool, writeFileTool, bashTool],`)改为:

```ts
    // anysearch key 每次调用现读 env:设置页保存即生效,不用重建 agent
    tools: [
      readFileTool,
      writeFileTool,
      bashTool,
      createWebSearchTool(() => process.env["ANYSEARCH_API_KEY"]),
      createWebExtractTool(() => process.env["ANYSEARCH_API_KEY"]),
    ],
```

- [ ] **Step 2: index.ts key 白名单**

`const allowedKeyEnvs = new Set(MODEL_CATALOG.map((m) => m.apiKeyEnv));` 改为:

```ts
  const allowedKeyEnvs = new Set([...MODEL_CATALOG.map((m) => m.apiKeyEnv), "ANYSEARCH_API_KEY"]);
```

(keyStatus 循环遍历这个 Set——加进白名单,状态布尔自动带上,渲染层零额外接线。)

- [ ] **Step 3: KeysPage 加一行**

`{providers.map(...)}` 之后追加:

```tsx
        <KeyRow envName="ANYSEARCH_API_KEY" label="AnySearch(搜索)" />
```

- [ ] **Step 4: 跑 gate + 真机冒烟**

Run: `npm test`
Expected: 全 PASS

真机(按内存规矩先杀旧实例):`pkill -9 -f "Github/Otter.*[Ee]lectron"` 后 `npm run dev`,验:
1. 设置页「模型配置」出现「AnySearch(搜索)」行,粘 key 保存,状态变「已配置」
2. 新会话问「搜一下 Electron 38 的发布说明」——模型调 `web_search`,工具卡片无审批直接执行,结果可读
3. 让模型 `web_extract` 某条结果链接,返回 markdown 正文
4. turn 进行中点停止,搜索请求随之中断,tool_result 落 error

- [ ] **Step 5: Commit**

```bash
git add src/main/agent.ts src/main/index.ts src/renderer/src/App.tsx
git commit -m "feat: 接线 web_search/web_extract + ANYSEARCH_API_KEY 进 keyVault 白名单

key 走既有 keyVault 管线(0600 文件、布尔回流、白名单挡渲染层写任意 env),
工具经闭包现读 env——设置页保存即生效。"
```

---

### Task 4: ADR 0008 + 收尾

**Files:**
- Create: `docs/adr/0008-executionworld-http-seam.md`

**Interfaces:** 无——纯文档。

- [ ] **Step 1: 写 ADR**

```markdown
# 0008. ExecutionWorld 网络 seam 与可替换搜索后端

日期:2026-08-17　状态:已接受

## 背景

web_search/web_extract 需要出站 HTTP。硬规则:工具只依赖 ExecutionWorld,
不得直接触碰 Node API——网络若绕过 seam,v2 Docker 化时无法按 bot 管控出站。

## 决定

1. ExecutionWorld 加 `http.postJson(url, body, { headers?, signal? })`:
   工具的全部网络面。LocalWorld 用全局 fetch + 30s 超时;withAbortSignal
   一并焊 signal(中断语义对齐 exec,ADR-0006:外力中断必须 reject,
   不伪装成请求自身失败)。
2. 搜索后端 = anysearch 云 API(JSON-RPC,不可自托管,两个官方仓库均为
   客户端)。协议细节收在 src/tools/anysearch.ts 一个文件——换
   SearXNG/Tavily 只改它,工具名/参数/事件日志/UI 不动。
3. key 经 keyVault(ANYSEARCH_API_KEY)注入工厂闭包,不进工具参数:
   参数落事件日志,日志不可删,key 进去 = 永久泄漏。匿名可用(低限额)。

## 否决

- postJson 泛化成完整 HTTP client(method/stream):YAGNI,当前唯一
  消费者是 JSON-RPC,面越小 v2 越好管。
- 装 anysearch-skill 为 otter skill:SKILL.md 常驻上下文、每次搜索过
  bash 审批、依赖 python 环境(spec「已否决的备选」)。

## 代价

- 匿名限额未知,撞墙表现为工具报错,模型可见可重试;换 key/换后端均不动上层。
- http seam 出现让「工具能碰的世界」多了一维,v2 SandboxWorld 必须实现它
  (断网 bot = postJson 直接 reject)。
```

- [ ] **Step 2: Commit + push + PR**

```bash
git add docs/adr/0008-executionworld-http-seam.md
git commit -m "docs: ADR-0008 ExecutionWorld http seam + 可替换搜索后端"
git push -u origin feat/web-search
gh pr create --title "feat: web_search/web_extract 原生工具(anysearch 后端)" --body "closes #4

spec: docs/superpowers/specs/2026-08-17-web-search-design.md
ADR: docs/adr/0008-executionworld-http-seam.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

CI 绿后按 AGENTS.md 合并(merge commit,作者自合)。
