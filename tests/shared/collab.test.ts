// 跨主场协作的纯逻辑（#1578，ADR-0368）：三档授权各说什么、牵头 / 协作者那段、邀请那句话；task_collab 折进任务、卡上写协作者。
import { describe, expect, it } from "vitest";
import { collabAuthPrompt, collabInviteText, collabRolePrompt } from "../../src/shared/collab.js";
import { delegationRolePrompt } from "../../src/shared/delegation.js";
import { foldTask, taskEventText, type TaskEvent, type TaskRow } from "../../src/shared/tasks.js";
import type { SessionEvent } from "../../src/session/events.js";

describe("授权档位", () => {
  it("仅聊天只转述、可协作答事实动手回批、全部开放小事可定", () => {
    expect(collabAuthPrompt("chat", "小红")).toContain("只能转述主人公开说过的话");
    expect(collabAuthPrompt("agents", "小红")).toContain("要动手（订票、改文件、花钱）的先回主人批");
    expect(collabAuthPrompt("full", "小红")).toContain("小事你可以替主人定");
    expect(collabAuthPrompt("full", "小红")).toContain("仍要主人批");
  });
  it("牵头 / 协作者那段进了车道里管理员的提示词；专员那段不带", () => {
    const admin = delegationRolePrompt({ isAdmin: true, ownerName: "Stan", peerName: "小红", others: [] });
    expect(admin).toContain("invite_collaborator");
    expect(admin).toContain("小红 的管理员带来的任务你是协作者");
    expect(collabRolePrompt("Stan", "小红")).toContain("Stan 交给你的任务你牵头");
    // #1605：没调工具不许说发了
    expect(collabRolePrompt("Stan", "小红")).toContain("没调 invite_collaborator 就等于没发");
    expect(collabRolePrompt("Stan", "小红")).toContain("那边要 小红 看到并点头才动");
    expect(delegationRolePrompt({ isAdmin: false, ownerName: "Stan", peerName: "小红", others: [] })).not.toContain("invite_collaborator");
  });
  it("邀请那句话：带任务 id、标题、简述、谁牵头、附言；promptSafe 过一遍", () => {
    const t = { id: "t_abc", title: "周六聚餐", brief: "六个人，预算 600" };
    const s = collabInviteText(t, "Stan", "问一下小红周六晚上有没有空");
    expect(s).toContain("[协作邀请 t_abc]");
    expect(s).toContain("「周六聚餐」：六个人，预算 600");
    expect(s).toContain("Stan 的管理员牵头");
    expect(s).toContain("问一下小红周六晚上有没有空");
    expect(collabInviteText({ id: "t", title: "x", brief: "" }, "Stan", "")).not.toContain("：");
  });
});

describe("task_collab", () => {
  const ev = (seq: number, e: Record<string, unknown>): TaskEvent => ({ sessionId: "s1", seq, ts: 1000 + seq, ignorable: true, ...e }) as unknown as TaskEvent;
  it("折进任务：不动状态、记协作者；文案写「邀请了小红的管理员协作」", () => {
    const fold = new Map<string, TaskRow>();
    foldTask(fold, ev(1, { type: "task_created", taskId: "t", byAgentId: "admin", title: "周六聚餐" }), "w1");
    foldTask(fold, ev(2, { type: "task_assigned", taskId: "t", byAgentId: "admin", toAgentId: "a_x" }), "w1");
    foldTask(fold, ev(3, { type: "task_collab", taskId: "t", byAgentId: "admin", withUid: "u_xh", withName: "小红" }), "w1");
    expect(fold.get("t")).toMatchObject({ status: "assigned", collaborator: { uid: "u_xh", name: "小红" }, updatedTs: 1003 });
    const e = ev(3, { type: "task_collab", taskId: "t", byAgentId: "admin", withUid: "u_xh", withName: "小红" });
    expect(taskEventText(e, (id) => id, () => "周六聚餐")).toBe("「周六聚餐」邀请了小红的管理员协作");
    foldTask(fold, { sessionId: "s1", seq: 4, ts: 1004, type: "chat_message", fromUid: "u", label: "u", content: "x" } as SessionEvent, "w1");
    expect(fold.get("t")!.updatedTs).toBe(1003);
  });
});
