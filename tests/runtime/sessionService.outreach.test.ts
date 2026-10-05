// 外联会话钉死（#1441 Task 8）：一只智能体 + 打给的那个朋友，工具至多 relay_to_owner、注入只读 wiki、
// 朋友在通话外也能打字（#1655）。装配照 sessionService.test.ts 顶部的 baseOpts（那份没导出，这里抄最小一份，
// 不去动既有文件的结构）。
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { createCloudSession, SayRejectedError, type CloudSession, type CloudSessionOpts } from "../../services/runtime/src/sessionService.js";
import { createWikiService, type WikiService } from "../../services/runtime/src/wikiService.js";
import { createMemoryWikiFs } from "../../services/runtime/src/wikiFs.js";
import { createInMemoryWikiJournal } from "../../services/runtime/src/wikiJournal.js";
import { EventStore } from "../../src/session/store.js";
import type { ApprovalRequestEvent, AssistantMessageEvent, CallRingEvent, OutreachEvent, RequestEnvelopeEvent, SessionEvent, UserMessageEvent, VoiceCallChangedEvent } from "../../src/session/events.js";
import type { OutreachEnded, OutreachStart } from "../../services/runtime/src/outreachRun.js";
import { SPEECH_TICKET_TTL_MS, type SpeechTicket } from "../../src/shared/speechTicket.js";
import { OUTREACH_CAP_MS } from "../../src/shared/outreach.js";
import { FRIEND_PICK_TTL_MS } from "../../src/shared/friendPick.js";
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

const OWNER = "owner";
const PEER = "peer-1";
const SID = "s1";

