# 团队语音通话 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 团队云会话里能开一场语音通话：拉哪几只 agent 进来、它们之后的回复经 edge 网关调 MiniMax speech-2.8-turbo 读出来、通话是日志里的团队事实、派活/接力只在通话成员里进行、agent 在用户口头同意后能把人拉进通话。

**Architecture:** 三层各一半：edge 加一扇 `/llm/v1/speech` 门（`model_route.kind='tts'`，hold/settle 按字符数）；runtime 加 `voice_call_changed` 事件 + `call` 帧 + 派活/接力过滤 + `invite_to_call` 工具；桌面加语音钮 / 通话栏 / 串行播放器（主进程拿 JWT 打网关，字节经 IPC 到渲染层播）。通话名单是事件日志的投影（`voiceCallOf`），三端共用。

**Tech Stack:** TypeScript strict、vitest（`tests/` 镜像 `src/`）、Electron IPC、Cloudflare Worker（edge）、React + Zustand + Tailwind/shadcn、MiniMax T2A v2（`https://api.minimaxi.com/v1/t2a_v2`）。

**Spec:** `docs/superpowers/specs/2026-09-09-team-voice-call-design.md`

## Global Constraints

- 硬规则：渲染层只走 `window.otter`（ShellBridge）；`src/shared` 不 import node builtin / electron（手机端也跑）；工具只依赖 `ExecutionWorld`；新事件类型必须向后兼容（`ignorable: true`）。
- 新事件类型检查清单（按 `agent_relay` 的足迹）：`events.ts` union + `KNOWN_EVENT_TYPES_MAP`、`persistencePolicy.ts`、`agentView.ts` `OTHER_AGENT_VERDICTS`、`sessionPackage.ts` `PRIVACY_VERDICTS`、`contextEstimate.ts` `pendingAfter`、`deriveMessages.ts`、`Timeline.tsx` `EventRow`、`tests/session/persistencePolicy.test.ts` DURABLE。
- 价：`speech-2.8-turbo` ¥2/万字符，1 USD = 7.2 CNY → `price_out_micro_per_m = 27777778`（micro-USD / 百万字符）；汉字 2 字符、其余 1 字符（`ttsUnits`）。
- 协议 `CS_PROTOCOL_VERSION` 16 → 17（加 `call` / `call_result`）。
- key 只在 Worker secret `MINIMAX_API_KEY`；仓库里任何文件不许出现 key。
- 文案纪律（ADR-0248）：「网关不供语音」「连不上网关」不许写成「你没订阅」。
- 门禁 `npm test`（tsc + vitest）全绿才提交；测试放 `tests/` 镜像目录。
- 提交信息写 **why**，末尾带 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` 与 `Claude-Session: https://claude.ai/code/session_01CYa2cYYAohnkLdv261D3sy`。

---

## File map

| 文件 | 职责 |
|---|---|
| `src/shared/tts.ts`（新） | `ttsUnits` 计费字符数、`TTS_MAX_UNITS`、`TTS_HEADERS` |
| `services/edge/src/ttsUpstream.ts`（新） | MiniMax 请求/回包的纯映射：`parseTtsRequest` / `ttsUpstreamBody` / `parseTtsReply` / `hexToBytes` |
| `services/edge/src/llmGateway.ts` | `RouteKind` 加 `tts`、`upstreamPathFor`、`UPSTREAM_KEY_ENV.minimax`、`serveTts` 分支 |
| `services/edge/src/edge.ts` | `/llm/v1/speech` 那扇门 |
| `services/edge/src/billingQueries.ts` / `worker.ts` | `parseRouteRows` 认 `tts`、`modelsForMe.ttsModels`、`meFromParts` 第八参 |
| `src/shared/billing.ts` | `BillingMe.ttsModels` + `parseBillingMe` |
| `supabase/migrations/0033_model_route_tts.sql`（新） | check 加 `'tts'` + 插一行 |
| `src/main/hostedQuota.ts` / `modelRoute.ts` | `ttsInput()`、`ttsBlocked` / `routeTts` |
| `src/main/teamVoice.ts`（新） | `createTeamVoice().speak(text, voiceId)` 打网关、记额度头 |
| `src/shared/shellBridge.ts` / `src/preload/index.ts` / `src/main/index.ts` | IPC `teamVoiceSpeak`、`workspaceCloudCall` |
| `src/shared/fnv1a.ts`（新）+ `src/renderer/src/lib/agentAvatarSlot.ts` | FNV 抽到 shared 两处共用 |
| `src/shared/agentVoice.ts`（新） | 音色表 + `agentVoiceIds` 派生 |
| `src/shared/voiceCall.ts`（新） | `VoiceCallChangedEvent` 的投影 `voiceCallOf` / `applyVoiceCallEvent` |
| `src/session/events.ts` 等清单八处 | 新事件类型 |
| `src/session/deriveMessages.ts` | 通话块 `renderVoiceCallPrompt` |
| `src/shared/remote/cloudSession.ts` | 协议 17：`call` / `call_result` |
| `services/runtime/src/rateLimit.ts` / `frameHandler.ts` | `CALL_BUCKET` + `case "call"` |
| `services/runtime/src/inviteToCallTool.ts`（新） | `invite_to_call` |
| `services/runtime/src/sessionService.ts` | `setVoiceCall`、`voiceCall` 状态、派活/接力过滤、@ 外人自动拉进、挂工具 |
| `src/main/cloudSessionClient.ts` | `call(participants)` + `pendingCall` |
| `src/renderer/src/store.ts` | `cloudCall`、`voice` 切片、喂播放器 |
| `src/renderer/src/lib/voiceCall.ts`（新） | `voiceCallAvailable` / `spokenText` / `feedDelta` / `feedEvent` |
| `src/renderer/src/lib/voicePlayer.ts`（新） | 串行播放队列 + 预取 |
| `src/renderer/src/lib/cloudTimeline.ts` | `voiceCallLineText` |
| `src/renderer/src/components/VoiceCallBar.tsx`（新）/ `VoicePickerPopover.tsx`（新） | 通话栏、选人弹层 |
| `src/renderer/src/components/CloudSessionPage.tsx` | 语音钮、通话栏挂载、`VoiceCallRow` |
| `docs/adr/0271-*.md`、`CONTEXT.md`、`AGENTS.md`、`services/edge/README.md` | 文档 |

