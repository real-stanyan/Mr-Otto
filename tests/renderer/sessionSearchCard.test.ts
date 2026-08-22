import { describe, expect, it } from "vitest";
import { toDocumentProps, toRetrievalProps } from "../../src/renderer/src/lib/sessionSearchCard.js";
import type { SessionSearchResult } from "../../src/shared/sessionSearch.js";

function discovery(partial: Partial<SessionSearchResult>): SessionSearchResult {
  return { mode: "discovery", query: "悉尼", chunks: [], ...partial };
}

function read(partial: Partial<SessionSearchResult>): SessionSearchResult {
  return { mode: "read", ...partial };
}

describe("toRetrievalProps", () => {
  it("score 按最大分归一化到 0..1", () => {
    const result = discovery({
      chunks: [
        { id: "1", sessionId: "s1", seq: 1, source: "a", locator: "L1", text: "t1", score: 4 },
        { id: "2", sessionId: "s1", seq: 2, source: "b", locator: "L2", text: "t2", score: 2 },
        { id: "3", sessionId: "s1", seq: 3, source: "c", locator: "L3", text: "t3", score: 1 },
      ],
    });
    const props = toRetrievalProps(result);
    expect(props.query).toBe("悉尼");
    expect(props.chunks.map((c) => c.score)).toEqual([1, 0.5, 0.25]);
    expect(props.visibleCount).toBe(3);
  });

  it("全 0 分(LIKE 兜底)→ 每条给 0.5,不是 0", () => {
    const result = discovery({
      chunks: [
        { id: "1", sessionId: "s1", seq: 1, source: "a", locator: "L1", text: "t1", score: 0 },
        { id: "2", sessionId: "s1", seq: 2, source: "b", locator: "L2", text: "t2", score: 0 },
      ],
    });
    const props = toRetrievalProps(result);
    expect(props.chunks.map((c) => c.score)).toEqual([0.5, 0.5]);
  });

  it("chunks 为空 → 空数组,visibleCount 为 0,不除以 0", () => {
    const props = toRetrievalProps(discovery({ chunks: [] }));
    expect(props.chunks).toEqual([]);
    expect(props.visibleCount).toBe(0);
  });

  it("chunks 缺失(非 discovery 模式漏了)→ 空数组兜底", () => {
    const props = toRetrievalProps({ mode: "discovery" });
    expect(props.chunks).toEqual([]);
    expect(props.visibleCount).toBe(0);
  });

  it("query 缺失 → 空串兜底", () => {
    const props = toRetrievalProps({ mode: "discovery", chunks: [] });
    expect(props.query).toBe("");
  });

  it("保留 source/locator/text 原样搬运", () => {
    const result = discovery({
      chunks: [
        { id: "1", sessionId: "s1", seq: 1, source: "src", locator: "loc", text: "文本", score: 1 },
      ],
    });
    const [chunk] = toRetrievalProps(result).chunks;
    expect(chunk).toMatchObject({ id: "1", source: "src", locator: "loc", text: "文本" });
  });
});

describe("toDocumentProps", () => {
  it("anchors 的 label 映射到 element 的 quote 字段", () => {
    const result = read({
      document: {
        sessionId: "s1",
        title: "调试 FTS5",
        pages: 3,
        anchors: [
          { page: 0, label: "开场白" },
          { page: 2, label: "结尾" },
        ],
      },
    });
    const props = toDocumentProps(result);
    expect(props.title).toBe("调试 FTS5");
    expect(props.pages).toBe(3);
    expect(props.anchors).toEqual([
      { page: 0, quote: "开场白" },
      { page: 2, quote: "结尾" },
    ]);
  });

  it("document 缺失 → 空壳兜底,不抛异常", () => {
    const props = toDocumentProps(read({}));
    expect(props).toEqual({ title: "", pages: 0, anchors: [] });
  });

  it("anchors 为空 → 空数组", () => {
    const props = toDocumentProps(
      read({ document: { sessionId: "s1", title: "t", pages: 1, anchors: [] } }),
    );
    expect(props.anchors).toEqual([]);
  });
});
