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
import { ArrowLeft, ArrowRight, RotateCw, X, Maximize2, Minimize2, Power } from "lucide-react";
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

  // 矩形上报:每帧量一次占位符,变了才发 IPC。
  //
  // 为什么是 rAF 而不是 ResizeObserver:网页是浮在这个组件之上的独立图层,
  // 它得跟住占位符的**位置**,而 ResizeObserver 只在尺寸变化时触发,位移一概不报。
  // 本面板的宿主 .side-panel 恰好有 200ms 的 translateX 入场动画(app.css),
  // 于是挂载时那一次测量量到的是动画中途的坐标,尺寸自始至终没变过——
  // 观察者再也不叫,网页就永远钉在那个错位的地方(实测:整块页面偏出面板)。
  // 位移的来源还不止动画:拖拽分隔线、侧栏折叠、窗口 resize、字体加载导致的重排,
  // 与其一条条挂监听,不如每帧问一次几何——只读四个数,变了才过桥,静止时零 IPC。
  //
  // 卸载时报 null——这一句就是"关面板网页也跟着消失"的全部实现
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !sessionId) return;
    let raf = 0;
    let last = "";
    const tick = () => {
      const bounds = rectToBounds(host.getBoundingClientRect(), true);
      const key = JSON.stringify(bounds);
      if (key !== last) {
        last = key;
        void window.otter.browserSetBounds(sessionId, bounds);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      void window.otter.browserSetBounds(sessionId, null);
    };
  }, [sessionId, panelWide]);

  const go = () => {
    if (!sessionId) return;
    void window.otter.browserNavigate(sessionId, draft);
  };

  // 真正把这个会话的浏览器销毁掉。
  //
  // 为什么要单独一颗按钮:右边那颗 X 是"收面板",按前提只摘不杀
  // (重开时页面还在、登录态还在),于是一个 WebContentsView 一旦开出来就再没有
  // 出口——开过十个会话的浏览器 = 十个 Chromium 渲染进程活到 app 退出。
  // 终端那边同一件事是靠标签上的 X 解决的(TerminalView.closeTab → terminalClose),
  // 但这里一个会话只有一个浏览器、没有标签行可挂,所以摆进工具栏。
  // 语义差别也因此必须靠图标和 title 说清:X = 收起(页面留着),
  // 这颗电源 = 结束(页面、历史、前进后退全没,下次开是全新一张白页)。
  // cookie/登录态存在 persist: 分区里,不随 view 走,所以"结束"不等于登出。
  //
  // 销毁完顺手收面板:view 已经没了,留着面板只会显示一份过期快照
  const shutdown = async () => {
    if (!sessionId) return;
    await window.otter.browserClose(sessionId);
    closePanel();
  };

  return (
    // flex-1 + min-w-0 不是可有可无的排版糖:宿主 .side-panel 是行向 flex,
    // 不写 flex-1 的话这块面板按内容宽度收成一条(实测卡在 424px 再也不动),
    // 占位符跟着不长,浮在上面的网页自然也不长——症状是"拖宽/全屏后网页不适应尺寸"。
    // min-w-0 是配套的:没有它,里面的 URL 栏能把面板顶得比容器还宽。
    // 照 GitGraphView 的根节点写法
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
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
        <Button variant="ghost" size="icon" onClick={togglePanelWide}
          title={panelWide ? "收回半屏" : "展开全屏"}>
          {panelWide ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </Button>
        <Button variant="ghost" size="icon" onClick={() => void shutdown()} disabled={!sessionId}
          title="结束浏览器（丢掉当前页面和历史，释放内存；下次打开是新的空白页）">
          <Power className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={closePanel}
          title="关闭面板（页面留着，下次打开还在这一页）">
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