---

### Task 1: `ttsUnits` —— 计费字符数（shared）

**Files:**
- Create: `src/shared/tts.ts`
- Test: `tests/shared/tts.test.ts`

**Interfaces:**
- Produces: `ttsUnits(text: string): number`、`TTS_MAX_UNITS = 2000`、`TTS_HEADERS = { audioMs: "x-otto-audio-ms", chars: "x-otto-tts-chars" }`

- [ ] **Step 1: 写失败的测试**

```ts
import { describe, expect, it } from "vitest";
import { TTS_MAX_UNITS, ttsUnits } from "../../src/shared/tts.js";

describe("ttsUnits（#1163）：与 MiniMax 官方计费口径逐字对齐——汉字 2、其余 1", () => {
  it("真机对账：那句 41、那句 35（extra_info.usage_characters）", () => {
    expect(ttsUnits("你好，我是管理员。这条消息是语音通话的测试。")).toBe(41);
    expect(ttsUnits("流式测试。第一句。第二句稍微长一点点。")).toBe(35);
  });
  it("英文字母 / 空格 / 换行 / emoji 各算 1，空串 0", () => {
    expect(ttsUnits("")).toBe(0);
    expect(ttsUnits("hi there\n")).toBe(9);
    expect(ttsUnits("👍")).toBe(1);
  });
  it("上限是个正整数，且一段正常气泡远小于它", () => {
    expect(TTS_MAX_UNITS).toBe(2000);
  });
});
```

- [ ] **Step 2: 跑，确认红** `npx vitest run tests/shared/tts.test.ts`

- [ ] **Step 3: 实现**

```ts
// tts —— 语音合成的三端共用纯逻辑（#1163）。
// ttsUnits 与 MiniMax 官方计费口径逐字对齐（按量计费页：1 个汉字算 2 个字符；
// 英文字母、标点、空格、回车各算 1）。网关拿它算预扣（hold），桌面拿它估一段
// 要花多少；两边一份判据，真机对账数据钉在 tests/shared/tts.test.ts。
const HAN = /\p{Script=Han}/u;
export function ttsUnits(text: string): number {
  let n = 0;
  for (const ch of text) n += HAN.test(ch) ? 2 : 1;
  return n;
}
/** 单次合成的字符上限（≈ 1000 汉字）。一段气泡远小于它；超了是客户端没拆段 */
export const TTS_MAX_UNITS = 2000;
export const TTS_HEADERS = { audioMs: "x-otto-audio-ms", chars: "x-otto-tts-chars" } as const;
```

- [ ] **Step 4: 跑，绿** — [ ] **Step 5: Commit** `feat(shared): ttsUnits——MiniMax 计费字符数，三端一份判据（#1163）`

---

### Task 2: `ttsUpstream` —— MiniMax 请求/回包的纯映射（edge）

**Files:**
- Create: `services/edge/src/ttsUpstream.ts`
- Test: `tests/edge/ttsUpstream.test.ts`

**Interfaces:**
- Consumes: `ttsUnits`, `TTS_MAX_UNITS`
- Produces:
  - `parseTtsRequest(body: Record<string, unknown>): { ok: true; req: TtsRequest } | { ok: false; message: string }`，`TtsRequest = { text: string; voiceId: string; speed: number }`
  - `ttsUpstreamBody(wireModel: string, req: TtsRequest): string`
  - `parseTtsReply(text: string): { ok: true; audio: Uint8Array; usageChars: number | null; audioMs: number | null } | { ok: false; message: string }`
  - `hexToBytes(hex: string): Uint8Array | null`

- [ ] **Step 1: 测试**

