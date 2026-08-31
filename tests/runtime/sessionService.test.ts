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
});
