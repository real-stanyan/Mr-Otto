// 聊天主界面 — 功能优先（视觉设计等 harness 完工后再做）。
// 消息区就是事件日志的直接渲染：又一个投影，UI 不持有自己的对话状态。

import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { ThinkingOrb } from "thinking-orbs";
import { BookMarked, Ellipsis, GitBranch, History } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useChat } from "./store.js";
import type { SettingsSection } from "./store.js";
import ottoLogo from "./assets/otto.png";
import { diffLines } from "../../shared/diff.js";
import { contextUsed } from "../../shared/contextEstimate.js";
import { dispatchSlash, SLASH_COMMANDS } from "./commands.js";
import { Replay, Hl } from "./replay/Replay.js";
import { ProtocolView } from "./components/ProtocolView.js";
import { GitGraphView } from "./components/GitGraphView.js";
import { FriendsSection } from "./components/FriendsSection.js";
import { MODEL_CATALOG, findModel } from "../../shared/modelCatalog.js";
import { themeController, type ThemePref } from "./theme.js";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Textarea } from "@/components/ui/textarea.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar.js";
import type {
  SessionEvent,
  ToolCallRequest,
  ToolExecutionStartedEvent,
  ToolResultEvent,
} from "../../session/events.js";

/** 会话累计 token（prompt + completion）——又一个日志投影：重开 app 账不丢 */
function totalTokens(events: SessionEvent[]): number {
  let sum = 0;
  for (const e of events) {
    if ((e.type === "assistant_message" || e.type === "context_compacted") && e.usage) {
      sum += e.usage.promptTokens + e.usage.completionTokens;
    }
  }
  return sum;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

/* ─── Tailwind 迁移(ADR-0010)的共享 className 组合 ───
   多处复用的样式串抽成常量:一处改全局生效,JSX 里不抄长串。
   一次性样式直接内联在各自元素上 */
const ROW = "max-w-[76%] whitespace-pre-wrap break-words";
const CHIP = `${ROW} self-start text-[12.5px] font-mono border border-border rounded-lg px-[9px] py-[5px] text-muted-foreground`;
const AUDIT = `${ROW} self-center text-xs text-muted-foreground`;
const V = "font-mono tabular-nums text-foreground whitespace-nowrap";
const POP_ROW = "flex justify-between items-baseline gap-3 text-muted-foreground py-[2.5px]";
/* 思考/skill 注入行:档案气质——降调、小字、细左边线,折叠头是唯一交互点 */
const THINKING_DETAILS = "self-stretch max-w-full border-l-2 border-border py-[2px] pl-[10px] group";
const THINKING_SUMMARY =
  "cursor-pointer text-muted-foreground text-xs select-none list-none [&::-webkit-details-marker]:hidden before:content-['▸_'] group-open:before:content-['▾_']";
const THINKING_BODY = "mt-1 text-muted-foreground text-[12.5px] leading-[1.55] whitespace-pre-wrap";
const TITLE_SPAN = "text-[13px] max-w-full truncate";
const WHEN_SPAN = "text-[11px] text-muted-foreground font-mono max-w-full truncate";
/* 设置页骨架(账号/模型配置/Skill 库共用) */
const MAIN_COL = "flex-1 min-w-0 flex h-full flex-col";

/** 侧栏收起后的全局重开钮（壳层渲染,所有视图自动覆盖——welcome 曾漏配触发钮把人困死）:
    侧栏从左缘消失,重开的把手就出现在左缘同侧(空间一致性);展开态不渲染——
    关闭入口在侧栏头部,一个功能一个控件,不随视图漂移。悬浮半透明底 = 内容之上的功能层 */
function CollapsedSidebarNub() {
  const { state } = useSidebar();
  if (state !== "collapsed") return null;
  return (
    <div className="collapsed-nub absolute top-[9px] left-2 z-40 rounded-md bg-background/75 backdrop-blur-sm border border-border shadow-sm">
      <SidebarTrigger />
    </div>
  );
}
const HEADER = "flex items-baseline gap-3 px-5 py-3 border-b border-border";
const HEADER_GHOST = "shrink-0 text-xs text-muted-foreground hover:text-foreground";
const SETTINGS_BODY =
  "flex-1 overflow-y-auto px-5 py-6 flex flex-col gap-4 w-[min(640px,100%)] mx-auto scrollbar-thin";
const HINT = "text-muted-foreground text-[13px]";
const ERR_TXT = "text-err text-[13px]";
/* 其余文本框与主输入框同一套焦点语言(浏览器默认外环太糙) */
const FOCUS_INPUT =
  "bg-background border border-border rounded-lg text-foreground transition-[border-color,box-shadow] duration-150 focus:outline-none focus:border-ring focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--ring)_15%,transparent)]";
/* 状态条/新会话卡的下拉框(素色,悬停亮边)——shadcn SelectTrigger 的 className 叠加层 */
const BAR_SELECT =
  "h-auto w-fit gap-1 bg-transparent text-muted-foreground border-transparent rounded-md px-1 py-[2px] text-xs font-mono shadow-none hover:text-foreground hover:border-border disabled:opacity-40 [&_svg]:size-3";
/* bypass 模式常亮警示色——免审状态必须一眼可见 */
const BYPASS = "text-warn bg-warn/[0.12]";
/* 新会话卡控件行的下拉框(比状态条版大半号,圆角 8px)——shadcn SelectTrigger 的 className 叠加层 */
const NSC_SELECT =
  "h-auto w-fit gap-1 bg-transparent border-transparent rounded-lg text-muted-foreground text-xs px-[6px] py-[3px] shadow-none hover:text-foreground hover:border-border disabled:opacity-40 [&_svg]:size-3";
/* 发送/停止键:控件行里收小一号,和状态条同一量级 */
const SEND_BTN = "px-[14px] py-1 h-auto text-[13px] rounded-lg shrink-0";
/* 工作区浮窗列表项 */
const WS_ITEM =
  "flex items-center gap-2 w-full text-left bg-transparent border-none rounded-lg px-[10px] py-2 text-foreground text-[13px] cursor-pointer hover:bg-foreground/[0.06] [&>svg]:text-muted-foreground [&>svg]:shrink-0";
/* slash/$ 菜单(composer 上方弹出):origin-aware,从会话框顶边长出来 */
const SLASH_MENU =
  "absolute left-0 right-0 bottom-[calc(100%+8px)] flex flex-col gap-[2px] bg-card border border-border rounded-xl p-[6px] max-h-[300px] overflow-auto shadow-[0_12px_32px_rgba(0,0,0,0.45)] origin-bottom-left transition-[opacity,transform] duration-150 ease-strong starting:opacity-0 starting:translate-y-[3px] starting:scale-[0.98] scrollbar-thin motion-reduce:transition-opacity motion-reduce:starting:translate-y-0 motion-reduce:starting:scale-100";
const SLASH_ITEM =
  "flex items-baseline gap-[10px] w-full text-left bg-transparent border-none rounded-lg px-[10px] py-[7px] cursor-pointer transition-colors duration-100";
/* 工具详情面板的小节标题与代码块(.hl = 自研高亮器配色作用域,见 app.css) */
const TOOL_SEC = "text-[11px] text-muted-foreground uppercase tracking-[0.05em] mt-2 mb-1";
const TOOL_PRE =
  "hl m-0 px-[10px] py-2 rounded-lg bg-[var(--pre-bg)] font-mono text-xs leading-normal whitespace-pre-wrap break-all max-h-60 overflow-auto scrollbar-thin";
/* 审批卡里的 pre(参数 JSON / diff 兜底文案) */
const APPROVAL_PRE = "font-mono text-xs text-muted-foreground mt-[6px] whitespace-pre-wrap break-all";

// contextUsed 搬进 shared（校准版：账单锚点 + 未计费事件估算），这里只消费

/** orb 旁的状态文案：耗时 · token · 在干嘛（Claude Code 状态行同款，一行合体）。
    挂载即计时——本组件只在 turn 进行中存在，出生时刻就是 turn 起点 */
function TurnMeta({ label, events }: { label: string; events: SessionEvent[] }) {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const tokens = useMemo(() => totalTokens(events), [events]);
  return (
    <span className="tabular-nums">
      {fmtElapsed(now - start)} · {fmtTokens(tokens)} tokens · {label}
    </span>
  );
}

/** 上下文用量圆环（Claude Code 同款）：满圈 = 上下文窗打满。
    数字进悬停提示，环本身只传达"还剩多少"；爬坡换警示色 */
function CtxRing({ used, win }: { used: number; win: number }) {
  const pct = Math.min(1, used / win);
  const r = 5.5;
  const c = 2 * Math.PI * r;
  // 有占用就至少画出一小段弧，不然低用量时环看着像坏了
  const arc = pct === 0 ? 0 : Math.max(pct, 0.05) * c;
  const color = pct > 0.9 ? "var(--color-deny)" : pct > 0.75 ? "var(--color-warn)" : "var(--color-brand)";
  return (
    // 圆环弧长/颜色随账单更新平滑过渡(每 turn 一次,低频)
    <svg
      className="[&_circle]:[transition:stroke-dasharray_400ms_var(--ease-strong),stroke_400ms_ease]"
      width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"
    >
      <circle cx="7" cy="7" r={r} fill="none" stroke="color-mix(in srgb, var(--foreground) 16%, transparent)" strokeWidth="2.5" />
      <circle
        cx="7" cy="7" r={r} fill="none"
        stroke={color} strokeWidth="2.5" strokeLinecap="round"
        strokeDasharray={`${arc} ${c}`}
        transform="rotate(-90 7 7)"
      />
    </svg>
  );
}

/** 圆环点开的详情浮窗：全部数字都是日志投影，没有任何独立状态。
    锚在触发环上方（从来处出现），点外面/Esc 关闭 */
function CtxPopover({ events, ctxWindow, onClose }: {
  events: SessionEvent[];
  ctxWindow: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => {
      // 点在浮窗外（含触发环之外的一切）就收起
      if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  const used = contextUsed(events);
  const pct = Math.min(100, Math.round((used / ctxWindow) * 100));
  const lastUsage = [...events].reverse().find(
    (e): e is SessionEvent & { usage: { promptTokens: number; completionTokens: number } } =>
      (e.type === "assistant_message" || e.type === "context_compacted") && e.usage !== undefined
  )?.usage;
  const compacts = events.filter((e) => e.type === "context_compacted").length;
  const maxSteps = useChat((s) => s.maxSteps);
  const n = (x: number) => x.toLocaleString("en-US");

  return (
    <div
      className="absolute -right-1 bottom-[calc(100%+8px)] z-10 w-[258px] px-3 py-[10px] bg-card border border-border rounded-[10px] shadow-[0_8px_24px_rgba(0,0,0,0.45),0_2px_6px_rgba(0,0,0,0.3)] text-xs text-foreground cursor-default origin-bottom-right transition-[opacity,transform] duration-150 ease-strong starting:opacity-0 starting:scale-[0.97] starting:translate-y-[2px] motion-reduce:transition-opacity motion-reduce:starting:scale-100 motion-reduce:starting:translate-y-0"
      ref={ref} role="dialog" aria-label="上下文用量详情"
    >
      <div className="flex justify-between items-baseline font-semibold mb-2">
        上下文窗 <span className={V}>{fmtTokens(ctxWindow)}</span>
      </div>
      <div className={POP_ROW}>
        <span>占用估计</span>
        <span className={V}>{n(used)} · {pct}%</span>
      </div>
      <div className="h-1 rounded-sm overflow-hidden bg-foreground/10 mt-[5px] mb-[7px]" aria-hidden="true">
        <i
          className="block h-full rounded-sm bg-brand min-w-0 transition-[width] duration-[400ms] ease-strong"
          style={{ width: `${Math.max(pct, used > 0 ? 1 : 0)}%` }}
        />
      </div>
      {lastUsage && (
        <div className={POP_ROW}>
          <span>最近一次调用</span>
          <span className={V}>入 {n(lastUsage.promptTokens)} · 出 {n(lastUsage.completionTokens)}</span>
        </div>
      )}
      <div className={POP_ROW}>
        <span>会话累计消耗</span>
        <span className={V}>{n(totalTokens(events))} tokens</span>
      </div>
      <div className={POP_ROW}>
        <span>事件日志</span>
        <span className={V}>{events.length} 条{compacts > 0 ? ` · 压缩 ${compacts} 次` : ""}</span>
      </div>
      <div className={POP_ROW}>
        <span>单 turn 步数上限</span>
        <span className={V}>{maxSteps}（/steps 可调）</span>
      </div>
      <div className="mt-2 pt-2 border-t border-border text-muted-foreground text-[11px] leading-normal">
        占用 = 最近账单 + 之后未计费事件的字符估算；/compact 可折叠历史释放上下文
      </div>
    </div>
  );
}

/** 输入框下的状态条（Claude Code 同款布局）：
    左 = 审批模式；右 = 模型 · thinking · 上下文用量。
    模式/thinking 是运行时偏好（主进程 agent 持有）；模型是日志投影；用量是日志投影 */
function ComposerBar() {
  const model = useChat((s) => s.model);
  const events = useChat((s) => s.events);
  const approvalMode = useChat((s) => s.approvalMode);
  const thinking = useChat((s) => s.thinking);
  const status = useChat((s) => s.statusBySession[s.sessionId] ?? "idle");
  const switchModel = useChat((s) => s.switchModel);
  const setApprovalMode = useChat((s) => s.setApprovalMode);
  const setThinking = useChat((s) => s.setThinking);
  const [ctxOpen, setCtxOpen] = useState(false);

  const choice = findModel(model);
  const ctxWindow = choice?.contextWindow ?? 128_000;
  const used = contextUsed(events);
  const pct = Math.min(100, Math.round((used / ctxWindow) * 100));

  return (
    // 窄宽(半屏面板挤压)时右簇整组换行:model/thinking/用量环包成一个 wrap 单元,
    // ml-auto 让它在自己那行也贴右——不会散成一件一行的碎排
    <div className="flex-1 min-w-0 flex items-center gap-x-2 gap-y-1 flex-wrap text-xs text-muted-foreground pl-[2px]">
      <Select value={approvalMode} onValueChange={(v) => void setApprovalMode(v as "ask" | "auto")}>
        <SelectTrigger
          className={BAR_SELECT + (approvalMode === "auto" ? " " + BYPASS : "")}
          title="审批模式：危险操作是逐条问你，还是免问直批（决定都会落日志）"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ask">逐条审批</SelectItem>
          <SelectItem value="auto">完全访问</SelectItem>
        </SelectContent>
      </Select>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="w-auto h-auto px-2 py-[2px] text-base leading-none text-inherit hover:bg-foreground/[0.08]"
            disabled={status === "running"}
            onClick={() => void useChat.getState().pickFiles()}
          >
            ＋
          </Button>
        </TooltipTrigger>
        <TooltipContent>添加文件(图片/文本)</TooltipContent>
      </Tooltip>

      <div className="ml-auto flex items-center gap-2 min-w-0">
      <Select value={model} onValueChange={(v) => void switchModel(v)} disabled={status === "running"}>
        <SelectTrigger className={BAR_SELECT}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MODEL_CATALOG.map((m) => (
            <SelectItem key={m.model} value={m.model}>
              {m.label}
            </SelectItem>
          ))}
          {/* OTTER_MODEL 填了目录外的型号：补一项，不然 select 显示空白 */}
          {!findModel(model) && <SelectItem value={model}>{model}</SelectItem>}
        </SelectContent>
      </Select>

      <Select
        value={thinking ? "on" : "off"}
        onValueChange={(v) => void setThinking(v === "on")}
        disabled={status === "running" || !choice?.supportsThinking}
      >
        <SelectTrigger
          className={BAR_SELECT}
          title={choice?.supportsThinking ? "thinking：模型先推理再作答（更好也更贵）" : "当前型号不支持 thinking 开关"}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="on">Thinking 开</SelectItem>
          <SelectItem value="off">Thinking 关</SelectItem>
        </SelectContent>
      </Select>

      <span className="relative inline-flex items-center">
        <button
          type="button"
          className="inline-flex items-center p-[3px] rounded-md bg-transparent border-none hover:bg-foreground/[0.07]"
          title={`上下文占用 ${fmtTokens(used)}/${fmtTokens(ctxWindow)} · ${pct}%——点击看详情`}
          aria-label="上下文用量详情"
          onClick={() => setCtxOpen((o) => !o)}
        >
          <CtxRing used={used} win={ctxWindow} />
        </button>
        {ctxOpen && <CtxPopover events={events} ctxWindow={ctxWindow} onClose={() => setCtxOpen(false)} />}
      </span>
      </div>
    </div>
  );
}

/** agent 状态 → orb 动画。审批等待优先于 running：这时是 agent 在等人 */
function orbStateOf(status: "idle" | "running", hasApproval: boolean) {
  if (hasApproval) return "listening" as const;
  return status === "running" ? ("working" as const) : ("breathing" as const);
}

/** 工具调用摘要行的文案：动词 + 目标 + 统计（Claude Code 版式）。
    全部从 call.args 推导——UI 不知道工具"做了什么"，只知道日志里请求了什么 */
function toolSummary(call: ToolCallRequest): { verb: string; target: string; stat: string } {
  const a = (call.args ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
  switch (call.name) {
    case "write_file": {
      const content = str("content");
      return {
        verb: "写入",
        target: str("path").split("/").pop() ?? "",
        stat: content ? `+${content.split("\n").length} 行` : "",
      };
    }
    case "read_file":
      return { verb: "读取", target: str("path").split("/").pop() ?? "", stat: "" };
    case "bash":
      return { verb: "终端", target: str("cmd"), stat: "" };
    default:
      return { verb: call.name, target: "", stat: "" };
  }
}

/** 一次工具调用 = 一行：请求 + 结果 + 耗时合并展示（都是日志投影，按 toolCallId 配对）。
    点开看详情：完整参数、完整输出、执行耗时（tool_execution_started 配对推导，ADR-0004） */
function ToolRow({ call, all }: { call: ToolCallRequest; all: SessionEvent[] }) {
  const [open, setOpen] = useState(false);
  const result = all.find(
    (e): e is ToolResultEvent => e.type === "tool_result" && e.toolCallId === call.id
  );
  const started = all.find(
    (e): e is ToolExecutionStartedEvent =>
      e.type === "tool_execution_started" && e.toolCallId === call.id
  );
  // 执行中的直播尾巴（bash 的 stdout/stderr 碎片）。tool_result 落地后 store
  // 会清掉这个 key，这里自然消失——直播只活在"事实到来前"的窗口里
  const live = useChat((s) => s.toolOutputByCall[call.id]);
  const liveRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    // 终端语义：始终看最新输出，新碎片到就滚到底
    liveRef.current?.scrollTo(0, liveRef.current.scrollHeight);
  }, [live]);
  const { verb, target, stat } = toolSummary(call);
  const status = result?.status ?? "running";

  return (
    <div className={`${ROW} p-0`}>
      {/* 高频摘要行零动画;宽行按压不缩放(读感怪) */}
      <button
        className="flex items-center gap-2 text-left bg-transparent border-none rounded-lg py-[5px] px-2 -mx-2 w-[calc(100%+16px)] text-[13px] text-muted-foreground transition-colors duration-[120ms] hover:bg-foreground/5"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span
          className={
            "font-[550] shrink-0 " +
            (status === "error" || status === "denied" ? "text-deny" : "text-foreground")
          }
        >
          {verb}
        </span>
        {target && <span className="font-mono text-xs text-muted-foreground truncate">{target}</span>}
        {stat && <span className="text-ok tabular-nums shrink-0">{stat}</span>}
        {status === "running" && <span className="text-muted-foreground shrink-0">执行中…</span>}
        {status === "error" && <span className="text-deny shrink-0">出错</span>}
        {status === "denied" && <span className="text-deny shrink-0">已拒绝</span>}
        <span
          className={
            "ml-auto shrink-0 text-muted-foreground transition-transform duration-150 ease-strong motion-reduce:transition-none" +
            (open ? " rotate-90" : "")
          }
        >
          ›
        </span>
      </button>
      {!result && live && (
        // 执行中的输出直播:迷你终端尾巴。低亮度——它是过程噪音,不是结果
        <pre
          className="mt-[2px] mb-1 px-[10px] py-2 max-h-40 overflow-y-auto bg-muted border border-border rounded-lg font-mono text-xs leading-normal text-muted-foreground whitespace-pre-wrap break-all transition-opacity duration-150 ease-strong starting:opacity-0"
          ref={liveRef}
        >
          {live}
        </pre>
      )}
      {open && (
        // 详情展开是偶发动作:150ms ease-out 入场,从触发行长出来(origin 左上)
        <div className="mt-[2px] mb-1 px-3 py-[10px] bg-card border border-border rounded-[10px] origin-top-left transition-[opacity,transform] duration-150 ease-strong starting:opacity-0 starting:-translate-y-[2px] starting:scale-[0.99] motion-reduce:transition-opacity motion-reduce:starting:translate-y-0 motion-reduce:starting:scale-100">
          <div className="text-xs text-muted-foreground tabular-nums mb-[6px]">
            {call.name} · {status}
            {result && started ? ` · 执行耗时 ${result.ts - started.ts} ms` : ""}
          </div>
          <div className={TOOL_SEC}>参数</div>
          <pre className={TOOL_PRE}><Hl src={JSON.stringify(call.args, null, 2)} /></pre>
          {result && (
            <>
              <div className={TOOL_SEC}>输出</div>
              <pre className={TOOL_PRE}><Hl src={result.output || "（空）"} /></pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** 附件 data URL 内存缓存:同图(内容寻址同 id)只过一次 IPC */
const thumbCache = new Map<string, string>();

/** 时间线里的图片缩略图:懒取 + 缓存。取不到(附件库文件丢失)显示占位文案——
    日志重放依赖附件库是已接受的取舍(docs/adr/0009),缺图不该炸时间线 */
function AttachmentThumb({ id, name }: { id: string; name?: string | undefined }) {
  const [url, setUrl] = useState<string | null>(thumbCache.get(id) ?? null);
  const [lost, setLost] = useState(false);
  useEffect(() => {
    if (url) return;
    let alive = true;
    window.otter.attachmentDataUrl(id).then(
      (u) => {
        thumbCache.set(id, u);
        if (alive) setUrl(u);
      },
      () => {
        if (alive) setLost(true);
      }
    );
    return () => {
      alive = false;
    };
  }, [id, url]);
  if (lost) return <span className="opacity-60 text-xs text-muted-foreground">[图片缺失:{name ?? id.slice(0, 14)}]</span>;
  if (!url) return <span className="opacity-60 text-xs text-muted-foreground">…</span>;
  return <img className="max-w-[200px] max-h-40 rounded-md block" src={url} alt={name ?? "附件图片"} title={name} />;
}

function EventRow({ event, all }: { event: SessionEvent; all: SessionEvent[] }) {
  switch (event.type) {
    case "user_message":
      // 文本文件渲染成折叠卡片,不摊开全文——全文是给模型的(投影时拼进上下文),
      // 气泡里只亮"带了什么文件";点开可核对快照内容
      return (
        // 多行输入原样展示(pre-wrap):换行是用户打的事实,别折叠成一行
        <div className={`${ROW} self-end bg-primary text-primary-foreground rounded-[12px_12px_2px_12px] px-3 py-2`}>
          {event.content}
          {event.textFiles && event.textFiles.length > 0 && (
            <div className="flex flex-col gap-1 mt-[6px]">
              {event.textFiles.map((f, i) => (
                <details className="group bg-foreground/[0.06] rounded-md px-2 py-1 text-xs" key={i}>
                  <summary className="cursor-pointer text-muted-foreground list-none [&::-webkit-details-marker]:hidden group-open:mb-1">
                    📄 {f.name}
                    <span className="opacity-70 ml-1">（{Math.max(1, Math.round(f.bytes / 1024))}KB）</span>
                  </summary>
                  <div className="whitespace-pre-wrap break-words max-h-60 overflow-y-auto text-muted-foreground text-xs border-t border-foreground/[0.08] pt-1">
                    {f.content}
                  </div>
                </details>
              ))}
            </div>
          )}
          {event.attachments && event.attachments.length > 0 && (
            <div className="flex flex-wrap gap-[6px] mt-[6px]">
              {event.attachments.map((a) => (
                <AttachmentThumb key={a.id} id={a.id} name={a.name} />
              ))}
            </div>
          )}
        </div>
      );

    case "assistant_message":
      // 模型输出按 Markdown 渲染（react-markdown 默认转义 HTML，无注入面）；
      // 用户消息保持原文——用户打的不是 markdown，别替他排版
      return (
        <>
          {event.reasoning && (
            // 思考默认折叠：它是"怎么想的"的档案，不是回复本身。
            // 纯文本渲染（pre-wrap）——思考不是给人排版的 markdown
            <details className={THINKING_DETAILS}>
              <summary className={THINKING_SUMMARY}>思考过程</summary>
              <div className={THINKING_BODY}>{event.reasoning}</div>
            </details>
          )}
          {event.content && (
            // 模型回复无框:正文直接躺在背景上,占满行宽(气泡只留给用户消息)
            <div className="md self-stretch max-w-full py-[2px]">
              <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {event.content}
              </Markdown>
            </div>
          )}
          {event.toolCalls?.map((c) => (
            <ToolRow key={c.id} call={c} all={all} />
          ))}
        </>
      );

    case "tool_result":
      return null; // 已被 ToolRow 吸收（按 toolCallId 配对进请求行）

    case "approval_decision":
      return (
        <div className={AUDIT}>
          审批：{event.decision === "approved" ? "已批准" : "已拒绝"}
          {event.reason ? `（${event.reason}）` : ""}
        </div>
      );

    case "session_created":
      return <div className={AUDIT}>会话已创建</div>;

    case "session_archived":
      return <div className={AUDIT}>会话已归档</div>;

    case "session_renamed":
      return <div className={AUDIT}>会话改名 → {event.title}</div>;

    case "context_compacted":
      return (
        <div className={AUDIT}>
          ✻ 上下文已压缩——此前对话折叠为摘要（{event.model}
          {event.usage ? ` · 耗 ${event.usage.promptTokens + event.usage.completionTokens} tokens` : ""}）
        </div>
      );

    case "model_changed":
      return (
        <div className={AUDIT}>
          模型切换 → {event.provider}/{event.model}
        </div>
      );

    case "skill_invoked":
      // 默认折叠：全文是"给模型的说明书"的存档快照，不是对话内容
      return (
        <details className={THINKING_DETAILS}>
          {/* skill 注入行:thinking 折叠版式 + accent 点题 */}
          <summary className={`${THINKING_SUMMARY} text-brand`}>
            ✦ 启用 skill「{event.name}」——指令已注入上下文
          </summary>
          <div className={THINKING_BODY}>{event.content}</div>
        </details>
      );

    case "image_described":
      // vision-bridge 代读存档：默认折叠——它是给无视觉模型的"图片字幕"，
      // 不是对话内容；摊开能看到视觉模型到底读出了什么（解析质量一目了然）
      return (
        <details className={THINKING_DETAILS}>
          <summary className={THINKING_SUMMARY}>👁 图片解析（由 {event.model} 代读）——已注入上下文</summary>
          <div className={THINKING_BODY}>{event.content}</div>
        </details>
      );

    // lifecycle 事件（ADR-0004）：聊天区是对话投影，系统脉搏不在这渲染（回放里看）。
    // 唯一例外：turn 暴死——错误从此是日志事实，重开 app 还在
    case "tool_execution_started":
      return null;
    case "turn_ended":
      // aborted 也上时间线：用户的停止是事实，得看得见——但用中性灰，不是故障红
      return event.outcome === "error" ? (
        <div className={`${CHIP} border-err text-err`}>[turn 失败] {event.error}</div>
      ) : event.outcome === "aborted" ? (
        // 中断 = 用户意志,中性灰居中——不是故障,不用红
        <div className={`${CHIP} self-center`}>已中断</div>
      ) : null;
  }
}

/** write_file 审批的 diff 视图。diff 现算（投影）；连续未变行折叠成计数——
    审批人要看的是"改了什么"，不是全文。算不动（超大文件）退回 JSON 由调用方兜底 */
function DiffPreview({ oldText, newText }: { oldText: string | null; newText: string }) {
  const lines = useMemo(() => diffLines(oldText ?? "", newText), [oldText, newText]);
  if (!lines) return <pre className={APPROVAL_PRE}>{`[文件过大，不展示 diff]\n新内容 ${newText.length} 字符`}</pre>;

  // 折叠：同类 same 连续段只留首尾各 2 行做上下文，中间换成"… N 行未变 …"
  const CONTEXT = 2;
  const rows: { key: number; kind: string; text: string }[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.kind !== "same") {
      rows.push({ key: key++, kind: line.kind, text: line.text });
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j]!.kind === "same") j++;
    const run = j - i;
    if (run > CONTEXT * 2 + 1) {
      for (let k = i; k < i + CONTEXT; k++) rows.push({ key: key++, kind: "same", text: lines[k]!.text });
      rows.push({ key: key++, kind: "skip", text: `… ${run - CONTEXT * 2} 行未变 …` });
      for (let k = j - CONTEXT; k < j; k++) rows.push({ key: key++, kind: "same", text: lines[k]!.text });
    } else {
      for (let k = i; k < j; k++) rows.push({ key: key++, kind: "same", text: lines[k]!.text });
    }
    i = j;
  }

  return (
    <pre className={`${APPROVAL_PRE} max-h-[260px] overflow-y-auto bg-[var(--pre-bg)] border border-border rounded-lg px-[10px] py-2 whitespace-pre break-normal overflow-x-auto`}>
      {rows.map((r) => (
        <div
          key={r.key}
          className={
            "leading-normal " +
            (r.kind === "add"
              ? "text-ok bg-ok/[0.12]"
              : r.kind === "del"
                ? "text-deny bg-deny/[0.12] line-through [text-decoration-color:color-mix(in_srgb,var(--deny)_40%,transparent)]"
                : r.kind === "skip"
                  ? "text-muted-foreground text-center italic"
                  : "")
          }
        >
          {r.kind === "add" ? "+ " : r.kind === "del" ? "- " : "  "}
          {r.text}
        </div>
      ))}
    </pre>
  );
}

function ApprovalCard() {
  // 只渲染挂靠在当前会话上的卡——别的会话的审批留在它自己的视图里
  const approval = useChat((s) => s.approvals[s.sessionId] ?? null);
  const decide = useChat((s) => s.decide);
  const [reason, setReason] = useState("");

  if (!approval) return null;
  return (
    // 偶发事件才配入场动画:从下方 8px 淡入——它物理上贴着输入框,从来处进场
    <div className="mx-5 mb-2 border border-warn rounded-[10px] bg-warn/[0.07] transition-[opacity,transform] duration-[220ms] ease-strong starting:opacity-0 starting:translate-y-2 motion-reduce:transition-opacity motion-reduce:duration-200 motion-reduce:starting:translate-y-0">
      <div className="pt-2 px-[14px] text-xs text-warn font-semibold">危险操作待审批</div>
      <div className="px-[14px] py-[6px]">
        <code>{approval.call.name}</code> — {approval.toolDescription}
        {approval.preview ? (
          <>
            <div className="mt-2 font-mono text-xs text-foreground">
              {approval.preview.path}
              {approval.preview.oldText === null && <span className="text-ok ml-[6px]">（新文件）</span>}
            </div>
            <DiffPreview oldText={approval.preview.oldText} newText={approval.preview.newText} />
          </>
        ) : (
          <pre className={APPROVAL_PRE}>{JSON.stringify(approval.call.args, null, 2)}</pre>
        )}
      </div>
      <div className="flex gap-2 px-[14px] pb-3">
        <input
          className={`${FOCUS_INPUT} flex-1 px-[10px] py-[6px] text-[13px]`}
          placeholder="拒绝原因（可空，模型会看到）"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <Button
          variant="outline"
          className="bg-transparent dark:bg-transparent text-destructive border-destructive hover:bg-destructive/10 dark:hover:bg-destructive/10 hover:text-destructive"
          onClick={() => void decide("denied", reason.trim() || undefined)}
        >
          拒绝
        </Button>
        <Button
          className="bg-ok border-ok text-white hover:bg-ok/90 hover:border-ok/90"
          onClick={() => void decide("approved")}
        >
          批准
        </Button>
      </div>
    </div>
  );
}

/** key 配置行：输入框存完即清——渲染层不留 key 的任何副本 */
function KeyRow({ envName, label }: { envName: string; label: string }) {
  const configured = useChat((s) => s.keyStatus[envName] ?? false);
  const saveApiKey = useChat((s) => s.saveApiKey);
  const [draft, setDraft] = useState("");

  const save = async () => {
    if (!draft.trim()) return;
    await saveApiKey(envName, draft.trim());
    setDraft("");
  };

  return (
    <div className="border border-border rounded-[10px] p-[14px] flex flex-col gap-[10px]">
      <div className="flex items-baseline gap-[10px]">
        <span className="font-semibold capitalize">{label}</span>
        <span className={"text-xs " + (configured ? "text-ok" : "text-muted-foreground")}>
          {configured ? "● 已配置" : "○ 未配置"}
        </span>
        <code className="text-muted-foreground text-[11.5px] ml-auto">{envName}</code>
      </div>
      <div className="flex gap-2">
        <input
          className={`${FOCUS_INPUT} flex-1 px-3 py-2 text-[13px] font-mono`}
          type="password"
          placeholder={configured ? "输入新 key 覆盖" : "粘贴 API key"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
        />
        <Button variant="outline" disabled={!draft.trim()} onClick={() => void save()}>
          保存
        </Button>
        {configured && (
          <Button
            variant="outline"
            className="bg-transparent dark:bg-transparent text-destructive border-destructive hover:bg-destructive/10 dark:hover:bg-destructive/10 hover:text-destructive"
            onClick={() => void saveApiKey(envName, "")}
          >
            清除
          </Button>
        )}
      </div>
    </div>
  );
}

/** 账号区头像:avatarUrl 有就用图,没有就拿 name 首字符垫个圆片。
    sizeCls 让侧栏登录槽用小一号(20px),设置页默认 28px */
function AccountAvatar({ name, avatarUrl, sizeCls = "w-7 h-7 text-[13px]" }: {
  name: string;
  avatarUrl: string;
  sizeCls?: string;
}) {
  const cls = `${sizeCls} rounded-full shrink-0 object-cover bg-accent inline-flex items-center justify-center font-semibold text-foreground`;
  if (avatarUrl) {
    return <img className={cls} src={avatarUrl} alt={name} referrerPolicy="no-referrer" />;
  }
  return <span className={cls}>{name.charAt(0).toUpperCase() || "?"}</span>;
}

/** 账号页（设置栏目之一）：未登录 = 两个 OAuth 按钮,已登录 = 头像+身份+退出 */
function AccountPage() {
  const account = useChat((s) => s.account);
  const signIn = useChat((s) => s.signIn);
  const signOut = useChat((s) => s.signOut);
  const closeSettings = useChat((s) => s.closeSettings);
  const error = useChat((s) => s.error);

  return (
    <div className={MAIN_COL}>
      <header className={HEADER}>
        <span className="font-[650] inline-flex items-center gap-[6px]">账号</span>
        <Button variant="ghost" size="sm" className={HEADER_GHOST} onClick={closeSettings}>
          返回
        </Button>
      </header>
      <section className={SETTINGS_BODY}>
        {account.signedIn ? (
          <div className="flex items-center gap-[10px]">
            <AccountAvatar name={account.name} avatarUrl={account.avatarUrl} />
            <span className="font-[650]">{account.name}</span>
            <span className={HINT}>{account.email}</span>
            <Button variant="outline" onClick={() => void signOut()}>
              退出登录
            </Button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-[10px]">
              <Button onClick={() => void signIn("google")}>用 Google 登录</Button>
              <Button onClick={() => void signIn("github")}>用 GitHub 登录</Button>
            </div>
            <p className={HINT}>登录后可在多台设备同步配置（即将上线）</p>
          </>
        )}
        {error && <p className={ERR_TXT}>{error}</p>}
      </section>
    </div>
  );
}

/** 模型配置页（设置栏目之一）：各 provider 的 API key 管理。
    外观切换暂时挂靠在这里的顶部——项目还没有独立的"通用设置"栏目 */
function KeysPage() {
  const closeSettings = useChat((s) => s.closeSettings);
  const error = useChat((s) => s.error);
  // 目录里每个不同的 apiKeyEnv 一行（provider 可能共用同一个 key）
  const providers = [...new Map(MODEL_CATALOG.map((m) => [m.apiKeyEnv, m.provider])).entries()];
  const [themePref, setThemePref] = useState<ThemePref>(() => themeController().pref());

  return (
    <div className={MAIN_COL}>
      <header className={HEADER}>
        <span className="font-[650] inline-flex items-center gap-[6px]">模型配置</span>
        <Button variant="ghost" size="sm" className={HEADER_GHOST} onClick={closeSettings}>
          返回
        </Button>
      </header>
      <section className={SETTINGS_BODY}>
        <label className="flex items-center justify-between gap-3 text-[13px]">
          <span className="text-muted-foreground">外观</span>
          <Select
            value={themePref}
            onValueChange={(v) => {
              const p = v as ThemePref;
              themeController().setPref(p);
              setThemePref(p);
            }}
          >
            <SelectTrigger className="px-[10px] py-[6px] text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">跟随系统</SelectItem>
              <SelectItem value="light">浅色</SelectItem>
              <SelectItem value="dark">深色</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <p className={HINT}>
          key 存在本机 <code>keys.json</code>（仅当前用户可读），不进会话日志，不回传界面。
          此处配置的 key 优先于 .env。
        </p>
        {providers.map(([envName, provider]) => (
          <KeyRow key={envName} envName={envName} label={provider} />
        ))}
        {error && <p className={ERR_TXT}>{error}</p>}
      </section>
    </div>
  );
}

/** skill 库页（设置栏目之一）：本机已安装 skill 的只读清单（磁盘扫描的投影，零持久化）。
    安装/卸载 = 在根目录里增删 <名字>/SKILL.md 文件夹——这里只看不改 */
function SkillsPage() {
  const skills = useChat((s) => s.skills);
  const closeSettings = useChat((s) => s.closeSettings);

  return (
    <div className={MAIN_COL}>
      <header className={HEADER}>
        <span className="font-[650] inline-flex items-center gap-[6px]">Skill 库</span>
        <Button variant="ghost" size="sm" className={HEADER_GHOST} onClick={closeSettings}>
          返回
        </Button>
      </header>
      <section className={SETTINGS_BODY}>
        <p className={HINT}>
          聊天里输入 <code>$</code> 选一个 skill，它的指令全文会随那条消息注入模型
          （发送时刻快照，落 skill_invoked 事件）。安装 = 把 <code>skill 名/SKILL.md</code>
          {" "}放进 <code>~/.otter/skills</code> 或 <code>~/.claude/skills</code>。
        </p>
        {skills.map((s) => (
          <details key={s.name} className="border border-border rounded-[10px]">
            <summary className="flex items-baseline gap-[10px] px-[14px] py-3 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
              <span className="font-mono text-[13px] font-semibold text-brand shrink-0">{s.name}</span>
              <span className="text-muted-foreground text-[12.5px] flex-1 min-w-0 truncate">{s.description || "（无描述）"}</span>
              <code className="text-muted-foreground text-[11px] shrink-0" title={s.path}>
                {s.source.split("/").slice(-2).join("/")}
              </code>
            </summary>
            <pre className="m-0 px-[14px] py-3 border-t border-border text-xs leading-[1.55] text-muted-foreground whitespace-pre-wrap break-words max-h-80 overflow-y-auto">
              {s.content}
            </pre>
          </details>
        ))}
        {skills.length === 0 && <p className={HINT}>还没有安装任何 skill。</p>}
      </section>
    </div>
  );
}

/** 设置栏目导航项：id 对应 store 的 settingsSection，label 是侧栏显示文案 */
const SETTINGS_SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "account", label: "账号" },
  { id: "keys", label: "模型配置" },
  { id: "skills", label: "Skill 库" },
];

/** 左侧常驻侧栏（shadcn Sidebar,offcanvas）：会话列表（设置模式下换成栏目导航）
    + 底部设置/登录槽。handler 与原自制版一字不动,只换结构壳（spec 修订 2026-08-18） */
function AppSidebar() {
  const sessions = useChat((s) => s.sessions);
  const sessionId = useChat((s) => s.sessionId);
  const phase = useChat((s) => s.phase);
  const settingsSection = useChat((s) => s.settingsSection);
  const resume = useChat((s) => s.resume);
  const newSession = useChat((s) => s.newSession);
  const openSettings = useChat((s) => s.openSettings);
  const closeSettings = useChat((s) => s.closeSettings);
  const deleteSession = useChat((s) => s.deleteSession);
  const statusBySession = useChat((s) => s.statusBySession);
  const approvals = useChat((s) => s.approvals);
  const account = useChat((s) => s.account);
  const protocolOpen = useChat((s) => s.protocolOpen);
  const gitGraphOpen = useChat((s) => s.gitGraphOpen);

  // 没记 workspace 的史前会话（schema 长出 workspace 之前的日志）无法重建围栏，
  // 不可恢复——但事实不该被藏：藏 = 用户看不见也删不掉的库存垃圾。
  // 灰显示人 + 开放删除，点击不响应（能力问题诚实呈现，不是数据问题）
  const resumable = sessions.filter((s) => s.workspace !== null);
  const prehistoric = sessions.filter((s) => s.workspace === null);

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader>
        <div className="pt-1 px-2 pb-[6px] font-[650] flex items-center gap-2">
          {/* logo 原图白底方图:圆角裁成小图标块,暗色界面里当 app icon 看 */}
          <img className="w-[22px] h-[22px] rounded-md" src={ottoLogo} alt="" />
          Mr Otto
          {/* 收起钮进侧栏本体:内容区头部那颗只在收起后当"打开"用,
              展开状态下用户第一眼找的是侧栏里的开关 */}
          <SidebarTrigger className="ml-auto" />
        </div>
        {/* ＋ 只是导航去 composer 视图：文件夹/偏好在那里配齐才建会话。
            设置模式下侧栏不是会话导航，这颗按钮没有落点，隐掉 */}
        {settingsSection === null && (
          <Button
            variant="ghost"
            className="justify-start px-3 py-[7px] text-[13px] border border-border hover:bg-foreground/[0.06]"
            onClick={newSession}
          >
            ＋ 新会话
          </Button>
        )}
      </SidebarHeader>
      <SidebarContent>
        {settingsSection !== null ? (
          // 设置模式：会话列表让位给栏目导航（同一块地皮，互斥展示）
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                className="text-muted-foreground border-b border-border rounded-b-none hover:text-foreground"
                onClick={closeSettings}
              >
                ← 返回会话
              </SidebarMenuButton>
            </SidebarMenuItem>
            {SETTINGS_SECTIONS.map((sec) => (
              <SidebarMenuItem key={sec.id}>
                <SidebarMenuButton
                  isActive={settingsSection === sec.id}
                  onClick={() => void openSettings(sec.id)}
                >
                  <span className={TITLE_SPAN}>{sec.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        ) : (
          <SidebarMenu>
            {resumable.map((s) => (
              <SidebarMenuItem key={s.sessionId}>
                <SidebarMenuButton
                  className="h-auto flex-col items-start gap-px py-[7px]"
                  isActive={phase === "chat" && settingsSection === null && !protocolOpen && !gitGraphOpen && s.sessionId === sessionId}
                  onClick={() => void resume(s.sessionId)}
                >
                  {/* 标题 = 第一条 user_message 首行（日志投影）；还没发话的会话退回文件夹名 */}
                  <span className={TITLE_SPAN}>{s.title ?? s.workspace?.split("/").pop()}</span>
                  <span className={WHEN_SPAN}>
                    {s.workspace?.split("/").pop()} · {new Date(s.lastTs).toLocaleDateString()} · {s.events} 条
                    {/* 后台会话的动静：等审批 > 跑 turn，让你在别的会话也看得见 */}
                    {approvals[s.sessionId] ? (
                      <em className="not-italic font-semibold text-warn"> 等审批</em>
                    ) : statusBySession[s.sessionId] === "running" ? (
                      <em className="not-italic font-semibold text-brand"> 运行中</em>
                    ) : null}
                  </span>
                </SidebarMenuButton>
                <SidebarMenuAction
                  showOnHover
                  title="删除会话（整段日志从库里抹除，不可恢复）"
                  onClick={(e) => {
                    e.stopPropagation(); // 别触发外层的"切换到该会话"
                    if (confirm(`彻底删除会话 ${s.workspace?.split("/").pop()} · ${s.sessionId}？\n整段事件日志将从数据库抹除，不可恢复。`)) {
                      void deleteSession(s.sessionId);
                    }
                  }}
                >
                  ✕
                </SidebarMenuAction>
              </SidebarMenuItem>
            ))}
            {prehistoric.length > 0 && (
              <>
                <div className="text-[11px] text-muted-foreground tracking-[0.04em] pt-[10px] px-[10px] pb-[2px]">史前会话（不可恢复）</div>
                {prehistoric.map((s) => (
                  <SidebarMenuItem key={s.sessionId}>
                    {/* 灰显示人 + 开放删除,点击不响应(能力问题诚实呈现,不是数据问题) */}
                    <SidebarMenuButton
                      disabled
                      className="h-auto flex-col items-start gap-px py-[7px] cursor-default opacity-55 hover:bg-transparent disabled:opacity-55"
                      title="未记录工程文件夹，无法重建围栏，只能删除"
                    >
                      <span className="font-mono text-xs max-w-full truncate">{s.title ?? s.sessionId}</span>
                      <span className={WHEN_SPAN}>
                        {new Date(s.lastTs).toLocaleDateString()} · {s.events} 条
                      </span>
                    </SidebarMenuButton>
                    <SidebarMenuAction
                      showOnHover
                      title="删除会话（整段日志从库里抹除，不可恢复）"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`彻底删除史前会话 ${s.sessionId}？\n整段事件日志将从数据库抹除，不可恢复。`)) {
                          void deleteSession(s.sessionId);
                        }
                      }}
                    >
                      ✕
                    </SidebarMenuAction>
                  </SidebarMenuItem>
                ))}
              </>
            )}
          </SidebarMenu>
          <FriendsSection />
        )}
      </SidebarContent>
      {/* Skill 库/设置入口搬进了设置栏目导航（上方 SETTINGS_SECTIONS），
          这一行只留用户卡片 + 一颗进「模型配置」首屏的齿轮 */}
      <SidebarFooter>
        <div className="flex items-center gap-[6px]">
          {/* 槽位兑现：点击进设置账号区（登出入口在那，这里不重复做）。
              低调侧栏风:文字色 dim,悬停亮起 */}
          <button
            className="flex items-center gap-2 flex-1 min-w-0 px-[10px] py-1 text-muted-foreground text-xs bg-transparent text-left hover:text-foreground"
            onClick={() => void openSettings("account")}
            title={account.signedIn ? account.email : undefined}
          >
            {account.signedIn ? (
              <>
                <AccountAvatar name={account.name} avatarUrl={account.avatarUrl} sizeCls="w-5 h-5 text-[11px]" />
                <span className="flex-1 min-w-0 truncate">{account.name}</span>
              </>
            ) : (
              "未登录 · 点击登录"
            )}
          </button>
          {/* 齿轮:纯图标按钮,颜色/hover 沿用 ghost 风 */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="shrink-0 flex items-center justify-center px-2 py-[6px] text-[13px] text-muted-foreground bg-transparent hover:text-foreground"
                onClick={() => void openSettings("keys")}
              >
                <GearIcon />
              </button>
            </TooltipTrigger>
            <TooltipContent>设置</TooltipContent>
          </Tooltip>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

/** 齿轮：侧栏底部设置入口图标（内联 SVG，跟 FolderIcon 同一套写法：
    currentColor 描边，不吃色板变量，跟着按钮的文字色走）。
    path 取自 feather icons 的 settings（MIT）——齿要连在轮缘上才是齿轮，
    圆心射线画法读作太阳 */
function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.8 4h4.2l1.4 1.8h6.8v7.4H1.8z" />
    </svg>
  );
}

/** 工作区选择浮窗（ZCode 版式）：最近工作区 = 会话列表的投影（listSessions
    最近活跃在前，按 workspace 去重即最近使用序）——零新增持久化。
    系统原生选择框只在点"打开文件夹"时出场 */
function WorkspacePicker({ value, onChange }: {
  value: string | null;
  onChange: (dir: string) => void;
}) {
  const sessions = useChat((s) => s.sessions);
  const pickWorkspace = useChat((s) => s.pickWorkspace);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const recents = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    // 草稿里刚通过系统框选的新文件夹也在列（它可能还没有任何会话）
    if (value) {
      seen.add(value);
      out.push(value);
    }
    for (const s of sessions) {
      if (s.workspace && !seen.has(s.workspace)) {
        seen.add(s.workspace);
        out.push(s.workspace);
      }
    }
    return out;
  }, [sessions, value]);

  const q = query.trim().toLowerCase();
  const matches = q ? recents.filter((d) => d.toLowerCase().includes(q)) : recents;

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const choose = (dir: string) => {
    onChange(dir);
    setOpen(false);
    setQuery("");
  };

  const openDialog = async () => {
    setOpen(false); // 先收浮窗再弹系统框，两层 UI 不叠着
    const dir = await pickWorkspace();
    if (dir) onChange(dir); // 取消 = 保持原选择
  };

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        className="inline-flex items-center gap-[6px] shrink-0 bg-transparent text-foreground text-[13px] font-[550] px-2 py-1 rounded-lg hover:bg-foreground/[0.06]"
        onClick={() => setOpen((o) => !o)}
        title={value ?? "选择工作区"}
      >
        <FolderIcon />
        {value ? value.split("/").pop() : "选择工作区"}
        <span className="text-muted-foreground text-[11px]" aria-hidden="true">⌄</span>
      </button>
      {open && (
        // 浮窗锚在触发钮左上(从来处出现),只动 transform/opacity
        <div
          className="absolute top-[calc(100%+6px)] left-0 z-30 w-80 max-h-[340px] flex flex-col bg-card border border-border rounded-xl shadow-[0_12px_32px_rgba(0,0,0,0.45)] overflow-hidden origin-top-left transition-[opacity,transform] duration-150 ease-strong starting:opacity-0 starting:scale-[0.97]"
          role="listbox"
          aria-label="选择工作区"
        >
          <input
            className="bg-transparent border-0 border-b border-border px-3 py-[10px] text-foreground text-[13px] shrink-0 focus:outline-none placeholder:text-muted-foreground"
            autoFocus
            placeholder="搜索工作区"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="overflow-y-auto p-[6px] flex-1">
            {matches.map((dir) => (
              <button
                key={dir}
                className={WS_ITEM}
                role="option"
                aria-selected={dir === value}
                title={dir}
                onClick={() => choose(dir)}
              >
                <FolderIcon />
                <span className="shrink-0">{dir.split("/").pop()}</span>
                {/* rtl 省略头部留尾部:路径的尾巴才认得出 */}
                <span className="text-muted-foreground text-[11px] flex-1 min-w-0 truncate [direction:rtl]">{dir}</span>
                {dir === value && <span className="text-brand shrink-0" aria-hidden="true">✓</span>}
              </button>
            ))}
            {matches.length === 0 && <div className="text-muted-foreground text-xs px-3 py-[10px]">没有匹配的工作区</div>}
          </div>
          <div className="border-t border-border p-[6px] shrink-0">
            <button className={WS_ITEM} onClick={() => void openDialog()}>
              <span className="text-muted-foreground shrink-0" aria-hidden="true">＋</span> 打开文件夹…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 新会话 composer（ZCode 版式）：文件夹 + 首条消息 + 模式/模型/thinking 先配齐，
    ↑ 一按才落地。落地前全是渲染层草稿——反悔零痕迹，没建的会话不存在半个。
    偏好初值：审批 ask（安全默认）、thinking 开；模型跟上个会话走，没有就用目录第一款 */
function Welcome() {
  const startSession = useChat((s) => s.startSession);
  const send = useChat((s) => s.send);
  const error = useChat((s) => s.error);
  const lastModel = useChat((s) => s.model);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [model, setModel] = useState(() =>
    findModel(lastModel) ? lastModel : MODEL_CATALOG[0]!.model
  );
  const [mode, setMode] = useState<"ask" | "auto">("ask");
  const [thinking, setThinking] = useState(true);
  const [busy, setBusy] = useState(false);
  const choice = findModel(model);

  const launch = async () => {
    if (!workspace || busy) return;
    setBusy(true);
    try {
      // 显式传全部偏好：下拉框显示什么就落地什么（宁多一条 model_changed，不让 UI 说谎）
      await startSession({ workspace, model, approvalMode: mode, thinking });
      const t = text.trim();
      // 建会话成功才发首条消息（失败时 phase 停在 welcome，草稿原样保留）。
      // 这里不走 slash 分发：会话刚出生，/compact 之类没有意义
      if (useChat.getState().phase === "chat" && t) void send(t);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 min-w-0 h-full flex flex-col items-center justify-center gap-4 text-center">
      <img className="w-[72px] h-[72px] rounded-[18px]" src={ottoLogo} alt="Mr Otto" />
      <h1 className="text-2xl font-[650] tracking-[-0.01em]">Mr Otto</h1>
      {/* 新会话 composer(ZCode 版式):文件夹行 + 输入区 + 控件行一张卡 */}
      <div className="w-[min(640px,90%)] text-left bg-card border border-border rounded-2xl px-3 py-[10px] flex flex-col gap-[6px] transition-colors duration-[120ms] focus-within:border-ring">
        <div className="flex items-center gap-2 min-w-0">
          <WorkspacePicker value={workspace} onChange={setWorkspace} />
          {workspace && (
            <span className="text-muted-foreground text-[11px] min-w-0 truncate" title={workspace}>
              {workspace}
            </span>
          )}
        </div>
        <Textarea
          className="border-none shadow-none resize-none text-foreground text-sm leading-[1.55] min-h-[52px] max-h-[200px] px-1 py-[2px] focus-visible:ring-0"
          autoFocus
          rows={2}
          placeholder="向 Mr Otto 描述任务，回车发送"
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void launch();
            }
          }}
        />
        <div className="flex items-center gap-2">
          <Select value={mode} onValueChange={(v) => setMode(v as "ask" | "auto")}>
            <SelectTrigger
              className={NSC_SELECT + (mode === "auto" ? " " + BYPASS : "")}
              title="审批模式：危险操作是逐条问你，还是免问直批（决定都会落日志）"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ask">逐条审批</SelectItem>
              <SelectItem value="auto">完全访问</SelectItem>
            </SelectContent>
          </Select>
          <span className="flex-1" />
          <Select value={model} onValueChange={(v) => setModel(v)}>
            <SelectTrigger className={NSC_SELECT}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODEL_CATALOG.map((m) => (
                <SelectItem key={m.model} value={m.model}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={thinking ? "on" : "off"} onValueChange={(v) => setThinking(v === "on")} disabled={!choice?.supportsThinking}>
            <SelectTrigger
              className={NSC_SELECT}
              title={choice?.supportsThinking ? "thinking：模型先推理再作答（更好也更贵）" : "当前型号不支持 thinking 开关"}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="on">Thinking 开</SelectItem>
              <SelectItem value="off">Thinking 关</SelectItem>
            </SelectContent>
          </Select>
          <Button
            className="w-[30px] h-[30px] rounded-[10px] shrink-0 text-[15px] leading-none p-0"
            disabled={!workspace || busy}
            title={workspace ? "开始会话" : "先选工程文件夹"}
            aria-label="开始会话"
            onClick={() => void launch()}
          >
            ↑
          </Button>
        </div>
      </div>
      <p className="text-muted-foreground text-xs leading-[1.7]">agent 的文件读写限制在所选文件夹内，危险操作先经你审批。</p>
      {error && <p className={ERR_TXT}>{error}</p>}
    </div>
  );
}

export function App() {
  const { phase, sessionId, workspace, events, error, boot, send, stop } = useChat();
  const status = useChat((s) => s.statusBySession[s.sessionId] ?? "idle");
  const approval = useChat((s) => s.approvals[s.sessionId] ?? null);
  const replayCursor = useChat((s) => s.replayCursor);
  const setReplayCursor = useChat((s) => s.setReplayCursor);
  const settingsSection = useChat((s) => s.settingsSection);
  const protocolOpen = useChat((s) => s.protocolOpen);
  const openProtocol = useChat((s) => s.openProtocol);
  const gitGraphOpen = useChat((s) => s.gitGraphOpen);
  const openGitGraph = useChat((s) => s.openGitGraph);
  const panelWide = useChat((s) => s.panelWide);
  // 直播缓冲 = 临时预览，完整 assistant_message 事件到达即被替换（内容一致，无缝）。
  // 两个 selector 都返回原始字符串——selector 里造新对象会让 zustand 每次都判"变了"
  const streamingText = useChat((s) => s.streamingBySession[s.sessionId]?.content ?? "");
  const streamingThinking = useChat((s) => s.streamingBySession[s.sessionId]?.reasoning ?? "");
  const staged = useChat((s) => s.staged);
  const attachError = useChat((s) => s.attachError);
  const removeStaged = useChat((s) => s.removeStaged);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const replaying = replayCursor !== null;

  // slash 菜单：输入以 "/" 开头即弹出，按前缀过滤注册表（注册表当初就为此留了 desc）
  const slashMatches = input.startsWith("/")
    ? Object.entries(SLASH_COMMANDS).filter(([name]) => name.startsWith(input.trim()))
    : [];
  // $ 菜单（skill 选择）：以 "$" 开头且还没打空格——打了空格 = 名字已定，后面是任务正文。
  // 两个菜单天然互斥（首字符只能是一个），选中态共用同一个 slashSel
  const skills = useChat((s) => s.skills);
  const dollarQuery = input.startsWith("$") && !/\s/.test(input) ? input.slice(1).toLowerCase() : null;
  const skillMatches =
    dollarQuery !== null ? skills.filter((s) => s.name.toLowerCase().includes(dollarQuery)) : [];
  const [slashSel, setSlashSel] = useState(0);
  useEffect(() => setSlashSel(0), [input]); // 过滤结果变了，选中回到第一项
  const menuLen = Math.max(slashMatches.length, skillMatches.length);
  const sel = Math.min(slashSel, Math.max(menuLen - 1, 0));
  const runSlash = (name: string) => {
    setInput("");
    dispatchSlash(name);
  };
  // 选中 skill = 只补全名字，不发送：任务正文还等着用户打
  const pickSkill = (name: string) => setInput(`$${name} `);

  useEffect(() => {
    void boot();
  }, [boot]);

  // Esc = 停止（Claude Code 同款肌肉记忆）。挂 window：running 时输入框
  // disabled 收不到键盘，事件得在更高处接
  useEffect(() => {
    if (status !== "running") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status, stop]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView(); // 高频动作：瞬时滚动，不加动画
  }, [events.length, status, approval, streamingText.length, streamingThinking.length]);

  const submit = () => {
    const text = input.trim();
    if (!text || status === "running") return;
    // "$skill名 任务正文"：名字给 harness（注入 skill），正文才是给模型的话。
    // 报错时不清输入框——让用户就地改，不用重打一遍
    if (text.startsWith("$")) {
      const space = text.search(/\s/);
      const name = (space === -1 ? text : text.slice(0, space)).slice(1);
      const task = space === -1 ? "" : text.slice(space + 1).trim();
      if (!useChat.getState().skills.some((s) => s.name === name)) {
        useChat.setState({ error: `skill 不存在: ${name}（$ 后跟已安装的 skill 名）` });
        return;
      }
      if (!task) {
        useChat.setState({ error: `任务不能为空（用法：$${name} 任务描述）` });
        return;
      }
      setInput("");
      void send(task, name);
      return;
    }
    setInput("");
    if (dispatchSlash(text)) return; // "/" 开头 = 对 harness 说话，不进模型
    void send(text);
  };

  if (phase === "connecting") return <main className="flex-1 min-w-0 px-6 py-24 text-muted-foreground">连接主进程…</main>;

  // 布局：侧栏常驻，主区按 settingsSection 分发（账号 / 模型配置 / Skill 库 / 欢迎 / 聊天）。
  // Protocol/Git Graph 不整页替换而是右侧叠加面板:默认半屏(会话还看得见),可展开全屏
  const panel = gitGraphOpen ? <GitGraphView /> : protocolOpen ? <ProtocolView /> : null;
  const base = settingsSection === "account" ? (
    <AccountPage />
  ) : settingsSection === "keys" ? (
    <KeysPage />
  ) : settingsSection === "skills" ? (
    <SkillsPage />
  ) : phase === "welcome" ? (
    <Welcome />
  ) : (
    <div className={MAIN_COL}>
      <header className={HEADER}>
        <span className="font-[650] inline-flex items-center gap-[6px]">
          <img className="w-[18px] h-[18px] rounded-[5px]" src={ottoLogo} alt="" />
          Mr Otto
        </span>
        {/* header 永远单行:溢出截断加省略号(完整路径挂 title,悬停可见) */}
        <span className="text-muted-foreground text-xs font-mono flex-1 min-w-0 truncate" title={workspace}>
          {workspace.split("/").pop()} · {sessionId}
        </span>
        {/* 模式出口不进菜单:回放中把「回到直播」外显,不让用户困在模式里翻菜单找出路 */}
        {replaying && (
          <Button variant="ghost" size="sm" className={HEADER_GHOST} onClick={() => setReplayCursor(null)}>
            回到直播
          </Button>
        )}
        {/* 头部只留一颗「更多」溢出菜单:回放/Protocol 等功能收进去,后续新功能有地方放 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className={HEADER_GHOST} title="更多">
              <Ellipsis className="w-[14px] h-[14px]" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={replaying} onClick={() => setReplayCursor(0)}>
              <History /> 回放
            </DropdownMenuItem>
            {/* Protocol 仪表盘对应各工作区,入口挂会话头部,不进全局侧栏 */}
            <DropdownMenuItem onClick={() => void openProtocol()}>
              <BookMarked /> Protocol 仪表盘
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void openGitGraph()}>
              <GitBranch /> Git Graph
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {replaying ? (
        <>
          {/* 富回放：画布 + 函数轨迹，重演每条事件在系统里的路径 */}
          <Replay />
          {/* 审批卡永不因回放隐藏：它是挂起中的活控制件，藏了 agent 就卡死 */}
          <ApprovalCard />
        </>
      ) : (
        <>
          <section className="flex-1 overflow-y-auto overflow-x-hidden px-5 py-4 flex flex-col gap-2 scrollbar-thin">
            {events.map((e) => (
              <EventRow key={e.seq} event={e} all={events} />
            ))}
            {error && <div className={`${CHIP} border-err text-err`}>[turn 失败] {error}</div>}
            {streamingThinking && (
              // 直播期思考敞开着流（看得见模型在想）；凝固成事件后默认折叠。
              // open 受控写死：流式中就是要摊开，用户要折等它完事。
              // streaming 类挂光标(app.css);直播思考限高滚动,别把时间线顶飞
              <details className={`${THINKING_DETAILS} streaming`} open>
                <summary className={THINKING_SUMMARY}>思考中</summary>
                <div className={`${THINKING_BODY} max-h-[180px] overflow-y-auto`}>{streamingThinking}</div>
              </details>
            )}
            {streamingText && (
              <div className="md streaming self-stretch max-w-full py-[2px]">
                {/* 流式也上高亮：半截代码块 rehype-highlight 容错（语言没识别就先素着），
                    完整事件到达后重渲一次自然纠正 */}
                <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                  {streamingText}
                </Markdown>
              </div>
            )}
            {(status === "running" || approval !== null) && (
              <div className="flex items-center gap-2 text-muted-foreground text-[13px] py-[2px]">
                <ThinkingOrb
                  state={orbStateOf(status, approval !== null)}
                  size={20}
                  theme="auto"
                />
                <TurnMeta
                  label={approval ? "等待审批…" : streamingText ? "输出中…" : "思考中…"}
                  events={events}
                />
              </div>
            )}
            <div ref={bottomRef} />
          </section>

          <ApprovalCard />

          <footer className="relative px-5 pt-[10px] pb-3">
            {/* 滚动缘渐隐:对话内容淡入 footer 底色,消掉硬切割线(scroll edge effect,非 1px 分隔) */}
            <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-10 h-10 bg-gradient-to-b from-transparent to-background" />
            {/* 会话框 = 单一容器：输入行 + 控件行融为一体（Claude Code 版式）。
                焦点环挂在容器上(focus-within)——整个会话框是一个控件 */}
            <div className="relative bg-card border border-border/60 shadow-sm rounded-xl pt-1 px-2 pb-[6px] flex flex-col gap-[2px] transition-[border-color,box-shadow] duration-150 focus-within:border-ring focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--ring)_15%,transparent)]">
              {slashMatches.length > 0 && (
                <div className={SLASH_MENU} role="listbox">
                  {slashMatches.map(([name, c], i) => (
                    <button
                      key={name}
                      className={SLASH_ITEM + (i === sel ? " bg-brand/[0.12]" : "")}
                      role="option"
                      aria-selected={i === sel}
                      onMouseEnter={() => setSlashSel(i)}
                      onClick={() => runSlash(name)}
                    >
                      <span className="font-mono text-[13px] text-brand shrink-0">{name}</span>
                      <span className="text-xs text-muted-foreground truncate">{c.desc}</span>
                    </button>
                  ))}
                </div>
              )}
              {/* $ 菜单复用 slash 菜单的全部版式：同一个位置弹出、同一套键盘手感 */}
              {skillMatches.length > 0 && (
                <div className={SLASH_MENU} role="listbox">
                  {skillMatches.map((s, i) => (
                    <button
                      key={s.name}
                      className={SLASH_ITEM + (i === sel ? " bg-brand/[0.12]" : "")}
                      role="option"
                      aria-selected={i === sel}
                      onMouseEnter={() => setSlashSel(i)}
                      onClick={() => pickSkill(s.name)}
                    >
                      <span className="font-mono text-[13px] text-brand shrink-0">{"$" + s.name}</span>
                      <span className="text-xs text-muted-foreground truncate">{s.description || "（无描述）"}</span>
                    </button>
                  ))}
                </div>
              )}
              {(staged.length > 0 || attachError) && (
                <div className="flex flex-wrap gap-[6px] items-center pt-[6px] px-[10px]">
                  {staged.map((a, i) => (
                    <span className="inline-flex items-center gap-1 bg-foreground/[0.06] rounded-md px-[6px] py-[3px] text-xs text-muted-foreground" key={i}>
                      {a.kind === "image" ? (
                        <img className="w-9 h-9 object-cover rounded-sm block" src={a.previewDataUrl} alt={a.ref.name ?? "图片"} />
                      ) : (
                        <span>
                          {a.name}({(a.bytes / 1024).toFixed(0)}KB)
                        </span>
                      )}
                      <button
                        type="button"
                        className="bg-transparent text-inherit opacity-60 text-[13px] px-[2px] hover:opacity-100"
                        title="移除"
                        onClick={() => removeStaged(i)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {attachError && <span className="text-err text-xs">{attachError}</span>}
                </div>
              )}
              {/* textarea + Enter 发送 / Shift+Enter 换行（Slack 约定）。
                  自动长高走 field-sizing: content（纯 CSS，max-height 封顶出滚动条） */}
              <Textarea
                className="border-none shadow-none min-h-0 bg-transparent text-foreground pt-2 px-2 pb-[6px] text-sm leading-[1.45] resize-none max-h-[40vh] focus-visible:ring-0 placeholder:text-muted-foreground"
                autoFocus
                rows={1}
                placeholder={status === "running" ? "turn 进行中…" : "输入消息，回车发送，Shift+回车换行"}
                disabled={status === "running"}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  // 菜单开着时键盘先归菜单：↑↓ 选、Tab 补全、Enter 执行选中项
                  if (slashMatches.length > 0) {
                    const n = slashMatches.length;
                    if (e.key === "ArrowDown") { e.preventDefault(); setSlashSel((sel + 1) % n); return; }
                    if (e.key === "ArrowUp") { e.preventDefault(); setSlashSel((sel - 1 + n) % n); return; }
                    if (e.key === "Tab") { e.preventDefault(); setInput(slashMatches[sel]![0]); return; }
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      runSlash(slashMatches[sel]![0]);
                      return;
                    }
                  }
                  // $ 菜单：Enter/Tab 都只补全名字（不发送）——正文还没打
                  if (skillMatches.length > 0) {
                    const n = skillMatches.length;
                    if (e.key === "ArrowDown") { e.preventDefault(); setSlashSel((sel + 1) % n); return; }
                    if (e.key === "ArrowUp") { e.preventDefault(); setSlashSel((sel - 1 + n) % n); return; }
                    if (e.key === "Tab" || (e.key === "Enter" && !e.nativeEvent.isComposing)) {
                      e.preventDefault();
                      pickSkill(skillMatches[sel]!.name);
                      return;
                    }
                  }
                  // Shift+Enter 走默认行为 = 插换行；裸 Enter 发送（IME 选字除外）。
                  // preventDefault 必须有：不拦的话换行会先插进 textarea 再被 setInput("") 清掉，闪一帧
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    submit();
                  }
                }}
              />
              {/* items-end:窄宽时 ComposerBar 换两行,发送键贴末行底对齐,不悬在行间 */}
              <div className="flex items-end gap-2">
                <ComposerBar />
                {/* running 时发送键原位变停止键：同一个位置、同一块肌肉记忆（Esc 同效）。
                    停止 = 描边警示色而非实底红——可停,但不嘶吼 */}
                {status === "running" ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        className={`${SEND_BTN} bg-transparent dark:bg-transparent border-err text-err hover:bg-err/[0.12] dark:hover:bg-err/[0.12] hover:text-err`}
                        onClick={() => void stop()}
                      >
                        停止
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>停止 turn（Esc）</TooltipContent>
                  </Tooltip>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button className={SEND_BTN} onClick={submit} disabled={!input.trim()}>
                        发送
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>发送(Enter)</TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>
          </footer>
        </>
      )}
    </div>
  );

  // 半屏:底层视图照常渲染,面板占右半带左框;全屏:面板独占,底层卸载省渲染
  const main = panel ? (
    <div className="flex-1 min-h-0 min-w-0 flex">
      {!panelWide && base}
      <div className={`side-panel flex min-w-0 ${panelWide ? "flex-1" : "w-1/2 shrink-0 border-l border-border"}`}>
        {panel}
      </div>
    </div>
  ) : (
    base
  );

  return (
    // shadcn 默认 wrapper 只给 min-h-svh(下限,不设上限):内容一旦超一屏,
    // 这个 div 会被撑到内容全高(auto height 服从 min-height 只兜底不封顶),
    // 内部 flex-1/overflow-y-auto 的会话列表/时间线因此拿不到有界高度,
    // scrollHeight == clientHeight,内部滚动条失效——超出部分被外层
    // body{overflow:hidden}(app.css)硬裁掉。h-screen 补一个显式高度,
    // 让这层重新成为有界 flex 容器（原 h-screen 链路的等价物）。
    // min-h-svh 与 h-screen 分属不同 tailwind-merge 分组,不会互相 dedupe,
    // 两条规则共存但不冲突(dev 环境下 svh≈vh,数值一致)
    <SidebarProvider className="h-screen">
      <TooltipProvider delayDuration={400}>
        <AppSidebar />
        {/* min-w-0:flex 子项默认 min-width:auto,宽内容会顶住不收缩,
            侧栏一展开整列右溢出窗(会话视图代码块/composer 被裁) */}
        <SidebarInset className="relative min-w-0">
          <CollapsedSidebarNub />
          {main}
        </SidebarInset>
      </TooltipProvider>
    </SidebarProvider>
  );
}
