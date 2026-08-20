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

// ─── 分块（ADR-0041：审批时按块取舍） ───────────────────────────────
//
// 一个 hunk = 一段连续的改动 + 两侧各两行上下文。相隔太近的两段合成一块 ——
// 中间只隔一两行还要分开决策，等于逼人对着同一处改动点两次按钮。

/** 两段改动之间隔这么多未变行以内就合成一块（= 两侧上下文加起来） */
const MERGE_GAP = CONTEXT * 2;

export interface DiffHunkView {
  id: string;
  /** 给人看的位置：新文件里的行号范围 */
  range: string;
  lines: DiffViewLine[];
  additions: number;
  deletions: number;
}

export interface DiffDoc {
  hunks: DiffHunkView[];
  additions: number;
  deletions: number;
}

/** 改动行分组：返回每组在 diffLines 结果里的下标区间（闭区间，只含改动行） */
function changedGroups(lines: readonly { kind: string }[]): { first: number; last: number }[] {
  const changed: number[] = [];
  for (let i = 0; i < lines.length; i++) if (lines[i]!.kind !== "same") changed.push(i);
  const groups: { first: number; last: number }[] = [];
  for (const i of changed) {
    const tail = groups[groups.length - 1];
    // 中间隔着的未变行数 = i - tail.last - 1
    if (tail && i - tail.last - 1 <= MERGE_GAP) tail.last = i;
    else groups.push({ first: i, last: i });
  }
  return groups;
}

/**
 * 把一次写盘拆成可逐块决策的 hunk。
 *
 * @returns null = 算不动（超大文件）；hunks 为空 = 没有任何改动
 */
export function diffDoc(oldText: string | null, newText: string): DiffDoc | null {
  const lines = diffLines(oldText ?? "", newText);
  if (!lines) return null;

  // 新文件里的行号：same 和 add 都占一行，del 不占
  const newLineNo: number[] = [];
  let n = 0;
  for (const line of lines) {
    if (line.kind === "del") newLineNo.push(n); // 删除行贴在它后面那一行的位置上
    else newLineNo.push(++n);
  }

  const hunks: DiffHunkView[] = [];
  let additions = 0;
  let deletions = 0;
  changedGroups(lines).forEach((g, idx) => {
    const from = Math.max(0, g.first - CONTEXT);
    const to = Math.min(lines.length - 1, g.last + CONTEXT);
    const out: DiffViewLine[] = [];
    let add = 0;
    let del = 0;
    for (let i = from; i <= to; i++) {
      const line = lines[i]!;
      if (line.kind === "add") add++;
      else if (line.kind === "del") del++;
      out.push({
        kind: line.kind === "add" ? "added" : line.kind === "del" ? "removed" : "context",
        text: line.text,
      });
    }
    additions += add;
    deletions += del;
    const start = newLineNo[from] ?? 1;
    const end = newLineNo[to] ?? start;
    hunks.push({
      id: `h${idx}`,
      range: start === end ? `第 ${start} 行` : `第 ${start}–${end} 行`,
      lines: out,
      additions: add,
      deletions: del,
    });
  });

  return { hunks, additions, deletions };
}

/**
 * 按取舍结果拼出真正要写进磁盘的内容。
 *
 * 丢掉一块 = 那一段维持旧样子：它的 add 行不写，它的 del 行留着。
 * 保留一块 = 照模型说的改。未变行永远原样。
 *
 * @param discarded 被丢掉的 hunk id
 * @returns null = 算不动（与 diffDoc 同一个门槛，调用方据此退回整体批/拒）
 */
export function composeContent(
  oldText: string | null,
  newText: string,
  discarded: ReadonlySet<string>
): string | null {
  const lines = diffLines(oldText ?? "", newText);
  if (!lines) return null;
  if (discarded.size === 0) return newText; // 一块没丢 = 模型请求的原样

  // 改动行 → 它属于第几块。分组规则必须和 diffDoc 完全一致,否则 id 对不上号
  const hunkOf = new Map<number, string>();
  changedGroups(lines).forEach((g, idx) => {
    for (let i = g.first; i <= g.last; i++) {
      if (lines[i]!.kind !== "same") hunkOf.set(i, `h${idx}`);
    }
  });

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.kind === "same") {
      out.push(line.text);
      continue;
    }
    const dropped = discarded.has(hunkOf.get(i)!);
    if (line.kind === "add" && !dropped) out.push(line.text);
    if (line.kind === "del" && dropped) out.push(line.text);
  }
  return out.join("\n");
}
