import { describe, expect, it } from "vitest";
import {
  MAX_TOPICS, SEED_TOPICS, isTopicSlug, renderTopicIndex, slugsFromFileNames,
  topicLabel, topicLabelRelPath, topicRelPath, withSeedTopics,
} from "../../src/shared/memoryTopics.js";

describe("isTopicSlug —— ASCII kebab，≤ 24 字符", () => {
  it("合法：小写字母开头，字母/数字/连字符", () => {
    expect(isTopicSlug("work")).toBe(true);
    expect(isTopicSlug("car-mods")).toBe(true);
    expect(isTopicSlug("a1")).toBe(true);
    expect(isTopicSlug("a".repeat(24))).toBe(true);
  });
  it("非法：大写、中文、空、数字开头、超长、非字符串", () => {
    for (const bad of ["Work", "工作", "", "1a", "a".repeat(25), "a b", null, 3])
      expect(isTopicSlug(bad), String(bad)).toBe(false);
  });
});

describe("路径", () => {
  it("topicRelPath / topicLabelRelPath", () => {
    expect(topicRelPath("work")).toBe("memories/topics/work.md");
    expect(topicLabelRelPath("work")).toBe("memories/topics/work.label");
  });
  it("非法 slug 抛（绝不拼出越界路径）", () => {
    expect(() => topicRelPath("../x")).toThrow(/slug/);
  });
});

describe("种子与索引", () => {
  it("四个种子桶，顺序固定", () => {
    expect(Object.keys(SEED_TOPICS)).toEqual(["work", "hobbies", "life", "learning"]);
    expect(SEED_TOPICS["work"]).toBe("工作");
    expect(MAX_TOPICS).toBe(8);
  });
  it("slugsFromFileNames 只认 <slug>.md，过滤非法、去重、排序", () => {
    expect(slugsFromFileNames(["work.md", "work.label", "Bad.md", "cars.md", "cars.md", "notes.txt"]))
      .toEqual(["cars", "work"]);
  });
  it("withSeedTopics = 种子在前（声明序）+ 其余字典序，不重复", () => {
    expect(withSeedTopics(["cars", "work", "art"])).toEqual(["work", "hobbies", "life", "learning", "art", "cars"]);
  });
  it("renderTopicIndex 一行一桶", () => {
    expect(renderTopicIndex([{ slug: "work", label: "工作", entries: 3 }, { slug: "cars", label: "cars", entries: 0 }]))
      .toBe("work（工作）· 3 条\ncars（cars）· 0 条");
  });
  it("topicLabel：label 文件 > 种子表 > slug", () => {
    expect(topicLabel("work", null)).toBe("工作");
    expect(topicLabel("work", " 上班 \n")).toBe("上班");
    expect(topicLabel("cars", null)).toBe("cars");
    expect(topicLabel("cars", "   ")).toBe("cars");
  });
});
