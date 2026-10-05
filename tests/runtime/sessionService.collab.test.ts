// 管理员车道（#1605 第 1 期 b）在 runtime 里的样子。钉的是：
// B 家：请求镜像进来 → 主人接 = 主人自己点起的一轮（提示词带原话 / 说明 / 结果）、回复送回 A；不接 / 过期 = 只落决定；
//       对面主人本人在这里说不了话；接了之后对面管理员接力进来的那一轮不是客人轮。
// A 家：invite_collaborator 落 collab_request（quote.ownerLine 是主人点起任务之前那句原话）+ task_collab，送到桥；
//       决定回来折进任务的协作者状态；回复回来以接力棒落下并起管理员的一轮。
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { createCloudSession, type AdminsBridge, type CloudSession, type CloudSessionOpts } from "../../services/runtime/src/sessionService.js";
import { createWikiService, type WikiService } from "../../services/runtime/src/wikiService.js";
import { createMemoryWikiFs } from "../../services/runtime/src/wikiFs.js";
import { createInMemoryWikiJournal } from "../../services/runtime/src/wikiJournal.js";
import { EventStore } from "../../src/session/store.js";
import type { CollabDecisionEvent, CollabRequestEvent, SessionEvent, UserMessageEvent } from "../../src/session/events.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import type { PxCallDeps } from "../../services/runtime/src/pxTools.js";
import type { AgentToolAllow } from "../../src/shared/agentToolAllow.js";
import type { AgentTier } from "../../src/shared/agentTier.js";
import { tempDir } from "../helpers/tempDir.js";
import { createInMemoryAgentWriter } from "../../services/runtime/src/agentRegistry.js";
import { createInMemoryMentionInbox } from "../../services/runtime/src/mentionInbox.js";
import { createWorkspaceLock } from "../../services/runtime/src/workspaceLock.js";
import { createInMemoryCloudSessionMeta } from "../../services/runtime/src/cloudSessionMeta.js";
import { taskFoldOf } from "../../src/shared/tasks.js";