```ts
import { describe, expect, it } from "vitest";
import { hexToBytes, parseTtsReply, parseTtsRequest, ttsUpstreamBody } from "../../services/edge/src/ttsUpstream.js";

describe("parseTtsRequest", () => {
  it("text / voice_id 必填，speed 缺省 1、越界拒", () => {
    expect(parseTtsRequest({ text: "你好", voice_id: "v" })).toEqual({ ok: true, req: { text: "你好", voiceId: "v", speed: 1 } });
    expect(parseTtsRequest({ voice_id: "v" })).toMatchObject({ ok: false });
    expect(parseTtsRequest({ text: "  ", voice_id: "v" })).toMatchObject({ ok: false });
    expect(parseTtsRequest({ text: "x", voice_id: "" })).toMatchObject({ ok: false });
    expect(parseTtsRequest({ text: "x", voice_id: "v", speed: 3 })).toMatchObject({ ok: false });
    expect(parseTtsRequest({ text: "x", voice_id: "v", speed: 1.5 })).toMatchObject({ ok: true, req: { speed: 1.5 } });
  });
  it("超过 TTS_MAX_UNITS 拒，且说出字符数", () => {
    const r = parseTtsRequest({ text: "汉".repeat(1001), voice_id: "v" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("2002");
  });
});

describe("ttsUpstreamBody：MiniMax t2a_v2 的形状，非流式 mp3 64kbps", () => {
  it("字段齐全", () => {
    const b = JSON.parse(ttsUpstreamBody("speech-2.8-turbo", { text: "hi", voiceId: "v", speed: 1.2 }));
    expect(b).toEqual({
      model: "speech-2.8-turbo", text: "hi", stream: false,
      voice_setting: { voice_id: "v", speed: 1.2, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 64000, format: "mp3", channel: 1 },
    });
  });
});

describe("parseTtsReply", () => {
  it("HTTP 200 + status_code≠0 是失败（真机：.io 站回 2049 invalid api key）", () => {
    const r = parseTtsReply(JSON.stringify({ base_resp: { status_code: 2049, status_msg: "invalid api key" } }));
    expect(r).toEqual({ ok: false, message: "MiniMax 2049：invalid api key" });
  });
  it("成功：hex → 字节，usage_characters / audio_length 带回", () => {
    const r = parseTtsReply(JSON.stringify({ data: { audio: "fffb", status: 2 }, extra_info: { usage_characters: 41, audio_length: 5508 }, base_resp: { status_code: 0, status_msg: "success" } }));
    expect(r).toEqual({ ok: true, audio: new Uint8Array([0xff, 0xfb]), usageChars: 41, audioMs: 5508 });
  });
  it("没有 audio / 不是 JSON / hex 坏了 → 失败", () => {
    expect(parseTtsReply("not json").ok).toBe(false);
    expect(parseTtsReply(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: "" } })).ok).toBe(false);
    expect(parseTtsReply(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: "zz" } })).ok).toBe(false);
  });
  it("hexToBytes：奇数长度 / 非 hex 回 null", () => {
    expect(hexToBytes("0aff")).toEqual(new Uint8Array([10, 255]));
    expect(hexToBytes("abc")).toBeNull();
    expect(hexToBytes("zz")).toBeNull();
  });
});
```

- [ ] **Step 2: 红** — [ ] **Step 3: 实现**（按上面接口；`parseTtsReply` 先 `JSON.parse`，再看 `base_resp.status_code`，再 `data.audio` hex；`usage_characters`/`audio_length` 非有限数一律 null）— [ ] **Step 4: 绿** — [ ] **Step 5: Commit** `feat(edge): MiniMax t2a_v2 的请求/回包纯映射（#1163）`

---

### Task 3: 网关 `/llm/v1/speech` + `/me.ttsModels`

**Files:**
- Modify: `services/edge/src/llmGateway.ts`（`RouteKind`、`UPSTREAM_KEY_ENV`、`upstreamPathFor`、`serve` 内 `serveTts` 分支）
- Modify: `services/edge/src/edge.ts:447`（门）
- Modify: `services/edge/src/billingQueries.ts`（`parseRouteRows` kind、`modelsForMe`、`meFromParts` 第八参 `ttsModels`）
- Modify: `services/edge/src/worker.ts`（`Env.MINIMAX_API_KEY?`、`me()` 递 `ttsModels`）
- Modify: `src/shared/billing.ts`（`BillingMe.ttsModels`、`parseBillingMe`）
- Test: `tests/edge/llmGateway.test.ts`、`tests/edge/edge.test.ts`、`tests/edge/billingQueries.test.ts`、`tests/shared/billing.test.ts`

**Interfaces:**
- Produces: 客户端 POST `/llm/v1/speech` `{model, text, voice_id, speed?}` → 200 `audio/mpeg` 字节 + 头 `x-otto-cost-micro` / `x-otto-audio-ms` / `x-otto-tts-chars` + 既有额度头；`BillingMe.ttsModels: string[]`

- [ ] **Step 1: 测试（llmGateway.test.ts 新 describe）**

```ts
const tts: RouteRow = {
  id: "speech-2.8-turbo@minimax", logicalModel: "speech-2.8-turbo", platform: "minimax",
  baseUrl: "https://mm/v1", wireModel: "speech-2.8-turbo",
  priceInMicroPerM: 0, priceCacheMicroPerM: 0, priceOutMicroPerM: 27_777_778, defaultMaxTokens: 400, kind: "tts",
};
const speechReq = (body: unknown) =>
  new Request("https://edge/llm/v1/speech", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const mmOk = (hex = "fffb", chars = 41) => () =>
  Response.json({ data: { audio: hex, status: 2 }, extra_info: { usage_characters: chars, audio_length: 5508 }, base_resp: { status_code: 0, status_msg: "success" } });

describe("语音那扇门（#1163）：kind=tts 打 /t2a_v2，按字符数预扣与结算，hex 解成 audio/mpeg", () => {
  it("upstreamPathFor(tts) = /t2a_v2；UPSTREAM_KEY_ENV 有 minimax", () => {
    expect(upstreamPathFor("tts")).toBe("/t2a_v2");
    expect(UPSTREAM_KEY_ENV.minimax).toBe("MINIMAX_API_KEY");
  });
  it("成功：预扣 = 41 字符 × 单价；结算用 usage_characters；回 mp3 字节与三个头", async () => {
    const { quota, calls } = quotaStub();
    const up = upstream(mmOk());
    const holdArgs: number[] = [];
    quota.hold = async (_u, rid, est) => { calls.hold.push(rid); holdArgs.push(est); return { ok: true, chargedTo: "window" }; };
    const handle = createLlmGateway({ routes: async () => [tts], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const res = await handle(speechReq({ model: "speech-2.8-turbo", text: "你好，我是管理员。这条消息是语音通话的测试。", voice_id: "male-qn-jingying" }), caller);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xfb]));
    expect(holdArgs).toEqual([Math.round(41 * 27_777_778 / 1_000_000)]);
    expect(calls.settle[0]!.usage).toEqual({ promptTokens: 0, cachedTokens: 0, completionTokens: 41 });
    expect(res.headers.get(BILLING_HEADERS.cost)).toBe(String(calls.settle[0]!.costMicro));
    expect(res.headers.get(TTS_HEADERS.audioMs)).toBe("5508");
    expect(res.headers.get(TTS_HEADERS.chars)).toBe("41");
    // 上游收到的是 MiniMax 形状，打的是 /t2a_v2，带 Bearer key
    const sent = up.seen[0]!;
    expect(sent.url).toBe("https://mm/v1/t2a_v2");
    expect(await sent.json()).toMatchObject({ model: "speech-2.8-turbo", stream: false, voice_setting: { voice_id: "male-qn-jingying" } });
  });
  it("HTTP 200 + status_code≠0：释放预扣、回 502 带 MiniMax 的话", async () => {
    const { quota, calls } = quotaStub();
    const up = upstream(() => Response.json({ base_resp: { status_code: 1004, status_msg: "auth failed" } }));
    const handle = createLlmGateway({ routes: async () => [tts], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const res = await handle(speechReq({ model: "speech-2.8-turbo", text: "hi", voice_id: "v" }), caller);
    expect(res.status).toBe(502);
    expect(calls.release).toHaveLength(1);
    expect(calls.settle).toHaveLength(0);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("1004");
  });
  it("形状不对 400，一个字节都不发、不 hold", async () => {
    const { quota, calls } = quotaStub();
    const up = upstream(mmOk());
    const handle = createLlmGateway({ routes: async () => [tts], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const res = await handle(speechReq({ model: "speech-2.8-turbo", text: "hi" }), caller);
    expect(res.status).toBe(400);
    expect(calls.hold).toHaveLength(0);
    expect(up.seen).toHaveLength(0);
  });
  it("额度用完：429 quota_exhausted 同 chat 那条路", async () => {
    const { quota } = quotaStub({ ok: false, code: "quota_exhausted", window: "5h", resetAt: 1 });
    const handle = createLlmGateway({ routes: async () => [tts], quota, upstreamKey: () => "k", fetchImpl: upstream(mmOk()).fetchImpl });
    const res = await handle(speechReq({ model: "speech-2.8-turbo", text: "hi", voice_id: "v" }), caller);
    expect(res.status).toBe(429);
  });
});
```

