// 应用连接卡（#1666）：request_app_connect 在 sessionService 里的挂刀条件、发卡落盘、已连上 / 已有开着的卡 / 每小时上限。
// 装配照 sessionService.friendRelay.test.ts 的 openWith 抄最小一份
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { createCloudSession, type CloudSession, type CloudSessionOpts } from "../../services/runtime/src/sessionService.js";
import { createWikiService, type WikiService } from "../../services/runtime/src/wikiService.js";
import { createMemoryWikiFs } from "../../services/runtime/src/wikiFs.js";
import { createInMemoryWikiJournal } from "../../services/runtime/src/wikiJournal.js";
import { EventStore } from "../../src/session/store.js";
import type { AppConnectEvent, ApprovalRequestEvent, RequestEnvelopeEvent, ToolResultEvent, UserMessageEvent } from "../../src/session/events.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import { pxToolName, type PxCallDeps } from "../../services/runtime/src/pxTools.js";
import type { AgentToolAllow } from "../../src/shared/agentToolAllow.js";
import type { AgentTier } from "../../src/shared/agentTier.js";
import { ADMIN_AGENT_ID } from "../../src/shared/workspaceAgents.js";
import { REQUEST_APP_CONNECT_TOOL_NAME, appConnectToolText, appConnectedOpening, appDeclinedOpening } from "../../src/shared/appConnect.js";
import { tempDir } from "../helpers/tempDir.js";
import { createInMemoryAgentWriter } from "../../services/runtime/src/agentRegistry.js";
import { createInMemoryMentionInbox } from "../../services/runtime/src/mentionInbox.js";
import { createWorkspaceLock } from "../../services/runtime/src/workspaceLock.js";
import { createInMemoryCloudSessionMeta } from "../../services/runtime/src/cloudSessionMeta.js";

const OWNER = "owner";
const PEER = "peer-1";
const SID = "s1";
const TOOL = REQUEST_APP_CONNECT_TOOL_NAME;

