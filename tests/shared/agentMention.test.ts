import { describe, it, expect } from "vitest";
import { parseMentions } from "../../src/shared/remote/agentMention.js";

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
});