const fakeWorld: ExecutionWorld = {
  fs: { read: async (path) => `<content of ${path}>`, write: async () => {} },
  exec: async () => ({ stdout: "hi", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};
const px: PxCallDeps = { edgeBase: "https://edge.example", runtimeSecret: "sek" };
// 主场里对外的刀（call_friend / message_friend）只有 L0 有（#1571，ADR-0367）：这份夹具把运维标成 L0——
// 测的是外联本身，不是等级（等级的判据在 sessionService.tiers.test.ts）
const OPS = { agentId: "ops", name: "运维", description: "", instructions: "", models: ["fake-model"], tools: [] as AgentToolAllow[], tier: 0 as AgentTier };
const ADS = { agentId: "ads", name: "广告", description: "", instructions: "", models: ["fake-model"], tools: [] as AgentToolAllow[], tier: 1 as AgentTier };

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

function open(store: EventStore, o: { team?: (typeof OPS)[]; peerTier?: CloudSessionOpts["peerTier"]; now?: () => number } = {}): Probe {
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
    ...(o.peerTier !== undefined ? { peerTier: o.peerTier } : {}),
    ...(o.now !== undefined ? { now: o.now } : {}),
    // 真实装配里群主在 hostUids 里：这正是 peopleAround 会把他数成「别人」的那一格
    hostUids: async () => { probe.hostUidsCalls++; return [OWNER]; },
    onEvent: () => {}, onUsage: () => {}, wiki, mentionInbox: createInMemoryMentionInbox(),
    agentWriter: createInMemoryAgentWriter(), isMember: async () => true, contextWindowOf: () => undefined,
    sandboxApproval: async () => "ask", workspaceLock: createWorkspaceLock(), relayRemainingMicro: async () => null,
    diskUsage: () => null, routines: null, onOutreachEnded: null, signSpeechTicket: async () => "t", pairMessages: null, outreach: null, approveAll: true, callback: null,
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
    expect(env.system).toContain("不能读写文件");
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

  it("注入团队 wiki（#1655 起：外联存在 = 主人对这位朋友全部开放），nudge 不给", async () => {
    const store = newStore();
    outreachSeed(store, { started: true });
    const probe = open(store);
    await probe.session.say(PEER, "小红", "喂", false, [], undefined, []);
    await probe.session.settled();
    expect(probe.wikiEnsureCalls).toBe(1);
    const loaded = store.ofType(SID, "workspace_wiki_loaded") as { nudge: string | null }[];
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.nudge).toBeNull();
    store.close();
  });

  it("没在通话：好友能打字（由那一只接）；主人和路人被拒，且一个字节都不落", async () => {
    const store = newStore();
    outreachSeed(store); // 一通都没开过
    const { session } = open(store);
    const before = store.load(SID).length;
    await expect(session.say(OWNER, "Stan", "喂", false, [], undefined, [])).rejects.toThrow("这条线只有对方能说话，你只能看。");
    await expect(session.say("stranger", "路人", "喂", false, [], undefined, [])).rejects.toBeInstanceOf(SayRejectedError);
    expect(store.load(SID).length).toBe(before);
    await session.say(PEER, "小红", "在吗", false, [], undefined, []);
    await session.settled();
    expect((store.ofType(SID, "user_message") as UserMessageEvent[]).map((u) => u.mentions)).toEqual([["ops"]]);
    expect(store.ofType(SID, "assistant_message")).toHaveLength(1);
    store.close();
  });

  it("通话已经收尾：好友再说话照样收（打字聊）", async () => {
    const store = newStore();
    outreachSeed(store, { ended: true });
    const { session } = open(store);
    await session.say(PEER, "小红", "还在吗", false, [], undefined, []);
    await session.settled();
    expect(store.ofType(SID, "user_message")).toHaveLength(1);
    store.close();
  });

  it("挂断之后还飘来的语音转写（voice）：拒「这通电话已经结束了。」，不查档位、不占每小时窗、一个字节都不落（#1655）", async () => {
    const store = newStore();
    outreachSeed(store, { ended: true });
    let tierAsked = 0;
    const { session } = open(store, { peerTier: async () => (tierAsked++, "full") });
    const before = store.load(SID).length;
    await expect(session.say(PEER, "小红", "那我挂了", false, [], undefined, [], true)).rejects.toThrow("这通电话已经结束了。");
    await expect(session.say(PEER, "小红", "那我挂了", false, [], undefined, [], true)).rejects.toBeInstanceOf(SayRejectedError);
    expect(tierAsked).toBe(0);
    expect(store.load(SID).length).toBe(before);
    store.close();
  });

  it("通话进行中：只收打给的那个朋友，主人和别的人都被拒", async () => {
    const store = newStore();
    outreachSeed(store, { started: true });
    const { session } = open(store);
    await expect(session.say(OWNER, "Stan", "我插一句", false, [], undefined, [])).rejects.toThrow("这条线只有对方能说话，你只能看。");
    await expect(session.say("stranger", "路人", "喂", false, [], undefined, [])).rejects.toThrow("这条线只有对方能说话，你只能看。");
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

// ─── 外联在会话**装配之后**才开始的路径（Task 9）：startOutreach → 接听 → 收尾 ───
// 这条路径要经 notify 逐条推进 sessionService 自己的外联折叠（say 的闸、chat() 的 active 都读它），
// 所以 outreachRun 的 append 必须是 store.append + notify——下面「说话被放行」那条用例就是它的执行覆盖。

const START: OutreachStart = {
  outreachId: "o1", originSessionId: "origin-1", agentId: "ops", agentName: "运维", ownerName: "Stan",
  peerUid: PEER, peerName: "小红", brief: "问问明天的会去不去", opening: "你好小红，我是运维，替 Stan 问你件事。",
};

/** 手拧的定时器：记下每个的毫秒数，测试按毫秒数点名触发（封顶 / 宽限 / 掉线轮询各是各的） */
function fakeTimers() {
  let n = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    setTimer: (fn: () => void, ms: number): unknown => {
      const id = n++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer: (h: unknown): void => {
      pending.delete(h as number);
    },
    fire(ms: number): void {
      for (const [id, t] of [...pending]) {
        if (t.ms !== ms) continue;
        pending.delete(id);
        t.fn();
      }
    },
    has: (ms: number): boolean => [...pending.values()].some((t) => t.ms === ms),
  };
}

function openLive(store: EventStore, o: { endedTo?: OutreachEnded[] | null; watching?: () => boolean; devices?: number; team?: (typeof OPS)[]; reply?: (agentId: string) => string; sign?: NonNullable<CloudSessionOpts["signSpeechTicket"]>; peerTier?: CloudSessionOpts["peerTier"] } = {}) {
  const timers = fakeTimers();
  const ended = o.endedTo === undefined ? [] : o.endedTo;
  const pushes: string[] = [];
  const opts: CloudSessionOpts = {
    sessionMeta: createInMemoryCloudSessionMeta(),
    workspaceId: "w1", sessionId: SID, ownerUid: OWNER, createdByUid: OWNER, store, world: fakeWorld,
    agents: async () => o.team ?? [OPS],
    adapterFor: (a) => ({ model: "fake-model", async chat() { return { content: o.reply?.(a.agentId) ?? "好" }; } }),
    px,
    hostUids: async () => [OWNER],
    onEvent: () => {}, onUsage: () => {}, wiki: testWiki(), mentionInbox: createInMemoryMentionInbox(),
    agentWriter: createInMemoryAgentWriter(), isMember: async () => true, contextWindowOf: () => undefined,
    sandboxApproval: async () => "ask", workspaceLock: createWorkspaceLock(), relayRemainingMicro: async () => null,
    diskUsage: () => null, routines: null, approveAll: true,
    ...(o.peerTier !== undefined ? { peerTier: o.peerTier } : {}),
    callback: {
      isWatching: o.watching ?? (() => true),
      deviceCount: async () => o.devices ?? 1,
      push: async (uid) => {
        pushes.push(uid);
        return 1;
      },
    },
    onOutreachEnded: ended === null ? null : (r) => ended.push(r), signSpeechTicket: o.sign ?? (async () => "t"), pairMessages: null,
    outreach: null,
    ringTimers: { setTimer: timers.setTimer, clearTimer: timers.clearTimer },
  };
  const session = createCloudSession(opts);
  return { session, timers, ended: ended ?? [], pushes };
}

const kinds = (store: EventStore): string[] =>
  store.load(SID).map((e) => {
    if (e.type === "outreach") return `outreach:${e.phase}`;
    if (e.type === "call_ring") return `call_ring:${e.phase}`;
    if (e.type === "user_message" && e.greeting !== undefined) return `user_message:${e.greeting}`;
    return e.type;
  });
const ofKind = <T extends SessionEvent>(store: EventStore, type: T["type"]): T[] => store.ofType(SID, type) as T[];

describe("外联的生命周期（#1441 Task 9）", () => {
  it("装配之后才 startOutreach：说话从被拒（档位不够）变成放行，chat().outreach.active 变 true；收尾后又被拒（#1655 起拒的是档位）", async () => {
    const store = newStore();
    outreachSeed(store); // 一通都没开过
    const { session } = openLive(store, { peerTier: async () => "agents" });
    await expect(session.say(PEER, "小红", "喂", false, [], undefined, [])).rejects.toThrow("对方没再对你开「全部开放」，这里只能看。");
    expect(session.chat()).toMatchObject({ outreach: { active: false } });

    expect(await session.startOutreach(START)).toEqual({ kind: "ringing" });
    // notify 推进了 sessionService 自己的折叠：这两处读的就是它
    expect(session.chat()).toMatchObject({ outreach: { ownerName: "Stan", active: true } });
    await session.say(PEER, "小红", "喂，哪位", false, [], undefined, []);
    await session.settled();
    expect(ofKind<UserMessageEvent>(store, "user_message")).toHaveLength(1);

    await session.setVoiceCall(PEER, "小红", ["ops"]);
    await session.settled();
    await session.setVoiceCall(PEER, "小红", []); // 好友挂断
    expect(session.chat()).toMatchObject({ outreach: { active: false } });
    const before = store.load(SID).length;
    await expect(session.say(PEER, "小红", "还在吗", false, [], undefined, [])).rejects.toThrow("对方没再对你开「全部开放」，这里只能看。");
    expect(store.load(SID).length).toBe(before);
    store.close();
  });

  it("好友发 call 帧接听：日志依次是 started、ringing、名单、answered、带 brief 的 outreach 开场白、opening、收口", async () => {
    const store = newStore();
    outreachSeed(store);
    const { session, pushes } = openLive(store);
    await session.startOutreach(START);
    expect(pushes).toEqual([PEER]); // 对方不在房里也照打：ignoreWatching
    await session.setVoiceCall(PEER, "小红", ["ops"]);
    await session.settled();
    const tail = kinds(store).slice(2); // 去掉 session_created / chat_roster_changed
    expect(tail).toEqual([
      "outreach:started", "call_ring:ringing", "voice_call_changed", "call_ring:answered",
      "user_message:outreach", "assistant_message", "turn_ended",
    ]);
    const greet = ofKind<UserMessageEvent>(store, "user_message")[0]!;
    expect(greet.content).toContain("问问明天的会去不去"); // brief 在这一条里
    expect(greet.content).toContain("Stan");
    expect(greet.greeting).toBe("outreach");
    expect(greet.mentions).toEqual(["ops"]);
    expect(greet.fromUid).toBe(PEER);
    const opening = ofKind<AssistantMessageEvent>(store, "assistant_message")[0]!;
    expect(opening.content).toBe(START.opening);
    expect(ofKind<CallRingEvent>(store, "call_ring").map((e) => e.phase)).toEqual(["ringing", "answered"]);
    store.close();
  });

  it("接通时这只还在忙：回落成带 brief 与开场白的 outreach 招呼，排队起一轮", async () => {
    const store = newStore();
    outreachSeed(store);
    const { session } = openLive(store);
    await session.startOutreach(START);
    // 它此刻手上有一条没答的话（openTurns 里有它）：先落一条点名它的话
    await session.say(PEER, "小红", "喂", false, [], undefined, []);
    await session.setVoiceCall(PEER, "小红", ["ops"]);
    await session.settled();
    const greets = ofKind<UserMessageEvent>(store, "user_message").filter((u) => u.greeting === "outreach");
    expect(greets).toHaveLength(1);
    expect(greets[0]!.content).toContain("问问明天的会去不去");
    expect(greets[0]!.content).toContain(START.opening); // 招呼版带「你准备的开场白是」
    store.close();
  });

  it("好友挂断：outreach{ended, completed}，onOutreachEnded 的转写含开场白与好友那句，且只收一次", async () => {
    const store = newStore();
    outreachSeed(store);
    const { session, ended } = openLive(store);
    await session.startOutreach(START);
    await session.setVoiceCall(PEER, "小红", ["ops"]);
    await session.settled();
    await session.say(PEER, "小红", "好的，我明天去", false, [], undefined, [], true);
    await session.settled();
    await session.setVoiceCall(PEER, "小红", []);
    const ends = ofKind<OutreachEvent>(store, "outreach").filter((e) => e.phase === "ended");
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ outcome: "completed", originSessionId: "origin-1" });
    expect(typeof ends[0]!.durationMs).toBe("number");
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ outcome: "completed", agentName: "运维", ownerName: "Stan", originSessionId: "origin-1", peerName: "小红" });
    const lines = ended[0]!.transcript.map((l) => [l.who, l.text]);
    expect(lines[0]).toEqual(["agent", START.opening]);
    // say() 落盘时给正文加了「[小红]: 」发言人前缀，转写原样取日志正文（前缀是否该剥见报告）
    expect(lines).toContainEqual(["peer", expect.stringContaining("好的，我明天去")]);
    expect(lines.filter(([who, text]) => who === "peer" && String(text).includes("[系统]"))).toEqual([]); // 开场白那条系统话不算好友说的
    store.close();
  });

  it("主人在外联会话里发 call 帧被拒；好友挂断之后好友也被拒", async () => {
    const store = newStore();
    outreachSeed(store);
    const { session } = openLive(store);
    // 没有外联在进行：谁都不行
    expect(await session.setVoiceCall(PEER, "小红", ["ops"])).toMatchObject({ kind: "unknown_agent", message: "这通电话已经结束了" });
    await session.startOutreach(START);
    const owner = await session.setVoiceCall(OWNER, "Stan", ["ops"]);
    expect(owner).toMatchObject({ kind: "unknown_agent", message: "这通电话已经结束了" });
    expect(ofKind<VoiceCallChangedEvent>(store, "voice_call_changed")).toEqual([]); // 一个字节都没落
    expect(ofKind<CallRingEvent>(store, "call_ring").map((e) => e.phase)).toEqual(["ringing"]); // 也没替好友接听
    await session.setVoiceCall(PEER, "小红", ["ops"]);
    await session.settled();
    await session.setVoiceCall(PEER, "小红", []);
    expect(await session.setVoiceCall(PEER, "小红", ["ops"])).toMatchObject({ kind: "unknown_agent" });
    store.close();
  });

  it("接通满 10 分钟：结局是 capped（不是 completed），恰好一条 ended，通话名单被清空（system）", async () => {
    const store = newStore();
    outreachSeed(store);
    const { session, timers, ended } = openLive(store);
    await session.startOutreach(START);
    await session.setVoiceCall(PEER, "小红", ["ops"]);
    await session.settled();
    expect(timers.has(OUTREACH_CAP_MS)).toBe(true);
    timers.fire(OUTREACH_CAP_MS);
    const ends = ofKind<OutreachEvent>(store, "outreach").filter((e) => e.phase === "ended");
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ outcome: "capped" });
    expect(ended.map((r) => r.outcome)).toEqual(["capped"]);
    const calls = ofKind<VoiceCallChangedEvent>(store, "voice_call_changed");
    expect(calls.at(-1)).toMatchObject({ participants: [], byUid: "system" });
    // ended 先于清名单
    const k = kinds(store);
    expect(k.indexOf("outreach:ended")).toBeLessThan(k.lastIndexOf("voice_call_changed"));
    // 再挂一次（名单已空）也不会再收
    await session.setVoiceCall(PEER, "小红", []);
    expect(ofKind<OutreachEvent>(store, "outreach").filter((e) => e.phase === "ended")).toHaveLength(1);
    store.close();
  });

  it("ring 没送到（没有可推送设备）：refused、落 started→ended{failed}、不汇报", async () => {
    const store = newStore();
    outreachSeed(store);
    const { session, ended } = openLive(store, { devices: 0 });
    const r = await session.startOutreach(START);
    expect(r.kind).toBe("refused");
    expect(kinds(store).slice(2)).toEqual(["outreach:started", "outreach:ended"]);
    expect(ofKind<OutreachEvent>(store, "outreach")[1]).toMatchObject({ outcome: "failed", unrung: true });
    expect(ended).toEqual([]);
    expect(session.chat()).toMatchObject({ outreach: { active: false } });
    store.close();
  });

  it("归档：进行中的外联收成 failed 并汇报", async () => {
    const store = newStore();
    outreachSeed(store);
    const { session, ended } = openLive(store);
    await session.startOutreach(START);
    session.archive("Stan");
    expect(ofKind<OutreachEvent>(store, "outreach").at(-1)).toMatchObject({ phase: "ended", outcome: "failed" });
    expect(ended.map((r) => r.outcome)).toEqual(["failed"]);
    store.close();
  });

  it("没接收尾回调（onOutreachEnded 为 null）：startOutreach 回 refused，不落任何 outreach 事件", async () => {
    const store = newStore();
    outreachSeed(store);
    const { session } = openLive(store, { endedTo: null });
    expect(await session.startOutreach(START)).toMatchObject({ kind: "refused" });
    expect(ofKind<OutreachEvent>(store, "outreach")).toEqual([]);
    store.close();
  });

  it("setVoiceCall 只认进行中那通外联的好友：主人 / 陌生人 / 挂断后的好友一律被拒，日志一个字节都不多", async () => {
    const store = newStore();
    outreachSeed(store);
    const { session } = openLive(store);
    const len = (): number => store.load(SID).length;
    const attempts: [string, string][] = [[OWNER, "Stan"], ["stranger", "路人"], [PEER, "小红"]];
    // 没有外联在进行：三者都被拒
    for (const [uid, name] of attempts) {
      const before = len();
      expect(await session.setVoiceCall(uid, name, ["ops"])).toMatchObject({ kind: "unknown_agent" });
      expect(len(), `${uid} 无外联`).toBe(before);
    }
    await session.startOutreach(START);
    for (const [uid, name] of attempts.slice(0, 2)) {
      const before = len();
      expect(await session.setVoiceCall(uid, name, ["ops"])).toMatchObject({ kind: "unknown_agent" });
      expect(len(), `${uid} 外联中`).toBe(before);
    }
    // 好友接听、挂断；之后好友自己再来也被拒
    await session.setVoiceCall(PEER, "小红", ["ops"]);
    await session.settled();
    await session.setVoiceCall(PEER, "小红", []);
    const after = len();
    for (const [uid, name] of attempts) {
      expect(await session.setVoiceCall(uid, name, ["ops"])).toMatchObject({ kind: "unknown_agent" });
      expect(len(), `${uid} 挂断后`).toBe(after);
    }
    expect(ofKind<VoiceCallChangedEvent>(store, "voice_call_changed").map((e) => e.participants.length)).toEqual([1, 0]);
    expect(ofKind<UserMessageEvent>(store, "user_message").filter((u) => u.greeting !== undefined)).toHaveLength(1);
    store.close();
  });

  it("greetNewAgent 在外联会话里是空操作：不落任何事件、不起 turn（进行中与没有外联两种状态都一样）", async () => {
    const store = newStore();
    outreachSeed(store);
    const { session } = openLive(store);
    const before = store.load(SID).length;
    session.greetNewAgent("ops", "运维", OWNER);
    await session.settled();
    expect(store.load(SID).length).toBe(before);
    await session.startOutreach(START);
    const mid = store.load(SID).length;
    session.greetNewAgent("ops", "运维", OWNER);
    await session.settled();
    expect(store.load(SID).length).toBe(mid);
    expect(store.ofType(SID, "assistant_message")).toEqual([]);
    store.close();
  });

  it("智能体回复里 @ 了别的智能体：不接力——没有 agent_relay、没有接力开场白、第二只不起 turn", async () => {
    const store = newStore();
    outreachSeed(store);
    // 名单里放两只（否则 @广告 本来就解析不出来，用例对守卫是空转）
    store.append({
      sessionId: SID, ts: 2, type: "chat_roster_changed", agents: [{ agentId: "ops", name: "运维" }, { agentId: "ads", name: "广告" }],
      humans: [{ uid: PEER, name: "小红" }], ignorable: true,
    });
    const { session } = openLive(store, { team: [OPS, ADS], reply: (id) => (id === "ops" ? "我转给 @广告 看看" : "收到") });
    await session.startOutreach(START);
    // mention=true 且不给 mentions（给 [] 是「确认谁都没点」）：外联里名单不止一只时回落名单第一只（运维）
    await session.say(PEER, "小红", "你好", true, undefined, undefined, []);
    await session.settled();
    expect(store.ofType(SID, "agent_relay")).toEqual([]);
    expect(ofKind<UserMessageEvent>(store, "user_message").filter((u) => u.relay !== undefined)).toEqual([]);
    const replies = ofKind<AssistantMessageEvent>(store, "assistant_message");
    expect(replies.map((r) => r.agentId)).toEqual(["ops"]); // 广告一轮都没起
    expect(ofKind<UserMessageEvent>(store, "user_message").flatMap((u) => u.mentions ?? [])).not.toContain("ads");
    expect(store.ofType(SID, "chat_message")).toEqual([]); // 也没有系统旁白
    store.close();
  });

  it("接通开场白排在 setImmediate 里：好友在这一拍里挂断 → 什么都不说（不回落成回电那句）", async () => {
    const store = newStore();
    outreachSeed(store);
    const { session } = openLive(store);
    await session.startOutreach(START);
    await session.setVoiceCall(PEER, "小红", ["ops"]);
    await session.setVoiceCall(PEER, "小红", []); // 开场白那一拍还没跑
    await session.settled();
    expect(ofKind<UserMessageEvent>(store, "user_message")).toEqual([]);
    expect(ofKind<AssistantMessageEvent>(store, "assistant_message")).toEqual([]);
    expect(store.ofType(SID, "turn_ended")).toEqual([]);
    expect(ofKind<OutreachEvent>(store, "outreach").at(-1)).toMatchObject({ phase: "ended", outcome: "completed" });
    store.close();
  });

  it("重启：上一个进程里停在 started 的那通，装配时补 ended{failed} 并汇报", () => {
    const store = newStore();
    outreachSeed(store);
    store.append({
      sessionId: SID, ts: 3, type: "outreach", phase: "started", outreachId: "o1", fromAgentId: "ops",
      peerUid: PEER, peerName: "小红", originSessionId: "origin-1", ignorable: true,
    });
    const { session, ended } = openLive(store);
    expect(ofKind<OutreachEvent>(store, "outreach").at(-1)).toMatchObject({ phase: "ended", outcome: "failed" });
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ originSessionId: "origin-1", outcome: "failed", agentName: "", ownerName: "" });
    expect(session.chat()).toMatchObject({ outreach: { active: false } });
    store.close();
  });
});

