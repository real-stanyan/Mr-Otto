# MCP OAuth 授权 + agent 自助配置 MCP —— 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `needs-auth` 的 MCP server 有一颗能点的「授权」按钮，并让 agent 能在对话里查目录、提议配置、过审批门落盘、拉起授权，配完当场就能用新工具。

**Architecture:** OAuth 协议本身交给 `@modelcontextprotocol/sdk` 1.30.0 的 `authProvider`（发现 / DCR / PKCE / 换 token / 刷新它全做了）；本仓只补两样——一个把凭据存进 `~/.mr-otto/mcp-auth.json` 的 `OAuthClientProvider` 实现，和一个收回调 code 的 loopback 服务器。agent 侧加三把刀（查目录 / 配置 / 授权），配置那把过审批门。`LoopEngine` 的工具表从「构造时冻死」改成「每 turn 重算、turn 内冻结」，新 server 才能当场生效。

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`) / Electron 主进程 / `@modelcontextprotocol/sdk` 1.30.0 / vitest / React + Tailwind + shadcn/ui（渲染层）

**Spec:** `docs/superpowers/specs/2026-08-26-mcp-oauth-agent-config-design.md`

## Global Constraints

- **测试统一放 `tests/`，镜像 `src/` 结构**，不与源码同目录（AGENTS.md 技术栈）。
- **`@modelcontextprotocol/sdk` 只允许 `src/main/mcpClient.ts` import**（ADR-0050，由 `tests/architecture.test.ts:90` 断言）。新模块一律不 import SDK。
- **工具实现（`src/tools/*`）只依赖 `ExecutionWorld` 接口，禁止直接 import `fs` / `child_process`**（AGENTS.md 硬规则，由 `tests/architecture.test.ts` 断言）。
- **凭据不进事件日志、不回流渲染层**；过桥的配置一律先过 `maskMcpConfig`（ADR-0044）。
- **门禁命令：`npm test`**（= `tsc --noEmit` + `vitest run`）。每个 Task 的最后一步提交前必须全绿。
- TypeScript 开了 `exactOptionalPropertyTypes`：可选字段要用 `...(x !== undefined ? { k: x } : {})` 的写法条件展开，不能直接赋 `undefined`。
- 注释和用户可见文案用中文，与仓内既有风格一致。
- 提交信息说清 **why**，不只是 what。

---

### Task 1: OAuth 凭据存储（`mcpAuthStore.ts`）

**Files:**
- Create: `src/main/mcpAuthStore.ts`
- Test: `tests/main/mcpAuthStore.test.ts`

**Interfaces:**
- Consumes: 无（本计划的第一块）
- Produces:
  - `interface McpAuthRecord { clientInformation?: Record<string, unknown>; tokens?: Record<string, unknown>; codeVerifier?: string }`
  - `type McpAuthFile = Record<string, McpAuthRecord>`
  - `loadMcpAuth(path: string): McpAuthFile`
  - `readMcpAuth(path: string, id: string): McpAuthRecord`
  - `writeMcpAuth(path: string, id: string, patch: Partial<McpAuthRecord>): McpAuthFile`
  - `clearMcpAuth(path: string, id: string): McpAuthFile`

- [ ] **Step 1: 写失败的测试**

创建 `tests/main/mcpAuthStore.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpAuth, readMcpAuth, writeMcpAuth, clearMcpAuth } from "../../src/main/mcpAuthStore.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-auth-"));
  path = join(dir, "sub", "mcp-auth.json");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("mcpAuthStore", () => {
  it("没有文件时读出空表——「还没授权过」不是错误", () => {
    expect(loadMcpAuth(path)).toEqual({});
    expect(readMcpAuth(path, "supabase")).toEqual({});
  });

  it("坏 JSON 当「还没授权过」，不抛", () => {
    writeFileSync(join(dir, "broken.json"), "{ 这不是 JSON");
    expect(loadMcpAuth(join(dir, "broken.json"))).toEqual({});
  });

  it("顶层不是对象（数组/字符串）也当空表", () => {
    writeFileSync(join(dir, "arr.json"), "[1,2,3]");
    expect(loadMcpAuth(join(dir, "arr.json"))).toEqual({});
  });

  it("部分更新不擦掉上一步存的字段——SDK 分三次回调落盘", () => {
    writeMcpAuth(path, "supabase", { clientInformation: { client_id: "c1" } });
    writeMcpAuth(path, "supabase", { codeVerifier: "v1" });
    writeMcpAuth(path, "supabase", { tokens: { access_token: "a1" } });
    expect(readMcpAuth(path, "supabase")).toEqual({
      clientInformation: { client_id: "c1" },
      codeVerifier: "v1",
      tokens: { access_token: "a1" },
    });
  });

  it("刷新覆盖旧 token", () => {
    writeMcpAuth(path, "supabase", { tokens: { access_token: "old" } });
    writeMcpAuth(path, "supabase", { tokens: { access_token: "new" } });
    expect(readMcpAuth(path, "supabase").tokens).toEqual({ access_token: "new" });
  });

  it("文件权限 0600——里面是凭据，与 keys.json 同档", () => {
    writeMcpAuth(path, "supabase", { tokens: { access_token: "a1" } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("已存在的文件也补一刀 chmod（writeFileSync 的 mode 只在新建时生效）", () => {
    writeMcpAuth(path, "a", { codeVerifier: "v" });
    // 模拟外部把权限放宽
    const { chmodSync } = require("node:fs") as typeof import("node:fs");
    chmodSync(path, 0o644);
    writeMcpAuth(path, "a", { codeVerifier: "v2" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("清一台不误伤同伴", () => {
    writeMcpAuth(path, "a", { codeVerifier: "va" });
    writeMcpAuth(path, "b", { codeVerifier: "vb" });
    clearMcpAuth(path, "a");
    expect(readMcpAuth(path, "a")).toEqual({});
    expect(readMcpAuth(path, "b")).toEqual({ codeVerifier: "vb" });
  });

  it("父目录不存在时自己建出来", () => {
    writeMcpAuth(path, "a", { codeVerifier: "v" });
    expect(existsSync(path)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/main/mcpAuthStore.test.ts`
Expected: FAIL —— `Failed to resolve import "../../src/main/mcpAuthStore.js"`

- [ ] **Step 3: 写实现**

创建 `src/main/mcpAuthStore.ts`：

```ts
// MCP OAuth 凭据的唯一落点：userData/mcp-auth.json（0600）。
// 与 mcp.json 分家的理由（spec §3.3）：mcp.json 要与 Claude Code 的 .mcp.json
// 格式兼容（用户能把已有配置直接粘过来、也会手编它），而 OAuth token 是
// 程序拥有、会被定期自动刷新重写的状态。把"用户手写的配置"和"程序频繁改写
// 的状态"混在一个文件里，两边都会出问题。
//
// 三条不变量抄 keyVault.ts：token 不进事件日志（日志不可删，进去 = 永久泄漏）、
// 不从主进程回流渲染层（渲染层只能问"这台授权了没"）、文件只属当前用户可读写。
// 主进程组装根特权：允许直接摸 fs（工具层的 fs 禁令不覆盖这里）。

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

/** 一台 server 的 OAuth 家当。三个字段分别对应 SDK 的三个 save* 回调。
    值类型故意宽（Record<string, unknown>）：这一层不认识 SDK 的
    OAuthTokens / OAuthClientInformation，那两个类型只在 mcpClient.ts 里
    出现（ADR-0050 的 SDK 单点 import 约束）。两边都是普通 JSON 对象，
    适配就是 mcpClient 那一处结构性赋值。 */
export interface McpAuthRecord {
  clientInformation?: Record<string, unknown>;
  tokens?: Record<string, unknown>;
  codeVerifier?: string;
}

export type McpAuthFile = Record<string, McpAuthRecord>;

export function loadMcpAuth(path: string): McpAuthFile {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    // 顶层必须是普通对象。数组/字符串/null 都当"还没授权过"——
    // 一份被写坏的文件不该让授权流程整个抛死，用户重新授权一次就能修好
    return raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as McpAuthFile)
      : {};
  } catch {
    return {}; // 没有文件 / 坏 JSON = 还没授权过（同 keyVault.loadKeys 的口径）
  }
}

export function readMcpAuth(path: string, id: string): McpAuthRecord {
  return loadMcpAuth(path)[id] ?? {};
}

/** 部分更新一台 server 的记录。patch 里没提的字段原样保留 —— SDK 分三次
    回调落盘（先 saveClientInformation、再 saveCodeVerifier、最后 saveTokens），
    每次都整条覆盖会把上一步刚存的擦掉，授权流程会在换 token 那步找不到
    code_verifier 而失败。 */
export function writeMcpAuth(path: string, id: string, patch: Partial<McpAuthRecord>): McpAuthFile {
  const all = loadMcpAuth(path);
  all[id] = { ...all[id], ...patch };
  persist(path, all);
  return all;
}

/** 清一台（删除 server、或用户点"重新授权"时）。同伴的记录不动 */
export function clearMcpAuth(path: string, id: string): McpAuthFile {
  const all = loadMcpAuth(path);
  delete all[id];
  persist(path, all);
  return all;
}