const fakeWorld: ExecutionWorld = {
  fs: { read: async (path) => `<content of ${path}>`, write: async () => {} },
  exec: async () => ({ stdout: "hi", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};
const basePx: PxCallDeps = { edgeBase: "https://edge.example", runtimeSecret: "sek" };
const OPS = { agentId: ADMIN_AGENT_ID, name: "运维", description: "", instructions: "", models: ["fake-model"], tools: [] as AgentToolAllow[], tier: 0 as AgentTier };

const newStore = (): EventStore => new EventStore(join(tempDir("mrotto-runtime-appconnect-"), "session.db"));
const testWiki = (): WikiService =>
  createWikiService({ workspaceId: "w1", fs: createMemoryWikiFs(), journal: createInMemoryWikiJournal(), legacyMemories: async () => [], agentNames: async () => new Map(), isRunning: async () => true });

const dmSeed = (store: EventStore): void => {
  store.append({ sessionId: SID, ts: 1, type: "session_created", workspace: "/work", cloud: { workspaceId: "w1", home: true, chat: { kind: "dm" } } });
  store.append({ sessionId: SID, ts: 2, type: "chat_roster_changed", agents: [{ agentId: ADMIN_AGENT_ID, name: "运维" }], humans: [], ignorable: true });
};
const outreachSeed = (store: EventStore): void => {
  store.append({
    sessionId: SID, ts: 1, type: "session_created", workspace: "/work",
    cloud: { workspaceId: "w1", home: true, chat: { kind: "outreach" }, outreach: { ownerName: "Stan", peerUid: PEER, peerName: "小红" } },
  });
  store.append({ sessionId: SID, ts: 2, type: "chat_roster_changed", agents: [{ agentId: ADMIN_AGENT_ID, name: "运维" }], humans: [{ uid: PEER, name: "小红" }], ignorable: true });
};

function openWith(store: EventStore, o: { adapter: ModelAdapter; approveAll?: boolean; px?: PxCallDeps; now?: () => number; hostUids?: string[]; agents?: CloudSessionOpts["agents"]; autoApprove?: boolean }): CloudSession {
  let s!: CloudSession;
  s = createCloudSession({
    sessionMeta: createInMemoryCloudSessionMeta(),
    workspaceId: "w1", sessionId: SID, ownerUid: OWNER, createdByUid: OWNER, store, world: fakeWorld,
    agents: o.agents ?? (async () => [OPS]), adapterFor: () => o.adapter, px: o.px ?? basePx, hostUids: async () => o.hostUids ?? [OWNER],
    // 受监督轮里连接器要批：autoApprove 时主人当场批（同 friendRelay.test 的写法）
    onEvent: (e) => {
      if (o.autoApprove === true && e.type === "approval_request") void s.approve((e as ApprovalRequestEvent).callId, OWNER, "Stan", "approved");
    },
    onUsage: () => {}, wiki: testWiki(), mentionInbox: createInMemoryMentionInbox(),
    agentWriter: createInMemoryAgentWriter(), isMember: async () => true, contextWindowOf: () => undefined,
    sandboxApproval: async () => "ask", workspaceLock: createWorkspaceLock(), relayRemainingMicro: async () => null,
    diskUsage: () => null, routines: null, onOutreachEnded: null, signSpeechTicket: async () => "t", pairMessages: null,
    outreach: null, approveAll: o.approveAll ?? true, callback: null,
    ...(o.now !== undefined ? { now: o.now } : {}),
  } as CloudSessionOpts);
  return s;
}

/** 第一轮一次调若干把 request_app_connect，之后说一句收口 */
function callsOnce(calls: { app: string; why?: string }[]): ModelAdapter {
  let round = 0;
  return { model: "fake-model", async chat(): Promise<ModelReply> {
    round++;
    return round === 1
      ? { content: "", toolCalls: calls.map((c, i) => ({ id: `c${i + 1}`, name: TOOL, args: { app: c.app, why: c.why ?? "要用它办事" } })) }
      : { content: "好的" };
  } };
}
const noop: ModelAdapter = { model: "fake-model", async chat() { return { content: "好" }; } };

const cards = (store: EventStore): AppConnectEvent[] => store.ofType(SID, "app_connect") as AppConnectEvent[];
const results = (store: EventStore): ToolResultEvent[] => store.ofType(SID, "tool_result") as ToolResultEvent[];
const toolNames = (store: EventStore): string[] => (store.ofType(SID, "request_envelope").at(-1) as RequestEnvelopeEvent).tools.map((t) => t.name);

describe("request_app_connect 发卡（#1666）", () => {
  it("主场私聊、主人亲口：落一条 app_connect offered，工具结果是 appConnectToolText", async () => {
    const store = newStore();
    dmSeed(store);
    const s = openWith(store, { adapter: callsOnce([{ app: "supabase", why: "要建表存订单" }]) });
    await s.say(OWNER, "Stan", "帮我建张表", false, [], undefined, []);
    await s.settled();
    const cs = cards(store);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ phase: "offered", catalogId: "supabase", appName: "Supabase", why: "要建表存订单", reason: "missing", fromAgentId: ADMIN_AGENT_ID, ignorable: true });
    expect(cs[0]!.connectId.length).toBeGreaterThan(0);
    expect(results(store)[0]).toMatchObject({ status: "ok", output: appConnectToolText("Supabase") });
    store.close();
  });

  it("已有开着的卡再调同一个应用：不落第二条，结果说「已经在会话里了」", async () => {
    const store = newStore();
    dmSeed(store);
    const s = openWith(store, { adapter: callsOnce([{ app: "supabase" }, { app: "Supabase" }]) });
    await s.say(OWNER, "Stan", "建表", false, [], undefined, []);
    await s.settled();
    expect(cards(store)).toHaveLength(1);
    expect(results(store)[1]!.output).toContain("已经在会话里了");
    store.close();
  });

  it("每小时最多 3 张：连调 4 个不同应用只落 3 条，第 4 次说「这个小时已经发了 3 张」", async () => {
    const store = newStore();
    dmSeed(store);
    const s = openWith(store, { adapter: callsOnce([{ app: "supabase" }, { app: "github" }, { app: "notion" }, { app: "linear" }]) });
    await s.say(OWNER, "Stan", "都连上", false, [], undefined, []);
    await s.settled();
    expect(cards(store).map((c) => c.catalogId)).toEqual(["supabase", "github", "notion"]);
    expect(results(store)[3]!.output).toContain("这个小时已经发了 3 张");
    store.close();
  });

  it("授权快照里已有 cloud-supabase：不发卡，结果说「已经连上了」", async () => {
    const store = newStore();
    dmSeed(store);
    const fetchImpl = (async () => Response.json({ servers: [{ serverId: "cloud-supabase", toolDefs: [] }] })) as unknown as typeof fetch;
    const s = openWith(store, { adapter: callsOnce([{ app: "supabase" }]), px: { ...basePx, fetchImpl } });
    await s.say(OWNER, "Stan", "建表", false, [], undefined, []);
    await s.settled();
    expect(cards(store)).toHaveLength(0);
    expect(results(store)[0]!.output).toContain("已经连上了");
    store.close();
  });

  it("快照里有 cloud-supabase 但这只的白名单没放它：照样发卡（它手上没那把刀，不能说「直接用」）", async () => {
    const store = newStore();
    dmSeed(store);
    const fetchImpl = (async () => Response.json({ servers: [{ serverId: "cloud-supabase", toolDefs: [] }] })) as unknown as typeof fetch;
    const narrow = { ...OPS, tools: [{ serverId: "cloud-github", tools: [] }] as AgentToolAllow[] };
    const s = openWith(store, { adapter: callsOnce([{ app: "supabase" }]), px: { ...basePx, fetchImpl }, agents: async () => [narrow] });
    await s.say(OWNER, "Stan", "建表", false, [], undefined, []);
    await s.settled();
    expect(cards(store)).toHaveLength(1);
    expect(results(store)[0]!.output).toBe(appConnectToolText("Supabase"));
    store.close();
  });

  it("目录外的应用：工具抛错，不落卡", async () => {
    const store = newStore();
    dmSeed(store);
    const s = openWith(store, { adapter: callsOnce([{ app: "不存在" }]) });
    await s.say(OWNER, "Stan", "x", false, [], undefined, []);
    await s.settled();
    expect(cards(store)).toHaveLength(0);
    expect(results(store)[0]).toMatchObject({ status: "error" });
    store.close();
  });
});

