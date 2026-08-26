// 后台任务面板（issue #452 / ADR-0109，槽位改在 issue #578 / ADR-0137）。
//
// 为什么需要它：后台任务的主要来源不是用户点单，是**前台命令跑满 30 秒自动
// 转的**（tools/bash.ts 的 AUTO_BACKGROUND_AFTER_MS，issue #395）。用户从没
// 点过单，却有五个任务在跑——在此之前界面上没有任何痕迹。
//
// 从输入框上沿搬到右侧槽位（与终端/文件/浏览器同一块地方）：贴着输入框的那一版
// 会把正在读的对话往上顶，任务一多能顶掉大半屏；而且它只在当前会话可见，
// 关掉之后再没有第二条路把它叫回来。搬进槽位之后这两件事都成立了——它有固定的
// 位置、有关闭键、能从「更多」菜单叫回来，代价是默认看不见，由自动开面板补上
// （判据在 lib/useBackgroundWatch.ts）。
//
// 行不可点：ready 的行意味着「结果还没进对话」，点它跳不到任何地方；等它进了
// 对话这一行就没了，而那条系统卡片就在时间线上。加一个点了没反应的钮不如不加。

import { useEffect, useState, type ReactElement } from "react";
import {
  CheckIcon,
  Loader2Icon,
  Maximize2,
  Minimize2,
  TerminalIcon,
  X,
  XIcon,
} from "lucide-react";
import { useChat } from "../store.js";
import { HEADER_H } from "../settingsShell.js";
import { Button } from "./ui/button.js";
import { SidebarNub } from "./SidebarNub.js";
import { useBackgroundRuns } from "../lib/useBackgroundWatch.js";
import { formatElapsed, type BackgroundRun } from "../../../shared/backgroundRuns.js";

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

export function BackgroundTasksPanel() {
  const closePanel = useChat((s) => s.closeBgPanel);
  const panelWide = useChat((s) => s.panelWide);
  const togglePanelWide = useChat((s) => s.togglePanelWide);
  const runs = useBackgroundRuns();
  const running = runs.filter((r) => r.state === "running").length;
  const [now, setNow] = useState(() => Date.now());

  // 走秒只在真有行的时候开
  useEffect(() => {
    if (runs.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [runs.length]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header
        className={`flex ${HEADER_H} shrink-0 items-center gap-2 border-b border-border px-2 drag-region`}
      >
        <SidebarNub />
        {/* 面板能被拖到很窄:标题和图标都 shrink-0,否则「后台任务」会被压成竖排 */}
        <TerminalIcon className="size-[14px] shrink-0 opacity-70" />
        <span className="shrink-0 whitespace-nowrap text-sm font-[650]">后台任务</span>
        <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
          {running > 0 ? `${running} 个在跑` : `${runs.length} 个待贴回`}
        </span>
        <div className="min-w-0 flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          title={panelWide ? "收起" : "展开"}
          onClick={togglePanelWide}
        >
          {panelWide ? <Minimize2 className="size-[14px]" /> : <Maximize2 className="size-[14px]" />}
        </Button>
        <Button variant="ghost" size="sm" className="shrink-0" title="关闭" onClick={closePanel}>
          <X className="size-[14px]" />
        </Button>
      </header>

      {/* 面板自己出现/消失不该抢走屏幕阅读器的话头（它不是在回答用户刚说的话），
          但内容变化时该被读到——polite 正是这个语义 */}
      <div className="min-h-0 flex-1 overflow-y-auto" aria-live="polite" aria-label="后台任务">
        {runs.length === 0 ? (
          // 空态照样画:面板是用户自己从菜单叫开的时候,「没有」也是个答案。
          // (自动开的那条路不会走到这儿——没有行就不会开)
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            现在没有在后台跑的命令
          </p>
        ) : (
          <ul className="flex flex-col py-1" data-testid="bg-task-list">
            {runs.map((r) => (
              <li
                key={r.id}
                className="flex items-center gap-2 px-3 py-2 text-xs [&+&]:border-t [&+&]:border-border/40"
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
        )}
      </div>
    </div>
  );
}
