// 代办的任务投影（#1565，ADR-0364）：一次请求 = 一条任务；回话、下发、下一棒归到它名下；电话开一条；状态与卡上的字。
import { laneItemPreview, laneTaskDigest, laneTaskResult, laneTaskShape, type LaneTask, type LaneTaskItem } from "../../src/shared/laneTasks.js";
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/session/events.js";
import { LANE_TASK_TITLE_MAX, laneBusy, laneTaskStatus, laneTaskSubtitle, laneTasksOf } from "../../src/shared/laneTasks.js";

const ME = "11111111-1111-4111-8111-111111111111";
const FRIEND = "22222222-2222-4222-8222-222222222222";
let seq = 0;
const ev = (e: Record<string, unknown>): SessionEvent => ({ sessionId: "s", seq: ++seq, ts: 1000 + seq, ...e }) as unknown as SessionEvent;
const reset = () => void (seq = 0);
const nameOf = (id: string) => ({ admin: "管理员", a_1: "助手" })[id] ?? id;

describe("laneTasksOf", () => {
  it("朋友点起一条；管理员回、@ 助手下发、助手回——都归这一条；下发那行标着给了谁", () => {
    reset();
    const events = [
      ev({ type: "user_message", content: "明天告诉慈，让他早点吃早饭", fromUid: FRIEND, mentions: ["admin"] }),
      ev({ type: "assistant_message", agentId: "admin", content: "收到。@助手 明天早上提醒慈早点吃早饭" }),
      ev({ type: "user_message", content: "明天早上提醒慈早点吃早饭", fromUid: ME, mentions: ["a_1"], relay: { fromAgentId: "admin", depth: 1 } }),
      ev({ type: "assistant_message", agentId: "a_1", content: "好的，明早 8 点提醒。" }),
    ];
    const tasks = laneTasksOf(events, ME, nameOf);
    expect(tasks).toHaveLength(1);
    const t = tasks[0]!;
    expect(t).toMatchObject({ startedBy: "friend", kind: "message", title: "明天告诉慈，让他早点吃早饭", agentIds: ["admin", "a_1"] });
    expect(t.items.map((i) => i.who)).toEqual(["friend", "agent", "agent", "agent"]);
    expect(t.items[2]).toMatchObject({ agentId: "admin", handoff: { toAgentIds: ["a_1"] } });
    expect(laneTaskStatus(t, false)).toBe("replied");
    expect(laneTaskSubtitle(t, "replied", nameOf)).toBe("管理员、助手 · 3 条进展 · 已回复");
  });

  it("下一句人话开新的一条；我点起的标 me；标题取第一行并截短", () => {
    reset();
    const long = "字".repeat(LANE_TASK_TITLE_MAX + 5);
    const tasks = laneTasksOf([
      ev({ type: "user_message", content: "第一件", fromUid: FRIEND }),
      ev({ type: "assistant_message", agentId: "admin", content: "好" }),
      ev({ type: "user_message", content: `${long}\n第二行`, fromUid: ME }),
    ], ME, nameOf);
    expect(tasks.map((t) => t.startedBy)).toEqual(["friend", "me"]);
    expect(tasks[1]!.title).toBe(`${"字".repeat(LANE_TASK_TITLE_MAX - 1)}…`);
    expect(laneTaskStatus(tasks[1]!, false)).toBe("waiting");
  });

  it("同一个人三分钟内接着说的归到他上一条；换人或隔久了才开新的（真机 2026-10-05 三条卡；#1626 窗口从半小时缩到三分钟）", () => {
    reset();
    const tasks = laneTasksOf([
      ev({ type: "user_message", content: "@我的管理员 你带上 Stan 的管理员去看营业额", fromUid: ME }),
      ev({ type: "assistant_message", agentId: "admin", content: "得他本人确认" }),
      ev({ type: "user_message", content: "他不在线，你去给他打电话", fromUid: ME }),
      ev({ type: "assistant_message", agentId: "admin", content: "好" }),
      ev({ type: "user_message", content: "你可以给他打电话的", fromUid: ME }),
      ev({ type: "user_message", content: "我来说一句", fromUid: FRIEND }),
      ev({ type: "user_message", content: "隔了很久", fromUid: FRIEND, ts: 1000 + seq + 4 * 60_000 }),
    ], ME, nameOf);
    expect(tasks.map((t) => [t.startedBy, t.items.filter((i) => i.who !== "agent").length])).toEqual([["me", 3], ["friend", 1], ["friend", 1]]);
    expect(tasks[0]!.title).toBe("@我的管理员 你带上 Stan 的管理员去看营业额");
  });
  it("电话开一条（标题带打给谁）；挂断是它的一行；之后的总结归到它；招呼 / 总结的开场白不画", () => {
    reset();
    const tasks = laneTasksOf([
      ev({ type: "voice_call_changed", participants: [{ agentId: "admin", name: "管理员" }], byUid: FRIEND, ignorable: true }),
      ev({ type: "user_message", content: "[小红]: 帮我看看仓库", fromUid: FRIEND, voice: true }),
      ev({ type: "assistant_message", agentId: "admin", content: "好，我记下了" }),
      ev({ type: "voice_call_changed", participants: [], byUid: FRIEND, ignorable: true }),
      ev({ type: "user_message", content: "[系统] 总结给小明", fromUid: ME, mentions: ["admin"], greeting: "pair_call_summary" }),
      ev({ type: "assistant_message", agentId: "admin", content: "小红要你看看仓库。" }),
    ], ME, nameOf);
    // 电话里说的话、挂断、之后的总结全归电话这一条（#1613：之前电话里那句人话另开了一张卡）
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: "call", startedBy: "friend", title: "打给 管理员 的电话", agentIds: ["admin"] });
    expect(tasks[0]!.items.map((i) => i.text)).toContain("[小红]: 帮我看看仓库");
    const last = tasks.at(-1)!;
    expect(last.items.map((i) => i.text)).toContain("通话结束");
    expect(last.items.at(-1)!.text).toBe("小红要你看看仓库。");
    expect(tasks.flatMap((t) => t.items).some((i) => i.text.startsWith("[系统]"))).toBe(false);
  });

  it("没有人话在前的回话自己成一条（startedBy agent）；没答上来那一行归当前任务", () => {
    reset();
    const tasks = laneTasksOf([
      ev({ type: "assistant_message", agentId: "admin", content: "我先汇报一下" }),
      ev({ type: "turn_ended", agentId: "admin", outcome: "error", error: "超时" }),
    ], ME, nameOf);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.startedBy).toBe("agent");
    expect(tasks[0]!.items.at(-1)!.text).toBe("没答上来：超时");
  });

  it("laneBusy 跟 openTurns 走：点了名还没答 = 代办中", () => {
    reset();
    const events = [ev({ type: "user_message", content: "@管理员 在吗", fromUid: FRIEND, mentions: ["admin"] })];
    expect(laneBusy(events)).toBe(true);
    const t = laneTasksOf(events, ME, nameOf)[0]!;
    expect(laneTaskStatus(t, laneBusy(events))).toBe("working");
  });
});

