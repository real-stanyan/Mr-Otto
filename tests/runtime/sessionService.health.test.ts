// read_health 进不进工具表（#1656）：主人亲口 + 手机在线才有；定时任务没有；没接 health 没有。调了之后结果落 tool_result。
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
import type { HealthGateway } from "../../services/runtime/src/healthTool.js";
import { EventStore } from "../../src/session/store.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import type { ToolResultEvent } from "../../src/session/events.js";
import { tempDir } from "../helpers/tempDir.js";

const OWNER = "owner";
const SID = "s-health";
const HELPER = { agentId: "a_000000000001", name: "助手", description: "", instructions: "", models: ["fake-model"], tools: [], domain: "dev" };
const fakeWorld: ExecutionWorld = { fs: { read: async () => "", write: async () => {} }, exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }), http: { postJson: async () => ({}) } };
const FIRED = Date.UTC(2026, 9, 5, 1, 0);
const ROUTINE = { routineId: "r1", title: "早报", instruction: "看一眼", tz: "Asia/Shanghai", firedAt: FIRED, agentId: HELPER.agentId };

/** 第一圈记工具表；callHealth 时第一圈调 read_health，第二圈收口 */
function adapter(seen: string[][], callHealth = false): ModelAdapter {
  let n = 0;
  return {
    model: "fake-model",
    async chat(_m, tools): Promise<ModelReply> {
      seen.push((tools ?? []).map((t) => t.name));
      n++;
      if (callHealth && n === 1) return { content: "", toolCalls: [{ id: "h1", name: "read_health", args: { metrics: ["steps"], from: "2026-10-04", to: "2026-10-04" } }] };
      return { content: "好" };
    },
  };
}

function open(o: { adapter: ModelAdapter; health?: HealthGateway; approveAll?: boolean }) {
  const store = new EventStore(join(tempDir("mrotto-runtime-health-"), "session.db"));
  store.append({ sessionId: SID, ts: 1, type: "session_created", workspace: "/work", cloud: { workspaceId: "home", home: true, chat: { kind: "dm" } } });
  const opts: CloudSessionOpts = {
    sessionMeta: createInMemoryCloudSessionMeta(),
    workspaceId: "home", sessionId: SID, ownerUid: OWNER, createdByUid: OWNER, store, world: fakeWorld,
    agents: async () => [HELPER], adapterFor: () => o.adapter, px: { edgeBase: "https://edge.example", runtimeSecret: "sek" },
    hostUids: async () => [OWNER], onEvent: () => {}, onUsage: () => {},
    wiki: createWikiService({ workspaceId: "home", fs: createMemoryWikiFs(), journal: createInMemoryWikiJournal(), legacyMemories: async () => [], agentNames: async () => new Map(), isRunning: async () => true }),
    mentionInbox: createInMemoryMentionInbox(), agentWriter: createInMemoryAgentWriter(), isMember: async () => true, contextWindowOf: () => undefined,
    sandboxApproval: async () => "ask", workspaceLock: createWorkspaceLock(), relayRemainingMicro: async () => null,
    diskUsage: () => null, onOutreachEnded: null, signSpeechTicket: async () => "t", pairMessages: null, outreach: null, approveAll: o.approveAll ?? true, callback: null,
    routines: createInMemoryRoutineStore(),
    ...(o.health !== undefined ? { health: o.health } : {}),
  };
  return { session: createCloudSession(opts), store };
}

const online: HealthGateway = {
  cidOf: (uid) => (uid === OWNER ? "c1" : null),
  request: async () => ({ ok: true, days: [{ date: "2026-10-04", steps: 8231 }], workouts: [] }),
};

