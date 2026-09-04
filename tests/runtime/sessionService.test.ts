import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { createCloudSession, type CloudSession } from "../../services/runtime/src/sessionService.js";
import { EventStore } from "../../src/session/store.js";
import type { SessionEvent, ApprovalRequestEvent } from "../../src/session/events.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import type { PxCallDeps } from "../../services/runtime/src/pxTools.js";
import { tempDir } from "../helpers/tempDir.js";

const fakeWorld: ExecutionWorld = {
  fs: {
    read: async (path) => `<content of ${path}>`,
    write: async () => {},
  },
  exec: async () => ({ stdout: "hi", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};

const px: PxCallDeps = { edgeBase: "https://edge.example", runtimeSecret: "sek" };

// 单 agent 场景（#928 之前就有的测试）用的占位 roster——只有一只、指令是空串，
// 专供沿用旧行为的测试用。真正的多智能体 roster 见下面 describe("多智能体云会话…")
const DEFAULT_AGENT = { agentId: "default", name: "default", description: "", instructions: "", models: ["fake-model"] };

function newStore(): EventStore {
  const dir = tempDir("mrotto-runtime-session-");
  return new EventStore(join(dir, "session.db"));
}

describe("createCloudSession", () => {
  it("① 完整 turn：say(mention) → user_message([label]前缀) → assistant_message → turn_ended，onEvent 每条都到", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    const adapter: ModelAdapter = {
      model: "fake-model",
      async chat(): Promise<ModelReply> {
        return { content: "你好，我是水獭" };
      },
    };
    const session = createCloudSession({
      workspaceId: "w1",
      sessionId: "s1",
      ownerUid: "owner",
      createdByUid: "creator",
      store,
      world: fakeWorld,
      agents: async () => [DEFAULT_AGENT],
      adapterFor: () => adapter,
      px,
      hostUids: async () => [],
      onEvent: (e) => events.push(e),
      onUsage: () => {},
    });

    await session.say("u1", "alice", "你好", true);

    // agent_briefed 排最前（#928）：这只 agent 第一次起 turn 前先落一条自我
    // 介绍，engine 这一轮的 snapshot() 才读得到它——不是这条测试原有的断言，
    // 是多智能体切片带来的新增事实
    expect(events.map((e) => e.type)).toEqual([
      "agent_briefed",
      "user_message",
      "request_envelope",
      "assistant_message",
      "turn_ended",
    ]);
    expect(events[1]).toMatchObject({ type: "user_message", content: "[alice]: 你好" });
    // 落盘与 onEvent 是同一份事实
    expect(store.load("s1").map((e) => e.type)).toEqual(events.map((e) => e.type));
    expect(session.isRunning()).toBe(false);
    expect(session.lastSeq()).toBe(events.at(-1)!.seq);
    store.close();
  });

  it("② 中途注入：mention=false 的插话落 chat_message，下一轮模型看到 [label]: 内容", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    let session!: CloudSession;
    const seenMessages: { role: string; content: unknown }[][] = [];
    let round = 0;

    const adapter: ModelAdapter = {
      model: "fake-model",
      async chat(messages): Promise<ModelReply> {
        seenMessages.push(messages as { role: string; content: unknown }[]);
        round++;
        if (round === 1) {
          // 第一轮 chat() 被调后，模拟另一个成员非 @ 插话
          await session.say("u2", "herz", "补充信息", false);
          return { content: "", toolCalls: [{ id: "c1", name: "read_file", args: { path: "/a.txt" } }] };
        }
        return { content: "看到补充信息了" };
      },
    };

    session = createCloudSession({
      workspaceId: "w1",
      sessionId: "s1",
      ownerUid: "owner",
      createdByUid: "creator",
      store,
      world: fakeWorld,
      agents: async () => [DEFAULT_AGENT],
      adapterFor: () => adapter,
      px,
      hostUids: async () => [],
      onEvent: (e) => events.push(e),
      onUsage: () => {},
    });

    await session.say("u1", "alice", "开始任务", true);

    expect(events.some((e) => e.type === "chat_message")).toBe(true);
    expect(seenMessages).toHaveLength(2);
    const secondRound = seenMessages[1]!;
    expect(
      secondRound.some((m) => typeof m.content === "string" && m.content.includes("[herz]: 补充信息"))
    ).toBe(true);
    store.close();
  });

  it("③ 审批链：bash toolCall → approval_request → approve(ownerUid) → approval_decision(decidedBy) → 执行 → 完成", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    let session!: CloudSession;
    let round = 0;

    const adapter: ModelAdapter = {
      model: "fake-model",
      async chat(): Promise<ModelReply> {
        round++;
        if (round === 1) {
          return { content: "", toolCalls: [{ id: "cA", name: "bash", args: { cmd: "echo hi" } }] };
        }
        return { content: "跑完了" };
      },
    };

    const onEvent = (e: SessionEvent): void => {
      events.push(e);
      if (e.type === "approval_request") {
        const req = e as ApprovalRequestEvent;
        session.approve(req.callId, "owner", "Owner", "approved");
      }
    };

    session = createCloudSession({
      workspaceId: "w1",
      sessionId: "s1",
      ownerUid: "owner",
      createdByUid: "creator",
      store,
      world: fakeWorld,
      agents: async () => [DEFAULT_AGENT],
      adapterFor: () => adapter,
      px,
      hostUids: async () => [],
      onEvent,
      onUsage: () => {},
    });

    await session.say("u1", "alice", "帮我跑个命令", true);

    expect(events.some((e) => e.type === "approval_request")).toBe(true);
    const decision = events.find((e) => e.type === "approval_decision");
    expect(decision).toMatchObject({ decision: "approved", decidedBy: { uid: "owner", label: "Owner" } });
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toMatchObject({ status: "ok" });
    expect(events.some((e) => e.type === "turn_ended" && (e as { outcome: string }).outcome === "completed")).toBe(true);
    store.close();
  });

  it("④ 并发 approve：同 callId 背靠背两次（不 await 中间态）——第一次赢，decidedBy 记的是第一次的 uid（复审 Important，非旁路 Map）", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    let session!: CloudSession;
    let round = 0;
    const approveResults: boolean[] = [];

    const adapter: ModelAdapter = {
      model: "fake-model",
      async chat(): Promise<ModelReply> {
        round++;
        if (round === 1) {
          return { content: "", toolCalls: [{ id: "cA", name: "bash", args: { cmd: "echo hi" } }] };
        }
        return { content: "跑完了" };
      },
    };

    const onEvent = (e: SessionEvent): void => {
      events.push(e);
      if (e.type === "approval_request") {
        const req = e as ApprovalRequestEvent;
        // approve() 是同步函数：背靠背连续调用两次，中间不 await 任何东西——
        // 模拟同一个 callId 几乎同时被批两次（两个人/两个设备都点了按钮）。
        // 旁路 Map 版本在这个场景下会静默丢 decidedBy（第二次覆盖 meta 又因
        // resolve 失败把 key 删掉，第一次的续体读到空 map）；显式参数版本
        // 不共享任何状态，第一次落定后 pending 已被消化，第二次连 entry 都
        // 查不到，早早短路回 false
        approveResults.push(session.approve(req.callId, "owner", "Owner-first", "approved"));
        approveResults.push(session.approve(req.callId, "owner", "Owner-second", "denied"));
      }
    };

    session = createCloudSession({
      workspaceId: "w1",
      sessionId: "s1",
      ownerUid: "owner",
      createdByUid: "creator",
      store,
      world: fakeWorld,
      agents: async () => [DEFAULT_AGENT],
      adapterFor: () => adapter,
      px,
      hostUids: async () => [],
      onEvent,
      onUsage: () => {},
    });

    await session.say("u1", "alice", "帮我跑个命令", true);

    expect(approveResults).toEqual([true, false]);
    const decision = events.find((e) => e.type === "approval_decision");
    expect(decision).toMatchObject({ decision: "approved", decidedBy: { uid: "owner", label: "Owner-first" } });
    store.close();
  });

  it("⑤ 并发 @：第一条跑着时第二条也 @ 进来，跑完之后协调器必须能再起下一轮（#928 task-8 修复轮 1/5，真实复现过的死锁）", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    let chatCalls = 0;
    let resolveFirstChat!: (reply: ModelReply) => void;

    const adapter: ModelAdapter = {
      model: "fake-model",
      async chat(): Promise<ModelReply> {
        chatCalls++;
        if (chatCalls === 1) {
          // 第一轮攥在手里不 resolve —— 模拟"turn 真的还在跑"，好让第二条
          // @ 是货真价实地并发进来，不是靠回调时序凑出来的假并发
          return new Promise<ModelReply>((resolve) => {
            resolveFirstChat = resolve;
          });
        }
        return { content: `第 ${chatCalls} 轮回复` };
      },
    };

    const session = createCloudSession({
      workspaceId: "w1",
      sessionId: "s1",
      ownerUid: "owner",
      createdByUid: "creator",
      store,
      world: fakeWorld,
      agents: async () => [DEFAULT_AGENT],
      adapterFor: () => adapter,
      px,
      hostUids: async () => [],
      onEvent: (e) => events.push(e),
      onUsage: () => {},
    });

    // 第一条 @：起 turn，但卡在 adapter.chat() 里不会立刻 resolve
    const firstSay = session.say("u1", "alice", "开始任务", true);

    // 放一拍，让第一条真正跑进 engine.runTurn() → adapter.chat() 卡住的那一刻
    // （fetchGrantedTools 在 hostUids=[] 时不发真请求，只是个 microtask，
    // setTimeout(0) 足够把它排空）
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.isRunning()).toBe(true);

    // 第二条 @ 并发进来：协调器此刻应该回 queued，不该起第二个 turn
    await session.say("u2", "bob", "我也有事", true);

    // 断言①（修复轮 1/5，#928）：第二条此刻**不**落 chat_message——它排上了
    // 队，会被第一条的排空循环真正跑到，届时由 runTurn 落 user_message；这里
    // 提前落一条 chat_message 会让同一句话产生两条几乎同形状的事件
    // （`[label]: content`），模型读到的就是同一条指令被念了两遍。这是本次
    // 修复权衡接受的代价：排队中的消息要等当前 turn 跑完才在群里出现，原来
    // 是立刻可见
    expect(
      events.some((e) => e.type === "chat_message" && (e as { content: string }).content === "我也有事")
    ).toBe(false);

    // 放第一条过关，等它（连同 finally 里的排空——这次会真的把 bob 那条也
    // 排空到并跑掉）跑完
    resolveFirstChat({ content: "第一轮完成" });
    await firstSay;

    // 断言①-b：bob 那条确实被跑到了——它自己的 user_message 出现在日志里，
    // 没有因为"排上了没跑"丢数据，只是推迟到了它真正起 turn 的那一刻
    expect(
      events.some((e) => e.type === "user_message" && (e as { content: string }).content === "[bob]: 我也有事")
    ).toBe(true);

    // 断言②：第一条跑完之后，协调器必须归 idle —— 这是这次复现的死锁本体：
    // finally 里只排一次 nextJob() 的话，会把并发挤进来的第二条 job 捞出来
    // 却因为它不是 null 而让 running 永久卡在 true
    expect(session.isRunning()).toBe(false);

    // 断言③：之后第三条 @ 还能真的起下一个 turn —— adapter.chat() 会被
    // 再调用一次。只断言①②不够：协调器可能"看起来没丢数据"但已经再也
    // 起不了 turn 了，只有这一条才逼出"回不回得去 idle"这件事
    const callsBefore = chatCalls;
    await session.say("u3", "carol", "第三条", true);
    expect(chatCalls).toBeGreaterThan(callsBefore);

    store.close();
  });
});

