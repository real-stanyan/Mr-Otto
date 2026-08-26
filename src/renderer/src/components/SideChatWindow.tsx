// SideChatWindow — /btw 的自由漂浮小聊天窗（issue #502）。
//
// 三条与主时间线不同的性质：
// - 底下是一个**独立 session**（打了 sideChat 标记，侧栏/⌘K 不可见），
//   事件由 store 的 absorbEvent 按 sessionId 分流进 sideChatEvents；
// - 自由漂浮，不进右侧互斥面板槽：标题栏按住拖，夹取在内容区容器内
//   （几何在 lib/sideChatWindow.ts，纯函数可单测）；
// - 窄窗口（isNarrowWidth，同侧栏自动收起的阈值）直接不渲染——显示不下。
//
// 拖拽手感（Apple fluid interfaces 的三条）：pointer capture 保证指针出窗
// 也不断拖；抓哪儿从哪儿动（respect grab offset）；拖动中直接写
// style.transform（不 setState——不需要每帧重渲整棵子树），松手才落回 state。
//
// 审批卡：side session 的 agent 与主会话同款装备（bash/写文件都要过门），
// 而主视图只渲染 approvals[当前会话] 的卡——不在这里给个最小审批行，
// side chat 一碰需要审批的工具就会永远卡住（卡在一张看不见的卡上）。

import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "../store.js";
import { Button } from "@/components/ui/button.js";
import { Bubble, BubbleContent } from "@/components/ui/bubble.js";
import { X, MessageSquareText } from "lucide-react";
import { isNarrowWidth } from "../lib/sidebarNarrow.js";
import {
  clampToContainer,
  defaultPosition,
  sideChatRows,
  SIDE_CHAT_SIZE,
  type Point,
} from "../lib/sideChatWindow.js";