describe("read_health 的挂载", () => {
  it("主人亲口 + 手机在线：有；调了结果落 tool_result", async () => {
    const seen: string[][] = [];
    const { session, store } = open({ adapter: adapter(seen, true), health: online });
    await session.say(OWNER, "小明", "我今天走了多少步", true, [HELPER.agentId], undefined, []);
    await session.settled();
    expect(seen[0]).toContain("read_health");
    const r = store.load(SID).find((e): e is ToolResultEvent => e.type === "tool_result" && e.toolCallId === "h1")!;
    expect(r.status).toBe("ok");
    expect(r.output).toContain("步数 8231");
    store.close();
  });
  it("手机不在线：没有", async () => {
    const seen: string[][] = [];
    const { session, store } = open({ adapter: adapter(seen), health: { ...online, cidOf: () => null } });
    await session.say(OWNER, "小明", "嗨", true, [HELPER.agentId], undefined, []);
    await session.settled();
    expect(seen[0]).not.toContain("read_health");
    store.close();
  });
  it("定时任务那一轮：没有", async () => {
    const seen: string[][] = [];
    const { session, store } = open({ adapter: adapter(seen), health: online });
    await session.runRoutine(ROUTINE);
    await session.settled();
    expect(seen[0]).not.toContain("read_health");
    store.close();
  });
  it("没接 health：没有", async () => {
    const seen: string[][] = [];
    const { session, store } = open({ adapter: adapter(seen) });
    await session.say(OWNER, "小明", "嗨", true, [HELPER.agentId], undefined, []);
    await session.settled();
    expect(seen[0]).not.toContain("read_health");
    store.close();
  });
  it("招呼那一轮（系统替主人落的开场白，带着主人的 fromUid）：没有", async () => {
    const seen: string[][] = [];
    const { session, store } = open({ adapter: adapter(seen), health: online });
    session.greetNewAgent(HELPER.agentId, HELPER.name, OWNER);
    await session.settled();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).not.toContain("read_health");
    store.close();
  });
  it("主人开口、但手机连在别的人名下：没有", async () => {
    const seen: string[][] = [];
    const { session, store } = open({ adapter: adapter(seen), health: { ...online, cidOf: (uid) => (uid === "someone-else" ? "c9" : null) } });
    await session.say(OWNER, "小明", "嗨", true, [HELPER.agentId], undefined, []);
    await session.settled();
    expect(seen[0]).not.toContain("read_health");
    store.close();
  });
  // 只测团队会话：主场里别人的话折进来会把这一轮的每把刀掀成要主人批（tightenSupervision），测试里没人批会一直等；
  // 团队会话没有审批兜底（tightenSupervision 直接返回），正是 tightenHealth + 调用口那一闸要挡的地方
  it("团队会话：一轮跑着时别人的话落进来，这一轮读不了发起人的手机（调用口落闸）", async () => {
    let asked = 0;
    const gateway: HealthGateway = { ...online, request: async () => { asked++; return { ok: true, days: [], workouts: [] }; } };
    let session!: ReturnType<typeof open>["session"];
    let n = 0;
    const a: ModelAdapter = {
      model: "fake-model",
      async chat(): Promise<ModelReply> {
        n++;
        if (n === 1) {
          // 等 say 本身返回：别人的话落进日志是它返回前的事，不靠睡一会儿碰运气
          await session.say("friend", "小红", "我也想问", true, [HELPER.agentId], undefined, []);
          return { content: "", toolCalls: [{ id: "f1", name: "read_file", args: { path: "a.txt" } }] };
        }
        if (n === 2) return { content: "", toolCalls: [{ id: "h2", name: "read_health", args: { metrics: ["steps"], from: "2026-10-04", to: "2026-10-04" } }] };
        return { content: "好" };
      },
    };
    const o = open({ adapter: a, health: gateway, approveAll: false });
    session = o.session;
    await session.say(OWNER, "小明", "我今天走了多少步", true, [HELPER.agentId], undefined, []);
    await session.settled();
    const r = o.store.load(SID).find((e): e is ToolResultEvent => e.type === "tool_result" && e.toolCallId === "h2")!;
    expect(r.status).toBe("error");
    expect(r.output).toContain("不是他一个人亲口问的");
    expect(asked).toBe(0);
    o.store.close();
  });
});
