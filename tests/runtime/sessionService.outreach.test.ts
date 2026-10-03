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
import type { ApprovalRequestEvent, AssistantMessageEvent, CallRingEvent, OutreachEvent, RequestEnvelopeEvent, SessionEvent, UserMessageEvent, VoiceCallChangedEvent } from "../../src/session/events.js";
import type { OutreachEnded, OutreachStart } from "../../services/runtime/src/outreachRun.js";
import { SPEECH_TICKET_TTL_MS, type SpeechTicket } from "../../src/shared/speechTicket.js";
import { OUTREACH_CAP_MS } from "../../src/shared/outreach.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
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
    diskUsage: () => null, onOutreachEnded: null, signSpeechTicket: async () => "t", outreach: null, approveAll: true, callback: null,
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

function openLive(store: EventStore, o: { endedTo?: OutreachEnded[] | null; watching?: () => boolean; devices?: number; team?: (typeof OPS)[]; reply?: (agentId: string) => string; sign?: NonNullable<CloudSessionOpts["signSpeechTicket"]> } = {}) {
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
    diskUsage: () => null, approveAll: true,
    callback: {
      isWatching: o.watching ?? (() => true),
      deviceCount: async () => o.devices ?? 1,
      push: async (uid) => {
        pushes.push(uid);
        return 1;
      },
    },
    onOutreachEnded: ended === null ? null : (r) => ended.push(r), signSpeechTicket: o.sign ?? (async () => "t"),
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
  it("装配之后才 startOutreach：说话从被拒变成放行，chat().outreach.active 变 true；收尾后又被拒", async () => {
    const store = newStore();
    outreachSeed(store); // 一通都没开过
    const { session } = openLive(store);
    await expect(session.say(PEER, "小红", "喂", false, [], undefined, [])).rejects.toThrow("这通电话已经结束了");
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
    await expect(session.say(PEER, "小红", "还在吗", false, [], undefined, [])).rejects.toThrow("这通电话已经结束了");
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
    expect(ofKind<OutreachEvent>(store, "outreach")[1]).toMatchObject({ outcome: "failed" });
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
  let session!: CloudSession;
  session = createCloudSession({
    sessionMeta: createInMemoryCloudSessionMeta(),
    workspaceId: "w1", sessionId: SID, ownerUid: OWNER, createdByUid: OWNER, store: o.store, world: fakeWorld,
    agents: async () => [OPS, ADS], adapterFor: (a) => o.adapterFor(a.agentId), px,
    hostUids: async () => [OWNER],
    onEvent: (e) => {
      o.events.push(e);
      o.onEvent?.(e, session);
    },
    onUsage: () => {}, wiki: testWiki(), mentionInbox: createInMemoryMentionInbox(),
    agentWriter: createInMemoryAgentWriter(), isMember: async (uid) => uid === OWNER, contextWindowOf: () => undefined,
    sandboxApproval: async () => "ask", workspaceLock: createWorkspaceLock(), relayRemainingMicro: async () => null,
    diskUsage: () => null, onOutreachEnded: null, signSpeechTicket: async () => "t", approveAll: !team, callback: null,
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
    const port: Port = { dispatch: async (c) => (calls.push(c), "已经打给 小红 了。") };
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
      diskUsage: () => null, onOutreachEnded: null, signSpeechTicket: async () => "t", approveAll: true, callback: null, outreach: portProbe().port,
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
    expect(calls).toEqual([{ originSessionId: SID, agentId: "ops", agentName: "运维", ...CALL_ARGS }]);
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
    expect(resultOf(events)).toContain("亲口");
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
  /** ops 的第 1 轮卡在 gate 上；期间排进两条开场白，第二条折进第一条排队的 job。放开之后第 2 轮依次
      read_file → call_friend → 说话。回的是第 2 轮每次请求里模型看得见的工具名、批过的卡、dispatch 次数 */
  async function fold(kind: "dm" | "group", first: (s: CloudSession) => void, second: (s: CloudSession) => void) {
    const store = newStore();
    const events: SessionEvent[] = [];
    const dispatched: PortCall[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let round = 0;
    const visible: string[][] = [];
    const session = openHome({
      store, events, kind,
      outreach: { dispatch: async (c) => (dispatched.push(c), "已经打过去了") },
      adapterFor: (id) => ({
        model: "fake-model",
        async chat(_m, defs): Promise<ModelReply> {
          if (id !== "ops") return { content: "好" };
          round++;
          if (round === 1) { await gate; return { content: "好" }; }
          visible.push((defs ?? []).map((d) => d.name));
          if (round === 2) return { content: "", toolCalls: [{ id: "rf", name: "read_file", args: { path: "/work/a.md" } }] };
          if (round === 3 && (defs ?? []).some((d) => d.name === "call_friend")) return { content: "", toolCalls: [{ id: "cf", name: "call_friend", args: CALL_ARGS }] };
          return { content: "好" };
        },
      }),
      onEvent: (e, s) => { if (e.type === "approval_request") s.approve((e as ApprovalRequestEvent).callId, OWNER, "Stan", "approved"); },
    });
    await session.say(OWNER, "Stan", "@运维 先做这个", true, ["ops"]);
    first(session);
    // reportOutreach 读名单是异步的：等它的开场白落了盘再排下一条，次序才是确定的
    for (let i = 0; i < 50 && store.ofType(SID, "user_message").length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    second(session);
    for (let i = 0; i < 50 && store.ofType(SID, "user_message").length < 3; i++) await new Promise((r) => setTimeout(r, 5));
    release();
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
});
