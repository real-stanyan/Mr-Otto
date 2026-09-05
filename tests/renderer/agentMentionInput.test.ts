import { describe, it, expect } from "vitest";
import { applyAgentMention, filterAgentCandidates, mentionQueryAt } from "../../src/renderer/src/lib/agentMentionInput.js";

describe("mentionQueryAt", () => {
  it("刚打了 @ / 打了一半 / 中文标点后 —— 都算正在打", () => {
    expect(mentionQueryAt("@", 1)).toEqual({ at: 0, query: "" });
    // 注：brief 原文此处 caret 写的是 4，但 "看下 @运" 长度为 5（看/下/空格/@/运），
    // caret=4 只切到 "看下 @"（不含"运"），与参照实现和同一条 it 里紧邻的
    // "你好，@广" caret=5 案例的规律矛盾（那条 caret 等于全串长度）。判定这是
    // brief 里的笔误，改成 5 以与参照实现和姊妹用例保持一致（task-8-report.md 有记录）。
    expect(mentionQueryAt("看下 @运", 5)).toEqual({ at: 3, query: "运" });
    expect(mentionQueryAt("你好，@广", 5)).toEqual({ at: 3, query: "广" });
  });
  it("邮箱 / @ 后面已经有空格 / 光标不在末尾那段 —— 不算", () => {
    expect(mentionQueryAt("rick@x", 6)).toBeNull();
    expect(mentionQueryAt("@运营 看", 5)).toBeNull();
    expect(mentionQueryAt("@运营 看", 2)).toEqual({ at: 0, query: "运" });
  });
});

describe("applyAgentMention", () => {
  it("换掉 @query，补空格，光标落在空格后", () => {
    expect(applyAgentMention("看下 @运 明天", 3, 5, "运营")).toEqual({ text: "看下 @运营  明天", caret: 7 });
  });
});

describe("filterAgentCandidates", () => {
  const roster = [{ name: "管理员", description: "" }, { name: "运营", description: "管店铺" }, { name: "Ads", description: "投放" }];
  it("空 = 全部；按名字或职责；大小写不敏感", () => {
    expect(filterAgentCandidates(roster, "")).toHaveLength(3);
    expect(filterAgentCandidates(roster, "店").map((r) => r.name)).toEqual(["运营"]);
    expect(filterAgentCandidates(roster, "ads").map((r) => r.name)).toEqual(["Ads"]);
  });
});
