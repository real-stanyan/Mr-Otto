// 管理员是唯一入口 + 分级闸在 runtime 里的样子（#1571 第二轮，ADR-0365 / ADR-0366）。钉的是：
// ① 主场里没点名的话一律到管理员（不再让分类器挑）；主人点了名的专员（在名单里）照旧；
// ② 主场群里的客人点谁都改成管理员；
// ③ 接力方向：L1 → L1 丢掉并落旁白，L0 → L1、L1 → L0 照旧；团队会话不判；
// ④ 工具面：专员看不见域外的刀、看不见对外的刀；管理员全有、多 bring_agent / dismiss_agent；
// ⑤ brief 里带分级那一段，只在主场；
// ⑥ bring_agent 把专员拉进管理员那条私聊（名单事件 + onRosterChanged），dismiss_agent 请出去。
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { createCloudSession, type CloudSession, type CloudSessionOpts } from "../../services/runtime/src/sessionService.js";
import { createWikiService, type WikiService } from "../../services/runtime/src/wikiService.js";
import { createMemoryWikiFs } from "../../services/runtime/src/wikiFs.js";
import { createInMemoryWikiJournal } from "../../services/runtime/src/wikiJournal.js";
import { EventStore } from "../../src/session/store.js";
import type { SessionEvent, ChatRosterChangedEvent } from "../../src/session/events.js";
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

