// 侧栏更新卡片（ADR-0075；设计稿改版 issue #362，节奏回到 #316 的「点了才下载」，
// 推翻 #322 的自动下载——设计稿把 Download 按钮定成下载入口）：
// 更新器 available / downloading / ready / manual 时出现在 SidebarFooter 用户行
// 上方，其余状态整个不渲染——idle/checking 是后台的事，侧栏不值得为它们闪。
//
// 布局照设计稿：左边 otto 升级像素图，中间 "New Version Available" + 版本号，
// 右边胶囊按钮（设计稿那支手写字不跟——侧栏其余文字全是系统字，单这一颗
// 破例会显脏）。点 Download 后版本号那一行原地变成进度条；下载完成按钮变
// Restart（有会话在跑先弹确认：重启是全 app 唯一会打断跑着的 turn 的动作）。
// manual（Translocation/不可写）按钮仍叫 Download，落到 Release 页手动装。
//
// 入场动画：稀有事件（几周一次），值得一段 240ms 上滑淡入；用 transition 而非
// keyframes（状态快速翻转时可中断重定向），reduced-motion 降为纯淡入。

import { useEffect, useState } from "react";
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
import updateOtto from "../assets/update-otto.webp";
import type { UpdaterState } from "../../../shared/shellBridge.js";

const VISIBLE_PHASES = ["available", "downloading", "ready", "manual"] as const;
type VisiblePhase = (typeof VISIBLE_PHASES)[number];
type VisibleState = Extract<UpdaterState, { phase: VisiblePhase }>;

// 守卫作用在整个 state 上（不是 phase 字符串）：四个可见 phase 都带 version，
// 收窄后 JSX 里直接取
function isVisibleState(s: UpdaterState): s is VisibleState {
  return (VISIBLE_PHASES as readonly string[]).includes(s.phase);
}

export function UpdatePill() {
  const updater = useChat((s) => s.updater);
  const statusBySession = useChat((s) => s.statusBySession);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // @starting-style 的替身（repo 既有 data-mounted 模式）：先以 hidden 态首渲染，
  // 挂上后下一帧翻真，transition 接管
  const [mounted, setMounted] = useState(false);

  const visible = updater !== null && isVisibleState(updater);
  useEffect(() => {
    if (!visible) {
      setMounted(false);
      return;
    }
    const raf = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(raf);
  }, [visible]);

  if (updater === null || !isVisibleState(updater)) return null;
  const phase = updater.phase;

  const runningCount = Object.values(statusBySession).filter((s) => s === "running").length;

  const install = () => {
    setConfirmOpen(false);
    void window.otter.updaterInstallAndRestart();
  };

  const onAction = () => {
    switch (phase) {
      case "available":
        void window.otter.updaterStartDownload();
        break;
      case "ready":
        if (runningCount > 0) setConfirmOpen(true);
        else install();
        break;
      case "manual":
        void window.otter.updaterOpenReleasePage();
        break;
      case "downloading":
        break; // 按钮 disabled，到不了这里
    }
  };

  const buttonLabel = phase === "ready" ? "Restart" : "Download";
  const pct =
    phase === "downloading" && updater.total > 0
      ? Math.min(100, (updater.received / updater.total) * 100)
      : null;

  return (
    <>
      <div
        data-mounted={mounted}
        className={
          "flex w-full items-center gap-[10px] rounded-[14px] border border-border bg-card " +
          "px-[10px] py-[8px] " +
          "transition-[transform,opacity] duration-[240ms] ease-[cubic-bezier(0.23,1,0.32,1)] " +
          "data-[mounted=false]:translate-y-[6px] data-[mounted=false]:opacity-0 " +
          "motion-reduce:data-[mounted=false]:translate-y-0"
        }
        title={phase === "manual" ? updater.reason : undefined}
      >
        <img
          src={updateOtto}
          alt=""
          className="w-[38px] h-[38px] shrink-0 select-none"
          style={{ imageRendering: "pixelated" }}
          draggable={false}
        />

        <div className="flex flex-1 min-w-0 flex-col gap-[4px]">
          <span className="truncate text-left text-xs font-medium text-foreground">
            New Version Available
          </span>
          {phase === "downloading" ? (
            // 设计稿：点了 Download，版本号那一行原地变成进度条
            <div className="h-[5px] w-full overflow-hidden rounded-full bg-muted">
              {pct !== null ? (
                <div
                  className="h-full rounded-full bg-brand transition-[width] duration-300 ease-out"
                  style={{ width: `${pct}%` }}
                />
              ) : (
                // 服务器没报 Content-Length：进度未知，整条低速呼吸代替假百分比
                <div className="h-full w-full rounded-full bg-brand/50 animate-pulse" />
              )}
            </div>
          ) : (
            <span className="truncate text-left text-[11px] text-muted-foreground">
              V {updater.version}
            </span>
          )}
        </div>

        <Button
          size="sm"
          variant="outline"
          disabled={phase === "downloading"}
          onClick={onAction}
          className="shrink-0 rounded-full px-[12px] font-semibold active:scale-[0.97]"
        >
          {buttonLabel}
        </Button>
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
