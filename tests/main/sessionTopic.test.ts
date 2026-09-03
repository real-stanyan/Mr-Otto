// sessionTopic（#846）：会话主题分类的提示词块 + 解析。纯函数，纪律同 sessionTitler：
// 模型产出的 JSON 不可信，形状不对 / 不在索引里 → null，永不抛。
import { describe, expect, it } from "vitest";
import { parseSessionTopic, topicBlock, topicSource } from "../../src/main/sessionTopic.js";

const index = [
  { slug: "work", label: "工作", entries: 2 },
  { slug: "hobbies", label: "爱好", entries: 0 },
];

describe("topicSource", () => {
  it("null → null；有消息 → 截到 2000", () => {
    expect(topicSource(null)).toBeNull();
    expect(topicSource("改装车")).toBe("改装车"); // 没有长度阈值：短消息也要分类
    expect(topicSource("很".repeat(5000))?.length).toBe(2000);
  });
});

describe("topicBlock", () => {
  it("带围栏、列索引、要求只从索引里选", () => {
    const b = topicBlock("帮我看看 WRX 改装", index, "abc12345");
    expect(b).toContain("<abc12345>\n帮我看看 WRX 改装\n</abc12345>");
    expect(b).toContain("work（工作）· 2 条");
    expect(b).toContain("hobbies");
    expect(b).toContain("任务四");
    expect(b).toContain("sessionTopic");
  });
});

describe("parseSessionTopic", () => {
  const allowed = ["work", "hobbies"];
  it("合法：在索引里的 slug", () => {
    expect(parseSessionTopic('{"sessionTopic":"hobbies"}', allowed)).toBe("hobbies");
    expect(parseSessionTopic('```json\n{"sessionTopic":"work"}\n```', allowed)).toBe("work");
  });
  it("不在索引里 / null / 空 / 非字符串 / 坏 JSON → null", () => {
    expect(parseSessionTopic('{"sessionTopic":"travel"}', allowed)).toBeNull();
    expect(parseSessionTopic('{"sessionTopic":null}', allowed)).toBeNull();
    expect(parseSessionTopic('{"sessionTopic":""}', allowed)).toBeNull();
    expect(parseSessionTopic('{"sessionTopic":3}', allowed)).toBeNull();
    expect(parseSessionTopic("not json", allowed)).toBeNull();
    expect(parseSessionTopic('{"sessionTitle":"x"}', allowed)).toBeNull();
  });
});
