// invite_collaborator（#1578 → #1605 第 1 期 b）：先 create_task 才有的邀；收口的不邀；等点头 / 在办的不重发；落点是 request 回调。
import { describe, expect, it } from "vitest";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import { createCollabTool, type CollabToolDeps } from "../../services/runtime/src/collabTool.js";
import type { TaskRow } from "../../src/shared/tasks.js";

const world = {} as ExecutionWorld;
const row = (id: string, status: TaskRow["status"], extra: Partial<TaskRow> = {}): TaskRow => ({
  id, workspaceId: "w1", sessionId: "s1", parentId: null, title: `任务${id}`, brief: "六个人", assigneeAgentId: null, status,
  question: null, summary: null, createdByAgent: "admin", createdTs: 1, updatedTs: 1, ...extra,
});

function harness(tasks: TaskRow[], refuse: string | null = null) {
  const requests: Parameters<CollabToolDeps["request"]>[0][] = [];
  const redelivered: string[] = [];
  const tool = createCollabTool({
    peer: () => ({ uid: "u_xh", name: "小红" }),
    ownerName: () => "Stan",
    tasks: () => new Map(tasks.map((t) => [t.id, t])),
    ownerLineBefore: (taskId) => (taskId === "t1" ? "@我的管理员 问问小红周六来不来" : ""),
    request: async (o) => { requests.push(o); return refuse; },
    redeliver: async (id) => { redelivered.push(id); return refuse; },
  });
  return { tool, requests, redelivered };
}

describe("invite_collaborator", () => {
  it("落 request（带主人原话、说明、到目前的结果）；回执说清要对面点头、别说成在办", async () => {
    const h = harness([row("t1", "open", { summary: null })]);
    const out = await h.tool.run({ taskId: "t1", note: "问问周六有没有空" }, world);
    expect(h.requests).toEqual([{ task: expect.objectContaining({ id: "t1" }), note: "问问周六有没有空", ownerLine: "@我的管理员 问问小红周六来不来", result: "" }]);
    expect(out).toContain("交给小红的管理员");
    expect(out).toContain("等 小红 点头");
    expect(out).toContain("别说成已经在办");
  });
  it("没这个任务 / 收口了 / note 太长；被拒原样抛", async () => {
    const h = harness([row("t1", "done"), row("t3", "open")]);
    await expect(h.tool.run({ taskId: "nope" }, world)).rejects.toThrow("先 create_task");
    await expect(h.tool.run({ taskId: "t1" }, world)).rejects.toThrow("收口");
    await expect(h.tool.run({ taskId: "t3", note: "x".repeat(501) }, world)).rejects.toThrow("最多 500");
    const refused = harness([row("t3", "open")], "你们已经不是朋友了，送不过去");
    await expect(refused.tool.run({ taskId: "t3" }, world)).rejects.toThrow("不是朋友");
    await expect(refused.tool.run({ taskId: "t3" }, world)).rejects.toThrow("别说已经交给了");
  });
  it("等点头 / 在办的不重发；不方便 / 没回的可以再邀", async () => {
    const pending = harness([row("t2", "open", { collaborator: { uid: "u_xh", name: "小红", state: "pending", requestId: "r_1" } })]);
    expect(await pending.tool.run({ taskId: "t2" }, world)).toContain("等 小红 点头");
    expect(pending.requests).toEqual([]);
    expect(pending.redelivered).toEqual(["r_1"]); // 等点头的再送一次（对面去重）——修好之前没送到的那条靠它补上
    const stuck = harness([row("t2", "open", { collaborator: { uid: "u_xh", name: "小红", state: "pending", requestId: "r_1" } })], "对方还没有主场");
    await expect(stuck.tool.run({ taskId: "t2" }, world)).rejects.toThrow("没送到");
    const accepted = harness([row("t2", "open", { collaborator: { uid: "u_xh", name: "小红", state: "accepted" } })]);
    expect(await accepted.tool.run({ taskId: "t2" }, world)).toContain("已经在办");
    const declined = harness([row("t2", "open", { collaborator: { uid: "u_xh", name: "小红", state: "declined" } })]);
    await declined.tool.run({ taskId: "t2" }, world);
    expect(declined.requests).toHaveLength(1);
  });
  it("不过审批门；说明里写了要先 create_task、对面要点头", () => {
    const h = harness([]);
    expect(h.tool.requiresApproval).toBe(false);
    expect(h.tool.def.description).toContain("create_task");
    expect(h.tool.def.description).toContain("点头");
  });
});
