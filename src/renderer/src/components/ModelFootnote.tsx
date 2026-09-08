// 上下文浮层末尾那一行（判据与文案规则在 lib/modelFootnote.ts）。
//
// **整行不换行**，且挤不下时让步的只有型号名：右边那串是定长事实（`shrink-0`），
// 把它截掉等于把这一行唯一的量化信息弄丢；型号名 `truncate` 之后至少还认得出
// 半个牌子，旁边还有那枚 logo。原来这一行会折成两行——一行脚注折成两行之后，
// 它「扫一眼」的全部用处就没了。

import { useMemo } from "react";
import { ProviderIcon } from "./ProviderIcon.js";
import { modelFootnoteView, type FootnoteCache } from "../lib/modelFootnote.js";
import type { ModelUsage } from "../../../session/deriveUsage.js";

export function ModelFootnote({ rows, cache }: { rows: ModelUsage[]; cache: FootnoteCache | null }) {
  const view = useMemo(() => modelFootnoteView(rows, cache), [rows, cache]);
  if (view === null) return null;

  return (
    <div
      className="mt-[7px] flex items-center gap-2 overflow-hidden whitespace-nowrap text-[11px] text-muted-foreground"
      title={view.title}
    >
      <span className="flex min-w-0 items-center gap-[5px]">
        {view.marks.map((model) => (
          <ProviderIcon key={model} model={model} />
        ))}
        <span className="truncate">{view.label}</span>
      </span>
      <span className="ml-auto shrink-0 font-mono text-[10.5px] tabular-nums">{view.stat}</span>
    </div>
  );
}