export function SideChatWindow() {
  const open = useChat((s) => s.sideChatOpen);
  const sessionId = useChat((s) => s.sideChatSessionId);
  const events = useChat((s) => s.sideChatEvents);
  const creating = useChat((s) => s.sideChatCreating);
  const sideError = useChat((s) => s.sideChatError);
  const streaming = useChat((s) => (sessionId ? s.streamingBySession[sessionId] : undefined));
  const status = useChat((s) => (sessionId ? s.statusBySession[sessionId] : undefined));
  const approval = useChat((s) => (sessionId ? s.approvals[sessionId] : undefined));
  const sendSideChat = useChat((s) => s.sendSideChat);
  const closeSideChat = useChat((s) => s.closeSideChat);

  const [narrow, setNarrow] = useState(() => isNarrowWidth(window.outerWidth));
  const [pos, setPos] = useState<Point | null>(null); // null = 还没落过位（首开时算右下角）
  const [draft, setDraft] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; grab: Point; last: Point } | null>(null);

  // 同 ui/sidebar.tsx 的窄窗判定：outerWidth（窗口点数），不是 innerWidth
  // （高分屏缩放下两者分叉，见 lib/sidebarNarrow.ts 顶部注释）。
  // 窗口变小时顺带把已落位的浮窗夹回容器里
  useEffect(() => {
    const update = () => {
      setNarrow(isNarrowWidth(window.outerWidth));
      setPos((p) => {
        const parent = boxRef.current?.parentElement;
        if (!p || !parent) return p;
        return clampToContainer(p, SIDE_CHAT_SIZE, {
          width: parent.clientWidth,
          height: parent.clientHeight,
        });
      });
    };
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // 首次打开：右下角落位。依赖 open——关了再开不重算（位置是用户的，
  // 只有从未落位时才给默认值）
  useEffect(() => {
    if (!open || pos !== null) return;
    const parent = boxRef.current?.parentElement;
    if (!parent) return;
    setPos(defaultPosition(SIDE_CHAT_SIZE, { width: parent.clientWidth, height: parent.clientHeight }));
  }, [open, pos]);

  const rows = useMemo(() => sideChatRows(events), [events]);

  // 新行/流式增量都贴底——小窗永远看最新
  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: "end" }); // jsdom 没有 scrollIntoView，可选调用
  }, [rows.length, streaming?.content, open]);

  if (!open || narrow) return null;

  const startDrag = (e: React.PointerEvent<HTMLElement>) => {
    if (drag.current || pos === null) return; // 多指保护：第二根手指不接管
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointerId: e.pointerId, grab: { x: e.clientX - pos.x, y: e.clientY - pos.y }, last: pos };
  };
  const moveDrag = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    const el = boxRef.current;
    const parent = el?.parentElement;
    if (!d || d.pointerId !== e.pointerId || !el || !parent) return;
    const next = clampToContainer(
      { x: e.clientX - d.grab.x, y: e.clientY - d.grab.y },
      SIDE_CHAT_SIZE,
      { width: parent.clientWidth, height: parent.clientHeight }
    );
    d.last = next;
    // 拖动中 1:1 跟手：直接写 transform，不走 setState（不重渲整棵子树）
    el.style.transform = `translate3d(${next.x}px, ${next.y}px, 0)`;
  };
  const endDrag = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    setPos(d.last); // 松手才落回 state——之后的重渲从这个位置开始
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || sessionId === null) return;
    setDraft("");
    void sendSideChat(text);
  };

  const busy = status === "running";

  return (
    <div
      ref={boxRef}
      className="absolute left-0 top-0 z-40 flex w-[340px] h-[440px] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      style={{
        transform: pos ? `translate3d(${pos.x}px, ${pos.y}px, 0)` : undefined,
        visibility: pos ? "visible" : "hidden", // 落位前不闪一帧在左上角
      }}
      role="dialog"
      aria-label="Side chat"
    >
      {/* 标题栏 = 拖拽把手。touch-none：拖窗时不让浏览器抢手势 */}
      <header
        className="flex shrink-0 cursor-grab touch-none select-none items-center gap-2 border-b border-border/60 bg-card/70 px-3 py-2 backdrop-blur-xl active:cursor-grabbing"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <MessageSquareText className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-[650] tracking-[-0.01em]">
          Side chat
        </span>
        {busy && (
          <span className="text-[10px] text-muted-foreground" aria-label="正在干活">
            干活中…
          </span>
        )}
        <Button variant="ghost" size="icon-sm" onClick={closeSideChat} title="关闭（/btw 再开）">
          <X />
        </Button>
      </header>

      <section className="scrollbar-thin flex flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden px-3 py-2">
        {rows.length === 0 && !creating && (
          <p className="text-xs text-muted-foreground">
            顺手聊两句——这是个独立小会话，不打断主时间线。
          </p>
        )}
        {creating && <p className="text-xs text-muted-foreground">正在建 side 会话…</p>}
        {rows.map((row) =>
          row.kind === "error" ? (
            <p key={row.key} className="text-xs text-err">
              {row.text}
            </p>
          ) : (
            <Bubble
              key={row.key}
              variant={row.kind === "user" ? "tinted" : "muted"}
              className={row.kind === "user" ? "self-end max-w-[85%]" : "self-start max-w-[85%]"}
            >
              <BubbleContent className="whitespace-pre-wrap text-[13px]">{row.text}</BubbleContent>
            </Bubble>
          )
        )}
        {/* 流式预览：终态 assistant_message 落地时 absorbEvent 会清这份缓冲（事实覆盖预览） */}
        {streaming && streaming.content !== "" && (
          <Bubble variant="muted" className="self-start max-w-[85%] opacity-80">
            <BubbleContent className="whitespace-pre-wrap text-[13px]">{streaming.content}</BubbleContent>
          </Bubble>
        )}
        <div ref={bottomRef} />
      </section>

      {/* 最小审批行：side 的卡不在主视图渲染，没这排按钮工具就永远挂着。
          只给 批/拒 两档——长期授权那类重决定请回主会话做 */}
      {approval && sessionId !== null && (
        <div className="flex items-center gap-2 border-t border-border/60 px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-xs" title={approval.call.name}>
            请求使用 <span className="font-mono">{approval.call.name}</span>
          </span>
          <Button
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => void window.otter.decideApproval(sessionId, approval.call.id, { decision: "approved" })}
          >
            允许
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            onClick={() =>
              void window.otter.decideApproval(sessionId, approval.call.id, {
                decision: "denied",
                reason: "用户在 side chat 里拒绝了",
              })
            }
          >
            拒绝
          </Button>
        </div>
      )}

      {sideError && <p className="px-3 pb-1 text-xs text-err">{sideError}</p>}

      <footer className="flex items-end gap-2 border-t border-border/60 bg-card/70 px-3 py-2 backdrop-blur-xl">
        <textarea
          rows={1}
          className="min-h-[30px] max-h-[90px] flex-1 min-w-0 resize-none rounded-xl border border-border bg-transparent px-2.5 py-[5px] text-[13px] leading-relaxed transition-colors duration-150 placeholder:text-muted-foreground/70 focus:border-ring focus:outline-none"
          placeholder={creating ? "正在建会话…" : "说点什么（Enter 发送）"}
          disabled={creating || sessionId === null}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter 发送、Shift+Enter 换行;输入法组词途中的 Enter 是选词不是发送
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Button size="sm" className="rounded-full" disabled={!draft.trim() || sessionId === null} onClick={submit}>
          发
        </Button>
      </footer>
    </div>
  );
}
