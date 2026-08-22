"use client";

import type { ComponentProps } from "react";
import { cn } from "@/lib/utils.js";
import { paper } from "@/lib/surfaces.js";
import { take } from "@/lib/range.js";

export type FlowNodeState = "done" | "active" | "pending";

export interface FlowNode {
  id: string;
  label: string;
  column: number;
  row: number;
  state: FlowNodeState;
}

export interface FlowEdge {
  from: string;
  to: string;
}

// 格子要放得下中文标签:78px 宽只够四个汉字,"测试覆盖率提升"会折成两行撑破。
// 节点 124×40,列距留 44px 给连线转弯,行距留 24px 让两行之间不贴
const NODE_W = 124;
const NODE_H = 40;
const COL_W = NODE_W + 44;
const ROW_H = NODE_H + 24;
const ARROW = 5;

export function FlowGraph({
  nodes,
  edges,
  visibleCount,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "nodes" | "edges" | "visibleCount"
> & {
  nodes: readonly FlowNode[];
  edges: readonly FlowEdge[];
  visibleCount: number;
}) {
  const shown = take(nodes, visibleCount);
  const shownIds = new Set(shown.map((node) => node.id));
  const columns = Math.max(0, ...nodes.map((node) => node.column)) + 1;
  const rows = Math.max(0, ...nodes.map((node) => node.row)) + 1;
  const width = (columns - 1) * COL_W + NODE_W;
  const height = (rows - 1) * ROW_H + NODE_H;

  const center = (node: FlowNode) => ({
    x: node.column * COL_W + NODE_W / 2,
    y: node.row * ROW_H + NODE_H / 2,
  });

  return (
    <div
      data-slot="flow-graph"
      className={cn(
        paper,
        "w-full overflow-x-auto rounded-2xl p-4",
        className,
      )}

      {...props}
    >
      <div className="relative" style={{ width, height, minWidth: width }}>
        <svg
          aria-hidden
          className="absolute inset-0 overflow-visible"
          width={width}
          height={height}
        >
          <defs>
            <marker
              id="flow-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth={ARROW}
              markerHeight={ARROW}
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" className="fill-foreground/30" />
            </marker>
          </defs>
          {edges.map((edge) => {
            const from = nodes.find((node) => node.id === edge.from);
            const to = nodes.find((node) => node.id === edge.to);
            if (!from || !to) return null;
            const live = shownIds.has(edge.from) && shownIds.has(edge.to);
            const a = center(from);
            const b = center(to);
            // 从右沿出、左沿进,水平切出切入(控制点钉在两端的列间隙里);
            // 回边(to 在左边)就从底沿绕到顶沿
            const forward = to.column > from.column;
            const sameColumn = to.column === from.column;
            let d: string;
            if (forward) {
              const x1 = a.x + NODE_W / 2;
              const x2 = b.x - NODE_W / 2 - 1;
              const gap = Math.min(36, (x2 - x1) / 2);
              d = `M ${x1} ${a.y} C ${x1 + gap} ${a.y}, ${x2 - gap} ${b.y}, ${x2} ${b.y}`;
            } else if (sameColumn) {
              const down = b.y > a.y;
              const y1 = a.y + (down ? NODE_H / 2 : -NODE_H / 2);
              const y2 = b.y + (down ? -NODE_H / 2 - 1 : NODE_H / 2 + 1);
              d = `M ${a.x} ${y1} L ${a.x} ${y2}`;
            } else {
              const y1 = a.y + NODE_H / 2;
              const y2 = b.y - NODE_H / 2 - 1;
              const dip = Math.max(y1, y2) + ROW_H / 2 - NODE_H / 2;
              d = `M ${a.x} ${y1} C ${a.x} ${dip}, ${b.x} ${dip}, ${b.x} ${y2}`;
            }
            return (
              <path
                key={`${edge.from}-${edge.to}`}
                d={d}
                fill="none"
                strokeWidth="1.5"
                markerEnd="url(#flow-arrow)"
                className={cn(
                  "transition-opacity duration-500 motion-reduce:transition-none",
                  live ? "stroke-foreground/30" : "stroke-foreground/5",
                )}
              />
            );
          })}
        </svg>

        {shown.map((node) => (
          <div
            key={node.id}
            className={cn(
              "fade-in zoom-in-95 animate-in fill-mode-both absolute flex items-center justify-center rounded-xl border text-center text-xs leading-tight duration-300",
              node.state === "done" &&
                "border-foreground/10 bg-foreground/[0.04] text-foreground/50",
              node.state === "active" &&
                "text-foreground/90 border-blue-500/30 bg-blue-500/10 dark:border-blue-400/30",
              node.state === "pending" &&
                "border-foreground/8 text-foreground/35 border-dashed",
            )}
            style={{
              left: node.column * COL_W,
              top: node.row * ROW_H,
              width: NODE_W,
              height: NODE_H,
            }}
          >
            <span className="line-clamp-2 px-2.5 break-all" title={node.label}>
              {node.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
