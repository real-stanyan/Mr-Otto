// 朋友在外联里托管理员带话、主人回话送回（#1655）：sessionService 的挂刀、两个落开场白的方法、监督。
// 装配照 sessionService.outreach.test.ts 顶部抄最小一份。夹具里唯一那只智能体的 agentId 是 ADMIN_AGENT_ID
// （名字仍叫「运维」、tier 0）：relayFromFriend 点的是 ADMIN_AGENT_ID，名单里得有它。
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { createCloudSession, type CloudSession, type CloudSessionOpts } from "../../services/runtime/src/sessionService.js";
import { createWikiService, type WikiService } from "../../services/runtime/src/wikiService.js";
import { createMemoryWikiFs } from "../../services/runtime/src/wikiFs.js";
import { createInMemoryWikiJournal } from "../../services/runtime/src/wikiJournal.js";
import { EventStore } from "../../src/session/store.js";
import type { ApprovalRequestEvent, RequestEnvelopeEvent, SessionEvent, UserMessageEvent } from "../../src/session/events.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import type { PxCallDeps } from "../../services/runtime/src/pxTools.js";
import type { AgentToolAllow } from "../../src/shared/agentToolAllow.js";
import type { AgentTier } from "../../src/shared/agentTier.js";
import { ADMIN_AGENT_ID } from "../../src/shared/workspaceAgents.js";
import { tempDir } from "../helpers/tempDir.js";
import { createInMemoryAgentWriter } from "../../services/runtime/src/agentRegistry.js";
import { createInMemoryMentionInbox } from "../../services/runtime/src/mentionInbox.js";
import { createWorkspaceLock } from "../../services/runtime/src/workspaceLock.js";
import { createInMemoryCloudSessionMeta } from "../../services/runtime/src/cloudSessionMeta.js";

const OWNER = "owner";
const PEER = "peer-1";
const SID = "s1";

