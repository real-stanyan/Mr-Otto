import { describe, it, expect } from "vitest";
import { timelineLabel, toolFilePath, toolIcon, toolSummary } from "../../src/shared/toolSummary.js";

describe("timelineLabel —— 折叠头那一行", () => {
  // 换掉的是「终端 ×26 · 读取 ×2」那份按动作归并的清单:折叠头不该抄一遍
  // 展开后的内容(产品决定见 OttoToolGroup 的注释),这里钉住新口径
  it("收工后报耗时 + 用了几把工具 + 动了几个文件", () => {
    expect(timelineLabel(5, 2, 12_400, false)).toBe("工作了 12.4s · 5 tools used, 2 files changed");
  });

  it("跑着的时候换成「工作中」", () => {
    expect(timelineLabel(3, 0, 8_000, true)).toBe("工作中 8.0s · 3 tools used");
  });

  it("一个文件 / 一把工具走单数", () => {
    expect(timelineLabel(1, 1, 900, false)).toBe("工作了 900ms · 1 tool used, 1 file changed");
  });

  it("一个文件都没动就不提这一段 —— 「0 files changed」是句废话", () => {
    expect(timelineLabel(4, 0, 3_000, false)).toBe("工作了 3.0s · 4 tools used");
  });

  it("推不出耗时就不报耗时,不硬凑一个数", () => {
    expect(timelineLabel(2, 0, null, false)).toBe("2 tools used");
    expect(timelineLabel(2, 0, null, true)).toBe("工作中 · 2 tools used");
  });

  it("过一分钟不再报小数", () => {
    expect(timelineLabel(9, 0, 185_000, false)).toBe("工作了 3分5秒 · 9 tools used");
  });

  it("时钟跳变那种离谱耗时当坏数据丢掉", () => {
    expect(timelineLabel(4, 0, -1, false)).toBe("4 tools used");
    expect(timelineLabel(4, 0, 7_200_000, false)).toBe("4 tools used");
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

describe("toolSummary —— create_agent（#954）", () => {
  it("动词「创建智能体」+ 目标是名字；名字缺席目标为空", () => {
    expect(toolSummary({ id: "c1", name: "create_agent", args: { name: "广告", instructions: "x" } }))
      .toEqual({ verb: "创建智能体", target: "广告", stat: "" });
    expect(toolSummary({ id: "c2", name: "create_agent", args: {} })).toEqual({ verb: "创建智能体", target: "", stat: "" });
  });
});
