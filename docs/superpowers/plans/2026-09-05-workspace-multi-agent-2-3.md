# 工作区多智能体 · 切片 2 + 3 + #945 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让工作区 agent 能真动连接器（每只一份白名单）、看得见每只烧了多少（`usage_event.agent_id` + 设置页周用量表），顺手修掉云会话头部「未配模型」对订阅用户撒谎（#945）。

**Architecture:** 切片 2 是「一份纯逻辑三处用」：`src/shared/agentToolAllow.ts` 定义白名单形状与过滤函数，runtime 在 `fetchGrantedTools` 之后过一道，桌面快照/表单用同一份归一化；勾选表复用 `proxyShare.ts` 的换算。切片 3 是「一列 + 一个头 + 一个端点」：`usage_event.agent_id`（migration 0022），runtime 调网关多带 `x-otto-agent`，edge 新开 `GET /billing/v1/workspace-usage` 按 owner 的周窗现聚合（`weekStartFor` 复用，不碰 Quota DO），桌面经 hostedQuota 拉、设置页第五个 tab 画。#945 是 welcome/config_result 多一格 `modelRoute`（runtime 用 `decideRuntimeRoute` 算好下发，协议版本 4→5），渲染层只读它不重算。

**Tech Stack:** TypeScript strict / vitest / React + Zustand + shadcn / Supabase (PostgREST) / Cloudflare Worker (edge) / Node daemon (runtime)

**Spec:** `docs/superpowers/specs/2026-09-04-workspace-multi-agent-design.md`（§3 数据模型、§7 用量归因、§9 权限矩阵、§10 切片表）。Issues：#941（切片 2 交接）、#946（切片 3）、#945。

## Global Constraints

- 硬规则（AGENTS.md）：渲染进程只经 `ShellBridge`；工具实现只依赖 `ExecutionWorld`；事件 schema 只增不改；测试放 `tests/` 镜像 `src/`。
- `tools` 白名单口径（spec §3）：**顶层 `[]` = 整池放行**；条目 `{ serverId, tools }` 中 **`tools: []` = 这台服务全部工具放行**（与 `workspace_connectors` / `proxyShare.ts` 同口径）。匹配只看 `serverId`，不看 `hostUid`（两个 host 贡献同一个 `serverId` 时两台都放行——接受，写进 ADR）。
- jsonb 形状不对（不是数组 / 条目缺 `serverId` / `tools` 不是字符串数组）一律归一化成 `[]`——同 `workspaces.ts` 的 `normalizeStringArray` 纪律。
- 「只用勾选的」模式下一台都没勾 = **不可保存**（`[]` 表达不了「一台都不给」，同 `proxyShare.ts` 文件头那条约定）。
- cs 协议加字段**要进位**（`src/shared/remote/cloudSession.ts` 文件头：握手精确相等，两端一起发版）：#945 把 `CS_PROTOCOL_VERSION` 4 → 5。
- `usage_event.agent_id` 的 migration 编号取 **0022**（spec 写 0023 是按 4→3 的顺序预估的；编号在合并前 re-fetch 复核，ADR-0074）。`agent_id text not null default ''`，旧行与桌面直连的行都是空串。
- 周窗起点 = **工作区 owner** 的订阅 `current_period_start` 过 `quota.ts` 的 `weekStartFor`；owner 没订阅时退回「此刻往前 7 天」（那种工作区走自带 key，`usage_event` 里本来就没有它的行）。
- `x-otto-agent` 头与 `x-otto-workspace` 同款：值截到 128 字符、只在 runtime 路径上带（桌面直连的请求不带，落库空串）。
- 新端点只收**真人 JWT**（platform 身份回 403），且调用者必须在籍（`workspace_members`）。
- `services/edge/src/worker.ts` 不进 vitest（文件头写明）：切片 3 的 worker 实现保持薄，所有判断落在 `usageAttribution.ts` 纯函数里并单测。
- 提交信息写**为什么**；每个任务末尾 `npx vitest run <本任务的测试文件>` 绿，任务 5/10 这类改类型的任务另跑 `npx tsc --noEmit`。
- 不动 `model_usage` 本地事件、不动 `usage_ledger` 旧表、不动 Quota DO。

## 部署清单（控制者在合并后做，不是实现者的事）

1. migration `0022_usage_event_agent_id.sql` 在生产 Supabase 跑一次——**DDL 是外向副作用，要维护者点头**。
2. `services/edge` 重新部署（README 五步）——#791：edge 不跟发版走。
3. `RUNTIME_SSH=stan@65.109.113.168 npm run runtime:deploy`。
4. 顺序：先 1 再 2 再 3（runtime 先带 `x-otto-agent` 而 edge 没升级是无害的：edge 忽略未知头；edge 先升级而列没加会让 `usage_event` 插入 400、settle 落库失败只记日志——所以 migration 必须最先）。

---

## 文件结构

**切片 2**
- Create `src/shared/agentToolAllow.ts` — 白名单形状 + 归一化 + 过滤（三端共用）
- Create `src/renderer/src/lib/agentToolsForm.ts` — 编辑弹窗那张勾选表的纯逻辑（模式 / 候选行 / 草稿校验）
- Modify `src/shared/workspaces.ts`、`src/main/supabaseWorkspacesApi.ts`、`src/main/workspaceManager.ts`、`src/shared/shellBridge.ts`、`src/main/index.ts`、`src/renderer/src/store.ts`、`src/renderer/src/lib/workspaceView.ts`、`src/renderer/src/components/WorkspaceAgentsTab.tsx`
- Modify `services/runtime/src/sessionService.ts`、`services/runtime/src/daemon.ts`

**切片 3**
- Create `supabase/migrations/0022_usage_event_agent_id.sql`
- Create `services/edge/src/usageAttribution.ts` — 查询串 / 行解析 / 按 agent 聚合 / 周窗
- Create `src/renderer/src/lib/workspaceUsageView.ts`、`src/renderer/src/components/WorkspaceUsageTab.tsx`
- Modify `src/shared/billing.ts`（`AGENT_HEADER`、`WorkspaceUsage`、`parseWorkspaceUsage`）、`services/edge/src/llmGateway.ts`（`Caller.agentId`）、`services/edge/src/edge.ts`（callerOf + 新路由 + `BillingPort.workspaceUsage`）、`services/edge/src/billingQueries.ts`（insert 多一列）、`services/edge/src/worker.ts`（实现）、`services/runtime/src/hostedRoute.ts`（头）、`services/runtime/src/daemon.ts`（传 agentId）、`src/main/hostedQuota.ts`、`src/shared/shellBridge.ts`、`src/preload/index.ts`、`src/main/index.ts`、`src/renderer/src/store.ts`、`src/renderer/src/components/WorkspacePage.tsx`

**#945**
- Create `src/renderer/src/lib/cloudModelStatus.ts`（从 `CloudSessionPage.tsx` 抽出来的 `modelStatusText`，多一个入参）
- Modify `src/shared/remote/cloudSession.ts`（`CsModelRoute`、版本 5）、`services/runtime/src/hostedRoute.ts`（`probeModelRoute`）、`services/runtime/src/frameHandler.ts`（deps.modelRoute）、`services/runtime/src/daemon.ts`、`src/main/cloudSessionClient.ts`、`src/shared/shellBridge.ts`、`src/renderer/src/store.ts`、`src/renderer/src/components/CloudSessionPage.tsx`

**文档**
- Create `docs/adr/0221-工作区多智能体连接器白名单与用量归因.md`；Modify `AGENTS.md`（索引）、`CONTEXT.md`（术语）、spec §10 备注

---

### Task 1: 白名单纯逻辑 + 快照长出 `tools`

**Files:**
- Create: `src/shared/agentToolAllow.ts`
- Modify: `src/shared/workspaces.ts:37-45`（`WorkspaceAgentRow`）、`:77-125`（`assembleSnapshot` agents 参数与映射）
- Modify: `src/main/supabaseWorkspacesApi.ts:100-108`（select 多一列 `tools`，行类型多 `tools: unknown`）
- Test: `tests/shared/agentToolAllow.test.ts`（新）、`tests/shared/workspaces.test.ts:80-93`（agents 用例补 `tools`）
- 其余用到 `WorkspaceAgentRow` 字面量的测试 fixture 补 `tools: []`（`tsc` 会点名：`tests/renderer/workspaceView.agents.test.ts`、`tests/renderer/cloudTimelineLabels.test.ts`，以及别的报错处）

**Interfaces:**
- Produces:
  ```ts
  export interface AgentToolAllow { serverId: string; tools: string[] }
  export function normalizeAgentTools(value: unknown): AgentToolAllow[]
  export function filterGrantedByAllow<T extends { serverId: string; toolDefs: readonly { name: string }[] }>(
    granted: readonly T[], allow: readonly AgentToolAllow[]): T[]
  export function sameAgentTools(a: readonly AgentToolAllow[], b: readonly AgentToolAllow[]): boolean
  ```
  `WorkspaceAgentRow.tools: AgentToolAllow[]`；`assembleSnapshot` 的 agents 行多 `tools: unknown`。

- [ ] **Step 1: 写失败测试 `tests/shared/agentToolAllow.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { filterGrantedByAllow, normalizeAgentTools, sameAgentTools } from "../../src/shared/agentToolAllow.js";

const granted = [
  { hostUid: "h1", serverId: "shopify", toolDefs: [{ name: "list_orders" }, { name: "cancel_order" }] },
  { hostUid: "h1", serverId: "ads", toolDefs: [{ name: "report" }] },
  { hostUid: "h2", serverId: "shopify", toolDefs: [{ name: "list_orders" }] },
];

describe("normalizeAgentTools（jsonb → 白名单）", () => {
  it("合法形状原样落地，tools 里的非字符串项让整份回 []", () => {
    expect(normalizeAgentTools([{ serverId: "shopify", tools: ["a"] }, { serverId: "ads", tools: [] }]))
      .toEqual([{ serverId: "shopify", tools: ["a"] }, { serverId: "ads", tools: [] }]);
    expect(normalizeAgentTools([{ serverId: "shopify", tools: ["a", 1] }])).toEqual([]);
  });
  it("不是数组 / 条目缺 serverId / tools 不是数组 → []（形状不对 = 当没配，同 connectors.tools）", () => {
    expect(normalizeAgentTools(null)).toEqual([]);
    expect(normalizeAgentTools("nope")).toEqual([]);
    expect(normalizeAgentTools([{ tools: [] }])).toEqual([]);
    expect(normalizeAgentTools([{ serverId: "x", tools: "all" }])).toEqual([]);
  });
});

describe("filterGrantedByAllow", () => {
  it("[] = 整池放行，原样回", () => {
    expect(filterGrantedByAllow(granted, [])).toEqual(granted);
  });
  it("只留白名单里的 serverId；条目 tools:[] = 该服务全部工具；**两个 host 的同名 server 都放行**", () => {
    expect(filterGrantedByAllow(granted, [{ serverId: "shopify", tools: [] }])).toEqual([granted[0], granted[2]]);
  });
  it("条目点了工具名就按名字过滤；过滤后一个都不剩的服务不进结果", () => {
    expect(filterGrantedByAllow(granted, [{ serverId: "shopify", tools: ["cancel_order"] }, { serverId: "ads", tools: ["nope"] }]))
      .toEqual([{ hostUid: "h1", serverId: "shopify", toolDefs: [{ name: "cancel_order" }] }]);
  });
});

describe("sameAgentTools", () => {
  it("顺序无关、内容相同才算同", () => {
    expect(sameAgentTools([{ serverId: "a", tools: ["x", "y"] }], [{ serverId: "a", tools: ["y", "x"] }])).toBe(true);
    expect(sameAgentTools([{ serverId: "a", tools: [] }], [{ serverId: "a", tools: ["x"] }])).toBe(false);
    expect(sameAgentTools([], [{ serverId: "a", tools: [] }])).toBe(false);
  });
});
```

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run tests/shared/agentToolAllow.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写 `src/shared/agentToolAllow.ts`**