function persist(path: string, all: McpAuthFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(all, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600); // mode 只在新建时生效，已有文件补一刀（同 keyVault）
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/main/mcpAuthStore.test.ts`
Expected: PASS（9 条）

- [ ] **Step 5: 跑门禁**

Run: `npm test`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add src/main/mcpAuthStore.ts tests/main/mcpAuthStore.test.ts
git commit -m "feat(mcp): OAuth 凭据落到独立的 mcp-auth.json（0600）

token 不能混进 mcp.json：那份文件要与 Claude Code 的 .mcp.json 格式兼容、
且用户会手编它，而 OAuth token 是程序拥有、会被定期刷新重写的状态。

writeMcpAuth 做部分更新而不是整条覆盖，是因为 SDK 分三次回调落盘
（client 信息 / code_verifier / tokens），整条覆盖会让换 token 那步
找不到上一步刚存的 verifier。"
```

---

### Task 2: loopback 回调服务器（`mcpOAuth.ts`）

**Files:**
- Create: `src/main/mcpOAuth.ts`
- Test: `tests/main/mcpOAuth.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface LoopbackCallback { readonly redirectUri: string; readonly state: string; waitForCode(timeoutMs: number): Promise<string>; close(): void }`
  - `startLoopback(): Promise<LoopbackCallback>`
  - `const AUTH_TIMEOUT_MS = 300_000`

- [ ] **Step 1: 写失败的测试**

创建 `tests/main/mcpOAuth.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { startLoopback, AUTH_TIMEOUT_MS } from "../../src/main/mcpOAuth.js";

/** 拿真 http 打一次回调——loopback 的价值全在"真能被浏览器访问到" */
async function hit(uri: string, params: Record<string, string>): Promise<number> {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  await res.text();
  return res.status;
}

describe("startLoopback", () => {
  it("redirectUri 指向 127.0.0.1 的一个真端口，路径是 /callback", async () => {
    const cb = await startLoopback();
    try {
      const u = new URL(cb.redirectUri);
      expect(u.hostname).toBe("127.0.0.1");
      expect(u.pathname).toBe("/callback");
      expect(Number(u.port)).toBeGreaterThan(0);
    } finally { cb.close(); }
  });

  it("state 匹配 + 带 code = 拿到授权码", async () => {
    const cb = await startLoopback();
    const waiting = cb.waitForCode(AUTH_TIMEOUT_MS);
    await hit(cb.redirectUri, { state: cb.state, code: "abc123" });
    await expect(waiting).resolves.toBe("abc123");
  });

  it("回调早于 waitForCode 到达也不丢——connect() 开完浏览器才轮到我们等", async () => {
    const cb = await startLoopback();
    await hit(cb.redirectUri, { state: cb.state, code: "early" });
    await expect(cb.waitForCode(AUTH_TIMEOUT_MS)).resolves.toBe("early");
  });

  it("state 对不上必须拒绝——SDK 的 finishAuth 只收 code、不验 state", async () => {
    const cb = await startLoopback();
    const waiting = cb.waitForCode(AUTH_TIMEOUT_MS);
    await hit(cb.redirectUri, { state: "别人的state", code: "abc123" });
    await expect(waiting).rejects.toThrow(/state/);
  });

  it("授权服务器回 error 时给人话，而不是干等到超时", async () => {
    const cb = await startLoopback();
    const waiting = cb.waitForCode(AUTH_TIMEOUT_MS);
    await hit(cb.redirectUri, { state: cb.state, error: "access_denied", error_description: "用户点了拒绝" });
    await expect(waiting).rejects.toThrow(/access_denied/);
  });

  it("回调里没有 code 也不干等", async () => {
    const cb = await startLoopback();
    const waiting = cb.waitForCode(AUTH_TIMEOUT_MS);
    await hit(cb.redirectUri, { state: cb.state });
    await expect(waiting).rejects.toThrow(/code/);
  });

  it("收完一次立刻关端口——不留长期监听的本地口子", async () => {
    const cb = await startLoopback();
    const waiting = cb.waitForCode(AUTH_TIMEOUT_MS);
    await hit(cb.redirectUri, { state: cb.state, code: "abc" });
    await waiting;
    await expect(hit(cb.redirectUri, { state: cb.state, code: "abc" })).rejects.toThrow();
  });

  it("超时后 reject 并关端口", async () => {
    const cb = await startLoopback();
    await expect(cb.waitForCode(50)).rejects.toThrow(/超时/);
    await expect(hit(cb.redirectUri, { state: cb.state, code: "abc" })).rejects.toThrow();
  });

  it("两次 startLoopback 拿到不同的 state", async () => {
    const a = await startLoopback();
    const b = await startLoopback();
    try { expect(a.state).not.toBe(b.state); } finally { a.close(); b.close(); }
  });

  it("close() 之后端口就不通了", async () => {
    const cb = await startLoopback();
    cb.close();
    await expect(hit(cb.redirectUri, { state: cb.state, code: "abc" })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/main/mcpOAuth.test.ts`
Expected: FAIL —— 解析不到 `../../src/main/mcpOAuth.js`

- [ ] **Step 3: 写实现**

创建 `src/main/mcpOAuth.ts`：

```ts
// MCP OAuth 的 loopback 回调 —— 授权码从浏览器回到主进程的那一段路。
//
// 零 SDK import（ADR-0050 的单点约束）：OAuth 协议本身（元数据发现、动态
// 客户端注册、PKCE、code 换 token、refresh 续期）由 SDK 的 authProvider 走完，
// 这里只解决两个 SDK 不管的问题——"code 怎么从浏览器回来"，以及"回来的
// 这一次是不是我们发出去的那一次"。
//
// 为什么是 loopback 而不是 mrotto:// 深链（spec §3.2）：RFC 8252 的标准做法，
// 动态客户端注册时服务端对 http://127.0.0.1 的 redirect_uri 几乎都接受，
// 而自定义 scheme 有一部分服务端直接拒绝。

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

/** 等授权的上限。人要在浏览器里登录、可能还要选组织、再点同意——
    一分钟根本不够，五分钟是"正常人走完这套"的宽松上界 */
export const AUTH_TIMEOUT_MS = 5 * 60_000;

export interface LoopbackCallback {
  /** redirect_uri，交给 OAuthClientProvider.redirectUrl */
  readonly redirectUri: string;
  /** 这一次授权的 state，交给 OAuthClientProvider.state() */
  readonly state: string;
  /** 等浏览器回调。校验 state；服务端回错误时抛人话。无论成败都关端口 */
  waitForCode(timeoutMs: number): Promise<string>;
  /** 提前放弃（上游抛了别的错、用户取消） */
  close(): void;
}

type Settled = { code: string } | { error: string };

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function startLoopback(): Promise<LoopbackCallback> {
  // 128 位随机。这串同时交给 provider.state() 和下面的校验，
  // 是"这次回调确实来自我们发起的那次授权"的唯一凭据
  const state = randomBytes(16).toString("hex");

  // 回调可能早于 waitForCode 到达：真实时序是 client.connect() 先开浏览器、
  // 抛 UnauthorizedError，调用方接住之后才轮到 waitForCode——中间这段窗口
  // 里用户完全可能已经点完同意了。没有这个缓冲就会丢掉那次回调，然后干等
  // 到超时（一个只在"用户手速快"时复现的 bug，最难查）
  let pending: Settled | null = null;
  let settle: ((r: Settled) => void) | null = null;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const q = url.searchParams;
    const reply = (text: string): void => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Mr Otto</title>` +
          `<body style="font:16px/1.6 system-ui;padding:3rem;max-width:32rem">${text}</body>`
      );
    };
    const done = (r: Settled): void => {
      if (settle) settle(r);
      else pending = r;
    };

    // state 不匹配 = 这次回调不是我们发出去的那一次。SDK 的 finishAuth(code)
    // 只收 code、不验 state，所以这道闸只能长在这里——它是 loopback 回调
    // 唯一的防伪造措施（本地端口对同机任何进程都是开着的）
    if (q.get("state") !== state) {
      reply("这次回调的 state 对不上，已拒绝。请回到 Mr Otto 重新发起授权。");
      done({ error: "回调的 state 与本次授权不匹配（可能是伪造的回调，或上一次授权的残留）" });
      return;
    }
    const err = q.get("error");
    if (err !== null) {
      const desc = q.get("error_description");
      reply(`授权未完成：${escapeHtml(err)}。可以关掉这个页面了。`);
      done({ error: `授权服务器拒绝了这次请求：${err}${desc !== null ? `（${desc}）` : ""}` });
      return;
    }
    const code = q.get("code");
    if (code === null || code === "") {
      reply("回调里没有授权码，已放弃。");
      done({ error: "回调里没有 code 参数，这次授权没有完成" });
      return;
    }
    reply("授权完成，回到 Mr Otto 继续。");
    done({ code });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // 端口 0 = 让系统挑一个空闲口；只绑 127.0.0.1，不对外
    server.listen(0, "127.0.0.1", () => { resolve(); });
  });

  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    server.close();
    throw new Error("loopback 回调端口起不来，无法发起 OAuth 授权");
  }
  const redirectUri = `http://127.0.0.1:${addr.port}/callback`;

  const close = (): void => {
    settle = null;
    server.close();
    // 已经建立的 keep-alive 连接不会被 close() 掐断，浏览器那条常常还挂着。
    // 不断开的话进程退不干净，测试里"关了之后应该连不上"也会偶发不成立
    server.closeAllConnections?.();
  };

  return {
    redirectUri,
    state,
    close,
    waitForCode(timeoutMs) {
      return new Promise<string>((resolve, reject) => {
        const finish = (r: Settled): void => {
          // 只收一次：收完立刻关端口
          close();
          if ("code" in r) resolve(r.code);
          else reject(new Error(r.error));
        };
        if (pending !== null) { finish(pending); return; }
        const timer = setTimeout(() => {
          close();
          reject(new Error(`等授权超时（${Math.round(timeoutMs / 1000)} 秒没等到浏览器回调）`));
        }, timeoutMs);
        settle = (r) => { clearTimeout(timer); finish(r); };
      });
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/main/mcpOAuth.test.ts`
Expected: PASS（10 条）

- [ ] **Step 5: 跑门禁**

Run: `npm test`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add src/main/mcpOAuth.ts tests/main/mcpOAuth.test.ts
git commit -m "feat(mcp): OAuth 回调走 loopback 临时端口

RFC 8252 的标准做法。选它而不是复用现有的 mrotto:// 深链，是因为动态
客户端注册时一部分服务端直接拒绝非 http 的 redirect_uri——很可能在
supabase 这第一个用例上就撞墙。

两个不显然的地方各有注释：state 必须我们自己验（SDK 的 finishAuth 只收
code），回调结果要缓冲（connect() 开完浏览器抛异常、调用方接住之后才轮到
waitForCode，中间窗口里用户完全可能已经点完同意了）。"
```

---

### Task 3: SDK 适配器 —— provider + 授权编排（`mcpClient.ts`）

**Files:**
- Modify: `src/main/mcpClient.ts`（新增导出，`connectMcpClient` 增一个可选参数）
- Test: `tests/main/mcpOAuthProvider.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `McpAuthRecord`；Task 2 的 `startLoopback` / `AUTH_TIMEOUT_MS`
- Produces:
  - `createOAuthProvider(opts: { redirectUri: string; state: string; read(): McpAuthRecord; write(patch: Partial<McpAuthRecord>): void; openBrowser(url: string): void }): OAuthClientProvider`
  - `authorizeMcpServer(id: string, cfg: McpServerConfig, deps: { read(): McpAuthRecord; write(patch: Partial<McpAuthRecord>): void; openBrowser(url: string): void }): Promise<void>`
  - `connectMcpClient(id, cfg, authProvider?)` —— 第三个参数可选，老调用方零改动

- [ ] **Step 1: 写失败的测试**

创建 `tests/main/mcpOAuthProvider.test.ts`：

```ts
import { describe, it, expect, vi } from "vitest";
import { createOAuthProvider } from "../../src/main/mcpClient.js";
import type { McpAuthRecord } from "../../src/main/mcpAuthStore.js";

function harness(initial: McpAuthRecord = {}) {
  let rec: McpAuthRecord = initial;
  const openBrowser = vi.fn();
  const provider = createOAuthProvider({
    redirectUri: "http://127.0.0.1:54321/callback",
    state: "state-abc",
    read: () => rec,
    write: (patch) => { rec = { ...rec, ...patch }; },
    openBrowser,
  });
  return { provider, openBrowser, current: () => rec };
}

describe("createOAuthProvider", () => {
  it("redirectUrl 跟着 loopback 走，clientMetadata 里也是同一个", () => {
    const { provider } = harness();
    expect(provider.redirectUrl).toBe("http://127.0.0.1:54321/callback");
    expect(provider.clientMetadata.redirect_uris).toEqual(["http://127.0.0.1:54321/callback"]);
  });

  it("公开客户端：token_endpoint_auth_method 是 none，靠 PKCE 而不是 secret", () => {
    const { provider } = harness();
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("none");
  });

  it("state() 返回 loopback 那一串——两端必须是同一个", () => {
    const { provider } = harness();
    expect(provider.state?.()).toBe("state-abc");
  });

  it("三个 save* 回调各存各的，互不擦除", async () => {
    const { provider, current } = harness();
    await provider.saveClientInformation?.({ client_id: "c1" });
    await provider.saveCodeVerifier("v1");
    await provider.saveTokens({ access_token: "a1", token_type: "Bearer" });
    expect(current()).toEqual({
      clientInformation: { client_id: "c1" },
      codeVerifier: "v1",
      tokens: { access_token: "a1", token_type: "Bearer" },
    });
  });

  it("读回来的就是存进去的", async () => {
    const { provider } = harness({
      clientInformation: { client_id: "c1" },
      tokens: { access_token: "a1", token_type: "Bearer" },
      codeVerifier: "v1",
    });
    expect(await provider.clientInformation()).toEqual({ client_id: "c1" });
    expect(await provider.tokens()).toEqual({ access_token: "a1", token_type: "Bearer" });
    expect(await provider.codeVerifier()).toBe("v1");
  });

  it("没存过的字段读出 undefined，不是空对象——SDK 靠 undefined 判断要不要注册", async () => {
    const { provider } = harness();
    expect(await provider.clientInformation()).toBeUndefined();
    expect(await provider.tokens()).toBeUndefined();
  });

  it("没有 code_verifier 时 codeVerifier() 抛人话，而不是把 undefined 喂给 SDK", async () => {
    const { provider } = harness();
    await expect(async () => provider.codeVerifier()).rejects.toThrow(/还没发起过授权/);
  });

  it("redirectToAuthorization 把浏览器打开到授权页", () => {
    const { provider, openBrowser } = harness();
    void provider.redirectToAuthorization(new URL("https://auth.example.com/authorize?x=1"));
    expect(openBrowser).toHaveBeenCalledWith("https://auth.example.com/authorize?x=1");
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/main/mcpOAuthProvider.test.ts`
Expected: FAIL —— `createOAuthProvider is not a function`

- [ ] **Step 3: 写实现**

在 `src/main/mcpClient.ts` 顶部的 import 区补：

```ts
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformation, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpAuthRecord } from "./mcpAuthStore.js";
import { startLoopback, AUTH_TIMEOUT_MS } from "./mcpOAuth.js";
```

（`UnauthorizedError` 已经在 import 了，只需把 `type OAuthClientProvider` 加进同一行。）

在文件末尾追加：

```ts
/** 存取凭据的两个把手 + 一个开浏览器的把手。hub 注入真实现，测试注入假的 */
export interface McpOAuthDeps {
  read(): McpAuthRecord;
  write(patch: Partial<McpAuthRecord>): void;
  openBrowser(url: string): void;
}

/** SDK 的 OAuthClientProvider 适配器 —— 本仓这一侧只负责"存哪、怎么开浏览器"。
    协议本身（元数据发现、动态客户端注册、PKCE、code 换 token、refresh 续期）
    全在 SDK 里，我们一行都不重写（spec §4）。

    SDK 类型（OAuthTokens / OAuthClientInformation）只在这个文件里出现：
    mcpAuthStore 用等价的 Record<string, unknown> 形状存盘，两边都是普通
    JSON 对象，适配就是下面这几处结构性断言（ADR-0050 的 SDK 单点 import）。 */
export function createOAuthProvider(
  opts: { redirectUri: string; state: string } & McpOAuthDeps
): OAuthClientProvider {
  const metadata: OAuthClientMetadata = {
    client_name: "Mr Otto",
    redirect_uris: [opts.redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    // 公开客户端：桌面 app 藏不住 client_secret，安全性靠 PKCE 而不是密钥
    token_endpoint_auth_method: "none",
  };
  return {
    get redirectUrl() { return opts.redirectUri; },
    get clientMetadata() { return metadata; },
    state: () => opts.state,
    clientInformation: () => opts.read().clientInformation as OAuthClientInformation | undefined,
    saveClientInformation: (info) => { opts.write({ clientInformation: info as Record<string, unknown> }); },
    tokens: () => opts.read().tokens as OAuthTokens | undefined,
    saveTokens: (t) => { opts.write({ tokens: t as unknown as Record<string, unknown> }); },
    saveCodeVerifier: (v) => { opts.write({ codeVerifier: v }); },
    codeVerifier: () => {
      const v = opts.read().codeVerifier;
      // 抛人话而不是返回 undefined：SDK 会把它直接塞进 token 请求，
      // 服务端回一句语焉不详的 invalid_grant，那比这句话难查十倍
      if (v === undefined) throw new Error("这台 server 还没发起过授权（缺 code_verifier），请重新点一次授权");
      return v;
    },
    redirectToAuthorization: (url) => { opts.openBrowser(url.toString()); },
  };
}

/** 跑完一次完整授权：开浏览器 → 等回调 → 换 token 落盘。
    成功返回即代表凭据已经在盘上，调用方（hub）接着 reconnect 即可。 */
export async function authorizeMcpServer(
  id: string,
  cfg: McpServerConfig,
  deps: McpOAuthDeps
): Promise<void> {
  if (cfg.kind !== "http") {
    // stdio 的凭据走 env，没有 OAuth 这回事——让调用方看到明确的话，
    // 而不是在 new URL(undefined) 那里炸一个看不懂的 TypeError
    throw new Error(`「${id}」是 stdio 传输的 server，凭据配在 env 里，没有 OAuth 授权这一步`);
  }
  const loopback = await startLoopback();
  try {
    const provider = createOAuthProvider({
      redirectUri: loopback.redirectUri,
      state: loopback.state,
      ...deps,
    });
    const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: { headers: cfg.headers },
      authProvider: provider,
    });
    const client = new Client({ name: "mr-otto", version: "1.0.0" }, { capabilities: {} });
    try {
      // 预期内的两种结局：
      // ① 抛 UnauthorizedError —— SDK 已经走完发现/注册/PKCE 并调过
      //    redirectToAuthorization（浏览器已经开了），"人已经送去授权页"
      //    就是这个异常的全部含义，不是故障
      // ② 不抛 —— 盘上的 token 还能用（或刚被 refresh 续上），这台其实
      //    不需要重新授权，关掉连接直接收工
      await client.connect(transport as unknown as Transport);
      await client.close();
      return;
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) throw e;
    }
    const code = await loopback.waitForCode(AUTH_TIMEOUT_MS);
    // finishAuth 内部用盘上的 code_verifier 把 code 换成 token，
    // 换到之后走 provider.saveTokens 落盘
    await transport.finishAuth(code);
    await transport.close();
  } finally {
    // 成功路径里 waitForCode 已经关过一次；close() 是幂等的，
    // 这里兜的是"中途抛错"那条路——端口不能留着
    loopback.close();
  }
}
```

同时把 `connectMcpClient` 的签名和 transport 构造改成接受 authProvider：

```ts
export async function connectMcpClient(
  id: string,
  cfg: McpServerConfig,
  authProvider?: OAuthClientProvider
): Promise<McpClientConn> {
```

transport 的 http 分支改成：

```ts
      : new StreamableHTTPClientTransport(new URL(cfg.url), {
          requestInit: { headers: cfg.headers },
          // 给了就走 OAuth：SDK 先用盘上的 access_token，过期自动 refresh，
          // refresh 也不行才抛 UnauthorizedError（→ hub 标 needs-auth）。
          // 不给 = 这台没配过 OAuth，照旧只用静态 header（老路径零改动）
          ...(authProvider ? { authProvider } : {}),
        });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/main/mcpOAuthProvider.test.ts`
Expected: PASS（8 条）

- [ ] **Step 5: 跑门禁**

Run: `npm test`
Expected: 全绿（`tests/architecture.test.ts` 的 SDK 单点断言仍应通过——新 import 都在 `mcpClient.ts` 里）

- [ ] **Step 6: 提交**

```bash
git add src/main/mcpClient.ts tests/main/mcpOAuthProvider.test.ts
git commit -m "feat(mcp): 接上 SDK 的 authProvider，一次完整授权编排

OAuth 协议本身一行没重写：元数据发现、动态客户端注册、PKCE、换 token、
refresh 续期都是 SDK 1.30.0 的 authProvider 做的。本仓补的只有'凭据存哪'
和'怎么开浏览器'。

authorizeMcpServer 里 connect() 抛 UnauthorizedError 是预期结局而不是
故障——那个异常的含义就是'人已经被送去授权页了'。不抛的那条路也留着：
盘上 token 还能用时直接收工，不该逼用户白点一次同意。"
```

---

### Task 4: hub 的 authorize + 删除时清凭据

**Files:**
- Modify: `src/main/mcpHub.ts`（`McpHub` 接口加 `authorize`；`createMcpHub` opts 加 `authorize` / `clearAuth`；`reconnect` 抽成局部函数复用）
- Modify: `src/main/index.ts:981`（装配处注入真实现）
- Test: `tests/main/mcpHub.test.ts`（追加）

**Interfaces:**
- Consumes: Task 3 的 `authorizeMcpServer`；Task 1 的 `readMcpAuth` / `writeMcpAuth` / `clearMcpAuth`
- Produces: `McpHub.authorize(id: string): Promise<void>`

- [ ] **Step 1: 写失败的测试**

在 `tests/main/mcpHub.test.ts` 末尾追加：

```ts
describe("authorize", () => {
  it("授权成功后自动重连，状态从 needs-auth 变 connected", async () => {
    let authed = false;
    const hub = createMcpHub({
      load: () => ({ servers: { s: http() }, errors: [], unrecognizedIds: [], fatal: false }),
      save: () => {},
      connect: async () => {
        if (!authed) throw new McpAuthRequiredError("s 需要授权");
        return conn();
      },
      authorize: async () => { authed = true; },
      clearAuth: () => {},
    });
    await hub.ready();
    expect(hub.list()[0]!.status).toBe("needs-auth");
    await hub.authorize("s");
    expect(hub.list()[0]!.status).toBe("connected");
  });

  it("授权失败原样抛出去，状态不被伪造成 connected", async () => {
    const hub = createMcpHub({
      load: () => ({ servers: { s: http() }, errors: [], unrecognizedIds: [], fatal: false }),
      save: () => {},
      connect: async () => { throw new McpAuthRequiredError("s 需要授权"); },
      authorize: async () => { throw new Error("用户点了拒绝"); },
      clearAuth: () => {},
    });
    await hub.ready();
    await expect(hub.authorize("s")).rejects.toThrow("用户点了拒绝");
    expect(hub.list()[0]!.status).toBe("needs-auth");
  });

  it("不存在的 id 给人话", async () => {
    const hub = createMcpHub({
      load: () => ({ servers: {}, errors: [], unrecognizedIds: [], fatal: false }),
      save: () => {},
      connect: async () => conn(),
      authorize: async () => {},
      clearAuth: () => {},
    });
    await expect(hub.authorize("不存在")).rejects.toThrow(/不存在/);
  });

  it("删除一台 server 顺手清掉它的 OAuth 凭据——留着就是一份没人管的长期授权", async () => {
    const cleared: string[] = [];
    const hub = createMcpHub({
      load: () => ({ servers: { s: http() }, errors: [], unrecognizedIds: [], fatal: false }),
      save: () => {},
      connect: async () => conn(),
      authorize: async () => {},
      clearAuth: (id) => { cleared.push(id); },
    });
    await hub.ready();
    await hub.remove("s");
    expect(cleared).toEqual(["s"]);
  });
});
```

同时在测试文件顶部的辅助函数区补一个 `http()`（与既有 `stdio()` 并列）：

```ts
const http = (url = "https://mcp.example.com/mcp"): McpServerConfig => ({
  kind: "http", url, headers: {}, enabled: true,
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/main/mcpHub.test.ts`
Expected: FAIL —— `hub.authorize is not a function`，以及 `createMcpHub` 的 opts 类型不认识 `authorize` / `clearAuth`

- [ ] **Step 3: 写实现**

`src/main/mcpHub.ts` —— 接口加一条：

```ts
  /** 跑一次 OAuth 授权（开浏览器、等回调、换 token 落盘），成功后自动重连。
      失败原样抛给调用方：设置页要把原因显示出来，agent 要把原因转述给用户。
      只对 http 传输有意义——stdio 的凭据走 env，调到会拿到一句人话 */
  authorize(id: string): Promise<void>;
```

`createMcpHub` 的 opts 加两条：

```ts
  /** 跑一次完整 OAuth 授权。真实现是 mcpClient.authorizeMcpServer（它才认识
      SDK），hub 只管什么时候调、调完做什么——同 connect 的注入方向，
      hub 因此完全不碰 SDK，状态机能用假实现测干净 */
  authorize(id: string, cfg: McpServerConfig): Promise<void>;
  /** 抹掉一台 server 的 OAuth 凭据。remove() 时调 —— 配置删了而凭据留着，
      就是一份没有任何界面能看到、也没人会想起来撤销的长期授权 */
  clearAuth(id: string): void;
```

把返回对象里的 `reconnect` 抽成上方的局部函数，让 `authorize` 复用（不要在对象字面量里用 `this`）：

```ts
  async function reconnectOne(id: string): Promise<void> {
    const cur = entries.get(id);
    if (cur?.conn) await cur.conn.close();
    // 状态先推成 failed 再连：connectOne 对 status === "connected" 的直接返回，
    // 不推的话"重连一台已经连上的"会变成空操作
    if (cur) { delete cur.conn; cur.status = "failed"; }
    await connectOne(id);
  }
```

返回对象里：

```ts
    reconnect: reconnectOne,

    async authorize(id) {
      syncFromDisk();
      const e = entries.get(id);
      if (!e) throw new Error(`没有名叫「${id}」的 MCP server，无法授权`);
      // 授权失败原样抛：状态停在 needs-auth 是诚实的——用户点了拒绝、
      // 或者超时没点，这台确实还是"需要授权"，不该被改成 failed（那会
      // 让设置页把"你还没授权"显示成"这台坏了"）
      await opts.authorize(id, e.cfg);
      await reconnectOne(id);
    },
```

`remove` 里在 `entries.delete(id)` 之后补一行：

```ts
      // 配置没了，凭据也不该留 —— 见 opts.clearAuth 的注释
      opts.clearAuth(id);
```

`src/main/index.ts:981` 的 `createMcpHub({...})` 补两个字段（`mcpAuthPath` 用与 `keys.json` 同一个配置目录）：

```ts
  const mcpAuthPath = join(configDir, "mcp-auth.json");
  const mcpHub = createMcpHub({
    // …既有的 load / save / connect
    connect: (id, cfg) =>
      connectMcpClient(
        id,
        cfg,
        // http 传输才给 authProvider：stdio 没有 OAuth 这回事。
        // 每次连接现造一个 provider，读的是盘上最新的 token
        cfg.kind === "http"
          ? createOAuthProvider({
              // 连接路径上不需要真 loopback：这两个字段只有在 SDK 决定
              // 发起一次新授权时才会被用到，而那条路走的是 authorize()
              // 里另造的、带真端口的 provider。这里给的是占位值——
              // 连接阶段 SDK 只读 tokens()/clientInformation() 去续期
              redirectUri: "http://127.0.0.1/callback",
              state: "",
              read: () => readMcpAuth(mcpAuthPath, id),
              write: (patch) => { writeMcpAuth(mcpAuthPath, id, patch); },
              openBrowser: () => {
                // 连接路径上不该弹浏览器：用户可能正在做别的事，一台
                // server 的 token 过期不该劫持屏幕。让它抛 Unauthorized
                // → hub 标 needs-auth → 用户自己点那颗按钮
              },
            })
          : undefined
      ),
    authorize: (id, cfg) =>
      authorizeMcpServer(id, cfg, {
        read: () => readMcpAuth(mcpAuthPath, id),
        write: (patch) => { writeMcpAuth(mcpAuthPath, id, patch); },
        openBrowser: (url) => { void shell.openExternal(url); },
      }),
    clearAuth: (id) => { clearMcpAuth(mcpAuthPath, id); },
  });
```

（`shell` 从 `electron` import；`configDir` 用该文件里既有的配置目录变量——照抄 `keys.json` 那一行的取法。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/main/mcpHub.test.ts`
Expected: PASS（既有全部 + 新增 4 条）

- [ ] **Step 5: 跑门禁**

Run: `npm test`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add src/main/mcpHub.ts src/main/index.ts tests/main/mcpHub.test.ts
git commit -m "feat(mcp): hub.authorize —— 授权成功即重连，删 server 顺手清凭据

授权失败时状态刻意停在 needs-auth 而不是 failed：用户点了拒绝或超时没点，
这台确实还是'需要授权'，标成 failed 会让设置页把'你还没授权'显示成
'这台坏了'。

连接路径上的 provider 故意不弹浏览器：一台 server 的 token 过期不该劫持
用户的屏幕。让它抛 Unauthorized、标 needs-auth，由用户自己点那颗按钮。"
```

---

### Task 5: 过桥 + 设置页的「授权」按钮

**Files:**
- Modify: `src/shared/shellBridge.ts`（`ShellBridge` 加 `authorizeMcpServer`，`CHANNELS` 加一条）
- Modify: `src/main/index.ts`（IPC handler）
- Modify: `src/preload/*`（透传，照抄 `reconnectMcpServer` 那一条）
- Modify: `src/renderer/src/components/McpSettings.tsx:445` 附近
- Test: `tests/renderer/McpSettings.test.tsx`（若无则新建）

**Interfaces:**
- Consumes: Task 4 的 `McpHub.authorize`
- Produces: `ShellBridge.authorizeMcpServer(id: string): Promise<McpServersSnapshot>`

- [ ] **Step 1: 写失败的测试**

`tests/renderer/McpSettings.test.tsx`（用仓内既有的渲染层测试写法；若该文件已存在就追加 describe 块）：

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { McpSettings } from "../../src/renderer/src/components/McpSettings.js";

// 用仓内既有的 bridge stub 手法造一份最小桥（照抄同目录其它渲染层测试）
function bridge(over: Record<string, unknown> = {}) {
  return {
    listMcpServers: async () => ({
      servers: [{
        id: "supabase", status: "needs-auth" as const, error: "supabase 需要授权：401",
        config: { kind: "http" as const, url: "https://mcp.supabase.com/mcp", headers: {}, enabled: true },
        tools: [], resources: [], prompts: [],
      }],
      errors: [],
    }),
    authorizeMcpServer: vi.fn(async () => ({ servers: [], errors: [] })),
    ...over,
  };
}

describe("McpSettings 的授权按钮", () => {
  it("needs-auth 的 server 显示「授权」按钮", async () => {
    render(<McpSettings bridge={bridge() as never} />);
    expect(await screen.findByRole("button", { name: "授权" })).toBeInTheDocument();
  });

  it("connected 的 server 不显示授权按钮", async () => {
    const b = bridge({
      listMcpServers: async () => ({
        servers: [{
          id: "s", status: "connected" as const,
          config: { kind: "http" as const, url: "https://x/mcp", headers: {}, enabled: true },
          tools: [], resources: [], prompts: [],
        }],
        errors: [],
      }),
    });
    render(<McpSettings bridge={b as never} />);
    await screen.findByText("s");
    expect(screen.queryByRole("button", { name: "授权" })).not.toBeInTheDocument();
  });

  it("点授权调桥，期间按钮禁用", async () => {
    const b = bridge();
    render(<McpSettings bridge={b as never} />);
    await userEvent.click(await screen.findByRole("button", { name: "授权" }));
    await waitFor(() => { expect(b.authorizeMcpServer).toHaveBeenCalledWith("supabase"); });
  });

  it("授权失败时把原因显示出来，不静默吞掉", async () => {
    const b = bridge({
      authorizeMcpServer: vi.fn(async () => { throw new Error("等授权超时（300 秒没等到浏览器回调）"); }),
    });
    render(<McpSettings bridge={b as never} />);
    await userEvent.click(await screen.findByRole("button", { name: "授权" }));
    expect(await screen.findByText(/等授权超时/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/renderer/McpSettings.test.tsx`
Expected: FAIL —— 找不到名为「授权」的按钮

- [ ] **Step 3: 写实现**

`src/shared/shellBridge.ts` —— 在 `reconnectMcpServer` 下面加：

```ts
  /** 跑一次 OAuth 授权：主进程开系统浏览器，用户点完同意后自动重连。
      URL 由主进程从这台 server 的配置推出来，渲染层递不进任意外链
      （同 updaterOpenReleasePage 的规矩）。失败原样 reject，设置页显示原因 */
  authorizeMcpServer(id: string): Promise<McpServersSnapshot>;
```

`CHANNELS` 加：

```ts
  authorizeMcpServer: "otter:authorizeMcpServer",
```

`src/main/index.ts` 的 MCP 段加 handler：

```ts
  ipcMain.handle(CHANNELS.authorizeMcpServer, async (_e, id: string): Promise<McpServersSnapshot> => {
    await mcpHub.authorize(id);
    return mcpSnapshot();
  });
```

preload 照抄 `reconnectMcpServer` 那一行透传。

`McpSettings.tsx` —— 在 `server.error && (display === "failed" || display === "needs-auth")` 那个错误块旁边加按钮。新增局部状态与处理函数：

```tsx
  const [authorizing, setAuthorizing] = useState<string | null>(null);
  const [authError, setAuthError] = useState<Record<string, string>>({});

  const onAuthorize = async (id: string) => {
    setAuthorizing(id);
    setAuthError((m) => { const next = { ...m }; delete next[id]; return next; });
    try {
      const snap = await bridge.authorizeMcpServer(id);
      setSnapshot(snap);
    } catch (e) {
      // 失败原因必须显示：超时/用户拒绝/服务端报错在这里是三件不同的事，
      // 统一吞成"授权失败"会让用户第二次点之前完全不知道该改什么
      setAuthError((m) => ({ ...m, [id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setAuthorizing(null);
    }
  };
```

JSX（放在错误行同一块内）：

```tsx
{display === "needs-auth" && server.config.kind === "http" && (
  <Button
    size="sm"
    variant="secondary"
    disabled={authorizing === server.id}
    onClick={() => { void onAuthorize(server.id); }}
  >
    {authorizing === server.id ? "等浏览器…" : "授权"}
  </Button>
)}
{authError[server.id] && (
  <p className="text-sm text-destructive">{authError[server.id]}</p>
)}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/renderer/McpSettings.test.tsx`
Expected: PASS（4 条）

- [ ] **Step 5: 跑门禁**

Run: `npm test`
Expected: 全绿

- [ ] **Step 6: 手动验一次真链路**

Run: `npm run dev`，在设置页配一台 `https://mcp.supabase.com/mcp?project_ref=<你的 ref>`，点「授权」。
Expected: 系统浏览器打开 Supabase 授权页 → 点同意 → 浏览器显示「授权完成，回到 Mr Otto 继续」→ 设置页状态灯变绿、工具清单出现。

- [ ] **Step 7: 提交**

```bash
git add src/shared/shellBridge.ts src/main/index.ts src/preload src/renderer/src/components/McpSettings.tsx tests/renderer/McpSettings.test.tsx
git commit -m "feat(mcp): needs-auth 的 server 给一颗能点的「授权」按钮

在此之前那行红字后面没有任何可点的东西，用户唯一的出路是自己去服务商
后台建 PAT、复制、回来手填一行 header。

失败原因逐台显示而不是统一吞成'授权失败'：超时 / 用户拒绝 / 服务端报错
是三件不同的事，混成一句话会让用户第二次点之前完全不知道该改什么。"
```

---

### Task 6: LoopEngine 工具表按 turn 重算

**Files:**
- Modify: `src/loop/engine.ts:41`（`LoopEngineOptions.tools` 类型）、`:115-128`（构造）、`:466` `runTurn` 开头
- Modify: `src/main/agent.ts:455-505`（工具数组改成 provider）
- Test: `tests/loop/engine.test.ts`（追加）

**Interfaces:**
- Consumes: 无
- Produces: `LoopEngineOptions.tools: Tool[] | (() => Tool[])`（老调用方传数组，行为不变）

- [ ] **Step 1: 写失败的测试**

在 `tests/loop/engine.test.ts` 追加（`makeEngine` 等辅助照用该文件既有的）：

```ts
describe("工具表按 turn 重算（MCP server 中途连上要能用）", () => {
  it("传数组时行为与从前一致", async () => {
    const engine = makeEngine({ tools: [fakeTool("a")] });
    await engine.runTurn("用 a");
    expect(lastToolDefs()).toEqual(["a"]);
  });

  it("turn 之间工具表会跟着 provider 变", async () => {
    let live = [fakeTool("a")];
    const engine = makeEngine({ tools: () => live });
    await engine.runTurn("第一轮");
    expect(lastToolDefs()).toEqual(["a"]);
    live = [fakeTool("a"), fakeTool("mcp__supabase__list_tables")];
    await engine.runTurn("第二轮");
    expect(lastToolDefs()).toEqual(["a", "mcp__supabase__list_tables"]);
  });

  it("turn 之内不变——模型按这一轮的声明表发调用，中途换表会变成「未知工具」", async () => {
    let live = [fakeTool("a")];
    const engine = makeEngine({
      tools: () => live,
      // 第一圈模型调 a，工具执行期间 provider 的返回值被改掉
      onToolRun: () => { live = []; },
      // 两圈：第一圈发工具调用，第二圈收口
      replies: [{ toolCalls: [{ id: "1", name: "a", args: {} }] }, { text: "好了" }],
    });
    await expect(engine.runTurn("跑一下")).resolves.not.toThrow();
    expect(lastToolResultStatus()).toBe("ok"); // 不是 "error: 未知工具"
  });

  it("撞名保护每轮都生效：后到的同名工具照旧被拒", async () => {
    const engine = makeEngine({ tools: () => [fakeTool("a"), fakeTool("a")] });
    await engine.runTurn("一轮");
    expect(lastToolDefs()).toEqual(["a"]);
  });

  it("deferred 已暴露的集合跨轮存活——搜出来的刀不该因为重算又缩回去", async () => {
    const engine = makeEngine({
      tools: () => [fakeTool("a"), { ...fakeTool("deep"), exposure: "deferred" as const }],
    });
    await engine.runTurn("第一轮");
    expect(lastToolDefs()).not.toContain("deep");
    exposeDeferred(engine, "deep"); // 模拟 tool_search 命中
    await engine.runTurn("第二轮");
    expect(lastToolDefs()).toContain("deep");
  });
});
```

> 实现者注：`lastToolDefs` / `lastToolResultStatus` / `exposeDeferred` 若在该测试文件里还没有，按文件既有的假 adapter 写法补——`lastToolDefs` 读假 adapter 最后一次 `chat()` 收到的 `tools` 参数的 `name` 列表。

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/loop/engine.test.ts`
Expected: FAIL —— `tools` 不接受函数（tsc 报类型错），且第二条断言拿到的仍是 `["a"]`

- [ ] **Step 3: 写实现**

`src/loop/engine.ts` —— 选项类型：

```ts
  /** 工具表。传函数 = 每个 turn 开始时重算一次（MCP server 中途连上/掉线
      要能被这个会话看见）；传数组 = 一次定终身（老调用方零改动）。

      为什么是"每 turn 重算、turn 内冻结"而不是"随时重算"：模型看到的声明表
      和 dispatch 时查的 toolsByName 必须是同一份。turn 中途换表，模型按旧表
      发出的调用会在新表里查不到，收到一句"未知工具"——那正是 mcpTool.ts
      顶部注释要避免的失败。 */
  tools: Tool[] | (() => Tool[]);
```

字段与构造：

```ts
  private toolsByName: Map<string, Tool>;
  private tools: Tool[];
  /** 每 turn 重算的来源；传数组时包成常量函数 */
  private readonly toolsProvider: () => Tool[];
```

```ts
    this.toolsProvider = typeof opts.tools === "function" ? opts.tools : () => opts.tools as Tool[];
    this.toolsByName = new Map();
    this.tools = [];
    this.rebuildTools();
```

把原来构造里那段去重循环抽成方法：

```ts
  /** 重算工具表。撞名保护（issue #349 ⑤）：同名后到者拒绝注册（先到的赢），
      不静默覆盖——内置工具在装配数组里排在 MCP 工具前面，外部工具因此永远
      占不了内置名；Map 构造器的 last-wins 恰好是反的，所以显式跳过。
      每 turn 跑一次，所以撞名警告也每 turn 打一次——这是刻意的：一台 server
      反复挂同名刀，用户该一直看得到，而不是只在会话开头看到一次。 */
  private rebuildTools(): void {
    const byName = new Map<string, Tool>();
    const list: Tool[] = [];
    for (const t of this.toolsProvider()) {
      if (byName.has(t.def.name)) {
        console.warn(`工具「${t.def.name}」已注册，后到的同名工具被拒绝挂载`);
        continue;
      }
      byName.set(t.def.name, t);
      list.push(t);
    }
    this.toolsByName = byName;
    this.tools = list;
  }
```

`runTurn` 的开头（在进入圈循环之前、和 `compactFloor` 重置放一起）：

```ts
    // 工具表这一 turn 的快照。turn 内不再变——见 LoopEngineOptions.tools 注释
    this.rebuildTools();
```

`src/main/agent.ts` —— 把 `const tools: Tool[] = [...]` 改成一个每次现算的函数。MCP 那两行进函数体，其余保持原样：

```ts
  // 工具表现在是"每 turn 现算"（engine 的 rebuildTools 调它）：MCP server
  // 在会话中途连上/掉线/改清单，这个会话就能跟着看见。内置工具每轮重建
  // 开销可以忽略（纯对象字面量），换来的是"agent 配完 MCP 当场能用"。
  const buildTools = (): Tool[] => {
    const list: Tool[] = [
      // …既有的内置工具，原样不动
      ...(mcp ? applyExposurePolicy(createMcpTools(mcp)) : []),
      ...(mcp ? [createMcpReadResourceTool(mcp)] : []),
      ...(opts.subagentRunner
        ? [createTaskTool(opts.subagentRunner, opts.listSubagents ?? (() => []))]
        : []),
    ];
    // deferred 检索口（issue #348）：可见集是**闭包外**的共享活 Set，
    // 跨 turn 存活——tool_search 搜出来的刀不该因为下一轮重算又缩回去
    if (list.some((t) => t.exposure === "deferred")) {
      list.push(createToolSearchTool(() => listDeferred(list), deferredExposed));
    }
    return opts.allowTools ? list.filter((t) => opts.allowTools!.includes(t.def.name)) : list;
  };

  const deferredExposed = new Set<string>();
  const listDeferred = (list: readonly Tool[]) =>
    list
      .filter((t) => t.exposure === "deferred" && !deferredExposed.has(t.def.name))
      .map((t) => ({ name: t.def.name, description: t.def.description ?? "" }));
```

engine 构造处把 `tools` 从数组换成 `buildTools`。该函数里原本用到 `tools` 变量的其它地方（如 BootInfo 的 `toolDefs`）改成调一次 `buildTools()`。

> 实现者注：`deferredExposed` 的声明要提到 `buildTools` 之前（`const` 有 TDZ，`buildTools` 里引用它没问题因为调用发生在之后，但为了可读性还是前置）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/loop/engine.test.ts`
Expected: PASS（既有全部 + 新增 5 条）

- [ ] **Step 5: 跑门禁**

Run: `npm test`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add src/loop/engine.ts src/main/agent.ts tests/loop/engine.test.ts
git commit -m "fix(loop): 工具表按 turn 重算，会话中途连上的 MCP server 能被看见

engine 从前把 toolsByName 冻在构造那一刻，createMcpTools 也是装配时快照。
后果是一台 server 在会话中途重连或新增，这个会话一辈子看不见它——这是
现在就存在的缺陷，不是新功能的副产品。

刻意做成'每 turn 重算、turn 内冻结'而不是'随时重算'：模型看到的声明表和
dispatch 时查的 toolsByName 必须是同一份，turn 中途换表会让模型按旧表发出
的调用收到'未知工具'。

deferredExposed 提到闭包外跨轮存活：tool_search 搜出来的刀不该因为下一轮
重算又缩回去。"
```

---

### Task 7: server 目录 + `mcp_catalog` 工具

**Files:**
- Create: `src/shared/mcpCatalog.ts`
- Create: `src/tools/mcpCatalog.ts`
- Test: `tests/shared/mcpCatalog.test.ts`、`tests/tools/mcpCatalog.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface CatalogEntry { id: string; name: string; description: string; transport: "http" | "stdio"; url?: string; command?: string; args?: string[]; params: { name: string; description: string; required: boolean }[]; auth: "oauth" | "token" | "none"; authNote: string }`
  - `MCP_CATALOG: readonly CatalogEntry[]`
  - `searchCatalog(query: string): CatalogEntry[]`
  - `mcpCatalogTool: Tool`

- [ ] **Step 1: 写失败的测试**

`tests/shared/mcpCatalog.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { MCP_CATALOG, searchCatalog } from "../../src/shared/mcpCatalog.js";

describe("mcpCatalog", () => {
  it("id 唯一", () => {
    const ids = MCP_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("http 的条目必须有 url，stdio 的必须有 command", () => {
    for (const e of MCP_CATALOG) {
      if (e.transport === "http") expect(e.url, e.id).toBeTruthy();
      else expect(e.command, e.id).toBeTruthy();
    }
  });

  it("url 模板里出现的占位符都在 params 里声明过", () => {
    for (const e of MCP_CATALOG) {
      const holes = [...(e.url ?? "").matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      for (const h of holes) {
        expect(e.params.map((p) => p.name), `${e.id} 的 {${h}}`).toContain(h);
      }
    }
  });

  it("按 id 精确命中", () => {
    expect(searchCatalog("supabase").map((e) => e.id)).toContain("supabase");
  });

  it("按名字/描述模糊命中，大小写无关", () => {
    expect(searchCatalog("SUPABASE").length).toBeGreaterThan(0);
  });

  it("查不到就是空数组，不抛", () => {
    expect(searchCatalog("绝无此物xyzzy")).toEqual([]);
  });

  it("空查询返回全部——agent 想看看有哪些", () => {
    expect(searchCatalog("")).toHaveLength(MCP_CATALOG.length);
  });
});
```

`tests/tools/mcpCatalog.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { mcpCatalogTool } from "../../src/tools/mcpCatalog.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

const world = {} as ExecutionWorld;

describe("mcp_catalog 工具", () => {
  it("免审批——只读一份仓内常量，没有副作用", () => {
    expect(mcpCatalogTool.requiresApproval).toBe(false);
  });

  it("deferred——十几条目录不该占初始工具表的位置", () => {
    expect(mcpCatalogTool.exposure).toBe("deferred");
  });

  it("命中时返回可直接照着填的字段", async () => {
    const out = await mcpCatalogTool.run({ query: "supabase" }, world);
    expect(String(out)).toContain("mcp.supabase.com");
    expect(String(out)).toContain("project_ref");
  });

  it("查不到时明说去搜，而不是回一句空", async () => {
    const out = await mcpCatalogTool.run({ query: "绝无此物xyzzy" }, world);
    expect(String(out)).toMatch(/没有|web_search/);
  });

  it("参数不是对象也不炸", async () => {
    await expect(mcpCatalogTool.run(null, world)).resolves.toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/shared/mcpCatalog.test.ts tests/tools/mcpCatalog.test.ts`
Expected: FAIL —— 两个模块都解析不到

- [ ] **Step 3: 写实现**

`src/shared/mcpCatalog.ts`（纯数据 + 纯函数，主进程/工具层/渲染层都能 import）：

```ts
// 常见 MCP server 的目录 —— 用户说"帮我接上 supabase"时，agent 从这儿
// 知道该填什么（spec §3.5）。
//
// 这份清单会过时，这是明知的取舍：它覆盖绝大多数请求且结果确定，而纯靠
// web_search 每次多花几秒、还可能拿到错 URL——虽然有审批门兜底，但让用户
// 在审批卡上判断一个 URL 对不对，等于把认知负担又还给了用户。
// 不在单上的走 web_search，见 tools/mcpCatalog.ts 的兜底话术。

export interface CatalogParam {
  name: string;
  description: string;
  required: boolean;
}

export interface CatalogEntry {
  /** 建议的 server id（用户可改） */
  id: string;
  name: string;
  description: string;
  transport: "http" | "stdio";
  /** http：URL 模板，占位符写成 {param_name} */
  url?: string;
  /** stdio */
  command?: string;
  args?: readonly string[];
  params: readonly CatalogParam[];
  auth: "oauth" | "token" | "none";
  /** 认证方式的一句话说明，直接说给用户听 */
  authNote: string;
}

export const MCP_CATALOG: readonly CatalogEntry[] = [
  {
    id: "supabase",
    name: "Supabase",
    description: "查数据库结构、跑只读 SQL、看项目配置与文档",
    transport: "http",
    url: "https://mcp.supabase.com/mcp?project_ref={project_ref}&features=database%2Cdocs",
    params: [
      { name: "project_ref", description: "Supabase 项目的 ref（在项目 URL 里，形如 kpeemypbhkynapkjzewr）", required: true },
    ],
    auth: "oauth",
    authNote: "配好后点一次授权，浏览器里登录 Supabase 并同意即可，不用手动建 token",
  },
  {
    id: "github",
    name: "GitHub",
    description: "读写 issue / PR / 仓库内容",
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权，在浏览器里同意 GitHub 的授权请求",
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "查线上报错、issue 详情与堆栈",
    transport: "http",
    url: "https://mcp.sentry.dev/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
  },
  {
    id: "notion",
    name: "Notion",
    description: "读写 Notion 页面与数据库",
    transport: "http",
    url: "https://mcp.notion.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权，在浏览器里选择要开放给 Mr Otto 的页面",
  },
  {
    id: "linear",
    name: "Linear",
    description: "查看和创建 Linear 的 issue / 项目",
    transport: "http",
    url: "https://mcp.linear.app/mcp",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "查客户、订阅、支付与产品目录",
    transport: "http",
    url: "https://mcp.stripe.com",
    params: [],
    auth: "oauth",
    authNote: "配好后点一次授权",
  },
  {
    id: "filesystem",
    name: "本地文件系统",
    description: "把指定目录暴露成 MCP 资源（Mr Otto 自带读写文件工具，一般用不上）",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "{root}"],
    params: [{ name: "root", description: "要暴露的目录绝对路径", required: true }],
    auth: "none",
    authNote: "不需要授权",
  },
  {
    id: "playwright",
    name: "Playwright",
    description: "用真浏览器点页面、填表单、截图",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
    params: [],
    auth: "none",
    authNote: "不需要授权；首次运行会下载浏览器内核",
  },
];

/** 查目录。空查询 = 返回全部（agent 想看看有哪些）。
    匹配 id / 名字 / 描述，大小写无关 */
export function searchCatalog(query: string): CatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...MCP_CATALOG];
  return MCP_CATALOG.filter((e) =>
    [e.id, e.name, e.description].some((f) => f.toLowerCase().includes(q))
  );
}
```

`src/tools/mcpCatalog.ts`：

```ts
// mcp_catalog —— agent 查"这台 server 该怎么配"。
// 只读一份仓内常量：不碰 world、没有副作用、免审批。

import type { Tool } from "./tool.js";
import { searchCatalog, type CatalogEntry } from "../shared/mcpCatalog.js";

function render(e: CatalogEntry): string {
  const lines = [
    `## ${e.name}（建议 id: ${e.id}）`,
    e.description,
    `传输方式：${e.transport}`,
  ];
  if (e.url !== undefined) lines.push(`URL 模板：${e.url}`);
  if (e.command !== undefined) lines.push(`命令：${e.command} ${(e.args ?? []).join(" ")}`);
  lines.push(
    e.params.length === 0
      ? "需要用户提供的参数：无"
      : `需要用户提供的参数：\n${e.params
          .map((p) => `  - ${p.name}${p.required ? "（必填）" : "（可选）"}：${p.description}`)
          .join("\n")}`
  );
  lines.push(`认证：${e.auth} —— ${e.authNote}`);
  return lines.join("\n");
}

export const mcpCatalogTool: Tool = {
  def: {
    name: "mcp_catalog",
    description:
      "查常见 MCP server 的配置方法（URL / 命令 / 需要用户提供的参数 / 认证方式）。" +
      "用户说要接某个服务时先查这里；查不到再用 web_search。" +
      "留空 query 可以列出全部已知的 server。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "服务名，例如 supabase / github；留空列出全部" },
      },
      required: [],
    },
  },
  exposure: "deferred",
  requiresApproval: false,
  // 纯读常量，无共享状态
  parallelSafe: true,
  async run(args) {
    const q = (args as { query?: unknown } | null)?.query;
    const hits = searchCatalog(typeof q === "string" ? q : "");
    if (hits.length === 0) {
      return (
        `目录里没有「${String(q)}」。用 web_search 查一下它的 MCP server 地址` +
        `（关键词：<服务名> MCP server url），拿到之后再调 mcp_configure。`
      );
    }
    return hits.map(render).join("\n\n");
  },
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/shared/mcpCatalog.test.ts tests/tools/mcpCatalog.test.ts`
Expected: PASS（7 + 5 条）

- [ ] **Step 5: 跑门禁**

Run: `npm test`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add src/shared/mcpCatalog.ts src/tools/mcpCatalog.ts tests/shared/mcpCatalog.test.ts tests/tools/mcpCatalog.test.ts
git commit -m "feat(mcp): 内置常见 server 目录 + mcp_catalog 工具

用户说'帮我接上 supabase'时 agent 得知道填什么。目录会过时是明知的取舍：
它覆盖绝大多数请求且结果确定，而纯靠 web_search 每次多花几秒、还可能拿到
错 URL——虽然有审批门兜底，但让用户在审批卡上判断一个 URL 对不对，等于
把认知负担又还给了用户。

一条测试钉住'URL 模板里的占位符都在 params 里声明过'：漏声明的话 agent
会把 {project_ref} 原样填进配置里。"
```

---

### Task 8: `McpCapability` 加配置与授权两项能力

**Files:**
- Modify: `src/world/executionWorld.ts:108-119`（`McpCapability` 接口）
- Modify: `src/main/mcpHub.ts`（hub 已实现 `save`/`remove`/`authorize`，补 `configure` 与 `listConfigured` 到能力面）
- Test: `tests/main/mcpHub.test.ts`（追加）

**Interfaces:**
- Consumes: Task 4 的 `McpHub.authorize`
- Produces:
  - `McpCapability.configure(id: string, cfg: McpServerConfig | null): Promise<void>`（`null` = 删除）
  - `McpCapability.authorize(id: string): Promise<void>`
  - `McpCapability.configOf(id: string): McpServerConfig | undefined`（审批预览要看当前配置）

- [ ] **Step 1: 写失败的测试**

在 `tests/main/mcpHub.test.ts` 追加：

```ts
describe("configure（agent 侧的写配置能力）", () => {
  it("configure 新增一台，落盘并尝试连接", async () => {
    const saved: Record<string, unknown>[] = [];
    const hub = createMcpHub({
      load: () => ({ servers: {}, errors: [], unrecognizedIds: [], fatal: false }),
      save: (servers) => { saved.push(servers); },
      connect: async () => conn(),
      authorize: async () => {},
      clearAuth: () => {},
    });
    await hub.configure("s", http());
    expect(saved.at(-1)).toHaveProperty("s");
    expect(hub.servers().find((x) => x.id === "s")?.live).toBe(true);
  });

  it("configure(id, null) = 删除", async () => {
    const hub = createMcpHub({
      load: () => ({ servers: { s: http() }, errors: [], unrecognizedIds: [], fatal: false }),
      save: () => {},
      connect: async () => conn(),
      authorize: async () => {},
      clearAuth: () => {},
    });
    await hub.ready();
    await hub.configure("s", null);
    expect(hub.servers().find((x) => x.id === "s")).toBeUndefined();
  });

  it("configOf 拿得到当前配置（审批预览要对照「改之前是什么」）", async () => {
    const hub = createMcpHub({
      load: () => ({ servers: { s: http("https://a/mcp") }, errors: [], unrecognizedIds: [], fatal: false }),
      save: () => {},
      connect: async () => conn(),
      authorize: async () => {},
      clearAuth: () => {},
    });
    await hub.ready();
    expect(hub.configOf("s")).toMatchObject({ kind: "http", url: "https://a/mcp" });
    expect(hub.configOf("没有这台")).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/main/mcpHub.test.ts`
Expected: FAIL —— `hub.configure is not a function`

- [ ] **Step 3: 写实现**

`src/world/executionWorld.ts` 的 `McpCapability` 追加三条：

```ts
  /** 增 / 改 / 删一台 server（cfg 为 null = 删）。落盘后立刻尝试连接。
      模型走 mcp_configure 工具到这儿，那把工具 requiresApproval：stdio 的
      配置就是 command + args + env，能自由写盘等于绕开 bash 的审批门拿到
      任意命令执行（spec §3.1）。这一层不设门——门在工具那一层，这里只是
      能力本身。 */
  configure(id: string, cfg: McpServerConfig | null): Promise<void>;
  /** 跑一次 OAuth 授权（开浏览器、等回调、换 token 落盘），成功后自动重连 */
  authorize(id: string): Promise<void>;
  /** 这台 server 此刻的配置（含真凭据——只在主进程内流转，
      审批预览要靠它对照"改之前是什么"）。没有这台 = undefined */
  configOf(id: string): McpServerConfig | undefined;
```

`src/main/mcpHub.ts` 的返回对象追加：

```ts
    async configure(id, cfg) {
      // 复用 save/remove 的全部既有语义（遮罩合并、写在前状态变更在后、
      // unrecognizedIds 保护、删除时清 OAuth 凭据）——agent 这条路不该
      // 有一套"简化版"的写盘逻辑，那必然与设置页那条 drift
      if (cfg === null) await this.remove(id);
      else await this.save(id, cfg);
    },

    configOf: (id) => {
      syncFromDisk();
      return entries.get(id)?.cfg;
    },
```

> 实现者注：对象字面量里的 `this` 在这里是安全的（`hub.configure(...)` 的调用形式使 `this` 绑定到 hub 本身），但为了与 Task 4 抽出的 `reconnectOne` 风格一致，也可以把 `save` / `remove` 的函数体抽成局部函数再复用。二选一即可，别两种混着写。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/main/mcpHub.test.ts`
Expected: PASS

- [ ] **Step 5: 跑门禁**

Run: `npm test`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add src/world/executionWorld.ts src/main/mcpHub.ts tests/main/mcpHub.test.ts
git commit -m "feat(mcp): McpCapability 加 configure / authorize / configOf

configure 直接复用 save/remove 的全部既有语义（遮罩合并、写在前状态变更
在后、unrecognizedIds 保护、删除清凭据）。agent 这条路不该有一套简化版的
写盘逻辑——那必然与设置页那条慢慢 drift 开。

能力这一层不设审批门，门在 mcp_configure 工具那一层。"
```

---

### Task 9: `mcp_configure` 工具 + 审批预览

**Files:**
- Create: `src/tools/mcpConfigure.ts`
- Modify: `src/shared/shellBridge.ts`（`ApprovalPreview` 加一个成员）
- Modify: `src/main/approvalPreview.ts`（认这把工具）
- Modify: `src/renderer/src/components/`（审批卡渲染新 kind，照抄 `mcp_tool` 那一块的写法）
- Test: `tests/tools/mcpConfigure.test.ts`、`tests/main/approvalPreview.test.ts`（追加）

**Interfaces:**
- Consumes: Task 8 的 `McpCapability.configure` / `configOf`
- Produces:
  - `createMcpConfigureTool(mcp: McpCapability): Tool`
  - `interface McpConfigurePreview { kind: "mcp_configure"; server: string; action: "add" | "update" | "remove"; transport: "http" | "stdio" | null; url: string | null; command: string | null; args: string[]; credentialKeys: string[]; before: { url: string | null; command: string | null } | null }`

- [ ] **Step 1: 写失败的测试**

`tests/tools/mcpConfigure.test.ts`：

```ts
import { describe, it, expect, vi } from "vitest";
import { createMcpConfigureTool } from "../../src/tools/mcpConfigure.js";
import type { McpCapability } from "../../src/world/executionWorld.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

function cap(over: Partial<McpCapability> = {}): McpCapability {
  return {
    ready: async () => {},
    servers: () => [],
    callTool: async () => [],
    readResource: async () => [],
    getPrompt: async () => "",
    configure: vi.fn(async () => {}),
    authorize: async () => {},
    configOf: () => undefined,
    ...over,
  } as McpCapability;
}
const world = (mcp: McpCapability) => ({ mcp }) as ExecutionWorld;

describe("mcp_configure", () => {
  it("必须过审批门——这是这条路上唯一的安全闸", () => {
    expect(createMcpConfigureTool(cap()).requiresApproval).toBe(true);
  });

  it("绝不是 parallelSafe（写盘 + 重连，有副作用）", () => {
    expect(createMcpConfigureTool(cap()).parallelSafe).not.toBe(true);
  });

  it("http：把 url 交给 configure", async () => {
    const c = cap();
    await createMcpConfigureTool(c).run(
      { id: "supabase", kind: "http", url: "https://mcp.supabase.com/mcp" },
      world(c)
    );
    expect(c.configure).toHaveBeenCalledWith("supabase", {
      kind: "http", url: "https://mcp.supabase.com/mcp", headers: {}, enabled: true,
    });
  });

  it("stdio：command + args + env 一起过去", async () => {
    const c = cap();
    await createMcpConfigureTool(c).run(
      { id: "fs", kind: "stdio", command: "npx", args: ["-y", "pkg"], env: { K: "v" } },
      world(c)
    );
    expect(c.configure).toHaveBeenCalledWith("fs", {
      kind: "stdio", command: "npx", args: ["-y", "pkg"], env: { K: "v" }, enabled: true,
    });
  });

  it("remove：传 null 给 configure", async () => {
    const c = cap();
    await createMcpConfigureTool(c).run({ id: "s", action: "remove" }, world(c));
    expect(c.configure).toHaveBeenCalledWith("s", null);
  });

  it("id 缺失/不是字符串 → 抛人话，不把垃圾写进配置", async () => {
    const c = cap();
    await expect(createMcpConfigureTool(c).run({ kind: "http", url: "https://x" }, world(c)))
      .rejects.toThrow(/id/);
    expect(c.configure).not.toHaveBeenCalled();
  });

  it("http 少了 url → 抛人话", async () => {
    const c = cap();
    await expect(createMcpConfigureTool(c).run({ id: "s", kind: "http" }, world(c)))
      .rejects.toThrow(/url/);
  });

  it("stdio 少了 command → 抛人话", async () => {
    const c = cap();
    await expect(createMcpConfigureTool(c).run({ id: "s", kind: "stdio" }, world(c)))
      .rejects.toThrow(/command/);
  });

  it("url 不是 http/https → 拒绝（file:// 之类没有意义，且是个惊喜面）", async () => {
    const c = cap();
    await expect(createMcpConfigureTool(c).run({ id: "s", kind: "http", url: "file:///etc/passwd" }, world(c)))
      .rejects.toThrow(/http/);
  });

  it("world 没有 mcp 能力时给人话", async () => {
    await expect(createMcpConfigureTool(cap()).run({ id: "s", action: "remove" }, {} as ExecutionWorld))
      .rejects.toThrow(/MCP/);
  });
});
```

`tests/main/approvalPreview.test.ts` 追加：

```ts
describe("mcp_configure 的审批预览", () => {
  it("stdio：command / 每一条 arg / env 的键名都列出来，值不列", async () => {
    const preview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "fs", kind: "stdio", command: "npx", args: ["-y", "pkg"], env: { TOKEN: "sk-真的" } } },
      worldWithMcp()
    );
    expect(preview).toMatchObject({
      kind: "mcp_configure", server: "fs", action: "add",
      transport: "stdio", command: "npx", args: ["-y", "pkg"],
      credentialKeys: ["TOKEN"],
    });
    expect(JSON.stringify(preview)).not.toContain("sk-真的");
  });

  it("http：url 全文出现在卡片上——用户要看得到自己在授权给谁", async () => {
    const preview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "s", kind: "http", url: "https://mcp.supabase.com/mcp" } },
      worldWithMcp()
    );
    expect(preview).toMatchObject({ kind: "mcp_configure", url: "https://mcp.supabase.com/mcp" });
  });

  it("改已有的一台时带上「改之前是什么」", async () => {
    const preview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "s", kind: "http", url: "https://新的/mcp" } },
      worldWithMcp({ s: { kind: "http", url: "https://旧的/mcp", headers: {}, enabled: true } })
    );
    expect(preview).toMatchObject({ action: "update", before: { url: "https://旧的/mcp" } });
  });

  it("删除时说清删的是哪台、它现在有几把刀", async () => {
    const preview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "s", action: "remove" } },
      worldWithMcp({ s: { kind: "http", url: "https://旧的/mcp", headers: {}, enabled: true } })
    );
    expect(preview).toMatchObject({ action: "remove", server: "s" });
  });
});
```

> 实现者注：`worldWithMcp(configs?)` 是这个测试文件需要新增的辅助，返回一个带假 `mcp` 能力的 world（`configOf` 从传入的 map 里取，`servers()` 按 map 造 handle）。

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/tools/mcpConfigure.test.ts tests/main/approvalPreview.test.ts`
Expected: FAIL —— 模块解析不到 / 预览返回 `undefined`

- [ ] **Step 3: 写实现**

`src/tools/mcpConfigure.ts`：

```ts
// mcp_configure —— agent 增 / 改 / 删一台 MCP server。
//
// 必须过审批门，这不是可选项（spec §3.1）：stdio 类型的 server 配置就是
// command + args + env，agent 能自由写盘，等于绕开 bash 工具的审批门拿到
// 任意命令执行，还附带任意环境变量。审批卡片（approvalPreview.ts 里的
// mcp_configure 分支）把这些逐字段列出来，是这条路上唯一的安全闸。
//
// 只依赖 ExecutionWorld / McpCapability（硬规则）：这里不知道配置写在哪个
// 文件、也不知道 hub 和 SDK 的存在。

import type { Tool } from "./tool.js";
import type { McpCapability, ExecutionWorld } from "../world/executionWorld.js";
import type { McpServerConfig } from "../shared/mcp.js";

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const asStringMap = (v: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(asRecord(v)).map(([k, x]) => [k, String(x)]));

/** 参数出自模型，一个字段都不赌形状。校验失败抛人话——模型收到的是
    tool_result 里的错误文本，它能照着改；写进配置的垃圾则要用户去手删 */
export function parseConfigureArgs(raw: unknown): { id: string; cfg: McpServerConfig | null } {
  const a = asRecord(raw);
  const id = a["id"];
  if (typeof id !== "string" || id.trim() === "") {
    throw new Error("id 必填，且必须是字符串（这是这台 server 在配置里的名字）");
  }
  if (a["action"] === "remove") return { id, cfg: null };

  const kind = a["kind"];
  if (kind === "http") {
    const url = a["url"];
    if (typeof url !== "string" || url === "") throw new Error("http 传输必须给 url");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`url 不是合法的地址：${url}`);
    }
    // 只认 http/https：file:// / data: 之类在这里没有任何正当用途，
    // 而它们能让一次"配置 MCP"变成读本地文件的惊喜面
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`url 只支持 http/https，收到的是 ${parsed.protocol}`);
    }
    return {
      id,
      cfg: { kind: "http", url, headers: asStringMap(a["headers"]), enabled: a["enabled"] !== false },
    };
  }
  if (kind === "stdio") {
    const command = a["command"];
    if (typeof command !== "string" || command === "") throw new Error("stdio 传输必须给 command");
    return {
      id,
      cfg: {
        kind: "stdio",
        command,
        args: Array.isArray(a["args"]) ? a["args"].map(String) : [],
        env: asStringMap(a["env"]),
        enabled: a["enabled"] !== false,
      },
    };
  }
  throw new Error('kind 必须是 "http" 或 "stdio"（删除请传 action: "remove"）');
}

export function createMcpConfigureTool(mcp: McpCapability): Tool {
  return {
    def: {
      name: "mcp_configure",
      description:
        "增 / 改 / 删一台 MCP server 的配置。会弹审批卡请用户确认，用户同意后才落盘并尝试连接。" +
        "先用 mcp_catalog 查该填什么。http 传输的 server 配好之后通常还需要调 mcp_authorize 授权一次。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "这台 server 在配置里的名字，例如 supabase" },
          action: { type: "string", enum: ["upsert", "remove"], description: "默认 upsert；remove 表示删除这台" },
          kind: { type: "string", enum: ["http", "stdio"], description: "传输方式" },
          url: { type: "string", description: "http 传输的地址" },
          headers: { type: "object", description: "http 传输的自定义请求头（OAuth 授权不需要填这个）" },
          command: { type: "string", description: "stdio 传输要跑的命令" },
          args: { type: "array", items: { type: "string" }, description: "stdio 传输的命令参数" },
          env: { type: "object", description: "stdio 传输的环境变量" },
          enabled: { type: "boolean", description: "是否启用，默认 true" },
        },
        required: ["id"],
      },
    },
    exposure: "deferred",
    requiresApproval: true,
    async run(args, world: ExecutionWorld) {
      if (!world.mcp) throw new Error("这个装配没有 MCP 能力，配不了 MCP server");
      const { id, cfg } = parseConfigureArgs(args);
      await world.mcp.configure(id, cfg);
      if (cfg === null) return `已删除 MCP server「${id}」。`;
      const hit = world.mcp.servers().find((s) => s.id === id);
      if (hit?.live) {
        return `MCP server「${id}」已配置并连上，可用工具 ${hit.tools.length} 个：${hit.tools.map((t) => t.name).join("、")}`;
      }
      if (hit?.status === "needs-auth") {
        return `MCP server「${id}」已配置，但需要授权。调用 mcp_authorize 拉起授权（会打开浏览器让用户点同意）。`;
      }
      return `MCP server「${id}」已配置，但暂时没连上：${hit?.error ?? "原因未知"}`;
    },
  };
}
```

> `mcp` 参数目前只用于保持与 `createMcpTools` 一致的注入形状；实现里一律从 `world.mcp` 取，这样装配根传进来的和运行时用的永远是同一个（对照 `mcpTool.ts` 里 `run` 的同款写法）。

`src/shared/shellBridge.ts` 加预览类型并并进联合：

```ts
/** mcp_configure 的审批预览。这张卡是 agent 自助配置那条路上**唯一**的
    安全闸：stdio 的配置就是 command + args + env，卡片含糊等于闸形同虚设。
    所以明细逐字段列，不折成一句"配置一台 MCP server"。

    凭据只出键名不出值（同 ADR-0044 的口径）：用户要认出"这一格配的是哪一把"，
    不需要、也不该在审批卡上看到真值。 */
export interface McpConfigurePreview {
  kind: "mcp_configure";
  server: string;
  action: "add" | "update" | "remove";
  /** remove 时为 null */
  transport: "http" | "stdio" | null;
  url: string | null;
  command: string | null;
  args: string[];
  /** env（stdio）或 headers（http）的**键名**；值不过桥 */
  credentialKeys: string[];
  /** 改已有的一台时，改之前是什么。新增时为 null */
  before: { url: string | null; command: string | null; toolCount: number } | null;
}

export type ApprovalPreview = WriteFilePreview | McpToolPreview | McpConfigurePreview;
```

`src/main/approvalPreview.ts` —— 在开头分派处加一行，并补实现：

```ts
  if (call.name === "mcp_configure") return mcpConfigurePreview(call, world);
```

```ts
/** mcp_configure 的预览。参数出自模型，形状一律不赌——认不出来就不预览，
    审批卡照常弹、走 JSON 兜底（同 write_file 分支的口径）。 */
function mcpConfigurePreview(call: ToolCallRequest, world: ExecutionWorld): ApprovalPreview | undefined {
  const mcp = world.mcp;
  if (!mcp) return undefined;
  const a = call.args as Record<string, unknown> | null;
  const id = a?.["id"];
  if (typeof id !== "string" || id === "") return undefined;

  const existing = mcp.configOf(id);
  const before = existing
    ? {
        url: existing.kind === "http" ? existing.url : null,
        command: existing.kind === "stdio" ? existing.command : null,
        toolCount: mcp.servers().find((s) => s.id === id)?.tools.length ?? 0,
      }
    : null;

  if (a?.["action"] === "remove") {
    return { kind: "mcp_configure", server: id, action: "remove", transport: null,
      url: null, command: null, args: [], credentialKeys: [], before };
  }

  const kind = a?.["kind"];
  if (kind !== "http" && kind !== "stdio") return undefined;
  const creds = kind === "http" ? a?.["headers"] : a?.["env"];
  return {
    kind: "mcp_configure",
    server: id,
    action: before ? "update" : "add",
    transport: kind,
    url: kind === "http" && typeof a?.["url"] === "string" ? (a["url"] as string) : null,
    command: kind === "stdio" && typeof a?.["command"] === "string" ? (a["command"] as string) : null,
    args: Array.isArray(a?.["args"]) ? (a["args"] as unknown[]).map(String) : [],
    // 只出键名。真值绝不过桥（ADR-0044）——审批卡要回答的是"配了哪几把"，
    // 不是"每把长什么样"
    credentialKeys: Object.keys(
      creds !== null && typeof creds === "object" && !Array.isArray(creds) ? creds : {}
    ),
    before,
  };
}
```

审批卡渲染：在渲染 `mcp_tool` 预览的那个组件里加一个 `kind === "mcp_configure"` 分支，逐行列出 `action` / `server` / `transport` / `url` 或 `command + args` / `credentialKeys` / `before`。样式照抄同文件里 `mcp_tool` 的参数表。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/tools/mcpConfigure.test.ts tests/main/approvalPreview.test.ts`
Expected: PASS（10 + 4 条）

- [ ] **Step 5: 跑门禁**

Run: `npm test`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add src/tools/mcpConfigure.ts src/shared/shellBridge.ts src/main/approvalPreview.ts src/renderer tests/tools/mcpConfigure.test.ts tests/main/approvalPreview.test.ts
git commit -m "feat(mcp): mcp_configure —— agent 配 MCP server，过审批门

审批门不是可选项：stdio 的 server 配置就是 command + args + env，agent 能
自由写盘等于绕开 bash 的审批门拿到任意命令执行，还附带任意环境变量。

审批卡逐字段列 command / 每一条 arg / 凭据键名，因为它是这条路上唯一的
安全闸——折成一句'配置一台 MCP server'等于闸形同虚设。凭据只出键名不出
值（ADR-0044 口径）。

url 只收 http/https：file:// 之类在这里没有正当用途，却能让一次'配置 MCP'
变成读本地文件的惊喜面。"
```

---

### Task 10: `mcp_authorize` 工具 + 三把刀挂上装配

**Files:**
- Create: `src/tools/mcpAuthorize.ts`
- Modify: `src/main/agent.ts`（`buildTools` 里挂三把）
- Test: `tests/tools/mcpAuthorize.test.ts`、`tests/main/agent.test.ts`（追加）

**Interfaces:**
- Consumes: Task 8 的 `McpCapability.authorize`；Task 6 的 `buildTools`
- Produces: `createMcpAuthorizeTool(mcp: McpCapability): Tool`

- [ ] **Step 1: 写失败的测试**

`tests/tools/mcpAuthorize.test.ts`：

```ts
import { describe, it, expect, vi } from "vitest";
import { createMcpAuthorizeTool } from "../../src/tools/mcpAuthorize.js";
import type { McpCapability, ExecutionWorld } from "../../src/world/executionWorld.js";

function cap(over: Partial<McpCapability> = {}): McpCapability {
  return {
    ready: async () => {}, servers: () => [], callTool: async () => [],
    readResource: async () => [], getPrompt: async () => "",
    configure: async () => {}, authorize: vi.fn(async () => {}), configOf: () => undefined,
    ...over,
  } as McpCapability;
}
const world = (mcp: McpCapability) => ({ mcp }) as ExecutionWorld;

describe("mcp_authorize", () => {
  it("免审批——浏览器必然弹出、用户必须亲手点同意，人天然在环里", () => {
    expect(createMcpAuthorizeTool(cap()).requiresApproval).toBe(false);
  });

  it("调 capability 的 authorize", async () => {
    const c = cap();
    await createMcpAuthorizeTool(c).run({ id: "supabase" }, world(c));
    expect(c.authorize).toHaveBeenCalledWith("supabase");
  });

  it("成功后回报这台现在有哪些工具", async () => {
    const c = cap({
      servers: () => [{ id: "s", name: "s", status: "connected", live: true,
        tools: [{ name: "list_tables", description: "", inputSchema: {} }], resources: [], prompts: [] }],
    });
    const out = await createMcpAuthorizeTool(c).run({ id: "s" }, world(c));
    expect(String(out)).toContain("list_tables");
  });

  it("授权失败把原因转述给模型，让它能告诉用户下一步", async () => {
    const c = cap({ authorize: vi.fn(async () => { throw new Error("等授权超时（300 秒没等到浏览器回调）"); }) });
    await expect(createMcpAuthorizeTool(c).run({ id: "s" }, world(c))).rejects.toThrow(/超时/);
  });

  it("id 不是字符串 → 人话", async () => {
    const c = cap();
    await expect(createMcpAuthorizeTool(c).run({}, world(c))).rejects.toThrow(/id/);
  });
});
```

`tests/main/agent.test.ts` 追加：

```ts
describe("MCP 自助配置的三把刀", () => {
  it("world 有 mcp 能力时三把都挂上，且都是 deferred", async () => {
    const agent = await createAgent(optsWithMcp());
    const names = agent.toolDefs().map((d) => d.name);
    // deferred 不进初始声明表，但在 toolsByName 里
    expect(agent.hasTool("mcp_catalog")).toBe(true);
    expect(agent.hasTool("mcp_configure")).toBe(true);
    expect(agent.hasTool("mcp_authorize")).toBe(true);
    expect(names).not.toContain("mcp_configure");
  });

  it("没有 mcp 能力的装配一把都不挂", async () => {
    const agent = await createAgent(optsWithoutMcp());
    expect(agent.hasTool("mcp_configure")).toBe(false);
  });

  it("子 agent 的白名单没点名时拿不到 mcp_configure（ADR-0054）", async () => {
    const child = await createAgent({ ...optsWithMcp(), allowTools: ["read_file"] });
    expect(child.hasTool("mcp_configure")).toBe(false);
  });
});
```

> 实现者注：`agent.hasTool` / `agent.toolDefs` 若不存在，按该测试文件既有的探查手法改写断言（例如读 `createAgent` 返回值上暴露的工具表，或用假 adapter 抓 `chat()` 收到的 `tools`）。

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/tools/mcpAuthorize.test.ts tests/main/agent.test.ts`
Expected: FAIL

- [ ] **Step 3: 写实现**

`src/tools/mcpAuthorize.ts`：

```ts
// mcp_authorize —— 对一台 needs-auth 的 server 拉起 OAuth 授权。
//
// 不设审批门（spec §7）：它必然弹出系统浏览器、用户必须亲手在服务商的
// 页面上点同意——人天然在环里，再加一道审批门是重复劳动而非安全增益。
// 而且这把刀改不了任何配置：它只能对**已经配好的**那台跑授权流程，
// 能造成的最坏结果是浏览器白开一次。

import type { Tool } from "./tool.js";
import type { McpCapability, ExecutionWorld } from "../world/executionWorld.js";

export function createMcpAuthorizeTool(_mcp: McpCapability): Tool {
  return {
    def: {
      name: "mcp_authorize",
      description:
        "对一台需要授权（needs-auth）的 MCP server 拉起 OAuth 授权：会打开系统浏览器，" +
        "用户在服务商页面登录并点同意后自动重连。授权期间这次调用会一直等（最多 5 分钟）。",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "server 在配置里的名字" } },
        required: ["id"],
      },
    },
    exposure: "deferred",
    requiresApproval: false,
    async run(args, world: ExecutionWorld) {
      if (!world.mcp) throw new Error("这个装配没有 MCP 能力，授权不了");
      const id = (args as { id?: unknown } | null)?.id;
      if (typeof id !== "string" || id === "") throw new Error("id 必填，且必须是字符串");
      // 失败原样抛：超时 / 用户拒绝 / 服务端报错是三件不同的事，模型要拿到
      // 具体原因才能告诉用户下一步该做什么
      await world.mcp.authorize(id);
      const hit = world.mcp.servers().find((s) => s.id === id);
      if (hit?.live) {
        return `「${id}」授权完成并已连上，可用工具 ${hit.tools.length} 个：${hit.tools.map((t) => t.name).join("、")}`;
      }
      return `「${id}」的授权流程跑完了，但还没连上：${hit?.error ?? "原因未知"}`;
    },
  };
}
```

`src/main/agent.ts` 的 `buildTools()` 里，在既有的两行 MCP 工具旁边加：

```ts
      // 自助配置三件套（spec §5.2）：查目录免审批、配置过审批门、授权免审批
      // （浏览器必然弹出、用户必须亲手点同意，人天然在环里）。
      // 三把都是 deferred：绝大多数会话用不到它们，不该占初始工具表的位置
      ...(mcp ? [mcpCatalogTool, createMcpConfigureTool(mcp), createMcpAuthorizeTool(mcp)] : []),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/tools/mcpAuthorize.test.ts tests/main/agent.test.ts`
Expected: PASS

- [ ] **Step 5: 跑门禁**

Run: `npm test`
Expected: 全绿

- [ ] **Step 6: 手动验一次完整链路**

Run: `npm run dev`，在对话里说「帮我接上 supabase，project ref 是 <你的 ref>」。
Expected: agent 查目录 → 弹出 `mcp_configure` 审批卡（卡上能看到完整 URL）→ 同意 → agent 调 `mcp_authorize` → 浏览器打开 → 点同意 → agent 回报「接好了，可用工具 N 个」→ **同一个会话里**接着让它查一张表，工具能调通。

- [ ] **Step 7: 提交**

```bash
git add src/tools/mcpAuthorize.ts src/main/agent.ts tests/tools/mcpAuthorize.test.ts tests/main/agent.test.ts
git commit -m "feat(mcp): mcp_authorize + 三把刀挂上装配

mcp_authorize 刻意不设审批门：它必然弹出浏览器、用户必须亲手在服务商页面
点同意，人天然在环里，再加一道门是重复劳动而非安全增益。而且它改不了任何
配置，最坏结果是浏览器白开一次。

三把都是 deferred：绝大多数会话用不到，不该占初始工具表的位置。子 agent
照旧要白名单点名才拿得到（ADR-0054）——派活不该顺带给出改系统配置的能力。"
```

---

### Task 11: 三份 ADR + CONTEXT.md 词条 + 索引

**Files:**
- Create: `docs/adr/00XX-mcp-oauth-授权.md`
- Create: `docs/adr/00XX-agent-自助配置-mcp-的权限边界.md`
- Create: `docs/adr/00XX-工具表按-turn-重算.md`
- Modify: `CONTEXT.md`（产品/技术术语段）
- Modify: `AGENTS.md` 的「Where to find things」

**Interfaces:**
- Consumes: 全部前置 Task
- Produces: 无代码

- [ ] **Step 1: 认领 ADR 编号**

Run: `git fetch origin && ls docs/adr | tail -5`
取当前最大编号 + 1、+2、+3。**编号在合并时认领**（项目 ADR-0074）：合并前再 fetch 一次，若别人先落了你的号，在自己 PR 内改名并加 `原为 ADR-00XX` 行，同时更新仓内全部引用。

- [ ] **Step 2: 写三份 ADR**

每份按仓内既有格式（`# ADR-00XX：标题` / 日期 / 状态 / 相关 / 背景 / 决定 / 被否掉的路 / 后果）。内容分别取 spec 的 §3.2+§3.3、§3.1、§3.4——**理由和被否掉的路照搬，不要重写成摘要**（复制会衰减，但 ADR 是决策的正本，这里要的是完整论证）。三份都在「相关」里指回 spec 路径。

- [ ] **Step 3: 补 CONTEXT.md 词条**

在产品/技术术语段加三条：**loopback 回调**、**needs-auth**、**工具表热更新**。每条一到两句，指向源 ADR。

- [ ] **Step 4: 补 AGENTS.md 索引**

在「Where to find things」加两行：

```
- `src/main/mcpOAuth.ts` / `src/main/mcpAuthStore.ts` — MCP 的 OAuth 授权：loopback 回调 + 0600 凭据落点（ADR-00XX）
- `src/tools/mcpConfigure.ts` — agent 自助配置 MCP，过审批门（ADR-00XX）
```

> AGENTS.md 的「Where to find things」是索引，属 L2 自主层（ADR-0005），本 PR 可自行合并；但仍需 issue + ADR + PR 三件套齐全。

- [ ] **Step 5: 跑门禁**

Run: `npm test`
Expected: 全绿（含 `tests/docs/adrNumbers.test.ts` 的编号唯一断言）

- [ ] **Step 6: 提交并开 PR**

```bash
git add docs/adr CONTEXT.md AGENTS.md
git commit -m "docs(adr): MCP OAuth / agent 自助配置权限边界 / 工具表按 turn 重算

三个决策各一份，理由与被否掉的路完整保留——ADR 是决策的正本，摘要化会让
下一个人无法判断'什么前提失效时该推翻它'。"
git push -u origin worktree-mcp-oauth-agent-config
gh pr create --title "MCP OAuth 授权 + agent 自助配置 MCP" --body "..."
```

PR 正文要点：closes 对应的 Task issue、贴 `npm test` 结果、贴 Task 5 与 Task 10 两次手动验收的结果（GUI 改动的 PR 要贴 e2e/真机结果，ADR-0058）。

---

## 自查

**Spec 覆盖**：§3.1 → Task 9；§3.2 → Task 2、3；§3.3 → Task 1；§3.4 → Task 6；§3.5 → Task 7；§4 模块划分 → Task 1/2/3/7/9/10；§5.1 授权流 → Task 3、4；§5.2 配置流 → Task 7/9/10；§6 UI → Task 5、9；§7 不变量 → Task 1（0600 / 不回流）、Task 2（state / 只收一次）、Task 9（键名不出值）、Task 10（子 agent 白名单）；§8 测试 → 各 Task 的 Step 1；§9 限制 → 无需实现；§10 协议动作 → Task 11。无遗漏。

**已知的实现者判断点**（不是占位符，是需要现场对齐仓内既有写法的地方，每处都标了参照对象）：
- Task 5 的 preload 透传行、审批卡组件的具体文件名 —— 照抄 `reconnectMcpServer` / `mcp_tool` 那一块
- Task 6 的 `lastToolDefs` / `exposeDeferred` 测试辅助 —— 按 `tests/loop/engine.test.ts` 既有的假 adapter 写法补
- Task 9 的 `worldWithMcp` 测试辅助 —— 按 `tests/main/approvalPreview.test.ts` 既有写法补
- Task 10 的 `agent.hasTool` —— 按 `tests/main/agent.test.ts` 既有的工具表探查手法改写
