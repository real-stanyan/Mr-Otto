// 任务那三把刀（#1571 第 3 步）：建 / 派 / 报各自的判据；落的是事件，投影由别处折。
import { describe, expect, it } from "vitest";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import { createTaskTools, type TaskAppend } from "../../services/runtime/src/taskTools.js";
import { foldTask, type TaskRow } from "../../src/shared/tasks.js";
import type { SessionEvent } from "../../src/session/events.js";

const world = {} as ExecutionWorld;
const ROSTER = [
  { agentId: "admin", name: "管理员", tier: 0 as const, domain: "admin" },
  { agentId: "a_travel", name: "出行", tier: 1 as const, domain: "travel" },
  { agentId: "a_dev", name: "码农", tier: 1 as const, domain: "dev" },
  { agentId: "a_book", name: "订票员", tier: 2 as const, domain: "travel", parentAgentId: "a_travel" },
];

/** 几只共用一份 fold：谁 append 的就按谁的 byAgentId 折 */
function world1() {
  const fold = new Map<string, TaskRow>();
  const events: TaskAppend[] = [];
  let seq = 0;
  let n = 0;
  const toolsFor = (agentId: string) => {
    const [create, assign, report] = createTaskTools({
      agentId, roster: () => ROSTER, tasks: () => fold, newId: () => `t_${++n}`,
      append: (e) => {
        events.push(e);
        foldTask(fold, { sessionId: "s1", seq: ++seq, ts: seq, ignorable: true, byAgentId: agentId, ...e } as SessionEvent, "w1");
      },
    });
    return { create: create!, assign: assign!, report: report! };
  };
  return { fold, events, admin: toolsFor("admin"), travel: toolsFor("a_travel"), dev: toolsFor("a_dev"), book: toolsFor("a_book") };
}

describe("create_task", () => {
  it("建一条；子任务带 parentTaskId；子工不建；标题必填、长度有上限", async () => {
    const w = world1();
    expect(await w.admin.create.run({ title: "明天出游", brief: "预算 500" }, world)).toContain("id t_1");
    await w.admin.create.run({ title: "订票", parentTaskId: "t_1" }, world);
    expect(w.fold.get("t_2")).toMatchObject({ parentId: "t_1", createdByAgent: "admin", status: "open" });
    await expect(w.admin.create.run({ title: "x", parentTaskId: "nope" }, world)).rejects.toThrow("没有 id");
    await expect(w.admin.create.run({}, world)).rejects.toThrow("title 必填");
    await expect(w.admin.create.run({ title: "x".repeat(81) }, world)).rejects.toThrow("最多 80 字");
    await expect(w.book.create.run({ title: "x" }, world)).rejects.toThrow("子工不建任务");
  });
});

describe("assign_task", () => {
  it("只能往下一级派给在场的那只；派完提醒 @；终态不能再派", async () => {
    const w = world1();
    await w.admin.create.run({ title: "订票" }, world);
    expect(await w.admin.assign.run({ taskId: "t_1", to: "出行" }, world)).toContain("@出行");
    expect(w.fold.get("t_1")).toMatchObject({ status: "assigned", assigneeAgentId: "a_travel" });
    await expect(w.admin.assign.run({ taskId: "t_1", to: "订票员" }, world)).rejects.toThrow("只能往下一级");
    await expect(w.travel.assign.run({ taskId: "t_1", to: "码农" }, world)).rejects.toThrow("只能往下一级");
    await expect(w.admin.assign.run({ taskId: "t_1", to: "财务" }, world)).rejects.toThrow("不在这条对话里");
    await expect(w.admin.assign.run({ taskId: "t_1", to: "管理员" }, world)).rejects.toThrow("不用派给自己");
    expect(await w.travel.assign.run({ taskId: "t_1", to: "订票员" }, world)).toContain("@订票员");
    await w.book.report.run({ taskId: "t_1", status: "done", text: "订好了" }, world);
    await expect(w.admin.assign.run({ taskId: "t_1", to: "出行" }, world)).rejects.toThrow("已经完成");
  });
});

describe("report_task", () => {
  it("被派的 / 建的 / 管理员能报；别人不能；四种状态各落一种事件；终态之后不能再报", async () => {
    const w = world1();
    await w.admin.create.run({ title: "订票" }, world);
    await w.admin.assign.run({ taskId: "t_1", to: "出行" }, world);
    await expect(w.dev.report.run({ taskId: "t_1", status: "progress", text: "我来" }, world)).rejects.toThrow("不是派给你的");
    await w.travel.report.run({ taskId: "t_1", status: "progress", text: "查到三班" }, world);
    await w.travel.report.run({ taskId: "t_1", status: "needs_owner", text: "8 点还是 10 点" }, world);
    expect(w.fold.get("t_1")).toMatchObject({ status: "needs_owner", question: "8 点还是 10 点" });
    expect(await w.travel.report.run({ taskId: "t_1", status: "done", text: "订好了" }, world)).toContain("@ 派给你的那只");
    expect(w.events.map((e) => e.type)).toEqual(["task_created", "task_assigned", "task_progress", "task_needs_owner", "task_done"]);
    await expect(w.admin.report.run({ taskId: "t_1", status: "failed", text: "x" }, world)).rejects.toThrow("已经完成了");
    await expect(w.admin.report.run({ taskId: "t_1", status: "weird", text: "x" }, world)).rejects.toThrow();
  });
});