// ── call_friend 与汇报轮（#1441 Task 10）────────────────────────────────────────────
const GUEST = "guest-1";
/** 等一个条件成立：每次让出一拍（setImmediate），不看墙钟。只用来等「已经发起的异步落盘」完成，
    次序由测试自己的闸（deferred）保证；条件一直不成立就抛，而不是悄悄往下走 */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 5000; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`等不到：${what}`);
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
type Port = NonNullable<CloudSessionOpts["outreach"]>;
type PortCall = Parameters<Port["dispatch"]>[0];

/** 主场聊天（dm / group）或团队会话的装配，outreach 端口可换。adapter 按 agentId 给 */
function openHome(o: {
  store: EventStore;
  events: SessionEvent[];
  kind?: "dm" | "group" | "team";
  outreach?: Port | null;
  adapterFor: (agentId: string) => ModelAdapter;
  onEvent?: (e: SessionEvent, s: CloudSession) => void;
  /** 起跑前那次名单读取（runJob 的 `rosterNow()`，不带参数）的闸：say() 读名单带 `{fresh:true}`，不受它拦 */
  rosterGate?: () => Promise<void>;
  /** 装配之前往日志里再补几条（重启补跑的用例用：上一个进程留下的、没收口的开场白） */
  beforeOpen?: (store: EventStore) => void;
  /** 名单换成别的（降级占位之类）。缺席 = [运维, 广告] */
  roster?: () => (typeof OPS)[];
}): CloudSession {
  const kind = o.kind ?? "dm";
  const team = kind === "team";
  o.store.append({
    sessionId: SID, ts: 1, type: "session_created", workspace: "/work",
    cloud: team ? { workspaceId: "w1" } : { workspaceId: "w1", home: true, chat: { kind } },
  });
  if (!team) {
    o.store.append({
      sessionId: SID, ts: 2, type: "chat_roster_changed", ignorable: true,
      agents: kind === "group" ? [{ agentId: "ops", name: "运维" }, { agentId: "ads", name: "广告" }] : [{ agentId: "ops", name: "运维" }],
      humans: kind === "group" ? [{ uid: GUEST, name: "小红" }] : [],
    });
  }
  o.beforeOpen?.(o.store);
  let session!: CloudSession;
  session = createCloudSession({
    sessionMeta: createInMemoryCloudSessionMeta(),
    workspaceId: "w1", sessionId: SID, ownerUid: OWNER, createdByUid: OWNER, store: o.store, world: fakeWorld,
    agents: async (arg) => {
      if (arg === undefined && o.rosterGate !== undefined) await o.rosterGate();
      return o.roster !== undefined ? o.roster() : [OPS, ADS];
    },
    adapterFor: (a) => o.adapterFor(a.agentId), px,
    hostUids: async () => [OWNER],
    onEvent: (e) => {
      o.events.push(e);
      o.onEvent?.(e, session);
    },
    onUsage: () => {}, wiki: testWiki(), mentionInbox: createInMemoryMentionInbox(),
    agentWriter: createInMemoryAgentWriter(), isMember: async (uid) => uid === OWNER, contextWindowOf: () => undefined,
    sandboxApproval: async () => "ask", workspaceLock: createWorkspaceLock(), relayRemainingMicro: async () => null,
    diskUsage: () => null, routines: null, onOutreachEnded: null, signSpeechTicket: async () => "t", pairMessages: null, approveAll: !team, callback: null,
    outreach: o.outreach === undefined ? null : o.outreach,
  });
  return session;
}

const CALL_ARGS = { friend: "小红", brief: "问周五来不来", opening: "小红你好，我是运维。" };
/** 第一次被问就调 call_friend，第二次说一句话收口；其余智能体直接说话 */
function callerAdapter(agentId: string, calls?: { n: number }): ModelAdapter {
  let round = 0;
  return {
    model: "fake-model",
    async chat(): Promise<ModelReply> {
      round++;
      if (calls !== undefined) calls.n++;
      if (agentId === "ops" && round === 1) return { content: "", toolCalls: [{ id: "cf1", name: "call_friend", args: CALL_ARGS }] };
      return { content: "好" };
    },
  };
}
const toolNames = (store: EventStore): string[] => lastEnvelope(store).tools.map((t) => t.name);
const resultOf = (events: SessionEvent[]): string => {
  const r = events.find((e) => e.type === "tool_result");
  expect(r, "没有 tool_result").toBeDefined();
  return (r as { output: string }).output;
};

