// message_friend 的纯逻辑（#1549）：代发前缀、回给模型的那句、上限常量与 messages.body 的 check 对得上。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CALL_FRIEND_TOOL_NAME, FRIEND_MESSAGE_MAX, FRIEND_MESSAGE_PER_HOUR_MAX, MESSAGE_FRIEND_TOOL_NAME, agentDmBody, friendMessageSentText,
} from "../../src/shared/outreach.js";

describe("message_friend 常量", () => {
  it("刀名与 call_friend 分得开；正文上限 + 前缀落在 messages.body 的 4000 以内", () => {
    expect(MESSAGE_FRIEND_TOOL_NAME).toBe("message_friend");
    expect(MESSAGE_FRIEND_TOOL_NAME).not.toBe(CALL_FRIEND_TOOL_NAME);
    const sql = readFileSync(new URL("../../supabase/migrations/0001_friends.sql", import.meta.url), "utf8");
    expect(sql).toMatch(/body text not null check \(length\(body\) between 1 and 4000\)/);
    expect([...agentDmBody("名".repeat(60), "字".repeat(FRIEND_MESSAGE_MAX))].length).toBeLessThanOrEqual(4000);
    expect(FRIEND_MESSAGE_PER_HOUR_MAX).toBeGreaterThan(0);
  });
});

describe("agentDmBody", () => {
  it("纯文本前缀标明代发——这条是以主人名义写的，不标就是冒充；不是 JSON 信封（老客户端照常读）", () => {
    const body = agentDmBody("管理员", "三条：设置公开智能体、跑迁移、出新包");
    expect(body).toBe("[管理员 代发] 三条：设置公开智能体、跑迁移、出新包");
    expect(() => JSON.parse(body)).toThrow();
  });
});

describe("friendMessageSentText", () => {
  it("说清发给谁、对方看到什么、回不回看不到；长正文截 80 字", () => {
    const short = friendMessageSentText("小红", "[管理员 代发] 好的");
    expect(short).toContain("小红");
    expect(short).toContain("「[管理员 代发] 好的」");
    expect(short).toContain("看不到");
    const long = friendMessageSentText("小红", "字".repeat(200));
    expect(long).toContain(`「${"字".repeat(80)}…」`);
    expect(long).not.toContain("字".repeat(81));
  });
});