describe("抽屉的摘要（#1601）：人说的 + 结果露着，智能体之间的往返折成「过程」", () => {
  const me = (key: string, text: string): LaneTaskItem => ({ key, ts: 1, who: "me", text });
  const ag = (key: string, agentId: string, text: string): LaneTaskItem => ({ key, ts: 1, who: "agent", agentId, text });
  const hand = (key: string, from: string, to: string): LaneTaskItem => ({ key, ts: 1, who: "agent", agentId: from, text: "[系统] …接力…", handoff: { toAgentIds: [to] } });
  const task = (items: LaneTaskItem[]): LaneTask => ({ key: "t", ts: 1, startedBy: "me", kind: "message", title: "x", items, agentIds: [], lastTs: 1 });
  const nameOf = (id: string): string => ({ a1: "雨姐", a2: "店铺管家" })[id] ?? id;

  it("真机那条：主人一句 → 雨姐 @店铺管家 → 下发 → 店铺管家回 → 下发 → 雨姐收尾：露主人那句与收尾，中间四条折成一格", () => {
    const t = task([me("u1", "去看看上个月营业额"), ag("a1", "a1", "@店铺管家 取一下"), hand("r1", "a1", "a2"), ag("a2", "a2", "@雨姐 9 月出来了"), hand("r2", "a2", "a1"), ag("a3", "a1", "9 月出来了：$78,807")]);
    const rows = laneTaskDigest(t);
    expect(rows.map((r) => (r.kind === "item" ? r.item.key : `过程×${r.items.length}`))).toEqual(["u1", "过程×4", "a3"]);
    expect(laneTaskResult(t)!.key).toBe("a3");
    const p = rows[1] as { kind: "process"; items: LaneTaskItem[] };
    expect(laneItemPreview(p.items.at(-1)!, nameOf)).toBe("下发给 雨姐");
    expect(laneItemPreview(p.items[0]!, nameOf)).toBe("@店铺管家 取一下");
  });
  it("只有一问一答：没有过程格；还在办、最后是下发：结果是前一句、下发折在它后面", () => {
    expect(laneTaskDigest(task([me("u1", "在吗"), ag("a1", "a1", "在")])).map((r) => r.kind)).toEqual(["item", "item"]);
    const t = task([me("u1", "查一下"), ag("a1", "a1", "@店铺管家 你来"), hand("r1", "a1", "a2")]);
    expect(laneTaskResult(t)!.key).toBe("a1");
    expect(laneTaskDigest(t).map((r) => (r.kind === "item" ? r.item.key : `过程×${r.items.length}`))).toEqual(["u1", "a1", "过程×1"]);
  });
  it("主人中途接着说的那句不折；没有智能体发言 = 没结果", () => {
    const t = task([me("u1", "查"), ag("a1", "a1", "@店铺管家 来"), me("u2", "顺便看看昨天的"), ag("a2", "a2", "好了")]);
    expect(laneTaskDigest(t).map((r) => (r.kind === "item" ? r.item.key : "过程"))).toEqual(["u1", "过程", "u2", "a2"]);
    expect(laneTaskResult(task([me("u1", "查")]))).toBeNull();
    expect(laneTaskDigest(task([]))).toEqual([]);
  });
});

