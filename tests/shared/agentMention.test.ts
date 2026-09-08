import { describe, it, expect } from "vitest";
import { mentionTokens, parseMemberMentions, parseMentionSpans, parseMentions } from "../../src/shared/remote/agentMention.js";

const roster = [
  { agentId: "admin", name: "管理员" },
  { agentId: "ops", name: "运营" },
  { agentId: "ads", name: "广告" },
  { agentId: "ops2", name: "运营助理" },
];

describe("parseMentions（#928 切片 1a）", () => {
  it("认中文名", () => {
    expect(parseMentions("@运营 看下这周销量", roster)).toEqual(["ops"]);
  });

  it("同一句里多个 @,按出现顺序,去重", () => {
    expect(parseMentions("@运营 和 @广告 一起看，@运营 你先", roster)).toEqual(["ops", "ads"]);
  });

  it("最长匹配优先 —— 「运营助理」不该被切成「运营」加两个字", () => {
    expect(parseMentions("@运营助理 帮个忙", roster)).toEqual(["ops2"]);
  });

  it("名单里没有的名字不认,也不报错", () => {
    expect(parseMentions("@张三 在吗", roster)).toEqual([]);
  });

  it("邮箱地址里的 @ 不算 —— @ 前面得是行首或空白", () => {
    expect(parseMentions("发到 rick@运营 那个邮箱", roster)).toEqual([]);
  });

  it("没有 @ 就是空数组 —— 调用方据此走「谁都没点名」那条路", () => {
    expect(parseMentions("大家好", roster)).toEqual([]);
  });

  // Critical: 中文标点后无空格是常见句子形状
  it("中文逗号后的 @ —— 「你好，@运营」该认出运营", () => {
    expect(parseMentions("你好，@运营 看下", roster)).toEqual(["ops"]);
  });

  it("中文句号后的 @ —— 「补充一下。@广告」该认出广告", () => {
    expect(parseMentions("补充一下。@广告 这个数", roster)).toEqual(["ads"]);
  });

  // Regression: 邮箱地址仍然要挡住
  it("邮箱地址中文标点不影响 —— 「rick@运营」还是不认", () => {
    expect(parseMentions("rick@运营 的邮箱", roster)).toEqual([]);
  });

  // Important 1: @运营@广告 只认第一个，第二个前面是中文字符
  it("连续 @ —— 「@运营@广告」该认出两个", () => {
    expect(parseMentions("@运营@广告", roster)).toEqual(["ops", "ads"]);
  });

  // Important 2: 空名字吃掉所有 @
  it("名单混入空字符串,裸 @ 应该不认", () => {
    const rosterWithEmpty = [
      ...roster,
      { agentId: "phantom", name: "" },
    ];
    expect(parseMentions("@随便什么人 你好", rosterWithEmpty)).toEqual([]);
  });

  it("名单混入空字符串,末尾裸 @ 应该不认", () => {
    const rosterWithEmpty = [
      ...roster,
      { agentId: "phantom", name: "" },
    ];
    expect(parseMentions("看这个 @", rosterWithEmpty)).toEqual([]);
  });

  // #935 / #957 F1：全角 ＠（U+FF20）与半角 @ 同等对待——中文输入法全角标点习惯打出来的
  it("全角 ＠ 认成点名，与半角 @ 同等对待", () => {
    expect(parseMentions("＠运营 看下这周销量", roster)).toEqual(["ops"]);
  });

  it("全角 ＠ 也吃最长匹配、多个、去重", () => {
    expect(parseMentions("＠运营助理 和 ＠广告 一起看，@运营 你先", roster)).toEqual(["ops2", "ads", "ops"]);
  });

  it("全角 ＠ 前面是构词字符时仍算越界（同半角 @ 的边界判据）", () => {
    expect(parseMentions("rick＠运营 的邮箱", roster)).toEqual([]);
  });
});