// issue #822：归档的日志那一半（Supabase 那行的 archived 列与房间收摊在
// daemon 里——这一层只碰日志）
describe("CloudSession.archive（issue #822）", () => {
  const openSession = (store: ReturnType<typeof newStore>, events: SessionEvent[]) =>
    createCloudSession({
      workspaceId: "w1",
      sessionId: "s1",
      ownerUid: "owner",
      createdByUid: "creator",
      store,
      world: fakeWorld,
      agents: async () => [DEFAULT_AGENT],
      adapterFor: () => ({ model: "fake-model", async chat() { return { content: "" }; } }),
      px,
      hostUids: async () => [],
      onEvent: (e) => events.push(e),
      onUsage: () => {},
    });

  it("落一条人话 + 一条 session_archived，两条都推给房里的人", () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    const session = openSession(store, events);

    expect(session.archive("alice")).toBe(true);

    expect(events.map((e) => e.type)).toEqual(["chat_message", "session_archived"]);
    // 谁干的：session_archived 自己没有这个字段（ADR-0087 的形状，单机
    // 时代不需要），所以要有那条人话，否则群里其他人只看到会话消失
    expect(events[0]).toMatchObject({ type: "chat_message", fromUid: "system" });
    expect((events[0] as { content: string }).content).toContain("alice");
    // reason:"user"——人点的，跟系统保留会话那种区分开
    expect(events[1]).toMatchObject({ type: "session_archived", reason: "user" });
    expect(session.lastSeq()).toBe(events[1]!.seq);
    store.close();
  });

  it("第二次归档回 false，不重复落事件（幂等）", () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    const session = openSession(store, events);
    session.archive("alice");
    events.length = 0;

    expect(session.archive("bob")).toBe(false);
    expect(events).toEqual([]);
    store.close();
  });

  it("装配时从已有日志播种归档状态 —— daemon 重启后不会把已归档的又归一次", () => {
    const store = newStore();
    const first: SessionEvent[] = [];
    const session = openSession(store, first);
    expect(session.isArchived()).toBe(false);
    session.archive("alice");
    expect(session.isArchived()).toBe(true);

    // 同一份日志重新装配一条会话（daemon 重启恢复房间的形态）
    const second: SessionEvent[] = [];
    const revived = openSession(store, second);
    // 日志是事实：Supabase 那列写失败过的话，daemon 会拿着 archived=false
    // 的一行走到这里，靠这个判据兜住（daemon 启动时据此当场收摊 + 补写）
    expect(revived.isArchived()).toBe(true);
    expect(revived.archive("bob")).toBe(false);
    expect(second).toEqual([]);
    store.close();
  });
});

