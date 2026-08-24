// 侧栏更新 pill（ADR-0075）：更新器 ready / manual 时出现在 SidebarFooter 用户行
// 上方，其余状态整个不渲染——checking/downloading 是后台的事，侧栏不值得为它们闪。
//
// 点击语义（用户裁定）：ready 直接换包重启；但有会话正在跑时先弹确认——重启是
// 全 app 唯一会打断跑着的 turn 的动作，误点的代价配得上一步确认；全闲则不啰嗦。
// manual（Translocation/不可写）点击开 Release 页手动装。
//
// 入场动画：稀有事件（几周一次），值得一段 240ms 上滑淡入；用 transition 而非
// keyframes（状态快速翻转时可中断重定向），reduced-motion 降为纯淡入。

import { useEffect, useState } from "react";
import { ArrowUpCircle } from "lucide-react";
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

export function UpdatePill() {
  const updater = useChat((s) => s.updater);
  const statusBySession = useChat((s) => s.statusBySession);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // @starting-style 的替身（repo 既有 data-mounted 模式）：先以 hidden 态首渲染，
  // 挂上后下一帧翻真，transition 接管
  const [mounted, setMounted] = useState(false);

  const visible = updater !== null && (updater.phase === "ready" || updater.phase === "manual");
  useEffect(() => {
    if (!visible) {
      setMounted(false);
      return;
    }
    const raf = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(raf);
  }, [visible]);

  if (updater === null || !(updater.phase === "ready" || updater.phase === "manual")) return null;

  const runningCount = Object.values(statusBySession).filter((s) => s === "running").length;

  const install = () => {
    setConfirmOpen(false);
    void window.otter.updaterInstallAndRestart();
  };

  const onClick = () => {
    if (updater.phase === "manual") {
      void window.otter.updaterOpenReleasePage();
    } else if (runningCount > 0) {
      setConfirmOpen(true);
    } else {
      install();
    }
  };

  return (
    <>
      <button
        data-mounted={mounted}
        className={
          "flex w-full items-center gap-2 rounded-[8px] border border-brand/30 bg-brand/10 px-[10px] py-[6px] " +
          "text-xs text-brand hover:bg-brand/15 active:scale-[0.97] " +
          "transition-[transform,opacity] duration-[240ms] ease-[cubic-bezier(0.23,1,0.32,1)] " +
          "data-[mounted=false]:translate-y-[6px] data-[mounted=false]:opacity-0 " +
          "motion-reduce:data-[mounted=false]:translate-y-0"
        }
        onClick={onClick}
        title={updater.phase === "manual" ? updater.reason : undefined}
      >
        <ArrowUpCircle className="w-[14px] h-[14px] shrink-0" />
        <span className="flex-1 min-w-0 truncate text-left">
          {updater.phase === "ready"
            ? `新版 v${updater.version} 已就绪 · 重启更新`
            : `发现新版 v${updater.version} · 去下载页`}
        </span>
      </button>

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