describe("电话与电话后的话是一张卡（#1613，真机 2026-10-05）", () => {
  it("我打给对面管理员，挂了以后半小时内接着说的归到电话那条；换人说的另开", () => {
    reset();
    const tasks = laneTasksOf([
      ev({ type: "voice_call_changed", participants: [{ agentId: "admin", name: "峰哥" }], byUid: ME, ignorable: true }),
      ev({ type: "user_message", content: "[继爸]: 告诉他，让他早点吃饭", fromUid: ME, voice: true }),
      ev({ type: "assistant_message", agentId: "admin", content: "行——「他」是哪个？" }),
      ev({ type: "voice_call_changed", participants: [], byUid: ME, ignorable: true }),
      ev({ type: "user_message", content: "去吧", fromUid: ME }),
      ev({ type: "assistant_message", agentId: "admin", content: "好" }),
      ev({ type: "user_message", content: "我插一句", fromUid: FRIEND }),
    ], ME, (id) => (id === "admin" ? "峰哥" : id));
    expect(tasks.map((t) => [t.kind, t.startedBy, t.items.length])).toEqual([["call", "me", 5], ["message", "friend", 1]]);
    expect(tasks[0]!.title).toBe("打给 峰哥 的电话");
  });
});

describe("车道气泡剥情绪记号（#1614）", () => {
  it("段首的（笑）/（平）不进抽屉；正文里的括注不动", () => {
    reset();
    const tasks = laneTasksOf([
      ev({ type: "user_message", content: "在吗", fromUid: ME }),
      ev({ type: "assistant_message", agentId: "admin", content: "（平）在。\n\n（笑）你说（真的）。" }),
    ], ME, nameOf);
    expect(tasks[0]!.items.at(-1)!.text).toBe("在。\n\n你说（真的）。");
  });
});

