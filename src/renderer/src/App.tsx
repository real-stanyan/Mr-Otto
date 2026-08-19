// 聊天主界面 — 功能优先（视觉设计等 harness 完工后再做）。
// 消息区就是事件日志的直接渲染：又一个投影，UI 不持有自己的对话状态。

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { ThinkingOrb } from "thinking-orbs";
import { BookMarked, Check, ChevronRight, CircleDot, Ellipsis, GitBranch, History, ListChecks, Plus, Spade, SquareTerminal, Users } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { type SessionMode, useChat } from "./store.js";
import type { SettingsSection } from "./store.js";
import ottoLogo from "./assets/otto.png";
import { diffLines } from "../../shared/diff.js";
import { contextBreakdown } from "../../shared/contextEstimate.js";
import { countTodos, deriveTodos } from "../../session/deriveTodos.js";
import type { ToolDefinition } from "../../model/adapter.js";
import { dispatchSlash, SLASH_COMMANDS } from "./commands.js";
import { Replay } from "./replay/Replay.js";
import { ProtocolView } from "./components/ProtocolView.js";
import { GitGraphView } from "./components/GitGraphView.js";
import { WorkTreePill } from "./components/WorkTreePill.js";
import { AttachDropZone } from "./components/AttachDropZone.js";
import { StagedChips } from "./components/StagedChips.js";
import { filesToPayload } from "./lib/attachIntake.js";
import { FriendsSection } from "./components/FriendsSection.js";
import { FloatingSidebarNub, SidebarNub } from "./components/SidebarNub.js";
import { FriendChatView } from "./components/FriendChatView.js";
import { PokerTable } from "./components/PokerTable.js";
import { GameInviteToast } from "./components/GameInviteToast.js";
import { ProfileCard } from "./components/ProfileCard.js";
import { ProfileSetupDialog } from "./components/ProfileSetupDialog.js";
import { displayIdentity } from "./lib/identity.js";
import { QuestionnaireCard } from "./components/QuestionnaireCard.js";
import { MD_COMPONENTS } from "./components/CodeBlock.js";
import { MODEL_CATALOG, findModel } from "../../shared/modelCatalog.js";
import { themeController, type ThemePref } from "./theme.js";
import { groupSessionsByWorkspace } from "./sessionGroups.js";
import { Button } from "@/components/ui/button.js";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer.js";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker.js";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
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
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar.js";
import type { SessionEvent, ToolCallRequest } from "../../session/events.js";
import { EventRow } from "./components/Timeline.js";
import { CHIP, THINKING_BODY, THINKING_DETAILS, THINKING_SUMMARY } from "./timelineStyles.js";
import { type OrbState } from "./lib/toolSummary.js";

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
const V = "font-mono tabular-nums text-foreground whitespace-nowrap";
const POP_ROW = "flex justify-between items-baseline gap-3 text-muted-foreground py-[2.5px]";
const TITLE_SPAN = "text-[13px] max-w-full truncate";
const WHEN_SPAN = "text-[11px] text-muted-foreground font-mono max-w-full truncate";
/* 设置页骨架(账号/模型配置/Skill 库共用) */
const MAIN_COL = "flex-1 min-w-0 flex h-full flex-col";

const HEADER = "flex items-baseline gap-3 px-5 py-3 border-b border-border";
const HEADER_GHOST = "shrink-0 text-xs text-muted-foreground hover:text-foreground";
const SETTINGS_BODY =
  "flex-1 overflow-y-auto scrollbar-stable px-5 py-6 flex flex-col gap-4 w-[min(640px,100%)] mx-auto";
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
  "absolute left-0 right-0 bottom-[calc(100%+8px)] flex flex-col gap-[2px] bg-card border border-border rounded-xl p-[6px] max-h-[300px] overflow-auto shadow-[0_12px_32px_rgba(0,0,0,0.45)] origin-bottom-left transition-[opacity,transform] duration-150 ease-strong starting:opacity-0 starting:translate-y-[3px] starting:scale-[0.98] motion-reduce:transition-opacity motion-reduce:starting:translate-y-0 motion-reduce:starting:scale-100";
const SLASH_ITEM =
  "flex items-baseline gap-[10px] w-full text-left bg-transparent border-none rounded-lg px-[10px] py-[7px] cursor-pointer transition-colors duration-100";
/* 审批卡里的 pre(参数 JSON / diff 兜底文案) */
const APPROVAL_PRE = "font-mono text-xs text-muted-foreground mt-[6px] whitespace-pre-wrap break-all";

// 上下文占用估算住 shared（账单锚点 + 未计费事件估算 + 按来源拆分），这里只消费

/** orb 旁的状态文案：耗时 · token · 在干嘛（Claude Code 状态行同款，一行合体）。
    挂载即计时——本组件只在 turn 进行中存在，出生时刻就是 turn 起点 */
