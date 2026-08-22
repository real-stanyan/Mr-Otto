// otto-flow 的自动排版:列 = 拓扑深度(从源点出发的最长路),行 = 同列内按
// 前驱的平均行号排(barycenter),少交叉。模型给的 column/row 只当兜底
// (孤立节点、环上的节点)——模型摆格子经常让 0→2 的线从第 1 列节点背后穿过。
// 纯函数,vitest 直接跑。

import type { FlowEdge, FlowNode } from "@/components/elements/flow-graph.js";

export function layoutFlow(
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[]
): FlowNode[] {
  const ids = new Set(nodes.map((n) => n.id));
  const out = new Map<string, string[]>();
  const preds = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  for (const n of nodes) {
    out.set(n.id, []);
    preds.set(n.id, []);
    inDeg.set(n.id, 0);
  }
  const seen = new Set<string>();
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
    const key = `${e.from} ${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.get(e.from)!.push(e.to);
    preds.get(e.to)!.push(e.from);
    inDeg.set(e.to, inDeg.get(e.to)! + 1);
  }

  // Kahn:按最长路定深度。环上的节点永远出不了队,留着用模型给的 column
  const depth = new Map<string, number>();
  const queue = nodes.filter((n) => inDeg.get(n.id) === 0).map((n) => n.id);
  for (const id of queue) depth.set(id, 0);
  const remaining = new Map(inDeg);
  while (queue.length > 0) {
    const id = queue.shift()!;
    const d = depth.get(id)!;
    for (const next of out.get(id)!) {
      depth.set(next, Math.max(depth.get(next) ?? 0, d + 1));
      const left = remaining.get(next)! - 1;
      remaining.set(next, left);
      if (left === 0) queue.push(next);
    }
  }

  const column = (n: FlowNode): number =>
    remaining.get(n.id) === 0 ? (depth.get(n.id) ?? n.column) : n.column;

  // 同列内排行:有前驱的按前驱平均行号,没有的按模型给的 row;并列按原顺序
  const byColumn = new Map<number, FlowNode[]>();
  for (const n of nodes) {
    const c = column(n);
    const bucket = byColumn.get(c);
    if (bucket) bucket.push(n);
    else byColumn.set(c, [n]);
  }
  const row = new Map<string, number>();
  const columns = [...byColumn.keys()].sort((a, b) => a - b);
  for (const c of columns) {
    const keyed = byColumn.get(c)!.map((n, i) => {
      const ps = preds.get(n.id)!.filter((p) => row.has(p));
      const bary =
        ps.length > 0 ? ps.reduce((acc, p) => acc + row.get(p)!, 0) / ps.length : n.row;
      return { n, bary, i };
    });
    keyed.sort((a, b) => a.bary - b.bary || a.i - b.i);
    keyed.forEach(({ n }, r) => row.set(n.id, r));
  }

  return nodes.map((n) => ({ ...n, column: column(n), row: row.get(n.id) ?? n.row }));
}
