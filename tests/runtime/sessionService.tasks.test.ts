// 管理员是唯一入口 + 分级闸在 runtime 里的样子（#1571 第二轮，ADR-0365 / ADR-0367）。钉的是：
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { createCloudSession, type CloudSession, type CloudSessionOpts } from "../../services/runtime/src/sessionService.js";
import { createWikiService, type WikiService } from "../../services/runtime/src/wikiService.js";
import { createMemoryWikiFs } from "../../services/runtime/src/wikiFs.js";
import { createInMemoryWikiJournal } from "../../services/runtime/src/wikiJournal.js";
import { EventStore } from "../../src/session/store.js";
import type { SessionEvent } from "../../src/session/events.js";
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
import { createInMemoryAppStore } from "../../services/runtime/src/appStore.js";

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
const APPS = { agentId: "a_apps", name: "应用专员", description: "做应用", instructions: "", models: ["m"], tools: [] as AgentToolAllow[], tier: 1 as AgentTier, domain: "apps" };
const TEAM = [ADMIN, TRAVEL, DEV, BOOK, APPS];
type Spec = typeof ADMIN | typeof TRAVEL | typeof DEV | typeof BOOK | typeof APPS;

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
  reply?: (agentId: string, tools: string[], transcript: string) => ModelReply;
  seen?: string[];
  events?: SessionEvent[];
  onRosterChanged?: CloudSessionOpts["onRosterChanged"];
  meta?: ReturnType<typeof createInMemoryCloudSessionMeta>;
  /** build_app（#1591）要的两样：接了 git（execInWorkspace）+ apps（表 + 上传） */
  apps?: CloudSessionOpts["apps"];
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
    sessionMeta: o.meta ?? createInMemoryCloudSessionMeta(),
    workspaceId: "w1", sessionId: "s1", ownerUid: "owner", createdByUid: "owner",
    store, world: fakeWorld, px, hostUids: async () => ["owner"],
    agents: async () => team,
    adapterFor: (a): ModelAdapter => ({
      model: "m",
      async chat(messages, tools): Promise<ModelReply> {
        o.seen?.push(a.agentId);
        return o.reply?.(a.agentId, (tools ?? []).map((t) => t.name), JSON.stringify(messages)) ?? { content: `${a.name}答` };
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
    ...(o.apps === undefined ? {} : {
      apps: o.apps,
      git: {
        tokenFor: () => null,
        execInWorkspace: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        execInSidecar: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        clone: async () => ({ ok: true }),
        sanitize: (t) => t,
        githubApi: async () => ({ status: 201, json: {} }),
      },
    }),
  });
}