edge.test.ts 那条门的用例加一行 `expect((await body("/llm/v1/speech")).error.code).toBe("llm_disabled");`。
billingQueries.test.ts：`modelsForMe([chatRow, imageRow, ttsRow]).ttsModels` 等于 `["speech-2.8-turbo"]` 且 `models` / `imageModels` 都不含它；`meFromParts(..., ["img"], ["speech-2.8-turbo"]).ttsModels` 透传、缺省 `[]`。
billing.test.ts：`parseBillingMe` 缺席 → `ttsModels: []`，在场原样。

- [ ] **Step 2: 红** — [ ] **Step 3: 实现**

llmGateway.ts 关键片段（放在 `serve` 顶部）：

```ts
if (route.kind === "tts") return serveTts(route, key);
```

```ts
const serveTts = async (route: RouteRow, key: string): Promise<Response> => {
  const parsed = parseTtsRequest(body);
  if (!parsed.ok) return apiError(400, parsed.message, "bad_request");
  const units = ttsUnits(parsed.req.text);
  const requestId = newId();
  const estimate = costMicro({ promptTokens: 0, cachedTokens: 0, completionTokens: units }, route);
  let held: HoldOutcome;
  try { held = await deps.quota.hold(caller.uid, requestId, estimate); }
  catch { return apiError(503, "额度服务暂时不可用，稍后再试", "upstream"); }
  if (!held.ok) { /* 逐字复用 chat 那条路的三种拒绝 */ }
  try {
    let res: Response;
    try {
      res = await doFetch(`${route.baseUrl}${upstreamPathFor(route.kind)}`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: ttsUpstreamBody(route.wireModel, parsed.req), signal: req.signal,
      });
    } catch { await deps.quota.release(caller.uid, requestId); return apiError(502, `上游连不上：${route.platform}`, "upstream"); }
    if (!res.ok) { await deps.quota.release(caller.uid, requestId); const snippet = (await res.text().catch(() => "")).slice(0, 300); return apiError(502, `上游 ${res.status}：${snippet}`, "upstream", { upstreamStatus: res.status }); }
    const reply = parseTtsReply(await res.text());
    if (!reply.ok) { await deps.quota.release(caller.uid, requestId); return apiError(502, reply.message, "upstream"); }
    const usage: UsageCounts = { promptTokens: 0, cachedTokens: 0, completionTokens: reply.usageChars ?? units };
    const cost = costMicro(usage, route);
    await deps.quota.settle(caller.uid, requestId, { caller, route, usage, costMicro: cost });
    const headers = await remainingHeaders(caller.uid);
    return new Response(reply.audio, { status: 200, headers: { "content-type": "audio/mpeg", ...headers, [BILLING_HEADERS.cost]: String(cost), [TTS_HEADERS.chars]: String(usage.completionTokens), ...(reply.audioMs !== null ? { [TTS_HEADERS.audioMs]: String(reply.audioMs) } : {}) } });
  } catch (err) { await deps.quota.release(caller.uid, requestId).catch(() => {}); return apiError(502, `处理请求时出错：${err instanceof Error ? err.message : String(err)}`, "upstream"); }
};
```

`RouteKind = "chat" | "image" | "tts"`；`upstreamPathFor`：`tts → "/t2a_v2"`。`parseRouteRows`：`r.kind === "image" ? "image" : r.kind === "tts" ? "tts" : "chat"`。`modelsForMe` 回 `ttsModels`；`meFromParts(..., imageModels = [], ttsModels = [])`；worker.ts `me()` 解构并递第八参。`BillingMe.ttsModels: string[]`（必填，同 `imageModels`；tsc 会点名九个测试 fixture，各补 `ttsModels: []`）。