```ts
// agentToolAllow —— 工作区 agent 的连接器白名单（spec §3，切片 2）。
// 三端共用一份（runtime 过滤 / 桌面快照与表单 / 手机端将来），只有类型 + 纯函数。
//
// 口径与 workspace_connectors / proxyShare.ts 一致，两层都是「空 = 全给」：
//   顶层 []                    = 整池放行（这只 agent 拿得到工作区里贡献的全部连接器）
//   条目 { serverId, tools: [] } = 这台服务的全部工具
//   条目 { serverId, tools: [..] } = 只给点名的这几个
// 「一台都不给」在这个编码里**表达不了**——表单层负责不让用户存出那种状态
// （agentToolsForm.ts 的 toolsDraftError）。
//
// 匹配只看 serverId 不看 hostUid：两个成员各自贡献了同一个 serverId 时两台都放行。
// 白名单是「配错了」的护栏不是越权闸（spec §11），真正的三道闸在 edge 的 pxGate。

export interface AgentToolAllow {
  serverId: string;
  tools: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** jsonb → 白名单。形状不对（不是数组 / 条目缺 serverId / tools 不是字符串数组）
    整份回 []——同 workspaces.ts 的 normalizeStringArray：宁可当没配，不猜 */
export function normalizeAgentTools(value: unknown): AgentToolAllow[] {
  if (!Array.isArray(value)) return [];
  const out: AgentToolAllow[] = [];
  for (const item of value) {
    if (!isObj(item) || typeof item.serverId !== "string") return [];
    if (!Array.isArray(item.tools) || !item.tools.every((t) => typeof t === "string")) return [];
    out.push({ serverId: item.serverId, tools: [...(item.tools as string[])] });
  }
  return out;
}

/** fetchGrantedTools 的产物过一道白名单。[] = 整池放行；过滤后一个工具都不剩的
    服务不进结果（engine 挂一台空服务没意义，还会在工具表里占一行） */
export function filterGrantedByAllow<T extends { serverId: string; toolDefs: readonly { name: string }[] }>(
  granted: readonly T[],
  allow: readonly AgentToolAllow[]
): T[] {
  if (allow.length === 0) return [...granted];
  const out: T[] = [];
  for (const g of granted) {
    const entry = allow.find((a) => a.serverId === g.serverId);
    if (!entry) continue;
    if (entry.tools.length === 0) {
      out.push(g);
      continue;
    }
    const toolDefs = g.toolDefs.filter((t) => entry.tools.includes(t.name));
    if (toolDefs.length > 0) out.push({ ...g, toolDefs });
  }
  return out;
}

/** 两份白名单是不是同一份（编辑弹窗「只发变了的字段」用）。顺序无关 */
export function sameAgentTools(a: readonly AgentToolAllow[], b: readonly AgentToolAllow[]): boolean {
  if (a.length !== b.length) return false;
  const key = (x: AgentToolAllow): string => `${x.serverId} ${[...x.tools].sort().join("")}`;
  const sa = a.map(key).sort();
  const sb = b.map(key).sort();
  return sa.every((k, i) => k === sb[i]);
}
```

- [ ] **Step 4: `src/shared/workspaces.ts` 长出 `tools`**

在文件顶部加 `import { normalizeAgentTools, type AgentToolAllow } from "./agentToolAllow.js";`。

`WorkspaceAgentRow` 在 `models: string[];` 后加：
```ts
  /** 连接器白名单（spec §3）：[] = 整池放行。形状见 agentToolAllow.ts */
  tools: AgentToolAllow[];
```

`assembleSnapshot` 的 `agents` 参数类型改成：
```ts
  agents: readonly {
    agent_id: string; name: string; description: string; instructions: string; models: unknown;
    tools: unknown; created_by: string; updated_at: string;
  }[],
```
映射里 `models: normalizeStringArray(a.models),` 后加 `tools: normalizeAgentTools(a.tools),`。

- [ ] **Step 5: `src/main/supabaseWorkspacesApi.ts` select 多一列**

把 `.select("agent_id,name,description,instructions,models,created_by,updated_at")` 改成
`.select("agent_id,name,description,instructions,models,tools,created_by,updated_at")`，紧随其后的行类型加 `tools: unknown;`。

- [ ] **Step 6: 补 `tests/shared/workspaces.test.ts` 的 agents 用例**

两行输入各加 `tools`：admin 行 `tools: [{ serverId: "shopify", tools: [] }]`，a1 行 `tools: "garbage"`。期望：admin 行 `tools: [{ serverId: "shopify", tools: [] }]`，a1 行 `tools: []`。用例名改成「agents：models/tools 形状不对回 []，updated_at → ms，created_by 原样」。

- [ ] **Step 7: 跑 tsc，把所有 `WorkspaceAgentRow` 字面量 fixture 补上 `tools: []`**

Run: `npx tsc --noEmit`
按报错逐个补（预期至少 `tests/renderer/workspaceView.agents.test.ts`、`tests/renderer/cloudTimelineLabels.test.ts`）。

- [ ] **Step 8: 跑，确认绿**

Run: `npx vitest run tests/shared/agentToolAllow.test.ts tests/shared/workspaces.test.ts tests/renderer && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add src/shared/agentToolAllow.ts src/shared/workspaces.ts src/main/supabaseWorkspacesApi.ts tests/
git commit -m "feat(shared): 工作区 agent 的连接器白名单形状 + 快照长出 tools（#941 切片 2）

[] = 整池放行、条目 tools:[] = 整台放行，与 workspace_connectors / proxyShare 同口径；
形状不对整份回 []，同 normalizeStringArray 的纪律。过滤只看 serverId 不看 hostUid。"
```

---

### Task 2: runtime 在 `fetchGrantedTools` 之后过白名单

**Files:**
- Modify: `services/runtime/src/sessionService.ts:85-94`（`AgentSpec`）、`:381-391`（`runJob` 的 `cachedPxTools` 赋值）
- Modify: `services/runtime/src/daemon.ts:66-72`（`DEFAULT_WORKSPACE_AGENT`）、`:265-278`（`queryAgents`）
- Test: `tests/runtime/sessionService.test.ts`（fixture 补 `tools: []`；新增两个用例）

**Interfaces:**
- Consumes: Task 1 的 `AgentToolAllow` / `normalizeAgentTools` / `filterGrantedByAllow`
- Produces: `AgentSpec.tools: AgentToolAllow[]`

- [ ] **Step 1: fixture 补字段**

`tests/runtime/sessionService.test.ts` 里所有 `AgentSpec` 字面量（`DEFAULT_AGENT`、`AGENTS` 两条、`SOLO_AGENT`、`ROSTER` 各条、以及 `{ ...AGENTS[0]!, models: [model] }` 那种展开不用动）加 `tools: []`。

- [ ] **Step 2: 写失败测试（追加到文件末尾）**

```ts
describe("连接器白名单（#941 切片 2）", () => {
  const GRANTS = {
    servers: [
      { serverId: "shopify", toolDefs: [{ name: "list_orders", description: "", inputSchema: {} }, { name: "cancel_order", description: "", inputSchema: {} }] },
      { serverId: "ads", toolDefs: [{ name: "report", description: "", inputSchema: {} }] },
    ],
  };
  const pxWithGrants: PxCallDeps = {
    ...px,
    fetchImpl: (async () => ({ ok: true, status: 200, json: async () => GRANTS })) as unknown as typeof fetch,
  };
  function sessionWithAgent(tools: { serverId: string; tools: string[] }[], seen: string[][]) {
    const adapter: ModelAdapter = {
      model: "fake-model",
      async chat(_m, toolDefs): Promise<ModelReply> {
        seen.push((toolDefs ?? []).map((t) => t.name));
        return { content: "ok" };
      },
    };
    return createCloudSession({
      workspaceId: "w1", sessionId: "s1", ownerUid: "owner", createdByUid: "creator",
      store: newStore(), world: fakeWorld,
      agents: async () => [{ ...DEFAULT_AGENT, tools }],
      adapterFor: () => adapter, px: pxWithGrants,
      hostUids: async () => ["h1"],
      onEvent: () => {}, onUsage: () => {},
    });
  }

  it("tools:[] = 整池放行：三把 px 刀都挂上", async () => {
    const seen: string[][] = [];
    const session = sessionWithAgent([], seen);
    await session.say("u1", "alice", "看下", true);
    await session.settled();
    expect(seen[0]).toEqual(expect.arrayContaining(["px_h1_shopify_list_orders", "px_h1_shopify_cancel_order", "px_h1_ads_report"]));
  });

  it("点了名的只挂点名那几把；没点名的服务整台不挂", async () => {
    const seen: string[][] = [];
    const session = sessionWithAgent([{ serverId: "shopify", tools: ["list_orders"] }], seen);
    await session.say("u1", "alice", "看下", true);
    await session.settled();
    expect(seen[0]).toContain("px_h1_shopify_list_orders");
    expect(seen[0]).not.toContain("px_h1_shopify_cancel_order");
    expect(seen[0]).not.toContain("px_h1_ads_report");
  });
});
```

- [ ] **Step 3: 跑，确认红**

Run: `npx vitest run tests/runtime/sessionService.test.ts -t "连接器白名单"`
Expected: FAIL（`tools` 不在 `AgentSpec` 上 / 第二个用例多挂了刀）

- [ ] **Step 4: `sessionService.ts`**

import 区加 `import { filterGrantedByAllow, type AgentToolAllow } from "../../../src/shared/agentToolAllow.js";`（与 pxTools 的 `../../../src/tools/tool.js` 同一种相对路径）。

`AgentSpec` 在 `models: string[];` 后加：
```ts
  /** 连接器白名单（spec §3，切片 2）：[] = 整池放行。接在 fetchGrantedTools 之后过一道 */
  tools: AgentToolAllow[];
```

`runJob` 里 `cachedPxTools = buildPxTools(opts.px, job.fromUid, granted);` 改成：
```ts
      // 切片 2：白名单接在拉取之后、建刀之前。过滤只看 serverId（agentToolAllow.ts 头注）。
      // [] = 整池放行，所以 1b 之前建的 agent 行为不变
      cachedPxTools = buildPxTools(opts.px, job.fromUid, filterGrantedByAllow(granted, spec.tools));
```

- [ ] **Step 5: `daemon.ts`**

import 加 `import { normalizeAgentTools } from "../../../src/shared/agentToolAllow.js";`。
`DEFAULT_WORKSPACE_AGENT` 的 `models: [],` 后加 `tools: [],`。
`queryAgents`：select 改 `"agent_id,name,description,instructions,models,tools"`；行类型加 `tools: unknown`；映射加 `tools: normalizeAgentTools(r.tools),`。

- [ ] **Step 6: 跑，确认绿**

Run: `npx vitest run tests/runtime && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add services/runtime/src/sessionService.ts services/runtime/src/daemon.ts tests/runtime/sessionService.test.ts
git commit -m "feat(runtime): agent 的连接器白名单接在 fetchGrantedTools 之后过一道（#941 切片 2）

过滤落在 cachedPxTools 赋值处，engine 不改；[] = 整池放行所以存量 agent 行为不变。"
```

---

### Task 3: 桌面建改 agent 带上 `tools`（主进程 + 桥 + store）

**Files:**
- Modify: `src/main/supabaseWorkspacesApi.ts:212-249`（`insertAgentRow` / `updateAgentRow`）
- Modify: `src/main/workspaceManager.ts:70-84`（接口）、`:215-238`（实现透传即可——draft/patch 是展开的）
- Modify: `src/shared/shellBridge.ts:1053-1062`
- Modify: `src/main/index.ts:3217-3230`
- Modify: `src/renderer/src/store.ts:853-861`、`:2127-2151`
- Test: `tests/main/workspaceManager.test.ts:300-330`

**Interfaces:**
- Consumes: `AgentToolAllow`
- Produces: `createAgent(id, { name, description, instructions, models, tools })`；`updateAgent(id, agentId, { ..., tools? })`；store 同名两 action 的 draft/patch 多 `tools`。

- [ ] **Step 1: 写失败测试（`tests/main/workspaceManager.test.ts` 的 `describe("workspace agents（#932）")` 里追加）**

```ts
  it("createAgent / updateAgent 透传 tools（切片 2）", async () => {
    const inserted: unknown[] = [];
    const updated: unknown[] = [];
    const { manager } = harness({
      insertAgentRow: async (_c, row) => { inserted.push(row); },
      updateAgentRow: async (_c, _ws, _id, patch) => { updated.push(patch); },
    });
    const tools = [{ serverId: "shopify", tools: ["list_orders"] }];
    await manager.createAgent("ws-1", { name: "运营", description: "", instructions: "", models: [], tools });
    expect(inserted[0]).toMatchObject({ tools });
    await manager.updateAgent("ws-1", "a_1", { tools: [] });
    expect(updated[0]).toEqual({ tools: [] });
  });
```

