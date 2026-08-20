// 审批卡 diff 预览的取景逻辑 —— 从 App.tsx 的 DiffPreview 里搬出来的纯函数部分。
//
// 搬出来的理由不是"App.tsx 太长":折叠规则(连续未变行只留首尾各两行)是一条
// **产品判断** —— 审批人要看的是"改了什么",不是全文。判断该有测试钉住,
// 而它原来长在一个 JSX 组件中间,测不到。
//
// 输出直接是 assistant-ui code-diff element 吃的形状(kind: context/added/removed),
// 外加本仓多出来的一种 skip("… N 行未变 …")。

import { diffLines } from "../../../shared/diff.js";

export type DiffViewKind = "context" | "added" | "removed" | "skip";

export interface DiffViewLine {
  kind: DiffViewKind;
  text: string;
}

export interface DiffView {
  lines: DiffViewLine[];
  additions: number;
  deletions: number;
}

/** 连续未变段折叠后,首尾各留几行上下文 */
const CONTEXT = 2;

/**
 * 算出这次写盘的取景。
 *
 * @returns null = 算不动(文件过大,见 shared/diff.ts 的 MAX_CELLS),调用方退回文本兜底
 */
export function diffView(oldText: string | null, newText: string): DiffView | null {
  const lines = diffLines(oldText ?? "", newText);
  if (!lines) return null;

  const out: DiffViewLine[] = [];
  let additions = 0;
  let deletions = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.kind !== "same") {
      if (line.kind === "add") additions++;
      else deletions++;
      out.push({ kind: line.kind === "add" ? "added" : "removed", text: line.text });
      i++;
      continue;
    }
    // 一整段未变行:短的原样留着(折叠它反而更占地方),长的抽掉中间
    let j = i;
    while (j < lines.length && lines[j]!.kind === "same") j++;
    const run = j - i;
    if (run > CONTEXT * 2 + 1) {
      for (let k = i; k < i + CONTEXT; k++) out.push({ kind: "context", text: lines[k]!.text });
      out.push({ kind: "skip", text: `… ${run - CONTEXT * 2} 行未变 …` });
      for (let k = j - CONTEXT; k < j; k++) out.push({ kind: "context", text: lines[k]!.text });
    } else {
      for (let k = i; k < j; k++) out.push({ kind: "context", text: lines[k]!.text });
    }
    i = j;
  }

  return { lines: out, additions, deletions };
}
