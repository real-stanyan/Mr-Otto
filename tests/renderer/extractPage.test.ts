import { describe, expect, it } from "vitest";

import { extractPage } from "../../src/renderer/src/aui/toolArtifacts.js";

describe("extractPage —— 读网页那一步的卡要显示什么", () => {
  it("标准输出：# 标题 / 地址 / 正文", () => {
    const out = extractPage(
      "# Mr Otto\nhttps://example.com/otto\n\n第一段。\n第二段。",
      undefined,
    );
    expect(out).toEqual({
      url: "https://example.com/otto",
      title: "Mr Otto",
      body: "第一段。\n第二段。",
    });
  });

  it("正文里的地址优先于参数里的 —— 重定向后落地的才是这段正文的出处", () => {
    const out = extractPage("# 标题\nhttps://final.example/x\n\n正文", "https://asked.example/x");
    expect(out.url).toBe("https://final.example/x");
  });

  it("正文里没有地址就退回参数里的", () => {
    const out = extractPage("# 标题\n正文第一行", "https://asked.example/x");
    expect(out.url).toBe("https://asked.example/x");
    expect(out.body).toBe("正文第一行");
  });

  it("两头都没有地址（browser_read 不给 url = 读当前页）", () => {
    const out = extractPage("# 标题\n正文", undefined);
    expect(out.url).toBeNull();
  });

  it("连标题都没有就整段当正文 —— 格式没保证，不猜", () => {
    const out = extractPage("只有正文，没有井号", undefined);
    expect(out).toEqual({ url: null, title: null, body: "只有正文，没有井号" });
  });

  it("空参数不当地址用", () => {
    expect(extractPage("# 标题\n正文", "").url).toBeNull();
  });
});
