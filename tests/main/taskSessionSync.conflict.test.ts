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
  it("human_only：onReplaced 排在重放之后——渲染层收到它就 resume() 重读日志（终审 minor）", async () => {
    // 先发的话，渲染层读到的是还没重放那几条人为动作的版本：刚改的名字在界面上凭空消失一下，
    // 直到下一次别的什么事触发重读
    const seen: number[] = [];
    const h = harness({ onReplaced: (id) => seen.push(h.store.load(id).length) });
    h.store.append(created("s1"));
    h.store.append({ sessionId: "s1", ts: 2, type: "user_message", content: "第一句" });
    await h.sync.flushNow();
    await h.sync.releasePen("s1");
    await bWrites(h, 2);
    h.cloud.setOffline(true);
    h.store.append({ sessionId: "s1", ts: 3, type: "session_renamed", title: "离线改名" });
    await h.sync.flushNow();
    h.cloud.setOffline(false);
    await h.sync.flushNow();
    expect(h.store.load("s1")).toHaveLength(6); // 云端 5 条 + 重放回来的那次改名
    expect(seen).toEqual([6]); // 通知发出去那一刻，改名已经在日志里
  });
  // ── #1258 / ADR-0310：持笔方 turn 跑着时，别的设备落人话 ──────────────────
  //
  // 原来的形状（读代码推出来的，没真跑过，但这条用例把它跑出来了）：免笔白名单不看笔 →
  // B 那条人话插进 A 正在跑的那一轮中间 → A 推同号的 executor 事件撞 seq_conflict →
  // 收口后对账判 `has_executor` → **A 刚跑完的一整轮被流放进「（本机未同步的分支）」**，
  // 主会话换成云端那份（B 的话、没人答），随后再被答一遍。
  //
  // 现在：B 那条在云端被 pen_busy 挡住（笔在 A 手上），等 A 放笔之后才落 —— 落在那一轮
  // **之后**，也就是它本该在的位置：那一轮没看见它，`lastUnanswered` 于是找得到它。
  it("A 跑着 turn 时 B 落人话：挡在云端，A 那一轮不被流放；A 放笔后 B 那条落在它之后", async () => {
    let running = true;
    const h = harness({ running: () => running });
    h.store.append(created("s1"));
    h.store.append({ sessionId: "s1", ts: 2, type: "user_message", content: "第一句" });
    await h.sync.flushNow(); // 建行那一批把笔发给 A，turn 在跑所以不放

    // A 这一轮的痕迹（还没推上去——真机上是 200ms 防抖 + 一次 RPC 往返的那个窗口）
    h.store.append({ sessionId: "s1", ts: 3, type: "assistant_message", content: "A 答", model: "m" });

    // B 这时候在云端落一条人话：被挡住
    await expect(
      // 云端此刻的尾巴是 seq 1（A 那条 assistant_message 还没推上去）——这正是 #1258 说的
      // 那个窗口：B 落的号，恰好是 A 手上那条还没出门的事件的号
      h.cloud.api.append("s1", 2, "desktop:B", [
        { seq: 2, sessionId: "s1", ts: 4, type: "user_message", content: "B 插话" },
      ])
    ).rejects.toMatchObject({ code: "pen_busy" });

    // A 照常把这一轮推完
    h.store.append({ sessionId: "s1", ts: 5, type: "turn_ended", outcome: "completed" });
    await h.sync.flushNow();
    running = false;
    await h.sync.releasePen("s1");
    // 收口之后那一次推 / 对账 —— **这一步是必须的**：#1258 的流放恰恰发生在这里
    // （turn 在跑时 reconcile 不动本地日志，收口后才处置）。少了它这条用例只验到「B 被挡住」
    await h.sync.flushNow();

    // 一条都没被流放，云端就是 A 那一轮
    expect(h.store.sessions().filter((x) => x.title?.includes("分支"))).toHaveLength(0);
    expect(h.replaced).toEqual([]);
    expect(h.cloud.rows.get("s1")!.events.map((e) => e.type)).toEqual([
      "session_created", "user_message", "assistant_message", "turn_ended",
    ]);

    // 笔放了，B 那条现在落得进去——在那一轮之后
    await h.cloud.api.append("s1", 4, "desktop:B", [
      { seq: 4, sessionId: "s1", ts: 6, type: "user_message", content: "B 插话" },
    ]);
    expect(h.cloud.rows.get("s1")!.events.map((e) => e.type)).toEqual([
      "session_created", "user_message", "assistant_message", "turn_ended", "user_message",
    ]);
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