- [ ] **Step 4: 绿（含 tsc：`npx tsc --noEmit`）** — [ ] **Step 5: Commit** `feat(edge): /llm/v1/speech——model_route.kind=tts 走 MiniMax，按字符数 hold/settle，/me 多一格 ttsModels（#1163）`

---

### Task 4: migration 0033 + edge README

**Files:**
- Create: `supabase/migrations/0033_model_route_tts.sql`
- Modify: `services/edge/README.md`（secret 清单加 `MINIMAX_API_KEY`，端点表加 `/llm/v1/speech`）

- [ ] **Step 1: 写 migration**（幂等；头注写价怎么算的 + 部署顺序：先跑本条再部署 worker——顺序反了只是 `ttsModels` 为空、桌面不画语音钮，不会炸）

```sql
alter table public.model_route drop constraint if exists model_route_kind_check;
alter table public.model_route add constraint model_route_kind_check check (kind in ('chat', 'image', 'tts'));
insert into public.model_route (id, logical_model, platform, base_url, wire_model, price_in_micro_per_m, price_cache_micro_per_m, price_out_micro_per_m, default_max_tokens, quantization, priority, enabled, kind)
values ('speech-2.8-turbo@minimax', 'speech-2.8-turbo', 'minimax', 'https://api.minimaxi.com/v1', 'speech-2.8-turbo', 0, 0, 27777778, 400, 'none', 10, true, 'tts')
on conflict (id) do update set logical_model = excluded.logical_model, platform = excluded.platform, base_url = excluded.base_url, wire_model = excluded.wire_model, price_in_micro_per_m = excluded.price_in_micro_per_m, price_cache_micro_per_m = excluded.price_cache_micro_per_m, price_out_micro_per_m = excluded.price_out_micro_per_m, default_max_tokens = excluded.default_max_tokens, quantization = excluded.quantization, priority = excluded.priority, enabled = excluded.enabled, kind = excluded.kind;
```

- [ ] **Step 2: Commit** `chore(db): 0033 model_route 加 tts 一款 speech-2.8-turbo@minimax（#1163）`

---

### Task 5: 桌面主进程：`ttsInput` / `routeTts` / `teamVoice` / IPC

**Files:**
- Modify: `src/main/hostedQuota.ts`（`ttsInput()`）、`src/main/modelRoute.ts`（`ttsBlocked` / `routeTts`）
- Create: `src/main/teamVoice.ts`
- Modify: `src/shared/shellBridge.ts`（`VoiceSpeakResult`、`teamVoiceSpeak`、`CHANNELS.teamVoiceSpeak`）、`src/preload/index.ts`、`src/main/index.ts`（造 `createTeamVoice` + `ipcMain.handle`）
- Test: `tests/main/hostedQuota.test.ts`、`tests/main/modelRoute.test.ts`、`tests/main/teamVoice.test.ts`

**Interfaces:**
- Produces: `VoiceSpeakResult = { ok: true; audio: Uint8Array; costMicro: number; audioMs: number | null } | { ok: false; message: string }`；`window.otter.teamVoiceSpeak(text: string, voiceId: string): Promise<VoiceSpeakResult>`
- `routeTts(input: { hosted?: { subscribed; exhausted; resetAt?; ttsModels: string[] }; hostedBaseUrl?; hostedToken? }): { kind: "hosted"; url: string; model: string } | { kind: "blocked"; reason: string }`

- [ ] **Step 1: 测试**

hostedQuota.test.ts：`me` fixture 加 `ttsModels: ["speech-2.8-turbo"]`；`q.ttsInput()` 等于 `{ subscribed: true, exhausted: false, ttsModels: ["speech-2.8-turbo"] }`；没登录 → `{ subscribed: false, exhausted: false, ttsModels: [] }`。
modelRoute.test.ts `describe("routeTts")`：照 routeImage 那组五条（成功 url 是 `.../speech`、没订阅说「订阅」不提 key、额度用完带「加购」、清单空说「语音」不说「没有订阅」、缺 JWT 说「连不上」）。
teamVoice.test.ts：