describe("request_app_connect 的挂刀条件（#1666）", () => {
  it("主场私聊里主人亲口那轮：亮着", async () => {
    const store = newStore();
    dmSeed(store);
    const s = openWith(store, { adapter: noop });
    await s.say(OWNER, "Stan", "在吗", false, [], undefined, []);
    await s.settled();
    expect(toolNames(store)).toContain(TOOL);
    store.close();
  });
  it("外联会话：不亮", async () => {
    const store = newStore();
    outreachSeed(store);
    const s = openWith(store, { adapter: noop });
    await s.say(PEER, "小红", "喂", false, [], undefined, []);
    await s.settled();
    expect(toolNames(store)).not.toContain(TOOL);
    store.close();
  });
  it("团队会话（approveAll=false）：不亮", async () => {
    const store = newStore();
    dmSeed(store);
    const s = openWith(store, { adapter: noop, approveAll: false });
    await s.say(OWNER, "Stan", "在吗", false, [], undefined, []);
    await s.settled();
    expect(toolNames(store)).not.toContain(TOOL);
    store.close();
  });
  it("受监督的轮（朋友带话那一轮）：不亮", async () => {
    const store = newStore();
    dmSeed(store);
    const s = openWith(store, { adapter: noop });
    expect(await s.relayFromFriend!({ text: "[系统] 小红让带话" })).toBe("ok");
    await s.settled();
    expect(toolNames(store)).not.toContain(TOOL);
    store.close();
  });
});

