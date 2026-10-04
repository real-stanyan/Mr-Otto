// 私密车道钉死（#1461 P1，ADR-0346）：主人带进与朋友私聊的智能体住的那条会话。
// 只听主人的、开跑前把私聊最近几句封成信封落进日志（模型看得见的必须落盘）、信封没变不重落、
// 读私聊失败不挡 turn、名单只改智能体那一半、不推回复不回电。装配照 sessionService.outreach.test.ts 抄最小一份。
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { createCloudSession, SayRejectedError, type CloudSession, type CloudSessionOpts } from "../../services/runtime/src/sessionService.js";
import { createWikiService } from "../../services/runtime/src/wikiService.js";
import { createMemoryWikiFs } from "../../services/runtime/src/wikiFs.js";
import { createInMemoryWikiJournal } from "../../services/runtime/src/wikiJournal.js";
import { EventStore } from "../../src/session/store.js";
import type { PairContextLoadedEvent, RequestEnvelopeEvent } from "../../src/session/events.js";
import type { PairMessageRow } from "../../src/shared/pairChat.js";
import type { ModelAdapter } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import type { AgentToolAllow } from "../../src/shared/agentToolAllow.js";
import type { AgentTier } from "../../src/shared/agentTier.js";
import { tempDir } from "../helpers/tempDir.js";
import { createInMemoryAgentWriter } from "../../services/runtime/src/agentRegistry.js";
import { createInMemoryMentionInbox } from "../../services/runtime/src/mentionInbox.js";
import { createWorkspaceLock } from "../../services/runtime/src/workspaceLock.js";
import { createInMemoryCloudSessionMeta } from "../../services/runtime/src/cloudSessionMeta.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const PEER = "22222222-2222-4222-8222-222222222222";
const STRANGER = "33333333-3333-4333-8333-333333333333";
const SID = "s-pair";

