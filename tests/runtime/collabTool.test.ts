// invite_collaborator（#1578）：先 create_task 才有的邀；收口的不邀；邀过同一家不重发；发成功才落 task_collab。
import { describe, expect, it } from "vitest";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import { createCollabTool } from "../../services/runtime/src/collabTool.js";
import type { TaskRow } from "../../src/shared/tasks.js";

const world = {} as ExecutionWorld;
const row = (id: string, status: TaskRow["status"], extra: Partial<TaskRow> = {}): TaskRow => ({
  id, workspaceId: "w1", sessionId: "s1", parentId: null, title: `任务${id}`, brief: "六个人", assigneeAgentId: null, status,
  question: null, summary: null, createdByAgent: "admin", createdTs: 1, updatedTs: 1, ...extra,
});

function harness(tasks: TaskRow[], sendOk = true) {
  const sent: string[] = [];
  const recorded: unknown[] = [];
  const tool = createCollabTool({
    peer: () => ({ uid: "u_xh", name: "小红" }),
    ownerName: () => "Stan",
    tasks: () => new Map(tasks.map((t) => [t.id, t])),
    record: (...a) => { recorded.push(a); },
    send: async (text) => { if (!sendOk) throw new Error("桥断了"); sent.push(text); return "已发给小红的管理员。"; },
  });
  return { tool, sent, recorded };
}

describe("invite_collaborator", () => {
  it("发邀请 + 落 task_collab；回执带对方名字", async () => {
    const h = harness([row("t1", "open")]);
    const out = await h.tool.run({ taskId: "t1", note: "问问周六有没有空" }, world);
    expect(h.sent[0]).toContain("[协作邀请 t1]");
    expect(h.sent[0]).toContain("问问周六有没有空");
    expect(h.recorded).toEqual([["t1", "u_xh", "小红"]]);
    expect(out).toContain("已邀请小红的管理员协作");
    // #1605：回执说清对面要主人点头，别把「发到了」说成「在办了」
    expect(out).toContain("要 小红 本人看到并点头");
    expect(out).toContain("别说成已经在办");
  });
  it("没这个任务 / 收口了 / 邀过了 / note 太长", async () => {
    const h = harness([row("t1", "done"), row("t2", "open", { collaborator: { uid: "u_xh", name: "小红" } }), row("t3", "open")]);
    await expect(h.tool.run({ taskId: "nope" }, world)).rejects.toThrow("先 create_task");
    await expect(h.tool.run({ taskId: "t1" }, world)).rejects.toThrow("收口");
    expect(await h.tool.run({ taskId: "t2" }, world)).toContain("已经邀过");
    await expect(h.tool.run({ taskId: "t3", note: "x".repeat(501) }, world)).rejects.toThrow("最多 500");
    expect(h.recorded).toEqual([]);
  });
  it("桥抛错：不落 task_collab", async () => {
    const h = harness([row("t1", "open")], false);
    await expect(h.tool.run({ taskId: "t1" }, world)).rejects.toThrow("桥断了");
    expect(h.recorded).toEqual([]);
  });
});