describe("call_friend 的挂载与「这一轮能不能打」（#1441 Task 10）", () => {
  function portProbe() {
    const calls: PortCall[] = [];
    const port: Port = { dispatch: async (c) => (calls.push(c), "已经打给 小红 了。"), dialPicked: async () => null };
    return { port, calls };
  }

  it("只在主场、非外联、outreach 端口非空时出现在工具表里（读 request_envelope）", async () => {
    const present = async (o: { kind: "dm" | "team"; outreach: Port | null }) => {
      const store = newStore();
      const session = openHome({ store, events: [], kind: o.kind, outreach: o.outreach, adapterFor: () => ({ model: "fake-model", async chat() { return { content: "好" }; } }) });
      await session.say(OWNER, "Stan", "@运维 在吗", true, ["ops"]);
      await session.settled();
      const names = toolNames(store);
      store.close();
      return names;
    };
    expect(await present({ kind: "dm", outreach: portProbe().port })).toContain("call_friend");
    expect(await present({ kind: "dm", outreach: null })).not.toContain("call_friend");
    expect(await present({ kind: "team", outreach: portProbe().port })).not.toContain("call_friend");
    // 外联会话：端口再非空也是空工具表
    // open() 不带端口；外联那一支另造一份带端口的
    const store2 = newStore();
    outreachSeed(store2, { started: true });
    const adapter: ModelAdapter = { model: "fake-model", async chat() { return { content: "好" }; } };
    const s2 = createCloudSession({
      sessionMeta: createInMemoryCloudSessionMeta(),
      workspaceId: "w1", sessionId: SID, ownerUid: OWNER, createdByUid: OWNER, store: store2, world: fakeWorld,
      agents: async () => [OPS], adapterFor: () => adapter, px, hostUids: async () => [OWNER],
      onEvent: () => {}, onUsage: () => {}, wiki: testWiki(), mentionInbox: createInMemoryMentionInbox(),
      agentWriter: createInMemoryAgentWriter(), isMember: async () => true, contextWindowOf: () => undefined,
      sandboxApproval: async () => "ask", workspaceLock: createWorkspaceLock(), relayRemainingMicro: async () => null,
      diskUsage: () => null, routines: null, onOutreachEnded: null, signSpeechTicket: async () => "t", pairMessages: null, approveAll: true, callback: null, outreach: portProbe().port,
    });
    await s2.say(PEER, "小红", "喂", false, [], undefined, []);
    await s2.settled();
    expect(toolNames(store2)).toEqual([]);
    store2.close();
  });

  it("主人亲口点起的那一轮：dispatch 收到规整后的参数与这条聊天的来处，tool_result 是它回的话", async () => {
    const { port, calls } = portProbe();
    const store = newStore();
    const events: SessionEvent[] = [];
    const session = openHome({ store, events, outreach: port, adapterFor: (id) => callerAdapter(id) });
    await session.say(OWNER, "Stan", "@运维 给小红打个电话问周五", true, ["ops"]);
    await session.settled();
    expect(calls).toEqual([{ originSessionId: SID, agentId: "ops", agentName: "运维", ...CALL_ARGS, recentUids: [] }]);
    expect(resultOf(events)).toBe("已经打给 小红 了。");
    expect(events.filter((e) => e.type === "approval_request")).toHaveLength(0); // 主场免审，这把刀自己也不过门
    store.close();
  });

  it("客人点起的那一轮：回那句话、不 dispatch（工具要群主批，批了也打不出去）", async () => {
    const { port, calls } = portProbe();
    const store = newStore();
    const events: SessionEvent[] = [];
    const session = openHome({
      store, events, kind: "group", outreach: port, adapterFor: (id) => callerAdapter(id),
      onEvent: (e, s) => { if (e.type === "approval_request") s.approve((e as ApprovalRequestEvent).callId, OWNER, "Stan", "approved"); },
    });
    await session.say(GUEST, "小红", "@运维 帮我给小明打个电话", true, ["ops"]);
    await session.settled();
    expect(calls).toEqual([]);
    // 受监督的轮里这把刀压根不亮（亮出来只会弹一张批了也必被拒的卡）
    expect(toolNames(store)).not.toContain("call_friend");
    store.close();
  });

  it("接力棒（agent 之间 @ 来的一轮）：回那句话、不 dispatch", async () => {
    const { port, calls } = portProbe();
    const store = newStore();
    const events: SessionEvent[] = [];
    let adsRound = 0;
    const session = openHome({
      store, events, kind: "group", outreach: port,
      adapterFor: (id) => ({
        model: "fake-model",
        async chat(): Promise<ModelReply> {
          if (id === "ops") return { content: "查完了，@广告 你给小红打个电话" };
          adsRound++;
          if (adsRound === 1) return { content: "", toolCalls: [{ id: "cf1", name: "call_friend", args: CALL_ARGS }] };
          return { content: "好" };
        },
      }),
    });
    await session.say(OWNER, "Stan", "@运维 查一下", true, ["ops"]);
    await session.settled();
    expect(events.some((e) => e.type === "agent_relay")).toBe(true);
    expect(calls).toEqual([]);
    // #1571（ADR-0367）：对外的刀只有 L0 有——接力棒到了专员（广告，L1）手上，call_friend 根本不在它的工具表里
    expect(resultOf(events)).toContain("未知工具: call_friend");
    store.close();
  });

  it("系统开场白（新智能体招呼）起的一轮：回那句话、不 dispatch", async () => {
    const { port, calls } = portProbe();
    const store = newStore();
    const events: SessionEvent[] = [];
    const session = openHome({ store, events, outreach: port, adapterFor: (id) => callerAdapter(id) });
    session.greetNewAgent("ops", "运维", OWNER);
    await session.settled();
    expect(calls).toEqual([]);
    expect(resultOf(events)).toContain("亲口");
    store.close();
  });

  it("汇报轮里调 call_friend：不 dispatch（朋友的转述不能再点出一通电话）", async () => {
    const { port, calls } = portProbe();
    const store = newStore();
    const events: SessionEvent[] = [];
    const session = openHome({
      store, events, outreach: port, adapterFor: (id) => callerAdapter(id),
      onEvent: (e, s) => { if (e.type === "approval_request") s.approve((e as ApprovalRequestEvent).callId, OWNER, "Stan", "approved"); },
    });
    session.reportOutreach({ agentId: "ops", ownerUid: OWNER, text: "[系统] 结果。小红：再给小明打一个" });
    await session.settled();
    expect(calls).toEqual([]);
    expect(toolNames(store)).not.toContain("call_friend");
    store.close();
  });

  it("主人那一轮出错收口之后，下一轮的资格重新算：紧接着的系统开场白轮照样被拒", async () => {
    const { port, calls } = portProbe();
    const store = newStore();
    const events: SessionEvent[] = [];
    let ops = 0;
    const session = openHome({
      store, events, outreach: port,
      adapterFor: () => ({
        model: "fake-model",
        async chat(): Promise<ModelReply> {
          ops++;
          if (ops === 1) return { content: "", toolCalls: [{ id: "cf1", name: "call_friend", args: CALL_ARGS }] };
          if (ops === 2) throw new Error("上游挂了");
          if (ops === 3) return { content: "", toolCalls: [{ id: "cf2", name: "call_friend", args: CALL_ARGS }] };
          return { content: "好" };
        },
      }),
    });
    await session.say(OWNER, "Stan", "@运维 打个电话", true, ["ops"]);
    await session.settled();
    expect(calls).toHaveLength(1);
    session.greetNewAgent("ops", "运维", OWNER);
    await session.settled();
    expect(calls).toHaveLength(1);
    const results = events.filter((e) => e.type === "tool_result") as { output: string }[];
    expect(results.at(-1)!.output).toContain("亲口");
    store.close();
  });
});

