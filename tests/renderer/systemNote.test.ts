// 旁白判据与它的两段正文（第四批 C2-I1）：摘要行说事实、全文可展开。
// 后台任务那条正文的形状由 src/main/backgroundTasks.ts 的 formatCompletion
// 定死（首行 `[后台任务 bg-N 完成] <cmd>`、第二行 `exit code: N`、其余是
// 输出），这里的用例照它造。
import { describe, it, expect } from "vitest";
import { isSystemNote, systemNoteBody, systemNoteDetail } from "../../src/renderer/src/lib/systemNote.js";
import type { SessionEvent, UserMessageEvent } from "../../src/session/events.js";

const base = { sessionId: "s", ts: 0, seq: 1 } as const;
const bg = (content: string): UserMessageEvent =>
  ({ ...base, type: "user_message", content, origin: "background", backgroundTaskIds: ["bg-3"] });
const guard: UserMessageEvent =
  { ...base, type: "user_message", content: "你在重复同一组命令…", origin: "loop_guard", agentId: "a_1" };
const human: UserMessageEvent = { ...base, type: "user_message", content: "在吗" };

const note = (e: UserMessageEvent) => {
  if (!isSystemNote(e)) throw new Error("不是旁白");
  return e;
};

describe("systemNoteBody（background）", () => {
  it("三行正文：首行 + 括号里的 exit code，输出不进摘要", () => {
    const e = bg("[后台任务 bg-3 完成] npm test\nexit code: 137\nstdout:\nkilled");
    expect(systemNoteBody(note(e), null)).toBe("[后台任务 bg-3 完成] npm test（exit code: 137）");
  });

  it("只有一行（没跑出 exit code 那行）：只回首行，不装作解析出了退出码", () => {
    const e = bg("[后台任务 bg-3 完成] npm test");
    expect(systemNoteBody(note(e), null)).toBe("[后台任务 bg-3 完成] npm test");
  });
});

describe("systemNoteBody（loop_guard）", () => {
  it("文案不变：名字由调用方解析好传进来，传 null 落兜底话", () => {
    expect(systemNoteBody(note(guard), "运营")).toBe("护栏：「运营」在原地打转，已提醒");
    expect(systemNoteBody(note(guard), null)).toBe("护栏：「某只智能体」在原地打转，已提醒");
  });
});

describe("systemNoteDetail", () => {
  it("background：回原始正文全文（摘要是它的投影，不另拼一份）", () => {
    const content = "[后台任务 bg-3 完成] npm test\nexit code: 137\nstdout:\nkilled";
    expect(systemNoteDetail(bg(content))).toBe(content);
  });

  it("loop_guard：null——摘要行已经把这条说完了，摊开只是把提示词泄给用户看", () => {
    expect(systemNoteDetail(guard)).toBeNull();
  });

  it("不是旁白（人打的话）：null，调用方不必再套一层 isSystemNote", () => {
    expect(systemNoteDetail(human)).toBeNull();
    const tool: SessionEvent = { ...base, type: "session_created", workspace: "/w" } as SessionEvent;
    expect(systemNoteDetail(tool)).toBeNull();
  });
});
