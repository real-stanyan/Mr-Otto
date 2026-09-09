// 一条回复怎么拆成几个气泡（#1132）的纯逻辑。判据只有一条：**空行分段，代码围栏
// 里的空行不算**。这份钉的是判据本身；「拆出来的真被画成几张气泡」在
// tests/renderer/CloudAssistantBubbles.test.tsx 与 CloudPendingTurnLines.test.tsx。

import { describe, expect, it } from "vitest";
import { splitBubbles } from "../../src/renderer/src/lib/chatBubbles.js";

describe("splitBubbles（#1132）——空行 = 下一条消息", () => {
  it("空行分段，每段一个气泡；首尾空白与多余空行不生出空气泡", () => {
    expect(splitBubbles("看了一圈，结论是没问题。\n\n下一步我去改样式。\n\n\n改完 @ 你。\n")).toEqual([
      "看了一圈，结论是没问题。",
      "下一步我去改样式。",
      "改完 @ 你。",
    ]);
  });

  it("没有空行 = 一个气泡；换行留在原处（一行一件的清单不拆）", () => {
    expect(splitBubbles("要做三件事：\n改样式\n加组件\n跑门禁")).toEqual(["要做三件事：\n改样式\n加组件\n跑门禁"]);
  });

  it("代码围栏里的空行不算分段——那是交付物，切开就读不了", () => {
    const text = "脚本在这：\n\n```bash\necho a\n\necho b\n```\n\n跑完告诉我。";
    expect(splitBubbles(text)).toEqual(["脚本在这：", "```bash\necho a\n\necho b\n```", "跑完告诉我。"]);
  });

  it("没关上的围栏（流式预览正长到一半）把后面全部留在同一个气泡里", () => {
    expect(splitBubbles("先说一句。\n\n```\nline 1\n\nline 2")).toEqual(["先说一句。", "```\nline 1\n\nline 2"]);
  });

  it("只有空白 → 空数组（画不画那个空气泡由调用方定）", () => {
    expect(splitBubbles("")).toEqual([]);
    expect(splitBubbles("  \n\n ")).toEqual([]);
  });

  it("只含空白字符的行也算空行（模型爱在空行里留一个空格）", () => {
    expect(splitBubbles("上一段。\n  \n下一段。")).toEqual(["上一段。", "下一段。"]);
  });
});