const fakeWorld: ExecutionWorld = {
  fs: { read: async (path) => `<content of ${path}>`, write: async () => {} },
  exec: async () => ({ stdout: "hi", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};
const px: PxCallDeps = { edgeBase: "https://edge.example", runtimeSecret: "sek" };
// 外联里只有 L0 才挂 relay_to_owner：这份夹具把管理员标成 tier 0
const OPS = { agentId: ADMIN_AGENT_ID, name: "运维", description: "", instructions: "", models: ["fake-model"], tools: [] as AgentToolAllow[], tier: 0 as AgentTier };

function newStore(): EventStore {
  return new EventStore(join(tempDir("mrotto-runtime-friendrelay-"), "session.db"));
}

function testWiki(): WikiService {
  return createWikiService({ workspaceId: "w1", fs: createMemoryWikiFs(), journal: createInMemoryWikiJournal(), legacyMemories: async () => [], agentNames: async () => new Map(), isRunning: async () => true });
}

/** 一条外联会话的种子：session_created（outreach 事实）+ 名单（一只智能体 + 朋友一个客人）；没在通话：朋友打字 */
function outreachSeed(store: EventStore, o: { started?: boolean } = {}): void {
  store.append({
    sessionId: SID, ts: 1, type: "session_created", workspace: "/work",
    cloud: { workspaceId: "w1", home: true, chat: { kind: "outreach" }, outreach: { ownerName: "Stan", peerUid: PEER, peerName: "小红" } },
  });
  store.append({
    sessionId: SID, ts: 2, type: "chat_roster_changed", agents: [{ agentId: ADMIN_AGENT_ID, name: "运维" }],
    humans: [{ uid: PEER, name: "小红" }], ignorable: true,
  });
  // 通话进行中（outreach 折叠里有 phase=started）：朋友是在电话里听着
  if (o.started === true) {
    store.append({ sessionId: SID, ts: 3, type: "outreach", phase: "started", outreachId: "o1", fromAgentId: ADMIN_AGENT_ID, peerUid: PEER, peerName: "小红", ignorable: true });
  }
}

const dmSeed = (store: EventStore): void => {
  store.append({ sessionId: SID, ts: 1, type: "session_created", workspace: "/work", cloud: { workspaceId: "w1", home: true, chat: { kind: "dm" } } });
  store.append({ sessionId: SID, ts: 2, type: "chat_roster_changed", agents: [{ agentId: ADMIN_AGENT_ID, name: "运维" }], humans: [], ignorable: true });
};

function lastEnvelope(store: EventStore): RequestEnvelopeEvent {
  const all = store.ofType(SID, "request_envelope");
  expect(all.length).toBeGreaterThan(0);
  return all.at(-1) as RequestEnvelopeEvent;
}

function openWith(store: EventStore, o: {
  adapter?: ModelAdapter;
  outreachRelay?: CloudSessionOpts["outreachRelay"];
  friendReply?: CloudSessionOpts["friendReply"];
  events?: SessionEvent[];
  /** 审批卡一落就由主人批掉（受监督的轮里 read_file 会弹卡，不批 settled() 会等到超时） */
  autoApprove?: boolean;
  alert?: CloudSessionOpts["alert"];
  /** 缺席 = true（主场）；false = 团队工作区 */
  approveAll?: boolean;
}): CloudSession {
  const adapter = o.adapter ?? { model: "fake-model", async chat() { return { content: "好" }; } };
  let s!: CloudSession;
  s = createCloudSession({
    sessionMeta: createInMemoryCloudSessionMeta(),
    workspaceId: "w1", sessionId: SID, ownerUid: OWNER, createdByUid: OWNER, store, world: fakeWorld,
    agents: async () => [OPS], adapterFor: () => adapter, px, hostUids: async () => [OWNER],
    onEvent: (e) => {
      o.events?.push(e);
      if (o.autoApprove === true && e.type === "approval_request") void s.approve((e as ApprovalRequestEvent).callId, OWNER, "Stan", "approved");
    },
    ...(o.alert !== undefined ? { alert: o.alert } : {}),
    onUsage: () => {}, wiki: testWiki(), mentionInbox: createInMemoryMentionInbox(),
    agentWriter: createInMemoryAgentWriter(), isMember: async () => true, contextWindowOf: () => undefined,
    sandboxApproval: async () => "ask", workspaceLock: createWorkspaceLock(), relayRemainingMicro: async () => null,
    diskUsage: () => null, routines: null, onOutreachEnded: null, signSpeechTicket: async () => "t", pairMessages: null,
    outreach: null, approveAll: o.approveAll ?? true, callback: null,
    ...(o.outreachRelay !== undefined ? { outreachRelay: o.outreachRelay } : {}),
    ...(o.friendReply !== undefined ? { friendReply: o.friendReply } : {}),
  });
  return s;
}

/** 第一轮调一把刀，之后说一句收口 */
function toolOnce(name: string, args: Record<string, unknown>): ModelAdapter {
  let round = 0;
  return { model: "fake-model", async chat(): Promise<ModelReply> {
    round++;
    return round === 1 ? { content: "", toolCalls: [{ id: "c1", name, args }] } : { content: "好的" };
  } };
}

describe("relay_to_owner 在外联里（#1655）", () => {
  it("只在外联、端口接了时挂；朋友点起的轮里不掀审批；send 收到朋友名与正文", async () => {
    const store = newStore();
    outreachSeed(store);
    const sent: unknown[] = [];
    const events: SessionEvent[] = [];
    const s = openWith(store, {
      events, adapter: toolOnce("relay_to_owner", { text: "周五借车行吗" }),
      outreachRelay: { toOwner: async (o) => (sent.push(o), "已经带给 Stan 了") },
    });
    await s.say(PEER, "小红", "帮我问下 Stan 周五借车行吗", false, [], undefined, []);
    await s.settled();
    expect(lastEnvelope(store).tools.map((t) => t.name)).toEqual(["relay_to_owner"]);
    expect(events.filter((e) => e.type === "approval_request")).toHaveLength(0);
    expect(sent).toEqual([{ agentName: "运维", peerUid: PEER, peerName: "小红", text: "周五借车行吗" }]);
    store.close();
  });
  it("端口没接：外联工具表照旧是空的", async () => {
    const store = newStore();
    outreachSeed(store);
    const s = openWith(store, {});
    await s.say(PEER, "小红", "喂", false, [], undefined, []);
    await s.settled();
    expect(lastEnvelope(store).tools).toEqual([]);
    store.close();
  });
  it("主场私聊里不挂 relay_to_owner", async () => {
    const store = newStore();
    dmSeed(store);
    const s = openWith(store, { outreachRelay: { toOwner: async () => "x" } });
    await s.say(OWNER, "Stan", "在吗", false, [], undefined, []);
    await s.settled();
    expect(lastEnvelope(store).tools.map((t) => t.name)).not.toContain("relay_to_owner");
    store.close();
  });
});

describe("relayFromFriend：落在管理员私聊（#1655）", () => {
  it("落 user_message{greeting:friend_relay, fromUid: owner, mentions:[admin 那只]} 并起一轮；那一轮受监督（read_file 要批）", async () => {
    const store = newStore();
    dmSeed(store);
    const events: SessionEvent[] = [];
    const s = openWith(store, { events, autoApprove: true, adapter: toolOnce("read_file", { path: "/work/a.txt" }) });
    expect(await s.relayFromFriend!({ text: "[系统] 小红让带话" })).toBe("ok");
    await s.settled();
    const opening = (store.ofType(SID, "user_message") as UserMessageEvent[]).at(-1)!;
    expect(opening).toMatchObject({ greeting: "friend_relay", fromUid: OWNER, content: "[系统] 小红让带话" });
    expect(events.filter((e) => e.type === "approval_request")).toHaveLength(1);
    store.close();
  });
  it("团队工作区（approveAll=false）里的私聊上调：archived，一个事件都不落——带话只落主场", async () => {
    const store = newStore();
    dmSeed(store);
    const s = openWith(store, { approveAll: false });
    const before = store.load(SID).length;
    expect(await s.relayFromFriend!({ text: "[系统] 小红让带话" })).toBe("archived");
    await s.settled();
    expect(store.load(SID).length).toBe(before);
    store.close();
  });
  it("在外联会话上调：archived，一个事件都不落", async () => {
    const store = newStore();
    outreachSeed(store);
    const s = openWith(store, {});
    const before = store.load(SID).length;
    expect(await s.relayFromFriend!({ text: "x" })).toBe("archived");
    expect(store.load(SID).length).toBe(before);
    store.close();
  });
});

describe("reply_to_friend 与 ownerReply（#1655）", () => {
  it("主人亲口的一轮：reply_to_friend 亮着、dispatch 拿到参数", async () => {
    const store = newStore();
    dmSeed(store);
    const got: unknown[] = [];
    const s = openWith(store, {
      adapter: toolOnce("reply_to_friend", { friend: "小红", text: "行" }),
      friendReply: { send: async (o) => (got.push(o), "已经送到") },
    });
    await s.say(OWNER, "Stan", "告诉小红行", false, [], undefined, []);
    await s.settled();
    expect(got).toEqual([{ agentId: ADMIN_AGENT_ID, agentName: "运维", friend: "小红", text: "行" }]);
    store.close();
  });
  it("带话那一轮（friend_relay 起的、受监督）：reply_to_friend 不亮", async () => {
    const store = newStore();
    dmSeed(store);
    const s = openWith(store, { friendReply: { send: async () => "x" } });
    await s.relayFromFriend!({ text: "[系统] 小红让带话" });
    await s.settled();
    expect(lastEnvelope(store).tools.map((t) => t.name)).not.toContain("reply_to_friend");
    store.close();
  });
  it("ownerReply：外联里落 owner_reply 开场白（fromUid 主人、点那只）并起一轮；非外联回 archived", async () => {
    const store = newStore();
    outreachSeed(store);
    const s = openWith(store, {});
    expect(await s.ownerReply!({ text: "[系统] Stan 回：行" })).toBe("ok");
    await s.settled();
    expect((store.ofType(SID, "user_message") as UserMessageEvent[]).at(-1)).toMatchObject({ greeting: "owner_reply", fromUid: OWNER, mentions: [ADMIN_AGENT_ID] });
    expect(store.ofType(SID, "assistant_message")).toHaveLength(1);
    store.close();
    const store2 = newStore();
    dmSeed(store2);
    expect(await openWith(store2, {}).ownerReply!({ text: "x" })).toBe("archived");
    store2.close();
  });
});

describe("外联的推送（#1655）", () => {
  it("朋友打字：答完推给朋友（目标是 outreach）；主人回话起的那轮：也推给朋友、不推主人", async () => {
    const store = newStore();
    outreachSeed(store);
    const pushes: { uid: string; target: unknown }[] = [];
    const s = openWith(store, { alert: (uid, _k, p) => pushes.push({ uid, target: p.target }) });
    await s.say(PEER, "小红", "在吗", false, [], undefined, []);
    await s.settled();
    await s.ownerReply!({ text: "[系统] Stan 回：行" });
    await s.settled();
    expect(pushes.map((p) => p.uid)).toEqual([PEER, PEER]);
    expect(pushes[0]!.target).toMatchObject({ kind: "cloud", chat: "outreach", workspaceId: "w1", sessionId: SID });
    store.close();
  });
  it("通话进行中：不推（人正在听）", async () => {
    const store = newStore();
    outreachSeed(store, { started: true });
    const pushes: string[] = [];
    const s = openWith(store, { alert: (uid) => pushes.push(uid) });
    await s.say(PEER, "小红", "喂", false, [], undefined, []);
    await s.settled();
    expect(store.ofType(SID, "assistant_message")).toHaveLength(1); // 确实答了，只是没推
    expect(pushes).toEqual([]);
    store.close();
  });
});
