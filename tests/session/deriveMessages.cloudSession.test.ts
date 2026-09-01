// 云会话（工作区群聊）的 system 段注入（issue #833）。
// 两条底线，同 packageNudge 那套：① 没有 cloud 标记的日志（本机会话/旧
// 日志）投影逐字节不变；② 有标记才多那一段。
//
// 这条测试真正盯住的东西是"云会话到底有没有 system 消息"——#833 之前
// runtime 建云会话时压根不 append session_created，而 deriveMessages 只
// 从这条事件产出 system 消息、engine 也不会补默认值，于是云端水獭跑在
// 一条**完全没有 system 提示词**的上下文里。
import { describe, expect, it } from "vitest";
import { deriveMessages, systemPromptText } from "../../src/session/deriveMessages.js";
import type { SessionEvent } from "../../src/session/events.js";

const base = (seq: number) => ({ seq, sessionId: "s", ts: 0 });
const userMsg: SessionEvent = { ...base(2), type: "user_message", content: "hi" };

describe("云会话的 system 段（issue #833）", () => {
  it("没有 cloud 标记（本机会话/旧日志）：逐字节 = 原文，不含任何云会话字样", () => {
    const created: SessionEvent = { ...base(1), type: "session_created", workspace: "/w" };
    const content = (deriveMessages([created, userMsg])[0] as { content: string }).content;
    expect(content).toBe(systemPromptText("/w", "1970-01-01"));
    expect(content).not.toContain("云沙箱");
    expect(content).not.toContain("群聊");
  });

  it("有 cloud 标记：多出云会话那一段，四件事实都在", () => {
    const created: SessionEvent = {
      ...base(1),
      type: "session_created",
      workspace: "/work",
      cloud: { workspaceId: "ws-1" },
    };
    const content = (deriveMessages([created, userMsg])[0] as { content: string }).content;
    expect(content).toBe(systemPromptText("/work", "1970-01-01", undefined, undefined, { workspaceId: "ws-1" }));
    expect(content).toContain("/work"); // ① 在容器里，工作目录是哪个
    expect(content).toContain("群聊"); // ② 对面是一群人
    expect(content).toContain("[名字]: 内容"); // ② 消息长什么样
    expect(content).toContain("工作区所有者"); // ③ 审批归谁
    expect(content).toContain("不允许 git push"); // ④ 提交推不出去
    // ⑤ 浅克隆（issue #836）：只说限制不给解法，模型会以为 blame 坏了
    expect(content).toContain("--depth 1");
    expect(content).toContain("git fetch --unshallow");
  });

  it("cloud 与 workspaceKind/isolated 互不干扰（各自独立注入）", () => {
    const withCloud = systemPromptText("/work", "d", undefined, undefined, { workspaceId: "w" });
    const plain = systemPromptText("/work", "d");
    expect(withCloud.length).toBeGreaterThan(plain.length);
    // 云那一段是**追加**，不是替换——原有的围栏/审批那几句一条都不少
    expect(withCloud).toContain("read_file / write_file 圈在这个文件夹内");
  });
});
