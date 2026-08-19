// 浏览器面板 —— 人和 agent 共用的那一块屏。
//
// 特别之处:真正的网页不在 React 树里,而是主进程挂在窗口 contentView 上的
// WebContentsView,浮在这个组件之上。这里的 <div ref={hostRef}> 是个占位符,
// 唯一职责是"量出自己在哪、多大",报给主进程去摆 view。
//
// 由此带来两条纪律:
// ① 卸载时必须报 null,否则面板关了网页还浮在屏幕上;
// ② 任何会改变占位符位置的动作(拖宽/全屏/窗口 resize)都得重新量。

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, RotateCw, X, Maximize2, Minimize2 } from "lucide-react";
import { useChat } from "../store.js";
import { Button } from "./ui/button.js";
import { rectToBounds } from "../lib/browserBounds.js";
import type { BrowserTabInfo } from "../../../shared/shellBridge.js";

export function BrowserPanel() {
  const sessionId = useChat((s) => s.sessionId);
  const closePanel = useChat((s) => s.closeBrowserPanel);
  const panelWide = useChat((s) => s.panelWide);
  const togglePanelWide = useChat((s) => s.togglePanelWide);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const [info, setInfo] = useState<BrowserTabInfo | null>(null);
  const [draft, setDraft] = useState("");

  // 挂载:拿这个会话浏览器的当前快照(agent 可能已经先开着某一页了)
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    void window.otter.browserOpen(sessionId).then((i) => {
      if (!alive) return;
      setInfo(i);
      setDraft(i.url);
    });
    return () => { alive = false; };
  }, [sessionId]);

  // 状态推送:只认自己这个会话的
  useEffect(() => {
    return window.otter.onBrowserState((i) => {
      if (i.sessionId !== sessionId) return;
      setInfo(i);
      // 地址栏跟着导航走,但别打断正在输入的人:只在没聚焦时同步
      if (document.activeElement?.getAttribute("data-browser-url") !== "1") setDraft(i.url);
    });
  }, [sessionId]);

  // 矩形上报:占位符自己变了(ResizeObserver)、窗口变了(resize)都重量一次。
  // 卸载时报 null——这一句就是"关面板网页也跟着消失"的全部实现
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !sessionId) return;
    const report = (visible: boolean) => {
      const bounds = rectToBounds(host.getBoundingClientRect(), visible);
      void window.otter.browserSetBounds(sessionId, bounds);
    };
    const ro = new ResizeObserver(() => report(true));
    ro.observe(host);
    const onWinResize = () => report(true);
    window.addEventListener("resize", onWinResize);
    report(true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onWinResize);
      void window.otter.browserSetBounds(sessionId, null);
    };
  }, [sessionId, panelWide]);

  const go = () => {
    if (!sessionId) return;
    void window.otter.browserNavigate(sessionId, draft);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <Button variant="ghost" size="icon" disabled={!info?.canGoBack}
          onClick={() => sessionId && void window.otter.browserBack(sessionId)}>
          <ArrowLeft className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" disabled={!info?.canGoForward}
          onClick={() => sessionId && void window.otter.browserForward(sessionId)}>
          <ArrowRight className="size-4" />
        </Button>
        <Button variant="ghost" size="icon"
          onClick={() => sessionId && void window.otter.browserReload(sessionId)}>
          <RotateCw className={`size-4 ${info?.loading ? "animate-spin" : ""}`} />
        </Button>
        <input
          data-browser-url="1"
          className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-sm outline-none focus:ring-1"
          value={draft}
          placeholder="localhost:5173 或 example.com"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") go(); }}
        />
        <Button variant="ghost" size="icon" onClick={togglePanelWide}>
          {panelWide ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </Button>
        <Button variant="ghost" size="icon" onClick={closePanel}>
          <X className="size-4" />
        </Button>
      </div>

      {info?.lastError && (
        <div className="border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          打不开：{info.lastError}
        </div>
      )}

      {/* 占位符。真正的网页由主进程浮在这块矩形上——这里保持空白且不加边框,
          有边框会和上面那层视觉打架(view 盖不住边框,边框会从网页底下透出来) */}
      <div ref={hostRef} className="min-h-0 flex-1" />
    </div>
  );
}
