// runRoutine / logRoutineNote（#1283，spec §4.2 / §5）：开场白的形状、起 turn、ownerSpoke 为真（schedule_task 亮）、圈数上限只对 routine 轮。
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { createCloudSession, type CloudSessionOpts } from "../../services/runtime/src/sessionService.js";
import { createWikiService } from "../../services/runtime/src/wikiService.js";
import { createMemoryWikiFs } from "../../services/runtime/src/wikiFs.js";
import { createInMemoryWikiJournal } from "../../services/runtime/src/wikiJournal.js";
import { createInMemoryAgentWriter } from "../../services/runtime/src/agentRegistry.js";
import { createInMemoryMentionInbox } from "../../services/runtime/src/mentionInbox.js";
import { createWorkspaceLock } from "../../services/runtime/src/workspaceLock.js";
import { createInMemoryCloudSessionMeta } from "../../services/runtime/src/cloudSessionMeta.js";
import { createInMemoryRoutineStore } from "../../services/runtime/src/routineStore.js";
import { EventStore } from "../../src/session/store.js";
import { ROUTINE_MAX_ROUNDS, SCHEDULE_TASK_TOOL_NAME } from "../../src/shared/routines.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import type { RoutineNoteEvent, TurnEndedEvent, UserMessageEvent } from "../../src/session/events.js";
import { tempDir } from "../helpers/tempDir.js";

const OWNER = "owner";
const SID = "s-routine";
// 主场里专员的工具面按域圈（#1571，ADR-0365）：这份夹具给它 dev 域（整面）——测的是定时任务那三把刀的挂载闸，不是等级
const HELPER = { agentId: "a_000000000001", name: "助手", description: "", instructions: "", models: ["fake-model"], tools: [], domain: "dev" };
const fakeWorld: ExecutionWorld = { fs: { read: async () => "", write: async () => {} }, exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }), http: { postJson: async () => ({}) } };

const FIRED = Date.UTC(2026, 9, 5, 1, 0);
const ROUTINE = { routineId: "r1", title: "早报", instruction: "看一眼报表", tz: "Asia/Shanghai", firedAt: FIRED, agentId: HELPER.agentId };

/** 每圈都调 bash 的模型（永不收口），记下每圈看到的工具表；stopAfter 给了就在那一圈之后收口 */
function busyAdapter(seenTools: string[][], stopAfter?: number): ModelAdapter {
  let n = 0;
  return {
    model: "fake-model",
    async chat(_messages, tools): Promise<ModelReply> {
      seenTools.push((tools ?? []).map((t) => t.name));
      n++;
      if (stopAfter !== undefined && n > stopAfter) return { content: "收工" };
      return { content: "", toolCalls: [{ id: `c${n}`, name: "bash", args: { cmd: `echo ${n}` } }] };
    },
  };
}

function open(o: {
  adapter?: ModelAdapter; routines?: ReturnType<typeof createInMemoryRoutineStore> | null;
  agents?: CloudSessionOpts["agents"]; approveAll?: boolean; chatKind?: "dm" | "group" | "pair";
} = {}) {
  const store = new EventStore(join(tempDir("mrotto-runtime-routine-"), "session.db"));
  store.append({ sessionId: SID, ts: 1, type: "session_created", workspace: "/work", cloud: { workspaceId: "home", home: true, chat: { kind: o.chatKind ?? "dm" } } });
  const fallback: ModelAdapter = { model: "fake-model", async chat() { return { content: "好的" }; } };
  const opts: CloudSessionOpts = {
    sessionMeta: createInMemoryCloudSessionMeta(),
    workspaceId: "home", sessionId: SID, ownerUid: OWNER, createdByUid: OWNER, store, world: fakeWorld,
    agents: o.agents ?? (async () => [HELPER]), adapterFor: () => o.adapter ?? fallback, px: { edgeBase: "https://edge.example", runtimeSecret: "sek" },
    hostUids: async () => [OWNER], onEvent: () => {}, onUsage: () => {},
    wiki: createWikiService({ workspaceId: "home", fs: createMemoryWikiFs(), journal: createInMemoryWikiJournal(), legacyMemories: async () => [], agentNames: async () => new Map(), isRunning: async () => true }),
    mentionInbox: createInMemoryMentionInbox(), agentWriter: createInMemoryAgentWriter(), isMember: async () => true, contextWindowOf: () => undefined,
    sandboxApproval: async () => "ask", workspaceLock: createWorkspaceLock(), relayRemainingMicro: async () => null,
    diskUsage: () => null, onOutreachEnded: null, signSpeechTicket: async () => "t", pairMessages: null, outreach: null, approveAll: o.approveAll ?? true, callback: null,
    routines: o.routines === undefined ? createInMemoryRoutineStore() : o.routines,
  };
  return { session: createCloudSession(opts), store };
}

