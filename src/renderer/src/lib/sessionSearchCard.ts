// session_search 工具卡的纯逻辑:SessionSearchResult → 两张 element 各自的 props。
// 单独抽出来(不写在 OttoThread.tsx 里)是因为这俩函数不碰 React,值得被单测直接
// 覆盖——tests/renderer 没有 RTL(vitest.config.ts 的 include 只认 *.test.ts,jsdom
// 环境也没配),组件本体测不了,但这一层能测(同 memoryChips.ts 的先例)。

import type { SessionSearchResult } from "../../../shared/sessionSearch.js";
import type { RetrievalChunk } from "../components/elements/retrieval-chunks.js";
import type { DocumentAnchor } from "../components/elements/document-reference.js";

/** discovery 结果 → RetrievalChunks 的 props。score 归一化到 0..1:除以这批结果里的
    最大分——bm25 分只在同一次查询内部可比,不同查询之间没有统一量纲,所以"归一化"
    只能是"相对这次搜到的其它结果打几分",不是绝对刻度。
    最大分 <= 0(LIKE 兜底恒为 0,理论上 -bm25 也不该是负的,但保守起见一并接住)
    → 每条都给 0.5:不是"没有信号",而是"这批结果之间分不出谁更相关",0.5 表示
    "中等、不确定",不是 0(那会被 UI 的"低分"配色判成不相关,是错的信号) */
export function toRetrievalProps(result: SessionSearchResult): {
  query: string;
  chunks: RetrievalChunk[];
  visibleCount: number;
} {
  const raw = result.chunks ?? [];
  const maxScore = raw.reduce((max, c) => Math.max(max, c.score), 0);
  const chunks: RetrievalChunk[] = raw.map((c) => ({
    id: c.id,
    source: c.source,
    locator: c.locator,
    score: maxScore > 0 ? c.score / maxScore : 0.5,
    text: c.text,
  }));
  return { query: result.query ?? "", chunks, visibleCount: chunks.length };
}

/** read 结果 → DocumentReference 的 props。anchors 的 label 字段搬到 element 的
    quote 字段(DocumentAnchor 的原文本字段就叫 quote,见 document-reference.tsx) */
export function toDocumentProps(result: SessionSearchResult): {
  title: string;
  pages: number;
  anchors: DocumentAnchor[];
} {
  const document = result.document;
  if (!document) return { title: "", pages: 0, anchors: [] };
  return {
    title: document.title,
    pages: document.pages,
    anchors: document.anchors.map((a) => ({ page: a.page, quote: a.label })),
  };
}
