import { describe, it, expect } from "vitest";
import { timelineLabel, toolFilePath, toolIcon } from "../../src/shared/toolSummary.js";

describe("timelineLabel —— 折叠头那一行", () => {
  // 换掉的是「终端 ×26 · 读取 ×2」那份按动作归并的清单:折叠头不该抄一遍
  // 展开后的内容(产品决定见 OttoToolGroup 的注释),这里钉住新口径
  it("收工后报耗时和步数", () => {
    expect(timelineLabel(5, 12_400, false)).toBe("工作了 12.4s · 5 步");
  });

  it("跑着的时候换成「工作中」", () => {
    expect(timelineLabel(3, 8_000, true)).toBe("工作中 8.0s · 3 步");
  });

  it("推不出耗时就只报步数,不硬凑一个数", () => {
    expect(timelineLabel(2, null, false)).toBe("2 步");
    expect(timelineLabel(2, null, true)).toBe("工作中 · 2 步");
  });

  it("不到一秒走毫秒——「0.4s」不如「420ms」精确", () => {
    expect(timelineLabel(1, 420, false)).toBe("工作了 420ms · 1 步");
  });

  it("过一分钟不再报小数", () => {
    expect(timelineLabel(9, 185_000, false)).toBe("工作了 3分5秒 · 9 步");
  });

  it("时钟跳变那种离谱耗时当坏数据丢掉", () => {
    expect(timelineLabel(4, -1, false)).toBe("4 步");
    expect(timelineLabel(4, 7_200_000, false)).toBe("4 步");
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
