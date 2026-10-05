// 应用连接卡（#1666）：request_app_connect 在 sessionService 里的挂刀条件、发卡落盘、已连上 / 已有开着的卡 / 每小时上限。
// 装配照 sessionService.friendRelay.test.ts 的 openWith 抄最小一份
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { createCloudSession, type CloudSession, type CloudSessionOpts } from "../../services/runtime/src/sessionService.js";
import { createWikiService, type WikiService } from "../../services/runtime/src/wikiService.js";
import { createMemoryWikiFs } from "../../services/runtime/src/wikiFs.js";
import { createInMemoryWikiJournal } from "../../services/runtime/src/wikiJournal.js";
import { EventStore } from "../../src/session/store.js";
import type { AppConnectEvent, RequestEnvelopeEvent, ToolResultEvent } from "../../src/session/events.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import type { PxCallDeps } from "../../services/runtime/src/pxTools.js";
import type { AgentToolAllow } from "../../src/shared/agentToolAllow.js";
import type { AgentTier } from "../../src/shared/agentTier.js";
import { ADMIN_AGENT_ID } from "../../src/shared/workspaceAgents.js";
import { REQUEST_APP_CONNECT_TOOL_NAME, appConnectToolText } from "../../src/shared/appConnect.js";
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

function openWith(store: EventStore, o: { adapter: ModelAdapter; approveAll?: boolean; px?: PxCallDeps; now?: () => number }): CloudSession {
  return createCloudSession({
    sessionMeta: createInMemoryCloudSessionMeta(),
    workspaceId: "w1", sessionId: SID, ownerUid: OWNER, createdByUid: OWNER, store, world: fakeWorld,
    agents: async () => [OPS], adapterFor: () => o.adapter, px: o.px ?? basePx, hostUids: async () => [OWNER],
    onEvent: () => {},
    onUsage: () => {}, wiki: testWiki(), mentionInbox: createInMemoryMentionInbox(),
    agentWriter: createInMemoryAgentWriter(), isMember: async () => true, contextWindowOf: () => undefined,
    sandboxApproval: async () => "ask", workspaceLock: createWorkspaceLock(), relayRemainingMicro: async () => null,
    diskUsage: () => null, routines: null, onOutreachEnded: null, signSpeechTicket: async () => "t", pairMessages: null,
    outreach: null, approveAll: o.approveAll ?? true, callback: null,
    ...(o.now !== undefined ? { now: o.now } : {}),
  } as CloudSessionOpts);
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