function TurnMeta({ events }: { events: SessionEvent[] }) {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const tokens = useMemo(() => totalTokens(events), [events]);
  return (
    <span className="tabular-nums">
      {fmtElapsed(now - start)} · {fmtTokens(tokens)} tokens
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

/** 用量弹窗的数字格式：~119K / 1M 那一路。K 以下给整数，10 万以上不要小数
    （119.0K 的那位小数没有信息量，估算精度也撑不起它） */
function fmtCtx(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}K`;
  }
  return String(n);
}

/** 三类占用的配色 —— 条形段与图例色块共用一处，两边永远同色。
    对话消息用品牌色（和圆环同源，"主角"一眼认出）；工具用紫，系统提示词用灰 */
const CTX_CATEGORIES = [
  { key: "system" as const, label: "系统提示词", color: "color-mix(in srgb, var(--foreground) 45%, transparent)" },
  { key: "tools" as const, label: "工具", color: "#8b7fe0" },
  { key: "messages" as const, label: "对话消息", color: "var(--brand)" },
];

/** 圆环点开的详情浮窗：全部数字都是投影（日志 + 主进程报的工具表），没有独立状态。
    主视觉 = 一条按来源分段的占用条 + 图例，回答"上下文被谁吃掉了"。
    锚在触发环上方（从来处出现），点外面/Esc 关闭 */
function CtxPopover({ events, toolDefs, ctxWindow, onClose }: {
  events: SessionEvent[];
  toolDefs: ToolDefinition[];
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

  const breakdown = useMemo(() => contextBreakdown(events, toolDefs), [events, toolDefs]);
  const pct = Math.min(100, Math.round((breakdown.total / ctxWindow) * 100));
  const lastUsage = [...events].reverse().find(
    (e): e is SessionEvent & { usage: { promptTokens: number; completionTokens: number } } =>
      (e.type === "assistant_message" || e.type === "context_compacted") && e.usage !== undefined
  )?.usage;
  const compacts = events.filter((e) => e.type === "context_compacted").length;
  const n = (x: number) => x.toLocaleString("en-US");
  /** 段宽按窗口占比（不是按三者互相占比）——条尾的空白就是"还剩多少"。
      非零的段至少 1.5px：1.5K 的系统提示词在 1M 窗口里不该被抹成不存在 */
  const width = (v: number) => (v > 0 ? `max(1.5px, ${(v / ctxWindow) * 100}%)` : "0px");

  return (
    <div
      className="absolute -right-1 bottom-[calc(100%+8px)] z-10 w-[276px] px-3 py-[10px] bg-card border border-border rounded-[10px] shadow-[0_8px_24px_rgba(0,0,0,0.45),0_2px_6px_rgba(0,0,0,0.3)] text-xs text-foreground cursor-default origin-bottom-right transition-[opacity,transform] duration-150 ease-strong starting:opacity-0 starting:scale-[0.97] starting:translate-y-[2px] motion-reduce:transition-opacity motion-reduce:starting:scale-100 motion-reduce:starting:translate-y-0"
      ref={ref} role="dialog" aria-label="上下文用量详情"
    >
      <div className="flex justify-between items-baseline gap-3 mb-[7px]">
        <span className="font-semibold">上下文已用 {pct}%</span>
        <span className={V + " text-muted-foreground"}>~{fmtCtx(breakdown.total)} / {fmtCtx(ctxWindow)}</span>
      </div>

      {/* 分段占用条：段宽 = 该类占窗口的比例，尾部留白 = 还没被吃掉的部分 */}
      <div
        className="flex h-[6px] rounded-full overflow-hidden bg-foreground/10 gap-[1px]"
        role="img"
        aria-label={`上下文占用 ${pct}%：系统提示词 ${breakdown.system}、工具 ${breakdown.tools}、对话消息 ${breakdown.messages} tokens`}
      >
        {CTX_CATEGORIES.map((c) => (
          <i
            key={c.key}
            className="block h-full transition-[width] duration-[400ms] ease-strong"
            style={{ width: width(breakdown[c.key]), background: c.color }}
          />
        ))}
      </div>

      <div className="mt-[9px] mb-1">
        {CTX_CATEGORIES.map((c) => (
          <div key={c.key} className={POP_ROW}>
            <span className="flex items-center gap-[7px] min-w-0">
              <i
                className="w-[7px] h-[7px] rounded-[2px] shrink-0"
                style={{ background: c.color }}
                aria-hidden="true"
              />
              {c.label}
            </span>
            {/* 带上单位:小值(~43)不带单位会像个裸数字,和 ~22.7K 不是一套读法 */}
            <span className={V}>~{fmtCtx(breakdown[c.key])} tokens</span>
          </div>
        ))}
      </div>

      <div className="pt-[6px] border-t border-border">
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
      </div>
    </div>
  );
}

/** 输入框下的状态条（Claude Code 同款布局）：
    左 = 审批模式；右 = 模型 · thinking · 上下文用量。
    模式/thinking 是运行时偏好（主进程 agent 持有）；模型是日志投影；用量是日志投影 */
/** 任务清单面板:模型用 todo_write 拆出来的活干到哪了。
    数据是 deriveTodos(events) 的投影——不存 UI state,重开 app / 换机器照样是这份。
    位置在会话框正上方:进度是"接下来要发生什么"的语境,贴着输入框读最顺 */
function TodoPanel() {
  const events = useChat((s) => s.events);
  const todos = useMemo(() => deriveTodos(events), [events]);
  // turn 没在跑时,in_progress 只是"模型开了个头就收工了",不是此刻正在发生的事。
  // 清单是日志的投影(不改),改的是措辞和动效:转圈的球 + shimmer 是"活的"的语言,
  // 静止的会话不该说这句话
  const live = useChat((s) => (s.statusBySession[s.sessionId] ?? "idle") === "running");
  const [open, setOpen] = useState(true);

  if (todos.length === 0) return null; // 没拆过任务就完全不占地方
  const c = countTodos(todos);
  const allDone = c.completed === c.total;
  // 头行只报"还没完的"——已完成数量是过去时,写出来抢眼但没用
  const summary = allDone
    ? `${c.total} 项全部完成`
    : [
        c.inProgress && `${c.inProgress} ${live ? "进行中" : "已开始"}`,
        c.pending && `${c.pending} 待处理`,
      ]
        .filter(Boolean)
        .join(" · ");

  return (
    <div className="mb-[6px] bg-card border border-border/60 rounded-xl overflow-hidden transition-[opacity,transform] duration-150 ease-strong starting:opacity-0 starting:translate-y-[2px]">
      <button
        type="button"
        className="flex items-center gap-2 w-full text-left bg-transparent border-none px-3 py-[7px] text-[13px] text-muted-foreground transition-colors duration-[120ms] hover:bg-foreground/5"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <ListChecks className="size-4 shrink-0 opacity-70" aria-hidden />
        <span className="font-[550] text-foreground shrink-0">任务</span>
        <span className="tabular-nums truncate">{summary}</span>
        <span className="ml-auto shrink-0 text-xs tabular-nums">
          {c.completed}/{c.total}
        </span>
        <ChevronRight
          className={
            "size-4 shrink-0 transition-transform duration-150 ease-strong motion-reduce:transition-none" +
            (open ? " rotate-90" : "")
          }
          aria-hidden
        />
      </button>
      {open && (
        <ul className="list-none m-0 px-3 pb-[7px] pt-[1px] max-h-[30vh] overflow-y-auto flex flex-col gap-[3px]">
          {todos.map((t, i) => (
            // text 就是身份(见 deriveTodos),但模型偶尔写重复文案——配上下标兜底
            <li className="flex items-start gap-2 text-[13px] leading-[1.45]" key={`${i}-${t.text}`}>
              <span className="shrink-0 mt-[1px] w-4 flex items-center justify-center">
                {t.status === "in_progress" ? (
                  live ? (
                    // 包只有 20 / 64 两档预设，size={16} 会取到 undefined 直接抛
                    // （issue #51 的黑屏）。要 16px 的视觉就外面缩，不要编造档位
                    <span className="scale-[0.8] origin-center leading-none" aria-hidden>
                      <ThinkingOrb state="working" size={20} theme="auto" />
                    </span>
                  ) : (
                    // 停着的"开了头":实心点 = 动过,但没有转圈的动效在说"正在动"
                    <CircleDot className="size-[13px] text-brand" aria-hidden />
                  )
                ) : t.status === "completed" ? (
                  <Check className="size-[13px] text-ok" aria-hidden />
                ) : (
                  <span className="block size-[7px] rounded-full border border-muted-foreground/60" aria-hidden />
                )}
              </span>
              <span
                className={
                  t.status === "completed"
                    ? "text-muted-foreground line-through decoration-muted-foreground/40"
                    : t.status === "in_progress"
                      ? live
                        ? "text-foreground shimmer"
                        : "text-foreground"
                      : "text-muted-foreground"
                }
              >
                {t.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 窄宽下收纳会话偏好的浮层。从触发钮左下角长出来(从来处出现,ADR-0010 的
    origin-aware 惯例),点外面 / Esc 关闭——与 CtxPopover 同一套手法 */
function SettingsPopover({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => {
      // Radix 的 Select 下拉挂在 body 的 portal 上,不在本浮层的 DOM 子树里:
      // 不放行的话点一下选项就把整个浮层关了,选不动任何东西
      const t = e.target as HTMLElement;
      if (t.closest("[data-radix-popper-content-wrapper]")) return;
      if (ref.current && !ref.current.parentElement?.contains(t)) onClose();
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
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="会话偏好"
      className="absolute -left-1 bottom-[calc(100%+8px)] z-10 w-[228px] flex flex-col gap-[6px] px-3 py-[10px] bg-card border border-border rounded-[10px] shadow-[0_8px_24px_rgba(0,0,0,0.45),0_2px_6px_rgba(0,0,0,0.3)] text-xs cursor-default origin-bottom-left transition-[opacity,transform] duration-150 ease-strong starting:opacity-0 starting:scale-[0.97] starting:translate-y-[2px] motion-reduce:transition-opacity motion-reduce:starting:scale-100 motion-reduce:starting:translate-y-0"
    >
      {children}
    </div>
  );
}

/** 浮层里的一行:左标签右控件。标签紧贴它管的那个控件——
    要靠说明文字才知道控件管什么,说明映射本身没做对 */
function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function ComposerBar() {
  const model = useChat((s) => s.model);
  const events = useChat((s) => s.events);
  const toolDefs = useChat((s) => s.toolDefs);
  const approvalMode = useChat((s) => s.approvalMode);
  const thinking = useChat((s) => s.thinking);
  const status = useChat((s) => s.statusBySession[s.sessionId] ?? "idle");
  const switchModel = useChat((s) => s.switchModel);
  const setApprovalMode = useChat((s) => s.setApprovalMode);
  const setThinking = useChat((s) => s.setThinking);
  const [ctxOpen, setCtxOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);

  const choice = findModel(model);
  const ctxWindow = choice?.contextWindow ?? 128_000;
  // 环和弹窗读同一份拆分：两处数字永远对得上（弹窗展开时不会"忽然变个数"）
  const used = contextBreakdown(events, toolDefs).total;
  const pct = Math.min(100, Math.round((used / ctxWindow) * 100));

  const approvalSelect = (
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
  );

  const modelSelect = (
    <Select value={model} onValueChange={(v) => void switchModel(v)} disabled={status === "running"}>
      {/* 型号名最长的一档("DeepSeek V4 Flash")不该独占半条控件行:封顶后省略 */}
      <SelectTrigger className={BAR_SELECT + " min-w-0 max-w-[150px]"}>
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
  );

  const thinkingSelect = (
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
  );

  return (
    // 版式按会话框自身宽度切(容器查询),不按窗口——同一个 composer 在全屏、
    // 半屏被面板挤、侧栏展开三种情况下宽度完全不同,视口断点看不见这件事。
    //
    // 原来是 flex-wrap 硬换行:控件散成两三行、右簇贴右左边留一大片空,
    // 读起来像散架而不是版式。改成【常用的留在面上,设一次就不动的收进浮层】——
    // 审批模式/模型/Thinking 是会话级偏好,＋(附件)、用量环、发送才是每条消息都碰的。
    <div className="@container flex-1 min-w-0 text-xs text-muted-foreground">
      <div className="flex items-center gap-2 pl-[2px]">
        {/* 宽:三件偏好摊开 */}
        <div className="hidden @[520px]:flex items-center gap-2 min-w-0">{approvalSelect}</div>

        {/* 窄:收进浮层。触发钮在免审(auto)状态下照样染警示色——
            危险状态绝不能因为被折叠就不见了,那是把提醒藏进抽屉 */}
        <span className="relative inline-flex @[520px]:hidden">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={
              "w-auto h-auto px-[6px] py-[3px] rounded-md text-inherit hover:bg-foreground/[0.08]" +
              (approvalMode === "auto" ? " " + BYPASS : "")
            }
            aria-label="会话偏好"
            aria-expanded={prefsOpen}
            title={`会话偏好：${approvalMode === "auto" ? "完全访问" : "逐条审批"} · ${choice?.label ?? model} · Thinking ${thinking ? "开" : "关"}`}
            onClick={() => setPrefsOpen((o) => !o)}
          >
            <Ellipsis className="size-4" />
          </Button>
          {prefsOpen && (
            <SettingsPopover onClose={() => setPrefsOpen(false)}>
              <SettingRow label="审批">{approvalSelect}</SettingRow>
              <SettingRow label="模型">{modelSelect}</SettingRow>
              <SettingRow label="推理">{thinkingSelect}</SettingRow>
            </SettingsPopover>
          )}
        </span>

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
          <div className="hidden @[520px]:flex items-center gap-2 min-w-0">
            {modelSelect}
            {thinkingSelect}
          </div>

          <span className="relative inline-flex">
            <button
              type="button"
              className="inline-flex items-center p-[3px] rounded-md bg-transparent border-none hover:bg-foreground/[0.07]"
              title={`上下文占用 ~${fmtCtx(used)}/${fmtCtx(ctxWindow)} · ${pct}%——点击看详情`}
              aria-label="上下文用量详情"
              onClick={() => setCtxOpen((o) => !o)}
            >
              <CtxRing used={used} win={ctxWindow} />
            </button>
            {ctxOpen && (
              <CtxPopover
                events={events}
                toolDefs={toolDefs}
                ctxWindow={ctxWindow}
                onClose={() => setCtxOpen(false)}
              />
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

/** 当前执行中的工具（有请求、无结果 = 还没落地）。纯日志投影：数 tool_result 对号 */
function currentTool(events: SessionEvent[]): ToolCallRequest | null {
  const done = new Set<string>();
  for (const e of events) if (e.type === "tool_result") done.add(e.toolCallId);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && e.type === "assistant_message") {
      for (const c of e.toolCalls ?? []) if (!done.has(c.id)) return c;
    }
  }
  return null;
}

/** agent 当前阶段 → orb 动画 + 文案。审批等待最优先，其后按「在跑哪个环节」细分：
     检索(read_file) / 执行(bash·write_file) / 思考(reasoning) / 作答(正文)——都是日志投影。
     四段对应 orbs 的 Searching / Working / Thinking / Solving */
function agentPhase(opts: {
  status: "idle" | "running";
  hasApproval: boolean;
  streamingThinking: string;
  streamingText: string;
  tool: ToolCallRequest | null;
}): { orb: OrbState; label: string } {
  if (opts.hasApproval) return { orb: "listening", label: "等待审批…" };
  if (opts.status !== "running") return { orb: "breathing", label: "空闲" };
  if (opts.tool?.name === "read_file") return { orb: "searching", label: "检索中…" };
  if (opts.tool) return { orb: "working", label: "执行中…" };
  if (opts.streamingText) return { orb: "solving", label: "作答中…" };
  return { orb: "composing", label: "思考中…" }; // reasoning 或模型首次调用：都还在想
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

/** 桶名 → 显示名。对得上模型下拉里的叫法，别让用户猜 flash 是哪个 */
const BUCKET_LABEL: Record<string, string> = { flash: "Flash", pro: "Pro" };

/** 官方额度卡（账号页内）。单位是 token 不是钱（ADR-0021）：
    额度要能直接当德州筹码，美元每押一注都得换算一次。
    数字是读的不是玩的——不给进度条做入场动画：这块每次进设置都会看一次，
    动一下就是每次都拖一下。 */
function QuotaCard() {
  const wallet = useChat((s) => s.wallet);
  const walletError = useChat((s) => s.walletError);
  const refreshWallet = useChat((s) => s.refreshWallet);

  if (walletError) {
    return (
      <div className="rounded-[10px] border border-border px-[14px] py-[10px]">
        <div className="flex items-center gap-2">
          <span className="text-xs font-[650]">官方额度</span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 px-2 text-xs"
            onClick={() => void refreshWallet()}
          >
            重试
          </Button>
        </div>
        {/* "查不到"和"没有额度"不是一回事，别把故障显示成 0 */}
        <p className={ERR_TXT}>查不到额度：{walletError}</p>
      </div>
    );
  }

  if (!wallet) return <p className={HINT}>正在查官方额度…</p>;

  const entries = Object.entries(wallet.buckets);
  const allEmpty = entries.every(([, b]) => b.balanceTokens <= 0);

  return (
    <div className="rounded-[10px] border border-border px-[14px] py-[10px] flex flex-col gap-[10px]">
      <span className="text-xs font-[650]">官方额度</span>

      {entries.map(([name, b]) => {
        const pct = b.grantTokens > 0
          ? Math.max(0, Math.min(100, (b.balanceTokens / b.grantTokens) * 100))
          : 0;
        const empty = b.balanceTokens <= 0;
        return (
          <div key={name} className="flex flex-col gap-[4px]">
            <div className="flex items-baseline gap-2 text-[13px]">
              <span className="font-[650]">{BUCKET_LABEL[name] ?? name}</span>
              <span className="ml-auto tabular-nums">
                {Math.max(0, b.balanceTokens).toLocaleString("en-US")}
              </span>
              <span className={`${HINT} tabular-nums`}>
                / {b.grantTokens.toLocaleString("en-US")}
              </span>
            </div>
            <div className="h-[3px] rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full ${empty ? "bg-destructive" : "bg-primary"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}

      <p className={HINT}>
        {allEmpty
          ? "额度都用完了。去「模型配置」填自己的 API key 即可继续。"
          : "单位是 token（进 + 出）。两档各扣各的，互不流通；填了自己的 key 就走自己的，不动这份额度。"}
      </p>
    </div>
  );
}

/** 账号页（设置栏目之一）：未登录 = 两个 OAuth 按钮,已登录 = 头像+身份+退出 */
function AccountPage() {
  const account = useChat((s) => s.account);
  const signIn = useChat((s) => s.signIn);
  const closeSettings = useChat((s) => s.closeSettings);
  const error = useChat((s) => s.error);

  return (
    <div className={MAIN_COL}>
      <header className={HEADER}>
        <SidebarNub />
        <span className="font-[650] inline-flex items-center gap-[6px]">账号</span>
        <Button variant="ghost" size="sm" className={HEADER_GHOST} onClick={closeSettings}>
          返回
        </Button>
      </header>
      <section className={SETTINGS_BODY}>
        {account.signedIn ? (
          <>
            {/* 显示即编辑:名字和头像就地可改,和首登引导共用同一张表单
                (components/ProfileCard.tsx → ProfileEditor.tsx) */}
            <ProfileCard />
            <QuotaCard />
          </>
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
        <SidebarNub />
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
        <SidebarNub />
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

/** 侧栏工程分组的折叠状态：UI 偏好，不是会话事实，走 localStorage 不进事件日志
    （沿用 theme.ts 的先例）。存路径数组；读坏了就当全展开——折叠记忆丢了是小事，
    白屏是大事 */
const COLLAPSED_KEY = "otter-sidebar-collapsed-projects";

function loadCollapsedProjects(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function saveCollapsedProjects(dirs: Set<string>): void {
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...dirs]));
}

/** 设置栏目导航项：id 对应 store 的 settingsSection，label 是侧栏显示文案 */
const SETTINGS_SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "account", label: "账号" },
  { id: "keys", label: "模型配置" },
  { id: "skills", label: "Skill 库" },
];

/** game 档下的牌桌导航：看得见的桌 + 当前在哪张桌上 */
function TableList() {
  const tables = useChat((s) => s.pokerTables);
  const current = useChat((s) => s.pokerTableId);
  const watch = useChat((s) => s.watchPokerTable);
  const refresh = useChat((s) => s.refreshPokerTables);
  const signedIn = useChat((s) => s.account.signedIn);

  useEffect(() => {
    if (signedIn) void refresh();
  }, [signedIn, refresh]);

  return (
    <div className="px-2 py-1 flex flex-col gap-1">
      <div className="px-1 pt-1 pb-[2px] text-[11px] text-muted-foreground">牌桌</div>
      {current && (
        <button
          className="w-full rounded-md px-2 py-[6px] text-left text-[13px] hover:bg-foreground/[0.06]"
          onClick={() => void watch(null)}
        >
          ← 回到大厅
        </button>
      )}
      {tables.length === 0 ? (
        <div className="px-1 py-2 text-xs text-muted-foreground">
          {signedIn ? "还没有桌子" : "登录后可见"}
        </div>
      ) : (
        tables.map((t) => (
          <button
            key={t.id}
            className={`w-full rounded-md px-2 py-[6px] text-left transition-colors duration-150 hover:bg-foreground/[0.06] ${
              t.id === current ? "bg-foreground/[0.08]" : ""
            }`}
            onClick={() => void watch(t.id)}
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px]">{t.name || "无名桌"}</span>
              {t.live && <span className="shrink-0 text-[11px] text-primary">打着</span>}
              {t.seated && !t.live && <span className="shrink-0 text-[11px] text-muted-foreground">在座</span>}
            </div>
            <div className="text-[11px] tabular-nums text-muted-foreground">
              {t.tier} · {t.smallBlind}/{t.bigBlind}
            </div>
          </button>
        ))
      )}
    </div>
  );
}

/** game 档下的侧栏内容：work 那边的会话在干什么。
    只列"有动静"的（跑着 / 等审批 / 等回答），其余折成一行计数 ——
    牌桌上的人要的是"有没有事找我"，不是完整会话列表 */
function WorkStatusList() {
  const sessions = useChat((s) => s.sessions);
  const statusBySession = useChat((s) => s.statusBySession);
  const approvals = useChat((s) => s.approvals);
  const asks = useChat((s) => s.asks);
  const resume = useChat((s) => s.resume);
  const setSessionMode = useChat((s) => s.setSessionMode);

  const rows = sessions
    .map((s) => {
      // 顺序即优先级：等人的排在跑着的前面，因为只有前者卡着不动
      if (approvals[s.sessionId]) return { s, label: "等审批", live: true, urgent: true };
      if (asks[s.sessionId]) return { s, label: "等回答", live: true, urgent: true };
      if (statusBySession[s.sessionId] === "running") {
        return { s, label: "运行中", live: true, urgent: false };
      }
      return { s, label: "空闲", live: false, urgent: false };
    })
    .filter((r) => r.live)
    .sort((a, b) => Number(b.urgent) - Number(a.urgent));

  const idle = sessions.length - rows.length;

  return (
    <div className="px-2 py-1 flex flex-col gap-1">
      <div className="px-1 pt-1 pb-[2px] text-[11px] text-muted-foreground">Work 状态</div>
      {rows.length === 0 ? (
        <div className="px-1 py-2 text-xs text-muted-foreground">没有跑着的任务</div>
      ) : (
        rows.map(({ s, label, urgent }) => (
          <button
            key={s.sessionId}
            className="w-full text-left rounded-md px-2 py-[6px] hover:bg-foreground/[0.06] transition-colors duration-150"
            // 点一行 = 回 work 并落到那个会话上：看见了却过不去等于没看见
            onClick={() => {
              setSessionMode("work");
              void resume(s.sessionId);
            }}
          >
            <div className="flex items-center gap-2">
              <span className={`size-1.5 shrink-0 rounded-full ${urgent ? "bg-primary" : "bg-muted-foreground"}`} />
              <span className="min-w-0 flex-1 truncate text-[13px]">{s.title ?? s.sessionId}</span>
              <span className={`shrink-0 text-[11px] ${urgent ? "text-primary" : "text-muted-foreground"}`}>
                {label}
              </span>
            </div>
          </button>
        ))
      )}
      {idle > 0 && (
        <div className="px-2 pt-1 text-[11px] text-muted-foreground">另有 {idle} 个空闲会话</div>
      )}
    </div>
  );
}

/** 左侧常驻侧栏（shadcn Sidebar,offcanvas）：会话列表（设置模式下换成栏目导航）
    + 底部设置/登录槽。handler 与原自制版一字不动,只换结构壳（spec 修订 2026-08-18） */
function AppSidebar() {
  const sessions = useChat((s) => s.sessions);
  const mode = useChat((s) => s.sessionMode);
  const setSessionMode = useChat((s) => s.setSessionMode);
  const asks = useChat((s) => s.asks);
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
  // 侧栏那一行显示的是"好友看到的我",所以以 profiles 为准而不是 auth.users(ADR-0028)
  const myProfile = useChat((s) => s.myProfile);
  const identity = displayIdentity(account, myProfile);
  const protocolOpen = useChat((s) => s.protocolOpen);
  const gitGraphOpen = useChat((s) => s.gitGraphOpen);
  const friendChat = useChat((s) => s.friendChat);
  const unreadByFriend = useChat((s) => s.unreadByFriend);
  const friendsSnapshot = useChat((s) => s.friendsSnapshot);
  // 好友区显隐:侧栏常驻版收进 footer 的 icon(齿轮左边),点开弹 Drawer(vaul)。
  // 纯 UI 偏好,不进事件日志(同 collapsed 组折叠的待遇)。放 store 不放本地 state,
  // 是因为点系统通知要能把它掀开(store.onNotificationActivated)
  const friendsOpen = useChat((s) => s.friendsPanelOpen);
  const setFriendsOpen = useChat((s) => s.setFriendsPanelOpen);
  const gameInvites = useChat((s) => s.gameInvites);
  // icon 角标 = 好友区"有事"的总和:未读 DM + 待处理请求 + 待回应牌局邀请。
  // 区收着也能被看见
  const friendActivity =
    Object.values(unreadByFriend).reduce((a, b) => a + b, 0) +
    friendsSnapshot.incoming.length +
    gameInvites.filter((i) => i.direction === "incoming" && i.status === "pending").length;
  // 抽屉是模态层,盖在主区上;点开 DM 面板时弹窗让位——不然 DM 被抽屉挡住看不见
  useEffect(() => {
    if (friendChat) setFriendsOpen(false);
  }, [friendChat]);

  // 没记 workspace 的史前会话（schema 长出 workspace 之前的日志）无法重建围栏，
  // 不可恢复——但事实不该被藏：藏 = 用户看不见也删不掉的库存垃圾。
  // 灰显示人 + 开放删除，点击不响应（能力问题诚实呈现，不是数据问题）
  const prehistoric = sessions.filter((s) => s.workspace === null);
  // 可恢复的按工程文件夹分组：平铺流里同一工程被别的工程插花，工程一多就找不着
  const groups = useMemo(() => groupSessionsByWorkspace(sessions), [sessions]);
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsedProjects);
  const toggleGroup = (dir: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(dir)) next.add(dir);
      saveCollapsedProjects(next);
      return next;
    });

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
        {/* 档位切换：work = 工程会话，game = 德州牌桌。放侧栏顶部 ——
            它切的是整个主区在展示什么，属于导航，不是输入区的控件。
            面板不在这棵树里（在 SidebarInset 那侧），所以 Root 只当分段控件用：
            试过把 Root 提到最外层罩住两边，display:contents 会让 shadcn sidebar
            的 peer 兄弟选择器算错宽度，主区不被推开。键盘导航和视觉照旧，
            代价是 trigger 的 aria-controls 指向一个不存在的 id */}
        <Tabs value={mode} onValueChange={(v) => setSessionMode(v as SessionMode)}>
        <TabsList className="w-full">
          <TabsTrigger value="work">
            <SquareTerminal aria-hidden />
            Work
          </TabsTrigger>
          <TabsTrigger value="game">
            <Spade aria-hidden />
            Game
          </TabsTrigger>
        </TabsList>
        </Tabs>
        {/* ＋ 只是导航去 composer 视图：文件夹/偏好在那里配齐才建会话。
            设置模式下侧栏不是会话导航，这颗按钮没有落点，隐掉 */}
        {/* game 档下这颗也隐掉:牌桌模式里"新会话"没有落点(建牌桌是 #59 的事) */}
        {settingsSection === null && mode !== "game" && (
          <Button
            variant="ghost"
            className="justify-start px-3 py-[7px] text-[13px] border border-border hover:bg-foreground/[0.06]"
            onClick={() => newSession()} // 裸传会把 MouseEvent 当 dir 塞进去
          >
            ＋ 新会话
          </Button>
        )}
      </SidebarHeader>
      <SidebarContent>
        {mode === "game" ? (
          // 上半是牌桌导航（这一档的主业），下半是 work 那边的状态：
          // game 档里看不见会话列表也看不见审批卡，静默挂起才是真的坏 ——
          // turn 停在等审批上而人在牌桌上，不给出口等于把 agent 关在门外
          <>
            <TableList />
            <WorkStatusList />
          </>
        ) : settingsSection !== null ? (
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
          <>
            {/* 一个工程一组：组序按组内最近会话时间，最近动过的工程浮上来。
                折叠状态记 localStorage（UI 偏好不进事件日志，沿用 theme.ts 的先例） */}
            {groups.map((g) => {
              const isCollapsed = collapsed.has(g.workspace);
              return (
                <SidebarGroup key={g.workspace} className="py-1">
                  <SidebarGroupLabel asChild>
                    <button
                      className="w-full gap-1 pr-7 hover:text-sidebar-foreground"
                      onClick={() => toggleGroup(g.workspace)}
                      title={g.workspace}
                    >
                      {/* 折叠只切显隐（列表结构变化,不做高度动画）；箭头转 = 状态反馈 */}
                      <ChevronRight
                        className={`w-[13px] h-[13px] shrink-0 transition-transform duration-150 ease-out ${isCollapsed ? "" : "rotate-90"}`}
                      />
                      <span className="min-w-0 truncate">{g.label}</span>
                      {/* 收起来了才报条数：展开时数得出来，标签栏别添噪 */}
                      {isCollapsed && (
                        <span className="shrink-0 font-mono text-[10px] opacity-70">{g.sessions.length}</span>
                      )}
                    </button>
                  </SidebarGroupLabel>
                  <SidebarGroupAction
                    title={`在 ${g.label} 下开新会话`}
                    onClick={() => newSession(g.workspace)}
                  >
                    <Plus />
                  </SidebarGroupAction>
                  {!isCollapsed && (
                    <SidebarGroupContent>
                      {/* 一道竖脊 + 缩进:一眼看出这些会话挂在上面那个工程下,
                          而不是和组标题平级的另一串 */}
                      {/* 缩进只能吃自己的 padding:w-full 上再加 margin 会把总宽顶出侧栏,
                          冒出一条横滚动条 */}
                      <SidebarMenu className="border-l border-sidebar-border ml-[11px] w-[calc(100%-11px)] pl-[6px]">
                        {g.sessions.map((s) => (
                          <SidebarMenuItem key={s.sessionId}>
                            <SidebarMenuButton
                              className="h-auto flex-col items-start gap-px py-[7px]"
                              isActive={phase === "chat" && settingsSection === null && !protocolOpen && !gitGraphOpen && !friendChat && s.sessionId === sessionId}
                              onClick={() => void resume(s.sessionId)}
                            >
                              {/* 标题 = 第一条 user_message 首行（日志投影）；还没发话的会话退回文件夹名 */}
                              <span className={TITLE_SPAN}>{s.title ?? g.label}</span>
                              {/* 文件夹名搬去组标题了,这行只留时间/条数——同组里重复报工程名是噪音 */}
                              <span className={WHEN_SPAN}>
                                {new Date(s.lastTs).toLocaleDateString()} · {s.events} 条
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
                                if (confirm(`彻底删除会话 ${g.label} · ${s.sessionId}？\n整段事件日志将从数据库抹除，不可恢复。`)) {
                                  void deleteSession(s.sessionId);
                                }
                              }}
                            >
                              ✕
                            </SidebarMenuAction>
                          </SidebarMenuItem>
                        ))}
                      </SidebarMenu>
                    </SidebarGroupContent>
                  )}
                </SidebarGroup>
              );
            })}
            {/* 收起的组里有动静(跑 turn / 等审批)时提醒一句,免得折叠把事实藏了 */}
            {groups.some(
              (g) =>
                collapsed.has(g.workspace) &&
                g.sessions.some((s) => approvals[s.sessionId] || statusBySession[s.sessionId] === "running")
            ) && (
              <div className="px-[10px] pb-1 text-[11px] text-warn">收起的工程里有会话在动</div>
            )}
            {prehistoric.length > 0 && (
              // 没工程可归,不塞进任何组:垫底单列一段
              <SidebarMenu>
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
              </SidebarMenu>
            )}
            {/* 好友区不再常驻侧栏:收进 footer icon 的 Drawer(见下方 Drawer 弹窗) */}
          </>
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
            title={account.signedIn ? identity.email : undefined}
          >
            {account.signedIn ? (
              <>
                <AccountAvatar name={identity.name} avatarUrl={identity.avatarUrl} sizeCls="w-5 h-5 text-[11px]" />
                <span className="flex-1 min-w-0 truncate">{identity.name}</span>
              </>
            ) : (
              "未登录 · 点击登录"
            )}
          </button>
          {/* 好友 icon:好友区从侧栏常驻收进这里(齿轮左边),点开/收起。
              有未读 DM 或待处理请求时右上角亮角标——区收着,动静也看得见 */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className={
                  "relative shrink-0 flex items-center justify-center px-2 py-[6px] text-[13px] bg-transparent hover:text-foreground " +
                  (friendsOpen ? "text-foreground bg-foreground/[0.08]" : "text-muted-foreground")
                }
                aria-label="好友"
                aria-pressed={friendsOpen}
                onClick={() => setFriendsOpen(!friendsOpen)}
              >
                <Users className="w-[14px] h-[14px]" />
                {friendActivity > 0 && (
                  <span
                    className="absolute -top-[2px] -right-[2px] min-w-[10px] h-[10px] px-[2px] rounded-full bg-brand text-white text-[8px] font-semibold leading-none flex items-center justify-center"
                    aria-label={`${friendActivity} 条好友动态`}
                  >
                    {friendActivity > 9 ? "9+" : friendActivity}
                  </span>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent>好友</TooltipContent>
          </Tooltip>
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
      {/* 好友弹窗(shadcn Drawer/vaul):点 footer 的好友 icon 弹出。
          右侧抽屉——桌面应用里和 DM/Protocol/GitGraph 右侧面板同一空间语言;
          想要底部抽屉样式把 side 改成 "bottom" 即可。模态层,点外面/Esc/右滑关闭 */}
      <Drawer open={friendsOpen} onOpenChange={setFriendsOpen} direction="right" shouldScaleBackground={false}>
        <DrawerContent side="right" className="w-[min(340px,90vw)]">
          <DrawerHeader className="flex items-center justify-between gap-2 text-left px-4 py-3 border-b border-border">
            <DrawerTitle className="text-sm">好友</DrawerTitle>
            <button
              className="text-muted-foreground hover:text-foreground bg-transparent px-1 rounded-md text-[13px]"
              aria-label="关闭好友面板"
              onClick={() => setFriendsOpen(false)}
            >
              ✕
            </button>
          </DrawerHeader>
          {/* SidebarMenu 系列需要 SidebarProvider 上下文(抽屉 portal 到 body,
              根 provider 够不着)——包一层只喂上下文,不带侧栏结构 */}
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-stable px-[6px] py-2">
            <SidebarProvider defaultOpen className="flex-col min-h-0">
              <FriendsSection embedded />
            </SidebarProvider>
          </div>
        </DrawerContent>
      </Drawer>
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

/** 分支选择器：目录是 git 仓库才出现（不是仓库 = 整个控件消失，不占位不解释）。
    新会话里 = 选分支再开工；会话里 = 常显当前分支，也能就地切。
    切分支是唯一的 git 写操作（ADR-0014），失败给可行动文案，不甩 stderr */
function BranchPicker({
  dir,
  disabled,
  leadingSep,
}: {
  dir: string | null;
  disabled?: boolean;
  /** 前置一个「·」分隔点。放控件内部,非 git 目录整块消失时分隔点跟着走,
      不会在头部留下一个孤零零的点 */
  leadingSep?: boolean;
}) {
  const branches = useChat((s) => (dir ? s.branchesByDir[dir] : undefined));
  const loadBranches = useChat((s) => s.loadBranches);
  const checkoutBranch = useChat((s) => s.checkoutBranch);
  const checkoutBusyDir = useChat((s) => s.checkoutBusyDir);
  const checkoutError = useChat((s) => s.checkoutError);

  // 目录变了就问一次 git（undefined = 没问过；null = 问着呢）
  useEffect(() => {
    if (dir && branches === undefined) void loadBranches(dir);
  }, [dir, branches, loadBranches]);

  if (!dir) return null;
  if (branches === undefined || branches === null) return null; // 首帧不闪骨架：分支是配角
  if (!branches.ok || branches.branches.length === 0) return null; // 非 git 仓库：整块消失

  const busy = checkoutBusyDir === dir;
  return (
    <>
      {leadingSep && <span className="text-muted-foreground text-xs shrink-0">·</span>}
      <Select
        value={branches.current ?? ""}
        onValueChange={(v) => void checkoutBranch(dir, v)}
        disabled={disabled || busy}
      >
        {/* 文案必须走 SelectValue:SelectContent 默认 item-aligned 定位,拿它当对齐锚点,
            换成自制 span 会让锚点为 null、定位计算直接放弃,弹层掉到视口外(看着像"点不开") */}
        <SelectTrigger className={BAR_SELECT + " max-w-[180px]"} title={busy ? "切换中…" : "当前分支——可切换"}>
          <GitBranch className="w-3 h-3 shrink-0" />
          <SelectValue placeholder="(detached HEAD)" />
        </SelectTrigger>
        <SelectContent>
          {branches.branches.map((b) => (
            <SelectItem key={b.name} value={b.name}>
              {b.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {checkoutError && <span className="text-err text-[11px] min-w-0 truncate" title={checkoutError}>{checkoutError}</span>}
    </>
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
  // 侧栏工程分组的 ＋ 带过来的文件夹初值。Welcome 常驻不卸载，所以用 effect 跟着变，
  // 不用 key 重挂——重挂会连草稿一起清掉
  const pendingWorkspace = useChat((s) => s.pendingWorkspace);
  const [workspace, setWorkspace] = useState<string | null>(pendingWorkspace);
  useEffect(() => setWorkspace(pendingWorkspace), [pendingWorkspace]);
  const [text, setText] = useState("");
  const [model, setModel] = useState(() =>
    findModel(lastModel) ? lastModel : MODEL_CATALOG[0]!.model
  );
  const [mode, setMode] = useState<"ask" | "auto">("ask");
  const [thinking, setThinking] = useState(true);
  const [busy, setBusy] = useState(false);
  const choice = findModel(model);
  // 附件暂存区是全局的:在这里粘/拖进来的,建会话后由 send 原样带走
  const attachPasted = useChat((s) => s.attachPasted);

  const launch = async () => {
    if (!workspace || busy) return;
    setBusy(true);
    try {
      // 显式传全部偏好：下拉框显示什么就落地什么（宁多一条 model_changed，不让 UI 说谎）
      await startSession({ workspace, model, approvalMode: mode, thinking });
      const t = text.trim();
      // 建会话成功才发首条消息（失败时 phase 停在 welcome，草稿原样保留）。
      // 只贴了图不打字也算一条消息——附件本身就是内容(同会话中的 submit 口径)。
      // 这里不走 slash 分发：会话刚出生，/compact 之类没有意义
      if (useChat.getState().phase === "chat" && (t || useChat.getState().staged.length > 0)) {
        void send(t);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 min-w-0 h-full flex flex-col items-center justify-center gap-4 text-center">
      <img className="w-[72px] h-[72px] rounded-[18px]" src={ottoLogo} alt="Mr Otto" />
      <h1 className="text-2xl font-[650] tracking-[-0.01em]">Mr Otto</h1>
      {/* 新会话 composer(ZCode 版式):文件夹行 + 输入区 + 控件行一张卡。
          外面套投放区:还没有会话也能先把图拖进来,建会话后随首条消息一起走 */}
      <AttachDropZone className="w-[min(640px,90%)]" disabled={busy}>
      <div className="w-full text-left bg-card border border-border rounded-2xl px-3 py-[10px] flex flex-col gap-[6px] transition-colors duration-[120ms] focus-within:border-ring">
        <div className="flex items-center gap-2 min-w-0">
          <WorkspacePicker value={workspace} onChange={setWorkspace} />
          {/* 有 git 才出现：开工前先挑分支，省得进了会话才发现站错枝 */}
          <BranchPicker dir={workspace} disabled={busy} />
          {workspace && (
            <span className="text-muted-foreground text-[11px] min-w-0 truncate" title={workspace}>
              {workspace}
            </span>
          )}
        </div>
        <StagedChips className="px-1" />
        <Textarea
          className="border-none shadow-none resize-none text-foreground text-sm leading-[1.55] min-h-[52px] max-h-[200px] px-1 py-[2px] focus-visible:ring-0"
          autoFocus
          rows={2}
          placeholder="向 Mr Otto 描述任务，回车发送"
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            // 与会话中的输入框同口径:有文件才接管,没文件不插手原生粘贴
            const files = Array.from(e.clipboardData.files);
            if (files.length === 0) return;
            e.preventDefault();
            void filesToPayload(files).then(attachPasted);
          }}
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
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-base leading-none text-muted-foreground hover:bg-foreground/[0.08]"
                disabled={busy}
                aria-label="添加文件"
                onClick={() => void useChat.getState().pickFiles()}
              >
                ＋
              </Button>
            </TooltipTrigger>
            <TooltipContent>添加文件(图片/文本)，也可直接粘贴或拖入</TooltipContent>
          </Tooltip>
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
      </AttachDropZone>
      <p className="text-muted-foreground text-xs leading-[1.7]">agent 的文件读写限制在所选文件夹内，危险操作先经你审批。</p>
      {error && <p className={ERR_TXT}>{error}</p>}
    </div>
  );
}

export function App() {
  const { phase, sessionId, workspace, events, error, boot, send, stop } = useChat();
  const mode = useChat((s) => s.sessionMode);
  const status = useChat((s) => s.statusBySession[s.sessionId] ?? "idle");
  const approval = useChat((s) => s.approvals[s.sessionId] ?? null);
  // 会话名走侧栏那份投影(改名/首条消息都已归一在那),不在这里重算一遍
  const sessionTitle = useChat((s) => s.sessions.find((x) => x.sessionId === s.sessionId)?.title ?? null);
  const replayCursor = useChat((s) => s.replayCursor);
  const setReplayCursor = useChat((s) => s.setReplayCursor);
  const settingsSection = useChat((s) => s.settingsSection);
  const protocolOpen = useChat((s) => s.protocolOpen);
  const openProtocol = useChat((s) => s.openProtocol);
  const gitGraphOpen = useChat((s) => s.gitGraphOpen);
  const openGitGraph = useChat((s) => s.openGitGraph);
  const friendChat = useChat((s) => s.friendChat);
  const panelWide = useChat((s) => s.panelWide);
  // 直播缓冲 = 临时预览，完整 assistant_message 事件到达即被替换（内容一致，无缝）。
  // 两个 selector 都返回原始字符串——selector 里造新对象会让 zustand 每次都判"变了"
  const streamingText = useChat((s) => s.streamingBySession[s.sessionId]?.content ?? "");
  const streamingThinking = useChat((s) => s.streamingBySession[s.sessionId]?.reasoning ?? "");
  const staged = useChat((s) => s.staged);
  const attachPasted = useChat((s) => s.attachPasted);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const replaying = replayCursor !== null;
  // 直播阶段的 phase：当前在跑哪个环节（审批/检索/执行/思考/作答），决定 orb + 文案
  const turnPhase = agentPhase({
    status,
    hasApproval: approval !== null,
    streamingThinking,
    streamingText,
    tool: currentTool(events),
  });

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
    // 只贴了图不打字也算一条消息:附件本身就是内容
    if ((!text && staged.length === 0) || status === "running") return;
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
  // Protocol/Git Graph/DM 不整页替换而是右侧叠加面板:默认半屏(会话还看得见),可展开全屏
  // friendChat 优先——DM 面板打开时不该被 Protocol/GitGraph 顶掉
  const panel = friendChat ? <FriendChatView /> : gitGraphOpen ? <GitGraphView /> : protocolOpen ? <ProtocolView /> : null;
  const base = mode === "game" ? (
    // game 是另一套模式，不是会话的一个视图：头部（会话名/工程/分支）和输入框
    // 都是 work 的语境，带过来只会让人以为这行字会发给牌桌
    <div className={MAIN_COL}>
      <PokerTable />
    </div>
  ) : settingsSection === "account" ? (
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
        <SidebarNub />
        {/* 会话名 · 工程 · 分支：一行说清"我在哪个会话、哪个工程、哪根枝上"。
            会话名可长可短,只让它伸缩截断;工程名和分支控件定宽不挤掉 */}
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span className="font-[650] text-sm min-w-0 truncate" title={sessionId}>
            {sessionTitle ?? sessionId}
          </span>
          <span className="text-muted-foreground text-xs shrink-0">·</span>
          <span className="text-muted-foreground text-xs font-mono shrink-0 max-w-[180px] truncate" title={workspace}>
            {workspace.split("/").pop()}
          </span>
          {/* 分支从 composer 上方搬来:它回答的是"我在哪",属于头部这排身份信息,
              不是输入区的控件 */}
          <BranchPicker dir={workspace} disabled={status === "running"} leadingSep />
        </div>
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
          <QuestionnaireCard />
        </>
      ) : (
        // work / game 两档共用同一个输入框：切的是上面看什么，不是换一个应用
        <>
          {/* pb 要盖过 footer 那道 40px 渐隐(见下面的 -top-10 h-10):
              不留这段余量,滚到底时最后一条消息正好压在渐变里,读起来像被蒙了一层 */}
          <section className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-stable px-5 pt-4 pb-12 flex flex-col gap-2">
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
                <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={MD_COMPONENTS}>
                  {streamingText}
                </Markdown>
              </div>
            )}
            {(status === "running" || approval !== null) && (
              <Marker role="status" className="py-[2px] text-[13px]">
                <MarkerIcon className="size-5">
                  <ThinkingOrb state={turnPhase.orb} size={20} theme="auto" />
                </MarkerIcon>
                <MarkerContent className="shimmer">{turnPhase.label}</MarkerContent>
                <span className="ml-auto shrink-0 text-xs">
                  <TurnMeta events={events} />
                </span>
              </Marker>
            )}
            <div ref={bottomRef} />
          </section>

          <ApprovalCard />
          <QuestionnaireCard />

          <footer className="relative px-5 pt-[10px] pb-3">
            {/* 滚动缘渐隐:对话内容淡入 footer 底色,消掉硬切割线(scroll edge effect,非 1px 分隔) */}
            <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-10 h-10 bg-gradient-to-b from-transparent to-background" />
            <WorkTreePill />
            <TodoPanel />
            {/* 会话框 = 单一容器：输入行 + 控件行融为一体（Claude Code 版式）。
                焦点环挂在容器上(focus-within)——整个会话框是一个控件。
                外面再套一层投放区:文件拖到会话框上就是附件(与粘贴同一道闸门) */}
            <AttachDropZone disabled={status === "running"}>
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
              <StagedChips className="pt-[6px] px-[10px]" />
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
                onPaste={(e) => {
                  // 剪贴板里有文件(截图 Cmd+Ctrl+Shift+4、Finder 复制的文件)就当附件收,
                  // 并拦掉默认行为——不然 Chromium 会把文件名当文本塞进输入框。
                  // 没有文件就完全不插手:粘文字仍是原生行为(含撤销栈)
                  const files = Array.from(e.clipboardData.files);
                  if (files.length === 0) return;
                  e.preventDefault();
                  void filesToPayload(files).then(attachPasted);
                }}
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
                      <Button className={SEND_BTN} onClick={submit} disabled={!input.trim() && staged.length === 0}>
                        发送
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>发送(Enter)</TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>
            </AttachDropZone>
          </footer>
        </>
      )}
    </div>
  );

  // 半屏:底层视图照常渲染,面板占右半、可左右拖拽缩放(左 28% ~ 右 72%);
  // 全屏:面板独占,底层卸载省渲染。拖拽位置由 react-resizable-panels 按
  // autoSaveId 存 localStorage,展开/收回、重启后都能记住。
  const main = panel ? (
    panelWide ? (
      <div className="flex-1 min-h-0 min-w-0 flex">
        <div className="side-panel flex min-w-0 flex-1">{panel}</div>
      </div>
    ) : (
      <ResizablePanelGroup
        direction="horizontal"
        autoSaveId="otter-side-panel"
        className="flex-1 min-h-0 min-w-0"
      >
        <ResizablePanel defaultSize={50} minSize={28} className="min-w-0">
          {base}
        </ResizablePanel>
        {/* 不要 withHandle 那颗六点抓手:分隔线本身整条可拖,抓手只是重复的视觉噪音 */}
        <ResizableHandle />
        <ResizablePanel defaultSize={50} minSize={28} className="min-w-0">
          <div className="side-panel flex h-full min-w-0">{panel}</div>
        </ResizablePanel>
      </ResizablePanelGroup>
    )
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
          {/* 有头部的视图把重开钮排进头部(见 SidebarNub);欢迎页没有头部,
              它左上角是空地,浮标不会盖住任何东西("连接中"那屏在更早处 return) */}
          {phase === "welcome" && <FloatingSidebarNub />}
          {main}
          {/* 牌局邀请浮层:抽屉收着也得看得见,而邀请是有时效的(见组件顶部注释) */}
          <GameInviteToast />
          {/* 首登引导:只在 profiles.onboarded_at 还是空的时候自己弹一次 */}
          <ProfileSetupDialog />
        </SidebarInset>
      </TooltipProvider>
    </SidebarProvider>
  );
}