describe("runRoutine", () => {
  it("落一条 greeting:'routine' 的开场白（fromUid 主人、mentions 那只、正文带时间与任务）并起 turn；回 ok", async () => {
    const { session, store } = open();
    expect(await session.runRoutine(ROUTINE)).toBe("ok");
    await session.settled();
    const log = store.load(SID);
    const opening = log.find((e): e is UserMessageEvent => e.type === "user_message")!;
    expect(opening).toMatchObject({ fromUid: OWNER, mentions: [HELPER.agentId], greeting: "routine", routine: { id: "r1", title: "早报" } });
    expect(opening.content).toContain("现在是 2026-10-05 09:00（Asia/Shanghai，周一）");
    expect(opening.content).toContain("看一眼报表");
    // 不带 tz：正文已经写明了时间与时区；带了的话投影「今天是」会按任务建时的时区算，主人人在别处时日期会跳
    expect("tz" in opening).toBe(false);
    expect(log.some((e) => e.type === "assistant_message")).toBe(true);
    store.close();
  });
  it("那只不在名单里：不落任何事件，回 no_agent；归档了回 archived", async () => {
    const { session, store } = open();
    expect(await session.runRoutine({ ...ROUTINE, agentId: "a_nobody" })).toBe("no_agent");
    expect(store.load(SID).filter((e) => e.type === "user_message")).toEqual([]);
    session.archive("owner");
    expect(await session.runRoutine(ROUTINE)).toBe("archived");
    store.close();
  });
  it("名单读不出来（degraded，一次查询失败）：抛错而不是 no_agent——调度器标 failed 但不停用，下一跳再试；一个事件都不落", async () => {
    const { session, store } = open({ agents: async () => [{ ...HELPER, degraded: true as const }] });
    await expect(session.runRoutine(ROUTINE)).rejects.toThrow("智能体名单读不出来");
    expect(store.load(SID).filter((e) => e.type === "user_message")).toEqual([]);
    store.close();
  });
  it("routine 轮里 schedule_task 亮着（主人亲口）；圈数到 ROUTINE_MAX_ROUNDS 以 error 收口", async () => {
    const seen: string[][] = [];
    const { session, store } = open({ adapter: busyAdapter(seen) });
    await session.runRoutine(ROUTINE);
    await session.settled();
    expect(seen[0]).toContain(SCHEDULE_TASK_TOOL_NAME);
    expect(seen).toHaveLength(ROUTINE_MAX_ROUNDS);
    const ended = store.load(SID).filter((e): e is TurnEndedEvent => e.type === "turn_ended").at(-1)!;
    expect(ended.outcome).toBe("error");
    expect(ended.error).toContain(`跑满 ${ROUTINE_MAX_ROUNDS} 步`);
    store.close();
  });
  it("主人亲口的普通轮不封顶：跑过 ROUTINE_MAX_ROUNDS 圈照样往下走，自己收口才收", async () => {
    const seen: string[][] = [];
    const { session, store } = open({ adapter: busyAdapter(seen, ROUTINE_MAX_ROUNDS + 5) });
    await session.say(OWNER, "小明", "干活", true, [HELPER.agentId], undefined, []);
    await session.settled();
    expect(seen.length).toBeGreaterThan(ROUTINE_MAX_ROUNDS);
    const ended = store.load(SID).filter((e): e is TurnEndedEvent => e.type === "turn_ended").at(-1)!;
    expect(ended.outcome).toBe("completed");
    store.close();
  });
  it("routines 为 null：工具表里没有那三把刀", async () => {
    const seen: string[][] = [];
    const { session, store } = open({ adapter: busyAdapter(seen), routines: null });
    await session.runRoutine(ROUTINE);
    await session.settled();
    expect(seen[0]).not.toContain(SCHEDULE_TASK_TOOL_NAME);
    store.close();
  });
});

describe("三把刀的挂载闸（#1283 终审 I3）", () => {
  const firstTools = async (o: Parameters<typeof open>[0], kick: (s: ReturnType<typeof open>["session"]) => unknown) => {
    const seen: string[][] = [];
    const { session, store } = open({ ...o, adapter: busyAdapter(seen, 0) });
    await kick(session);
    await session.settled();
    store.close();
    // 先确认这一轮真的跑起来了、模型真看到了一张工具表——否则「不含」是空表上的白断言
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!).toContain("bash");
    return seen[0]!;
  };
  it("基线：主场私聊、approveAll、主人亲口——亮", async () => {
    expect(await firstTools({}, (s) => s.runRoutine(ROUTINE))).toContain(SCHEDULE_TASK_TOOL_NAME);
  });
  it("approveAll: false（非主场）：不挂", async () => {
    expect(await firstTools({ approveAll: false }, (s) => s.runRoutine(ROUTINE))).not.toContain(SCHEDULE_TASK_TOOL_NAME);
  });
  it("群聊 / 配对线：不挂", async () => {
    expect(await firstTools({ chatKind: "group" }, (s) => s.runRoutine(ROUTINE))).not.toContain(SCHEDULE_TASK_TOOL_NAME);
    expect(await firstTools({ chatKind: "pair" }, (s) => s.runRoutine(ROUTINE))).not.toContain(SCHEDULE_TASK_TOOL_NAME);
  });
  it("受监督的轮（外联汇报开场白）：主场私聊里挂着但不进模型的工具表", async () => {
    const tools = await firstTools({}, (s) => s.reportOutreach({ agentId: HELPER.agentId, text: "朋友说：帮我每天提醒他", ownerUid: OWNER }));
    expect(tools).not.toContain(SCHEDULE_TASK_TOOL_NAME);
  });
});

describe("logRoutineNote", () => {
  it("落一条 ignorable 的 routine_note，不起 turn", async () => {
    const { session, store } = open();
    session.logRoutineNote({ routineId: "r1", title: "早报", reason: "skipped_quota", plannedAt: FIRED, tz: "Asia/Shanghai" });
    await session.settled();
    const note = store.load(SID).find((e): e is RoutineNoteEvent => e.type === "routine_note")!;
    expect(note).toMatchObject({ routineId: "r1", title: "早报", reason: "skipped_quota", plannedAt: FIRED, tz: "Asia/Shanghai", ignorable: true });
    expect("agentId" in note).toBe(false);
    expect(store.load(SID).some((e) => e.type === "assistant_message")).toBe(false);
    store.close();
  });
});
