import { describe, expect, it } from "vitest";
import { serializeSubagent, parseSubagentMd } from "../../src/main/subagents.js";
import type { SubagentDef } from "../../src/shared/subagent.js";

const KNOWN = ["read_file", "write_file", "bash", "web_search"];

const def: SubagentDef = {
  name: "searcher",
  description: "只读搜索员",
  instructions: "你是一个只读搜索员。",
  tools: ["read_file", "web_search"],
  unknownTools: [],
  model: "deepseek-chat",
  thinking: "off",
  approval: "deny",
  path: "/a/searcher.md",
  source: "/a",
  readOnly: false,
};

describe("serializeSubagent", () => {
  it("往返一致：序列化再解析回来，语义字段不变", () => {
    const text = serializeSubagent(def);
    const back = parseSubagentMd(text, {
      fallbackName: "x",
      knownTools: KNOWN,
      path: def.path,
      source: def.source,
      readOnly: false,
    });
    expect(back).toEqual(def);
  });

  it("缺席的可选字段不写进 frontmatter（别把 undefined 写成字面量）", () => {
    // exactOptionalPropertyTypes：字面量赋 undefined 和字段缺席是两回事，
    // 这里要测的是"缺席"，用解构去掉这两个 key 而不是显式赋 undefined
    const { model: _model, thinking: _thinking, ...withoutOptional } = def;
    const text = serializeSubagent(withoutOptional);
    expect(text).not.toContain("model:");
    expect(text).not.toContain("thinking:");
  });

  it("unknownTools 原样保留，用户的手写内容不被静默吃掉", () => {
    const text = serializeSubagent({ ...def, unknownTools: ["Grep"] });
    expect(text).toContain("Grep");
  });
});
