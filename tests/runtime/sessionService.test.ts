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

    // DEFAULT_AGENT 没有 instructions、又是 roster 里唯一一只——briefIfNeeded
    // 的守卫（#928 修复轮 3/5）判定这条 brief 说不出任何内容，不落
    // agent_briefed，事件序列因此与多智能体切片之前逐字节相同
    expect(events.map((e) => e.type)).toEqual(["user_message", "request_envelope", "assistant_message", "turn_ended"]);
    expect(events[0]).toMatchObject({ type: "user_message", content: "[alice]: 你好" });
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

  it("同一只 agent 排队去重(#928 终审 Critical,修复轮 2/5):它的 job 还排在队里时被连续点名两次,第二次的话不能凭空消失", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    let resolveOpsChat!: (reply: ModelReply) => void;
    const session = createCloudSession({
      workspaceId: "w1", sessionId: "s1", ownerUid: "owner", createdByUid: "creator",
      store, world: fakeWorld, px, hostUids: async () => [],
      agents: async () => AGENTS,
      adapterFor: (a) => ({
        model: a.models[0]!,
        async chat() {
          if (a.agentId === "ops") {
            // ops 那一轮攥在手里不 resolve —— 让它一直占着 drainer 的位置,
            // 后面两条 @广告 才真的会先后排进同一份队列,而不是被立刻跑掉
            return new Promise<ModelReply>((resolve) => { resolveOpsChat = resolve; });
          }
          return { content: `${a.name}答` };
        },
      }),
      onEvent: (e) => events.push(e), onUsage: () => {},
    });

    // 起 ops 的 turn,卡住——这条调用是 drainer,一直没跑完
    const opsSay = session.say("u1", "alice", "@运营 做 A", true, ["ops"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.isRunning()).toBe(true);

    // 第一次 @广告:enqueue 成功入队("queued"),job 真的排进了队列里,
    // 只是还没被 drainer 的 nextJob() 捞走(drainer 正卡在 ops 那轮)
    await session.say("u2", "bob", "@广告 做 B", true, ["ads"]);

    // 第二次 @广告(同一只 agent,前一个 job 还原封不动地躺在队列里没被捞
    // 走):turnCoordinator 的去重分支命中,回 logged_only 且这个 job **压根
    // 没有入队**。这条消息如果不特殊处理就是真的丢——它不在队列里,不会有
    // 任何 runJob 替它落 user_message,finally 的补偿排空也捞不到它
    await session.say("u3", "carol", "@广告 做 C", true, ["ads"]);

    // 1b（#932 坑 ②）：去重命中不再需要"补一条 chat_message"这种特例——
    // say() 一律先落 user_message，落盘早于排队，去重只决定"跑不跑一轮"，
    // 决定不了"这句话留不留痕"。三次点名 = 三条 user_message，零条
    // chat_message（1a 那条补偿是为了"不在队里的 job 说过的话"，那个前提
    // 没有了）
    expect(
      events.some(
        (e) => e.type === "user_message" && (e as { content: string }).content === "[carol]: @广告 做 C"
      )
    ).toBe(true);
    expect(events.filter((e) => e.type === "user_message")).toHaveLength(3);
    expect(events.filter((e) => e.type === "chat_message")).toHaveLength(0);

    // 收尾:放 ops 过关,不留一条永远 pending 的 promise
    resolveOpsChat({ content: "运营答完了" });
    await opsSay;

    // 去重的那一只不重复起 turn：ops 一轮 + ads 一轮 = 两条 assistant_message
    // （carol 那句被 ads 的排队去重吃掉，它开跑时读的是整份日志，三句都在里面）
    expect(events.filter((e) => e.type === "assistant_message")).toHaveLength(2);
  });

  it("去重与排队混在同一条调用里(#928 终审 Critical,修复轮 2/5):[\"logged_only\",\"queued\"] 不该补 chat_message —— 那个 queued 的 job 会自己落 user_message", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    let resolveOpsChat!: (reply: ModelReply) => void;
    let opsCalls = 0;
    const session = createCloudSession({
      workspaceId: "w1", sessionId: "s1", ownerUid: "owner", createdByUid: "creator",
      store, world: fakeWorld, px, hostUids: async () => [],
      agents: async () => AGENTS,
      // 计数器**在 adapterFor 外面**（1b/#932 坑 ①）：engineFor 现在每 turn
      // 现取一次 adapter，工厂里的 let 会跟着每轮重置——ops 的第二轮又会拿到
      // opsCalls=0 那条挂住的分支，测试自己卡死。这不是被测行为变了，是这个
      // 假货原来偷偷依赖了"adapter 一只 agent 只造一次"
      adapterFor: (a) => ({
        model: a.models[0]!,
        async chat() {
          // 只有"ops"第一次被叫到时才攥住不放——它自己的 job 后面还会因为
          // message3 里也点了它而再跑一轮(那一轮不该也挂住,否则整条排空
          // 循环真的会卡死,测试本身就跑不完,不是这次要测的东西)
          if (a.agentId === "ops") {
            opsCalls++;
            if (opsCalls === 1) {
              return new Promise<ModelReply>((resolve) => { resolveOpsChat = resolve; });
            }
          }
          return { content: `${a.name}答` };
        },
      }),
      onEvent: (e) => events.push(e), onUsage: () => {},
    });

    const opsSay = session.say("u1", "alice", "@运营 做 A", true, ["ops"]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 先让"ads"真的排进队列里(queued,还没被捞走)
    await session.say("u2", "bob", "@广告 做 B", true, ["ads"]);


    // 这条调用同时点了"ads"(已经在队里,命中去重 → logged_only)和
    // "ops"(它自己的 job 已被 drainer 捞走、不在队里 → 不去重,真的入队,
    // 回 queued)。decisions === ["logged_only","queued"]——含至少一个
    // queued,所以**不该**补 chat_message:那个 queued 的"ops"job 会在
    // drainer 排空到它时,自己落一条带这句话原文的 user_message
    await session.say("u3", "carol", "@广告 也麻烦 @运营", true, ["ads", "ops"]);

    // 1b（#932 坑 ②）：这句话的痕迹不再取决于 decisions 的组合——say() 收下
    // 就落一条 user_message，chat_message 只剩"没点名"一个来源，这里一条都
    // 不该有
    expect(events.filter((e) => e.type === "chat_message")).toHaveLength(0);

    // 放 ops 第一轮过关,让排空循环继续跑完(ops、ads、message3 的 ops job
    // 依次落盘)
    resolveOpsChat({ content: "运营答完了" });
    await opsSay;

    // message3 的原文确实以 user_message 的身份在日志里（1b 里它落在 say()
    // 那一刻，而不是等 drainer 排到 ops 那个 job 才落）
    expect(
      events.some(
        (e) => e.type === "user_message" && (e as { content: string }).content === "[carol]: @广告 也麻烦 @运营"
      )
    ).toBe(true);
    // 三次发言 = 三条 user_message。
    // assistant_message 是 **4** 条不是 3 条，这是 1b「落盘早于开跑」的一个
    // 已知代价，写在这里免得下次有人把它当 bug 追：ops 第一轮说完话时，
    // carol 那条（点了 ops）已经在日志尾上了，engine 的 unseenUserTail
    // （ADR-0205）于是在同一个 turn 里又采样了一圈答它；随后 drain 排到
    // carol 给 ops 排的那个 job，又正经跑了一轮。两轮读的都是整份日志，
    // 答案不会错，多花的是一次模型调用。1a 里这条路走不到——那时 carol
    // 的话要等它的 job 起跑才落盘，第一轮的日志尾上什么都没有
    expect(events.filter((e) => e.type === "user_message")).toHaveLength(3);
    expect(events.filter((e) => e.type === "assistant_message")).toHaveLength(4);
  });

  it("没提示词也没同伴的占位 agent(#928 终审,修复轮 3/5):brief 说不出任何内容,不该落 agent_briefed", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    // 只有一只、instructions 是空串——过滤掉自己之后 roster 也是空的,
    // 与 daemon.ts 的 DEFAULT_WORKSPACE_AGENT / smokeAssembly.ts 的 smokeAgent
    // 同一种形状(runtime:smoke 用的正是这种占位)
    const SOLO_AGENT = { agentId: "solo", name: "solo", description: "", instructions: "", models: ["m-solo"] };
    const session = createCloudSession({
      workspaceId: "w1", sessionId: "s1", ownerUid: "owner", createdByUid: "creator",
      store, world: fakeWorld, px, hostUids: async () => [],
      agents: async () => [SOLO_AGENT],
      adapterFor: () => ({ model: "m-solo", async chat() { return { content: "答" }; } }),
      onEvent: (e) => events.push(e), onUsage: () => {},
    });

    await session.say("u1", "alice", "你好", true);

    expect(events.some((e) => e.type === "agent_briefed")).toBe(false);
    // 事件序列直接以 user_message 开头——同 npm run runtime:smoke 那条断言
    expect(events[0]?.type).toBe("user_message");
  });

  it("没提示词但有同伴(#928 终审,修复轮 3/5):守卫不是'没提示词就不 brief'——roster 非空时仍要落", async () => {
    const store = newStore();
    const events: SessionEvent[] = [];
    // "solo" 自己没有 instructions,但群里还有"friend"——这条 brief 说得出
    // "群里还有:friend(帮衬的)",不该被守卫拦下
    const ROSTER = [
      { agentId: "solo", name: "solo", description: "", instructions: "", models: ["m-solo"] },
      { agentId: "friend", name: "friend", description: "帮衬的", instructions: "你帮衬", models: ["m-friend"] },
    ];
    const session = createCloudSession({
      workspaceId: "w1", sessionId: "s1", ownerUid: "owner", createdByUid: "creator",
      store, world: fakeWorld, px, hostUids: async () => [],
      agents: async () => ROSTER,
      adapterFor: () => ({ model: "m-solo", async chat() { return { content: "答" }; } }),
      onEvent: (e) => events.push(e), onUsage: () => {},
    });

    await session.say("u1", "alice", "@solo 你好", true, ["solo"]);

    const briefed = events.find((e) => e.type === "agent_briefed");
    expect(briefed).toMatchObject({ agentId: "solo", instructions: "" });
  });
});

