import { describe, it, expect } from "vitest";
import { summarizeGroup } from "../../src/renderer/src/lib/toolSummary.js";
import type { ToolCallRequest } from "../../src/session/events.js";

const read = (path: string): ToolCallRequest => ({ id: path, name: "read_file", args: { path } });
const write = (path: string): ToolCallRequest => ({
  id: "w" + path,
  name: "write_file",
  args: { path, content: "x" },
});
const bash = (cmd: string): ToolCallRequest => ({ id: "b" + cmd, name: "bash", args: { cmd } });

describe("summarizeGroup", () => {
  it("空组给空串", () => {
    expect(summarizeGroup([])).toBe("");
  });

  it("同一种动作归并计数", () => {
    expect(summarizeGroup([read("a"), read("b"), read("c")])).toBe("读取 ×3");
  });

  it("多种动作按首次出现的顺序排,不重排", () => {
    expect(summarizeGroup([write("a"), read("b"), read("c")])).toBe("写入 ×1 · 读取 ×2");
  });

  it("认不出的工具用工具名当动作", () => {
    expect(summarizeGroup([{ id: "x", name: "web_search", args: {} }])).toBe("web_search ×1");
  });

  it("终端调用归在一起", () => {
    expect(summarizeGroup([bash("ls"), bash("pwd")])).toBe("终端 ×2");
  });
});
