// 外联会话钉死（#1441 Task 8）：一只智能体 + 打给的那个朋友，没有工具、不注入记忆、
// 只在通话进行中收话。装配照 sessionService.test.ts 顶部的 baseOpts（那份没导出，这里抄最小一份，
// 不去动既有文件的结构）。
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { createCloudSession, SayRejectedError, type CloudSession, type CloudSessionOpts } from "../../services/runtime/src/sessionService.js";
import { createWikiService, type WikiService } from "../../services/runtime/src/wikiService.js";
import { createMemoryWikiFs } from "../../services/runtime/src/wikiFs.js";
import { createInMemoryWikiJournal } from "../../services/runtime/src/wikiJournal.js";
import { EventStore } from "../../src/session/store.js";
import type { RequestEnvelopeEvent, UserMessageEvent } from "../../src/session/events.js";
import type { ModelAdapter } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import type { PxCallDeps } from "../../services/runtime/src/pxTools.js";
import type { AgentToolAllow } from "../../src/shared/agentToolAllow.js";
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
const OPS = { agentId: "ops", name: "运维", description: "", instructions: "", models: ["fake-model"], tools: [] as AgentToolAllow[] };
const ADS = { agentId: "ads", name: "广告", description: "", instructions: "", models: ["fake-model"], tools: [] as AgentToolAllow[] };

function newStore(): EventStore {
  return new EventStore(join(tempDir("mrotto-runtime-outreach-"), "session.db"));
}

function testWiki(): WikiService {
  return createWikiService({ workspaceId: "w1", fs: createMemoryWikiFs(), journal: createInMemoryWikiJournal(), legacyMemories: async () => [], agentNames: async () => new Map(), isRunning: async () => true });
}

/** 一条外联会话的种子：session_created（outreach 事实）+ 名单（一只智能体 + 朋友一个客人） */
function outreachSeed(store: EventStore, o: { started?: boolean; ended?: boolean; kind?: "outreach" | "dm" } = {}): void {
  const kind = o.kind ?? "outreach";
  store.append({
    sessionId: SID, ts: 1, type: "session_created", workspace: "/work",
    cloud: {
      workspaceId: "w1", home: true, chat: { kind },
      ...(kind === "outreach" ? { outreach: { ownerName: "Stan", peerUid: PEER, peerName: "小红" } } : {}),
    },
  });
  store.append({
    sessionId: SID, ts: 2, type: "chat_roster_changed", agents: [{ agentId: "ops", name: "运维" }],
    humans: [{ uid: PEER, name: "小红" }], ignorable: true,
  });
  if (o.started === true || o.ended === true) {
    store.append({ sessionId: SID, ts: 3, type: "outreach", phase: "started", outreachId: "o1", fromAgentId: "ops", peerUid: PEER, peerName: "小红", ignorable: true });
  }
  if (o.ended === true) {
    store.append({ sessionId: SID, ts: 4, type: "outreach", phase: "ended", outreachId: "o1", fromAgentId: "ops", peerUid: PEER, peerName: "小红", outcome: "completed", ignorable: true });
  }
}

interface Probe {
  session: CloudSession;
  dispatchCalls: number;
  hostUidsCalls: number;
  wikiEnsureCalls: number;
}

function open(store: EventStore, o: { team?: (typeof OPS)[] } = {}): Probe {
  const probe = { dispatchCalls: 0, hostUidsCalls: 0, wikiEnsureCalls: 0 } as Probe;
  const wiki = testWiki();
  const realEnsure = wiki.ensure.bind(wiki);
  wiki.ensure = async (...a: Parameters<WikiService["ensure"]>) => {
    probe.wikiEnsureCalls++;
    return realEnsure(...a);
  };
  const adapter: ModelAdapter = { model: "fake-model", async chat() { return { content: "好" }; } };
  const opts: CloudSessionOpts = {
    sessionMeta: createInMemoryCloudSessionMeta(),
    workspaceId: "w1", sessionId: SID, ownerUid: OWNER, createdByUid: OWNER, store, world: fakeWorld,
    agents: async () => o.team ?? [OPS], adapterFor: () => adapter, px,
    // 真实装配里群主在 hostUids 里：这正是 peopleAround 会把他数成「别人」的那一格
    hostUids: async () => { probe.hostUidsCalls++; return [OWNER]; },
    onEvent: () => {}, onUsage: () => {}, wiki, mentionInbox: createInMemoryMentionInbox(),
    agentWriter: createInMemoryAgentWriter(), isMember: async () => true, contextWindowOf: () => undefined,
    sandboxApproval: async () => "ask", workspaceLock: createWorkspaceLock(), relayRemainingMicro: async () => null,
    diskUsage: () => null, approveAll: true, callback: null,
    dispatch: async (input) => {
      probe.dispatchCalls++;
      return { kind: "picked", agentIds: [input.roster[0]!.agentId] };
    },
  };
  probe.session = createCloudSession(opts);
  return probe;
}

