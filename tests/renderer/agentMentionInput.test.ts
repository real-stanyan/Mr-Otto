import { describe, it, expect } from "vitest";
import { applyAgentMention, filterAgentCandidates, mentionQueryAt, pickerEmptyState } from "../../src/renderer/src/lib/agentMentionInput.js";

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
  // #935 / #957 C-I4：全角 ＠ 与半角 @ 同等对待。
  // 注：constraints.md 原文给的例子是 mentionQueryAt("你好＠运", 4) 命中，但
  // "好" 属于 \p{L}（构词字符），按本文件头注与 tests/shared/agentMention.test.ts
  // 「全角 ＠ 前面是构词字符时仍算越界」那条已确立的边界判据，这个位置**不该**
  // 命中——命中了反而是与 parseMentions 判据分家的那种撕裂（弹出选人层，发送
  // 时却被判越界不认）。这里改用与姊妹 ASCII 用例（"看下 @运"）同构、只替换成
  // 全角字符的例子，验证的是"全角字符本身被识别"这件事，边界判据保持一致
  // （task-6-report.md 有记录）。
  it("全角 ＠ 与半角 @ 同等对待（边界判据不放宽）", () => {
    expect(mentionQueryAt("看下 ＠运", 5)).toEqual({ at: 3, query: "运" });
    expect(mentionQueryAt("rick＠x", 6)).toBeNull(); // 前面是构词字符，同邮箱不算
  });
});

describe("applyAgentMention", () => {
  it("下一个字符已经是空白时不再补 —— 不然句子中间会冒出双空格", () => {
    // 原来的实现无条件补一个空格，text[caret] 本来就是空格，落地成 "运营  明天"
    // （两个空格）；这里改成只在真的没有空白时才补
    expect(applyAgentMention("看下 @运 明天", 3, 5, "运营")).toEqual({ text: "看下 @运营 明天", caret: 6 });
  });
  it("光标在行尾 / 下一个字符不是空白时仍然补一个", () => {
    expect(applyAgentMention("看下 @运", 3, 5, "运营")).toEqual({ text: "看下 @运营 ", caret: 7 });
  });
});

describe("pickerEmptyState", () => {
  const options = [{ name: "运营" }];
  it("非 null 只有一种情形：正在打 @、已经打了字、且一个候选都没有", () => {
    expect(pickerEmptyState({ at: 0, query: "新名字" }, [])).toEqual({ query: "新名字" });
  });
  it("没在打 @ / 刚打完 @ 还没打字 / 有候选 —— 都是 null", () => {
    expect(pickerEmptyState(null, [])).toBeNull();
    expect(pickerEmptyState({ at: 0, query: "" }, [])).toBeNull();
    expect(pickerEmptyState({ at: 0, query: "运" }, options)).toBeNull();
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
