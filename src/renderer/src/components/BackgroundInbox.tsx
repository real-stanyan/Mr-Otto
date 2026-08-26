// 后台任务面板（issue #452 / ADR-0109）——输入框上方，有任务才出现。
//
// 为什么需要它：后台任务的主要来源不是用户点单，是**前台命令跑满 30 秒自动
// 转的**（tools/bash.ts 的 AUTO_BACKGROUND_AFTER_MS，issue #395）。用户从没
// 点过单，却有五个任务在跑——在此之前界面上没有任何痕迹。
//
// 行不可点：ready 的行意味着「结果还没进对话」，点它跳不到任何地方；等它进了
// 对话这一行就没了，而那条系统卡片就在时间线上。加一个点了没反应的钮不如不加。

import { useEffect, useMemo, useState, type ReactElement } from "react";
import { CheckIcon, Loader2Icon, TerminalIcon, XIcon } from "lucide-react";
import { useChat } from "../store.js";
import { cn } from "@/lib/utils.js";
import {
  projectBackgroundRuns,
  hasUndeliveredBackgroundTasks,
  formatElapsed,
  type BackgroundRun,
} from "../../../shared/backgroundRuns.js";

/** live 集合的重取间隔。它只回答一件事——「started 没配上 completed 的那些，
    进程还活着吗」——而这个答案只在 app 重启那一刻会变，不必跟着秒表刷 */
const LIVE_POLL_MS = 5_000;
/** elapsed 的走秒间隔。纯本地计算，不过 IPC */
const TICK_MS = 1_000;

const ROW_ICON: Record<BackgroundRun["state"], ReactElement> = {
  running: <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />,
  ready: <CheckIcon className="size-3.5 shrink-0 text-ok" />,
  failed: <XIcon className="size-3.5 shrink-0 text-err" />,
};

const ROW_NOTE: Record<BackgroundRun["state"], string> = {
  running: "",
  ready: "跑完了，这轮说完就贴进来",
  failed: "跑完了（失败），这轮说完就贴进来",
};

export function BackgroundInbox() {
  const sessionId = useChat((s) => s.sessionId);
  const events = useChat((s) => s.events);
  const [liveIds, setLiveIds] = useState<ReadonlySet<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());

  // 没有候选就一趟 IPC 都不发——面板绝大多数时间是空的，
  // 不该为了空面板常驻一个轮询
  const hasCandidates = useMemo(() => hasUndeliveredBackgroundTasks(events), [events]);

  useEffect(() => {
    if (!sessionId || !hasCandidates) {
      setLiveIds(new Set());
      return;
    }
    let alive = true;
    const pull = async () => {
      const live = await window.otter.liveBackgroundTasks(sessionId);
      // 会话切走后回来的那趟结果不能往新会话身上贴
      if (alive) setLiveIds(new Set(live.map((t) => t.id)));
    };
    void pull();
    const timer = setInterval(() => void pull(), LIVE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [sessionId, hasCandidates, events.length]);

  const runs = useMemo(() => projectBackgroundRuns(events, liveIds), [events, liveIds]);
  const running = runs.filter((r) => r.state === "running").length;

  // 走秒只在真有行的时候开
  useEffect(() => {
    if (runs.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [runs.length]);

  if (runs.length === 0) return null;

  return (
    <div
      // 出现动效：位移 + 透明度，200ms ease-strong。不从 scale(0) 长出来——
      // 现实里没有东西从虚无里冒出来。reduce-motion 时只留透明度
      className={cn(
        "mb-2 overflow-hidden rounded-[12px] border border-border/60 bg-card/60 text-xs",
        "transition-[opacity,transform] duration-200 ease-strong",
        "starting:translate-y-1 starting:opacity-0",
        "motion-reduce:transition-opacity motion-reduce:starting:translate-y-0"
      )}
      // 面板自己出现/消失不该抢走屏幕阅读器的话头（它不是在回答用户刚说的话），
      // 但内容变化时该被读到——polite 正是这个语义
      aria-live="polite"
      aria-label="后台任务"
    >
      <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[11px] text-muted-foreground">
        <TerminalIcon className="size-3" />
        <span>在后台跑着</span>
        <span className="ml-auto tabular-nums">
          {running > 0 ? `${running} 个在跑` : `${runs.length} 个待贴回`}
        </span>
      </div>
      <ul className="flex flex-col pb-1">
        {runs.map((r) => (
          <li
            key={r.id}
            className="flex items-center gap-2 px-3 py-1.5 [&+&]:border-t [&+&]:border-border/40"
          >
            {ROW_ICON[r.state]}
            <div className="min-w-0 flex-1">
              {/* 命令可能很长，截断成一行；title 里给全文 */}
              <div className="truncate font-mono text-[12px] text-foreground/90" title={r.cmd}>
                {r.cmd}
              </div>
              {ROW_NOTE[r.state] && (
                <div className="truncate text-[11px] text-muted-foreground">
                  {ROW_NOTE[r.state]}
                  {r.exitCode !== undefined && r.exitCode !== 0 ? ` · exit ${r.exitCode}` : ""}
                </div>
              )}
            </div>
            <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
              {formatElapsed(r.startedAt, now)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