/** 日志里最后一条 request_envelope——这是「真正发给模型的请求长什么样」唯一的落盘凭据 */
function lastEnvelope(store: EventStore): RequestEnvelopeEvent {
  const all = store.ofType(SID, "request_envelope");
  expect(all.length).toBeGreaterThan(0);
  return all.at(-1) as RequestEnvelopeEvent;
}

describe("外联会话（#1441）", () => {
  it("起一轮时发给模型的工具表是空的（读 request_envelope，不戳 engine）", async () => {
    const store = newStore();
    outreachSeed(store, { started: true });
    const { session } = open(store);
    await session.say(PEER, "小红", "喂，你好", false, [], undefined, []);
    await session.settled();
    const env = lastEnvelope(store);
    expect(env.tools).toEqual([]);
    // 提示词与工具表说同一句话：外联那一支在，工具点名一个不在
    expect(env.system).toContain("什么工具都没有");
    for (const w of ["read_file", "write_file", "bash", "call_user", "invite_to_call", "git_push"]) expect(env.system, w).not.toContain(w);
    store.close();
  });

  it("对照：同样的装配换成主场私聊，工具表不是空的（上一条不是空转）", async () => {
    const store = newStore();
    outreachSeed(store, { kind: "dm" });
    const { session } = open(store);
    await session.say(OWNER, "Stan", "在吗", false, [], undefined, []);
    await session.settled();
    expect(lastEnvelope(store).tools.length).toBeGreaterThan(0);
    store.close();
  });

  it("不注入团队 wiki：不落 workspace_wiki_loaded，wiki 服务一次都没碰", async () => {
    const store = newStore();
    outreachSeed(store, { started: true });
    const probe = open(store);
    await probe.session.say(PEER, "小红", "喂", false, [], undefined, []);
    await probe.session.settled();
    expect(store.ofType(SID, "workspace_wiki_loaded")).toEqual([]);
    expect(probe.wikiEnsureCalls).toBe(0);
    store.close();
  });

  it("没有外联在进行时，好友说话被拒、主人说话也被拒，且一个字节都不落盘", async () => {
    const store = newStore();
    outreachSeed(store); // 一通都没开过
    const { session } = open(store);
    const before = store.load(SID).length;
    await expect(session.say(PEER, "小红", "在吗", false, [], undefined, [])).rejects.toThrow("这通电话已经结束了");
    await expect(session.say(OWNER, "Stan", "喂", false, [], undefined, [])).rejects.toBeInstanceOf(SayRejectedError);
    expect(store.load(SID).length).toBe(before);
    store.close();
  });

  it("通话已经收尾（started 之后有 ended）：好友再说话也被拒", async () => {
    const store = newStore();
    outreachSeed(store, { ended: true });
    const { session } = open(store);
    await expect(session.say(PEER, "小红", "还在吗", false, [], undefined, [])).rejects.toThrow("这通电话已经结束了");
    store.close();
  });

  it("通话进行中：只收打给的那个朋友，主人和别的人都被拒", async () => {
    const store = newStore();
    outreachSeed(store, { started: true });
    const { session } = open(store);
    await expect(session.say(OWNER, "Stan", "我插一句", false, [], undefined, [])).rejects.toThrow("这通电话已经结束了");
    await expect(session.say("stranger", "路人", "喂", false, [], undefined, [])).rejects.toThrow("这通电话已经结束了");
    await session.say(PEER, "小红", "你好", false, [], undefined, []);
    await session.settled();
    expect(store.ofType(SID, "user_message").length).toBe(1);
    store.close();
  });

  it("有外联在进行：好友每句话都由那一只接，分类器与成员名单一次都不问", async () => {
    const store = newStore();
    outreachSeed(store, { started: true });
    const probe = open(store);
    await probe.session.say(PEER, "小红", "你好呀", false, [], undefined, []);
    await probe.session.say(PEER, "小红", "我想问个事", false, [], undefined, []);
    await probe.session.settled();
    expect(probe.dispatchCalls).toBe(0);
    expect(probe.hostUidsCalls).toBe(0); // 不为一份注定为空的「别人」名单打网络，也不拉连接器授权
    const users = store.ofType(SID, "user_message") as UserMessageEvent[];
    expect(users.map((u) => u.mentions)).toEqual([["ops"], ["ops"]]);
    expect(store.ofType(SID, "assistant_message").length).toBe(2);
    store.close();
  });

  it("语音通话开着时也一样：不问分类器，由那一只接", async () => {
    const store = newStore();
    outreachSeed(store, { started: true });
    store.append({
      sessionId: SID, ts: 5, type: "voice_call_changed", participants: [{ agentId: "ops", name: "运维" }],
      byUid: PEER, ignorable: true,
    });
    const probe = open(store);
    await probe.session.say(PEER, "小红", "听得到吗", false, [], undefined, [], true);
    await probe.session.settled();
    expect(probe.dispatchCalls).toBe(0);
    expect((store.ofType(SID, "user_message") as UserMessageEvent[]).at(-1)!.mentions).toEqual(["ops"]);
    store.close();
  });

  it("名单读不出恰好一只（团队占位）时也不问分类器", async () => {
    const store = newStore();
    outreachSeed(store, { started: true });
    // 团队名单 degraded：rosterNow 原样交回、不收窄，于是名单不是一只——分类器仍然不该被叫
    const probe = open(store, { team: [{ ...OPS, degraded: true } as never, { ...ADS, degraded: true } as never] });
    await probe.session.say(PEER, "小红", "喂", false, [], undefined, []);
    await probe.session.settled();
    expect(probe.dispatchCalls).toBe(0);
    store.close();
  });

  it("名单改不了，文案说的是这条线", async () => {
    const store = newStore();
    outreachSeed(store, { started: true });
    const { session } = open(store);
    const r = await session.updateChatRoster(OWNER, { agentIds: [] });
    expect(r.kind).toBe("not_group");
    expect(r).toMatchObject({ message: "这条线的名单改不了" });
    store.close();
  });

  it("chat() 报 outreach 与 active：没开过 = false，进行中 = true", () => {
    const idle = newStore();
    outreachSeed(idle);
    expect(open(idle).session.chat()).toMatchObject({ kind: "outreach", agentIds: ["ops"], humans: [{ uid: PEER, name: "小红" }], outreach: { ownerName: "Stan", active: false } });
    idle.close();
    const live = newStore();
    outreachSeed(live, { started: true });
    expect(open(live).session.chat()).toMatchObject({ kind: "outreach", outreach: { ownerName: "Stan", active: true } });
    live.close();
  });

  it("非外联的聊天不带 outreach 字段", () => {
    const store = newStore();
    outreachSeed(store, { kind: "dm" });
    expect(open(store).session.chat()).toEqual({ kind: "dm", agentIds: ["ops"], humans: [{ uid: PEER, name: "小红" }] });
    store.close();
  });
});

// 外联在会话**装配之后**才开始的路径（notify 里逐条 applyOutreach）：要等 Task 9 的通话生命周期把
// outreach 事件经 notify 写进来——今天 CloudSession 没有任何公开入口能让会话自己落一条 outreach，
// 往 store 直接 append 会绕开 notify（daemon.ts 那几条直写同理），测它只会测出「绕开了」。
// 接线那天在这里补一条：装配 → 通话开始 → 好友能说话 → 通话结束 → 又被拒。
