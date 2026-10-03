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
import type { AssistantMessageEvent, CallRingEvent, OutreachEvent, RequestEnvelopeEvent, SessionEvent, UserMessageEvent, VoiceCallChangedEvent } from "../../src/session/events.js";
import type { OutreachEnded, OutreachStart } from "../../services/runtime/src/outreachRun.js";
import { OUTREACH_CAP_MS } from "../../src/shared/outreach.js";
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
    diskUsage: () => null, onOutreachEnded: null, approveAll: true, callback: null,
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

function openLive(store: EventStore, o: { endedTo?: OutreachEnded[] | null; watching?: () => boolean; devices?: number } = {}) {
  const timers = fakeTimers();
  const ended = o.endedTo === undefined ? [] : o.endedTo;
  const pushes: string[] = [];
  const adapter: ModelAdapter = { model: "fake-model", async chat() { return { content: "好" }; } };
  const opts: CloudSessionOpts = {
    sessionMeta: createInMemoryCloudSessionMeta(),
    workspaceId: "w1", sessionId: SID, ownerUid: OWNER, createdByUid: OWNER, store, world: fakeWorld,
    agents: async () => [OPS], adapterFor: () => adapter, px,
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
    onOutreachEnded: ended === null ? null : (r) => ended.push(r),
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
