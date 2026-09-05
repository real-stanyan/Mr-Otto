import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { LoopEngine } from "../../src/loop/engine.js";
import { EventStore } from "../../src/session/store.js";
import type { ModelAdapter } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import type { UserMessageEvent } from "../../src/session/events.js";
import { tempDir } from "../helpers/tempDir.js";

const world: ExecutionWorld = {
  fs: { read: async () => "", write: async () => {} },
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};

function newStore() {
  return new EventStore(join(tempDir("mrotto-engine-logged-"), "s.db"));
}

describe("LoopEngine.runLoggedTurn（#932 坑 ②）", () => {
  it("不再 append user_message：开场那条已经在日志里，turn 只补 assistant_message + turn_ended", async () => {
    const store = newStore();
    const adapter: ModelAdapter = { model: "fake", async chat() { return { content: "好" }; } };
    const engine = new LoopEngine({ store, adapter, tools: [], world, sessionId: "s1", agentId: "ops" });
    const opening = store.append({
      sessionId: "s1", ts: 1, type: "user_message", content: "[alice]: @运营 在吗", fromUid: "u1", mentions: ["ops"],
    }) as UserMessageEvent;

    await engine.runLoggedTurn(opening);

    const types = store.load("s1").map((e) => e.type);
    expect(types.filter((t) => t === "user_message")).toHaveLength(1);
    expect(types.at(-1)).toBe("turn_ended");
    expect(store.load("s1").at(-1)).toMatchObject({ type: "turn_ended", outcome: "completed", agentId: "ops" });
  });

  it("模型看到的开场白就是那条已落盘的消息", async () => {
    const store = newStore();
    let seen = "";
    const adapter: ModelAdapter = {
      model: "fake",
      async chat(messages) { seen = JSON.stringify(messages); return { content: "好" }; },
    };
    const engine = new LoopEngine({ store, adapter, tools: [], world, sessionId: "s1" });
    const opening = store.append({ sessionId: "s1", ts: 1, type: "user_message", content: "[alice]: 看销量" }) as UserMessageEvent;
    await engine.runLoggedTurn(opening);
    expect(seen).toContain("[alice]: 看销量");
  });

  it("尾上多出来一条点名别人的 user_message，不算「我没答的」——不再采样一圈", async () => {
    const store = newStore();
    let calls = 0;
    const adapter: ModelAdapter = {
      model: "fake",
      async chat() {
        calls += 1;
        // 第一次采样期间，别人往日志尾巴上追加了一条给 ads 的话
        if (calls === 1) {
          store.append({ sessionId: "s1", ts: 2, type: "user_message", content: "[bob]: @广告 看投放", fromUid: "u2", mentions: ["ads"] });
        }
        return { content: "好" };
      },
    };
    const engine = new LoopEngine({ store, adapter, tools: [], world, sessionId: "s1", agentId: "ops" });
    const opening = store.append({ sessionId: "s1", ts: 1, type: "user_message", content: "[alice]: @运营 在吗", fromUid: "u1", mentions: ["ops"] }) as UserMessageEvent;
    await engine.runLoggedTurn(opening);
    expect(calls).toBe(1);
  });

  it("尾上多出来一条点名我的，也**不**再采样一圈 —— 每条带 mentions 的发言在 say() 落盘那一刻就已经有一个 turn 归它（#932 复审）", async () => {
    const store = newStore();
    let calls = 0;
    const adapter: ModelAdapter = {
      model: "fake",
      async chat() {
        calls += 1;
        if (calls === 1) {
          store.append({ sessionId: "s1", ts: 2, type: "user_message", content: "[bob]: @运营 再看下退款", fromUid: "u2", mentions: ["ops"] });
        }
        return { content: "好" };
      },
    };
    const engine = new LoopEngine({ store, adapter, tools: [], world, sessionId: "s1", agentId: "ops" });
    const opening = store.append({ sessionId: "s1", ts: 1, type: "user_message", content: "[alice]: @运营 在吗", fromUid: "u1", mentions: ["ops"] }) as UserMessageEvent;
    await engine.runLoggedTurn(opening);
    // 不变量：sessionService.say() 收下这句话时就给它排了 job（或并进了那只
    // agent 还排在队里的 job），daemon 中途死掉由重启补跑接住。这里再采样一
    // 圈 = 同一句话的第二个答案，不是捡回一条没人管的话
    expect(calls).toBe(1);
  });

  it("turn_ended.readUpToSeq = 开跑那一刻的日志末条 seq（#932 终审 Blocking ①）", async () => {
    const store = newStore();
    const adapter: ModelAdapter = { model: "fake", async chat() { return { content: "好" }; } };
    const engine = new LoopEngine({ store, adapter, tools: [], world, sessionId: "s1", agentId: "ops" });
    const opening = store.append({
      sessionId: "s1", ts: 1, type: "user_message", content: "[alice]: @运营 在吗", fromUid: "u1", mentions: ["ops"],
    }) as UserMessageEvent;
    // job 在队里等的那一会儿，别人又说了一句（这条**在**这一轮的第一次快照里）
    const queuedTail = store.append({
      sessionId: "s1", ts: 2, type: "chat_message", fromUid: "u2", label: "bob", content: "顺便看下退款", mention: false,
    });

    await engine.runLoggedTurn(opening);

    const end = store.load("s1").at(-1)!;
    expect(end).toMatchObject({ type: "turn_ended", agentId: "ops", readUpToSeq: queuedTail.seq });
    expect(queuedTail.seq).toBeGreaterThan(opening.seq);
  });

  it("开场白就是日志末条（runTurn 那条路）：readUpToSeq = opening.seq 自己", async () => {
    const store = newStore();
    const adapter: ModelAdapter = { model: "fake", async chat() { return { content: "好" }; } };
    const engine = new LoopEngine({ store, adapter, tools: [], world, sessionId: "s1", agentId: "ops" });
    await engine.runTurn("在吗");
    const events = store.load("s1");
    const opening = events.find((e) => e.type === "user_message")!;
    expect(events.at(-1)).toMatchObject({ type: "turn_ended", readUpToSeq: opening.seq });
  });

  it("没配 agentId 的 engine（本机会话）：mentions 不参与判断，尾上任何 user_message 都算没答的", async () => {
    const store = newStore();
    let calls = 0;
    const adapter: ModelAdapter = {
      model: "fake",
      async chat() {
        calls += 1;
        if (calls === 1) store.append({ sessionId: "s1", ts: 2, type: "user_message", content: "补一句", mentions: ["ads"] });
        return { content: "好" };
      },
    };
    const engine = new LoopEngine({ store, adapter, tools: [], world, sessionId: "s1" });
    await engine.runTurn("在吗");
    expect(calls).toBe(2);
  });
});