```ts
import { describe, expect, it, vi } from "vitest";
import { createTeamVoice } from "../../src/main/teamVoice.js";
import { BILLING_HEADERS } from "../../src/shared/billing.js";
import { TTS_HEADERS } from "../../src/shared/tts.js";

function make(res: () => Response, over: Partial<{ subscribed: boolean; ttsModels: string[]; token: string | null }> = {}) {
  const noted: Headers[] = []; const exhausted: unknown[] = [];
  const fetchImpl = vi.fn(async () => res()) as unknown as typeof fetch;
  const voice = createTeamVoice({
    quota: {
      ttsInput: () => ({ subscribed: over.subscribed ?? true, exhausted: false, ttsModels: over.ttsModels ?? ["speech-2.8-turbo"] }),
      noteHeaders: (h) => { noted.push(h); }, noteExhausted: (i) => { exhausted.push(i); },
    },
    edgeBaseUrl: () => "https://edge", accessToken: async () => (over.token === undefined ? "jwt" : over.token), fetchImpl,
  });
  return { voice, fetchImpl, noted, exhausted };
}

describe("teamVoice.speak（#1163）", () => {
  it("成功：POST /llm/v1/speech 带 JWT，回字节 + cost + audioMs，记额度头", async () => {
    const { voice, fetchImpl, noted } = make(() => new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-type": "audio/mpeg", [BILLING_HEADERS.cost]: "1139", [TTS_HEADERS.audioMs]: "5508", [BILLING_HEADERS.h5]: "99" } }));
    const r = await voice.speak("你好", "male-qn-jingying");
    expect(r).toEqual({ ok: true, audio: new Uint8Array([1, 2]), costMicro: 1139, audioMs: 5508 });
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe("https://edge/llm/v1/speech");
    expect(init.headers).toMatchObject({ authorization: "Bearer jwt" });
    expect(JSON.parse(String(init.body))).toEqual({ model: "speech-2.8-turbo", text: "你好", voice_id: "male-qn-jingying" });
    expect(noted).toHaveLength(1);
  });
  it("没订阅：一个字节都不发，blocked 文案说订阅", async () => {
    const { voice, fetchImpl } = make(() => new Response(""), { subscribed: false });
    const r = await voice.speak("x", "v");
    expect(r).toMatchObject({ ok: false }); if (!r.ok) expect(r.message).toContain("订阅");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("429 quota_exhausted：记 exhausted，文案原样", async () => {
    const { voice, exhausted } = make(() => Response.json({ error: { type: "otto_edge", code: "quota_exhausted", message: "5 小时额度已用完", window: "5h", resetAt: 5 } }, { status: 429 }));
    const r = await voice.speak("x", "v");
    expect(r).toEqual({ ok: false, message: "5 小时额度已用完" });
    expect(exhausted).toEqual([{ window: "5h", resetAt: 5 }]);
  });
  it("连不上：说连不上，不说没订阅", async () => {
    const { voice } = make(() => { throw new Error("ECONNRESET"); });
    const r = await voice.speak("x", "v");
    expect(r.ok).toBe(false); if (!r.ok) { expect(r.message).toContain("连不上"); expect(r.message).not.toContain("订阅"); }
  });
});
```

- [ ] **Step 2: 红** — [ ] **Step 3: 实现**（`teamVoice.ts` 按 spec 3.6；`index.ts` 在 `hostedQuota` 造好之后 `const teamVoice = createTeamVoice({ quota: hostedQuota, edgeBaseUrl: () => edgeBaseUrl(), accessToken: () => accountManager?.getAccessToken() ?? Promise.resolve(null) })`，`ipcMain.handle(CHANNELS.teamVoiceSpeak, (_e, text: string, voiceId: string) => teamVoice.speak(text, voiceId))`）— [ ] **Step 4: 绿 + tsc** — [ ] **Step 5: Commit** `feat(main): teamVoice——拿 JWT 打网关合成一段语音，额度头照记（#1163）`

---

### Task 6: 事件 `voice_call_changed` + 投影 + 音色派生 + 八处清单

**Files:**
- Create: `src/shared/fnv1a.ts`（从 `agentAvatarSlot.ts` 抽出，那边改 import）、`src/shared/agentVoice.ts`、`src/shared/voiceCall.ts`
- Modify: `src/session/events.ts`、`persistencePolicy.ts`、`agentView.ts`、`src/shared/sessionPackage.ts`、`src/shared/contextEstimate.ts`、`src/renderer/src/components/Timeline.tsx`（`case "voice_call_changed": return null;`）
- Test: `tests/shared/voiceCall.test.ts`、`tests/shared/agentVoice.test.ts`、`tests/session/persistencePolicy.test.ts`（DURABLE 加一项）、`tests/renderer/agentAvatarSlot.test.ts` 不变（行为不变）

**Interfaces:**
- `VoiceCallChangedEvent { type: "voice_call_changed"; participants: { agentId: string; name: string }[]; byUid: string; byAgentId?: string; ignorable: true }`
- `VoiceCallState { participants: { agentId; name }[]; sinceSeq: number; sinceTs: number }`
- `voiceCallOf(events): VoiceCallState | null`、`applyVoiceCallEvent(prev: VoiceCallState | null, e: VoiceCallChangedEvent): VoiceCallState | null`、`inVoiceCall(state, agentId): boolean`
- `AGENT_VOICES: readonly { id: string; label: string }[]`、`ADMIN_VOICE_ID`、`agentVoiceIds(roster: readonly string[]): Map<string, string>`、`agentVoiceId(agentId, roster): string`
- `fnv1a(s: string): number`

- [ ] **Step 1: 测试**

```ts
// tests/shared/voiceCall.test.ts
describe("voiceCallOf", () => {
  it("没有事件 → null；空名单 = 结束；sinceSeq/sinceTs 取这一场第一条非空事件", () => {
    const a = ev(3, [{ agentId: "a", name: "A" }]);
    const b = ev(5, [{ agentId: "a", name: "A" }, { agentId: "b", name: "B" }]);
    expect(voiceCallOf([])).toBeNull();
    expect(voiceCallOf([a, b])).toEqual({ participants: b.participants, sinceSeq: 3, sinceTs: 30 });
    expect(voiceCallOf([a, b, ev(7, [])])).toBeNull();
    expect(voiceCallOf([a, ev(4, []), b])).toMatchObject({ sinceSeq: 5 });
  });
  it("applyVoiceCallEvent 逐条推进 == voiceCallOf 整份折叠", () => { /* 对拍 */ });
});
// tests/shared/agentVoice.test.ts
describe("agentVoiceIds", () => {
  it("管理员固定沉稳高管；同一 id 两次派生同一音色；名单顺序解撞", () => {
    expect(agentVoiceId("admin", ["admin"])).toBe(ADMIN_VOICE_ID);
    const r = ["admin", "a_1", "a_2"]; expect(agentVoiceId("a_1", r)).toBe(agentVoiceId("a_1", [...r]));
    const ids = agentVoiceIds(["admin", ...Array.from({ length: AGENT_VOICES.length }, (_, i) => `a_${i}`)]);
    expect(new Set(ids.values()).size).toBe(AGENT_VOICES.length + 1); // 不撞（含管理员那一个）
  });
  it("音色表里 id 唯一、非空", () => { ... });
});
```