describe("连接器 409 needs_login 兜底发卡（#1666）", () => {
  const PX_TOOL = "px_owner_cloud-supabase_list";
  /** grants 回主人自己云箱里的 cloud-supabase；call 回 409 needs_login */
  const needsLoginFetch = (calls: string[]): typeof fetch =>
    (async (url: string) => {
      calls.push(url);
      if (url.includes("/px/v1/grants")) {
        return Response.json({ servers: [{ serverId: "cloud-supabase", toolDefs: [{ name: "list", description: "d", inputSchema: {} }] }] });
      }
      return Response.json({ error: { message: "这个应用要在手机上重新登录", type: "otto_edge", code: "needs_login" } }, { status: 409 });
    }) as unknown as typeof fetch;
  const callsPx = (n: number, toolName: string = PX_TOOL): ModelAdapter => {
    let round = 0;
    return { model: "fake-model", async chat(): Promise<ModelReply> {
      round++;
      return round === 1
        ? { content: "", toolCalls: Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: toolName, args: {} })) }
        : { content: "好的" };
    } };
  };

  it("主人自己云箱的工具回 409 needs_login：落 app_connect offered（reason needs_login），tool_result 说登录过期了；再调一次不重发卡", async () => {
    const store = newStore();
    dmSeed(store);
    const calls: string[] = [];
    const s = openWith(store, { adapter: callsPx(2), px: { ...basePx, fetchImpl: needsLoginFetch(calls) } });
    await s.say(OWNER, "Stan", "查一下库", false, [], undefined, []);
    await s.settled();
    const cs = cards(store);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ phase: "offered", catalogId: "supabase", appName: "Supabase", reason: "needs_login", fromAgentId: ADMIN_AGENT_ID });
    const rs = results(store);
    expect(rs).toHaveLength(2);
    expect(rs[0]).toMatchObject({ status: "error" });
    expect(rs[0]!.output).toBe("Supabase 的登录过期了，已经在会话里请主人重新登录；这一轮别再调它。");
    // 第二次：已有开着的卡 → 模型收到「登录过期了。」+ offerAppConnect 的去重话，不落第二条
    expect(rs[1]!.output).toBe("Supabase 的登录过期了。连 Supabase 的卡已经在会话里了，等主人点。这一轮别再试它。");
    expect(calls.filter((u) => u.includes("/px/v1/call"))).toHaveLength(2);
    store.close();
  });

  it("本小时连接卡已发满 3 张：不再发新卡，模型收到「登录过期了。」+ 封顶话，而不是「已经请主人重新登录」", async () => {
    const store = newStore();
    dmSeed(store);
    let round = 0;
    const adapter: ModelAdapter = { model: "fake-model", async chat(): Promise<ModelReply> {
      round++;
      return round === 1
        ? { content: "", toolCalls: [
            { id: "c1", name: TOOL, args: { app: "github", why: "要用它办事" } },
            { id: "c2", name: TOOL, args: { app: "notion", why: "要用它办事" } },
            { id: "c3", name: TOOL, args: { app: "linear", why: "要用它办事" } },
            { id: "p1", name: PX_TOOL, args: {} },
          ] }
        : { content: "好的" };
    } };
    const s = openWith(store, { adapter, px: { ...basePx, fetchImpl: needsLoginFetch([]) } });
    await s.say(OWNER, "Stan", "都办了", false, [], undefined, []);
    await s.settled();
    expect(cards(store).map((c) => c.catalogId)).toEqual(["github", "notion", "linear"]);
    const out = results(store)[3]!.output;
    expect(out).toContain("Supabase 的登录过期了。");
    expect(out).toContain("这个小时已经发了 3 张");
    expect(out).not.toContain("已经在会话里请主人重新登录");
    store.close();
  });

  it("工具是别人托管的（hostUid ≠ 主人）：不发卡，模型收到 edge 原 message", async () => {
    const store = newStore();
    dmSeed(store);
    const s = openWith(store, {
      adapter: callsPx(1, pxToolName(PEER, "cloud-supabase", "list")),
      px: { ...basePx, fetchImpl: needsLoginFetch([]) },
      hostUids: [PEER],
    });
    await s.say(OWNER, "Stan", "查一下库", false, [], undefined, []);
    await s.settled();
    expect(cards(store)).toHaveLength(0);
    const rs = results(store);
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ status: "error", output: "这个应用要在手机上重新登录" });
    store.close();
  });

  it("受监督的轮（朋友带话那一轮）回 409：不发卡，模型收到 edge 原 message——主人点卡起的会是免审批的主人轮，朋友的请求不能借这一下升级", async () => {
    const store = newStore();
    dmSeed(store);
    const s = openWith(store, { adapter: callsPx(1), px: { ...basePx, fetchImpl: needsLoginFetch([]) }, autoApprove: true });
    expect(await s.relayFromFriend!({ text: "[系统] 小红让带话：帮我查一下库" })).toBe("ok");
    await s.settled();
    expect(store.ofType(SID, "approval_request")).toHaveLength(1); // 确实是受监督轮：连接器要批
    expect(cards(store)).toHaveLength(0);
    const rs = results(store);
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ status: "error", output: "这个应用要在手机上重新登录" });
    store.close();
  });

  it("主人点了正常发出的卡，app_connected 起的那一轮不受监督：连接卡那把刀亮着、连接器不要批", async () => {
    const store = newStore();
    dmSeed(store);
    store.append({
      sessionId: SID, ts: Date.now(), type: "app_connect", connectId: "card-1", phase: "offered", fromAgentId: ADMIN_AGENT_ID,
      catalogId: "supabase", appName: "Supabase", why: "要建表", reason: "missing", ignorable: true,
    });
    const okFetch = (async (url: string) =>
      String(url).includes("/px/v1/grants")
        ? Response.json({ servers: [{ serverId: "cloud-supabase", toolDefs: [{ name: "list", description: "d", inputSchema: {} }] }] })
        : Response.json({ content: [{ type: "text", text: "ok" }] })) as unknown as typeof fetch;
    const s = openWith(store, { adapter: callsPx(1), px: { ...basePx, fetchImpl: okFetch } });
    expect(await s.answerAppConnect("card-1", OWNER, "connected")).toEqual({ ok: true });
    await s.settled();
    expect(toolNames(store)).toContain(TOOL);
    expect(store.ofType(SID, "approval_request")).toHaveLength(0);
    expect(results(store)).toHaveLength(1);
    store.close();
  });

  it("外联会话不挂这个回调：不会走到发卡（不落 app_connect）", async () => {
    const store = newStore();
    outreachSeed(store);
    const s = openWith(store, { adapter: noop, px: { ...basePx, fetchImpl: needsLoginFetch([]) } });
    await s.say(PEER, "小红", "喂", false, [], undefined, []);
    await s.settled();
    expect(cards(store)).toHaveLength(0);
    store.close();
  });
});

