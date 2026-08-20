"use client";

// 模型产出的结构化块 → 对应的展示元件。解析/校验在 lib/ottoBlocks.ts,
// 这里只管"认出来就画卡,认不出来把原文当代码块交回去"。
//
// 认不出来的路径是常态,不是异常:块还在流的时候 JSON 只写了一半;模型也会写错
// 字段。两种情况都退回代码块 —— 人看得见模型到底写了什么,也就看得出它写错在哪。

import type { SyntaxHighlighterProps } from "@assistant-ui/react-streamdown";

import { ComparisonCard } from "@/components/elements/comparison-card.js";
import { FlowGraph } from "@/components/elements/flow-graph.js";
import { ScoreBreakdown } from "@/components/elements/score-breakdown.js";
import { SpecSheet } from "@/components/elements/spec-sheet.js";
import { BLOCK_LANGUAGES, parseBlock, type BlockLanguage } from "@/lib/ottoBlocks.js";

/** 卡在对话流里的统一外形:上下留一行、不受元件自带 max-w 限制(那是画廊里
    单独展示时的宽度,对话流有自己的栏宽) */
const CARD = "my-3 max-w-none";

function Fallback({ code }: { code: string }) {
  return (
    <pre className="aui-md-pre bg-muted my-3 overflow-x-auto rounded-lg p-3 text-[13px]">
      <code>{code}</code>
    </pre>
  );
}

function OttoBlock({ code, language }: SyntaxHighlighterProps) {
  const block = parseBlock(language, code);
  if (block === null) return <Fallback code={code} />;

  switch (block.kind) {
    case "otto-spec":
      return (
        <SpecSheet
          title={block.data.title}
          {...(block.data.subtitle === undefined ? {} : { subtitle: block.data.subtitle })}
          rows={block.data.rows}
          // visibleCount 是画廊用来演示"逐行落位"的旋钮;这里内容一次到齐,全给
          visibleCount={block.data.rows.length}
          className={CARD}
        />
      );
    case "otto-compare":
      return (
        <ComparisonCard
          traitLabels={block.data.traitLabels}
          options={block.data.options}
          recommendedId={block.data.recommendedId}
          reason={block.data.reason}
          className={CARD}
        />
      );
    case "otto-score":
      return (
        <ScoreBreakdown
          verdict={block.data.verdict}
          total={block.data.total}
          outOf={block.data.outOf}
          criteria={block.data.criteria}
          visibleCount={block.data.criteria.length}
          className={CARD}
        />
      );
    case "otto-flow":
      return (
        <FlowGraph
          nodes={block.data.nodes}
          edges={block.data.edges}
          visibleCount={block.data.nodes.length}
          className={CARD}
        />
      );
  }
}

/** componentsByLanguage 的四条登记。CodeHeader 一并去掉:每张卡自己就是标题,
    上面再顶一条「otto-spec + 复制」是在暴露实现细节 */
export const OTTO_BLOCK_COMPONENTS: Record<
  BlockLanguage,
  { SyntaxHighlighter: typeof OttoBlock; CodeHeader: () => null }
> = Object.fromEntries(
  BLOCK_LANGUAGES.map((lang) => [lang, { SyntaxHighlighter: OttoBlock, CodeHeader: () => null }]),
) as Record<BlockLanguage, { SyntaxHighlighter: typeof OttoBlock; CodeHeader: () => null }>;