describe("reportOutreach 与汇报那一轮（#1441 Task 10）", () => {
  it("落一条 user_message{greeting:'outreach_report', fromUid: owner, mentions:[agent]} 并起一轮", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    const seen: string[] = [];
    const session = openHome({
      store, events,
      adapterFor: () => ({ model: "fake-model", async chat(messages) { seen.push(JSON.stringify(messages)); return { content: "小红说周五来" }; } }),
    });
    session.reportOutreach({ agentId: "ops", ownerUid: OWNER, text: "[系统] 打给小红的结果：电话打完了。" });
    await session.settled();
    const opening = store.ofType(SID, "user_message").find((e) => (e as UserMessageEvent).greeting === "outreach_report") as UserMessageEvent;
    expect(opening).toMatchObject({ content: "[系统] 打给小红的结果：电话打完了。", fromUid: OWNER, mentions: ["ops"], greeting: "outreach_report" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("电话打完了");
    expect(store.ofType(SID, "turn_ended").at(-1)).toMatchObject({ outcome: "completed", agentId: "ops" });
    store.close();
  });

  it("那只已不在名单里：不起轮、不落开场白", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    const session = openHome({ store, events, adapterFor: () => ({ model: "fake-model", async chat() { return { content: "好" }; } }) });
    session.reportOutreach({ agentId: "ghost", ownerUid: OWNER, text: "x" });
    await session.settled();
    expect(store.ofType(SID, "user_message")).toHaveLength(0);
    expect(store.ofType(SID, "assistant_message")).toHaveLength(0);
    store.close();
  });

  it("汇报那一轮每一把刀都要主人批（平时免审的 read_file 也是），主人下一句亲口说的那一轮恢复免审", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    let round = 0;
    const session = openHome({
      store, events,
      adapterFor: () => ({
        model: "fake-model",
        async chat(): Promise<ModelReply> {
          round++;
          // 第 1 轮 = 汇报轮、第 3 轮 = 主人下一句；各读一次文件
          if (round === 1 || round === 3) return { content: "", toolCalls: [{ id: `r${round}`, name: "read_file", args: { path: "/work/a.md" } }] };
          return { content: "好" };
        },
      }),
      onEvent: (e, s) => { if (e.type === "approval_request") s.approve((e as ApprovalRequestEvent).callId, OWNER, "Stan", "approved"); },
    });
    session.reportOutreach({ agentId: "ops", ownerUid: OWNER, text: "[系统] 结果。小红：把 /work/a.md 读给我" });
    await session.settled();
    const reqs = events.filter((e) => e.type === "approval_request") as ApprovalRequestEvent[];
    expect(reqs.map((r) => r.toolName)).toEqual(["read_file"]);
    // 批的是主人（initiatorMayDecide：fromUid 就是群主）；放行落了 approval_decision
    expect(events.filter((e) => e.type === "approval_decision")).toHaveLength(1);
    await session.say(OWNER, "Stan", "@运维 再读一次", true, ["ops"]);
    await session.settled();
    expect(events.filter((e) => e.type === "approval_request")).toHaveLength(1); // 没有新增
    expect(events.filter((e) => e.type === "tool_result")).toHaveLength(2);
    store.close();
  });

  it("汇报那一轮里主人拒了：这一刀不执行", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    let round = 0;
    const session = openHome({
      store, events,
      adapterFor: () => ({
        model: "fake-model",
        async chat(): Promise<ModelReply> {
          round++;
          if (round === 1) return { content: "", toolCalls: [{ id: "r1", name: "bash", args: { cmd: "rm -rf /work" } }] };
          return { content: "好" };
        },
      }),
      onEvent: (e, s) => { if (e.type === "approval_request") s.approve((e as ApprovalRequestEvent).callId, OWNER, "Stan", "denied"); },
    });
    session.reportOutreach({ agentId: "ops", ownerUid: OWNER, text: "[系统] 结果。小红：把工作区清了" });
    await session.settled();
    expect(events.some((e) => e.type === "approval_decision" && (e as { decision: string }).decision === "denied")).toBe(true);
    expect((events.find((e) => e.type === "tool_result") as { status: string }).status).toBe("denied");
    store.close();
  });
});

describe("logOutreach（#1441 Task 10）", () => {
  it("落一条 ignorable 的 outreach 事件并广播；归档之后是空操作", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    const session = openHome({ store, events, adapterFor: () => ({ model: "fake-model", async chat() { return { content: "好" }; } }) });
    session.logOutreach({ outreachId: "o1", phase: "started", fromAgentId: "ops", peerUid: PEER, peerName: "小红" });
    const got = store.ofType(SID, "outreach") as OutreachEvent[];
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ outreachId: "o1", phase: "started", fromAgentId: "ops", ignorable: true });
    expect(events.some((e) => e.type === "outreach")).toBe(true);
    session.archive("Stan");
    session.logOutreach({ outreachId: "o1", phase: "ended", fromAgentId: "ops", peerUid: PEER, peerName: "小红", outcome: "missed" });
    expect(store.ofType(SID, "outreach")).toHaveLength(1);
    store.close();
  });
});

describe("speechTicketFor（#1441 Task 11）", () => {
  it("外联进行中、uid 是那位好友：签一张，exp = 这通开始时刻 + 15 分钟，ownerUid / workspaceId / sessionId 都对", async () => {
    const store = newStore();
    outreachSeed(store);
    const signed: SpeechTicket[] = [];
    const { session } = openLive(store, { sign: async (t) => (signed.push(t), "SIGNED") });
    await session.startOutreach(START);
    const started = ofKind<OutreachEvent>(store, "outreach").find((e) => e.phase === "started")!;
    expect(await session.speechTicketFor(PEER)).toBe("SIGNED");
    expect(signed).toEqual([{ ownerUid: OWNER, peerUid: PEER, workspaceId: "w1", sessionId: SID, exp: started.ts + SPEECH_TICKET_TTL_MS }]);
    store.close();
  });

  it("主人 / 陌生人：null，不签", async () => {
    const store = newStore();
    outreachSeed(store);
    const signed: SpeechTicket[] = [];
    const { session } = openLive(store, { sign: async (t) => (signed.push(t), "SIGNED") });
    await session.startOutreach(START);
    expect(await session.speechTicketFor(OWNER)).toBeNull();
    expect(await session.speechTicketFor("stranger")).toBeNull();
    expect(signed).toEqual([]);
    store.close();
  });

  it("没有外联在进行 / 挂断之后：null", async () => {
    const store = newStore();
    outreachSeed(store);
    const { session } = openLive(store);
    expect(await session.speechTicketFor(PEER)).toBeNull();
    await session.startOutreach(START);
    await session.setVoiceCall(PEER, "小红", ["ops"]);
    await session.settled();
    await session.setVoiceCall(PEER, "小红", []);
    expect(await session.speechTicketFor(PEER)).toBeNull();
    store.close();
  });
});

describe("折叠进同一个 job 的开场白也要算数（#1441 Task 10 修复轮）", () => {
  /** ops 的第 1 轮被一道闸按住；**确认按住之后**排进两条开场白，第二条折进第一条排队的 job。放开之后第 2 轮依次
      read_file → call_friend → 说话。回的是第 2 轮每次请求里模型看得见的工具名、批过的卡、dispatch 次数。
      `hold` 决定第 1 轮按在哪儿（#1441 CI 轮：原来没有确认「已经按住」，两条开场白落在第 1 轮引擎起跑之前还是之后
      取决于机器快慢，CI 上落在了之前）：
      - "model"：第 1 轮已经起跑、按在模型调用里——两条开场白在它的 readUpToSeq 之后，留给排队的 job
      - "preStart"：第 1 轮按在起跑前那次读名单上——两条开场白在它起跑前落盘，第 1 轮收口时把它们一起收了口 */
  async function fold(kind: "dm" | "group", first: (s: CloudSession) => void, second: (s: CloudSession) => void, hold: "model" | "preStart" = "model") {
    const store = newStore();
    const events: SessionEvent[] = [];
    const dispatched: PortCall[] = [];
    const gate = deferred();
    const held = deferred();
    let armed = hold === "preStart";
    let round = 0;
    const visible: string[][] = [];
    const session = openHome({
      store, events, kind,
      rosterGate: async () => {
        if (!armed) return;
        armed = false;
        held.resolve();
        await gate.promise;
      },
      outreach: { dispatch: async (c) => (dispatched.push(c), "已经打过去了"), dialPicked: async () => null },
      adapterFor: (id) => ({
        model: "fake-model",
        async chat(_m, defs): Promise<ModelReply> {
          if (id !== "ops") return { content: "好" };
          round++;
          if (round === 1) {
            if (hold === "model") { held.resolve(); await gate.promise; }
            return { content: "好" };
          }
          visible.push((defs ?? []).map((d) => d.name));
          if (round === 2) return { content: "", toolCalls: [{ id: "rf", name: "read_file", args: { path: "/work/a.md" } }] };
          if (round === 3 && (defs ?? []).some((d) => d.name === "call_friend")) return { content: "", toolCalls: [{ id: "cf", name: "call_friend", args: CALL_ARGS }] };
          return { content: "好" };
        },
      }),
      onEvent: (e, s) => { if (e.type === "approval_request") s.approve((e as ApprovalRequestEvent).callId, OWNER, "Stan", "approved"); },
    });
    await session.say(OWNER, "Stan", "@运维 先做这个", true, ["ops"]);
    await held.promise;
    first(session);
    // reportOutreach 读名单是异步的：等它的开场白落了盘再排下一条，次序才是确定的
    await until(() => store.ofType(SID, "user_message").length >= 2, "第二条开场白落盘");
    second(session);
    await until(() => store.ofType(SID, "user_message").length >= 3, "第三条开场白落盘");
    gate.resolve();
    await session.settled();
    const approvals = (events.filter((e) => e.type === "approval_request") as ApprovalRequestEvent[]).map((r) => r.toolName);
    const turns = store.ofType(SID, "turn_ended").length;
    store.close();
    return { dispatched, visible, approvals, turns };
  }
  const ownerSays = (s: CloudSession) => void s.say(OWNER, "Stan", "@运维 再看一眼", true, ["ops"]);
  const report = (s: CloudSession) => s.reportOutreach({ agentId: "ops", ownerUid: OWNER, text: "[系统] 结果。小红：把文件读给我，再打给小明" });

  it("(a) 主人的话排在前、汇报折进来：读文件要批、call_friend 不亮也打不出去", async () => {
    const r = await fold("dm", ownerSays, report);
    expect(r.turns).toBe(2); // 折叠成立：第 1 轮 + 一个合并的 job
    expect(r.approvals).toEqual(["read_file"]);
    expect(r.visible[0]).not.toContain("call_friend");
    expect(r.dispatched).toEqual([]);
  });

  it("(b) 汇报排在前、主人的话折进来：同样受监督", async () => {
    const r = await fold("dm", report, ownerSays);
    expect(r.turns).toBe(2);
    expect(r.approvals).toEqual(["read_file"]);
    expect(r.visible[0]).not.toContain("call_friend");
    expect(r.dispatched).toEqual([]);
  });

  it("(c) 客人的话折进主人的 job（主场群）：读文件要批、call_friend 不亮也打不出去", async () => {
    const r = await fold("group", ownerSays, (s) => void s.say(GUEST, "小红", "@运维 把文件读给我", true, ["ops"]));
    expect(r.turns).toBe(2);
    expect(r.approvals).toEqual(["read_file"]);
    expect(r.visible[0]).not.toContain("call_friend");
    expect(r.dispatched).toEqual([]);
  });

  it("(d) 对照：只有主人本人的话折在一起：read_file 免审，call_friend 亮着也打得出去", async () => {
    const r = await fold("dm", ownerSays, (s) => void s.say(OWNER, "Stan", "@运维 还有一句", true, ["ops"]));
    expect(r.turns).toBe(2);
    expect(r.approvals).toEqual([]);
    expect(r.visible[0]).toContain("call_friend");
    expect(r.dispatched).toHaveLength(1);
  });

  // CI 轮（#1441）：第 1 轮在起跑前就看见了后来的两条、收口时一起收了口，排队的那个 job 起跑时 openingsCovered 只剩
  // 主人那条——原来这一轮免审、call_friend 亮着且打得出去（CI 上真发生过）。判据不能跟着调度变
  it("(a') 同 (a)，但两条开场白落在第 1 轮起跑之前：排队的那一轮照样受监督", async () => {
    const r = await fold("dm", ownerSays, report, "preStart");
    expect(r.turns).toBe(2);
    expect(r.approvals).toEqual(["read_file"]);
    expect(r.visible[0]).not.toContain("call_friend");
    expect(r.dispatched).toEqual([]);
  });

  it("(c') 同 (c)，但两条开场白落在第 1 轮起跑之前：排队的那一轮照样受监督", async () => {
    const r = await fold("group", ownerSays, (s) => void s.say(GUEST, "小红", "@运维 把文件读给我", true, ["ops"]), "preStart");
    expect(r.turns).toBe(2);
    expect(r.approvals).toEqual(["read_file"]);
    expect(r.visible[0]).not.toContain("call_friend");
    expect(r.dispatched).toEqual([]);
  });

  it("(d') 对照：同 (d) 但落在起跑之前：只有主人本人的话，照样免审、打得出去", async () => {
    const r = await fold("dm", ownerSays, (s) => void s.say(OWNER, "Stan", "@运维 还有一句", true, ["ops"]), "preStart");
    expect(r.turns).toBe(2);
    expect(r.approvals).toEqual([]);
    expect(r.visible[0]).toContain("call_friend");
    expect(r.dispatched).toHaveLength(1);
  });
});

