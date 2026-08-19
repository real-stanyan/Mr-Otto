// 连续工具调用的折叠组(assistant-ui 的 GroupedParts 同款)。
//
// 三条规矩:
// 1) 执行中自动展开——正在跑的东西必须看得见进度
// 2) 全部完成自动收起——跑完了它就是过程档案,不该继续占版面
// 3) 有失败就不自动收,且失败数染红——错误绝不能因为折叠被藏掉
// 用户手动点过之后就不再自动驱动:自动行为不该抢用户已经表达过的意图

import { useState } from "react";
import type { SessionEvent, ToolCallRequest, ToolResultEvent } from "../../../session/events.js";
import { summarizeGroup } from "../lib/toolSummary.js";
import { ToolRow } from "./Timeline.js";
import { ROW } from "../timelineStyles.js";

/** 组的墙上耗时:第一次开跑到最后一个结果落盘。
    不是各调用耗时之和——并发时那个数会大于实际经过的时间 */
function groupElapsed(calls: ToolCallRequest[], all: SessionEvent[]): number | null {
  const ids = new Set(calls.map((c) => c.id));
  let first: number | null = null;
  let last: number | null = null;
  for (const e of all) {
    if (e.type === "tool_execution_started" && ids.has(e.toolCallId)) {
      first ??= e.ts;
    } else if (e.type === "tool_result" && ids.has(e.toolCallId)) {
      last = e.ts;
    }
  }
  if (first === null || last === null || last < first) return null;
  return last - first;
}

export function ToolGroup({ calls, all }: { calls: ToolCallRequest[]; all: SessionEvent[] }) {
  const results = new Map<string, ToolResultEvent>();
  for (const e of all) {
    if (e.type === "tool_result") results.set(e.toolCallId, e);
  }

  const running = calls.some((c) => !results.has(c.id));
  const failed = calls.filter((c) => {
    const r = results.get(c.id);
    return r !== undefined && r.status !== "ok";
  }).length;

  // touched = 用户点过折叠头。点过之后 open 只听 manual,自动规则彻底让位
  const [touched, setTouched] = useState(false);
  const [manual, setManual] = useState(false);
  const open = touched ? manual : running || failed > 0;

  const elapsed = groupElapsed(calls, all);

  return (
    <div className={`${ROW} p-0`}>
      <button
        type="button"
        className="flex items-center gap-2 text-left bg-transparent border-none rounded-lg py-[5px] px-2 -mx-2 w-[calc(100%+16px)] text-[13px] text-muted-foreground transition-colors duration-[120ms] hover:bg-foreground/5"
        aria-expanded={open}
        onClick={() => {
          setManual(!open);
          setTouched(true);
        }}
      >
        <span className="font-[550] shrink-0 text-foreground">{summarizeGroup(calls)}</span>
        {failed > 0 && <span className="text-deny shrink-0">{failed} 个失败</span>}
        {!running && elapsed !== null && (
          <span className="tabular-nums shrink-0">{(elapsed / 1000).toFixed(1)}s</span>
        )}
        {running && <span className="shimmer shrink-0">执行中</span>}
        <span
          className={
            "ml-auto shrink-0 transition-transform duration-150 ease-strong motion-reduce:transition-none" +
            (open ? " rotate-90" : "")
          }
        >
          ›
        </span>
      </button>
      {open && (
        <div className="pl-3 border-l border-border ml-[2px] flex flex-col">
          {calls.map((c) => (
            <ToolRow key={c.id} call={c} all={all} />
          ))}
        </div>
      )}
    </div>
  );
}
