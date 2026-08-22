// 派活卡点开后的那一块:子会话转录,限制在卡片范围内上下滚,随手收起看下一个。
// 不整屏切到子会话 —— 那条路(resume)仍留着,右上角「打开会话」一键过去。

import { useEffect } from "react";
import { CheckIcon, ExternalLinkIcon, Loader2Icon, XIcon } from "lucide-react";
import type { SessionEvent } from "../../../session/events.js";
import { cn } from "@/lib/utils.js";
import { mono } from "@/lib/surfaces.js";
import { subagentTranscript } from "../lib/subagentTranscript.js";
import { useChat } from "../store.js";

export function SubagentTranscriptPanel({
  childSessionId,
  done,
  className,
}: {
  childSessionId: string;
  /** 子会话收口了没。没收口就不问日志——loadSubagentLog 会把半截日志缓存住,
      之后再也不刷新(它是"收口后补一笔事实"的通道,不是直播) */
  done: boolean;
  className?: string;
}) {
  const events: readonly SessionEvent[] | undefined = useChat(
    (s) => s.subagentLogCache[childSessionId]
  );
  const loadSubagentLog = useChat((s) => s.loadSubagentLog);
  const resume = useChat((s) => s.resume);
  useEffect(() => {
    if (done) void loadSubagentLog(childSessionId);
  }, [done, childSessionId, loadSubagentLog]);

  const rows = events ? subagentTranscript(events) : [];

  return (
    <div
      data-slot="subagent-transcript"
      className={cn("flex min-h-0 flex-col gap-1 border-t border-foreground/10 pt-2", className)}
      // 父元素是可点的整张卡:这块里的点击/按键别冒上去把卡又收起来
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-end px-1">
        <button
          type="button"
          onClick={() => void resume(childSessionId)}
          className="text-foreground/45 hover:text-foreground flex items-center gap-1 text-[11px] transition-colors"
        >
          <ExternalLinkIcon className="size-3" />
          打开会话
        </button>
      </div>
      <div className="max-h-[40vh] overflow-y-auto overscroll-contain px-1 pb-1">
        {!done ? (
          <p className="text-foreground/45 py-3 text-center text-xs">还在跑,收口后可在这里回看</p>
        ) : events === undefined ? (
          <p className="text-foreground/45 py-3 text-center text-xs">读取中…</p>
        ) : rows.length === 0 ? (
          <p className="text-foreground/45 py-3 text-center text-xs">子会话里没有内容</p>
        ) : (
          <ol className="flex flex-col gap-1.5 text-xs">
            {rows.map((r, i) =>
              r.kind === "tool" ? (
                <li key={i} className="flex min-w-0 items-center gap-2 py-0.5">
                  {r.status === "ok" ? (
                    <CheckIcon className="size-3 shrink-0 text-emerald-500" />
                  ) : r.status === "running" ? (
                    <Loader2Icon className="text-foreground/35 size-3 shrink-0 animate-spin" />
                  ) : (
                    <XIcon className="size-3 shrink-0 text-red-500" />
                  )}
                  <span className="text-foreground/70 shrink-0">{r.verb}</span>
                  <span className={cn(mono, "text-foreground/90 truncate")} title={r.target}>
                    {r.target || r.name}
                  </span>
                  {r.note ? (
                    <span className={cn(mono, "text-red-400/80 truncate")} title={r.note}>
                      {r.note}
                    </span>
                  ) : null}
                </li>
              ) : (
                <li
                  key={i}
                  className={cn(
                    "rounded-lg px-2.5 py-1.5 whitespace-pre-wrap break-words leading-relaxed",
                    r.kind === "user"
                      ? "bg-foreground/[0.06] text-foreground/80"
                      : "text-foreground/90"
                  )}
                >
                  {r.text}
                </li>
              )
            )}
          </ol>
        )}
      </div>
    </div>
  );
}