describe("主页上是气泡还是卡（#1620）", () => {
  const me = (key: string, text: string): LaneTaskItem => ({ key, ts: 1, who: "me", text });
  const ag = (key: string, agentId: string, text: string): LaneTaskItem => ({ key, ts: 1, who: "agent", agentId, text });
  const hand = (key: string, from: string, to: string): LaneTaskItem => ({ key, ts: 1, who: "agent", agentId: from, text: "[系统]", handoff: { toAgentIds: [to] } });
  const task = (items: LaneTaskItem[], over: Partial<LaneTask> = {}): LaneTask =>
    ({ key: "t", ts: 1, startedBy: "me", kind: "message", title: "x", items, agentIds: [...new Set(items.map((i) => i.agentId).filter((a): a is string => a !== undefined))], lastTs: 1, ...over });
  it("一只答、没派活 = 聊天；还没答的也按聊天（答了就是气泡，别先出卡再变）", () => {
    expect(laneTaskShape(task([me("u", "@雨姐 你说对吗"), ag("a", "admin", "对，gmail 不难。")]))).toBe("chat");
    expect(laneTaskShape(task([me("u", "@雨姐 你说对吗"), ag("a", "admin", "对"), me("u2", "那呢"), ag("a2", "admin", "也对")]))).toBe("chat");
    expect(laneTaskShape(task([me("u", "@雨姐 你说对吗")]))).toBe("chat");
  });
  it("派了活 / 多只 / 电话 = 代办卡", () => {
    expect(laneTaskShape(task([me("u", "查营业额"), ag("a", "admin", "@店铺管家 取一下"), hand("r", "admin", "a2")]))).toBe("task");
    expect(laneTaskShape(task([me("u", "查"), ag("a", "admin", "好"), ag("b", "a2", "来了")]))).toBe("task");
    expect(laneTaskShape(task([ag("a", "admin", "通话结束")], { kind: "call" }))).toBe("task");
  });
});

describe("隔了几分钟再 @ = 新的一条（#1626）", () => {
  it("上一条是派过活的卡、已回复；5 分钟后主人再 @ → 另开一条（不藏进旧卡）", () => {
    reset();
    const tasks = laneTasksOf([
      ev({ type: "user_message", content: "看看数正不正常", fromUid: ME }),
      ev({ type: "assistant_message", agentId: "admin", content: "@店铺管家 取一下" }),
      ev({ type: "user_message", content: "[系统] 接力", fromUid: ME, mentions: ["a2"], relay: { fromAgentId: "admin", depth: 1 } }),
      ev({ type: "assistant_message", agentId: "a2", content: "数正常" }),
      ev({ type: "user_message", content: "@雨姐", fromUid: ME, ts: 1000 + seq + 5 * 60_000 }),
      ev({ type: "assistant_message", agentId: "admin", content: "在。说吧。", ts: 1000 + seq + 5 * 60_000 + 4000 }),
    ], ME, nameOf);
    expect(tasks).toHaveLength(2);
    expect(tasks[1]!.items.map((i) => i.text)).toEqual(["@雨姐", "在。说吧。"]);
  });
});

describe("协作在哪一步（#1605）", () => {
  it("task_collab / collab_decision 归当前任务，当智能体那一侧的一行", () => {
    reset();
    const tasks = laneTasksOf([
      ev({ type: "user_message", content: "带上 Stan 的管理员看营业额", fromUid: ME }),
      ev({ type: "task_created", taskId: "t_1", byAgentId: "admin", title: "看营业额", ignorable: true }),
      ev({ type: "task_collab", taskId: "t_1", byAgentId: "admin", withUid: "u_b", withName: "Stan", ignorable: true }),
      ev({ type: "collab_decision", requestId: "r_1", decision: "accepted", byUid: "u_b", ignorable: true }),
    ], ME, nameOf);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.items.map((i) => i.text)).toEqual(["带上 Stan 的管理员看营业额", "已交给 Stan 的管理员，等 TA 点头", "对面主人接了，它的管理员在办"]);
  });
});

describe("建了任务 / 交了协作的那一条是代办（#1605 真机）", () => {
  it("一只答、没下发，但这一条里有 task_created / task_collab → task；纯问答还是 chat", () => {
    reset();
    const tasks = laneTasksOf([
      ev({ type: "user_message", content: "@雨姐 带上他的管理员去看看营业额", fromUid: ME }),
      ev({ type: "task_created", taskId: "t_1", byAgentId: "admin", title: "看营业额", ignorable: true }),
      ev({ type: "task_collab", taskId: "t_1", byAgentId: "admin", withUid: "u_b", withName: "Stan", ignorable: true }),
      ev({ type: "assistant_message", agentId: "admin", content: "交给了" }),
    ], ME, nameOf);
    expect(tasks[0]!.delegated).toBe(true);
    expect(laneTaskShape(tasks[0]!)).toBe("task");
    reset();
    const chat = laneTasksOf([ev({ type: "user_message", content: "@雨姐 你说对吗", fromUid: ME }), ev({ type: "assistant_message", agentId: "admin", content: "对" })], ME, nameOf);
    expect(laneTaskShape(chat[0]!)).toBe("chat");
  });
});
