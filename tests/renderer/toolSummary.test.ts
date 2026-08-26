import { describe, it, expect } from "vitest";
import { summarizeGroup, toolFilePath, toolIcon } from "../../src/shared/toolSummary.js";
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

describe("toolFilePath —— 这一步动的是哪个文件", () => {
  it("读写文件给完整路径（不是摘要行里那个 basename）", () => {
    expect(toolFilePath({ id: "1", name: "read_file", args: { path: "src/renderer/src/App.tsx" } }))
      .toBe("src/renderer/src/App.tsx");
    expect(toolFilePath({ id: "1", name: "write_file", args: { path: "a/b.ts", content: "x" } }))
      .toBe("a/b.ts");
  });

  it("不碰文件的工具一律 null —— bash 的目标是一条命令，给它画文件图标是在说假话", () => {
    expect(toolFilePath({ id: "1", name: "bash", args: { cmd: "npm test" } })).toBeNull();
    expect(toolFilePath({ id: "1", name: "web_search", args: { query: "x" } })).toBeNull();
  });

  it("路径缺失/不是字符串也当没有 —— 模型给的 args 不可信", () => {
    expect(toolFilePath({ id: "1", name: "read_file", args: {} })).toBeNull();
    expect(toolFilePath({ id: "1", name: "read_file", args: { path: "" } })).toBeNull();
    expect(toolFilePath({ id: "1", name: "read_file", args: { path: 42 } })).toBeNull();
  });
});

describe("toolIcon —— 工具行打头的小图标（lucide 名字，组件在渲染层查表）", () => {
  it("读/写文件给 null：走 FileTypeIcon，不用通用图标说假话", () => {
    expect(toolIcon("read_file")).toBeNull();
    expect(toolIcon("write_file")).toBeNull();
  });
  it("常见工具各认各的图标", () => {
    expect(toolIcon("bash")).toBe("SquareTerminal");
    expect(toolIcon("web_search")).toBe("Search");
    expect(toolIcon("task")).toBe("Bot");
    expect(toolIcon("ask_user")).toBe("MessageCircleQuestion");
  });
  it("认不出的（MCP 工具）给通用扳手", () => {
    expect(toolIcon("mcp__github__create_issue")).toBe("Wrench");
  });
});
