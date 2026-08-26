// SideChatWindow — /btw 打开的旁聊浮窗（issue #502；可缩放 + markdown 见 #516；
// 8 向缩放 + 流式渲染见 #538）。
// 自由漂浮、可全窗口拖动的小会话：不进右侧互斥面板槽，挂在 App 最外层
// 自己管 fixed 定位（位置/尺寸都在 store.sideChat，拖拽和缩放只改它）。
// 宽度 < 阈值时整个不渲染（显示不下，判定在纯函数 sideChatHidden）。
//
// 会话本体是独立 session（sideChat.sessionId，spawnedBy kind:"side"）。
// 助手正文的流式：store.streamingBySession（onAssistantDelta 攒的增量缓冲）
// 在 assistant_message 落下前是「正在流的这条」，落下后自动清空、走完整事件——
// 两条源在渲染里接力，就是主聊天的流式观感（边收边渲染 + 逐字动画）。

import { useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { X } from "lucide-react";
import { useChat } from "../store.js";
import { Bubble, BubbleContent } from "./ui/bubble.js";
import {
  SIDE_W,
  SIDE_H,
  sideChatHidden,
  clampPos,
  applyResize,
  RESIZE_CURSORS,
  type ResizeHandle,
} from "../lib/sideChatWindow.js";
import {
  MD_PLUGINS,
  MD_REHYPE_PLUGINS,
  MD_ANIMATED,
  useMdComponents,
} from "../lib/markdownConfig.js";
import type { SessionEvent } from "../../../session/events.js";

/** 拖拽起点快照（一次拖拽/缩放过程里不变的基准） */
type DragBase = { px: number; py: number; x: number; y: number; w: number; h: number };

/** 8 个缩放 handle 的定位样式（角 12×12、边沿轴向铺满；统一 4px 内缩让可点区比视觉宽） */
const HANDLE_STYLES: Record<ResizeHandle, React.CSSProperties> = {
  nw: { top: -2, left: -2, width: 14, height: 14 },
  n: { top: -2, left: 14, right: 14, height: 6 },
  ne: { top: -2, right: -2, width: 14, height: 14 },
  e: { top: 14, bottom: 14, right: -2, width: 6 },
  se: { bottom: -2, right: -2, width: 14, height: 14 },
  s: { bottom: -2, left: 14, right: 14, height: 6 },
  sw: { bottom: -2, left: -2, width: 14, height: 14 },
  w: { top: 14, bottom: 14, left: -2, width: 6 },
};

export function SideChatWindow() {
  const side = useChat((s) => s.sideChat);
  const closeSideChat = useChat((s) => s.closeSideChat);
  const sendSide = useChat((s) => s.sendSide);
  const stopSide = useChat((s) => s.stopSide);
  const setSidePos = useChat((s) => s.setSidePos);
  const setSideSize = useChat((s) => s.setSideSize);
  const sideRunning = useChat((s) =>
    s.sideChat ? s.statusBySession[s.sideChat.sessionId] === "running" : false
  );
  // 流式缓冲：旁聊 turn 跑着时模型正往外吐的正文（assistant_message 落下前）。
  // 读 streamingBySession 而不是自己拼——store 已按 sessionId 分好桶、落终态时自清，
  // 组件再攒一份就是两份「正在流的这条」互相 drift（issue #538）
  const streaming = useChat((s) =>
    s.sideChat ? s.streamingBySession[s.sideChat.sessionId]?.content ?? "" : ""
  );
  // side 会话的审批卡（issue #512）：全权装配的旁聊会过审批门，而主视图只
  // 渲染 approvals[当前会话]——不在这里给出口，side 一碰需审批的工具就永远挂起
  const approval = useChat((s) =>
    s.sideChat ? s.approvals[s.sideChat.sessionId] : undefined
  );

  const [draft, setDraft] = useState("");
  const [hidden, setHidden] = useState(() => sideChatHidden(window.outerWidth));
  const dragRef = useRef<DragBase | null>(null);
  const resizeRef = useRef<(DragBase & { handle: ResizeHandle }) | null>(null);
  const sizeRef = useRef(side?.size ?? { w: SIDE_W, h: SIDE_H });
  const scrollRef = useRef<HTMLDivElement>(null);
  // side.size 在 #516 之前建的会话镜像/测试 mock 里可能缺席，读的时候一律兜底
  const size = side?.size ?? { w: SIDE_W, h: SIDE_H };
  const mdComponents = useMdComponents();

  // 窗口 resize → 重判显隐 + 把浮窗钳回屏内（窗口缩小可能把它顶出去）
  useEffect(() => {
    const onResize = () => {
      setHidden(sideChatHidden(window.outerWidth));
      const s = useChat.getState().sideChat;
      if (s) useChat.getState().setSidePos(clampPos(s.pos, window.innerWidth, window.innerHeight, s.size));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 消息/流式内容到底部（新事件落下、流式增量进来都滚）
  const msgCount = side?.events.length ?? 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgCount, streaming]);

  if (hidden || !side || !side.open) return null;

  // ── 标题栏拖拽（pointer capture：拖出窗体也收得到 move/up）──
  const onDragPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return; // 按钮不吃拖拽
    dragRef.current = { px: e.clientX, py: e.clientY, x: side.pos.x, y: side.pos.y, w: size.w, h: size.h };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDragPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setSidePos(clampPos(
      { x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py },
      window.innerWidth, window.innerHeight, sizeRef.current
    ));
  };
  const onDragPointerUp = () => { dragRef.current = null; };

  // ── 8 向缩放（issue #538）：handle 上按下 → move 时按方向走 applyResize ──
  const onResizePointerDown = (handle: ResizeHandle) => (e: React.PointerEvent) => {
    e.stopPropagation(); // 角/边 handle 不触发标题栏拖拽
    resizeRef.current = { px: e.clientX, py: e.clientY, x: side.pos.x, y: side.pos.y, w: size.w, h: size.h, handle };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onResizePointerMove = (e: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r) return;
    const next = applyResize(
      { x: r.x, y: r.y }, { w: r.w, h: r.h },
      r.handle, e.clientX - r.px, e.clientY - r.py,
      window.innerWidth, window.innerHeight
    );
    sizeRef.current = next.size;
    setSideSize(next.size);
    setSidePos(next.pos); // 拉左/上边时位置跟着锚定（applyResize 里算好的）
  };
  const onResizePointerUp = () => { resizeRef.current = null; };

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void sendSide(text);
  };

  const messages = side.events.filter(
    (e): e is Extract<SessionEvent, { type: "user_message" | "assistant_message" }> =>
      e.type === "user_message" || e.type === "assistant_message"
  );

  return (
    <div
      className="fixed z-50 flex flex-col overflow-hidden rounded-xl border bg-card shadow-2xl"
      style={{ left: side.pos.x, top: side.pos.y, width: size.w, height: size.h }}
      role="dialog"
      aria-label="旁聊"
    >
      {/* 标题栏 = 拖拽把手 */}
      <div
        className="flex h-9 shrink-0 cursor-move select-none items-center gap-1 border-b bg-muted/40 px-3"
        onPointerDown={onDragPointerDown}
        onPointerMove={onDragPointerMove}
        onPointerUp={onDragPointerUp}
      >
        <span className="flex-1 truncate text-xs font-medium text-muted-foreground">旁聊</span>
        <button
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="关闭（会话保留）"
          onClick={closeSideChat}
        >
          <X className="size-3.5" />
        </button>
      </div>

      {/* 消息区：完整事件 + 正在流的这条（两条源接力，见头部注释） */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2">
        {messages.length === 0 && !streaming ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            跟主会话并排聊点别的——独立会话，不打断那边
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {messages.map((e, i) =>
              e.type === "user_message" ? (
                <Bubble key={i} data-variant="user" className="justify-end">
                  <BubbleContent data-variant="user" className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-primary px-3 py-1.5 text-sm text-primary-foreground">
                    {e.content}
                  </BubbleContent>
                </Bubble>
              ) : (
                <Bubble key={i} data-variant="assistant" className="justify-start">
                  <BubbleContent data-variant="assistant" className="max-w-[92%] text-sm">
                    {/* 主聊天同一份 streamdown 配置（lib/markdownConfig.ts）——
                        代码高亮/CJK 断行/mermaid/otto 块/逐字动画全对齐。
                        最后一条且还在流 = 开逐字动画；落下后静态（同主聊天） */}
                    <Streamdown
                      animated={i === messages.length - 1 && sideRunning ? MD_ANIMATED : false}
                      caret="block"
                      components={mdComponents}
                      isAnimating={i === messages.length - 1 && sideRunning}
                      mode={i === messages.length - 1 && sideRunning ? "streaming" : "static"}
                      parseIncompleteMarkdown={i === messages.length - 1 && sideRunning}
                      plugins={MD_PLUGINS}
                      rehypePlugins={MD_REHYPE_PLUGINS}
                    >
                      {e.content}
                    </Streamdown>
                  </BubbleContent>
                </Bubble>
              )
            )}
            {/* 正在流的这条：还在 streamingBySession 里、没落成事件（落了就并进上面列表） */}
            {streaming && (
              <Bubble data-variant="assistant" className="justify-start">
                <BubbleContent data-variant="assistant" className="max-w-[92%] text-sm">
                  <Streamdown
                    animated={MD_ANIMATED}
                    caret="block"
                    components={mdComponents}
                    isAnimating
                    mode="streaming"
                    parseIncompleteMarkdown
                    plugins={MD_PLUGINS}
                    rehypePlugins={MD_REHYPE_PLUGINS}
                  >
                    {streaming}
                  </Streamdown>
                </BubbleContent>
              </Bubble>
            )}
          </div>
        )}
      </div>

      {/* 输入区 */}
      {/* 最小审批行（issue #512）：只给 批/拒 两档——长期授权（session/always）
          这类重决定不进小窗，要授权请回主会话做。返程与主视图同一条通道 */}
      {approval && (
        <div className="flex shrink-0 items-center gap-2 border-t border-border/60 px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-xs" title={approval.toolDescription}>
            请求使用 <span className="font-mono">{approval.call.name}</span>
          </span>
          <button
            type="button"
            className="rounded-full bg-primary px-2.5 py-1 text-xs text-primary-foreground hover:opacity-90"
            onClick={() =>
              void window.otter.decideApproval(side.sessionId, approval.call.id, {
                decision: "approved",
              })
            }
          >
            允许
          </button>
          <button
            type="button"
            className="rounded-full border border-border/60 px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() =>
              void window.otter.decideApproval(side.sessionId, approval.call.id, {
                decision: "denied",
                reason: "用户在旁聊浮窗里拒绝了",
              })
            }
          >
            拒绝
          </button>
        </div>
      )}

      <div className="shrink-0 border-t p-2">
        <div className="flex items-end gap-1.5 rounded-lg border bg-background px-2.5 py-1.5">
          <textarea
            className="max-h-24 min-h-[20px] flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            rows={1}
            placeholder={sideRunning ? "等这条说完…" : "说点什么…"}
            value={draft}
            disabled={sideRunning}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {sideRunning ? (
            <button className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => void stopSide()}>
              停止
            </button>
          ) : null}
        </div>
      </div>

      {/* 8 向缩放 handle：四角 + 四边，absolute 叠在窗缘上（pointer events 只在这几条上） */}
      {(Object.keys(HANDLE_STYLES) as ResizeHandle[]).map((h) => (
        <div
          key={h}
          className="absolute touch-none"
          style={{ ...HANDLE_STYLES[h], cursor: RESIZE_CURSORS[h] }}
          onPointerDown={onResizePointerDown(h)}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
        />
      ))}
    </div>
  );
}