describe("主场里任务那三把刀", () => {
  /** 模型只看得见自己的上下文：管理员从 create_task 的回执（「id t_…」）里读，出行从时间线那句「[任务 t_…]」里读 */
  const idIn = (transcript: string): string | null => (/id (t_[0-9a-f]{8})/.exec(transcript) ?? /\[任务 (t_[0-9a-f]{8})\]/.exec(transcript))?.[1] ?? null;

  it("管理员建 → 派 → @ 出行；出行报完成；事件落盘、投影表逐条 upsert、重放折出同一份", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    const meta = createInMemoryCloudSessionMeta();
    let adminRound = 0;
    let travelRound = 0;
    const tools: Record<string, string[]> = {};
    const session = open(store, {
      roster: ["admin", "a_travel"], events, meta,
      reply: (id, names, transcript) => {
        tools[id] = names;
        if (id === "admin") {
          adminRound++;
          if (adminRound === 1) return { content: "", toolCalls: [{ id: "c1", name: "create_task", args: { title: "订票", brief: "明早 8 点" } }] };
          if (adminRound === 2) return { content: "", toolCalls: [{ id: "c2", name: "assign_task", args: { taskId: idIn(transcript), to: "出行" } }] };
          if (adminRound === 3) return { content: "@出行 订明早 8 点的票" };
          return { content: "收到" };
        }
        travelRound++;
        if (travelRound === 1) return { content: "", toolCalls: [{ id: "c3", name: "report_task", args: { taskId: idIn(transcript), status: "done", text: "订好了" } }] };
        return { content: "@管理员 订好了" };
      },
    });
    await session.say("owner", "Stan", "帮我订票", false, undefined);
    await session.settled();
    const kinds = events.filter((e) => e.type.startsWith("task_")).map((e) => e.type);
    expect(kinds).toEqual(["task_created", "task_assigned", "task_done"]);
    const created = events.find((e) => e.type === "task_created");
    expect(created).toMatchObject({ byAgentId: "admin", title: "订票", brief: "明早 8 点", ignorable: true });
    expect(events.find((e) => e.type === "task_assigned")).toMatchObject({ byAgentId: "admin", toAgentId: "a_travel" });
    expect(events.find((e) => e.type === "task_done")).toMatchObject({ byAgentId: "a_travel", summary: "订好了" });
    // 投影：每折一条 upsert 一行，状态逐步推进
    expect(meta.tasks.map((t) => t.status)).toEqual(["open", "assigned", "done"]);
    expect(meta.tasks.at(-1)).toMatchObject({ workspaceId: "w1", sessionId: "s1", assigneeAgentId: "a_travel", createdByAgent: "admin", title: "订票" });
    // 重放
    const replayed = taskFoldOf(store.load("s1"), "w1");
    expect([...replayed.values()]).toEqual([meta.tasks.at(-1)]);
    // 两只都有三把刀
    expect(tools["admin"]).toEqual(expect.arrayContaining(["create_task", "assign_task", "report_task"]));
    expect(tools["a_travel"]).toEqual(expect.arrayContaining(["create_task", "assign_task", "report_task"]));
    store.close();
  });

  it("团队会话：没有任务那三把刀", async () => {
    const store = newStore();
    const tools: Record<string, string[]> = {};
    const session = open(store, { roster: ["a_travel"], home: false, reply: (id, names) => { tools[id] = names; return { content: "好" }; } });
    await session.say("owner", "Stan", "@出行 来", true, ["a_travel"]);
    await session.settled();
    expect(tools["a_travel"]).not.toContain("create_task");
    store.close();
  });
});

describe("build_app（#1591）挂给谁", () => {
  const appsOpts = (): CloudSessionOpts["apps"] => ({ store: createInMemoryAppStore(), upload: async () => {} });
  it("主场里：管理员与 apps 域的专员有；出行没有", async () => {
    const store = newStore();
    const tools: Record<string, string[]> = {};
    const session = open(store, {
      roster: ["admin", "a_travel", "a_apps"], apps: appsOpts(),
      reply: (id, names) => { tools[id] = names; return { content: "好" }; },
    });
    await session.say("owner", "Stan", "@管理员 @出行 @应用专员 都来", true, ["admin", "a_travel", "a_apps"]);
    await session.settled();
    expect(tools["admin"]).toContain("build_app");
    expect(tools["a_apps"]).toContain("build_app");
    expect(tools["a_travel"]).not.toContain("build_app");
    store.close();
  });
  it("没接 apps（探针 / 旧装配）或团队会话：谁都没有", async () => {
    const store = newStore();
    const tools: Record<string, string[]> = {};
    const s1 = open(store, { roster: ["admin", "a_apps"], reply: (id, names) => { tools[id] = names; return { content: "好" }; } });
    await s1.say("owner", "Stan", "@应用专员 来", true, ["a_apps"]);
    await s1.settled();
    expect(tools["a_apps"]).not.toContain("build_app");
    store.close();
    const store2 = newStore();
    const s2 = open(store2, { roster: ["a_apps"], home: false, apps: appsOpts(), reply: (id, names) => { tools[id] = names; return { content: "好" }; } });
    await s2.say("owner", "Stan", "@应用专员 来", true, ["a_apps"]);
    await s2.settled();
    expect(tools["a_apps"]).not.toContain("build_app");
    store2.close();
  });
});