const fakeWorld: ExecutionWorld = {
  fs: { read: async (path) => `<content of ${path}>`, write: async () => {} },
  exec: async () => ({ stdout: "hi", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};
const px: PxCallDeps = { edgeBase: "https://edge.example", runtimeSecret: "sek" };
const ADMIN = { agentId: "admin", name: "管理员", description: "", instructions: "", models: ["m"], tools: [] as AgentToolAllow[], tier: 0 as AgentTier, domain: "admin" };
const TRAVEL = { agentId: "a_travel", name: "出行", description: "管出行", instructions: "", models: ["m"], tools: [] as AgentToolAllow[], tier: 1 as AgentTier, domain: "travel" };
const DEV = { agentId: "a_dev", name: "码农", description: "写代码", instructions: "", models: ["m"], tools: [] as AgentToolAllow[], tier: 1 as AgentTier, domain: "dev" };
const BOOK = { agentId: "a_book", name: "订票员", description: "", instructions: "", models: ["m"], tools: [] as AgentToolAllow[], tier: 2 as AgentTier, domain: "travel", parentAgentId: "a_travel" };
const TEAM = [ADMIN, TRAVEL, DEV, BOOK];
type Spec = typeof ADMIN | typeof TRAVEL | typeof DEV | typeof BOOK;

function newStore(): EventStore {
  return new EventStore(join(tempDir("mrotto-runtime-tiers-"), "session.db"));
}
function testWiki(): WikiService {
  return createWikiService({ workspaceId: "w1", fs: createMemoryWikiFs(), journal: createInMemoryWikiJournal(), legacyMemories: async () => [], agentNames: async () => new Map(), isRunning: async () => true });
}

/** 主场（approveAll）里的一条会话：先落 session_created + 名单，再装配 */
function open(store: EventStore, o: {
  roster: string[];
  kind?: "dm" | "group";
  home?: boolean;
  humans?: { uid: string; name: string }[];
  team?: Spec[];
  reply?: (agentId: string, tools: string[]) => ModelReply;
  seen?: string[];
  events?: SessionEvent[];
  onRosterChanged?: CloudSessionOpts["onRosterChanged"];
}): CloudSession {
  const home = o.home ?? true;
  store.append({ sessionId: "s1", ts: 1, type: "session_created", workspace: "/work", cloud: { workspaceId: "w1", chat: { kind: o.kind ?? "group" }, ...(home ? { home: true } : {}) } });
  store.append({
    sessionId: "s1", ts: 2, type: "chat_roster_changed", ignorable: true,
    agents: o.roster.map((id) => ({ agentId: id, name: TEAM.find((a) => a.agentId === id)!.name })),
    ...(o.humans ? { humans: o.humans } : {}),
  });
  const team = o.team ?? TEAM;
  return createCloudSession({
    diskUsage: () => null, routines: null, onOutreachEnded: null, signSpeechTicket: async () => "t", pairMessages: null, outreach: null, callback: null,
    approveAll: home,
    ...(o.onRosterChanged === undefined ? {} : { onRosterChanged: o.onRosterChanged }),
    sessionMeta: createInMemoryCloudSessionMeta(),
    workspaceId: "w1", sessionId: "s1", ownerUid: "owner", createdByUid: "owner",
    store, world: fakeWorld, px, hostUids: async () => ["owner"],
    agents: async () => team,
    adapterFor: (a): ModelAdapter => ({
      model: "m",
      async chat(_messages, tools): Promise<ModelReply> {
        o.seen?.push(a.agentId);
        return o.reply?.(a.agentId, (tools ?? []).map((t) => t.name)) ?? { content: `${a.name}答` };
      },
    }),
    onEvent: (e) => o.events?.push(e),
    onUsage: () => {},
    wiki: testWiki(),
    mentionInbox: createInMemoryMentionInbox(),
    agentWriter: createInMemoryAgentWriter(),
    isMember: async () => true,
    contextWindowOf: () => undefined,
    sandboxApproval: async () => "ask",
    workspaceLock: createWorkspaceLock(),
    relayRemainingMicro: async () => null,
  });
}

describe("入口：主场里没点名的话到管理员", () => {
  it("主人没 @ 谁：只有管理员跑；@ 了在场的专员：那只跑", async () => {
    const store = newStore();
    const seen: string[] = [];
    const session = open(store, { roster: ["admin", "a_travel"], seen });
    await session.say("owner", "Stan", "明天出游怎么安排", false, undefined);
    await session.settled();
    expect(seen).toEqual(["admin"]);
    await session.say("owner", "Stan", "@出行 几点出发", true, ["a_travel"]);
    await session.settled();
    expect(seen).toEqual(["admin", "a_travel"]);
    store.close();
  });
  it("主场群里的客人点了专员：改成管理员", async () => {
    const store = newStore();
    const seen: string[] = [];
    const session = open(store, { roster: ["admin", "a_travel"], humans: [{ uid: "u_guest", name: "小红" }], seen });
    await session.say("u_guest", "小红", "@出行 帮我看看", true, ["a_travel"]);
    await session.settled();
    expect(seen).toEqual(["admin"]);
    store.close();
  });
  it("团队会话（非主场）：没点名照旧回落名单第一只，不改写", async () => {
    const store = newStore();
    const seen: string[] = [];
    // 名单顺序跟团队名单走（出行在码农前面）：回落的是出行，不是「主场里一律到管理员」那条
    const session = open(store, { roster: ["a_dev", "a_travel"], home: false, seen });
    await session.say("owner", "Stan", "随便说一句", true, undefined);
    await session.settled();
    expect(seen).toEqual(["a_travel"]);
    store.close();
  });
});

describe("接力方向", () => {
  it("L1 → L1 丢掉、落一句旁白；L0 → L1、L1 → L0 照旧", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    const seen: string[] = [];
    const rounds: Record<string, number> = {};
    const session = open(store, {
      roster: ["admin", "a_travel", "a_dev"], seen, events,
      reply: (id) => {
        rounds[id] = (rounds[id] ?? 0) + 1;
        // 每只只在第一轮 @ 人，不然管理员与出行会来回乒乓到棒数上限
        if (rounds[id]! > 1) return { content: "收到" };
        return { content: id === "admin" ? "@出行 你安排" : id === "a_travel" ? "@码农 你写个脚本，@管理员 我接了" : "好" };
      },
    });
    await session.say("owner", "Stan", "安排一下", false, undefined);
    await session.settled();
    // 管理员 → 出行 ✓；出行 → 管理员 ✓；出行 → 码农 ✗
    expect(seen).toEqual(["admin", "a_travel", "admin"]);
    const relays = events.filter((e) => e.type === "agent_relay").map((e) => (e.type === "agent_relay" ? `${e.fromAgentId}>${e.toAgentId}` : ""));
    expect(relays).toEqual(["admin>a_travel", "a_travel>admin"]);
    const note = events.find((e) => e.type === "chat_message" && e.content.includes("不能直接找"));
    expect(note).toBeDefined();
    expect((note as { content: string }).content).toContain("「出行」不能直接找「码农」");
    store.close();
  });
  it("团队会话不判方向：两只专员互相 @ 照旧接力", async () => {
    const store = newStore();
    const seen: string[] = [];
    const session = open(store, { roster: ["a_travel", "a_dev"], home: false, seen, reply: (id) => ({ content: id === "a_travel" ? "@码农 看看" : "好" }) });
    await session.say("owner", "Stan", "@出行 来", true, ["a_travel"]);
    await session.settled();
    expect(seen).toEqual(["a_travel", "a_dev"]);
    store.close();
  });
});

describe("工具面", () => {
  it("专员：只有域里的刀，没有对外的刀；管理员：全有，多拉人 / 请人 / 建人", async () => {
    const store = newStore();
    const tools: Record<string, string[]> = {};
    const session = open(store, {
      roster: ["admin", "a_travel", "a_dev"],
      reply: (id, names) => { tools[id] = names; return { content: "好" }; },
    });
    await session.say("owner", "Stan", "@出行 @码农 @管理员 报到", true, ["a_travel", "a_dev", "admin"]);
    await session.settled();
    expect(tools["a_travel"]).toContain("read_file");
    expect(tools["a_travel"]).toContain("write_file");
    expect(tools["a_travel"]).not.toContain("bash");
    expect(tools["a_dev"]).toContain("bash");
    for (const id of ["a_travel", "a_dev"]) {
      expect(tools[id]).not.toContain("create_agent");
      expect(tools[id]).not.toContain("bring_agent");
      expect(tools[id]).not.toContain("dismiss_agent");
    }
    expect(tools["admin"]).toEqual(expect.arrayContaining(["read_file", "write_file", "bash", "create_agent", "bring_agent", "dismiss_agent", "wiki_read"]));
    store.close();
  });
  it("团队会话：不圈，专员照旧有 bash", async () => {
    const store = newStore();
    const tools: Record<string, string[]> = {};
    const session = open(store, { roster: ["a_travel"], home: false, reply: (id, names) => { tools[id] = names; return { content: "好" }; } });
    await session.say("owner", "Stan", "@出行 来", true, ["a_travel"]);
    await session.settled();
    expect(tools["a_travel"]).toContain("bash");
    store.close();
  });
});

describe("brief 里的分级那一段", () => {
  it("主场：管理员的 brief 写着现有专员与「先判简单」；专员的写着只做本域；团队会话不带", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    const session = open(store, { roster: ["admin", "a_travel"], events });
    await session.say("owner", "Stan", "@管理员 @出行 在吗", true, ["admin", "a_travel"]);
    await session.settled();
    const briefs = events.filter((e) => e.type === "agent_briefed") as { agentId: string; instructions: string }[];
    expect(briefs.find((b) => b.agentId === "admin")!.instructions).toContain("出行：出行");
    expect(briefs.find((b) => b.agentId === "admin")!.instructions).toContain("一句话能答完");
    expect(briefs.find((b) => b.agentId === "a_travel")!.instructions).toContain("「出行」专员");
    store.close();
    const store2 = newStore();
    const events2: SessionEvent[] = [];
    const team = open(store2, { roster: ["a_travel", "a_dev"], home: false, events: events2 });
    await team.say("owner", "Stan", "@出行 在吗", true, ["a_travel"]);
    await team.settled();
    const b2 = events2.filter((e) => e.type === "agent_briefed") as { instructions: string }[];
    expect(b2.every((b) => !b.instructions.includes("专员"))).toBe(true);
    store2.close();
  });
});

