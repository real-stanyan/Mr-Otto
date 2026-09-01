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
      adapter,
      px,
      hostUids: async () => [],
      onEvent: (e) => events.push(e),
      onUsage: () => {},
    });

    await session.say("u1", "alice", "你好", true);

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
      adapter,
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
      adapter,
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
      adapter,
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
      adapter: { model: "fake-model", async chat() { return { content: "" }; } },
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