同一 describe 里既有的 `createAgent(...)` 三处调用补 `tools: []`（tsc 会点名）。

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run tests/main/workspaceManager.test.ts`
Expected: FAIL（类型 / 透传缺字段）

- [ ] **Step 3: 主进程**

`supabaseWorkspacesApi.ts`：
- `insertAgentRow` 的 `row` 类型加 `tools: AgentToolAllow[];`，insert 体加 `tools: row.tools,`。
- `updateAgentRow` 的 `patch` 类型加 `tools?: AgentToolAllow[];`（`...patch` 已经会把它带上）。
- 文件顶部 `import type { AgentToolAllow } from "../shared/agentToolAllow.js";`

`workspaceManager.ts`：接口 `createAgent` 的 draft 加 `tools: AgentToolAllow[]`，`updateAgent` 的 patch 加 `tools?: AgentToolAllow[]`；import 同上。实现体不用改（`...draft` / `patch` 透传）。

`shellBridge.ts`：`workspaceAgentCreate` draft 加 `tools: AgentToolAllow[]`；`workspaceAgentUpdate` patch 加 `tools?: AgentToolAllow[]`；import type。

`index.ts` 两个 handler 的参数类型同步加 `tools` / `tools?`。

- [ ] **Step 4: store**

`store.ts` 接口：`createWorkspaceAgent` draft 加 `tools: readonly AgentToolAllow[]`；`updateWorkspaceAgent` patch 加 `tools?: readonly AgentToolAllow[]`。

实现：
```ts
  async createWorkspaceAgent(id, draft) {
    const r = await window.otter.workspaceAgentCreate(id, {
      ...draft, models: [...draft.models], tools: draft.tools.map((t) => ({ serverId: t.serverId, tools: [...t.tools] })),
    });
```
```ts
  async updateWorkspaceAgent(id, agentId, patch) {
    const { models, tools, ...rest } = patch;
    const r = await window.otter.workspaceAgentUpdate(id, agentId, {
      ...rest,
      ...(models === undefined ? {} : { models: [...models] }),
      ...(tools === undefined ? {} : { tools: tools.map((t) => ({ serverId: t.serverId, tools: [...t.tools] })) }),
    });
```

- [ ] **Step 5: 跑，确认绿**

Run: `npx vitest run tests/main/workspaceManager.test.ts && npx tsc --noEmit`
Expected: PASS（`WorkspaceAgentsTab.tsx` 此刻会因 create 缺 `tools` 报红——在 `submit` 里先临时传 `tools: []`，Task 4 换成真值）

- [ ] **Step 6: 提交**

```bash
git add src/main src/shared/shellBridge.ts src/renderer/src/store.ts src/renderer/src/components/WorkspaceAgentsTab.tsx tests/main/workspaceManager.test.ts
git commit -m "feat(workspace): 建改 agent 的 IPC 带上连接器白名单 tools（#941 切片 2）"
```

---

### Task 4: 设置页勾选表

**Files:**
- Create: `src/renderer/src/lib/agentToolsForm.ts`
- Modify: `src/renderer/src/lib/workspaceView.ts:114-149`（`AgentRowView.toolsSummary` + `agentRows`）
- Modify: `src/renderer/src/components/WorkspaceAgentsTab.tsx`（行摘要 + 编辑弹窗「连接器」段）
- Test: `tests/renderer/agentToolsForm.test.ts`（新）、`tests/renderer/workspaceView.agents.test.ts`

**Interfaces:**
- Consumes: `proxyShare.ts` 的 `ProxySelection` / `selectionFromAllow` / `buildAllow` / `toggleServer` / `toggleTool` / `isServerOn` / `isToolOn` / `describeAllow`；Task 1 的 `AgentToolAllow` / `sameAgentTools`
- Produces:
  ```ts
  export type ToolsMode = "all" | "some";
  export interface ConnectorChoice { serverId: string; hostLabels: string[]; toolNames: string[] | null }
  export function connectorChoices(ws: WorkspaceSnapshot): ConnectorChoice[]
  export function modeFromTools(tools: readonly AgentToolAllow[]): ToolsMode
  export function toolsDraftError(mode: ToolsMode, sel: ProxySelection): string | null
  export function toolsFromDraft(mode: ToolsMode, sel: ProxySelection): AgentToolAllow[]
  ```

- [ ] **Step 1: 写失败测试 `tests/renderer/agentToolsForm.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { connectorChoices, modeFromTools, toolsDraftError, toolsFromDraft } from "../../src/renderer/src/lib/agentToolsForm.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const ws: WorkspaceSnapshot = {
  id: "w", name: "W", ownerUid: "owner", sessions: [], agents: [],
  members: [{ uid: "owner", role: "owner", label: "Stan" }, { uid: "m1", role: "member", label: "Mei" }],
  connectors: [
    { workspaceId: "w", hostUid: "owner", serverId: "shopify", label: "Shopify", tools: ["list_orders", "cancel_order"] },
    { workspaceId: "w", hostUid: "m1", serverId: "shopify", label: "Shopify", tools: [] },
    { workspaceId: "w", hostUid: "m1", serverId: "ads", label: "Ads", tools: [] },
  ],
};

describe("connectorChoices", () => {
  it("按 serverId 合并两个 host 的同名服务；工具名取并集；有人整台放行就不列名字（null）", () => {
    expect(connectorChoices(ws)).toEqual([
      { serverId: "shopify", hostLabels: ["Stan", "Mei"], toolNames: null },
      { serverId: "ads", hostLabels: ["Mei"], toolNames: null },
    ]);
  });
  it("所有贡献者都点了名才列得出工具名", () => {
    const only = { ...ws, connectors: [ws.connectors[0]!] };
    expect(connectorChoices(only)[0]!.toolNames).toEqual(["list_orders", "cancel_order"]);
  });
});

describe("模式与草稿", () => {
  it("modeFromTools：[] = all，否则 some", () => {
    expect(modeFromTools([])).toBe("all");
    expect(modeFromTools([{ serverId: "ads", tools: [] }])).toBe("some");
  });
  it("some 且一台都没勾 → 不可保存（[] 表达不了「一台都不给」）", () => {
    expect(toolsDraftError("some", {})).toMatch(/至少勾一台/);
    expect(toolsDraftError("some", { ads: "all" })).toBeNull();
    expect(toolsDraftError("all", {})).toBeNull();
  });
  it("toolsFromDraft：all → []；some → buildAllow", () => {
    expect(toolsFromDraft("all", { ads: "all" })).toEqual([]);
    expect(toolsFromDraft("some", { ads: "all", shopify: ["list_orders"] }))
      .toEqual([{ serverId: "ads", tools: [] }, { serverId: "shopify", tools: ["list_orders"] }]);
  });
});
```

`tests/renderer/workspaceView.agents.test.ts`：fixture 的 a_1 行 `tools: [{ serverId: "shopify", tools: [] }, { serverId: "ads", tools: ["report"] }]`，admin 行 `tools: []`；在「型号摘要」用例后加：
```ts
  it("连接器摘要：[] = 全部连接器；否则列服务与工具数", () => {
    const rows = agentRows(ws, "owner");
    expect(rows.map((r) => r.toolsSummary)).toEqual(["全部连接器", "shopify（全部工具）、ads（1 个工具）"]);
  });
```

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run tests/renderer/agentToolsForm.test.ts tests/renderer/workspaceView.agents.test.ts`
Expected: FAIL

- [ ] **Step 3: 写 `src/renderer/src/lib/agentToolsForm.ts`**

```ts
// agentToolsForm —— 工作区 agent 编辑弹窗里「连接器」那张勾选表的纯逻辑（切片 2）。
// 换算复用 proxyShare.ts（ProxySelection / buildAllow …），这里只回答三件
// proxyShare 不知道的事：候选行从哪来（工作区快照的 connectors）、「全部 / 只用
// 勾选的」两档怎么映射到 [] 这个编码、哪种草稿不许存。
//
// 候选行按 serverId 合并：runtime 过滤只看 serverId（agentToolAllow.ts），界面上
// 按 host 拆两行会让人以为能分开授权、实际做不到。工具名只在**每个**贡献者都点了
// 名时才列得出来——有人 tools:[] 整台放行时，那台此刻有哪些工具本机快照里没有
// （在 edge 的托管箱里），只能整台勾。

import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";
import type { AgentToolAllow } from "../../../shared/agentToolAllow.js";
import { buildAllow, type ProxySelection } from "./proxyShare.js";
import { labelOf } from "./workspaceView.js";

export type ToolsMode = "all" | "some";

export interface ConnectorChoice {
  serverId: string;
  hostLabels: string[];
  /** null = 至少一个贡献者整台放行，工具名列不出来，只能整台勾 */
  toolNames: string[] | null;
}

export function connectorChoices(ws: WorkspaceSnapshot): ConnectorChoice[] {
  const byServer = new Map<string, ConnectorChoice>();
  for (const c of ws.connectors) {
    const cur = byServer.get(c.serverId) ?? { serverId: c.serverId, hostLabels: [], toolNames: [] };
    cur.hostLabels.push(labelOf(ws, c.hostUid));
    if (c.tools.length === 0) cur.toolNames = null;
    else if (cur.toolNames !== null) {
      for (const t of c.tools) if (!cur.toolNames.includes(t)) cur.toolNames.push(t);
    }
    byServer.set(c.serverId, cur);
  }
  return [...byServer.values()];
}

export function modeFromTools(tools: readonly AgentToolAllow[]): ToolsMode {
  return tools.length === 0 ? "all" : "some";
}

/** [] 在线上是「整池放行」，所以「只用勾选的」却一台都没勾不能存——存出去就是
    把用户的「都不要」翻译成「都要」（proxyShare.ts 文件头的同一条约定，高一层） */
export function toolsDraftError(mode: ToolsMode, sel: ProxySelection): string | null {
  if (mode === "some" && buildAllow(sel).length === 0) return "至少勾一台连接器，或改回「全部连接器」";
  return null;
}

export function toolsFromDraft(mode: ToolsMode, sel: ProxySelection): AgentToolAllow[] {
  return mode === "all" ? [] : buildAllow(sel).map((a) => ({ serverId: a.serverId, tools: [...a.tools] }));
}
```

（`labelOf` 若在 `workspaceView.ts` 里没有 export，把它 export 出来——`CloudSessionPage.tsx` 已经 import 它，说明已 export。）

- [ ] **Step 4: `workspaceView.ts`**

`AgentRowView` 加 `toolsSummary: string;`。加：
```ts
/** []（整池放行）→ 一句人话；否则复用 proxyShare 的描述（服务名 + 全部/几个工具） */
function toolsSummaryOf(tools: readonly AgentToolAllow[]): string {
  return tools.length === 0 ? "全部连接器" : describeAllow(tools);
}
```
`agentRows` 的返回对象加 `toolsSummary: toolsSummaryOf(a.tools),`。import `describeAllow` from `./proxyShare.js`、`AgentToolAllow` type。

- [ ] **Step 5: `WorkspaceAgentsTab.tsx`**

行摘要那行改成：
```tsx
          {row.description || "没有写职责"} · {row.modelsSummary} · {row.toolsSummary} · {row.creatorLabel}
```

编辑弹窗：
- 新 state：`const [toolsMode, setToolsMode] = useState<ToolsMode>("all");`、`const [toolsSel, setToolsSel] = useState<ProxySelection>({});`、`const [expanded, setExpanded] = useState<Set<string>>(new Set());`
- `useEffect` 回填：edit 时 `setToolsMode(modeFromTools(state.agent.tools)); setToolsSel(selectionFromAllow(state.agent.tools));`；create 时 `setToolsMode("all"); setToolsSel({});`；两种都 `setExpanded(new Set())`。
- `const toolsError = toolsDraftError(toolsMode, toolsSel);`，`canSave = nameError === null && toolsError === null && !busy`。
- `submit`：`const tools = toolsFromDraft(toolsMode, toolsSel);` create 传 `tools`；edit 加 `...(sameAgentTools(tools, state.agent.tools) ? {} : { tools })`。删掉 Task 3 临时的 `tools: []`。
- 「型号」段之后加「连接器」段：

```tsx
          <div className="flex flex-col gap-1">
            <span className={SECTION_LABEL}>连接器</span>
            <div className="flex gap-1">
              <Button
                type="button" size="xs" variant={toolsMode === "all" ? "secondary" : "ghost"}
                disabled={busy} onClick={() => setToolsMode("all")}
              >
                全部连接器
              </Button>
              <Button
                type="button" size="xs" variant={toolsMode === "some" ? "secondary" : "ghost"}
                disabled={busy} onClick={() => setToolsMode("some")}
              >
                只用勾选的
              </Button>
            </div>
            {toolsMode === "some" && (
              choices.length === 0 ? (
                <p className="text-[10.5px] text-muted-foreground">这个工作区还没有人贡献连接器。</p>
              ) : (
                <div className="max-h-[220px] overflow-y-auto rounded-md border border-border py-1">
                  {choices.map((srv) => {
                    const isOpen = expanded.has(srv.serverId);
                    return (
                      <div key={srv.serverId}>
                        <div className={ROW}>
                          <button
                            type="button"
                            className="bg-transparent p-0 text-muted-foreground hover:text-foreground disabled:opacity-40"
                            aria-label={isOpen ? "收起工具" : "展开工具"}
                            disabled={srv.toolNames === null}
                            title={srv.toolNames === null ? "贡献者整台放行，本机没有工具清单——只能整台勾" : undefined}
                            onClick={() => setExpanded((prev) => {
                              const next = new Set(prev);
                              if (next.has(srv.serverId)) next.delete(srv.serverId);
                              else next.add(srv.serverId);
                              return next;
                            })}
                          >
                            {isOpen ? <ChevronDown className="size-[13px]" /> : <ChevronRight className="size-[13px]" />}
                          </button>
                          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 select-none">
                            <input
                              type="checkbox"
                              checked={isServerOn(toolsSel, srv.serverId)}
                              onChange={() => setToolsSel((p) => toggleServer(p, srv.serverId, !isServerOn(p, srv.serverId)))}
                              className="size-[13px] shrink-0 accent-[var(--brand)]"
                              aria-label={srv.serverId}
                            />
                            <span className="truncate">{srv.serverId}</span>
                          </label>
                          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                            {srv.hostLabels.join("、")} · {srv.toolNames === null ? "全部工具" : `${srv.toolNames.length} 个工具`}
                          </span>
                        </div>
                        {isOpen && srv.toolNames !== null && (
                          <div className="pb-1 pl-8">
                            {srv.toolNames.map((tool) => (
                              <div key={tool} className={ROW}>
                                <label className="flex cursor-pointer items-center gap-2 select-none">
                                  <input
                                    type="checkbox"
                                    checked={isToolOn(toolsSel, srv.serverId, tool)}
                                    onChange={() => setToolsSel((p) => toggleTool(p, srv.serverId, tool, srv.toolNames!))}
                                    className="size-[13px] shrink-0 accent-[var(--brand)]"
                                    aria-label={tool}
                                  />
                                  <span className="truncate">{tool}</span>
                                </label>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )
            )}
            {toolsError && <p className="text-xs text-err">{toolsError}</p>}
          </div>
```

`const choices = connectorChoices(ws);` 放在组件体顶部。import：`ChevronDown, ChevronRight` from `lucide-react`；`isServerOn, isToolOn, selectionFromAllow, toggleServer, toggleTool, type ProxySelection` from `../lib/proxyShare.js`；`connectorChoices, modeFromTools, toolsDraftError, toolsFromDraft, type ToolsMode` from `../lib/agentToolsForm.js`；`sameAgentTools` from `../../../shared/agentToolAllow.js`。

`Button` 的 `variant="secondary"` 若本仓 `ui/button.tsx` 没有，用 `variant="outline"`；看一眼该文件的 variants 列表再定。

- [ ] **Step 6: 跑，确认绿**

Run: `npx vitest run tests/renderer && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/renderer tests/renderer
git commit -m "feat(ui): 工作区 agent 编辑弹窗长出连接器勾选表，换算复用 proxyShare（#941 切片 2）

候选行按 serverId 合并（runtime 过滤只看 serverId）；「只用勾选的」却一台没勾不许存——
[] 在线上是整池放行，存出去等于把「都不要」翻译成「都要」。"
```

---

### Task 5: `usage_event.agent_id`：migration + 共用头/形状 + edge 落库

**Files:**
- Create: `supabase/migrations/0022_usage_event_agent_id.sql`
- Modify: `src/shared/billing.ts:69-71`（`AGENT_HEADER`）、文件末尾（`WorkspaceUsage` 类型 + `parseWorkspaceUsage`）
- Modify: `services/edge/src/llmGateway.ts:44-56`（`Caller.agentId`）
- Modify: `services/edge/src/edge.ts:299-327`（`callerOf`）
- Modify: `services/edge/src/billingQueries.ts:126-140`（`usageEventInsert`）
- Test: `tests/shared/billing.test.ts`、`tests/edge/billingRoutes.test.ts:47-51`、`tests/edge/billingQueries.test.ts:153-163`；其余构造 `Caller` 字面量的测试（`tests/edge/llmGateway.test.ts` 等）由 tsc 点名补 `agentId: ""`

**Interfaces:**
- Produces:
  ```ts
  export const AGENT_HEADER = "x-otto-agent";
  export interface WorkspaceUsageRow { agentId: string; costMicro: number; calls: number; promptTokens: number; cachedTokens: number; completionTokens: number }
  export interface WorkspaceUsage { workspaceId: string; ownerUid: string; weekStartAt: number; weekEndAt: number; rows: WorkspaceUsageRow[] }
  export function parseWorkspaceUsage(payload: unknown): WorkspaceUsage | null
  ```
  `Caller.agentId: string`（空串 = 桌面直连 / 旧 runtime）。

- [ ] **Step 1: migration**

```sql
-- 0022：usage_event 记下「这笔是哪只工作区 agent 烧的」（#946，spec §7，ADR-0221）
--
-- 同 0018 的约定：在 Supabase SQL editor 手动执行一次，幂等。
-- runtime 调网关时随 x-otto-on-behalf-of 一起带 x-otto-agent（agent_id，不是名字——
-- 名字随时会改，0021 把 agent_id 与 name 拆开正是为了这本账不断）。
-- 桌面直连的请求、0022 之前的旧行都是空串；聚合时空串单列成「未归因」。
alter table public.usage_event add column if not exists agent_id text not null default '';
comment on column public.usage_event.agent_id is
  '工作区 agent 的 agent_id（workspace_agents.agent_id）；空串 = 桌面直连或 0022 之前的旧行';
-- 设置页周用量表的查询形状：owner + 工作区 + 周窗，按 agent 聚合
create index if not exists usage_event_owner_workspace_created
  on public.usage_event (user_id, workspace_id, created_at desc);
```

- [ ] **Step 2: 写失败测试**

`tests/shared/billing.test.ts` 追加：
```ts
import { AGENT_HEADER, parseWorkspaceUsage } from "../../src/shared/billing.js";

describe("workspace usage（#946）", () => {
  it("头名固定", () => {
    expect(AGENT_HEADER).toBe("x-otto-agent");
  });
  it("parseWorkspaceUsage：形状对就落地，行里数字缺失回 null", () => {
    const ok = {
      workspaceId: "w1", ownerUid: "o", weekStartAt: 1, weekEndAt: 2,
      rows: [{ agentId: "admin", costMicro: 10, calls: 2, promptTokens: 5, cachedTokens: 1, completionTokens: 3 }],
    };
    expect(parseWorkspaceUsage(ok)).toEqual(ok);
    expect(parseWorkspaceUsage({ ...ok, rows: [{ agentId: "x" }] })).toBeNull();
    expect(parseWorkspaceUsage(null)).toBeNull();
  });
});
```

`tests/edge/billingRoutes.test.ts` 第一条用例的期望改成 `[{ uid: "u9", source: "desktop", workspaceId: "w1", sessionId: "s1", agentId: "" }]`，再加一条：
```ts
  it("x-otto-agent 透进 caller.agentId，同样截到 128", async () => {
    const h = harness();
    const res = await h.handle(post("/llm/v1/chat/completions", {
      authorization: `Bearer ${RUNTIME}`, [ON_BEHALF_HEADER]: U7, [WORKSPACE_HEADER]: "w1", [AGENT_HEADER]: "a_".padEnd(200, "x"),
    }));
    expect(res.status).toBe(200);
    expect(h.llmCalls[0]!.agentId).toHaveLength(128);
    expect(h.llmCalls[0]!.source).toBe("runtime");
  });
```
（import 里加 `AGENT_HEADER`。）

`tests/edge/billingQueries.test.ts` 的 `usageEventInsert` 用例：`meta.caller` 加 `agentId: "a_1"`，期望对象加 `agent_id: "a_1"`。

- [ ] **Step 3: 跑，确认红**

Run: `npx vitest run tests/shared/billing.test.ts tests/edge/billingRoutes.test.ts tests/edge/billingQueries.test.ts`
Expected: FAIL

- [ ] **Step 4: `src/shared/billing.ts`**

`SESSION_HEADER` 后加：
```ts
/** runtime 替工作区 agent 调网关时带的 agent_id（#946，spec §7）。桌面直连不带。
    值落 usage_event.agent_id；名字随时会改，所以带的是 id */
export const AGENT_HEADER = "x-otto-agent";
```
文件末尾加：
```ts
/** 设置页「用量」tab 的一行：某只 agent 本周烧了多少（#946）。agentId 空串 = 未归因
    （桌面直连 / 0022 之前的旧行） */
export interface WorkspaceUsageRow {
  agentId: string;
  costMicro: number;
  calls: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
}

/** GET /billing/v1/workspace-usage 的响应。周窗是 **owner** 的（ADR-0217：工作区烧的是
    owner 的额度），起点与 Quota DO 同一份 weekStartFor——同一扇窗两个界面不能给出两个数 */
export interface WorkspaceUsage {
  workspaceId: string;
  ownerUid: string;
  weekStartAt: number;
  weekEndAt: number;
  rows: WorkspaceUsageRow[];
}

export function parseWorkspaceUsage(payload: unknown): WorkspaceUsage | null {
  if (!isObj(payload)) return null;
  const { workspaceId, ownerUid, weekStartAt, weekEndAt } = payload;
  if (typeof workspaceId !== "string" || typeof ownerUid !== "string") return null;
  if (typeof weekStartAt !== "number" || typeof weekEndAt !== "number") return null;
  if (!Array.isArray(payload.rows)) return null;
  const rows: WorkspaceUsageRow[] = [];
  for (const r of payload.rows) {
    if (!isObj(r) || typeof r.agentId !== "string") return null;
    const nums = [r.costMicro, r.calls, r.promptTokens, r.cachedTokens, r.completionTokens];
    if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    rows.push({
      agentId: r.agentId, costMicro: r.costMicro as number, calls: r.calls as number,
      promptTokens: r.promptTokens as number, cachedTokens: r.cachedTokens as number, completionTokens: r.completionTokens as number,
    });
  }
  return { workspaceId, ownerUid, weekStartAt, weekEndAt, rows };
}
```
（`isObj` 该文件里已有；没有就照 `parseBillingMe` 上方那份写法补一个。）

- [ ] **Step 5: edge**

`llmGateway.ts` `Caller` 加：
```ts
  /** 工作区 agent 的 agent_id（#946）。空串 = 桌面直连 / 没带头 */
  agentId: string;
```
`edge.ts` import `AGENT_HEADER`；`callerOf` 返回体加 `agentId: (req.headers.get(AGENT_HEADER) ?? "").slice(0, 128),`。
`billingQueries.ts` `usageEventInsert` 加 `agent_id: meta.caller.agentId,`（放在 `session_id` 之后）。

- [ ] **Step 6: tsc 点名的 `Caller` 字面量补 `agentId: ""`**

Run: `npx tsc --noEmit`，逐个补（`tests/edge/llmGateway.test.ts`、`tests/edge/quota*.test.ts` 若有）。

- [ ] **Step 7: 跑，确认绿**

Run: `npx vitest run tests/shared/billing.test.ts tests/edge && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add supabase/migrations/0022_usage_event_agent_id.sql src/shared/billing.ts services/edge/src tests/
git commit -m "feat(billing): usage_event 多一列 agent_id，x-otto-agent 头透进 caller 落库（#946 切片 3）

带的是 agent_id 不是名字——0021 把两者拆开正是为了这本账在改名后不断。"
```

---

### Task 6: runtime 调网关带 `x-otto-agent`

**Files:**
- Modify: `services/runtime/src/hostedRoute.ts:55-102`（`decideRuntimeRoute` 多一个可选 `agentId`）、`:104-118`（`HostedRuntimeAdapterDeps.agentId`）、`:128-145`（`decide()` 透传）
- Modify: `services/runtime/src/daemon.ts:232-248`（`adapterFor` 传 `agentId: agent.agentId`）
- Test: `tests/runtime/hostedRoute.test.ts`

- [ ] **Step 1: 写失败测试（`describe("decideRuntimeRoute")` 里追加）**

```ts
  it("给了 agentId → hosted 端点多带 x-otto-agent；不给不带（桌面直连的形状）", () => {
    const withAgent = decideRuntimeRoute({ me, requestedModel: null, workspace: null, ...base, agentId: "a_ops" });
    expect(withAgent.kind === "hosted" && withAgent.endpoint.headers).toMatchObject({ [AGENT_HEADER]: "a_ops" });
    const without = decideRuntimeRoute({ me, requestedModel: null, workspace: null, ...base });
    expect(without.kind === "hosted" && AGENT_HEADER in without.endpoint.headers).toBe(false);
  });
```
import 里加 `AGENT_HEADER`。

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run tests/runtime/hostedRoute.test.ts`
Expected: FAIL

- [ ] **Step 3: `hostedRoute.ts`**

`decideRuntimeRoute` 入参加：
```ts
  /** 这一 turn 是哪只工作区 agent（#946）。带上就落 usage_event.agent_id；桌面直连没有这一格 */
  agentId?: string;
```
hosted 分支 headers 加 `...(o.agentId ? { [AGENT_HEADER]: o.agentId } : {}),`。
`HostedRuntimeAdapterDeps` 加 `agentId?: string;`；`decide()` 里 `decideRuntimeRoute({...})` 加 `...(deps.agentId ? { agentId: deps.agentId } : {}),`。import `AGENT_HEADER`。

- [ ] **Step 4: `daemon.ts` `adapterFor`**

`createHostedRuntimeAdapter({ ... })` 加 `agentId: agent.agentId,`，并在函数头注里补一句「`agentId` 只进请求头落账，不影响扣谁（仍是 ownerUid）」。

- [ ] **Step 5: 跑，确认绿**

Run: `npx vitest run tests/runtime/hostedRoute.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add services/runtime/src/hostedRoute.ts services/runtime/src/daemon.ts tests/runtime/hostedRoute.test.ts
git commit -m "feat(runtime): 托管路由的请求头带上 x-otto-agent（#946 切片 3）"
```

---

### Task 7: edge 端点 `GET /billing/v1/workspace-usage`

**Files:**
- Create: `services/edge/src/usageAttribution.ts`
- Modify: `services/edge/src/edge.ts:44-56`（`BillingPort.workspaceUsage`）、`:329-400`（`billingRoute` 加路由）
- Modify: `services/edge/src/worker.ts:620-640`（`billingPort` 实现）
- Test: `tests/edge/usageAttribution.test.ts`（新）、`tests/edge/billingRoutes.test.ts`

**Interfaces:**
- Consumes: `weekStartFor` / `WEEK_MS`（`quota.ts`）、`subscriptionQuery` / `parseSubscriptionRows` / `pageAll`（`billingQueries.ts`）、`WorkspaceUsage`（Task 5）
- Produces:
  ```ts
  export const WORKSPACE_ID_RE: RegExp   // uuid
  export interface AttributionRow { agentId: string; costMicro: number; promptTokens: number; cachedTokens: number; completionTokens: number }
  export function workspaceUsageQuery(ownerUid: string, workspaceId: string, sinceMs: number): string
  export function parseAttributionRows(v: unknown): AttributionRow[]
  export function aggregateByAgent(rows: readonly AttributionRow[]): WorkspaceUsageRow[]
  export function usageWindowFor(now: number, periodStartMs: number | null): { weekStartAt: number; weekEndAt: number }
  export function memberQuery(workspaceId: string, uid: string): string
  export function workspaceOwnerQuery(workspaceId: string): string
  export function parseOwnerRows(v: unknown): string | null
  ```
  `BillingPort.workspaceUsage(uid, workspaceId): Promise<{ ok: true; value: WorkspaceUsage } | { ok: false; code: "not_member" | "not_found"; message: string }>`

- [ ] **Step 1: 写失败测试 `tests/edge/usageAttribution.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  aggregateByAgent, memberQuery, parseAttributionRows, parseOwnerRows, usageWindowFor, workspaceOwnerQuery, workspaceUsageQuery,
} from "../../services/edge/src/usageAttribution.js";
import { WEEK_MS } from "../../services/edge/src/quota.js";