describe("mentionTokens（#957 F4——原始 token，不按名单解析）", () => {
  it("@ 后到空白/行尾的原始 token；邮箱地址里的 @ 不算（边界判据同 parseMentions）", () => {
    expect(mentionTokens("@运营 看下 @xx销量 邮箱 a@b.c")).toEqual(["运营", "xx销量"]);
  });

  it("没有 @ 就是空数组", () => {
    expect(mentionTokens("大家好")).toEqual([]);
  });

  it("裸 @（后面立刻是空白或行尾）不产生 token", () => {
    expect(mentionTokens("看这个 @")).toEqual([]);
    expect(mentionTokens("看这个 @ 呢")).toEqual([]);
  });

  it("行首 @ 算边界", () => {
    expect(mentionTokens("@运营 在吗")).toEqual(["运营"]);
  });

  it("中文标点后的 @ 也算边界（同 parseMentions）", () => {
    expect(mentionTokens("你好，@运营 看下")).toEqual(["运营"]);
  });

  // #935 / #957 F1：全角 ＠ 与半角 @ 同等对待
  it("全角 ＠ 产生 token，与半角 @ 混用也认", () => {
    expect(mentionTokens("＠运营 看下 @广告 都在吗")).toEqual(["运营", "广告"]);
  });

  it("全角 ＠ 前面是构词字符（邮箱）不算边界", () => {
    expect(mentionTokens("rick＠运营 的邮箱")).toEqual([]);
  });
});

// ── parseMentionSpans / parseMemberMentions（#1064）────────────────────────
// 撞名归 agent 的判据是**同一个 @ 的位置**，不是名字前缀 —— 后者只覆盖一个
// 方向，反方向（agent 名字更长）会给一个根本没被点到的人发提醒。

describe("parseMentionSpans", () => {
  it("回 @ 的下标，且不去重（同一个人被 @ 两次就是两条）", () => {
    expect(parseMentionSpans("@运营 在吗 @运营", roster)).toEqual([
      { agentId: "ops", at: 0 },
      { agentId: "ops", at: 7 },
    ]);
  });

  it("最长匹配与 parseMentions 逐字同一条：@运营助理 归 ops2", () => {
    expect(parseMentionSpans("@运营助理 看下", roster)).toEqual([{ agentId: "ops2", at: 0 }]);
  });

  it("全角 ＠ 是等长替换，下标对原文同样成立", () => {
    expect(parseMentionSpans("你好，＠运营 看下", roster)).toEqual([{ agentId: "ops", at: 3 }]);
  });
});

describe("parseMemberMentions（这句话点了哪几个人）", () => {
  const agents = [{ agentId: "ops", name: "运营" }];
  const members = [
    { agentId: "u-hong", name: "小红" },
    { agentId: "u-ops", name: "运营助理" },
    { agentId: "u-space", name: "Mingxuan Zhang" },
  ];

  it("只 @ 人：回那个 uid", () => {
    expect(parseMemberMentions("@小红 帮我看下", agents, members)).toEqual(["u-hong"]);
  });

  it("名字里有空格照样认（parseMentions 按名单最长匹配，不按空白切词）", () => {
    expect(parseMemberMentions("@Mingxuan Zhang 看下", agents, members)).toEqual(["u-space"]);
  });

  it("成员名以 agent 名开头：那个 @ 归 agent，成员不通知（ADR-0252）", () => {
    // "@运营助理" 在 agent 那一遍匹配到「运营」（最长匹配吃完就收工），
    // 于是同一个 @ 的位置被占了 —— 这与选人弹层上写的
    // 「@ 会点到智能体「运营」」是同一句话
    expect(parseMentions("@运营助理 看下", agents)).toEqual(["ops"]);
    expect(parseMemberMentions("@运营助理 看下", agents, members)).toEqual([]);
  });

  it("反方向也对：agent 名字更长时，成员那一遍的短匹配同样作废（按名字前缀判会误报）", () => {
    const longAgent = [{ agentId: "a1", name: "小红助手" }];
    // 按名字判：「小红」不以「小红助手」开头 → 不算被抢 → 会给小红发一条
    // 她根本没被点到的提醒。按位置判：那个 @ 归 a1，小红不通知
    expect(parseMemberMentions("@小红助手 看下", longAgent, members)).toEqual([]);
  });

  it("一句话里 agent 与人各占一个 @：两边各认各的", () => {
    expect(parseMentions("@运营 @小红 一起看", agents)).toEqual(["ops"]);
    expect(parseMemberMentions("@运营 @小红 一起看", agents, members)).toEqual(["u-hong"]);
  });

  it("同一个人 @ 两次只回一个 uid", () => {
    expect(parseMemberMentions("@小红 在吗 @小红", agents, members)).toEqual(["u-hong"]);
  });

  it("名单为空 = 谁都没点到", () => {
    expect(parseMemberMentions("@小红 看下", agents, [])).toEqual([]);
  });
});
