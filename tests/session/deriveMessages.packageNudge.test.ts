// workspaceKind:"default" 的「打包为项目」引导注入(#559 后续)。
// 两条底线:① 没有这个标记的日志(旧日志/项目会话)投影逐字节不变;
// ② 有标记才多那一段,且估算(contextEstimate)和真实请求同一份文案。
import { describe, expect, it } from "vitest";
import { deriveMessages, systemPromptText } from "../../src/session/deriveMessages.js";
import type { SessionEvent } from "../../src/session/events.js";

const base = (seq: number) => ({ seq, sessionId: "s", ts: 0 });
const userMsg: SessionEvent = { ...base(2), type: "user_message", content: "hi" };

describe("package_project 引导注入", () => {
  it("没有 workspaceKind(旧日志/项目会话):system 逐字节 = systemPromptText 原文", () => {
    const created: SessionEvent = { ...base(1), type: "session_created", workspace: "/w" };
    const msgs = deriveMessages([created, userMsg]);
    expect((msgs[0] as { content: string }).content).toBe(systemPromptText("/w", "1970-01-01"));
    expect((msgs[0] as { content: string }).content).not.toContain("package_project");
  });

  it("workspaceKind:'default':system 多出引导段,提到 package_project", () => {
    const created: SessionEvent = {
      ...base(1),
      type: "session_created",
      workspace: "/w",
      workspaceKind: "default",
    };
    const msgs = deriveMessages([created, userMsg]);
    const content = (msgs[0] as { content: string }).content;
    expect(content).toBe(systemPromptText("/w", "1970-01-01", "default"));
    expect(content).toContain("package_project");
    expect(content).toContain("打包");
  });

  it("systemPromptText 不传 kind 与传 undefined 逐字节一致(老调用方不变)", () => {
    expect(systemPromptText("/w", "2026-08-26")).toBe(systemPromptText("/w", "2026-08-26", undefined));
  });
});