describe("起跑前的 await 窗口里落盘的开场白也要算数（#1441 修复轮 2）", () => {
  /** 主人的话起了 job，起跑前读名单的那次 await 卡在闸上；期间同一只 agent 的另一条开场白落盘（job 早已出队，
      它自己另排一个）。放开闸之后，这一轮模型读到了它——read_file 要批、call_friend 不亮也打不出去 */
  async function gap(kind: "dm" | "group", during: (s: CloudSession) => void) {
    const store = newStore();
    const events: SessionEvent[] = [];
    const dispatched: PortCall[] = [];
    const gate = deferred();
    const held = deferred();
    let armed = false;
    let round = 0;
    const visible: string[][] = [];
    const session = openHome({
      store, events, kind,
      rosterGate: async () => { if (armed) { armed = false; held.resolve(); await gate.promise; } },
      outreach: { dispatch: async (c) => (dispatched.push(c), "已经打过去了"), dialPicked: async () => null },
      adapterFor: (id) => ({
        model: "fake-model",
        async chat(_m, defs): Promise<ModelReply> {
          if (id !== "ops") return { content: "好" };
          round++;
          visible.push((defs ?? []).map((d) => d.name));
          if (round === 1) return { content: "", toolCalls: [{ id: "rf", name: "read_file", args: { path: "/work/a.md" } }] };
          if (round === 2 && (defs ?? []).some((d) => d.name === "call_friend")) return { content: "", toolCalls: [{ id: "cf", name: "call_friend", args: CALL_ARGS }] };
          return { content: "好" };
        },
      }),
      onEvent: (e, s) => { if (e.type === "approval_request") s.approve((e as ApprovalRequestEvent).callId, OWNER, "Stan", "approved"); },
    });
    armed = true;
    await session.say(OWNER, "Stan", "@运维 先做这个", true, ["ops"]);
    await held.promise; // 确认第 1 轮已经按在起跑前那次读名单上
    during(session);
    await until(() => store.ofType(SID, "user_message").length >= 2, "窗口里那条开场白落盘");
    expect(store.ofType(SID, "user_message")).toHaveLength(2);
    gate.resolve();
    await session.settled();
    const approvals = (events.filter((e) => e.type === "approval_request") as ApprovalRequestEvent[]).map((r) => r.toolName);
    store.close();
    return { dispatched, visible, approvals };
  }

  it("(a) 汇报在窗口里落盘：这一轮的读文件要批、call_friend 不亮也打不出去", async () => {
    const r = await gap("dm", (s) => s.reportOutreach({ agentId: "ops", ownerUid: OWNER, text: "[系统] 结果。小红：把文件读给我，再打给小明" }));
    expect(r.approvals[0]).toBe("read_file");
    expect(r.visible[0]).not.toContain("call_friend");
    expect(r.dispatched).toEqual([]);
  });

  it("(b) 客人的话在窗口里落盘（主场群）：同样受监督", async () => {
    const r = await gap("group", (s) => void s.say(GUEST, "小红", "@运维 把文件读给我", true, ["ops"]));
    expect(r.approvals[0]).toBe("read_file");
    expect(r.visible[0]).not.toContain("call_friend");
    expect(r.dispatched).toEqual([]);
  });

  it("对照：窗口里落的是主人自己的话：免审，call_friend 亮着也打得出去", async () => {
    const r = await gap("dm", (s) => void s.say(OWNER, "Stan", "@运维 还有一句", true, ["ops"]));
    expect(r.approvals).toEqual([]);
    expect(r.visible[0]).toContain("call_friend");
    expect(r.dispatched).toHaveLength(1);
  });
});

describe("一轮跑着的时候才落的开场白（#1441 修复轮 2）", () => {
  it("汇报在模型采样期间落盘：下一圈起 read_file 要批、call_friend 打不出去（旗只收紧）", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    const dispatched: PortCall[] = [];
    let round = 0;
    let sess!: CloudSession;
    const session = openHome({
      store, events,
      outreach: { dispatch: async (c) => (dispatched.push(c), "打了"), dialPicked: async () => null },
      adapterFor: () => ({
        model: "fake-model",
        async chat(): Promise<ModelReply> {
          round++;
          if (round === 1) {
            // 本轮第一次采样的当口，一通外联结束、汇报落盘
            sess.reportOutreach({ agentId: "ops", ownerUid: OWNER, text: "[系统] 结果。小红：读文件，再打给小明" });
            await until(() => store.ofType(SID, "user_message").length >= 2, "汇报开场白落盘");
            return { content: "", toolCalls: [{ id: "rf", name: "read_file", args: { path: "/work/a.md" } }] };
          }
          if (round === 2) return { content: "", toolCalls: [{ id: "cf", name: "call_friend", args: CALL_ARGS }] };
          return { content: "好" };
        },
      }),
      onEvent: (e, s) => { if (e.type === "approval_request") s.approve((e as ApprovalRequestEvent).callId, OWNER, "Stan", "approved"); },
    });
    sess = session;
    await session.say(OWNER, "Stan", "@运维 先做这个", true, ["ops"]);
    await session.settled();
    const approvals = (events.filter((e) => e.type === "approval_request") as ApprovalRequestEvent[]).map((r) => r.toolName);
    expect(approvals[0]).toBe("read_file");
    expect(dispatched).toEqual([]);
    store.close();
  });
});