describe("bring_agent / dismiss_agent", () => {
  it("管理员那条私聊：拉进专员 → 名单事件 + onRosterChanged；主人能直接 @ 它；请出去之后 @ 不到", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    const seen: string[] = [];
    const written: string[][] = [];
    let step = 0;
    const session = open(store, {
      roster: ["admin"], kind: "dm", seen, events,
      onRosterChanged: async (ids) => { written.push(ids); },
      reply: (id) => {
        if (id !== "admin") return { content: "出行在" };
        step++;
        if (step === 1) return { content: "", toolCalls: [{ id: "t1", name: "bring_agent", args: { name: "出行" } }] };
        if (step === 2) return { content: "拉好了，@出行 你来" };
        if (step === 3) return { content: "", toolCalls: [{ id: "t2", name: "dismiss_agent", args: { name: "出行" } }] };
        return { content: "请走了" };
      },
    });
    await session.say("owner", "Stan", "帮我安排出游", false, undefined);
    await session.settled();
    const roster = events.filter((e): e is ChatRosterChangedEvent => e.type === "chat_roster_changed");
    expect(roster.at(-1)!.agents.map((a) => a.agentId)).toEqual(["admin", "a_travel"]);
    expect(written).toEqual([["admin", "a_travel"]]);
    // 管理员那一轮里两次模型调用（工具调用 + 续写），然后它的回复 @ 出行 → 出行接棒
    expect(seen.filter((id) => id === "a_travel")).toHaveLength(1);
    expect(seen.at(-1)).toBe("a_travel");
    expect(session.chat()?.agentIds).toEqual(["admin", "a_travel"]);
    await session.say("owner", "Stan", "@出行 几点", true, ["a_travel"]);
    await session.settled();
    expect(seen.at(-1)).toBe("a_travel");
    await session.say("owner", "Stan", "可以了", false, undefined);
    await session.settled();
    expect(session.chat()?.agentIds).toEqual(["admin"]);
    expect(written.at(-1)).toEqual(["admin"]);
    store.close();
  });
  it("不能拉子工；拉已经在场的只回一句", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    let step = 0;
    const session = open(store, {
      roster: ["admin", "a_travel"], events,
      reply: (id) => {
        if (id !== "admin") return { content: "好" };
        step++;
        if (step === 1) return { content: "", toolCalls: [{ id: "t1", name: "bring_agent", args: { name: "订票员" } }] };
        if (step === 2) return { content: "", toolCalls: [{ id: "t2", name: "bring_agent", args: { name: "出行" } }] };
        return { content: "好" };
      },
    });
    await session.say("owner", "Stan", "来", false, undefined);
    await session.settled();
    const results = events.filter((e) => e.type === "tool_result").map((e) => (e.type === "tool_result" ? e.output : ""));
    expect(results[0]).toContain("子工");
    expect(results[1]).toContain("已经在这条对话里");
    expect(session.chat()?.agentIds).toEqual(["admin", "a_travel"]);
    store.close();
  });
});