describe("主人点连接卡 answerAppConnect（#1666）", () => {
  const CID = "card-1";
  const seedCard = (store: EventStore, fromAgentId: string = ADMIN_AGENT_ID, ts: number = Date.now()): void => {
    store.append({
      sessionId: SID, ts, type: "app_connect", connectId: CID, phase: "offered", fromAgentId,
      catalogId: "supabase", appName: "Supabase", why: "要建表", reason: "missing", ignorable: true,
    });
  };
  /** 每轮把最后一条 user_message 的正文记下来，回一句收口 */
  const recorder = (): { adapter: ModelAdapter; rounds: () => number } => {
    let n = 0;
    return { rounds: () => n, adapter: { model: "fake-model", async chat(): Promise<ModelReply> { n++; return { content: "好的" }; } } };
  };
  const phases = (store: EventStore): string[] => cards(store).map((c) => c.phase);
  const openings = (store: EventStore): UserMessageEvent[] =>
    (store.ofType(SID, "user_message") as UserMessageEvent[]).filter((m) => m.greeting === "app_connected" || m.greeting === "app_declined");

  it("非主人点：拒，日志不变", async () => {
    const store = newStore();
    dmSeed(store);
    seedCard(store);
    const before = store.load(SID).length;
    const s = openWith(store, { adapter: noop });
    expect(await s.answerAppConnect(CID, PEER, "connected")).toEqual({ ok: false, message: "只有他本人能点。" });
    expect(store.load(SID)).toHaveLength(before);
    store.close();
  });

  it("外联会话 / 团队会话（approveAll=false）：同样拒", async () => {
    const store = newStore();
    dmSeed(store);
    seedCard(store);
    const s = openWith(store, { adapter: noop, approveAll: false });
    expect(await s.answerAppConnect(CID, OWNER, "connected")).toEqual({ ok: false, message: "只有他本人能点。" });
    store.close();
    const store2 = newStore();
    outreachSeed(store2);
    seedCard(store2);
    const s2 = openWith(store2, { adapter: noop });
    expect(await s2.answerAppConnect(CID, OWNER, "connected")).toEqual({ ok: false, message: "只有他本人能点。" });
    store2.close();
  });

  it("卡不存在 / 已连 / 已忽略 / 过期：拒「已经用过或过期了」", async () => {
    const store = newStore();
    dmSeed(store);
    seedCard(store, ADMIN_AGENT_ID, 1); // 1970 年发的卡：早过期
    const s = openWith(store, { adapter: noop });
    const used = { ok: false, message: "这张卡已经用过或过期了。" };
    expect(await s.answerAppConnect("nope", OWNER, "connected")).toEqual(used);
    expect(await s.answerAppConnect(CID, OWNER, "connected")).toEqual(used);
    store.close();

    const store2 = newStore();
    dmSeed(store2);
    seedCard(store2);
    const rec = recorder();
    const s2 = openWith(store2, { adapter: rec.adapter });
    expect(await s2.answerAppConnect(CID, OWNER, "dismissed")).toEqual({ ok: true });
    await s2.settled();
    expect(await s2.answerAppConnect(CID, OWNER, "connected")).toEqual(used); // 已忽略
    expect(phases(store2)).toEqual(["offered", "dismissed"]);
    store2.close();

    const store3 = newStore();
    dmSeed(store3);
    seedCard(store3);
    const s3 = openWith(store3, { adapter: recorder().adapter });
    expect(await s3.answerAppConnect(CID, OWNER, "connected")).toEqual({ ok: true });
    await s3.settled();
    expect(await s3.answerAppConnect(CID, OWNER, "dismissed")).toEqual(used); // 已连
    expect(phases(store3)).toEqual(["offered", "connected"]);
    store3.close();
  });

  it("connected：落 connected，紧接 app_connected 开场白（主人亲口、点那只），起一轮", async () => {
    const store = newStore();
    dmSeed(store);
    seedCard(store);
    const rec = recorder();
    const s = openWith(store, { adapter: rec.adapter });
    expect(await s.answerAppConnect(CID, OWNER, "connected")).toEqual({ ok: true });
    await s.settled();
    expect(phases(store)).toEqual(["offered", "connected"]);
    const ops = openings(store);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ greeting: "app_connected", fromUid: OWNER, mentions: [ADMIN_AGENT_ID], content: appConnectedOpening("Supabase") });
    // 先落结局、再落开场白
    expect(cards(store)[1]!.seq).toBeLessThan(ops[0]!.seq);
    expect(rec.rounds()).toBe(1);
    store.close();
  });

  it("connected：清掉授权快照——下一轮重新 fetch grants，刚连上的工具就能挂上", async () => {
    const store = newStore();
    dmSeed(store);
    seedCard(store);
    let grantCalls = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("/px/v1/grants")) grantCalls++;
      return Response.json({ servers: [] });
    }) as unknown as typeof fetch;
    const s = openWith(store, { adapter: recorder().adapter, px: { ...basePx, fetchImpl } });
    await s.say(OWNER, "Stan", "在吗", false, [], undefined, []);
    await s.settled();
    const afterFirst = grantCalls;
    expect(afterFirst).toBeGreaterThan(0);
    // 对照：60s 快照内再说一句，命中缓存，不重新 fetch
    await s.say(OWNER, "Stan", "还在吗", false, [], undefined, []);
    await s.settled();
    expect(grantCalls).toBe(afterFirst);
    // 点「连上了」：快照清掉，开场白那一轮重新 fetch
    expect(await s.answerAppConnect(CID, OWNER, "connected")).toEqual({ ok: true });
    await s.settled();
    expect(grantCalls).toBeGreaterThan(afterFirst);
    store.close();
  });

  it("dismissed：落 dismissed + app_declined 开场白，同样起一轮；grants 不动", async () => {
    const store = newStore();
    dmSeed(store);
    seedCard(store);
    const rec = recorder();
    const s = openWith(store, { adapter: rec.adapter });
    expect(await s.answerAppConnect(CID, OWNER, "dismissed")).toEqual({ ok: true });
    await s.settled();
    expect(phases(store)).toEqual(["offered", "dismissed"]);
    expect(openings(store)[0]).toMatchObject({ greeting: "app_declined", fromUid: OWNER, mentions: [ADMIN_AGENT_ID], content: appDeclinedOpening("Supabase") });
    expect(rec.rounds()).toBe(1);
    store.close();
  });

  it("发卡的那只已不在名单里：仍落结局事件，不写开场白、不起轮", async () => {
    const store = newStore();
    dmSeed(store);
    seedCard(store, "ghost-agent");
    const rec = recorder();
    const s = openWith(store, { adapter: rec.adapter });
    expect(await s.answerAppConnect(CID, OWNER, "connected")).toEqual({ ok: true });
    await s.settled();
    expect(phases(store)).toEqual(["offered", "connected"]);
    expect(openings(store)).toHaveLength(0);
    expect(rec.rounds()).toBe(0);
    store.close();
  });

  it("名单读不出来（degraded）：仍落结局事件，不写开场白、不起轮", async () => {
    const store = newStore();
    dmSeed(store);
    seedCard(store);
    const rec = recorder();
    const s = openWith(store, { adapter: rec.adapter, agents: async () => [{ ...OPS, degraded: true as const }] });
    expect(await s.answerAppConnect(CID, OWNER, "connected")).toEqual({ ok: true });
    await s.settled();
    expect(phases(store)).toEqual(["offered", "connected"]);
    expect(openings(store)).toHaveLength(0);
    expect(rec.rounds()).toBe(0);
    store.close();
  });

  it("连点第二帧：第一帧落了结局就被拒，只起一轮", async () => {
    const store = newStore();
    dmSeed(store);
    seedCard(store);
    const rec = recorder();
    const s = openWith(store, { adapter: rec.adapter });
    const [a, b] = await Promise.all([s.answerAppConnect(CID, OWNER, "connected"), s.answerAppConnect(CID, OWNER, "connected")]);
    await s.settled();
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(phases(store)).toEqual(["offered", "connected"]);
    expect(openings(store)).toHaveLength(1);
    store.close();
  });

  it("归档之后：拒「已经归档了」", async () => {
    const store = newStore();
    dmSeed(store);
    seedCard(store);
    const s = openWith(store, { adapter: noop });
    s.archive("Stan");
    expect(await s.answerAppConnect(CID, OWNER, "connected")).toEqual({ ok: false, message: "这条聊天已经归档了。" });
    store.close();
  });
});