- [ ] **Step 2: 红** — [ ] **Step 3: 实现**（`agentVoiceIds` 逐字照 `agentAvatarSlots` 的算法：管理员固定、其余 `fnv1a(id) % AGENT_VOICES.length`、按名单顺序线性探测、全满退回天然位；`Timeline.tsx` 的 case 返回 null；`persistencePolicy` 加 durable；`agentView: "keep"`；`sessionPackage: "strip"`；`contextEstimate` 加 case break）— [ ] **Step 4: 绿 + tsc**（`tests/renderer/timelineLists.test.ts` 应保持绿：`return null` 分支与 `isAuditEvent` 不放行一致）— [ ] **Step 5: Commit** `feat(session): voice_call_changed 事件 + 投影 + 音色派生（#1163）`

---

### Task 7: deriveMessages 的通话块

**Files:**
- Modify: `src/session/deriveMessages.ts`（`renderVoiceCallPrompt` 导出；主循环记 `isCloud`、最近 brief 的 name/roster、最后一条通话事件；尾部追加）
- Test: `tests/session/deriveMessages.voiceCall.test.ts`

**Interfaces:**
- `renderVoiceCallPrompt(participants: { agentId; name }[], selfName: string | null, roster: { name; description }[]): string`

- [ ] **Step 1: 测试**：① 没有通话事件的云会话投影逐字节不变；② 有通话：system 尾部含「语音通话进行中」「通话里的成员：管理员、开发」「不在通话里的：测试（跑测试）」「invite_to_call」；③ 两条事件只留最新（不 `+=`）；④ 空名单之后块消失；⑤ 本机会话（无 cloud）即使有事件也不注入；⑥ 名字里的 `]` 过 promptSafe。

- [ ] **Step 2: 红** — [ ] **Step 3: 实现**（文案见 spec 3.3）— [ ] **Step 4: 绿** — [ ] **Step 5: Commit** `feat(session): 通话名单投影进云会话 system 尾部——只有通话成员参与，先问再拉人（#1163）`

---

### Task 8: 协议 17 + `call` 帧 + `setVoiceCall`

**Files:**
- Modify: `src/shared/remote/cloudSession.ts`（版本、`CsUp.call`、`CsDown.call_result`、编解码）
- Modify: `services/runtime/src/rateLimit.ts`（`CALL_BUCKET = { capacity: 10, refillPerMin: 10 }`、`ThrottleKind` 加 `"call"`、`throttleMessage`）
- Modify: `services/runtime/src/frameHandler.ts`（`case "call"`）
- Modify: `services/runtime/src/sessionService.ts`（`CloudSession.setVoiceCall`、`voiceCall` 状态从 seed 折叠 + `notify` 推进、`logVoiceCall`）
- Test: `tests/shared/remote/cloudSession.test.ts`（版本 17、`call` 编解码、坏形状拒）、`tests/runtime/frameHandler.test.ts`（在籍 / 桶 / 三态回执；`fakeSession` 补 `setVoiceCall: async () => ({ kind: "ok" })`）、`tests/runtime/sessionService.test.ts`（`setVoiceCall`：落事件带名字 / 名单外 id 拒 / 同名单不重复落 / 归档拒）

**Interfaces:**
- `CloudSession.setVoiceCall(byUid: string, byLabel: string, participants: string[]): Promise<{ kind: "ok" } | { kind: "unknown_agent" | "archived"; message: string }>`

- [ ] Steps: 测试 → 红 → 实现 → 绿 → Commit `feat(runtime): call 帧——任何在籍成员改通话名单，落 voice_call_changed，协议 16→17（#1163）`

---

### Task 9: runtime：派活只在通话里、@ 外人自动拉进、接力过滤、`invite_to_call`

**Files:**
- Create: `services/runtime/src/inviteToCallTool.ts`
- Modify: `services/runtime/src/sessionService.ts`（`say()` 的 `callRoster`、自动拉进；`relayAfterTurn` 过滤 + 系统话；`engineFor` 挂工具）
- Test: `tests/runtime/inviteToCallTool.test.ts`、`tests/runtime/sessionService.test.ts` 新 describe「语音通话（#1163）」

**Interfaces:**
- `createInviteToCallTool(deps: { agentId: string; currentCall: () => VoiceCallState | null; roster: () => Promise<{ agentId: string; name: string }[]>; invite: (target: { agentId: string; name: string }) => void }): Tool`，工具名 `INVITE_TO_CALL_TOOL_NAME = "invite_to_call"`，参数 `{ name: string }`，`requiresApproval: false`

- [ ] **Step 1: 测试**
  - inviteToCallTool：没有通话抛「没有语音通话」；名单没有抛「没有叫」；已在通话里回「已经在通话里」不调 invite；成功调 invite 一次、回执含「可以 @」。
  - sessionService：① 通话 {ops} 开着、`say` 不 @ → 分类器收到的 roster 只有 ops；② 通话 {ops}、人 @ 了 ads → 先落 `voice_call_changed{participants: ops+ads, byUid}` 再落开场白；③ 通话 {ops}、ops 的回复 @ 了 ads → 不落 agent_relay、落一条系统 chat_message 含「不在通话里」；④ mention:true 开局卡回落通话第一只不是名单第一只；⑤ 工具挂在每只 engine 上（`tools()` 里有 invite_to_call）；⑥ agent 调 invite_to_call 后事件带 `byAgentId`。

- [ ] Steps: 红 → 实现 → 绿 → Commit `feat(runtime): 通话里只有通话成员参与——派活/接力按名单过滤，@ 外人自动拉进，invite_to_call（#1163）`

---

### Task 10: 桌面：`call()` RPC、store、时间线旁白

