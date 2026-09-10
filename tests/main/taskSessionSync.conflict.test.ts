// tests/main/taskSessionSync.conflict.test.ts
// 冲突三态（#1223，spec §3.6）：重叠段相等 = 只是游标陈旧；本地多出的尾巴全是人为动作 = 重放；
// 含 turn 痕迹 = 分叉出兄弟会话、原 id 换成云端那份。turn 在跑时一律不动本地日志。
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/session/events.js";
import { fakeCloud, harness } from "./taskSessionSync.test.js";

const created = (sessionId: string) =>
  ({ sessionId, ts: 1, type: "session_created", workspace: `/D/${sessionId}`, workspaceKind: "default" }) as const;

/** A 建好会话并推上云、放笔；返回 harness */
async function seeded() {
  const h = harness();
  h.store.append(created("s1"));
  h.store.append({ sessionId: "s1", ts: 2, type: "user_message", content: "第一句" });
  await h.sync.flushNow();
  await h.sync.releasePen("s1");
  return h;
}
/** 另一台设备 B 在云端写一条人话 + 一轮回复 */
async function bWrites(h: ReturnType<typeof harness>, fromSeq: number) {
  await h.cloud.api.append("s1", fromSeq, "desktop:B", [{ seq: fromSeq, sessionId: "s1", ts: 9, type: "user_message", content: "B 说" }]);
  await h.cloud.api.acquirePen("s1", "desktop:B", 30);
  await h.cloud.api.append("s1", fromSeq + 1, "desktop:B", [
    { seq: fromSeq + 1, sessionId: "s1", ts: 10, type: "assistant_message", content: "B 答", model: "m" },
    { seq: fromSeq + 2, sessionId: "s1", ts: 11, type: "turn_ended", outcome: "completed" },
  ]);
  await h.cloud.api.releasePen("s1", "desktop:B");
}

describe("taskSessionSync：冲突", () => {
  it("游标陈旧（推过但没记下来）：重叠段相等 → 只推游标，不分叉、不重放", async () => {
    const h = await seeded();
    // 假装游标丢了一格：把 pushedUpTo 退回 0，再 flush 会重推 seq 1 → seq_conflict → 对账
    h.fileRef().sessions["s1"]!.pushedUpTo = 0;
    h.store.append({ sessionId: "s1", ts: 3, type: "session_renamed", title: "新名" });
    await h.sync.flushNow();
    expect(h.cloud.rows.get("s1")!.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(h.replaced).toEqual([]);
    expect(h.store.sessions().filter((s) => s.title?.includes("分支"))).toHaveLength(0);
  });
  it("本地离线只改了名（human_only）：云端赢，改名重放到云端日志之后", async () => {
    const h = await seeded();
    await bWrites(h, 2); // 云端 seq 2..4
    h.cloud.setOffline(true);
    h.store.append({ sessionId: "s1", ts: 3, type: "session_renamed", title: "离线改名" }); // 本地 seq 2
    await h.sync.flushNow();
    h.cloud.setOffline(false);
    await h.sync.flushNow();
    const local = h.store.load("s1");
    expect(local.map((e) => [e.seq, e.type])).toEqual([
      [0, "session_created"], [1, "user_message"], [2, "user_message"], [3, "assistant_message"], [4, "turn_ended"], [5, "session_renamed"],
    ]);
    expect(h.cloud.rows.get("s1")!.events).toHaveLength(6);
    expect(h.replaced).toEqual(["s1"]);
    expect(h.store.sessions().filter((s) => s.title?.includes("分支"))).toHaveLength(0);
  });
  it("本地离线跑了一轮（has_executor）：分叉出「（本机未同步的分支）」，原 id 换成云端那份，分叉自己上云", async () => {
    const h = await seeded();
    await bWrites(h, 2);
    h.cloud.setOffline(true);
    h.store.append({ sessionId: "s1", ts: 3, type: "user_message", content: "离线问" });
    h.store.append({ sessionId: "s1", ts: 4, type: "assistant_message", content: "离线答", model: "m" });
    h.store.append({ sessionId: "s1", ts: 5, type: "turn_ended", outcome: "completed" });
    await h.sync.flushNow();
    h.cloud.setOffline(false);
    await h.sync.flushNow();
    // 原 id = 云端那份
    expect(h.store.load("s1").map((e) => e.type)).toEqual(["session_created", "user_message", "user_message", "assistant_message", "turn_ended"]);
    expect(h.store.load("s1")[2]).toMatchObject({ content: "B 说" });
    // 兄弟会话保住了本地那截
    const fork = h.store.sessions().find((s) => s.title?.includes("（本机未同步的分支）"));
    expect(fork).toBeDefined();
    const forkEvents = h.store.load(fork!.sessionId);
    expect(forkEvents.map((e) => e.type)).toEqual(["session_created", "user_message", "user_message", "assistant_message", "turn_ended", "session_renamed"]);
    expect(forkEvents[2]).toMatchObject({ content: "离线问" });
    expect(forkEvents[0]).not.toHaveProperty("forkedFrom");
    // 分叉作为新会话上了云
    await h.sync.flushNow();
    expect(h.cloud.rows.has(fork!.sessionId)).toBe(true);
    expect(h.replaced).toEqual(["s1"]);
  });
  it("turn 在跑：撞上冲突先不动本地日志，留在脏集合；收口后再 flush 才对账", async () => {
    let running = true;
    const h = harness({ running: () => running });
    h.store.append(created("s1"));
    h.store.append({ sessionId: "s1", ts: 2, type: "user_message", content: "第一句" });
    await h.sync.flushNow();
    await h.sync.releasePen("s1");
    await bWrites(h, 2);
    h.cloud.setOffline(true);
    h.store.append({ sessionId: "s1", ts: 3, type: "assistant_message", content: "本地半截", model: "m" });
    await h.sync.flushNow();
    h.cloud.setOffline(false);
    await h.sync.flushNow();
    expect(h.replaced).toEqual([]);
    expect(h.store.load("s1")).toHaveLength(3); // 没动
    running = false;
    await h.sync.flushNow();
    expect(h.replaced).toEqual(["s1"]);
  });
});
