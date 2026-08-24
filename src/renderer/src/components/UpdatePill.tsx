// 侧栏更新卡片（ADR-0075；节奏改版 issue #322，推翻 #316 的「点了才下载」）：
// 更新器 available / downloading / ready / manual 时出现在 SidebarFooter 用户行
// 上方，其余状态整个不渲染——idle/checking 是后台的事，侧栏不值得为它们闪。
//
// 新节奏（用户裁定，issue #322）：查到新版主进程直接自动下载，卡片自己弹出来：
// available 是一闪而过的过渡态（「即将开始下载」）；downloading 显示进度条 + MB；
// ready 出「重启更新」按钮——有会话正在跑时先弹确认：重启是全 app 唯一会打断
// 跑着的 turn 的动作，误点的代价配得上一步确认；全闲则不啰嗦。
// manual（Translocation/不可写）出「去下载页」按钮手动装。
//
// 入场动画：稀有事件（几周一次），值得一段 240ms 上滑淡入；用 transition 而非
// keyframes（状态快速翻转时可中断重定向），reduced-motion 降为纯淡入。

import { useEffect, useState } from "react";
import { ArrowUpCircle, DownloadCloud } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { useChat } from "../store.js";

const VISIBLE_PHASES = ["available", "downloading", "ready", "manual"] as const;
type VisiblePhase = (typeof VISIBLE_PHASES)[number];

function isVisiblePhase(phase: string): phase is VisiblePhase {
  return (VISIBLE_PHASES as readonly string[]).includes(phase);
}

function formatMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(0);
}

export function UpdatePill() {
  const updater = useChat((s) => s.updater);
  const statusBySession = useChat((s) => s.statusBySession);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // @starting-style 的替身（repo 既有 data-mounted 模式）：先以 hidden 态首渲染，
  // 挂上后下一帧翻真，transition 接管
  const [mounted, setMounted] = useState(false);

  const visible = updater !== null && isVisiblePhase(updater.phase);
  useEffect(() => {
    if (!visible) {
      setMounted(false);
      return;
    }
    const raf = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(raf);
  }, [visible]);

  if (updater === null || !isVisiblePhase(updater.phase)) return null;
  const phase = updater.phase;

  const runningCount = Object.values(statusBySession).filter((s) => s === "running").length;

  const install = () => {
    setConfirmOpen(false);
    void window.otter.updaterInstallAndRestart();
  };

  const onRestart = () => {
    if (runningCount > 0) setConfirmOpen(true);
    else install();
  };

  const title = (() => {
    switch (phase) {
      case "available":
        return `发现新版 v${updater.version} · 即将开始下载`;
      case "downloading":
        return `正在下载 v${updater.version}`;
      case "ready":
        return `新版 v${updater.version} 已就绪`;
      case "manual":
        return `发现新版 v${updater.version}`;
    }
  })();

  const Icon = phase === "available" || phase === "downloading" ? DownloadCloud : ArrowUpCircle;

  return (
    <>
      <div
        data-mounted={mounted}
        className={
          "flex w-full flex-col gap-[6px] rounded-[8px] border border-brand/30 bg-brand/10 px-[10px] py-[8px] " +
          "text-xs text-brand " +
          "transition-[transform,opacity] duration-[240ms] ease-[cubic-bezier(0.23,1,0.32,1)] " +
          "data-[mounted=false]:translate-y-[6px] data-[mounted=false]:opacity-0 " +
          "motion-reduce:data-[mounted=false]:translate-y-0"
        }
        title={phase === "manual" ? updater.reason : undefined}
      >
        <div className="flex items-center gap-2">
          <Icon className="w-[14px] h-[14px] shrink-0" />
          <span className="flex-1 min-w-0 truncate text-left">{title}</span>
        </div>

        {phase === "downloading" && (
          <>
            <div className="h-[4px] w-full overflow-hidden rounded-full bg-brand/15">
              {updater.total > 0 ? (
                <div
                  className="h-full rounded-full bg-brand transition-[width] duration-300 ease-out"
                  style={{ width: `${Math.min(100, (updater.received / updater.total) * 100)}%` }}
                />
              ) : (
                // 服务器没报 Content-Length：进度未知，整条低速呼吸代替假百分比
                <div className="h-full w-full rounded-full bg-brand/50 animate-pulse" />
              )}
            </div>
            <span className="text-[10px] text-brand/70">
              {updater.total > 0
                ? `${formatMb(updater.received)} / ${formatMb(updater.total)} MB`
                : `已下载 ${formatMb(updater.received)} MB`}
            </span>
          </>
        )}

        {phase === "ready" && (
          <Button size="sm" className="w-full active:scale-[0.97]" onClick={onRestart}>
            重启更新
          </Button>
        )}

        {phase === "manual" && (
          <Button
            size="sm"
            variant="outline"
            className="w-full active:scale-[0.97]"
            onClick={() => void window.otter.updaterOpenReleasePage()}
          >
            去下载页
          </Button>
        )}
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-[380px]">
          <DialogHeader>
            <DialogTitle>现在重启更新？</DialogTitle>
            <DialogDescription>
              {runningCount} 个会话正在跑，重启会打断它们——已发生的事件都在日志里，
              但没跑完的 turn 不会自己续上。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" className="active:scale-[0.97]" onClick={() => setConfirmOpen(false)}>
              先不重启
            </Button>
            <Button size="sm" className="active:scale-[0.97]" onClick={install}>
              重启更新
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