**Files:**
- Modify: `src/main/cloudSessionClient.ts`（`call(participants)`、`pendingCall`、`case "call_result"`、gone 收口）
- Modify: `src/shared/shellBridge.ts`（`workspaceCloudCall`、`CHANNELS.workspaceCloudCall`）、`src/preload/index.ts`、`src/main/index.ts`
- Modify: `src/renderer/src/store.ts`（`cloudCall(participants): Promise<CloudAck>`）
- Modify: `src/renderer/src/lib/cloudTimeline.ts`（`voiceCallLineText(prev, e, ws)`）、`CloudSessionPage.tsx`（`VoiceCallRow` + 前一条查找 memo）
- Test: `tests/main/cloudSessionClient.test.ts`（照 stop 那四条）、`tests/renderer/cloudTimelineLabels.test.ts`（五种文案）

**Interfaces:**
- `voiceCallLineText(prev: VoiceCallChangedEvent | null, e: VoiceCallChangedEvent, ws: WorkspaceSnapshot): string`

- [ ] Steps: 测试 → 红 → 实现 → 绿 → Commit `feat(desktop): 通话名单帧的桌面半边 + 时间线旁白（#1163）`

---

### Task 11: 渲染层语音引擎（纯逻辑 + 播放器 + store 切片）

**Files:**
- Create: `src/renderer/src/lib/voiceCall.ts`、`src/renderer/src/lib/voicePlayer.ts`
- Modify: `src/renderer/src/store.ts`（`voice` 切片、`joinVoiceCall` / `leaveVoiceCall` / `setVoiceMuted`、`onCloudSessionEvent` / `onCloudSessionDelta` 喂料、`closeCloudSession` 收口）
- Test: `tests/renderer/voiceCall.test.ts`、`tests/renderer/voicePlayer.test.ts`

**Interfaces:**
- `voiceCallAvailable(billing: BillingSnapshotView | null): boolean`
- `spokenText(content: string): string`
- `VoiceFeedState = { spoken: Record<string, string[]> }`；`Utterance = { key: string; agentId: string; text: string }`
- `feedDelta(state, participants: ReadonlySet<string>, agentId: string, text: string): { state; out: Utterance[] }`
- `feedEvent(state, participants, listenSinceSeq: number, e: SessionEvent): { state; out: Utterance[] }`
- `class VoicePlayer { constructor(deps: { speak; createAudio?; toUrl?; revokeUrl?; onChange }); enqueue(u: Utterance & { voiceId: string }): void; stop(): void; state(): VoicePlayerState }`
- store：`voice: { sessionId: string; listening: boolean; muted: boolean; sinceSeq: number; speaking: string | null; queued: number; error: string | null } | null`

- [ ] **Step 1: 测试**
  - `spokenText`：剥 `[名字]: ` 前缀、`**粗**`→粗、`# 标题`→标题、`- 项`→项、`[文](url)`→文、整段代码围栏→空串、行内反引号只留内容。
  - `feedDelta`：快照「a\n\nb\n\nc（未完）」→ 出 a、b；再来「a\n\nb\n\nc\n\nd」→ 只出 c；不在名单的 agent 不出。
  - `feedEvent`：终态内容「a\n\nb\n\nc」在 a、b 已读后只出 c，并清这只的 spoken；seq ≤ since 不出；`turn_ended` 清 spoken；工具步（content 空）不出。
  - `voicePlayer`：两段入队 → 第二段的 speak 在第一段播放时就发出（预取）；串行；`stop()` 清空；speak 失败记 error 跳到下一段；`onChange` 报 speaking。

- [ ] Steps: 红 → 实现 → 绿 → Commit `feat(renderer): 语音引擎——一段写完就合成、全局串行播放、预取下一段（#1163）`

---

### Task 12: UI：语音钮、选人弹层、通话栏

**Files:**
- Create: `src/renderer/src/components/VoicePickerPopover.tsx`、`VoiceCallBar.tsx`
- Modify: `src/renderer/src/components/CloudSessionPage.tsx`（左簇加钮、头部之下挂通话栏）
- Test: `tests/renderer/voiceCallBar.test.tsx`（jsdom 真渲染：有通话画头像 N 个；speaking 那只 `data-speaking="true"`；没订阅画「语音要订阅」；listening 时有「静音」「结束通话」）

- [ ] Steps: 测试 → 红 → 实现 → 绿 → Commit `feat(ui): 输入框语音钮 + 通话栏（参与者/说话环/计时/加人/静音/结束）（#1163）`

---

### Task 13: 文档 + 门禁 + PR

- [ ] ADR-0271（`docs/adr/0271-团队语音通话-通话是日志事实-TTS走edge-听的人付费.md`）：背景 / 决策（六条拍板各一节 + 否决项）/ 代价 / 推翻前提
- [ ] CONTEXT.md 产品术语加「语音通话（voice call）」一行
- [ ] AGENTS.md「Where to find things」加一条索引（L2）
- [ ] `npm test` 全绿；`git push`；`gh pr create`（正文写 GUI 未验 + 部署四步）；等 CI 绿；合并前 re-fetch 查 ADR 撞号；merge commit

### Task 14（合并后）: 部署 + 真机

- [ ] Cloud 真库跑 0033（Management API 逐条）
- [ ] `cd services/edge && npx wrangler secret put MINIMAX_API_KEY`
- [ ] `npm run edge:deploy`；`RUNTIME_SSH=stan@65.109.113.168 npm run runtime:deploy`；`npm run deploy:check` 两边 current
- [ ] `OTTO_PROFILE=dev` + Playwright 起 `out/`：开通话 → @ 一只 → 有声音；@ 通话外 → 自动拉进；结束 → 栏消失。结果贴回 #1163
- [ ] 交接 issue（五段 Memory）