const W = "77777777-7777-4777-8777-777777777777";

describe("查询串", () => {
  it("workspaceUsageQuery 按 owner + 工作区 + created_at 起点，select 五列，稳定排序（分页要全序）", () => {
    expect(workspaceUsageQuery("o1", W, Date.UTC(2026, 8, 1))).toBe(
      `usage_event?user_id=eq.o1&workspace_id=eq.${W}&created_at=gte.2026-09-01T00:00:00.000Z&select=agent_id,cost_micro,prompt_tokens,cached_tokens,completion_tokens&order=created_at.asc,id.asc`
    );
  });
  it("memberQuery / workspaceOwnerQuery", () => {
    expect(memberQuery(W, "u1")).toBe(`workspace_members?workspace_id=eq.${W}&uid=eq.u1&select=uid&limit=1`);
    expect(workspaceOwnerQuery(W)).toBe(`workspaces?id=eq.${W}&select=owner_uid&limit=1`);
    expect(parseOwnerRows([{ owner_uid: "o1" }])).toBe("o1");
    expect(parseOwnerRows([])).toBeNull();
  });
});

describe("行解析与聚合", () => {
  it("parseAttributionRows：数字缺失的行跳过；agent_id 缺失当空串", () => {
    expect(parseAttributionRows([
      { agent_id: "a", cost_micro: 5, prompt_tokens: 1, cached_tokens: 0, completion_tokens: 2 },
      { cost_micro: 7, prompt_tokens: 1, cached_tokens: 0, completion_tokens: 2 },
      { agent_id: "bad", cost_micro: "x" },
    ])).toEqual([
      { agentId: "a", costMicro: 5, promptTokens: 1, cachedTokens: 0, completionTokens: 2 },
      { agentId: "", costMicro: 7, promptTokens: 1, cachedTokens: 0, completionTokens: 2 },
    ]);
  });
  it("aggregateByAgent：按 agentId 求和 + 计数，按花费降序、同额按 id", () => {
    expect(aggregateByAgent([
      { agentId: "b", costMicro: 1, promptTokens: 1, cachedTokens: 0, completionTokens: 1 },
      { agentId: "a", costMicro: 5, promptTokens: 2, cachedTokens: 1, completionTokens: 3 },
      { agentId: "b", costMicro: 4, promptTokens: 1, cachedTokens: 0, completionTokens: 1 },
      { agentId: "", costMicro: 5, promptTokens: 0, cachedTokens: 0, completionTokens: 0 },
    ])).toEqual([
      { agentId: "", costMicro: 5, calls: 1, promptTokens: 0, cachedTokens: 0, completionTokens: 0 },
      { agentId: "a", costMicro: 5, calls: 1, promptTokens: 2, cachedTokens: 1, completionTokens: 3 },
      { agentId: "b", costMicro: 5, calls: 2, promptTokens: 2, cachedTokens: 0, completionTokens: 2 },
    ]);
  });
  it("usageWindowFor：有订阅按 weekStartFor 分段；没订阅退回滚动 7 天", () => {
    const period = Date.UTC(2026, 8, 1);
    const now = period + 10 * 86_400_000;
    expect(usageWindowFor(now, period)).toEqual({ weekStartAt: period + WEEK_MS, weekEndAt: period + 2 * WEEK_MS });
    expect(usageWindowFor(now, null)).toEqual({ weekStartAt: now - WEEK_MS, weekEndAt: now });
  });
});
```

`tests/edge/billingRoutes.test.ts`：`harness()` 里的假 `billing` 加
```ts
    workspaceUsage: async (uid, workspaceId) => {
      billingCalls.push(`workspaceUsage:${uid}:${workspaceId}`);
      if (workspaceId === U3) return { ok: false, code: "not_member", message: "不在籍" };
      if (workspaceId === U2) return { ok: false, code: "not_found", message: "没有这个工作区" };
      return { ok: true, value: { workspaceId, ownerUid: "o", weekStartAt: 1, weekEndAt: 2, rows: [] } };
    },