describe("多智能体云会话 · 切片 1b（#932 四个坑）", () => {
  function open(store: EventStore, opts: {
    agents: () => Promise<typeof AGENTS>;
    adapterFor: (a: (typeof AGENTS)[number]) => ModelAdapter;
    events?: SessionEvent[];
  }): CloudSession {
    return createCloudSession({
      workspaceId: "w1", sessionId: "s1", ownerUid: "owner", createdByUid: "creator",
      store, world: fakeWorld, px, hostUids: async () => [],
      agents: opts.agents, adapterFor: opts.adapterFor,
      onEvent: (e) => opts.events?.push(e), onUsage: () => {},
    });
  }

  it("坑 ②：点了名的发言在 say() 那一刻就落 user_message（带 fromUid/mentions），turn 不再另落一条", async () => {
    const store = newStore();
    const session = open(store, {
      agents: async () => AGENTS,
      adapterFor: (a) => ({ model: a.models[0]!, async chat() { return { content: "答" }; } }),
    });
    await session.say("u1", "alice", "@运营 看下销量", true, ["ops"]);
    const ums = store.load("s1").filter((e) => e.type === "user_message");
    expect(ums).toHaveLength(1);
    expect(ums[0]).toMatchObject({ content: "[alice]: @运营 看下销量", fromUid: "u1", mentions: ["ops"] });
    // 开场白 seq 在 assistant_message 之前
    const am = store.load("s1").find((e) => e.type === "assistant_message")!;
    expect(ums[0]!.seq).toBeLessThan(am.seq);
    store.close();
  });

  it("坑 ①：改了型号，下一 turn 立刻用新 adapter（不等 daemon 重启）", async () => {
    const store = newStore();
    let model = "m-v1";
    const used: string[] = [];
    const session = open(store, {
      agents: async () => [{ ...AGENTS[0]!, models: [model] }],
      adapterFor: (a) => ({ model: a.models[0]!, async chat() { used.push(a.models[0]!); return { content: "答" }; } }),
    });
    await session.say("u1", "alice", "@运营 一", true, ["ops"]);
    model = "m-v2";
    await session.say("u1", "alice", "@运营 二", true, ["ops"]);
    expect(used).toEqual(["m-v1", "m-v2"]);
    store.close();
  });

  it("坑 ③：排队期间 agent 被删 —— 留一条 turn_ended{error, agentId}，openTurns 收口", async () => {
    const store = newStore();
    let roster = AGENTS;
    const session = open(store, {
      agents: async () => roster,
      adapterFor: (a) => ({
        model: a.models[0]!,
        async chat() {
          // 运营跑着的时候，广告被删了
          roster = AGENTS.filter((x) => x.agentId !== "ads");
          return { content: "答" };
        },
      }),
    });
    await session.say("u1", "alice", "@运营 @广告 一起", true, ["ops", "ads"]);
    const events = store.load("s1");
    const gone = events.find((e) => e.type === "turn_ended" && e.agentId === "ads");
    expect(gone).toMatchObject({ outcome: "error" });
    expect((gone as { error?: string }).error).toContain("ads");
    const { openTurns } = await import("../../src/shared/turnLedger.js");
    expect(openTurns(events)).toEqual([]);
    store.close();
  });

  it("坑 ④：客户端给了 mentions 就以它为准 —— mentions:[] + 正文含 @ 也只落 chat_message", async () => {
    const store = newStore();
    const seen: string[] = [];
    const session = open(store, {
      agents: async () => AGENTS,
      adapterFor: (a) => ({ model: a.models[0]!, async chat() { seen.push(a.agentId); return { content: "答" }; } }),
    });
    await session.say("u1", "alice", "@运营 这句只是复述，别跑", false, []);
    expect(seen).toEqual([]);
    expect(store.load("s1").map((e) => e.type)).toEqual(["chat_message"]);
    store.close();
  });

  it("坑 ④ 反面：mentions 缺席（手机端）仍走老语义 —— 正文解析、再回落名单第一只", async () => {
    const store = newStore();
    const seen: string[] = [];
    const session = open(store, {
      agents: async () => AGENTS,
      adapterFor: (a) => ({ model: a.models[0]!, async chat() { seen.push(a.agentId); return { content: "答" }; } }),
    });
    await session.say("u1", "alice", "@广告 看投放", true);
    await session.say("u1", "alice", "在吗", true);
    expect(seen).toEqual(["ads", "ops"]);
    store.close();
  });

  it("重启补跑：日志里有排队中的点名发言，重新装配时自动跑完", async () => {
    const store = newStore();
    // 模拟"上一个 daemon 收下了话、还没跑就死了"：只有那条 user_message
    store.append({ sessionId: "s1", ts: 1, type: "user_message", content: "[alice]: @运营 看", fromUid: "u1", mentions: ["ops"] });
    const seen: string[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });
    open(store, {
      agents: async () => AGENTS,
      adapterFor: (a) => ({ model: a.models[0]!, async chat() { seen.push(a.agentId); resolveDone(); return { content: "答" }; } }),
    });
    await done;
    // 等 turn 完整收口：轮询 openTurns 直到空（最多 1s），不用固定 sleep
    const { openTurns } = await import("../../src/shared/turnLedger.js");
    for (let i = 0; i < 50 && openTurns(store.load("s1")).length > 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(["ops"]);
    expect(openTurns(store.load("s1"))).toEqual([]);
    store.close();
  });

  it("排空循环里一个 job 抛错，后面的 job 照跑 —— 每只各自收口，不再整队丢弃", async () => {
    const store = newStore();
    const seen: string[] = [];
    const session = open(store, {
      agents: async () => AGENTS,
      adapterFor: (a) => ({
        model: a.models[0]!,
        async chat() { seen.push(a.agentId); if (a.agentId === "ops") throw new Error("boom"); return { content: "答" }; },
      }),
    });
    await session.say("u1", "alice", "@运营 @广告 一起", true, ["ops", "ads"]);
    expect(seen).toEqual(["ops", "ads"]);
    expect(session.isRunning()).toBe(false);
    const ends = store.load("s1").filter((e) => e.type === "turn_ended");
    expect(ends.map((e) => [e.agentId, (e as { outcome: string }).outcome])).toEqual([["ops", "error"], ["ads", "completed"]]);
    store.close();
  });
});