const fakeWorld: ExecutionWorld = {
  fs: { read: async (path) => `<content of ${path}>`, write: async () => {} },
  exec: async () => ({ stdout: "hi", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};
const px: PxCallDeps = { edgeBase: "https://edge.example", runtimeSecret: "sek" };
const ADMIN = { agentId: "admin", name: "峰哥", description: "", instructions: "", models: ["m"], tools: [] as AgentToolAllow[], tier: 0 as AgentTier, domain: "admin" };

function newStore(): EventStore {
  return new EventStore(join(tempDir("mrotto-runtime-collab-"), "session.db"));
}
function testWiki(): WikiService {
  return createWikiService({ workspaceId: "w1", fs: createMemoryWikiFs(), journal: createInMemoryWikiJournal(), legacyMemories: async () => [], agentNames: async () => new Map(), isRunning: async () => true });
}
function bridgeStub() {
  const back: Parameters<AdminsBridge["deliverBack"]>[0][] = [];
  const requests: Parameters<AdminsBridge["deliverRequest"]>[0][] = [];
  const bridge: AdminsBridge = {
    async deliverRequest(o) { requests.push(o); return null; },
    async deliverBack(o) { back.push(o); },
  };
  return { bridge, back, requests };
}
const REQUEST: CollabRequestEvent = {
  sessionId: "a-task", seq: 9, ts: 9, type: "collab_request", requestId: "r_1", taskId: "t_1", title: "看 9 月营业额", fromUid: "u_a", fromAgentName: "雨姐",
  quote: { ownerName: "继爸", ownerLine: "@我的管理员 带上 Stan 的管理员去看营业额", note: "只要总数" }, result: "9 月 $78,807", expiresTs: Date.now() + 3_600_000,
  byAgentId: "admin", ignorable: true, origin: { workspaceId: "wa", sessionId: "a-task" },
};

/** B 家的管理员车道：主人 Stan（owner），客人 = 继爸（u_a） */
function openAdmins(store: EventStore, o: {
  reply?: (tools: string[], transcript: string) => ModelReply;
  bridge?: AdminsBridge;
  timers?: { fns: (() => void)[] };
  events?: SessionEvent[];
  alerts?: unknown[][];
}): CloudSession {
  store.append({ sessionId: "s1", ts: 1, type: "session_created", workspace: "/work", cloud: { workspaceId: "w1", chat: { kind: "admins" }, admins: { ownerName: "Stan Yan", peerUid: "u_a", peerName: "继爸" }, home: true } });
  store.append({ sessionId: "s1", ts: 2, type: "chat_roster_changed", ignorable: true, agents: [{ agentId: "admin", name: "峰哥" }], humans: [{ uid: "u_a", name: "继爸" }] });
  return createCloudSession({
    diskUsage: () => null, routines: null, onOutreachEnded: null, signSpeechTicket: async () => "t", pairMessages: null, outreach: null, callback: null,
    approveAll: true, sessionMeta: createInMemoryCloudSessionMeta(),
    workspaceId: "w1", sessionId: "s1", ownerUid: "owner", createdByUid: "owner",
    store, world: fakeWorld, px, hostUids: async () => ["owner"],
    agents: async () => [ADMIN],
    adapterFor: (): ModelAdapter => ({
      model: "m",
      async chat(messages, tools): Promise<ModelReply> {
        return o.reply?.((tools ?? []).map((t) => t.name), JSON.stringify(messages)) ?? { content: "峰哥答" };
      },
    }),
    onEvent: (e) => o.events?.push(e), onUsage: () => {}, wiki: testWiki(), mentionInbox: createInMemoryMentionInbox(), agentWriter: createInMemoryAgentWriter(),
    isMember: async () => true, contextWindowOf: () => undefined, sandboxApproval: async () => "ask", workspaceLock: createWorkspaceLock(), relayRemainingMicro: async () => null,
    ...(o.bridge === undefined ? {} : { adminsBridge: o.bridge }),
    ...(o.alerts === undefined ? {} : { alert: (...a: unknown[]) => void o.alerts!.push(a) }),
    ...(o.timers === undefined ? {} : { ringTimers: { setTimer: (fn: () => void) => { o.timers!.fns.push(fn); return o.timers!.fns.length; }, clearTimer: () => {} } }),
  });
}

describe("B 家的管理员车道", () => {
  it("请求镜像进来；主人接 = 自己点起的一轮（开场白带原话 / 说明 / 结果）；回复送回 A；决定也送回 A", async () => {
    const store = newStore();
    const b = bridgeStub();
    const seen: string[] = [];
    const s = openAdmins(store, { bridge: b.bridge, reply: (_tools, transcript) => { seen.push(transcript); return { content: "行，9 月对得上。" }; } });
    s.receiveCollabRequest(REQUEST);
    s.receiveCollabRequest(REQUEST); // 重复的不落
    expect(store.load("s1").filter((e) => e.type === "collab_request")).toHaveLength(1);
    expect(await s.decideCollab("r_1", "owner", "accepted")).toEqual({ ok: true });
    await s.settled();
    const log = store.load("s1");
    expect(log.find((e) => e.type === "collab_decision")).toMatchObject({ requestId: "r_1", decision: "accepted", byUid: "owner" });
    const opening = log.find((e): e is UserMessageEvent => e.type === "user_message" && e.greeting === "collab_accept")!;
    expect(opening.fromUid).toBe("owner");
    expect(opening.content).toContain("继爸 的管理员「雨姐」");
    expect(opening.content).toContain("只要总数");
    expect(seen.at(-1)).toContain("带上 Stan 的管理员去看营业额");
    expect(b.back.map((x) => (x.event !== undefined ? "decision" : "reply"))).toEqual(["decision", "reply"]);
    expect(b.back[1]!.reply).toMatchObject({ text: "行，9 月对得上。", fromAgentId: "admin", fromAgentName: "峰哥" });
    expect(b.back[1]!.origin).toEqual({ workspaceId: "wa", sessionId: "a-task" });
    store.close();
  });
  it("不是主人不能点；不接只落决定、不起轮；答过的不能再答；不在管理员车道里没有这回事", async () => {
    const store = newStore();
    const seen: string[] = [];
    const s = openAdmins(store, { reply: () => { seen.push("ran"); return { content: "x" }; } });
    s.receiveCollabRequest(REQUEST);
    expect(await s.decideCollab("r_1", "u_a", "accepted")).toEqual({ ok: false, message: "只有主人能点" });
    expect(await s.decideCollab("nope", "owner", "accepted")).toMatchObject({ ok: false });
    expect(await s.decideCollab("r_1", "owner", "declined")).toEqual({ ok: true });
    await s.settled();
    expect(seen).toEqual([]);
    expect(await s.decideCollab("r_1", "owner", "accepted")).toEqual({ ok: false, message: "已经答过了" });
    store.close();
  });
  it("24 小时没回：到点落 expired；之后点不了；重启后从日志补上表", async () => {
    const store = newStore();
    const timers = { fns: [] as (() => void)[] };
    const s = openAdmins(store, { timers });
    s.receiveCollabRequest(REQUEST);
    expect(timers.fns).toHaveLength(1);
    timers.fns[0]!();
    expect(store.load("s1").find((e) => e.type === "collab_decision")).toMatchObject({ requestId: "r_1", decision: "expired", byUid: null });
    expect(await s.decideCollab("r_1", "owner", "accepted")).toEqual({ ok: false, message: "这条已经过期了" });
    store.close();
    // 重启：日志里有请求没决定 → 重新上表
    const store2 = newStore();
    const t2 = { fns: [] as (() => void)[] };
    store2.append({ ...REQUEST, sessionId: "s1", ts: 3 } as SessionEvent);
    openAdmins(store2, { timers: t2 });
    expect(t2.fns).toHaveLength(1);
    store2.close();
  });
  it("对面主人本人在这里说不了话；主人自己能说", async () => {
    const store = newStore();
    const s = openAdmins(store, {});
    await expect(s.say("u_a", "继爸", "我来说一句", true, ["admin"])).rejects.toThrow("只有两家管理员说话");
    await s.say("owner", "Stan Yan", "@峰哥 在吗", true, ["admin"]);
    await s.settled();
    expect(store.load("s1").some((e) => e.type === "assistant_message")).toBe(true);
    store.close();
  });
});

describe("A 家：invite_collaborator 的落点", () => {
  const TRAVEL_ADMIN = { ...ADMIN, name: "雨姐" };
  function openPair(store: EventStore, o: { bridge: AdminsBridge; reply: (tools: string[], transcript: string) => ModelReply; events?: SessionEvent[] }): CloudSession {
    store.append({ sessionId: "s1", ts: 1, type: "session_created", workspace: "/work", cloud: { workspaceId: "wa", chat: { kind: "pair" }, pair: { ownerName: "继爸", peerUid: "u_b", peerName: "Stan Yan", facing: "self" }, home: true } });
    store.append({ sessionId: "s1", ts: 2, type: "chat_roster_changed", ignorable: true, agents: [{ agentId: "admin", name: "雨姐" }] });
    return createCloudSession({
      diskUsage: () => null, routines: null, onOutreachEnded: null, signSpeechTicket: async () => "t", pairMessages: null, outreach: null, callback: null,
      approveAll: true, sessionMeta: createInMemoryCloudSessionMeta(),
      workspaceId: "wa", sessionId: "s1", ownerUid: "u_a", createdByUid: "u_a",
      store, world: fakeWorld, px, hostUids: async () => ["u_a"],
      agents: async () => [TRAVEL_ADMIN],
      adapterFor: (): ModelAdapter => ({ model: "m", async chat(messages, tools): Promise<ModelReply> { return o.reply((tools ?? []).map((t) => t.name), JSON.stringify(messages)); } }),
      onEvent: (e) => o.events?.push(e), onUsage: () => {}, wiki: testWiki(), mentionInbox: createInMemoryMentionInbox(), agentWriter: createInMemoryAgentWriter(),
      isMember: async () => true, contextWindowOf: () => undefined, sandboxApproval: async () => "ask", workspaceLock: createWorkspaceLock(), relayRemainingMicro: async () => null,
      adminsBridge: o.bridge,
    });
  }
  const idIn = (t: string): string | null => /id (t_[0-9a-f]{8})/.exec(t)?.[1] ?? null;

  it("私密车道里也挂；落 collab_request（原话 = 主人点起任务前那句）+ task_collab，送到桥带 origin；决定回来折进任务；回复回来起管理员一轮", async () => {
    const store = newStore();
    const b = bridgeStub();
    let round = 0;
    const tools: string[][] = [];
    const s = openPair(store, {
      bridge: b.bridge,
      reply: (names, transcript) => {
        tools.push(names);
        round++;
        if (round === 1) return { content: "", toolCalls: [{ id: "c1", name: "create_task", args: { title: "看 9 月营业额", brief: "总数" } }] };
        if (round === 2) return { content: "", toolCalls: [{ id: "c2", name: "invite_collaborator", args: { taskId: idIn(transcript), note: "只要总数" } }] };
        return { content: "已交给 Stan 的管理员，等那边回。" };
      },
    });
    await s.say("u_a", "继爸", "@雨姐 带上 Stan 的管理员去看看营业额", true, ["admin"]);
    await s.settled();
    expect(tools[0]).toContain("invite_collaborator");
    const log = store.load("s1");
    const req = log.find((e): e is CollabRequestEvent => e.type === "collab_request")!;
    expect(req).toMatchObject({ fromUid: "u_a", fromAgentName: "雨姐", title: "看 9 月营业额", quote: { ownerName: "继爸", ownerLine: "@雨姐 带上 Stan 的管理员去看看营业额", note: "只要总数" } });
    expect(req.expiresTs - req.ts).toBeGreaterThan(23 * 3_600_000);
    expect(log.some((e) => e.type === "task_collab")).toBe(true);
    expect(b.requests).toHaveLength(1);
    expect(b.requests[0]).toMatchObject({ ownerUid: "u_a", peerUid: "u_b", origin: { workspaceId: "wa", sessionId: "s1" } });
    // 任务上：等 TA 点头
    expect(taskFoldOf(store.load("s1"), "wa").get(req.taskId)!.collaborator).toMatchObject({ uid: "u_b", state: "pending", requestId: req.requestId });
    // 决定回来
    const decision: CollabDecisionEvent = { sessionId: "x", seq: 1, ts: 1, type: "collab_decision", requestId: req.requestId, decision: "accepted", byUid: "u_b", ignorable: true };
    s.receiveCollabDecision(decision);
    expect(taskFoldOf(store.load("s1"), "wa").get(req.taskId)!.collaborator!.state).toBe("accepted");
    // 回复回来：接力棒 + 管理员一轮
    s.receiveCollabReply({ fromUid: "u_b", text: "9 月对得上。", fromAgentId: "admin", fromAgentName: "峰哥" });
    await s.settled();
    const relayed = store.load("s1").find((e): e is UserMessageEvent => e.type === "user_message" && e.relay !== undefined)!;
    expect(relayed).toMatchObject({ fromUid: "u_b", content: "[峰哥]: 9 月对得上。", mentions: ["admin"] });
    expect(store.load("s1").filter((e) => e.type === "assistant_message").length).toBeGreaterThanOrEqual(3);
    store.close();
  });
});

describe("A 家开房时重送还在等点头的请求（#1605 真机）", () => {
  it("日志里有请求没决定 → 开房就送一遍；有决定的 / 过期的 / 不是这边发的不送", async () => {
    const store = newStore();
    const b = bridgeStub();
    store.append({ sessionId: "s1", ts: 1, type: "session_created", workspace: "/work", cloud: { workspaceId: "wa", chat: { kind: "pair" }, pair: { ownerName: "继爸", peerUid: "u_b", peerName: "Stan Yan", facing: "self" }, home: true } });
    const mk = (id: string, extra: Partial<CollabRequestEvent> = {}) => ({ ...REQUEST, sessionId: "s1", requestId: id, fromUid: "u_a", origin: undefined, ...extra }) as unknown as SessionEvent;
    store.append(mk("r_live"));
    store.append(mk("r_done"));
    store.append({ sessionId: "s1", ts: 5, type: "collab_decision", requestId: "r_done", decision: "declined", byUid: "u_b", ignorable: true });
    store.append(mk("r_old", { expiresTs: 1 }));
    store.append(mk("r_theirs", { fromUid: "u_x" }));
    createCloudSession({
      diskUsage: () => null, routines: null, onOutreachEnded: null, signSpeechTicket: async () => "t", pairMessages: null, outreach: null, callback: null,
      approveAll: true, sessionMeta: createInMemoryCloudSessionMeta(),
      workspaceId: "wa", sessionId: "s1", ownerUid: "u_a", createdByUid: "u_a",
      store, world: fakeWorld, px, hostUids: async () => ["u_a"], agents: async () => [ADMIN],
      adapterFor: (): ModelAdapter => ({ model: "m", async chat(): Promise<ModelReply> { return { content: "x" }; } }),
      onEvent: () => {}, onUsage: () => {}, wiki: testWiki(), mentionInbox: createInMemoryMentionInbox(), agentWriter: createInMemoryAgentWriter(),
      isMember: async () => true, contextWindowOf: () => undefined, sandboxApproval: async () => "ask", workspaceLock: createWorkspaceLock(), relayRemainingMicro: async () => null,
      adminsBridge: b.bridge,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(b.requests.map((x) => x.event.requestId)).toEqual(["r_live"]);
    expect(b.requests[0]).toMatchObject({ ownerUid: "u_a", peerUid: "u_b", origin: { workspaceId: "wa", sessionId: "s1" } });
    store.close();
  });
});

describe("协作请求推给对面主人（#1605 真机）", () => {
  it("新来的推一次（朋友消息那一类、点开去和对面那位的私聊）；一小时内对面重送不再推；答过的不推", async () => {
    const store = newStore();
    const alerts: unknown[][] = [];
    const s = openAdmins(store, { alerts });
    s.receiveCollabRequest(REQUEST);
    s.receiveCollabRequest(REQUEST);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]![0]).toBe("owner");
    expect(alerts[0]![1]).toBe("friend");
    expect(alerts[0]![2]).toMatchObject({ title: "继爸 的管理员找你的管理员", target: { kind: "friend", uid: "u_a" } });
    expect((alerts[0]![2] as { body: string }).body).toContain("看 9 月营业额");
    await s.decideCollab("r_1", "owner", "declined");
    store.close();
  });
});