const AGENTS = [
  { agentId: "ops", name: "运营", description: "管店铺运营", instructions: "你管店铺运营", models: ["m-ops"] },
  { agentId: "ads", name: "广告", description: "管投放", instructions: "你管投放", models: ["m-ads"] },
];

describe("多智能体云会话（#928 切片 1a）", () => {
  it("@运营 只让运营那只跑,落盘事件带 agentId=ops", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    const seen: string[] = [];
    const session = createCloudSession({
      workspaceId: "w1", sessionId: "s1", ownerUid: "owner", createdByUid: "creator",
      store, world: fakeWorld, px, hostUids: async () => [],
      agents: async () => AGENTS,
      adapterFor: (a) => ({ model: a.models[0]!, async chat() { seen.push(a.agentId); return { content: `${a.name}答` }; } }),
      onEvent: (e) => events.push(e), onUsage: () => {},
    });

    await session.say("u1", "alice", "@运营 看下销量", true, ["ops"]);

    expect(seen).toEqual(["ops"]);
    const am = events.filter((e) => e.type === "assistant_message");
    expect(am).toHaveLength(1);
    expect(am[0]).toMatchObject({ agentId: "ops", content: "运营答" });
  });

  it("@ 两只 —— 串行跑完,顺序按 mentions 给的顺序", async () => {
    const store = newStore();
    const seen: string[] = [];
    const session = createCloudSession({
      workspaceId: "w1", sessionId: "s1", ownerUid: "owner", createdByUid: "creator",
      store, world: fakeWorld, px, hostUids: async () => [],
      agents: async () => AGENTS,
      adapterFor: (a) => ({ model: a.models[0]!, async chat() { seen.push(a.agentId); return { content: `${a.name}答` }; } }),
      onEvent: () => {}, onUsage: () => {},
    });

    await session.say("u1", "alice", "@运营 @广告 一起看", true, ["ops", "ads"]);

    expect(seen).toEqual(["ops", "ads"]);
  });

  it("广告那只看不见运营的工具痕迹,只看得见它说的话", async () => {
    const store = newStore();
    const prompts: Record<string, string> = {};
    const session = createCloudSession({
      workspaceId: "w1", sessionId: "s1", ownerUid: "owner", createdByUid: "creator",
      store, world: fakeWorld, px, hostUids: async () => [],
      agents: async () => AGENTS,
      adapterFor: (a) => ({
        model: a.models[0]!,
        async chat(messages) {
          prompts[a.agentId] = JSON.stringify(messages);
          return { content: `${a.name}答` };
        },
      }),
      onEvent: () => {}, onUsage: () => {},
    });

    // 先手工塞一条运营的工具痕迹,再让广告跑
    store.append({ sessionId: "s1", ts: 1, type: "assistant_message", content: "查了",
                   model: "m-ops", agentId: "ops",
                   toolCalls: [{ id: "c1", name: "bash", args: "{}" }] });
    store.append({ sessionId: "s1", ts: 2, type: "tool_result", toolCallId: "c1",
                   status: "ok", output: "机密的 12 行查询结果", agentId: "ops" });

    await session.say("u1", "alice", "@广告 看投放", true, ["ads"]);

    expect(prompts.ads).toContain("查了");                    // 说的话进来了
    expect(prompts.ads).not.toContain("机密的 12 行查询结果");  // 工具输出没进来
  });

  it("mentions 缺席但正文里有 @ —— 服务端用同一份纯逻辑自己认出来", async () => {
    const store = newStore();
    const seen: string[] = [];
    const session = createCloudSession({
      workspaceId: "w1", sessionId: "s1", ownerUid: "owner", createdByUid: "creator",
      store, world: fakeWorld, px, hostUids: async () => [],
      agents: async () => AGENTS,
      adapterFor: (a) => ({ model: a.models[0]!, async chat() { seen.push(a.agentId); return { content: "答" }; } }),
      onEvent: () => {}, onUsage: () => {},
    });
    // 手机端只发得出布尔那一版
    await session.say("u1", "alice", "@广告 看投放", true);
    expect(seen).toEqual(["ads"]); // 不是名单第一只的 ops
  });

  it("mentions 缺席、正文也没 @ —— 老语义:唤醒名单第一只", async () => {
    const store = newStore();
    const seen: string[] = [];
    const session = createCloudSession({
      workspaceId: "w1", sessionId: "s1", ownerUid: "owner", createdByUid: "creator",
      store, world: fakeWorld, px, hostUids: async () => [],
      agents: async () => AGENTS,
      adapterFor: (a) => ({ model: a.models[0]!, async chat() { seen.push(a.agentId); return { content: "答" }; } }),
      onEvent: () => {}, onUsage: () => {},
    });
    await session.say("u1", "alice", "在吗", true);
    expect(seen).toEqual(["ops"]); // 名单第一只 = 默认那只
  });

  it("排空循环中途抛错(#928 修复轮 1/5):剩下的 job 不再尝试跑,但每个都留下一条 chat_message,协调器不卡死", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    const seen: string[] = [];
    const session = createCloudSession({
      workspaceId: "w1", sessionId: "s1", ownerUid: "owner", createdByUid: "creator",
      store, world: fakeWorld, px, hostUids: async () => [],
      agents: async () => AGENTS,
      adapterFor: (a) => ({
        model: a.models[0]!,
        async chat() {
          // ops 那只的 adapter 直接炸掉,模拟"起跑失败"(hostUids() 抛错、
          // runTurn 抛错都是这条路径,这里用最直接的 chat() 抛错触发)
          if (a.agentId === "ops") throw new Error("boom：ops 的 adapter 炸了");
          seen.push(a.agentId);
          return { content: `${a.name}答` };
        },
      }),
      onEvent: (e) => events.push(e), onUsage: () => {},
    });

    // ops 排第一个(拿到 start_turn,真的起跑并抛错),ads 排第二个(queued,
    // 会在 finally 的丢弃排空里被捞到——但不会被真的跑,因为 ops 已经把这条
    // 调用的排空循环炸断了)
    await expect(
      session.say("u1", "alice", "@运营 @广告 一起看", true, ["ops", "ads"])
    ).rejects.toThrow("boom");

    // ads 那个 job 被丢弃排空——从没真的起过 turn,它的 adapter.chat() 没被调用过
    expect(seen).toEqual([]);
    // 但它的话没有凭空消失:留下一条 chat_message(两只 agent 的 job 共享
    // 同一条原始消息,所以丢弃排空只会补这一条,不是两条)
    const chatMessages = events.filter((e) => e.type === "chat_message");
    expect(chatMessages).toHaveLength(1);
    expect(chatMessages[0]).toMatchObject({ fromUid: "u1", label: "alice", content: "@运营 @广告 一起看" });
    // 协调器没有卡死——不是"看起来没丢数据"但已经再起不来了
    expect(session.isRunning()).toBe(false);

    // 而且真的还能再起下一轮
    await session.say("u2", "bob", "@广告 还在吗", true, ["ads"]);
    expect(seen).toEqual(["ads"]);
  });

  it("多 agent 场景:approval_request.agentId 是当前跑着的那一只(#928 修复轮 1/5)", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    let session!: CloudSession;

    const onEvent = (e: SessionEvent): void => {
      events.push(e);
      if (e.type === "approval_request") {
        session.approve((e as ApprovalRequestEvent).callId, "owner", "Owner", "approved");
      }
    };

    session = createCloudSession({
      workspaceId: "w1", sessionId: "s1", ownerUid: "owner", createdByUid: "creator",
      store, world: fakeWorld, px, hostUids: async () => [],
      agents: async () => AGENTS,
      adapterFor: (a) => {
        let round = 0;
        return {
          model: a.models[0]!,
          async chat() {
            round++;
            if (round === 1) return { content: "", toolCalls: [{ id: "cA", name: "bash", args: { cmd: "echo hi" } }] };
            return { content: `${a.name}跑完了` };
          },
        };
      },
      onEvent,
      onUsage: () => {},
    });

    await session.say("u1", "alice", "@广告 帮我跑个命令", true, ["ads"]);

    // agentId 之前一直没有写入方(#928 之前的单 agent 时代没这个概念)——
    // 这条断言钉住它:两只 agent 各自弹出的审批卡,日志里要能分清是谁要的
    const req = events.find((e) => e.type === "approval_request");
    expect(req).toMatchObject({ agentId: "ads" });
  });
});