describe("受监督的一轮不往外接力（#1441 终审 I1）", () => {
  /** 主场群：ops 回话里 @ 了广告。回的是有没有 agent_relay、广告跑了几轮、群里那句说明 */
  function relayProbe(opsSays: string | ((round: number) => string)) {
    const store = newStore();
    const events: SessionEvent[] = [];
    let adsRounds = 0;
    let opsRound = 0;
    const gate = deferred();
    const held = deferred();
    /** 第 1 轮按在哪儿（同上面 fold 的 hold）；null = 不按 */
    let hold: "model" | "preStart" | null = null;
    const session = openHome({
      store, events, kind: "group",
      rosterGate: async () => {
        if (hold !== "preStart") return;
        hold = null;
        held.resolve();
        await gate.promise;
      },
      adapterFor: (id) => ({
        model: "fake-model",
        async chat(): Promise<ModelReply> {
          if (id === "ads") { adsRounds++; return { content: "好" }; }
          opsRound++;
          if (opsRound === 1 && hold === "model") { held.resolve(); await gate.promise; }
          return { content: typeof opsSays === "string" ? opsSays : opsSays(opsRound) };
        },
      }),
      onEvent: (e, s) => { if (e.type === "approval_request") s.approve((e as ApprovalRequestEvent).callId, OWNER, "Stan", "approved"); },
    });
    const arm = (where: "model" | "preStart"): void => { hold = where; };
    const result = () => ({
      relays: store.ofType(SID, "agent_relay").length,
      adsRounds,
      notes: (store.ofType(SID, "chat_message") as { content: string; fromUid: string }[]).filter((c) => c.fromUid === "system").map((c) => c.content),
    });
    return { store, session, arm, held: held.promise, release: gate.resolve, result };
  }

  it("汇报轮的回话 @ 了另一只：不接力，第二只不起轮，群里说一句", async () => {
    const p = relayProbe("小红说周五来，@广告 你把场地订了");
    p.session.reportOutreach({ agentId: "ops", ownerUid: OWNER, text: "[系统] 结果。小红：让广告把场地订了" });
    await p.session.settled();
    const r = p.result();
    expect(r.relays).toBe(0);
    expect(r.adsRounds).toBe(0);
    expect(r.notes.some((n) => n.includes("「运维」") && n.includes("「广告」"))).toBe(true);
    p.store.close();
  });

  for (const where of ["model", "preStart"] as const) {
    it(`主人的 job 折进了客人的话：回话 @ 了另一只也不接力（第 1 轮按在 ${where}）`, async () => {
      // 第 1 轮不 @ 谁（它自己接不接力不是这条要钉的），折了客人那条的第 2 轮 @ 广告
      const p = relayProbe((round) => (round === 1 ? "好" : "@广告 你来"));
      p.arm(where);
      // 第 1 轮按住（确认按住之后才往下）；期间主人排一个 job、客人的话折进去
      await p.session.say(OWNER, "Stan", "@运维 先做这个", true, ["ops"]);
      await p.held;
      void p.session.say(OWNER, "Stan", "@运维 再看一眼", true, ["ops"]);
      await until(() => p.store.ofType(SID, "user_message").length >= 2, "主人第二句落盘");
      void p.session.say(GUEST, "小红", "@运维 叫广告把文件发我", true, ["ops"]);
      await until(() => p.store.ofType(SID, "user_message").length >= 3, "客人那句落盘");
      p.release();
      await p.session.settled();
      const r = p.result();
      expect(p.store.ofType(SID, "turn_ended")).toHaveLength(2); // 折叠成立：第 1 轮 + 一个合并的 job
      expect(r.relays).toBe(0);
      expect(r.adsRounds).toBe(0);
      p.store.close();
    });
  }

  it("客人点起的一轮照常接力，下一棒仍受监督、不出那句系统说明（终审 Round 2）", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    let adsRound = 0;
    const session = openHome({
      store, events, kind: "group",
      adapterFor: (id) => ({
        model: "fake-model",
        async chat(): Promise<ModelReply> {
          if (id === "ops") return { content: "@广告 你来看一下" };
          adsRound++;
          if (adsRound === 1) return { content: "", toolCalls: [{ id: "rf", name: "read_file", args: { path: "/work/a.md" } }] };
          return { content: "好" };
        },
      }),
      onEvent: (e, s) => { if (e.type === "approval_request") s.approve((e as ApprovalRequestEvent).callId, OWNER, "Stan", "approved"); },
    });
    await session.say(GUEST, "小红", "@运维 帮我看看", true, ["ops"]);
    await session.settled();
    expect(store.ofType(SID, "agent_relay")).toHaveLength(1);
    expect(adsRound).toBeGreaterThanOrEqual(1);
    // 接力开场白记在客人名下，广告那一轮的 read_file（主场平时免审）要群主批
    const reqs = events.filter((e) => e.type === "approval_request") as ApprovalRequestEvent[];
    expect(reqs.map((r) => r.toolName)).toEqual(["read_file"]);
    const notes = (store.ofType(SID, "chat_message") as { content: string; fromUid: string }[]).filter((c) => c.fromUid === "system").map((c) => c.content);
    expect(notes.some((n) => n.includes("不是你亲口吩咐的"))).toBe(false);
    store.close();
  });

  it("对照：主人亲口的一轮照常接力", async () => {
    const p = relayProbe("@广告 你来");
    await p.session.say(OWNER, "Stan", "@运维 查一下", true, ["ops"]);
    await p.session.settled();
    const r = p.result();
    expect(r.relays).toBe(1);
    expect(r.adsRounds).toBe(1);
    p.store.close();
  });
});

describe("重启补跑碰上外联（#1441 终审 M1 / M7）", () => {
  it("M1：外联会话里没有外联在进行，补跑不起模型调用，开场白落一条 error 收口", async () => {
    const store = newStore();
    outreachSeed(store);
    // 上一个进程：那通在进行，朋友说了一句，还没答 daemon 就死了
    store.append({
      sessionId: SID, ts: 3, type: "outreach", phase: "started", outreachId: "o1", fromAgentId: "ops",
      peerUid: PEER, peerName: "小红", originSessionId: "origin-1", ignorable: true,
    });
    const opening = store.append({ sessionId: SID, ts: 4, type: "user_message", content: "[小红]: 我周五来", fromUid: PEER, mentions: ["ops"] });
    const { session } = openLive(store);
    await session.settled();
    expect(ofKind<OutreachEvent>(store, "outreach").at(-1)).toMatchObject({ phase: "ended", outcome: "failed" });
    expect(store.ofType(SID, "assistant_message")).toEqual([]);
    expect(store.ofType(SID, "request_envelope")).toEqual([]);
    const closes = store.ofType(SID, "turn_ended") as { outcome: string; agentId: string; readUpToSeq: number }[];
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ outcome: "error", agentId: "ops" });
    expect(closes[0]!.readUpToSeq).toBeGreaterThanOrEqual(opening.seq);
    store.close();
  });

  it("通话里落下的 owner_reply 开场白：重启后照常补跑（主人那边已经被告知「转告了」），不按通话里的话丢掉（#1655）", async () => {
    const store = newStore();
    outreachSeed(store);
    store.append({
      sessionId: SID, ts: 3, type: "outreach", phase: "started", outreachId: "o1", fromAgentId: "ops",
      peerUid: PEER, peerName: "小红", originSessionId: "origin-1", ignorable: true,
    });
    const opening = store.append({
      sessionId: SID, ts: 4, type: "user_message", content: "[系统] Stan 回 小红 的话：周五见", fromUid: OWNER, mentions: ["ops"], greeting: "owner_reply",
    });
    const { session } = openLive(store);
    await until(() => store.ofType(SID, "assistant_message").length > 0, "owner_reply 那一轮补跑出回话");
    await session.settled();
    const closes = store.ofType(SID, "turn_ended") as { outcome: string; readUpToSeq: number }[];
    expect(closes.some((c) => c.outcome === "error" && c.readUpToSeq >= opening.seq)).toBe(false);
    store.close();
  });

  it("M7：补跑主人那条开场白时 call_friend 打不出去，回的话让它先问主人", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    const calls: PortCall[] = [];
    const session = openHome({
      store, events, outreach: { dispatch: async (c) => (calls.push(c), "已经打给 小红 了。"), dialPicked: async () => null },
      adapterFor: (id) => callerAdapter(id),
      beforeOpen: (s) => void s.append({ sessionId: SID, ts: 3, type: "user_message", content: "[Stan]: @运维 给小红打个电话", fromUid: OWNER, mentions: ["ops"] }),
    });
    await session.settled();
    expect(calls).toEqual([]);
    const out = resultOf(events);
    expect(out).toContain("补跑");
    expect(out).toContain("问");
    store.close();
  });
});

