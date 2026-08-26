// SideChatWindow — /btw 打开的旁聊浮窗（issue #502）。
// 自由漂浮、可全窗口拖动的小会话：不进右侧互斥面板槽，挂在 App 最外层
// 自己管 fixed 定位（位置在 store.sideChat.pos，拖拽只改它）。
// 宽度 < 阈值时整个不渲染（显示不下，判定在纯函数 sideChatHidden，
// 阈值 = max(侧栏自动收起线, 浮窗自身塞得下)，两条线取严的那条）。
//
// 会话本体是独立 session（sideChat.sessionId，spawnedBy kind:"side"），
// 事件走主进程正常广播、渲染层在 store 里分流镜像——这里只负责窗口
// 外壳（拖拽/定位/关）+ 把 sideChat.events 里 user/assistant 两类画出来。

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useChat } from "../store.js";
import { cn } from "../lib/utils.js";
import { SIDE_W, sideChatHidden, clampPos } from "../lib/sideChatWindow.js";

export function SideChatWindow() {
  const side = useChat((s) => s.sideChat);
  const sendSide = useChat((s) => s.sendSide);
  const closeSideChat = useChat((s) => s.closeSideChat);
  const setSidePos = useChat((s) => s.setSidePos);

  // 宽度阈值：resize 时重判；从宽缩到窄，浮窗连同内容一起消失
  // （会话本体还活着，再敲 /btw 抬回来）。
  const [hidden, setHidden] = useState(() => sideChatHidden(window.outerWidth));
  useEffect(() => {
    const onResize = () => setHidden(sideChatHidden(window.outerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 拖拽：指针按下时记「指针-窗口左上角」偏移，move 时指针减偏移 = 新位置，
  // 再过 clamp 防拖出可视区。偏移放 ref——move 回调注册一次，不能靠闭包拿 state。
  const dragOffset = useRef<{ dx: number; dy: number } | null>(null);
  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      const off = dragOffset.current;
      if (!off) return;
      setSidePos(
        clampPos(
          { x: ev.clientX - off.dx, y: ev.clientY - off.dy },
          window.innerWidth,
          window.innerHeight
        )
      );
    };
    const onUp = () => {
      dragOffset.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [setSidePos]);

  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const msgCount = side?.events.length ?? 0;
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgCount]);

  if (!side || !side.open || hidden) return null;

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void sendSide(text);
  };

  return (
    <div
      className="fixed z-50 flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-background/95 shadow-2xl backdrop-blur"
      style={{ left: side.pos.x, top: side.pos.y, width: SIDE_W, height: "60vh", maxHeight: "80vh" }}
    >
      {/* 标题栏 = 拖拽把手 */}
      <div
        className="flex cursor-move select-none items-center gap-1 border-b border-border/60 px-3 py-2"
        onPointerDown={(e) => {
          dragOffset.current = { dx: e.clientX - side.pos.x, dy: e.clientY - side.pos.y };
        }}
      >
        <span className="text-[13px] font-medium text-muted-foreground">Side chat</span>
        <span className="ml-auto" />
        <button
          type="button"
          title="关闭浮窗（会话本体保留，再敲 /btw 抬回来）"
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={closeSideChat}
        >
          <X size={14} />
        </button>
      </div>

      {/* 消息流：只画 user/assistant 两类，工具事件不进浮窗（镜像里本就没收） */}
      <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto px-3 py-2">
        {side.events.map((e, i) => {
          if (e.type === "user_message") {
            return (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-3 py-1.5 text-[13px] text-primary-foreground">
                  {e.content}
                </div>
              </div>
            );
          }
          if (e.type === "assistant_message") {
            return (
              <div key={i} className="flex justify-start">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-md bg-muted px-3 py-1.5 text-[13px]">
                  {e.content}
                </div>
              </div>
            );
          }
          return null;
        })}
        {side.events.length === 0 && (
          <p className="pt-4 text-center text-xs text-muted-foreground">
            旁聊：和主会话并排的第二张嘴，互相看不见。
          </p>
        )}
      </div>

      {/* 输入行 */}
      <div className="border-t border-border/60 p-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
          }}
          placeholder="Follow up..."
          className={cn(
            "w-full rounded-full border border-border/60 bg-muted/60 px-3 py-1.5 text-[13px]",
            "outline-none placeholder:text-muted-foreground focus:border-border"
          )}
        />
      </div>
    </div>
  );
}
