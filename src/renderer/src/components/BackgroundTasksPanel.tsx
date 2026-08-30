// 后台任务面板（issue #452 / ADR-0109，槽位改在 issue #578 / ADR-0139，
// 改画成终端在 issue #772 / ADR-0194）。
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
// 每一行改画成一台终端（elements/terminal-block，与时间线上工具行底下那条
// 直播尾巴同一个组件）：一个跑三十分钟的构建，「◜ npm run build · 12:04」
// 这一行回答不了用户唯一真正想问的问题——它卡住了没有。所以后台任务的输出
// 也接上直播了（ADR-0194）；直播是 UI 增强不是事实，完整输出照旧随完成回注
// 那条 user_message 进日志。
//
// 行不可点：ready 的行意味着「结果还没进对话」，点它跳不到任何地方；等它进了
// 对话这一行就没了，而那条系统卡片就在时间线上。加一个点了没反应的钮不如不加。

import { useEffect, useState } from "react";
import { Maximize2, Minimize2, TerminalIcon, X } from "lucide-react";
import { useChat } from "../store.js";
import { HEADER_H } from "../settingsShell.js";
import { Button } from "./ui/button.js";
import { SidebarNub } from "./SidebarNub.js";
import { TerminalBlock } from "./elements/terminal-block.js";
import { useBackgroundOutputs, useBackgroundRuns } from "../lib/useBackgroundWatch.js";
import { formatElapsed } from "../../../shared/backgroundRuns.js";

/** elapsed 的走秒间隔。纯本地计算，不过 IPC */
const TICK_MS = 1_000;

/** 每台终端留最后这些行。限高本来就会把上面裁掉，多出来的 DOM 节点白建
    ——同 ToolLiveTail 的 TAIL_LINES，两边画的是同一种东西 */
const TAIL_LINES = 40;

/** 尾巴 → 要画的行。末尾那个换行不算一行：命令的输出几乎都以 \n 收尾，
    照直 split 会在光标前面多垫一个空 div */
function linesOf(tail: string): string[] {
  const body = tail.endsWith("\n") ? tail.slice(0, -1) : tail;
  return body === "" ? [] : body.split("\n").slice(-TAIL_LINES);
}

export function BackgroundTasksPanel() {
  const closePanel = useChat((s) => s.closeBgPanel);
  const panelWide = useChat((s) => s.panelWide);
  const togglePanelWide = useChat((s) => s.togglePanelWide);
  const runs = useBackgroundRuns();
  const outputs = useBackgroundOutputs();
  const running = runs.filter((r) => r.state === "running").length;
  const [now, setNow] = useState(() => Date.now());

  // 走秒只在真有**在跑的**任务时开：跑完的那些 elapsed 冻在 completedAt 上，
  // 为它们每秒 setState 一次是白刷
  useEffect(() => {
    if (running === 0) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [running]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header
        className={`flex ${HEADER_H} shrink-0 items-center gap-2 border-b border-border px-2 drag-region`}
      >
        <SidebarNub />
        {/* 面板能被拖到很窄:标题和图标都 shrink-0,否则「后台任务」会被压成竖排 */}
        <TerminalIcon className="size-[14px] shrink-0 opacity-70" />
        <span className="shrink-0 whitespace-nowrap text-sm font-[650]">后台任务</span>
        {/* 播报只挂在这一句上（issue #772）：输出区现在是逐帧刷新的终端，
            把 live 区圈在它外面等于让读屏软件念完整个构建日志。
            「2 个在跑 → 1 个在跑」才是值得被念出来的那句话 */}
        <span
          className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground"
          aria-live="polite"
        >
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

      <div className="min-h-0 flex-1 overflow-y-auto" aria-label="后台任务">
        {runs.length === 0 ? (
          // 空态照样画:面板是用户自己从菜单叫开的时候,「没有」也是个答案。
          // (自动开的那条路不会走到这儿——没有行就不会开)
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            现在没有在后台跑的命令
          </p>
        ) : (
          <ul className="flex flex-col gap-2 p-2" data-testid="bg-task-list">
            {runs.map((r) => {
              const lines = linesOf(outputs[r.id] ?? "");
              // 跑完的按 completedAt 冻住;跑完但日志里没有 completedAt 的
              // (ADR-0194 之前的旧日志)退回此刻的钟——不准,但比不显示强
              const elapsed = formatElapsed(r.startedAt, r.completedAt ?? now);
              return (
                <li key={r.id}>
                  <TerminalBlock
                    command={r.cmd}
                    lines={lines}
                    visibleCount={lines.length}
                    done={r.state !== "running"}
                    {...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {})}
                    footer={
                      r.state === "running"
                        ? `已跑 ${elapsed}`
                        : `跑了 ${elapsed} · 这轮说完就贴进来`
                    }
                    className="max-w-none rounded-lg"
                    // 顶部裁掉旧行而不是滚动:终端尾巴要的是「最新那几行永远在
                    // 最下面」,滚动条得追、还会被用户手滚打断(同 ToolLiveTail)。
                    // min-h-0 让还没吐字的任务收成一条细缝,而不是一个空盒子
                    bodyClassName="min-h-0 max-h-40 justify-end overflow-hidden"
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