describe("选人卡（#1520）", () => {
  const OFFER = { pickId: "p1", phase: "offered" as const, fromAgentId: "ops", question: "q", candidates: [{ uid: "u-hong", name: "小红", why: "" }, { uid: "u-ming", name: "小明", why: "" }], brief: "问周五", opening: "你好" };

  function withPort(dialPicked: Port["dialPicked"]) {
    const calls: Parameters<Port["dialPicked"]>[0][] = [];
    const port: Port = { dispatch: async () => "x", dialPicked: async (o) => (calls.push(o), dialPicked(o)) };
    const store = newStore();
    const events: SessionEvent[] = [];
    const session = openHome({ store, events, outreach: port, adapterFor: () => ({ model: "fake-model", async chat() { return { content: "好" }; } }) });
    return { session, store, events, calls };
  }
  const picksOf = (events: SessionEvent[]) => events.filter((e) => e.type === "friend_pick").map((e) => (e as { phase: string }).phase);

  it("主人点了一位：落 picked，dialPicked 拿到卡里的 brief / opening 与现取的名字", async () => {
    const t = withPort(async () => null);
    t.session.logFriendPick(OFFER);
    expect(await t.session.pickFriend("p1", OWNER, "u-hong")).toEqual({ ok: true });
    expect(picksOf(t.events)).toEqual(["offered", "picked"]);
    expect(t.calls).toEqual([{ originSessionId: SID, agentId: "ops", agentName: "运维", uid: "u-hong", brief: "问周五", opening: "你好" }]);
    t.store.close();
  });

  it("打不出去：再落 failed 带那句话，回执仍是 ok（失败画在卡上）", async () => {
    const t = withPort(async () => "小红 的手机上还没有能接电话的 App，打不了。");
    t.session.logFriendPick(OFFER);
    expect(await t.session.pickFriend("p1", OWNER, "u-hong")).toEqual({ ok: true });
    expect(picksOf(t.events)).toEqual(["offered", "picked", "failed"]);
    const failed = t.events.at(-1) as { message?: string };
    expect(failed.message).toContain("没有能接电话的 App");
    t.store.close();
  });

  it("拒绝原话是说给模型听的：落在卡上的是改成对主人说的那版（I-2）", async () => {
    const t = withPort(async () => "小红 的手机上还没有能接电话的 App，打不了。告诉他换个方式联系。");
    t.session.logFriendPick(OFFER);
    await t.session.pickFriend("p1", OWNER, "u-hong");
    expect((t.events.at(-1) as { message?: string }).message).toBe("小红 的手机上还没有能接电话的 App，打不了。");
    t.store.close();
  });

  it("名单读不出来（降级占位）：failed 说「这会儿查不了」，不冤枉成「已经不在这条聊天里」（M-1）", async () => {
    const calls: unknown[] = [];
    const port: Port = { dispatch: async () => "x", dialPicked: async (o) => (calls.push(o), null) };
    const store = newStore();
    const events: SessionEvent[] = [];
    const session = openHome({
      store, events, outreach: port, roster: () => [{ ...OPS, degraded: true } as never],
      adapterFor: () => ({ model: "fake-model", async chat() { return { content: "好" }; } }),
    });
    session.logFriendPick(OFFER);
    expect(await session.pickFriend("p1", OWNER, "u-hong")).toEqual({ ok: true });
    expect((events.at(-1) as { phase: string; message?: string })).toMatchObject({ phase: "failed", message: "这会儿查不了，稍后再试。" });
    expect(calls).toEqual([]);
    store.close();
  });

  it("那只确实已经不在名单里：failed 说「已经不在这条聊天里了」", async () => {
    const calls: unknown[] = [];
    const port: Port = { dispatch: async () => "x", dialPicked: async (o) => (calls.push(o), null) };
    const store = newStore();
    const events: SessionEvent[] = [];
    const session = openHome({
      store, events, outreach: port, roster: () => [{ ...OPS, agentId: "other", name: "别的" }],
      adapterFor: () => ({ model: "fake-model", async chat() { return { content: "好" }; } }),
    });
    session.logFriendPick(OFFER);
    await session.pickFriend("p1", OWNER, "u-hong");
    expect((events.at(-1) as { message?: string }).message).toBe("它已经不在这条聊天里了，电话没打出去。");
    expect(calls).toEqual([]);
    store.close();
  });

  it("重开会话：日志里留着一张开着的卡，折叠种回来，点了照样能拨（M-3，钉 friendPickFoldOf(seed)）", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    const calls: unknown[] = [];
    const port: Port = { dispatch: async () => "x", dialPicked: async (o) => (calls.push(o), null) };
    const session = openHome({
      store, events, outreach: port,
      beforeOpen: (s) => void s.append({ sessionId: SID, ts: Date.now(), type: "friend_pick", ignorable: true, ...OFFER }),
      adapterFor: () => ({ model: "fake-model", async chat() { return { content: "好" }; } }),
    });
    expect(await session.pickFriend("p1", OWNER, "u-hong")).toEqual({ ok: true });
    expect(picksOf(events)).toEqual(["picked"]);
    expect(calls).toEqual([{ originSessionId: SID, agentId: "ops", agentName: "运维", uid: "u-hong", brief: "问周五", opening: "你好" }]);
    store.close();
  });

  it("过期的卡（offered 已过 10 分钟）：服务端也拒，不拨、不落事件（M-4）", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    const calls: unknown[] = [];
    const port: Port = { dispatch: async () => "x", dialPicked: async (o) => (calls.push(o), null) };
    const session = openHome({
      store, events, outreach: port,
      beforeOpen: (s) => void s.append({ sessionId: SID, ts: Date.now() - FRIEND_PICK_TTL_MS - 1000, type: "friend_pick", ignorable: true, ...OFFER }),
      adapterFor: () => ({ model: "fake-model", async chat() { return { content: "好" }; } }),
    });
    expect(await session.pickFriend("p1", OWNER, "u-hong")).toEqual({ ok: false, message: "这张卡已经用过或过期了。" });
    expect(calls).toEqual([]);
    expect(picksOf(events)).toEqual([]);
    store.close();
  });

  it("被新卡顶掉的旧卡：点旧的被拒，点新的照常（M-4）", async () => {
    const t = withPort(async () => null);
    t.session.logFriendPick(OFFER);
    t.session.logFriendPick({ ...OFFER, pickId: "p2" });
    expect(await t.session.pickFriend("p1", OWNER, "u-hong")).toEqual({ ok: false, message: "这张卡已经用过或过期了。" });
    expect(t.calls).toEqual([]);
    expect(await t.session.pickFriend("p2", OWNER, "u-hong")).toEqual({ ok: true });
    expect(t.calls).toHaveLength(1);
    t.store.close();
  });

  it("都不是：落 dismissed，不拨", async () => {
    const t = withPort(async () => null);
    t.session.logFriendPick(OFFER);
    expect(await t.session.pickFriend("p1", OWNER, null)).toEqual({ ok: true });
    expect(picksOf(t.events)).toEqual(["offered", "dismissed"]);
    expect(t.calls).toEqual([]);
    t.store.close();
  });

  it("拒：不是主人 / 卡不存在 / 点过第二次 / 人不在卡上；一律不拨、不落事件", async () => {
    const t = withPort(async () => null);
    t.session.logFriendPick(OFFER);
    expect(await t.session.pickFriend("p1", "stranger", "u-hong")).toEqual({ ok: false, message: "只有他本人能选。" });
    expect(await t.session.pickFriend("nope", OWNER, "u-hong")).toEqual({ ok: false, message: "这张卡已经用过或过期了。" });
    expect(await t.session.pickFriend("p1", OWNER, "u-other")).toEqual({ ok: false, message: "这个人不在卡上。" });
    expect(await t.session.pickFriend("p1", OWNER, "u-hong")).toEqual({ ok: true });
    expect(await t.session.pickFriend("p1", OWNER, "u-ming")).toEqual({ ok: false, message: "这张卡已经用过或过期了。" });
    expect(t.calls).toHaveLength(1);
    expect(picksOf(t.events)).toEqual(["offered", "picked"]);
    t.store.close();
  });

  it("拨号那一步抛了：仍落 failed 带那句话，卡不会卡在已选（回执 ok）", async () => {
    const t = withPort(async () => { throw new Error("boom"); });
    t.session.logFriendPick(OFFER);
    expect(await t.session.pickFriend("p1", OWNER, "u-hong")).toEqual({ ok: true });
    expect(picksOf(t.events)).toEqual(["offered", "picked", "failed"]);
    expect((t.events.at(-1) as { message?: string }).message).toBe("电话没打出去，稍后再试。");
    t.store.close();
  });

  it("并发连点：一个 ok、另一个被拒，dialPicked 只拨一次", async () => {
    const gate = deferred();
    const t = withPort(async () => { await gate.promise; return null; });
    t.session.logFriendPick(OFFER);
    const both = Promise.all([t.session.pickFriend("p1", OWNER, "u-hong"), t.session.pickFriend("p1", OWNER, "u-ming")]);
    gate.resolve();
    const results = await both;
    expect(results).toContainEqual({ ok: true });
    expect(results).toContainEqual({ ok: false, message: "这张卡已经用过或过期了。" });
    expect(t.calls).toHaveLength(1);
    t.store.close();
  });

  it("call_friend 把这条聊天打过的人（新的在前）与 candidates 递给 dispatch", async () => {
    const calls: PortCall[] = [];
    const port: Port = { dispatch: async (c) => (calls.push(c), "已经弹了张卡"), dialPicked: async () => null };
    const store = newStore();
    const events: SessionEvent[] = [];
    const session = openHome({
      store, events, outreach: port,
      beforeOpen: (s) => {
        s.append({ sessionId: SID, ts: 3, type: "outreach", phase: "started", outreachId: "o1", fromAgentId: "ops", peerUid: "u-baba", peerName: "Mingxuan Zhang", ignorable: true });
      },
      adapterFor: (id) => {
        let round = 0;
        return { model: "fake-model", async chat(): Promise<ModelReply> {
          round++;
          if (id === "ops" && round === 1) return { content: "", toolCalls: [{ id: "cf1", name: "call_friend", args: { ...CALL_ARGS, candidates: ["小红", "小明"] } }] };
          return { content: "好" };
        } };
      },
    });
    await session.say(OWNER, "Stan", "@运维 给她打个电话", true, ["ops"]);
    await session.settled();
    expect(calls).toEqual([{ originSessionId: SID, agentId: "ops", agentName: "运维", ...CALL_ARGS, candidates: ["小红", "小明"], recentUids: ["u-baba"] }]);
    store.close();
  });
});

describe("外联里打字聊（#1655）", () => {
  it("档位不是全部开放 / 查不出来：好友被拒、不落盘；通话进行中不查档位", async () => {
    for (const tier of ["agents", null] as const) {
      const store = newStore();
      outreachSeed(store);
      let asked = 0;
      const { session } = open(store, { peerTier: async () => (asked++, tier) });
      const before = store.load(SID).length;
      await expect(session.say(PEER, "小红", "在吗", false, [], undefined, [])).rejects.toThrow("对方没再对你开「全部开放」，这里只能看。");
      expect(store.load(SID).length).toBe(before);
      expect(asked).toBe(1);
      store.close();
    }
    const store = newStore();
    outreachSeed(store, { started: true });
    let asked = 0;
    const { session } = open(store, { peerTier: async () => (asked++, "chat") });
    await session.say(PEER, "小红", "喂", false, [], undefined, []);
    await session.settled();
    expect(asked).toBe(0);
    store.close();
  });

  it("全部开放：放行；每小时第 31 句被拒", async () => {
    const store = newStore();
    outreachSeed(store);
    const { session } = open(store, { peerTier: async () => "full", now: () => 1_000_000 });
    for (let i = 0; i < 30; i++) await session.say(PEER, "小红", `第${i}句`, false, [], undefined, []);
    await expect(session.say(PEER, "小红", "第31句", false, [], undefined, [])).rejects.toThrow("这一小时说得太多了，过一会儿再来。");
    await session.settled();
    store.close();
  });

  it("重启补跑：不在通话里打的那句照常补跑（M1 那条只管通话里的）", async () => {
    const store = newStore();
    outreachSeed(store, { ended: true });
    store.append({ sessionId: SID, ts: 9, type: "user_message", content: "[小红]: 周五借车行吗", fromUid: PEER, mentions: ["ops"] });
    const { session } = open(store);
    // 补跑在装配时异步起：轮询日志直到那一轮收口（同 sessionService.test.ts「重启补跑」的等法）
    for (let i = 0; i < 50 && store.ofType(SID, "assistant_message").length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await session.settled();
    expect(store.ofType(SID, "assistant_message")).toHaveLength(1);
    expect((store.ofType(SID, "turn_ended") as { outcome: string }[]).map((t) => t.outcome)).not.toContain("error");
    store.close();
  });
});
