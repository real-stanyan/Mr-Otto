import { describe, expect, it } from "vitest";
import {
  extractSources,
  generatedImagesOf,
  sourcePartsFor,
} from "../../src/renderer/src/aui/toolArtifacts.js";
import type { ToolCallRequest, ToolResultEvent } from "../../src/session/events.js";

function call(name: string, args: unknown, id = "c1"): ToolCallRequest {
  return { id, name, args } as ToolCallRequest;
}

function ok(output: string, id = "c1"): ToolResultEvent {
  return { sessionId: "s1", ts: 1, seq: 1, type: "tool_result", toolCallId: id, status: "ok", output };
}

describe("extractSources —— 宽松提取", () => {
  it("markdown 链接:文案当标题", () => {
    expect(extractSources("看这个 [Vite 文档](https://vite.dev/guide/) 就够了")).toEqual([
      { url: "https://vite.dev/guide/", title: "Vite 文档" },
    ]);
  });

  it("裸 URL:退回域名当标题,且去掉 www.", () => {
    expect(extractSources("来源 https://www.example.com/a/b")).toEqual([
      { url: "https://www.example.com/a/b", title: "example.com" },
    ]);
  });

  it("句末标点不算地址的一部分", () => {
    expect(extractSources("详见 https://example.com/x。").map((s) => s.url)).toEqual([
      "https://example.com/x",
    ]);
  });

  it("地址自带的配平括号留着,多出来的右括号削掉", () => {
    expect(
      extractSources("(见 https://en.wikipedia.org/wiki/Foo_(bar))").map((s) => s.url)
    ).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
  });

  it("markdown 链接里的地址不会被裸 URL 分支重复捞一遍", () => {
    expect(extractSources("[A](https://a.com/1)")).toEqual([
      { url: "https://a.com/1", title: "A" },
    ]);
  });

  it("同一个地址只留第一次(标题跟着第一次走)", () => {
    const out = extractSources("[标题](https://a.com/1)\n又见 https://a.com/1");
    expect(out).toEqual([{ url: "https://a.com/1", title: "标题" }]);
  });

  it("提不到就返回空数组 —— 调用方据此整条不渲染", () => {
    expect(extractSources("这段输出里一个网址都没有")).toEqual([]);
  });

  it("最多 10 条:云端偶尔把整页正文塞回来,不设上限会把回复顶出屏外", () => {
    const text = Array.from({ length: 30 }, (_, i) => `https://e.com/${i}`).join(" ");
    expect(extractSources(text)).toHaveLength(10);
  });
});

describe("sourcePartsFor", () => {
  it("web_search:从输出里捞,投成 url 型 source part", () => {
    expect(sourcePartsFor(call("web_search", { query: "x" }), ok("[A](https://a.com/1)"))).toEqual([
      { type: "source", sourceType: "url", id: "https://a.com/1", url: "https://a.com/1", title: "A" },
    ]);
  });

  it("web_extract:来源是被抓的那一个地址,不是正文里的一堆导航链接", () => {
    const out = sourcePartsFor(
      call("web_extract", { url: "https://b.com/page" }),
      ok("# 页面标题\n\n正文里还有 [别的](https://c.com/nav) 链接")
    );
    expect(out).toEqual([
      {
        type: "source",
        sourceType: "url",
        id: "https://b.com/page",
        url: "https://b.com/page",
        title: "页面标题",
      },
    ]);
  });

  it("web_extract 正文没有标题行时退回域名", () => {
    const out = sourcePartsFor(call("web_extract", { url: "https://b.com/page" }), ok("光秃秃的正文"));
    expect(out[0]).toMatchObject({ title: "b.com" });
  });

  it("结果还没回来 / 出错 / 被拒:都不产来源", () => {
    const c = call("web_search", { query: "x" });
    expect(sourcePartsFor(c, undefined)).toEqual([]);
    expect(sourcePartsFor(c, { ...ok("https://a.com"), status: "error" })).toEqual([]);
    expect(sourcePartsFor(c, { ...ok("https://a.com"), status: "denied" })).toEqual([]);
  });

  it("别的工具不产来源(bash 输出里的网址不是「查到的东西」)", () => {
    expect(sourcePartsFor(call("bash", { cmd: "curl" }), ok("https://a.com"))).toEqual([]);
  });
});

// ── 工具产出的图（#594）────────────────────────────────────────

const ref = (id: string, name?: string) => ({
  id,
  mediaType: "image/png",
  bytes: 9,
  ...(name !== undefined ? { name } : {}),
});

describe("generatedImagesOf —— 一组调用产出的图", () => {
  it("caption 取参数里的 prompt", () => {
    const out = generatedImagesOf([call("text_to_image", { prompt: " 一只水獭 " })], () => ({
      images: [ref("sha256:a")],
    }));
    expect(out).toEqual([{ id: "sha256:a", caption: "一只水獭" }]);
  });

  it("没有 prompt 就退回 ref 的名字，再没有退回工具名", () => {
    const noPrompt = generatedImagesOf([call("draw", {})], () => ({
      images: [ref("sha256:b", "draw.png")],
    }));
    expect(noPrompt[0]!.caption).toBe("draw.png");

    const nameless = generatedImagesOf([call("draw", {})], () => ({ images: [ref("sha256:c")] }));
    expect(nameless[0]!.caption).toBe("draw");
  });

  it("prompt 不是字符串/是空白时不采信 —— 说明文字和图无关比没有更糟", () => {
    for (const prompt of [42, null, {}, "   "]) {
      const out = generatedImagesOf([call("draw", { prompt })], () => ({
        images: [ref("sha256:d", "draw.png")],
      }));
      expect(out[0]!.caption).toBe("draw.png");
    }
  });

  it("同一张图（同 id）在一组里只画一张", () => {
    const calls = [call("draw", {}, "c1"), call("draw", {}, "c2")];
    const out = generatedImagesOf(calls, () => ({ images: [ref("sha256:same")] }));
    expect(out).toHaveLength(1);
  });

  it("旧日志没有 images 字段 / 没有结果 —— 一张不出，不炸", () => {
    expect(generatedImagesOf([call("draw", {})], () => ({}))).toEqual([]);
    expect(generatedImagesOf([call("draw", {})], () => undefined)).toEqual([]);
  });
});
