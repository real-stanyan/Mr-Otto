// SideChatWindow — /btw 打开的旁聊浮窗（issue #502，可缩放 + markdown 渲染见 #516）。
// 自由漂浮、可全窗口拖动的小会话：不进右侧互斥面板槽，挂在 App 最外层
// 自己管 fixed 定位（位置/尺寸都在 store.sideChat，拖拽和缩放只改它）。
// 宽度 < 阈值时整个不渲染（显示不下，判定在纯函数 sideChatHidden）。
//
// 会话本体是独立 session（sideChat.sessionId，spawnedBy kind:"side"），
// 事件走主进程正常广播、渲染层在 store 里分流镜像——这里只负责窗口
// 外壳（拖拽/缩放/关）+ 把 sideChat.events 里 user/assistant 两类画出来。
// 助手正文用与主聊天同一份 streamdown 配置（lib/markdownConfig.ts）渲染
// markdown——不是简化模板，两条路的渲染规则同源。

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Streamdown } from "streamdown";
import { useChat } from "../store.js";
import { cn } from "../lib/utils.js";
import { sideChatHidden, clampPos, clampSize } from "../lib/sideChatWindow.js";
import {
  MD_PLUGINS,
  MD_REHYPE_PLUGINS,
  MD_ANIMATED,
  useMdComponents,
} from "../lib/markdownConfig.js";

export function SideChatWindow() {
  const side = useChat((s) => s.sideChat);
  const sendSide = useChat((s) => s.sendSide);
  const closeSideChat = useChat((s) => s.closeSideChat);
  const setSidePos = useChat((s) => s.setSidePos);
  const setSideSize = useChat((s) => s.setSideSize);
  // 最后一条 assistant 是否还在流（statusBySession 是 turn 状态投影：
  // onTurnStatus 推送按 sessionId 记账，旁聊的事件分流不进主视图但状态照记）
  const sideRunning = useChat((s) =>
    s.sideChat ? s.statusBySession[s.sideChat.sessionId] === "running" : false
  );
  // side 会话的审批卡（issue #512）：全权装配的旁聊会过审批门，而主视图只
  // 渲染 approvals[当前会话]——不在这里给出口，side 一碰需审批的工具就永远挂起
  const approval = useChat((s) =>
    s.sideChat ? s.approvals[s.sideChat.sessionId] : undefined
  );
  const mdComponents = useMdComponents();

  // 宽度阈值：resize 时重判；从宽缩到窄，浮窗连同内容一起消失
  // （会话本体还活着，再敲 /btw 抬回来）。
  const [hidden, setHidden] = useState(() => sideChatHidden(window.outerWidth));
  useEffect(() => {
    const onResize = () => setHidden(sideChatHidden(window.outerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 拖拽（标题栏）：指针按下时记「指针-窗口左上角」偏移，move 时指针减偏移 = 新位置。
  // 缩放（右下角 handle）：记「指针-窗口右下角」偏移，move 时反推新尺寸。
  // 两条路的偏移都放 ref——move 回调注册一次，不能靠闭包拿 state。
  // sizeRef 镜像最新 size：move 回调要靠它算钳制（闭包里的 side.size 是注册时的旧值）。
  const dragOffset = useRef<{ dx: number; dy: number } | null>(null);
  const resizeOffset = useRef<{ dx: number; dy: number } | null>(null);
  const sizeRef = useRef(side?.size ?? { w: 380, h: 480 });
  // side.size 在 #516 之前建的会话镜像里可能缺席（测试 mock / 旧 renderer 状态），
  // 读的时候一律过这个兜底——size 是渲染层本地状态，不进日志，没有「旧日志」要兼容
  sizeRef.current = side?.size ?? sizeRef.current;

  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      const drag = dragOffset.current;
      if (drag) {
        setSidePos(
          clampPos(
            { x: ev.clientX - drag.dx, y: ev.clientY - drag.dy },
            window.innerWidth,
            window.innerHeight,
            sizeRef.current
          )
        );
        return;
      }
      const rs = resizeOffset.current;
      if (rs) {
        setSideSize(
          clampSize(
            { w: ev.clientX - rs.dx, h: ev.clientY - rs.dy },
            window.innerWidth,
            window.innerHeight
          )
        );
      }
    };
    const onUp = () => {
      dragOffset.current = null;
      resizeOffset.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [setSidePos, setSideSize]);

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

  // 最后一条 assistant 的 index：流式动画/caret 只给它（已说完的历史不需要，
  // 同主聊天「running 才开逐字出场」的理由）
  const lastAssistantIdx = side.events.reduce(
    (acc, e, i) => (e.type === "assistant_message" ? i : acc),
    -1
  );

  return (
    <div
      className="fixed z-50 flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-background/95 shadow-2xl backdrop-blur"
      style={{
        left: side.pos.x,
        top: side.pos.y,
        width: side.size?.w ?? 380,
        height: side.size?.h ?? 480,
      }}
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

      {/* 消息流：只画 user/assistant 两类，工具事件不进浮窗（镜像里本就没收）。
          助手正文用主聊天同一份 streamdown 配置渲染 markdown（issue #516） */}
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
            const streaming = sideRunning && i === lastAssistantIdx;
            return (
              <div key={i} className="flex justify-start">
                <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-muted px-3 py-1.5 text-[13px]">
                  <Streamdown
                    className="aui-md"
                    components={mdComponents}
                    plugins={MD_PLUGINS as any}
                    rehypePlugins={MD_REHYPE_PLUGINS}
                    animated={streaming ? MD_ANIMATED : false}
                    isAnimating={streaming}
                    caret="block"
                    mode={streaming ? "streaming" : "static"}
                  >
                    {e.content}
                  </Streamdown>
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

      {/* 最小审批行（issue #512）：只给 批/拒 两档——长期授权（session/always）
          这类重决定不进小窗，要授权请回主会话做。返程与主视图同一条通道 */}
      {approval && (
        <div className="flex items-center gap-2 border-t border-border/60 px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-xs" title={approval.toolDescription}>
            请求使用 <span className="font-mono">{approval.call.name}</span>
          </span>
          <button
            type="button"
            className="rounded-full bg-primary px-2.5 py-1 text-xs text-primary-foreground hover:opacity:90"
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

      {/* 缩放把手（右下角）：按住斜拉改尺寸，钳制在 clampSize 里（最小保输入框、
          最大不出视口——和拖拽「无复位入口」同一条保险） */}
      <div
        className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize touch-none"
        title="拖动缩放浮窗"
        onPointerDown={(e) => {
          // 偏移 = 指针到窗口右下角的距离，move 时指针位置减它就是新尺寸
          resizeOffset.current = {
            dx: e.clientX - (side.pos.x + (side.size?.w ?? 380)),
            dy: e.clientY - (side.pos.y + (side.size?.h ?? 480)),
          };
          e.stopPropagation(); // 别误触发标题栏拖拽（钉死）
        }}
      >
        <svg viewBox="0 0 16 16" className="h-full w-full text-muted-foreground/50">
          <path
            d="M14 16 L16 14 M10 16 L16 10 M6 16 L16 6"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </svg>
      </div>
    </div>
  );
}