```
新 describe：
```ts
describe("/billing/v1/workspace-usage（#946）", () => {
  const get = (q: string, headers: Record<string, string>) => new Request(`https://edge/billing/v1/workspace-usage${q}`, { headers });
  it("真人 JWT + 在籍 → 200，body 是 WorkspaceUsage", async () => {
    const h = harness();
    const res = await h.handle(get(`?workspace=${U7}`, { authorization: `Bearer ${token("u1")}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ workspaceId: U7, rows: [] });
    expect(h.billingCalls).toEqual([`workspaceUsage:u1:${U7}`]);
  });
  it("workspace 缺失 / 不是 uuid → 400；不在籍 → 403；没有这个工作区 → 404", async () => {
    const h = harness();
    expect((await h.handle(get("", { authorization: `Bearer ${token("u1")}` }))).status).toBe(400);
    expect((await h.handle(get("?workspace=nope", { authorization: `Bearer ${token("u1")}` }))).status).toBe(400);
    expect((await h.handle(get(`?workspace=${U3}`, { authorization: `Bearer ${token("u1")}` }))).status).toBe(403);
    expect((await h.handle(get(`?workspace=${U2}`, { authorization: `Bearer ${token("u1")}` }))).status).toBe(404);
  });
  it("平台身份不能查（它代表谁都没意义）→ 403", async () => {
    const h = harness();
    const res = await h.handle(get(`?workspace=${U7}`, { authorization: `Bearer ${RUNTIME}`, [ON_BEHALF_HEADER]: U7 }));
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run tests/edge/usageAttribution.test.ts tests/edge/billingRoutes.test.ts`
Expected: FAIL

- [ ] **Step 3: 写 `services/edge/src/usageAttribution.ts`**

```ts
// usageAttribution —— 设置页「用量」tab 的服务端纯逻辑（#946，spec §7，切片 3）。
// 数据从 usage_event 现聚合，**不碰 Quota DO**：DO 是限流用的投影，这里要的是归因。
// 周窗起点复用 quota.ts 的 weekStartFor——同一扇窗两个界面不能给出两个数（ADR-0209
// 踩过一次）。窗是 **owner** 的：工作区烧的是 owner 的额度（ADR-0217），成员看到的
// 「本周」就是 owner 额度页上的那个本周。
//
// worker.ts 不进 vitest，所以能单测的判断全在这里：查询串、行解析、聚合、窗口。

import { WEEK_MS, weekStartFor } from "./quota.js";
import type { WorkspaceUsageRow } from "../../../src/shared/billing.js";

export const WORKSPACE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AttributionRow {
  agentId: string;
  costMicro: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const enc = encodeURIComponent;

/** 按 created_at,id 升序——分页（pageAll）要一个稳定的全序，同 usageEventsQuery */
export function workspaceUsageQuery(ownerUid: string, workspaceId: string, sinceMs: number): string {
  return `usage_event?user_id=eq.${enc(ownerUid)}&workspace_id=eq.${enc(workspaceId)}&created_at=gte.${enc(new Date(sinceMs).toISOString())}&select=agent_id,cost_micro,prompt_tokens,cached_tokens,completion_tokens&order=created_at.asc,id.asc`;
}

export function memberQuery(workspaceId: string, uid: string): string {
  return `workspace_members?workspace_id=eq.${enc(workspaceId)}&uid=eq.${enc(uid)}&select=uid&limit=1`;
}

export function workspaceOwnerQuery(workspaceId: string): string {
  return `workspaces?id=eq.${enc(workspaceId)}&select=owner_uid&limit=1`;
}

export function parseOwnerRows(v: unknown): string | null {
  if (!Array.isArray(v) || !isObj(v[0])) return null;
  return typeof v[0].owner_uid === "string" ? v[0].owner_uid : null;
}

/** 数字缺失的行跳过（一行坏数据不该让整张表 502）；agent_id 缺失当空串 = 未归因 */
export function parseAttributionRows(v: unknown): AttributionRow[] {
  const out: AttributionRow[] = [];
  if (!Array.isArray(v)) return out;
  for (const r of v) {
    if (!isObj(r)) continue;
    const c = num(r.cost_micro), p = num(r.prompt_tokens), k = num(r.cached_tokens), o = num(r.completion_tokens);
    if (c === null || p === null || k === null || o === null) continue;
    out.push({ agentId: typeof r.agent_id === "string" ? r.agent_id : "", costMicro: c, promptTokens: p, cachedTokens: k, completionTokens: o });
  }
  return out;
}

/** 按 agentId 求和 + 计数；花费降序，同额按 agentId 升序（空串排最前，稳定可测） */
export function aggregateByAgent(rows: readonly AttributionRow[]): WorkspaceUsageRow[] {
  const acc = new Map<string, WorkspaceUsageRow>();
  for (const r of rows) {
    const cur = acc.get(r.agentId) ?? { agentId: r.agentId, costMicro: 0, calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0 };
    cur.costMicro += r.costMicro;
    cur.calls += 1;
    cur.promptTokens += r.promptTokens;
    cur.cachedTokens += r.cachedTokens;
    cur.completionTokens += r.completionTokens;
    acc.set(r.agentId, cur);
  }
  return [...acc.values()].sort((a, b) => b.costMicro - a.costMicro || (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
}

/** 有订阅：weekStartFor 分段（与 Quota DO 同一扇窗）；没订阅：滚动 7 天——那种工作区
    走自带 key，usage_event 里本来就没有它的行，窗口只是给界面一个日期范围 */
export function usageWindowFor(now: number, periodStartMs: number | null): { weekStartAt: number; weekEndAt: number } {
  if (periodStartMs === null || !Number.isFinite(periodStartMs)) return { weekStartAt: now - WEEK_MS, weekEndAt: now };
  const weekStartAt = weekStartFor(now, periodStartMs);
  return { weekStartAt, weekEndAt: weekStartAt + WEEK_MS };
}
```

- [ ] **Step 4: `edge.ts`**

`BillingPort` 加：
```ts
  /** 设置页「用量」tab（#946）：调用者必须在籍；周窗与聚合在 usageAttribution.ts */
  workspaceUsage(uid: string, workspaceId: string): Promise<
    { ok: true; value: WorkspaceUsage } | { ok: false; code: "not_member" | "not_found"; message: string }
  >;
```
import type `WorkspaceUsage`（`../../../src/shared/billing.js`）与 `WORKSPACE_ID_RE`（`./usageAttribution.js`）。

`billingRoute` 里、`/billing/v1/me` 分支之后、「平台身份不能发起购买」那行之前，加：
```ts
    if (pathname === "/billing/v1/workspace-usage" && req.method === "GET") {
      // 平台身份代表谁都没意义（它不会来看设置页），和下面 checkout/portal 同一条理由
      if (caller.source === "runtime") return apiError(403, "平台身份不能查工作区用量", "forbidden");
      const workspaceId = new URL(req.url).searchParams.get("workspace") ?? "";
      if (!WORKSPACE_ID_RE.test(workspaceId)) return apiError(400, "workspace 必须是 uuid", "bad_request");
      try {
        const r = await deps.billing.workspaceUsage(caller.uid, workspaceId);
        if (r.ok) return json(200, r.value);
        return apiError(r.code === "not_member" ? 403 : 404, r.message, r.code);
      } catch (err) {
        return apiError(502, `取用量失败：${err instanceof Error ? err.message : String(err)}`, "upstream");
      }
    }
```

- [ ] **Step 5: `worker.ts` `billingPort` 加实现**

在 `async me(uid) {...}` 之后：
```ts
    async workspaceUsage(uid, workspaceId) {
      const owner = parseOwnerRows(await db.get(workspaceOwnerQuery(workspaceId)));
      if (!owner) return { ok: false, code: "not_found", message: "没有这个工作区" };
      const member = await db.get(memberQuery(workspaceId, uid));
      if (!Array.isArray(member) || member.length === 0) return { ok: false, code: "not_member", message: "你不在这个工作区里" };
      const sub = parseSubscriptionRows(await db.get(subscriptionQuery(owner)));
      const window = usageWindowFor(Date.now(), sub ? Date.parse(sub.current_period_start) : null);
      const rows = parseAttributionRows(await pageAll(db.get, workspaceUsageQuery(owner, workspaceId, window.weekStartAt)));
      return { ok: true, value: { workspaceId, ownerUid: owner, ...window, rows: aggregateByAgent(rows) } };
    },
```
import：`aggregateByAgent, memberQuery, parseAttributionRows, parseOwnerRows, usageWindowFor, workspaceOwnerQuery, workspaceUsageQuery` from `./usageAttribution.js`；`pageAll, subscriptionQuery, parseSubscriptionRows` 若 worker 里还没 import 就补。

- [ ] **Step 6: 跑，确认绿**

Run: `npx vitest run tests/edge && npx tsc --noEmit && (cd services/edge && npx tsc --noEmit -p tsconfig.json)`
Expected: PASS（edge 有独立 tsconfig，见 AGENTS.md `services/edge/` 那条）

- [ ] **Step 7: 提交**

```bash
git add services/edge/src tests/edge
git commit -m "feat(edge): GET /billing/v1/workspace-usage 按 owner 周窗聚合每只 agent 的花费（#946 切片 3）

从 usage_event 现聚合不碰 Quota DO；周窗起点复用 weekStartFor——同一扇窗不能给出两个数。
只收真人 JWT 且必须在籍；worker 实现保持薄，判断全在 usageAttribution.ts 单测里。"
```

---

### Task 8: 桌面拉用量（hostedQuota + 桥 + store）

**Files:**
- Modify: `src/main/hostedQuota.ts:48-61`（接口）、`:170-185`（实现）
- Modify: `src/shared/shellBridge.ts`（`workspaceUsage` 方法 + `CHANNELS.workspaceUsage`，挨着 `workspaceAgentDelete`）
- Modify: `src/preload/index.ts:236-237` 后加一行
- Modify: `src/main/index.ts:3231` 后加 handler
- Modify: `src/renderer/src/store.ts`（接口 + 实现，挨着 `deleteWorkspaceAgent`）
- Test: `tests/main/hostedQuota.test.ts`

**Interfaces:**
- Produces: `HostedQuota.workspaceUsage(workspaceId): Promise<WorkspaceUsage>`（失败抛）；`ShellBridge.workspaceUsage(id): Promise<FriendsResult<WorkspaceUsage>>`；store `loadWorkspaceUsage(id): Promise<FriendsResult<WorkspaceUsage>>`

- [ ] **Step 1: 写失败测试（`tests/main/hostedQuota.test.ts` 追加）**

```ts
  it("workspaceUsage：GET /billing/v1/workspace-usage?workspace=<id> 带 JWT；形状不对抛", async () => {
    const usage = { workspaceId: "w1", ownerUid: "o", weekStartAt: 1, weekEndAt: 2, rows: [] };
    const { q, fetchImpl } = make([() => Response.json(usage), () => Response.json({ nope: true })]);
    expect(await q.workspaceUsage("w1")).toEqual(usage);
    const req = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(req[0]).toBe("https://edge/billing/v1/workspace-usage?workspace=w1");
    expect((req[1] as RequestInit).headers).toMatchObject({ authorization: "Bearer jwt" });
    await expect(q.workspaceUsage("w1")).rejects.toThrow(/形状/);
  });
  it("workspaceUsage：edge 的错误信封翻成人话抛出", async () => {
    const { q } = make([() => Response.json({ error: { message: "你不在这个工作区里", type: "otto_edge", code: "not_member" } }, { status: 403 })]);
    await expect(q.workspaceUsage("w1")).rejects.toThrow("你不在这个工作区里");
  });
```

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run tests/main/hostedQuota.test.ts`
Expected: FAIL

- [ ] **Step 3: `hostedQuota.ts`**

接口加 `workspaceUsage(workspaceId: string): Promise<WorkspaceUsage>; // GET /billing/v1/workspace-usage；失败抛`。实现（`portal()` 之后）：
```ts
    async workspaceUsage(workspaceId) {
      const token = await deps.accessToken();
      if (!token) throw new Error("还没登录");
      const res = await doFetch(`${deps.baseUrl()}/billing/v1/workspace-usage?workspace=${encodeURIComponent(workspaceId)}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const payload: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const e = parseBillingError(res.status, payload);
        throw new Error(e?.message ?? `HTTP ${res.status}`);
      }
      const usage = parseWorkspaceUsage(payload);
      if (!usage) throw new Error("workspace-usage 形状不对");
      return usage;
    },
```
import `parseWorkspaceUsage, type WorkspaceUsage`。

- [ ] **Step 4: 桥 / preload / index / store**

`shellBridge.ts`：`workspaceAgentDelete` 之后加
```ts
  /** 设置页「用量」tab（#946）：每只 agent 本周烧了多少。经 hostedQuota 打 edge，失败翻成 FriendsResult */
  workspaceUsage(id: string): Promise<FriendsResult<WorkspaceUsage>>;
```
`CHANNELS` 加 `workspaceUsage: "otter:workspaceUsage",`；import type `WorkspaceUsage`。

`preload/index.ts`：`workspaceUsage: (id) => ipcRenderer.invoke(CHANNELS.workspaceUsage, id),`。

`index.ts`（`workspaceAgentDelete` handler 之后）：
```ts
  ipcMain.handle(CHANNELS.workspaceUsage, async (_e, id: string): Promise<FriendsResult<WorkspaceUsage>> => {
    try {
      return { ok: true, value: await hostedQuota.workspaceUsage(id) };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });
```
（`hostedQuota` 在 index.ts 第 1489 行造出来，handler 注册处若在它之前，挪到之后——照 `billingSnapshot` handler 的位置放。）

`store.ts` 接口：`loadWorkspaceUsage(id: string): Promise<FriendsResult<WorkspaceUsage>>;`；实现：
```ts
  async loadWorkspaceUsage(id) {
    return window.otter.workspaceUsage(id);
  },
```
（不进 store 状态：这张表只在打开 tab 时看一眼，组件本地 state 就够；同 `CloudRepoConfigDialog` 现取的纪律。）

- [ ] **Step 5: 跑，确认绿**

Run: `npx vitest run tests/main/hostedQuota.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/main/hostedQuota.ts src/shared/shellBridge.ts src/preload/index.ts src/main/index.ts src/renderer/src/store.ts tests/main/hostedQuota.test.ts
git commit -m "feat(desktop): 经 hostedQuota 拉工作区周用量，IPC workspaceUsage（#946 切片 3）"
```

---

### Task 9: 设置页「用量」tab

**Files:**
- Create: `src/renderer/src/lib/workspaceUsageView.ts`
- Create: `src/renderer/src/components/WorkspaceUsageTab.tsx`
- Modify: `src/renderer/src/components/WorkspacePage.tsx:108-129`（第五个 tab）
- Test: `tests/renderer/workspaceUsageView.test.ts`

**Interfaces:**
- Consumes: `WorkspaceUsage`（Task 5）、`agentNameOf`（workspaceView）、`fmtCredit`（billing）、store `loadWorkspaceUsage`（Task 8）
- Produces:
  ```ts
  export interface UsageRowView { agentId: string; name: string; credit: string; calls: number; tokens: string }
  export function usageRows(ws: WorkspaceSnapshot, usage: WorkspaceUsage): UsageRowView[]
  export function usageWindowText(usage: WorkspaceUsage): string
  export function usageTotalText(usage: WorkspaceUsage): string
  ```

- [ ] **Step 1: 写失败测试 `tests/renderer/workspaceUsageView.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { usageRows, usageTotalText, usageWindowText } from "../../src/renderer/src/lib/workspaceUsageView.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";
import type { WorkspaceUsage } from "../../src/shared/billing.js";

const ws: WorkspaceSnapshot = {
  id: "w", name: "W", ownerUid: "owner", connectors: [], sessions: [], members: [],
  agents: [{ agentId: "admin", name: "管理员", description: "", instructions: "", models: [], tools: [], createdBy: "owner", updatedTs: 0 }],
};
const usage: WorkspaceUsage = {
  workspaceId: "w", ownerUid: "owner",
  weekStartAt: Date.UTC(2026, 8, 1, 0, 0), weekEndAt: Date.UTC(2026, 8, 8, 0, 0),
  rows: [
    { agentId: "admin", costMicro: 123_456, calls: 3, promptTokens: 1200, cachedTokens: 200, completionTokens: 300 },
    { agentId: "a_gone", costMicro: 20_000, calls: 1, promptTokens: 10, cachedTokens: 0, completionTokens: 5 },
    { agentId: "", costMicro: 10_000, calls: 1, promptTokens: 1, cachedTokens: 0, completionTokens: 1 },
  ],
};

describe("usageRows", () => {
  it("名字现查名单：查得到用名字，被删的回 id，空串 = 未归因", () => {
    expect(usageRows(ws, usage).map((r) => [r.agentId, r.name, r.credit, r.calls, r.tokens])).toEqual([
      ["admin", "管理员", "12.3 credit", 3, "1.5k"],
      ["a_gone", "a_gone", "2 credit", 1, "15"],
      ["", "未归因", "1 credit", 1, "2"],
    ]);
  });
  it("窗口文案与合计", () => {
    expect(usageWindowText(usage)).toMatch(/9月1日.*9月8日/);
    expect(usageTotalText(usage)).toBe("15.3 credit");
  });
});
```

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run tests/renderer/workspaceUsageView.test.ts`
Expected: FAIL

- [ ] **Step 3: 写 `src/renderer/src/lib/workspaceUsageView.ts`**

```ts
// workspaceUsageView —— 设置页「用量」tab 的纯逻辑（#946，spec §7）。
// 展示落工作区设置页不挤上下文浮层卡（那张 300px 的卡已经满了，ADR-0209）。
// 名字**现查名单**：usage_event 记的是 agent_id（改名不断账），被删的 agent 只剩 id——
// 同 agentNameOf「查不到回 id」的纪律；空串是桌面直连 / 0022 之前的旧行，叫「未归因」。

import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";
import { fmtCredit, type WorkspaceUsage } from "../../../shared/billing.js";
import { agentNameOf } from "./workspaceView.js";

export interface UsageRowView {
  agentId: string;
  name: string;
  credit: string;
  calls: number;
  tokens: string;
}

/** 1500 → "1.5k"，15 → "15"，2_000_000 → "2.0m"：这一列只要量级 */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function dateText(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function usageRows(ws: WorkspaceSnapshot, usage: WorkspaceUsage): UsageRowView[] {
  return usage.rows.map((r) => ({
    agentId: r.agentId,
    name: r.agentId === "" ? "未归因" : agentNameOf(ws, r.agentId),
    credit: fmtCredit(r.costMicro),
    calls: r.calls,
    tokens: fmtTokens(r.promptTokens + r.cachedTokens + r.completionTokens),
  }));
}

export function usageWindowText(usage: WorkspaceUsage): string {
  return `${dateText(usage.weekStartAt)} – ${dateText(usage.weekEndAt)}`;
}

export function usageTotalText(usage: WorkspaceUsage): string {
  return fmtCredit(usage.rows.reduce((sum, r) => sum + r.costMicro, 0));
}
```

（`usageWindowText` 用本地时区——用例只匹配月日，UTC 零点在东八区仍是同一天；若 CI 时区让 9 月 8 日零点变成 9 月 7 日，测试改用 `Date.UTC(2026, 8, 8, 12)`。）

- [ ] **Step 4: `WorkspaceUsageTab.tsx`**

```tsx
// WorkspaceUsageTab —— 工作区设置页「用量」tab：每只 agent 本周烧了多少（#946，
// spec §7）。数据每次打开 tab 现拉一次（loadWorkspaceUsage），不进 store——这张表
// 只在看的时候有意义，缓存一份等于多一处会陈旧的额度数。
// 「拿不到」≠「没花」：请求失败画错误行，不画一张全零的表。

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useChat } from "../store.js";
import { usageRows, usageTotalText, usageWindowText } from "../lib/workspaceUsageView.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";
import type { WorkspaceUsage } from "../../../shared/billing.js";

const SECTION_LABEL = "text-[11px] tracking-[0.06em] text-muted-foreground uppercase";
const ROW = "flex items-center gap-2 px-2 py-[6px] rounded-md text-xs";

export function WorkspaceUsageTab({ ws }: { ws: WorkspaceSnapshot }) {
  const load = useChat((s) => s.loadWorkspaceUsage);
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; message: string } | { kind: "ok"; usage: WorkspaceUsage }>({ kind: "loading" });

  const refresh = async (): Promise<void> => {
    setState({ kind: "loading" });
    const r = await load(ws.id);
    setState(r.ok ? { kind: "ok", usage: r.value } : { kind: "error", message: r.message });
  };

  useEffect(() => { void refresh(); }, [ws.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state.kind === "loading") return <p className="px-2 text-xs text-muted-foreground">正在算本周的账…</p>;
  if (state.kind === "error") {
    return (
      <div className="flex flex-col gap-2">
        <p className="px-2 text-xs text-err">拿不到用量：{state.message}</p>
        <div><Button size="sm" variant="ghost" onClick={() => void refresh()}>再试一次</Button></div>
      </div>
    );
  }
  const rows = usageRows(ws, state.usage);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between px-2">
        <span className={SECTION_LABEL}>本周 · {usageWindowText(state.usage)} · 记在所有者的额度上</span>
        <Button size="sm" variant="ghost" onClick={() => void refresh()}>刷新</Button>
      </div>
      {rows.length === 0 ? (
        <p className="px-2 text-xs text-muted-foreground">这一周还没有托管路由的花费。</p>
      ) : (
        <div className="flex flex-col gap-1">
          {rows.map((r) => (
            <div key={r.agentId} className={cn(ROW, "border border-border")}>
              <span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
              <span className="shrink-0 text-muted-foreground">{r.calls} 次 · {r.tokens} token</span>
              <span className="w-[90px] shrink-0 text-right tabular-nums">{r.credit}</span>
            </div>
          ))}
          <div className={cn(ROW, "justify-end text-muted-foreground")}>合计 {usageTotalText(state.usage)}</div>
        </div>
      )}
    </div>
  );
}
```

`WorkspacePage.tsx`：`TabsTrigger value="members"` 之后加 `<TabsTrigger value="usage">用量</TabsTrigger>`；`TabsContent value="members"` 之后加
```tsx
        <TabsContent value="usage" className="pt-3">
          <WorkspaceUsageTab ws={ws} />
        </TabsContent>
```
import `WorkspaceUsageTab`；文件头注「四 tab」改成「五 tab（会话 / 智能体 / 连接器 / 成员 / 用量）」。

- [ ] **Step 5: 跑，确认绿**

Run: `npx vitest run tests/renderer && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/renderer tests/renderer
git commit -m "feat(ui): 工作区设置页第五个 tab「用量」——每只 agent 本周烧了多少（#946 切片 3）"
```

---

### Task 10: #945 协议：welcome/config_result 带 `modelRoute`（版本 5）+ runtime 与桌面主进程接线

**Files:**
- Modify: `src/shared/remote/cloudSession.ts:10-23`（版本注 + 5）、`:85-90` 后（`CsModelRoute`）、`:185-220`（两条下行帧）、`:270-278` 后（`normalizeModelRoute`）、`:415-445`（解码）
- Modify: `services/runtime/src/hostedRoute.ts`（`probeModelRoute`）
- Modify: `services/runtime/src/frameHandler.ts:135-138`（deps）、`:334-342`、`:405-411`、`:460-466`（三处 send）
- Modify: `services/runtime/src/daemon.ts:664-676`（deps 接线）
- Modify: `src/main/cloudSessionClient.ts:243-247`（`ActiveSession.modelRoute`）、`:266-276`（pushStatus）、`:388-410`（welcome / config_result）、`:605-608`（占位）
- Modify: `src/shared/shellBridge.ts:466-468`（`CloudSessionStatus.modelRoute`）、`src/renderer/src/store.ts:184-186`、`:2227-2235`、`:2559-2575`
- Test: `tests/shared/remote/cloudSession.test.ts`、`tests/runtime/frameHandler.test.ts`、`tests/runtime/hostedRoute.test.ts`、`tests/main/cloudSessionClient.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CsModelRoute =
    | { kind: "hosted"; model: string }   // 订阅路，实际会用的型号
    | { kind: "workspace" }               // 工作区自带 key
    | { kind: "blocked" };                // 两条路都没有
  // welcome / config_result: modelRoute: CsModelRoute | null（null = 探不到，别下结论）
  export async function probeModelRoute(o: { probe: HostedProbe; cfg: () => {...} | null; ownerUid: string; workspaceId: string; edgeBase: string; runtimeSecret: string }): Promise<CsModelRoute>
  // FrameHandlerDeps.modelRoute: (workspaceId: string) => Promise<CsModelRoute | null>
  // CloudSessionStatus.modelRoute / CloudSessionState.modelRoute: CsModelRoute | null
  ```

- [ ] **Step 1: 写失败测试**

`tests/shared/remote/cloudSession.test.ts`（照第 211 行那条用例的写法）追加：
```ts
  it("v5：welcome/config_result 的 modelRoute 一格能解回来，缺席或形状不对降级成 null", () => {
    expect(CS_PROTOCOL_VERSION).toBe(5);
    const base = { t: "welcome" as const, v: CS_PROTOCOL_VERSION, sessionId: "s", lastSeq: 0, initiatorUid: null, ownerUid: "o", repo: null, model: null };
    const hosted = decodeCsDown(encodeCs({ ...base, modelRoute: { kind: "hosted", model: "deepseek-v4-flash" } }));
    expect(hosted && hosted.t === "welcome" && hosted.modelRoute).toEqual({ kind: "hosted", model: "deepseek-v4-flash" });
    const blocked = decodeCsDown(encodeCs({ ...base, modelRoute: { kind: "blocked" } }));
    expect(blocked && blocked.t === "welcome" && blocked.modelRoute).toEqual({ kind: "blocked" });
    const raw = JSON.parse(Buffer.from(encodeCs(base), "base64url").toString()) as Record<string, unknown>;
    raw.modelRoute = { kind: "hosted" }; // hosted 没带 model = 形状不对
    const bad = decodeCsDown(Buffer.from(JSON.stringify(raw)).toString("base64url"));
    expect(bad && bad.t === "welcome" && bad.modelRoute).toBeNull();
  });
```
（encode/decode 的 base64url 细节看该文件里既有用例怎么构造「手工篡改的帧」——若已有 helper 就用它。）

`tests/runtime/frameHandler.test.ts`：`makeDeps` 的 config 加 `modelRoute?: FrameHandlerDeps["modelRoute"]`，deps 里 `modelRoute: config.modelRoute ?? (async () => null),`；②「成功路径 welcome 形状」那条期望对象加 `modelRoute: null`（第 137 行附近）、config_result 那条（第 181 行）也加；再加一条：
```ts
  it("③e welcome 带 modelRoute——runtime 用 decideRuntimeRoute 算好下发，客户端不重算（#945）", async () => {
    const { deps, sent } = makeDeps({ modelRoute: async () => ({ kind: "hosted", model: "glm-5" }) });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    expect(sent[0]!.msg).toMatchObject({ t: "welcome", modelRoute: { kind: "hosted", model: "glm-5" } });
  });
```

`tests/runtime/hostedRoute.test.ts` 追加：
```ts
describe("probeModelRoute（#945）", () => {
  const probeOf = (v: BillingMe | null): HostedProbe => ({ me: async () => v });
  it("有订阅 → hosted + 实际会用的型号（工作区配的网关不供就退到第一款）", async () => {
    expect(await probeModelRoute({ probe: probeOf(me), cfg: () => ({ ...ws, modelId: "gpt-9" }), ...base })).toEqual({ kind: "hosted", model: "deepseek-v4-flash" });
  });
  it("没订阅有 key → workspace；都没 → blocked", async () => {
    expect(await probeModelRoute({ probe: probeOf(null), cfg: () => ws, ...base })).toEqual({ kind: "workspace" });
    expect(await probeModelRoute({ probe: probeOf(null), cfg: () => null, ...base })).toEqual({ kind: "blocked" });
  });
});
```
（`base` 里有 `sessionId`，`probeModelRoute` 的入参类型允许多余字段的话直接展开；不允许就 `const { sessionId: _s, ...probeBase } = base`。）

`tests/main/cloudSessionClient.test.ts`：所有 `emitDown({ t: "welcome", ... })` 的字面量加 `modelRoute: null`（tsc 点名）；「welcome 到达后」那条加断言 `expect(last).toMatchObject({ modelRoute: null })`，再加一条 welcome 带 `modelRoute: { kind: "blocked" }` 时 status 也带它。

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run tests/shared/remote/cloudSession.test.ts tests/runtime/frameHandler.test.ts tests/runtime/hostedRoute.test.ts tests/main/cloudSessionClient.test.ts`
Expected: FAIL

- [ ] **Step 3: `cloudSession.ts`**

版本注最上面加一行：
```
    5（issue #945）：welcome/config_result 多了 `modelRoute` 一格——runtime 用
    decideRuntimeRoute 算好「这个工作区此刻的 turn 会走哪条路」下发，客户端不再
    拿 `model === null` 推断「起不了 turn」（订阅用户走托管路照跑，那句是假的）。
```
`CS_PROTOCOL_VERSION = 5`。

`CsModelState` 之后加：
```ts
/** 这个工作区此刻的 turn 会走哪条路（issue #945）。与 runtime 的
    `decideRuntimeRoute` 同源：hosted 带**实际会用的**型号（工作区配的网关不供时
    退到网关第一款，界面上该显示退到的那个）。null = runtime 探不到（edge 抖了）——
    「拿不到」≠「起不了」，客户端别下结论。按 agent 各自的型号白名单会有差异，
    这一格答的是工作区默认那份 */
export type CsModelRoute =
  | { kind: "hosted"; model: string }
  | { kind: "workspace" }
  | { kind: "blocked" };
```
welcome 与 config_result 各加 `modelRoute: CsModelRoute | null;`。

`normalizeModelState` 之后加：
```ts
function normalizeModelRoute(v: unknown): CsModelRoute | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.kind === "hosted") return typeof o.model === "string" && o.model !== "" ? { kind: "hosted", model: o.model } : null;
  if (o.kind === "workspace") return { kind: "workspace" };
  if (o.kind === "blocked") return { kind: "blocked" };
  return null;
}
```
解码两处各加 `modelRoute: normalizeModelRoute(obj.modelRoute),`。

- [ ] **Step 4: `hostedRoute.ts` 加 `probeModelRoute`**

```ts
/** welcome/config_result 那一格 `modelRoute`（issue #945）：与 turn 真正走的那条路
    同一份 decideRuntimeRoute，sessionId 留空——这里只要 kind 与型号，不发请求。 */
export async function probeModelRoute(o: {
  probe: HostedProbe;
  cfg: () => { baseUrl: string; apiKey: string; modelId: string } | null;
  ownerUid: string;
  workspaceId: string;
  edgeBase: string;
  runtimeSecret: string;
}): Promise<CsModelRoute> {
  const ws = o.cfg();
  const route = decideRuntimeRoute({
    me: await o.probe.me(o.ownerUid),
    requestedModel: ws?.modelId ?? null,
    workspace: ws,
    ownerUid: o.ownerUid,
    workspaceId: o.workspaceId,
    sessionId: "",
    edgeBase: o.edgeBase,
    runtimeSecret: o.runtimeSecret,
  });
  if (route.kind === "hosted") return { kind: "hosted", model: route.model };
  return { kind: route.kind };
}
```
import type `CsModelRoute` from `../../../src/shared/remote/cloudSession.js`。

- [ ] **Step 5: `frameHandler.ts`**

deps 加：
```ts
  /** 这个工作区此刻的 turn 会走哪条路（issue #945）。async：要问一次 edge 的订阅
      快照（hostedProbe 有 60s 缓存）。回 null = 探不到，客户端按「不知道」画 */
  modelRoute: (workspaceId: string) => Promise<CsModelRoute | null>;
```
三处 send 的 `model: deps.modelState(workspaceId),` 后各加 `modelRoute: await deps.modelRoute(workspaceId),`（所在函数都已是 async；config_result 那处若在非 async 回调里，先 `const modelRoute = await ...` 再 send）。import type。

- [ ] **Step 6: `daemon.ts` 接线**

`modelState` 之后加：
```ts
    // issue #945：与 turn 同一份 decideRuntimeRoute。探不到（edge 抖、ownerOf 查不到）
    // 回 null 而不是 blocked——「拿不到」≠「起不了」
    modelRoute: async (workspaceId) => {
      try {
        return await probeModelRoute({
          probe: hostedProbe,
          cfg: () => workspaceConfigStore.load(workspaceId)?.model ?? null,
          ownerUid: await ownerOf(workspaceId),
          workspaceId,
          edgeBase: config.edgeBase,
          runtimeSecret: config.runtimeSecret,
        });
      } catch (err) {
        console.warn(`[otto-runtime] modelRoute 探测失败（workspaceId=${workspaceId}）：${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    },
```
import `probeModelRoute`。

- [ ] **Step 7: `cloudSessionClient.ts` / `shellBridge.ts` / `store.ts`**

- `ActiveSession` 加 `modelRoute: CsModelRoute | null;`（注：「welcome 给的路由判定（issue #945），config 回执后刷新」）；占位处 `modelRoute: null,`；welcome 与 config_result 各加 `session.modelRoute = msg.modelRoute;`；`pushStatus` 加 `modelRoute: session.modelRoute,`。
- `CloudSessionStatus` 加 `modelRoute: CsModelRoute | null;`（注同上，import type）。
- `CloudSessionState` 加同名字段；`openCloudSession` 占位加 `modelRoute: null,`；`onCloudSessionStatus` 合并处加 `modelRoute: status.modelRoute,`。

- [ ] **Step 8: 跑，确认绿**

Run: `npx vitest run tests/shared/remote tests/runtime tests/main/cloudSessionClient.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add src/shared/remote/cloudSession.ts services/runtime/src src/main/cloudSessionClient.ts src/shared/shellBridge.ts src/renderer/src/store.ts tests/
git commit -m "feat(cs): welcome/config_result 带 modelRoute，协议 4→5（#945）

runtime 用 turn 同一份 decideRuntimeRoute 算好下发；客户端不再拿 model===null 推断
「起不了 turn」——订阅用户走托管路照跑，那句是假的。探不到回 null 不回 blocked。"
```

---

### Task 11: #945 渲染层：模型那一格按 `modelRoute` 说话

**Files:**
- Create: `src/renderer/src/lib/cloudModelStatus.ts`
- Modify: `src/renderer/src/components/CloudSessionPage.tsx:580-600`（删掉本地 `modelStatusText`）、`:604-618`（`CloudRepoConfigEntry` 多收 `route`）、`:326-331`（传 `route={cs.modelRoute}`）
- Test: `tests/renderer/cloudModelStatus.test.ts`

**Interfaces:**
- Produces: `export function modelStatusText(model: CsModelState | null, route: CsModelRoute | null): { short: string; full: string; bad: boolean }`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { modelStatusText } from "../../src/renderer/src/lib/cloudModelStatus.js";

const cfg = { baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-v4", hasKey: true };

describe("modelStatusText（#945）", () => {
  it("hosted：没配模型也不红，说托管型号；配了但网关退到别款，显示实际会用的那款", () => {
    expect(modelStatusText(null, { kind: "hosted", model: "deepseek-v4-flash" })).toEqual({
      short: "deepseek-v4-flash · 托管", bad: false, full: expect.stringContaining("订阅"),
    });
    expect(modelStatusText(cfg, { kind: "hosted", model: "glm-5" }).short).toBe("glm-5 · 托管");
  });
  it("workspace：走自带 key，沿用旧文案", () => {
    expect(modelStatusText(cfg, { kind: "workspace" })).toEqual({ short: "deepseek-v4", full: `${cfg.baseUrl}\n${cfg.modelId}`, bad: false });
  });
  it("blocked：两条路都没有才红，两条出路都说", () => {
    const r = modelStatusText(null, { kind: "blocked" });
    expect(r.bad).toBe(true);
    expect(r.full).toMatch(/订阅/);
    expect(r.full).toMatch(/key/);
  });
  it("route 探不到（null）：按旧规则退回 model 那一格，但措辞不说死「起不了 turn」", () => {
    expect(modelStatusText(null, null)).toEqual({ short: "未配模型", bad: false, full: expect.stringContaining("订阅") });
    expect(modelStatusText({ ...cfg, hasKey: false }, null).bad).toBe(true);
    expect(modelStatusText(cfg, null).short).toBe("deepseek-v4");
  });
});
```

- [ ] **Step 2: 跑，确认红**

Run: `npx vitest run tests/renderer/cloudModelStatus.test.ts`
Expected: FAIL

- [ ] **Step 3: 写 `src/renderer/src/lib/cloudModelStatus.ts`**

```ts
// cloudModelStatus —— 云会话头部「模型」那一格写什么（issue #844 → #945）。
// 从 CloudSessionPage 抽出来：判据换成 runtime 下发的 modelRoute（与 turn 真正走的那条
// 路同一份 decideRuntimeRoute），渲染层不重算。#844 那版拿 `model === null` 推断
// 「@Agent 起不了 turn」——订阅用户走托管路照跑，那句是假的，而且撒谎的方向是吓人：
// owner 会去配一把自己的 key，从此烧自己的 key 而不是订阅额度。
//
// route 为 null（老 runtime / edge 抖了）时退回 model 那一格，但**不说死**——
// 「拿不到」≠「起不了」。

import type { CsModelRoute, CsModelState } from "../../../shared/remote/cloudSession.js";

export function modelStatusText(
  model: CsModelState | null,
  route: CsModelRoute | null
): { short: string; full: string; bad: boolean } {
  if (route?.kind === "hosted") {
    return {
      short: `${route.model} · 托管`,
      full:
        `走所有者的订阅（托管路由），实际型号 ${route.model}。` +
        (model ? `\n工作区配的 ${model.modelId} 只在订阅失效时用。` : "\n不用配自己的 key。"),
      bad: false,
    };
  }
  if (route?.kind === "blocked") {
    return {
      short: "没有可用的模型",
      full: "所有者没有活跃订阅，工作区也没配自己的 API key——@Agent 起不了 turn。两条路：所有者订阅 Mr Otto，或所有者点右边那颗按钮配一把 key。",
      bad: true,
    };
  }
  // workspace 或探不到：按工作区配置说
  if (!model) {
    return {
      short: "未配模型",
      full: "这个工作区没配自己的模型。有订阅的话 turn 走托管路照跑；没有的话所有者点右边那颗按钮配一把 API key。",
      bad: false,
    };
  }
  if (!model.hasKey) {
    return { short: `${model.modelId} · 缺 key`, full: `${model.baseUrl}\n配了型号但没有 key —— 这条路起不来`, bad: true };
  }
  return { short: model.modelId, full: `${model.baseUrl}\n${model.modelId}`, bad: false };
}
```

- [ ] **Step 4: `CloudSessionPage.tsx`**

删掉本地 `modelStatusText`（第 583–600 行）与它上面那段注释，import `modelStatusText` from `../lib/cloudModelStatus.js`。`CloudRepoConfigEntry` props 加 `route: CsModelRoute | null`，`const modelStatus = modelStatusText(model, route);`；调用处加 `route={cs.modelRoute}`。「模型排在仓库前面」那段注释里「没配模型是**会挡住干活**的那一格」改成「走不通的路（blocked / 缺 key）才是会挡住干活的那一格」。

- [ ] **Step 5: 跑，确认绿**

Run: `npx vitest run tests/renderer && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/renderer tests/renderer
git commit -m "fix(ui): 云会话头部模型那一格按 runtime 下发的 modelRoute 说话，订阅用户不再看到假红字（#945）"
```

---

### Task 12: 文档：ADR-0221 + AGENTS.md 索引 + CONTEXT.md + spec 备注

**Files:**
- Create: `docs/adr/0221-工作区多智能体连接器白名单与用量归因.md`
- Modify: `AGENTS.md`（「Where to find things」：在 ADR-0220 那条之后加一条）、`CONTEXT.md`（产品术语表加两行）、`docs/superpowers/specs/2026-09-04-workspace-multi-agent-design.md` §10（备注 2/3 一起落地、migration 编号）
- Test: `npx vitest run tests/docs`（编号唯一 + 不跳号）

- [ ] **Step 1: 确认编号**

Run: `git fetch origin && git -c core.quotePath=false ls-tree --name-only origin/main docs/adr | sort | tail -1`
Expected: `0220-…`——则本 ADR 取 0221；不然取 max+1 并同步改索引。

- [ ] **Step 2: 写 ADR**

结构照 ADR-0220：背景 → 决策（编号）→ 否决的备选 → 代价 → 推翻前提。决策要写进去的：
1. 白名单编码 `[]`/`tools:[]` 两层「空 = 全给」与 `workspace_connectors` 同口径；匹配只看 `serverId`。否决：按 `hostUid+serverId` 双键（界面上做不到分开授权，而且贡献者换机器 hostUid 会变）。
2. 「一台都不给」不可表达 → 表单层不许存；否决：引入 `null`/哨兵条目（同一个字面量在相邻两张表里意思相反）。
3. 工具名只在所有贡献者都点了名时列得出来（快照里没有整台放行那台的清单）。代价：整台放行的连接器只能整台勾。推翻前提：若用户成规模要在整台放行的连接器上挑工具，桌面得多一条 IPC 去 edge 拉 toolDefs（`pxCloudClient.fetchGrants` 已有一半）。
4. `usage_event.agent_id` 带 id 不带名；空串 = 未归因；migration 编号 0022（spec 预估 0023）。
5. 周用量端点在 edge 不在 Supabase RPC：周窗起点要 owner 的订阅 + `weekStartFor`，那份逻辑只在 edge；否决：桌面直连 usage_event（RLS 只让本人读，成员读不到 owner 的账）。
6. 只收真人 JWT、必须在籍；没订阅退回滚动 7 天。
7. #945：welcome 带 `modelRoute`，版本 5；hosted 带实际型号；探不到回 null 不回 blocked。否决：桌面自己拿 billing.me 判（那是**我的**订阅，工作区走 owner 的）。
8. 部署顺序：migration → edge → runtime（理由见本计划「部署清单」）。

已知未修：整台放行的连接器不能挑工具（决策 3）；用量表按 agent 不按会话；`model_usage` 本地事件仍无 agentId。

- [ ] **Step 3: AGENTS.md 索引加一条（紧接 ADR-0220 那条之后）**

一条 `- ` 开头的条目，点名：`src/shared/agentToolAllow.ts` / `src/renderer/src/lib/agentToolsForm.ts` / `services/edge/src/usageAttribution.ts` / `src/renderer/src/lib/workspaceUsageView.ts` / `src/renderer/src/lib/cloudModelStatus.ts`，各一句「为什么长这样」（从 ADR 决策 1/2/3/5/7 抄要点，不复述全文）。

- [ ] **Step 4: CONTEXT.md 产品术语表加两行**

| 连接器白名单（agent） | `workspace_agents.tools`：这只 agent 拿得到工作区里贡献的哪几台连接器、每台哪几个工具。两层「空 = 全给」，与 `workspace_connectors` 同口径 | ADR-0221；`src/shared/agentToolAllow.ts` |
| 用量归因 | `usage_event.agent_id`：托管路由的每一笔花费记在哪只工作区 agent 名下。设置页「用量」tab 按 owner 的周窗现聚合 | ADR-0221；`services/edge/src/usageAttribution.ts` |

- [ ] **Step 5: spec §10 加一行备注**

在「顺序：1a → 1b → 2 → 3 → 5 → 4 → 6」之后加：「> 2 与 3 同一条 lane 一起落地（ADR-0221，2026-09-05）；`usage_event.agent_id` 的 migration 编号实际是 0022（切片 4 的记忆表顺延为 0023）。」

- [ ] **Step 6: 跑门禁**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add docs/adr/0221-*.md AGENTS.md CONTEXT.md docs/superpowers/specs/2026-09-04-workspace-multi-agent-design.md
git commit -m "docs(adr): 工作区多智能体切片 2+3 与 #945 的决策（ADR-0221）"
```

---

## Self-review

**Spec coverage**
- §3 `tools jsonb`、`[] = 整池放行` → Task 1/2/4 ✓
- §7 `usage_event.agent_id`（migration）、runtime 随 on-behalf-of 带上、展示落设置页、`weekStartFor` 复用、不碰 DO → Task 5/6/7/8/9 ✓
- §9 权限矩阵不变（改 tools 走既有 update RLS）✓
- §10 切片 2「设置页勾选表复用 proxyShare.ts」→ Task 4 ✓；切片 3「设置页周用量表」→ Task 9 ✓
- #945 修法「判据与 decideRuntimeRoute 同源」→ Task 10 用 runtime 下发 ✓
- #941 交接里的四条：`AgentSpec`/`WorkspaceAgentRow` 同时加（Task 1+2）、过滤落 `cachedPxTools`（Task 2）、顺序不改 ✓、先部署再验（部署清单）✓

**Placeholder scan**：无 TBD/TODO；每步有代码。Task 4 的 `Button variant` 与 Task 9 的时区各留了一条「看一眼再定」，都是可在本地一眼确认的事实，不是留白。

**Type consistency**：`AgentToolAllow`（T1）被 T2/T3/T4 引用同名；`WorkspaceUsage`/`WorkspaceUsageRow`（T5）被 T7/T8/T9 引用同名；`CsModelRoute`（T10）被 T11 引用同名；`probeModelRoute` 入参与 `decideRuntimeRoute` 的 `base` 形状对齐（T10 测试里注明了 `sessionId` 多余字段的处理）。
