// 协作请求 / 决定两种事件的登记（#1605 第 1 期 a）：每一张穷举表都表态；投影成给对面 / 给发起方读的一句；任务上协作者的状态跟着走。
import { describe, expect, it } from "vitest";
import { KNOWN_EVENT_TYPES, type CollabDecisionEvent, type CollabRequestEvent, type SessionEvent } from "../../src/session/events.js";
import { PRIVACY_VERDICTS } from "../../src/shared/sessionPackage.js";
import { PEN_VERDICTS } from "../../src/shared/taskSync.js";
import { hiddenFromCloudTimeline } from "../../src/shared/cloudTimeline.js";
import { shouldPersist } from "../../src/session/persistencePolicy.js";
import { deriveMessages } from "../../src/session/deriveMessages.js";
import { foldTask, type TaskRow } from "../../src/shared/tasks.js";
import { COLLAB_EXPIRE_MS, collabDecisionText, collabRequestText } from "../../src/shared/collab.js";

const request: CollabRequestEvent = {
  sessionId: "s", seq: 5, ts: 5, type: "collab_request", requestId: "r_1", taskId: "t_1", title: "看 9 月营业额", fromUid: "u_a", fromAgentName: "雨姐",
  quote: { ownerName: "继爸", ownerLine: "@我的管理员 你带上 Stan 的管理员去看看营业额", note: "只要总数" }, result: "9 月 $78,807", expiresTs: 5 + COLLAB_EXPIRE_MS,
  byAgentId: "admin", ignorable: true,
};
const decision: CollabDecisionEvent = { sessionId: "s", seq: 6, ts: 6, type: "collab_decision", requestId: "r_1", decision: "accepted", byUid: "u_b", ignorable: true };
const base = { sessionId: "s", seq: 0, ts: 0, type: "session_created", workspace: "/work", cloud: { workspaceId: "w", chat: { kind: "dm" }, home: true } } as const;

describe("协作事件的登记", () => {
  it("两种都是已知类型、落盘、分享包里剥掉、要握笔、桌面时间线不画", () => {
    for (const t of ["collab_request", "collab_decision"] as const) {
      expect(KNOWN_EVENT_TYPES.has(t)).toBe(true);
      expect(PRIVACY_VERDICTS[t]).toBe("strip");
      expect(PEN_VERDICTS[t]).toBe("executor");
      expect(shouldPersist(t)).toBe(true);
    }
    expect(hiddenFromCloudTimeline(request)).toBe(true);
    expect(hiddenFromCloudTimeline(decision)).toBe(true);
  });
  it("请求投影成给对面管理员读的一句（谁找、原话、说明、结果、先等主人点头）；决定投影成给发起方读的一句", () => {
    const users = deriveMessages([base, request, decision]).filter((m) => m.role === "user").map((m) => String(m.content));
    expect(users).toHaveLength(2);
    expect(users[0]).toContain("[协作请求 r_1] 继爸 的管理员");
    expect(users[0]).toContain("找你配合");
    expect(users[0]).toContain("只要总数");
    expect(users[0]).toContain("$78,807");
    expect(users[0]).toContain("你主人点了头才轮到你动");
    expect(users[1]).toContain("[协作 r_1] 对面主人：接了");
    expect(collabDecisionText({ requestId: "r", decision: "expired" })).toContain("对面没回");
    expect(collabRequestText({ ...request, quote: { ...request.quote, ownerLine: "", note: "" }, result: "" })).not.toContain("原话");
  });
  it("卡在工具调用与 tool_result 之间时先攒着", () => {
    const log: SessionEvent[] = [
      base,
      { sessionId: "s", seq: 1, ts: 1, type: "user_message", content: "看看", fromUid: "owner", mentions: ["admin"] },
      { sessionId: "s", seq: 2, ts: 2, type: "assistant_message", agentId: "admin", model: "m", content: "", toolCalls: [{ id: "c1", name: "read_file", args: {} }] },
      { ...request, seq: 3, ts: 3 },
      { sessionId: "s", seq: 4, ts: 4, type: "tool_result", toolCallId: "c1", status: "ok", output: "x" },
    ];
    const msgs = deriveMessages(log);
    expect(msgs.findIndex((m) => m.role === "user" && String(m.content).startsWith("[协作请求"))).toBeGreaterThan(msgs.map((m) => m.role).lastIndexOf("tool"));
  });
  it("任务上协作者的状态：task_collab 之后请求记 pending + requestId；决定按 requestId 找回任务推状态；没任务（对面那份）不折", () => {
    const fold = new Map<string, TaskRow>();
    const ev = (e: Record<string, unknown> & { seq: number }): SessionEvent => ({ sessionId: "s", ts: e.seq, ...e }) as unknown as SessionEvent;
    foldTask(fold, ev({ seq: 1, type: "task_created", taskId: "t_1", byAgentId: "admin", title: "看营业额", ignorable: true }), "w");
    foldTask(fold, ev({ seq: 2, type: "task_collab", taskId: "t_1", byAgentId: "admin", withUid: "u_b", withName: "Stan", ignorable: true }), "w");
    foldTask(fold, { ...request, seq: 3 }, "w");
    expect(fold.get("t_1")!.collaborator).toEqual({ uid: "u_b", name: "Stan", state: "pending", requestId: "r_1" });
    foldTask(fold, { ...decision, seq: 4, decision: "declined" as const }, "w");
    expect(fold.get("t_1")!.collaborator!.state).toBe("declined");
    expect(fold.get("t_1")!.status).toBe("open");
    const empty = new Map<string, TaskRow>();
    foldTask(empty, request, "w");
    foldTask(empty, decision, "w");
    expect(empty.size).toBe(0);
  });
});
