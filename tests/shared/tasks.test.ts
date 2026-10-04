// 任务的折法与文案（#1571 第 3 步，ADR-0365 §2.4）：事件 → 一行；终态不翻回；状态行取这只手上最近动过的；投影行来回转。
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/session/events.js";
import { foldTask, liveTaskOf, taskEventText, taskFoldOf, taskLine, taskRowOf, taskRowToDb, type TaskEvent } from "../../src/shared/tasks.js";

const ev = (seq: number, e: Record<string, unknown>): TaskEvent =>
  ({ sessionId: "s1", seq, ts: 1000 + seq, ignorable: true, ...e }) as unknown as TaskEvent;

const LOG: SessionEvent[] = [
  ev(1, { type: "task_created", taskId: "t_1", byAgentId: "admin", title: "明天出游", brief: "两个人，预算 500" }),
  ev(2, { type: "task_created", taskId: "t_2", byAgentId: "admin", title: "订票", parentTaskId: "t_1" }),
  ev(3, { type: "task_assigned", taskId: "t_2", byAgentId: "admin", toAgentId: "a_travel" }),
  ev(4, { type: "task_progress", taskId: "t_2", byAgentId: "a_travel", note: "查到三班车" }),
  ev(5, { type: "task_needs_owner", taskId: "t_2", byAgentId: "a_travel", question: "8 点还是 10 点？" }),
  ev(6, { type: "task_progress", taskId: "t_2", byAgentId: "a_travel", note: "主人说 8 点" }),
  ev(7, { type: "task_done", taskId: "t_2", byAgentId: "a_travel", summary: "订好了 8 点那班" }),
  ev(8, { type: "task_progress", taskId: "t_2", byAgentId: "a_travel", note: "晚到的一条" }),
  ev(9, { type: "task_progress", taskId: "t_ghost", byAgentId: "a_travel", note: "没建过的" }),
];

describe("foldTask", () => {
  it("建 → 派 → 进展 → 等主人 → 进展 → 完成；终态之后的事件忽略；没建过的忽略", () => {
    const fold = taskFoldOf(LOG, "w1");
    expect([...fold.keys()]).toEqual(["t_1", "t_2"]);
    expect(fold.get("t_1")).toMatchObject({ status: "open", assigneeAgentId: null, brief: "两个人，预算 500", parentId: null, createdTs: 1001 });
    const t2 = fold.get("t_2")!;
    expect(t2).toMatchObject({ status: "done", assigneeAgentId: "a_travel", summary: "订好了 8 点那班", question: null, parentId: "t_1", updatedTs: 1007 });
    const mid = taskFoldOf(LOG.slice(0, 5), "w1").get("t_2")!;
    expect(mid).toMatchObject({ status: "needs_owner", question: "8 点还是 10 点？" });
    expect(taskFoldOf(LOG.slice(0, 6), "w1").get("t_2")).toMatchObject({ status: "running", question: null });
    expect(taskFoldOf(LOG.slice(0, 3), "w1").get("t_2")).toMatchObject({ status: "assigned" });
  });
  it("failed 也是终态；重复 created 不覆盖", () => {
    const fold = new Map();
    foldTask(fold, ev(1, { type: "task_created", taskId: "t", byAgentId: "admin", title: "A" }), "w1");
    foldTask(fold, ev(2, { type: "task_created", taskId: "t", byAgentId: "admin", title: "B" }), "w1");
    foldTask(fold, ev(3, { type: "task_failed", taskId: "t", byAgentId: "admin", reason: "没额度" }), "w1");
    foldTask(fold, ev(4, { type: "task_assigned", taskId: "t", byAgentId: "admin", toAgentId: "x" }), "w1");
    expect(fold.get("t")).toMatchObject({ title: "A", status: "failed", summary: "没额度", assigneeAgentId: null });
  });
  it("非任务事件不动 fold", () => {
    const fold = new Map();
    foldTask(fold, { sessionId: "s1", seq: 1, ts: 1, type: "chat_message", fromUid: "u", label: "u", content: "x" } as SessionEvent, "w1");
    expect(fold.size).toBe(0);
  });
});

describe("状态行", () => {
  it("liveTaskOf：这条会话里派给它、还没收口的，取最近动过的；taskLine 带父标题", () => {
    const rows = [...taskFoldOf(LOG.slice(0, 5), "w1").values()];
    const t = liveTaskOf(rows, "a_travel", "s1")!;
    expect(t.id).toBe("t_2");
    expect(liveTaskOf(rows, "a_travel", "other")).toBeNull();
    expect(liveTaskOf([...taskFoldOf(LOG, "w1").values()], "a_travel", "s1")).toBeNull(); // 完成了
    const titleOf = (id: string) => rows.find((r) => r.id === id)?.title ?? null;
    expect(taskLine(t, titleOf)).toBe("任务：明天出游 › 订票");
    expect(taskLine(rows[0]!, titleOf)).toBe("任务：明天出游");
  });
});

describe("投影行", () => {
  it("TaskRow → 表行 → TaskRow 往返；形状不对回 null", () => {
    const t = taskFoldOf(LOG, "w1").get("t_2")!;
    const back = taskRowOf(taskRowToDb(t));
    expect(back).toEqual(t);
    expect(taskRowOf({ id: "x" })).toBeNull();
    expect(taskRowOf({ ...taskRowToDb(t), status: "dreaming" })).toBeNull();
    expect(taskRowOf(null)).toBeNull();
  });
});

describe("taskEventText", () => {
  it("六种各一句，名字与标题从回调来", () => {
    const nameOf = (id: string) => (id === "admin" ? "管理员" : "出行");
    const titles = new Map([["t_1", "明天出游"], ["t_2", "订票"]]);
    const titleOf = (id: string) => titles.get(id) ?? null;
    const lines = LOG.slice(0, 7).map((e) => taskEventText(e as TaskEvent, nameOf, titleOf));
    expect(lines).toEqual([
      "管理员建了任务「明天出游」",
      "管理员建了任务「订票」（属于「明天出游」）",
      "「订票」派给了出行",
      "「订票」· 出行：查到三班车",
      "「订票」等你拍板：8 点还是 10 点？",
      "「订票」· 出行：主人说 8 点",
      "「订票」完成：订好了 8 点那班",
    ]);
  });
});
