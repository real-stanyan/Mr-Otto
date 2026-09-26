// sessionLast —— 名册「最后一句」的判据（#1356 A1，spec §7.1）。runtime 按它决定往库里
// 写什么，手机按它的 from 格式读回来——两边共用这一份。

import { describe, expect, it } from "vitest";
import { LAST_EXCERPT_MAX, excerptOf, lastOf, lastSpeakerOf } from "../../src/shared/sessionLast.js";
import type { SessionEvent } from "../../src/session/events.js";

const base = { seq: 1, sessionId: "s1", ts: 5000 };
const user = (o: Record<string, unknown>): SessionEvent => ({ ...base, type: "user_message", ...o }) as unknown as SessionEvent;
const reply = (o: Record<string, unknown>): SessionEvent =>
  ({ ...base, type: "assistant_message", model: "m", ...o }) as unknown as SessionEvent;
const chat = (o: Record<string, unknown>): SessionEvent =>
  ({ ...base, type: "chat_message", label: "Stan", mention: false, ...o }) as unknown as SessionEvent;

describe("excerptOf", () => {
  it("第一段非空文字、折叠空白", () => {
    expect(excerptOf("  门禁绿了，\n推到   分支了。\n\n第二段不要")).toBe("门禁绿了， 推到 分支了。");
  });
  it("只有空白 → 空串", () => {
    expect(excerptOf(" \n\n  ")).toBe("");
  });
  it(`超过 ${LAST_EXCERPT_MAX} 字截断，连省略号正好 ${LAST_EXCERPT_MAX} 字；按字符数不按码元`, () => {
    const long = "一".repeat(200);
    const out = excerptOf(long);
    expect(Array.from(out)).toHaveLength(LAST_EXCERPT_MAX);
    expect(out.endsWith("…")).toBe(true);
    const emoji = "😀".repeat(130);
    expect(Array.from(excerptOf(emoji))).toHaveLength(LAST_EXCERPT_MAX); // 不把 emoji 劈成两半
  });
  it("正好 120 字不截", () => {
    const exact = "二".repeat(LAST_EXCERPT_MAX);
    expect(excerptOf(exact)).toBe(exact);
  });
});

describe("lastOf", () => {
  it("人打的 user_message：剥掉 [名字]: 前缀，from = human:<uid>", () => {
    expect(lastOf(user({ content: "[Stan]: 帮我看下排班\n\n还有进货", fromUid: "u1" }))).toEqual({
      ts: 5000, excerpt: "帮我看下排班", from: "human:u1",
    });
  });
  it("接力 / 招呼开场白不算（fromUid 是点火的人，不是他此刻说的话）", () => {
    expect(lastOf(user({ content: "[系统]: …", fromUid: "u1", relay: { depth: 1 } }))).toBeNull();
    expect(lastOf(user({ content: "打个招呼", fromUid: "u1", greeting: "voice_call" }))).toBeNull();
  });
  it("engine 注的旁白（后台任务 / 护栏）不算", () => {
    expect(lastOf(user({ content: "后台任务 bg-1 完成", origin: "background", agentId: "a_000000000001" }))).toBeNull();
    expect(lastOf(user({ content: "你在打转", origin: "loop_guard", fromUid: "u1" }))).toBeNull();
  });
  it("没有 fromUid 的 user_message（本机旧日志）不算", () => {
    expect(lastOf(user({ content: "hi" }))).toBeNull();
  });
  it("agent 的答案算，from = agent:<id>；要了工具的中间步骤 / 空正文 / 没 agentId 的不算", () => {
    expect(lastOf(reply({ content: "国庆三个人两班倒。", agentId: "a_000000000001" }))).toEqual({
      ts: 5000, excerpt: "国庆三个人两班倒。", from: "agent:a_000000000001",
    });
    expect(lastOf(reply({ content: "我先查一下", agentId: "a1", toolCalls: [{ id: "c1", name: "bash", args: {} }] }))).toBeNull();
    expect(lastOf(reply({ content: "   ", agentId: "a1" }))).toBeNull();
    expect(lastOf(reply({ content: "旧日志", }))).toBeNull();
  });
  it("人的 chat_message 算；系统旁白（fromUid=system）不算", () => {
    expect(lastOf(chat({ content: "大家看一下", fromUid: "u2" }))).toEqual({ ts: 5000, excerpt: "大家看一下", from: "human:u2" });
    expect(lastOf(chat({ content: "没派出去", fromUid: "system", label: "系统" }))).toBeNull();
  });
  it("别的事件一律不算", () => {
    expect(lastOf({ ...base, type: "turn_ended", outcome: "completed" } as unknown as SessionEvent)).toBeNull();
  });
});

describe("lastSpeakerOf", () => {
  it("两种前缀", () => {
    expect(lastSpeakerOf("agent:a_000000000001")).toEqual({ kind: "agent", agentId: "a_000000000001" });
    expect(lastSpeakerOf("human:u1")).toEqual({ kind: "human", uid: "u1" });
  });
  it("空串 / 认不出 / 前缀后面是空的 → null", () => {
    expect(lastSpeakerOf("")).toBeNull();
    expect(lastSpeakerOf("bot:x")).toBeNull();
    expect(lastSpeakerOf("agent:")).toBeNull();
  });
});