const fakeWorld: ExecutionWorld = {
  fs: { read: async (path) => `<content of ${path}>`, write: async () => {} },
  exec: async () => ({ stdout: "hi", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};
// 对外的刀（车道桥 / 打给朋友 / 发私聊）只有 L0 有（#1571，ADR-0367）：这份夹具把助手标成 L0——测的是车道本身，不是等级
const HELPER = { agentId: "a_000000000001", name: "助手", description: "", instructions: "", models: ["fake-model"], tools: [] as AgentToolAllow[], tier: 0 as AgentTier };
const TRANS = { agentId: "a_000000000002", name: "翻译", description: "", instructions: "", models: ["fake-model"], tools: [] as AgentToolAllow[] };
const ADMIN = { agentId: "admin", name: "管理员", description: "", instructions: "", models: ["fake-model"], tools: [] as AgentToolAllow[] };

function newStore(): EventStore {
  return new EventStore(join(tempDir("mrotto-runtime-pair-"), "session.db"));
}

function pairSeed(store: EventStore): void {
  store.append({
    sessionId: SID, ts: 1, type: "session_created", workspace: "/work",
    cloud: { workspaceId: "home", home: true, chat: { kind: "pair" }, pair: { ownerName: "小明", peerUid: PEER, peerName: "小红", facing: "self" } },
  });
  store.append({ sessionId: SID, ts: 2, type: "chat_roster_changed", agents: [{ agentId: HELPER.agentId, name: "助手" }], ignorable: true });
}

const msg = (sender: string, recipient: string, body: string, sec: number): PairMessageRow => ({
  sender, recipient, body, createdAt: new Date(Date.UTC(2026, 9, 4, 0, 0, sec)).toISOString(),
});

function open(store: EventStore, o: { messages?: () => Promise<PairMessageRow[]>; alerts?: string[]; outreach?: CloudSessionOpts["outreach"]; bridge?: CloudSessionOpts["laneBridge"] } = {}): { session: CloudSession; reads: number } {
  const probe = { reads: 0 } as { session: CloudSession; reads: number };
  const adapter: ModelAdapter = { model: "fake-model", async chat() { return { content: "好的" }; } };
  const opts: CloudSessionOpts = {
    sessionMeta: createInMemoryCloudSessionMeta(),
    workspaceId: "home", sessionId: SID, ownerUid: OWNER, createdByUid: OWNER, store, world: fakeWorld,
    agents: async () => [HELPER, TRANS, ADMIN], adapterFor: () => adapter, px: { edgeBase: "https://edge.example", runtimeSecret: "sek" },
    hostUids: async () => [OWNER],
    onEvent: () => {}, onUsage: () => {},
    wiki: createWikiService({ workspaceId: "home", fs: createMemoryWikiFs(), journal: createInMemoryWikiJournal(), legacyMemories: async () => [], agentNames: async () => new Map(), isRunning: async () => true }),
    mentionInbox: createInMemoryMentionInbox(),
    agentWriter: createInMemoryAgentWriter(), isMember: async () => true, contextWindowOf: () => undefined,
    sandboxApproval: async () => "ask", workspaceLock: createWorkspaceLock(), relayRemainingMicro: async () => null,
    diskUsage: () => null, routines: null, onOutreachEnded: null, signSpeechTicket: async () => "t",
    pairMessages: async () => {
      probe.reads++;
      return o.messages ? o.messages() : [msg(PEER, OWNER, "周末去哪", 1), msg(OWNER, PEER, "爬山？", 2)];
    },
    outreach: o.outreach ?? null, laneBridge: o.bridge ?? null, approveAll: true, callback: null,
    ...(o.alerts ? { alert: (uid: string) => void o.alerts!.push(uid) } : {}),
  };
  probe.session = createCloudSession(opts);
  return probe;
}

const say = (s: CloudSession, text: string, mentions: string[], from = OWNER) => s.say(from, "小明", text, true, mentions, undefined, []);

describe("私密车道（#1461 P1）", () => {
  it("开跑前把私聊信封落进日志，而且在请求之前——模型看到的 system 里有它", async () => {
    const store = newStore();
    pairSeed(store);
    const { session } = open(store);
    await say(session, "@助手 帮我想想", [HELPER.agentId]);
    await session.settled();
    const types = store.load(SID).map((e) => e.type);
    expect(types.indexOf("pair_context_loaded")).toBeGreaterThan(-1);
    expect(types.indexOf("pair_context_loaded")).toBeLessThan(types.indexOf("request_envelope"));
    const ctx = store.ofType(SID, "pair_context_loaded")[0] as PairContextLoadedEvent;
    expect(ctx.lines.map((l) => [l.from, l.text])).toEqual([["peer", "周末去哪"], ["owner", "爬山？"]]);
    const env = store.ofType(SID, "request_envelope").at(-1) as RequestEnvelopeEvent;
    expect(env.system).toContain("小红：周末去哪");
    expect(env.system).toContain("看不到你");
    store.close();
  });

  it("私聊没变就不重落一条；变了再落", async () => {
    const store = newStore();
    pairSeed(store);
    let rows = [msg(PEER, OWNER, "a", 1)];
    const { session } = open(store, { messages: async () => rows });
    await say(session, "@助手 一", [HELPER.agentId]);
    await session.settled();
    await say(session, "@助手 二", [HELPER.agentId]);
    await session.settled();
    expect(store.ofType(SID, "pair_context_loaded")).toHaveLength(1);
    rows = [...rows, msg(OWNER, PEER, "b", 2)];
    await say(session, "@助手 三", [HELPER.agentId]);
    await session.settled();
    expect(store.ofType(SID, "pair_context_loaded")).toHaveLength(2);
    store.close();
  });

  it("读私聊失败不挡 turn：这一轮照答，只是不落信封", async () => {
    const store = newStore();
    pairSeed(store);
    const { session } = open(store, { messages: async () => { throw new Error("db down"); } });
    await say(session, "@助手 在吗", [HELPER.agentId]);
    await session.settled();
    expect(store.ofType(SID, "pair_context_loaded")).toEqual([]);
    expect(store.ofType(SID, "assistant_message").length).toBeGreaterThan(0);
    store.close();
  });

  it("只听主人的：别人说话被拒，一个字节都不落", async () => {
    const store = newStore();
    pairSeed(store);
    const { session } = open(store);
    const before = store.load(SID).length;
    await expect(say(session, "@助手 帮我", [HELPER.agentId], PEER)).rejects.toBeInstanceOf(SayRejectedError);
    expect(store.load(SID).length).toBe(before);
    store.close();
  });

  it("chat() 报出 pair 与配对的朋友", () => {
    const store = newStore();
    pairSeed(store);
    const { session } = open(store);
    expect(session.chat()).toEqual({ kind: "pair", agentIds: [HELPER.agentId], humans: [], pair: { peerUid: PEER, facing: "self" } });
    store.close();
  });

  it("名单：带进一只成功；客人名单只能是 [配对的朋友]（公开）或 []（仅我可见），别人进不来（#1523）", async () => {
    const store = newStore();
    pairSeed(store);
    const { session } = open(store);
    const r = await session.updateChatRoster(OWNER, { agentIds: [HELPER.agentId, TRANS.agentId] }, "小明");
    expect(r).toMatchObject({ kind: "ok", changed: true, agentIds: [HELPER.agentId, TRANS.agentId] });
    const r2 = await session.updateChatRoster(OWNER, { humans: [{ uid: PEER, name: "小红" }] }, "小明");
    expect(r2).toMatchObject({ kind: "ok", changed: true, humans: [{ uid: PEER, name: "小红" }] });
    expect(session.chat()?.pair).toEqual({ peerUid: PEER, facing: "both" });
    const r3 = await session.updateChatRoster(OWNER, { humans: [{ uid: PEER, name: "小红" }, { uid: STRANGER, name: "路人" }] }, "小明");
    expect(r3.kind).toBe("not_group");
    const r4 = await session.updateChatRoster(OWNER, { humans: [] }, "小明");
    expect(r4).toMatchObject({ kind: "ok", changed: true, humans: [] });
    expect(session.chat()?.pair).toEqual({ peerUid: PEER, facing: "self" });
    store.close();
  });

  describe("公开车道（#1523，#1461 P2）", () => {
    function sharedSeed(store: EventStore): void {
      store.append({
        sessionId: SID, ts: 1, type: "session_created", workspace: "/work",
        cloud: { workspaceId: "home", home: true, chat: { kind: "pair" }, pair: { ownerName: "小明", peerUid: PEER, peerName: "小红", facing: "both" } },
      });
      store.append({ sessionId: SID, ts: 2, type: "chat_roster_changed", agents: [{ agentId: HELPER.agentId, name: "助手" }], humans: [{ uid: PEER, name: "小红" }], ignorable: true });
    }
    it("代办入口（#1564，ADR-0363）：名单里有管理员时，客人点谁都落给管理员、客人开的通话只拉管理员；主人点谁还是谁；没管理员的老车道原样", async () => {
      const store = newStore();
      store.append({
        sessionId: SID, ts: 1, type: "session_created", workspace: "/work",
        cloud: { workspaceId: "home", home: true, chat: { kind: "pair" }, pair: { ownerName: "小明", peerUid: PEER, peerName: "小红", facing: "both" } },
      });
      store.append({ sessionId: SID, ts: 2, type: "chat_roster_changed", agents: [{ agentId: "admin", name: "管理员" }, { agentId: HELPER.agentId, name: "助手" }], humans: [{ uid: PEER, name: "小红" }], ignorable: true });
      const { session } = open(store);
      await say(session, "@助手 帮我查个东西", [HELPER.agentId], PEER);
      await session.settled();
      const guestOpening = store.ofType(SID, "user_message").filter((e) => e.type === "user_message" && e.fromUid === PEER).at(-1) as { mentions?: string[] };
      expect(guestOpening.mentions).toEqual(["admin"]);
      expect(await session.setVoiceCall(PEER, "小红", [HELPER.agentId])).toEqual({ kind: "ok" });
      const call = store.ofType(SID, "voice_call_changed").at(-1) as { participants: { agentId: string }[] };
      expect(call.participants.map((p) => p.agentId)).toEqual(["admin"]);
      await session.setVoiceCall(PEER, "小红", []);
      await session.settled();
      await say(session, "@助手 你来", [HELPER.agentId]);
      await session.settled();
      const ownerOpening = store.ofType(SID, "user_message").filter((e) => e.type === "user_message" && e.fromUid === OWNER && e.greeting === undefined).at(-1) as { mentions?: string[] };
      expect(ownerOpening.mentions).toEqual([HELPER.agentId]);
      store.close();
      // 老车道（名单里还没有管理员）：客人点的名原样，不能让朋友一句话都发不出去
      const old = newStore();
      sharedSeed(old);
      const o = open(old);
      await say(o.session, "@助手 在吗", [HELPER.agentId], PEER);
      await o.session.settled();
      const legacy = old.ofType(SID, "user_message").filter((e) => e.type === "user_message" && e.fromUid === PEER).at(-1) as { mentions?: string[] };
      expect(legacy.mentions).toEqual([HELPER.agentId]);
      old.close();
    });
    it("朋友（客人）能说、能点起一轮；路人仍被拒", async () => {
      const store = newStore();
      sharedSeed(store);
      const { session } = open(store);
      expect(session.isGuest(PEER)).toBe(true);
      await say(session, "@助手 帮我们想想", [HELPER.agentId], PEER);
      await session.settled();
      expect(store.ofType(SID, "assistant_message").length).toBeGreaterThan(0);
      await expect(say(session, "@助手 x", [HELPER.agentId], STRANGER)).rejects.toBeInstanceOf(SayRejectedError);
      store.close();
    });
    it("提示词说公开那一版：朋友看得到你、朋友点起的轮要等主人批；信封头不再说「看不到你」", async () => {
      const store = newStore();
      sharedSeed(store);
      const { session } = open(store);
      await say(session, "@助手 在吗", [HELPER.agentId]);
      await session.settled();
      const env = store.ofType(SID, "request_envelope").at(-1) as RequestEnvelopeEvent;
      expect(env.system).toContain("也看得到你说的话");
      expect(env.system).toContain("都要等群主批");
      expect(env.system).not.toContain("看不到你");
      store.close();
    });
    it("朋友（客人）打给公开智能体、挂了 → 替主人落一条 pair_call_summary 开场白，那一轮它总结给主人（#1533）；主人自己开的通话不落", async () => {
      const store = newStore();
      sharedSeed(store);
      const { session } = open(store);
      expect(await session.setVoiceCall(PEER, "小红", [HELPER.agentId])).toEqual({ kind: "ok" });
      expect(session.callStarter?.()).toBe(PEER);
      await session.settled();
      // 电话里朋友说的话要随总结的开场白一起给它（#1550）
      await session.say(PEER, "小红", "周五帮我看看仓库的账", true, [HELPER.agentId]);
      await session.settled();
      expect(await session.setVoiceCall(PEER, "小红", [])).toEqual({ kind: "ok" });
      await session.settled();
      const openings = store.ofType(SID, "user_message").filter((e) => e.type === "user_message" && e.greeting === "pair_call_summary");
      expect(openings).toHaveLength(1);
      expect(openings[0]).toMatchObject({ fromUid: OWNER, mentions: [HELPER.agentId] });
      expect((openings[0] as { content: string }).content).toContain("小红");
      expect((openings[0] as { content: string }).content).toContain("电话里的记录：");
      expect((openings[0] as { content: string }).content).toContain("小红：周五帮我看看仓库的账");
      expect(store.ofType(SID, "assistant_message").length).toBeGreaterThan(0);
      // 主人自己开、自己挂：不落总结
      const before = store.ofType(SID, "user_message").length;
      await session.setVoiceCall(OWNER, "小明", [HELPER.agentId]);
      await session.settled();
      await session.setVoiceCall(OWNER, "小明", []);
      await session.settled();
      const after = store.ofType(SID, "user_message").filter((e) => e.type === "user_message" && e.greeting === "pair_call_summary");
      expect(after).toHaveLength(1);
      expect(store.ofType(SID, "user_message").length).toBeGreaterThanOrEqual(before);
      store.close();
    });
    it("message_friend_agent（#1542）：公开车道 + 接了 laneBridge 才挂；客人点起的轮里也不要批；发出去带这一轮的深度", async () => {
      const store = newStore();
      sharedSeed(store);
      const sends: unknown[] = [];
      const { session } = open(store, { bridge: { send: async (o) => { sends.push(o); return "已发"; } } });
      await say(session, "@助手 在吗", [HELPER.agentId], PEER);
      await session.settled();
      const env = store.ofType(SID, "request_envelope").at(-1) as RequestEnvelopeEvent;
      const tool = env.tools.find((t) => t.name === "message_friend_agent");
      expect(tool).toBeDefined();
      expect(env.system).toContain("message_friend_agent");
      // 跨主场协作（#1578）：同一条件下 invite_collaborator 也挂着（只有 L0 有，HELPER 标的是 L0；提示词那段按 agentId 认
      // 管理员，HELPER 不是 admin 所以这里不验 system）
      expect(env.tools.find((t) => t.name === "invite_collaborator")).toBeDefined();
      store.close();
    });
    it("私密车道（没有朋友在名单里）不挂 message_friend_agent；没接 laneBridge 也不挂", async () => {
      const store = newStore();
      pairSeed(store);
      const { session } = open(store, { bridge: { send: async () => "x" } });
      await say(session, "@助手 在吗", [HELPER.agentId]);
      await session.settled();
      const env = store.ofType(SID, "request_envelope").at(-1) as RequestEnvelopeEvent;
      expect(env.tools.map((t) => t.name)).not.toContain("message_friend_agent");
      store.close();
    });
    it("say 的 relay 记号落进 user_message（对面车道发来的那句）", async () => {
      const store = newStore();
      sharedSeed(store);
      const { session } = open(store);
      await session.say(PEER, "管理员（小红 的智能体）", "能借 100 吗", true, [HELPER.agentId], undefined, [], undefined, undefined, { fromAgentId: "a_0000000000b1", depth: 1 });
      await session.settled();
      const opening = store.ofType(SID, "user_message").find((e) => e.type === "user_message" && e.relay !== undefined);
      expect(opening).toMatchObject({ fromUid: PEER, relay: { fromAgentId: "a_0000000000b1", depth: 1 } });
      store.close();
    });
    it("chat() 从名单推朝向：有朋友 = both", () => {
      const store = newStore();
      sharedSeed(store);
      const { session } = open(store);
      expect(session.chat()).toEqual({ kind: "pair", agentIds: [HELPER.agentId], humans: [{ uid: PEER, name: "小红" }], pair: { peerUid: PEER, facing: "both" } });
      store.close();
    });
  });

  it("车道里不挂 call_friend：提示词说「你发不了消息给朋友」，工具表必须说同一句话（#1206；复审 M3）", async () => {
    const store = newStore();
    pairSeed(store);
    const { session } = open(store, { outreach: { dispatch: async () => "打了", dialPicked: async () => null } });
    await say(session, "@助手 帮我问问", [HELPER.agentId]);
    await session.settled();
    const env = store.ofType(SID, "request_envelope").at(-1) as RequestEnvelopeEvent;
    expect(env.tools.length).toBeGreaterThan(0); // 不是空转：别的刀照挂
    expect(env.tools.map((t) => t.name)).not.toContain("call_friend");
    expect(env.system).toContain("发不了消息给");
    // 选人卡的收口同一条件（#1520）：车道里就算有人伪造 pick_friend 也不认
    session.logFriendPick({ pickId: "p1", phase: "offered", fromAgentId: HELPER.agentId, question: "q", candidates: [{ uid: "u1", name: "小红", why: "" }, { uid: "u2", name: "小明", why: "" }], brief: "b", opening: "o" });
    expect(await session.pickFriend("p1", OWNER, "u1")).toEqual({ ok: false, message: "只有他本人能选。" });
    store.close();
  });

  it("不推回复：车道里智能体答完不发推送", async () => {
    const store = newStore();
    pairSeed(store);
    const alerts: string[] = [];
    const { session } = open(store, { alerts });
    await say(session, "@助手 在吗", [HELPER.agentId]);
    await session.settled();
    expect(alerts).toEqual([]);
    store.close();
  });
});
