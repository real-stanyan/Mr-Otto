// 灵动岛 UI:四态 —— 胶囊(idle) / 活动 / 审批 / 输入。
// 状态三态来自 reduceIsland(日志投影);输入态是本组件局部状态。
// 窗体尺寸跟 DOM 走:ResizeObserver 量根节点,islandResize 上报给主进程 setBounds。
import { useEffect, useReducer, useRef, useState } from "react";
import { Check, Loader2, Send, Terminal, X } from "lucide-react";
import { toolSummary } from "@/lib/toolSummary.js";
import { initialIsland, reduceIsland, type IslandInput } from "./reduceIsland.js";

function useIsland() {
  const [s, dispatch] = useReducer(reduceIsland, initialIsland);
  const [model, setModel] = useState<string | null>(null);
  useEffect(() => {
    const offs = [
      window.otter.onActiveSessionChanged((b) => {
        setModel(b.model);
        dispatch({ kind: "activeSession", sessionId: b.activeSessionId });
      }),
      window.otter.onEvent((event) => dispatch({ kind: "event", event })),
      window.otter.onTurnStatus((update) => dispatch({ kind: "turnStatus", update, now: Date.now() })),
      window.otter.onApprovalRequest((req) => dispatch({ kind: "approvalRequest", req })),
    ];
    void window.otter.islandBoot().then((b) => {
      setModel(b.model);
      dispatch({ kind: "activeSession", sessionId: b.activeSessionId });
    });
    return () => offs.forEach((off) => off());
  }, []);
  return { s, model, dispatch: dispatch as (i: IslandInput) => void };
}

/** 根节点尺寸 → 主进程 setBounds。输入态放开焦点 */
function useReportSize(ref: React.RefObject<HTMLDivElement | null>, focusable: boolean) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      void window.otter.islandResize({ w: Math.ceil(r.width), h: Math.ceil(r.height), focusable });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, focusable]);
}

function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="tabular-nums text-white/60">{Math.floor((Date.now() - since) / 1000)}s</span>;
}

export function Island() {
  const { s, model } = useIsland();
  const [composing, setComposing] = useState(false);
  const [text, setText] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  useReportSize(rootRef, composing);

  const submit = async () => {
    if (!s.sessionId || !text.trim()) return;
    const body = text.trim();
    setText("");
    setComposing(false);
    try {
      await window.otter.sendMessage(s.sessionId, body);
    } catch (e) {
      console.error("岛上发消息失败", e);
    }
  };
  const decide = (decision: "approved" | "denied", grant?: "session") => {
    if (!s.sessionId || !s.pendingApproval) return;
    void window.otter.decideApproval(s.sessionId, s.pendingApproval.call.id, { decision, ...(grant ? { grant } : {}) });
  };

  const shell = "inline-flex items-center gap-2 rounded-full bg-black text-white text-[12px] px-3 py-1.5 shadow-lg select-none";
  // 每个按钮统一的按压反馈:按下缩到 97%,松开弹回,150ms;偏好减少动效时不缩
  const btn = "active:scale-[0.97] transition-transform duration-150 motion-reduce:transition-none";

  return (
    <div ref={rootRef} className="inline-block p-1">
      {composing ? (
        <form
          key="input"
          className={`${shell} island-state motion-reduce:transition-none`}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setComposing(false);
                setText("");
              }
            }}
            disabled={!s.sessionId}
            placeholder={s.sessionId ? "对 Otto 说…" : "主窗里先开会话"}
            className="w-64 bg-transparent outline-none placeholder:text-white/40"
          />
          <button type="submit" disabled={!s.sessionId} className={`opacity-70 hover:opacity-100 ${btn}`}>
            <Send size={14} />
          </button>
        </form>
      ) : s.phase === "approval" && s.pendingApproval ? (
        (() => {
          const summary = toolSummary(s.pendingApproval.call);
          return (
            <div key="approval" className={`${shell} island-state motion-reduce:transition-none`}>
              <span className="text-amber-300">审批</span>
              <span className="max-w-56 truncate">
                {summary.verb} {summary.target}
              </span>
              <button onClick={() => decide("approved")} title="允许" className={`text-green-400 ${btn}`}>
                <Check size={14} />
              </button>
              <button onClick={() => decide("approved", "session")} title="本会话允许" className={`text-green-400/70 text-[10px] ${btn}`}>
                会话
              </button>
              <button onClick={() => decide("denied")} title="拒绝" className={`text-red-400 ${btn}`}>
                <X size={14} />
              </button>
            </div>
          );
        })()
      ) : s.phase === "active" ? (
        (() => {
          const activeSummary = s.currentTool ? toolSummary(s.currentTool) : null;
          return (
            <button
              key="active"
              className={`${shell} island-state motion-reduce:transition-none ${btn}`}
              onClick={() => setComposing(true)}
            >
              {s.currentTool ? <Terminal size={14} className="opacity-80" /> : <Loader2 size={14} className="animate-spin" />}
              <span className="max-w-56 truncate">
                {activeSummary ? `${activeSummary.verb} ${activeSummary.target}` : "思考中…"}
              </span>
              {s.turnStartedAt && <Elapsed since={s.turnStartedAt} />}
            </button>
          );
        })()
      ) : (
        <button
          key="capsule"
          className={`${shell} island-state motion-reduce:transition-none hover:scale-105 motion-reduce:hover:scale-100 ${btn}`}
          onClick={() => setComposing(true)}
        >
          <span className="size-2 rounded-full bg-white/70" />
          <span className="text-white/70">{model ?? "Otto"}</span>
        </button>
      )}
    </div>
  );
}
