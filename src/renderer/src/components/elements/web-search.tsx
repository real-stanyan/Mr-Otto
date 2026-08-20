"use client";

import type { ComponentProps, ReactNode } from "react";
import { SearchIcon } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { field, mono, ShimmerLabel } from "@/lib/surfaces.js";
import { take } from "@/lib/range.js";

export interface WebSearchResult {
  title: string;
  domain: string;
  /** 本仓改动:地址。原件只画标题和域名(演示不用真的点开),
      本仓这张卡里的每一条都是能打开的东西 */
  url?: string;
}

/** 本仓改动:一行结果的容器。给了 onOpen 就渲染成按钮(能点、能用键盘走到),
    没给就还是原件那个 div —— 外观两边一模一样 */
function Row({ onOpen, children }: { onOpen?: () => void; children: ReactNode }) {
  const className =
    "fade-in slide-in-from-bottom-1 animate-in fill-mode-both hover:bg-foreground/[0.03] -mx-2.5 flex items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-start transition-colors duration-300";
  if (!onOpen) return <div className={className}>{children}</div>;
  return (
    <button type="button" onClick={onOpen} className={className}>
      {children}
    </button>
  );
}

export function WebSearch({
  query,
  results,
  visibleResults,
  searching,
  cycle,
  statusLabel,
  searchingLabel,
  onOpenResult,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "query" | "results" | "visibleResults" | "searching" | "cycle"
> & {
  query: string;
  results: readonly WebSearchResult[];
  visibleResults: number;
  searching: boolean;
  cycle: number;
  /** 本仓改动:搜完那行字。原件写死 "Read 3 sources"(演示里永远是 3 条),
      真实条数得由调用方说,而且本仓是中文界面 */
  statusLabel?: ReactNode;
  /** 本仓改动:搜索中那行字。理由同 statusLabel */
  searchingLabel?: ReactNode;
  /** 本仓改动:点一条要能打开。给了就把行渲染成按钮 —— 一行里既有标题又有域名、
      鼠标移上去还变底色,不能点才是意外 */
  onOpenResult?: (result: WebSearchResult) => void;
}) {
  return (
    <div
      data-slot="web-search"
      className={cn("flex w-full max-w-sm flex-col gap-2.5", className)}

      {...props}
    >
      <span
        className={cn(
          field,
          "text-foreground/70 inline-flex w-fit items-center gap-1.5 rounded-full px-3.5 py-2 text-xs",
        )}
      >
        <SearchIcon className="text-foreground/40 size-3" />
        {query}
      </span>
      <div className="text-foreground/45 text-xs">
        {searching ? (
          <ShimmerLabel className="relative inline-block leading-none">
            {searchingLabel ?? "Searching"}
          </ShimmerLabel>
        ) : (
          <span className="fade-in animate-in duration-300">
            {statusLabel ?? `Read ${results.length} sources`}
          </span>
        )}
      </div>
      <div className="flex min-h-[5.75rem] flex-col">
        {take(results, visibleResults).map((result, i) => (
          // 本仓改动:key 带上下标。同一个站点可以出现两条结果(同域名不同页),
          // 只拿域名当 key 会撞
          <Row
            key={`${cycle}-${i}-${result.domain}`}
            {...(onOpenResult ? { onOpen: () => onOpenResult(result) } : {})}
          >
            <span className="bg-foreground/[0.06] text-foreground/45 flex size-4 shrink-0 items-center justify-center rounded text-[9px] font-medium">
              {result.domain.charAt(0).toUpperCase()}
            </span>
            <span className="text-foreground/90 min-w-0 flex-1 truncate text-[13.5px]">
              {result.title}
            </span>
            <span className={cn(mono, "text-foreground/35 shrink-0")}>
              {result.domain}
            </span>
          </Row>
        ))}
      </div>
    </div>
  );
}
