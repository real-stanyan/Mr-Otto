// 换执行器投影成 system 尾块（#1223，spec §3.5）：一条都没有 = 逐字节不变；cloud = 「碰不到电脑文件」；
// 回到电脑 = 「全部工具可用」；换了一台 Mac 多一句「文件不在这台机器上」。
import { describe, expect, it } from "vitest";
import { deriveMessages, renderExecutorPrompt } from "../../src/session/deriveMessages.js";
import type { SessionEvent } from "../../src/session/events.js";

const base = (seq: number) => ({ seq, sessionId: "s", ts: 0 });
const created: SessionEvent = { ...base(0), type: "session_created", workspace: "/Users/a/Documents/Mr Otto/Default/s-1", workspaceKind: "default" };
const user: SessionEvent = { ...base(9), type: "user_message", content: "开工" };
const ex = (seq: number, executor: "desktop" | "cloud", label?: string): SessionEvent => ({
  ...base(seq), type: "executor_changed", executor, ignorable: true, ...(label ? { label } : {}),
});
const systemOf = (events: SessionEvent[]): string => (deriveMessages(events)[0] as { content: string }).content;

describe("system 尾部的执行器块（#1223）", () => {
  it("没有 executor_changed：投影逐字节不变", () => {
    expect(systemOf([created, user])).toBe(systemOf([created, user]));
    expect(systemOf([created, user])).not.toContain("云端");
  });
  it("云端在跑：说清碰不到电脑文件、要记待办、回复像发消息", () => {
    const content = systemOf([created, ex(1, "cloud"), user]);
    expect(content).toContain("你现在在云端替用户接着这条会话");
    expect(content).toContain("todo_write");
    expect(content.endsWith("]")).toBe(true); // 追在最尾，prefix cache 只从这儿失效
  });
  it("回到电脑：全部工具可用；此前没上过云的桌面切换（同一台）一字不加", () => {
    expect(systemOf([created, ex(1, "cloud"), ex(2, "desktop", "A"), user])).toContain("你回到了电脑上，全部工具可用");
    expect(systemOf([created, ex(1, "desktop", "A"), user])).toBe(systemOf([created, user]));
  });
  it("换了一台电脑：多一句文件不在这台机器上（判据是 label 变了）", () => {
    const content = systemOf([created, ex(1, "desktop", "A"), ex(2, "cloud"), ex(3, "desktop", "B"), user]);
    expect(content).toContain("这是另一台电脑");
    const same = systemOf([created, ex(1, "desktop", "A"), ex(2, "cloud"), ex(3, "desktop", "A"), user]);
    expect(same).not.toContain("这是另一台电脑");
  });
  it("renderExecutorPrompt 单独可测", () => {
    expect(renderExecutorPrompt({ kind: "desktop", everCloud: false, changedMachine: false })).toBe("");
    expect(renderExecutorPrompt({ kind: "desktop", everCloud: false, changedMachine: true })).toContain("另一台电脑");
  });
});
