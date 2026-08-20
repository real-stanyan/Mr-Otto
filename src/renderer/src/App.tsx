// 聊天主界面 — 功能优先（视觉设计等 harness 完工后再做）。
// 消息区就是事件日志的直接渲染：又一个投影，UI 不持有自己的对话状态。

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ThinkingOrb } from "thinking-orbs";
import { BookMarked, ChevronRight, CircleDot, Ellipsis, GitBranch, Globe, History, ListChecks, Plus, Search, Spade, SquareTerminal, Terminal as TerminalIcon, Users } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { type SessionMode, useChat } from "./store.js";
import type { SettingsSection } from "./store.js";
import ottoLogo from "./assets/otto.png";
import { CodeDiff } from "@/components/elements/code-diff.js";
import { ReviewableDiff } from "@/components/elements/reviewable-diff.js";
import {
  ComposerActions,
  ComposerAttachButton,
  ComposerBar,
  ComposerSend,
  ComposerToolbar,
} from "@/components/elements/composer.js";
import { PermissionGrant } from "@/components/elements/permission-grant.js";
import { TodoList } from "@/components/elements/todo-list.js";
import { composeContent, diffDoc, diffView } from "./lib/diffView.js";
import type { GrantScope } from "../../shared/permissionGrants.js";
import type { ApprovalRequest } from "../../shared/shellBridge.js";
import { contextBreakdown } from "../../shared/contextEstimate.js";
import { countTodos, deriveTodos } from "../../session/deriveTodos.js";
import { deriveSections } from "../../session/deriveSections.js";
import type { ToolDefinition } from "../../model/adapter.js";
import { dispatchSlash, SLASH_COMMANDS } from "./commands.js";
import { Replay } from "./replay/Replay.js";
import { ProtocolView } from "./components/ProtocolView.js";
import { GitGraphView } from "./components/GitGraphView.js";
import { TerminalView } from "./components/TerminalView.js";
import { BrowserPanel } from "./components/BrowserPanel.js";
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
import { CostPanel } from "./components/CostPanel.js";
import { SessionActivity } from "./components/SessionActivity.js";
import { pickGreeting } from "./lib/greeting.js";
import { NumberTicker } from "@/components/elements/number-ticker.js";
import { ProfileSetupDialog } from "./components/ProfileSetupDialog.js";
import { ThinkingPicker } from "./components/ThinkingPicker.js";
import { BypassSwitch, BypassToggle } from "./components/BypassSwitch.js";
import { SessionSearchDialog, useSessionSearchHotkey } from "./components/SessionSearch.js";
import { displayIdentity } from "./lib/identity.js";
import { QuestionnaireCard } from "./components/QuestionnaireCard.js";
// RetryButton 不在这里 import 了:main 侧原来在这渲染它,新路径下 OttoThread 自己的
// ErrorBanner 槽已经内置了同一颗按钮(见 aui/OttoThread.tsx),App.tsx 不用重复渲染
import { SectionRail } from "./components/SectionRail.js";
import { DEFAULT_MODEL, describeModel } from "../../shared/modelCatalog.js";
import { clampThinking, thinkingLabel, type ThinkingMode } from "../../shared/thinking.js";
import { thinkingSpecOf, useModelChoice } from "./lib/useModelChoice.js";
import { modelChipLabel } from "./lib/modelChip.js";
import { ModelPicker } from "./components/ModelPicker.js";
import { ModelProviderSettings } from "./components/ModelProviderSettings.js";
import { themeController, type ThemePref } from "./theme.js";
import { groupSessionsByWorkspace } from "./sessionGroups.js";
import { Button } from "@/components/ui/button.js";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer.js";
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
import type { SessionEvent } from "../../session/events.js";
import { lastUserMessage } from "./lib/lastUserMessage.js";
import { retryPlan } from "./lib/retry.js";
import { retryLastUserMessage } from "./lib/retryAction.js";
import {
  ComposerPrimitive,
  unstable_useTriggerPopoverAriaProps,
  unstable_useSlashCommandAdapter,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  ContextDisplayRoot,
  ContextDisplayTrigger,
  ContextDisplayRingVisual,
} from "@/components/assistant-ui/context-display.js";
import type { Unstable_TriggerAdapter } from "@assistant-ui/core";
import { ComposerTriggerPopover } from "@/components/assistant-ui/composer-trigger-popover.js";
import { ottoDirectiveFormatter } from "./aui/ottoDirectives.js";
import { OttoRuntimeProvider } from "./aui/OttoRuntimeProvider.js";
import { OttoThread } from "./aui/OttoThread.js";
import { SelectionQuote } from "./components/SelectionQuote.js";

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
  "h-auto w-fit gap-1 bg-transparent dark:bg-transparent dark:hover:bg-foreground/[0.06] text-muted-foreground border-transparent rounded-full px-2 py-[3px] text-xs font-mono shadow-none hover:text-foreground hover:bg-foreground/[0.06] disabled:opacity-40 [&_svg]:size-3";
/* bypass 模式常亮警示色——免审状态必须一眼可见 */
const BYPASS = "text-warn bg-warn/[0.12]";
/* 新会话卡控件行的下拉框(比状态条版大半号,圆角 8px)——shadcn SelectTrigger 的 className 叠加层 */
const NSC_SELECT =
  "h-auto w-fit gap-1 bg-transparent dark:bg-transparent dark:hover:bg-foreground/[0.06] border-transparent rounded-full text-muted-foreground text-xs px-2 py-[3px] shadow-none hover:text-foreground hover:bg-foreground/[0.06] disabled:opacity-40 [&_svg]:size-3";
/* 工作区浮窗列表项 */
const WS_ITEM =
  "flex items-center gap-2 w-full text-left bg-transparent border-none rounded-lg px-[10px] py-2 text-foreground text-[13px] cursor-pointer hover:bg-foreground/[0.06] [&>svg]:text-muted-foreground [&>svg]:shrink-0";
/* slash/$ 补全浮层(composer 上方弹出):origin-aware,从会话框顶边长出来。
   定位交给 ComposerTriggerPopover 自己(它已经是 absolute bottom-full),
   这里只覆盖"长什么样":拉满会话框宽度 + 本仓的卡片底色/阴影/入场动画 ——
   上游默认是 w-64 的窄条 + 无动画,和旧的手写菜单不是一个观感 */
/* /$ 补全浮层(composer 上方弹出)。外观照 elements/composer 的 ComposerMenu:
   同一个输入框上方弹出来的东西,该是同一种东西 —— floating 面 + 2xl 圆角 +
   1.5 的内边距,从下沿长出来(origin-bottom-left) */
const TRIGGER_POP =
  "end-0 mb-2 w-auto max-h-[300px] overflow-auto rounded-2xl border-border/60 bg-background dark:bg-popover p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.45)] origin-bottom-left transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] starting:opacity-0 starting:scale-[0.97] motion-reduce:transition-opacity motion-reduce:starting:scale-100";
/* 审批卡里的 pre(参数 JSON / diff 兜底文案) */
const APPROVAL_PRE = "font-mono text-xs text-muted-foreground mt-[6px] whitespace-pre-wrap break-all";

// 上下文占用估算住 shared（账单锚点 + 未计费事件估算 + 按来源拆分），这里只消费

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

/** 用量环的详情浮层：全部数字都是投影（日志 + 主进程报的工具表），没有独立状态。
    主视觉 = 一条按来源分段的占用条 + 图例，回答"上下文被谁吃掉了"。

    壳换成了 assistant-ui 的 ContextDisplay（悬停 Tooltip，Root 管百分比/配色/开合），
    内容仍是本仓这一份：上游 Content 报的是"上一次请求的 usage 分项"（入/缓存/出/推理），
    本仓要回答的是"当前上下文由什么构成"（系统提示词/工具/对话消息）——两码事，换不得。
    因此只用官方的 Root + Trigger + 环（ContextDisplayRingVisual），Content 自己写 */
function CtxDetails({ events, toolDefs, ctxWindow }: {
  events: SessionEvent[];
  toolDefs: ToolDefinition[];
  ctxWindow: number;
}) {
  const breakdown = useMemo(() => contextBreakdown(events, toolDefs), [events, toolDefs]);
  const pct = Math.min(100, Math.round((breakdown.total / ctxWindow) * 100));
  const n = (x: number) => x.toLocaleString("en-US");
  /** 段宽按窗口占比（不是按三者互相占比）——条尾的空白就是"还剩多少"。
      非零的段至少 1.5px：1.5K 的系统提示词在 1M 窗口里不该被抹成不存在 */
  const width = (v: number) => (v > 0 ? `max(1.5px, ${(v / ctxWindow) * 100}%)` : "0px");

  return (
    <TooltipContent
      side="top"
      align="end"
      sideOffset={8}
      // 版式照旧：卡片底色/圆角/阴影都沿用原来的浮窗，只是开合改由 Tooltip 管。
      // 箭头藏掉——这是一张信息卡，不是一句提示气泡
      // 藏箭头:这是一张信息卡,不是一句提示气泡。本仓 tooltip 的箭头是
      // Radix 的 TooltipPrimitive.Arrow(见 ui/tooltip.tsx),它渲染成一个 <svg>,
      // 身上没有 data-slot —— 按标签选
      className="w-[300px] px-3 py-[10px] bg-card border border-border text-foreground text-xs cursor-default [&>svg]:hidden"
      aria-label="上下文用量详情"
    >
      {/* 标题位换成会滚的数(number-ticker):这张卡的主语就是"现在有多少 token
          在上下文里",而它在一个 turn 里是**活的** —— 每翻一位就是刚发生的事。
          原来那行 `~22.7K / 128K` 里的分母挪进底下的标签,分子留在这里 */}
      <div className="flex items-baseline justify-between gap-3 mb-[7px]">
        <NumberTicker
          value={breakdown.total}
          label={`已用 ${pct}% · 窗口 ${fmtCtx(ctxWindow)}`}
          valueClassName="text-[22px]"
          className="items-start gap-0.5"
        />
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
        {/* 花费按型号拆开(cost-meter):正文走贵的、压缩/分区/建议走便宜的,
            只报一个总数会把这件事抹平 */}
        <CostPanel events={events} />
      </div>
    </TooltipContent>
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
        // 身子换成 elements/todo-list：清单本身是投影(deriveTodos)，元件只负责画。
        // 三处本仓特供都走它的口子：头行留给上面那个折叠钮、进行中的图标分"真在跑/
        // 只是开了个头"两种、真在跑才加 shimmer
        <TodoList
          className="max-h-[30vh] max-w-none overflow-y-auto px-3 pt-[1px] pb-[7px]"
          header={null}
          {...(live ? { activeClassName: "shimmer" } : {})}
          activeIcon={
            live ? (
              // 包只有 20 / 64 两档预设，size={16} 会取到 undefined 直接抛
              // （issue #51 的黑屏）。要 16px 的视觉就外面缩，不要编造档位
              <span className="origin-center scale-[0.7] leading-none" aria-hidden>
                <ThinkingOrb state="working" size={20} theme="auto" />
              </span>
            ) : (
              // 停着的"开了头":实心点 = 动过,但没有转圈的动效在说"正在动"
              <CircleDot className="size-[13px] text-brand" aria-hidden />
            )
          }
          // text 就是身份(见 deriveTodos),但模型偶尔写重复文案——配上下标兜底
          items={todos.map((t, i) => ({
            id: `${i}-${t.text}`,
            text: t.text,
            status:
              t.status === "completed" ? "done" : t.status === "in_progress" ? "active" : "pending",
          }))}
        />
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

function ComposerPrefsBar() {
  const model = useChat((s) => s.model);
  const events = useChat((s) => s.events);
  const toolDefs = useChat((s) => s.toolDefs);
  const approvalMode = useChat((s) => s.approvalMode);
  const thinking = useChat((s) => s.thinking);
  const status = useChat((s) => s.statusBySession[s.sessionId] ?? "idle");
  const switchModel = useChat((s) => s.switchModel);
  const setApprovalMode = useChat((s) => s.setApprovalMode);
  const setThinking = useChat((s) => s.setThinking);
  const [prefsOpen, setPrefsOpen] = useState(false);

  // 目录 + 本机探测：Ollama 的窗只有那台机器答得上来，查目录会拿到 32k 兜底常量，
  // 圆环就会按一个假数报占用（实测 qwen3:30b 是 256k）
  const choice = useModelChoice(model);
  const ctxWindow = choice?.contextWindow ?? 128_000;
  // 环和弹窗读同一份拆分：两处数字永远对得上（弹窗展开时不会"忽然变个数"）
  const used = contextBreakdown(events, toolDefs).total;

  // 审批模式是两态,用开关不用下拉框(理由见 BypassSwitch 的开篇)
  const approvalToggle = (
    <BypassToggle value={approvalMode} onChange={(m) => void setApprovalMode(m)} />
  );

  // 型号名最长的一档不该独占半条控件行:封顶后省略。
  // thinking 挡位收进同一个浮层(ModelSelector.Effort)——挡位是型号的属性,
  // 并排两个下拉框会让人以为可以先定挡位再挑型号,而实际顺序是反的
  const modelSelect = (
    <ModelPicker
      value={model}
      onChange={(v) => void switchModel(v)}
      disabled={status === "running"}
      className={BAR_SELECT + " max-w-[164px]"}
    />
  );

  // 挡位单独一枚钮(ThinkingPicker):型号浮层只回答"用哪个型号",
  // 挡位归它自己。换不了挡的型号上这枚钮不出现
  const thinkingPick = (
    <ThinkingPicker
      spec={thinkingSpecOf(choice)}
      value={thinking}
      onChange={(m) => void setThinking(m)}
      disabled={status === "running"}
    />
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
        <div className="hidden @[520px]:flex items-center gap-2 min-w-0">{approvalToggle}</div>

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
            title={`会话偏好：${approvalMode === "auto" ? "免审批" : "逐条审批"} · ${choice?.label ?? model} · Thinking ${thinkingLabel(thinking)}`}
            onClick={() => setPrefsOpen((o) => !o)}
          >
            <Ellipsis className="size-4" />
          </Button>
          {prefsOpen && (
            <SettingsPopover onClose={() => setPrefsOpen(false)}>
              <SettingRow label="免审批">
                <BypassSwitch value={approvalMode} onChange={(m) => void setApprovalMode(m)} />
              </SettingRow>
              <SettingRow label="模型">{modelSelect}</SettingRow>
              <SettingRow label="Thinking">{thinkingPick}</SettingRow>
            </SettingsPopover>
          )}
        </span>

        {/* 附件钮用 element 的:圆形 ghost + PlusIcon。原来是个全角「＋」字符,
            它的行高/字宽跟着字体走,和旁边那些控件永远差半像素 */}
        <Tooltip>
          <TooltipTrigger asChild>
            <ComposerAttachButton
              className="size-7"
              aria-label="添加文件"
              {...(status === "running" ? {} : { onClick: () => void useChat.getState().pickFiles() })}
            />
          </TooltipTrigger>
          <TooltipContent>添加文件(图片/文本)</TooltipContent>
        </Tooltip>

        <div className="ml-auto flex items-center gap-2 min-w-0">
          <div className="hidden @[520px]:flex items-center gap-2 min-w-0">
            {modelSelect}
            {thinkingPick}
          </div>

          {/* usage 只喂 totalTokens:Root 拿它算百分比和配色。分项不走上游那套
              (入/缓存/出/推理),本仓的分项是"上下文构成",在 CtxDetails 里自己算 */}
          <ContextDisplayRoot modelContextWindow={ctxWindow} usage={{ totalTokens: used }}>
            {/* 不给 title:富 tooltip 已经把同样的数字说了一遍,
                原生气泡会在它旁边再冒一个,成了重影 */}
            <ContextDisplayTrigger
              className="p-[3px] hover:bg-foreground/[0.07]"
              aria-label="上下文用量详情"
            >
              <ContextDisplayRingVisual />
            </ContextDisplayTrigger>
            <CtxDetails events={events} toolDefs={toolDefs} ctxWindow={ctxWindow} />
          </ContextDisplayRoot>
        </div>
      </div>
    </div>
  );
}

/** write_file 审批的 diff 视图 —— assistant-ui 的 code-diff element。
    diff 现算（投影）：旧内容 + 新内容两个事实推得出，不落盘。取景规则
    （连续未变行折叠成计数）搬进了 lib/diffView.ts，那里有测试钉着；
    这里只剩"算不动就退回文本"这一个判断。
    max-w-none / max-h：element 默认 max-w-md（聊天流里的宽度），
    而审批卡是贴着输入框的一整条，宽度由卡自己定；再高就滚，不许把输入框顶出屏幕 */
function DiffPreview({
  path,
  oldText,
  newText,
}: {
  path: string;
  oldText: string | null;
  newText: string;
}) {
  const view = useMemo(() => diffView(oldText, newText), [oldText, newText]);
  if (!view) {
    return (
      <pre className={APPROVAL_PRE}>{`[文件过大，不展示 diff]\n新内容 ${newText.length} 字符`}</pre>
    );
  }
  return (
    <CodeDiff
      filename={path}
      additions={view.additions}
      deletions={view.deletions}
      lines={view.lines}
      className="mt-2 max-h-[260px] max-w-none overflow-y-auto"
    />
  );
}

function ApprovalCard() {
  // 只渲染挂靠在当前会话上的卡——别的会话的审批留在它自己的视图里
  const approval = useChat((s) => s.approvals[s.sessionId] ?? null);
  if (!approval) return null;
  // key = 这次调用:换一张卡就换一个组件实例,取舍状态和拒绝原因一起清零。
  // 用 key 而不是在 effect 里手动清 —— 少一处"忘了清"的可能
  return <ApprovalCardBody key={approval.call.id} approval={approval} />;
}

/** 审批卡的本体（ADR-0041）。三种形态，按"能不能看清将要发生什么"分：
    改文件 → ReviewableDiff（每块可丢），新文件 → CodeDiff（整份都是新增，没有块可取舍），
    其它工具 → PermissionGrant（这一步会碰什么，列出来）。
    动作条只有一条，三种形态共用：拒绝 · 批准 · 本次会话 · 永久 */
function ApprovalCardBody({ approval }: { approval: ApprovalRequest }) {
  const decide = useChat((s) => s.decide);
  const [reason, setReason] = useState("");
  const [discarded, setDiscarded] = useState<ReadonlySet<string>>(() => new Set());

  const preview = approval.preview;
  // 分块只对"改文件"有意义:新文件整份都是新增,拆块之后每一块都是"要不要这一段",
  // 而模型给的是一整个文件 —— 拼出半个文件不是任何人想要的结果
  const doc = useMemo(
    () => (preview && preview.oldText !== null ? diffDoc(preview.oldText, preview.newText) : null),
    [preview]
  );

  const toggle = (id: string, drop: boolean): void =>
    setDiscarded((prev) => {
      const next = new Set(prev);
      if (drop) next.add(id);
      else next.delete(id);
      return next;
    });

  const approve = (grant?: GrantScope): void => {
    // 一块没丢 = 原样执行,不带 revisedArgs(日志里就不会多出一份重复的内容)
    const revised =
      preview && doc && discarded.size > 0
        ? composeContent(preview.oldText, preview.newText, discarded)
        : null;
    void decide({
      decision: "approved",
      ...(grant ? { grant } : {}),
      ...(revised !== null
        ? { revisedArgs: { ...(approval.call.args as Record<string, unknown>), content: revised } }
        : {}),
    });
  };

  const keptCount = doc ? doc.hunks.length - discarded.size : 0;
  const approveLabel =
    doc && discarded.size > 0 ? `应用 ${keptCount}/${doc.hunks.length} 块` : "批准";

  return (
    // 偶发事件才配入场动画:从下方 8px 淡入——它物理上贴着输入框,从来处进场
    <div className="mx-5 mb-2 border border-warn rounded-[10px] bg-warn/[0.07] transition-[opacity,transform] duration-[220ms] ease-strong starting:opacity-0 starting:translate-y-2 motion-reduce:transition-opacity motion-reduce:duration-200 motion-reduce:starting:translate-y-0">
      <div className="pt-2 px-[14px] text-xs text-warn font-semibold">危险操作待审批</div>
      <div className="px-[14px] py-[6px]">
        {doc && preview ? (
          <ReviewableDiff
            filename={preview.path}
            hunks={doc.hunks.map((h) => ({
              id: h.id,
              range: h.range,
              decision: discarded.has(h.id) ? ("discarded" as const) : ("kept" as const),
              lines: h.lines,
            }))}
            onKeep={(id) => toggle(id, false)}
            onDiscard={(id) => toggle(id, true)}
            className="max-h-[320px] max-w-none overflow-y-auto"
          />
        ) : preview ? (
          <>
            <div className="mb-1 text-xs text-ok">（新文件）</div>
            <DiffPreview
              path={preview.path}
              oldText={preview.oldText}
              newText={preview.newText}
            />
          </>
        ) : (
          <PermissionGrant
            capability={approval.call.name}
            requester={approval.toolDescription}
            reach={reachOf(approval)}
            scope="pending"
            actions={null}
            className="max-w-none"
          />
        )}
      </div>
      <div className="flex flex-wrap gap-2 px-[14px] pb-3">
        <input
          className={`${FOCUS_INPUT} min-w-[140px] flex-1 px-[10px] py-[6px] text-[13px]`}
          placeholder="拒绝原因（可空，模型会看到）"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <Button
          variant="outline"
          className="bg-transparent dark:bg-transparent text-destructive border-destructive hover:bg-destructive/10 dark:hover:bg-destructive/10 hover:text-destructive"
          onClick={() => void decide({ decision: "denied", ...(reason.trim() ? { reason: reason.trim() } : {}) })}
        >
          拒绝
        </Button>
        {/* 两档长期许可（ADR-0041）。都顺带批准这一次 —— 授权是"以后也别问了"，
            不是"这次不算"。改过参数的那一次照旧只应用留下的块 */}
        <Button
          variant="ghost"
          className="text-muted-foreground hover:text-foreground"
          title={`本次会话内不再为 ${approval.call.name} 弹审批（换会话恢复询问）`}
          onClick={() => approve("session")}
        >
          本次会话
        </Button>
        <Button
          variant="ghost"
          className="text-muted-foreground hover:text-foreground"
          title={`以后永远不再为 ${approval.call.name} 弹审批（存在 userData/permissions.json）`}
          onClick={() => approve("always")}
        >
          永久
        </Button>
        <Button
          className="bg-ok border-ok text-white hover:bg-ok/90 hover:border-ok/90"
          onClick={() => approve()}
        >
          {approveLabel}
        </Button>
      </div>
    </div>
  );
}

/** 「这一步会」列表 —— 没有 diff 预览的工具，把参数摊成人话。
    参数出自模型，形状不赌：认得出的写成一句话，认不出的原样列 key: value */
function reachOf(approval: ApprovalRequest): string[] {
  const args = approval.call.args;
  if (typeof args !== "object" || args === null) return [String(args)];
  return Object.entries(args as Record<string, unknown>).map(([k, v]) => {
    const text = typeof v === "string" ? v : JSON.stringify(v);
    // 长参数（bash 的一整段脚本）截断：这一列是"扫一眼看清要发生什么"，不是全文
    return `${k}: ${text.length > 160 ? `${text.slice(0, 160)}…` : text}`;
  });
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
        {/* 会话热力图。放这一页而不是新会话屏:它是"我用了多久"这类统计,
            和额度卡是同一类东西;而新会话屏的正事是开始干活,一张半年统计摆在
            输入框底下只是让人多看一眼。登录与否都画 —— 数据是本机日志,不靠账号 */}
        <SessionActivity workspace={null} className="max-w-none" />
        {error && <p className={ERR_TXT}>{error}</p>}
      </section>
    </div>
  );
}

/** 模型配置页（设置栏目之一）：市面主流厂商一家一行，挑一家、贴 key 就能用。
    列表主体在 components/ModelProviderSettings.tsx —— 这里只留页壳。
    外观切换曾经挂靠在这一页顶部，已搬去独立的「外观」栏目：它和 API key 没有关系，
    放在一起只会让人以为主题是模型的一个属性 */
function KeysPage() {
  const closeSettings = useChat((s) => s.closeSettings);
  const error = useChat((s) => s.error);

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
        <ModelProviderSettings />
        {error && <p className={ERR_TXT}>{error}</p>}
      </section>
    </div>
  );
}

/** 外观页（设置栏目之一）：目前只有主题一项。
    分段控件而不是下拉框——三个选项全部可见时，"选哪个"和"现在是哪个"是同一眼的事 */
function AppearancePage() {
  const closeSettings = useChat((s) => s.closeSettings);
  const [themePref, setThemePref] = useState<ThemePref>(() => themeController().pref());

  const OPTIONS: { value: ThemePref; label: string; hint: string }[] = [
    { value: "light", label: "浅色", hint: "始终用浅色底盘" },
    { value: "dark", label: "深色", hint: "始终用深色底盘" },
    { value: "system", label: "跟随系统", hint: "跟着 macOS 的外观设置走" },
  ];

  return (
    <div className={MAIN_COL}>
      <header className={HEADER}>
        <SidebarNub />
        <span className="font-[650] inline-flex items-center gap-[6px]">外观</span>
        <Button variant="ghost" size="sm" className={HEADER_GHOST} onClick={closeSettings}>
          返回
        </Button>
      </header>
      <section className={SETTINGS_BODY}>
        <div className="flex flex-col gap-[6px]">
          <h2 className="px-1 text-[11px] tracking-[0.06em] text-muted-foreground uppercase">主题</h2>
          <div
            role="radiogroup"
            aria-label="主题"
            className="inline-flex gap-1 rounded-[10px] border border-border bg-card p-1"
          >
            {OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={themePref === o.value}
                title={o.hint}
                className={`press-scale flex-1 rounded-[7px] px-4 py-[6px] text-[13px] transition-colors duration-150 ${
                  themePref === o.value
                    ? "bg-foreground/[0.10] font-[550] text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => {
                  themeController().setPref(o.value);
                  setThemePref(o.value);
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
          <p className={HINT}>{OPTIONS.find((o) => o.value === themePref)?.hint}</p>
        </div>
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
  { id: "appearance", label: "外观" },
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
  const setSessionSearchOpen = useChat((s) => s.setSessionSearchOpen);
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
  const terminalPanelOpen = useChat((s) => s.terminalPanelOpen);
  const browserPanelOpen = useChat((s) => s.browserPanelOpen);
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
        {/* 搜索入口跟着新会话钮走:两颗都是"去别的会话"的路口。
            只留快捷键的话,不知道有这功能的人永远不知道 */}
        {settingsSection === null && mode !== "game" && (
          <Button
            variant="ghost"
            className="justify-start px-3 py-[7px] text-[13px] text-muted-foreground hover:bg-foreground/[0.06]"
            title="搜索会话（⌘K）"
            onClick={() => setSessionSearchOpen(true)}
          >
            <Search className="size-4 opacity-70" aria-hidden />
            搜索会话
            <kbd className="ml-auto font-mono text-[10px] opacity-60">⌘K</kbd>
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
                              isActive={phase === "chat" && settingsSection === null && !protocolOpen && !gitGraphOpen && !terminalPanelOpen && !browserPanelOpen && !friendChat && s.sessionId === sessionId}
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
    偏好初值：审批 ask（安全默认）、thinking 跟型号的默认档；模型跟上个会话走，
    没有就用开箱默认款 */
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
  // 招呼语只抽一次:Welcome 常驻不卸载,放进 render 体里的话每敲一个字都换一句话
  const myProfile = useChat((s) => s.myProfile);
  const account = useChat((s) => s.account);
  const [roll] = useState(() => Math.random());
  const greeting = pickGreeting(displayIdentity(account, myProfile).name, roll);
  const [model, setModel] = useState(() =>
    describeModel(lastModel) ? lastModel : DEFAULT_MODEL
  );
  const [mode, setMode] = useState<"ask" | "auto">("ask");
  const [busy, setBusy] = useState(false);
  const choice = useModelChoice(model);
  const thinkingSpec = thinkingSpecOf(choice);
  const [thinking, setThinking] = useState<ThinkingMode>(thinkingSpec.default);
  // 换型号 = 换挡位表。这里是渲染层草稿（会话还没落地，没有主进程可问），
  // 钳位得自己做——用的是同一个函数，落地后主进程再钳一次也是同一个结果
  useEffect(() => setThinking((t) => clampThinking(t, thinkingSpec)), [thinkingSpec]);
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
    <div className="flex-1 min-w-0 h-full flex flex-col items-center justify-center gap-4">
      {/* 头像左、招呼语右,整块居中。竖排的「头像 + Mr Otto」是一张启动画面 ——
          它介绍自己是谁,而这一屏的正事是开始说话。横过来之后这一块读成
          "它在跟你打招呼",和底下那个输入框连成一句话。
          不跟输入框左对齐:那样长短不一的招呼语会把右边拖出一条毛边,
          而居中让每一句都以自己为中轴,长短变化只往两边匀开 */}
      <div className="flex w-[min(640px,90%)] items-center justify-center gap-3">
        <img className="size-16 shrink-0 rounded-2xl" src={ottoLogo} alt="Mr Otto" />
        <p className="min-w-0 text-left text-[19px] font-[600] tracking-[-0.01em]">{greeting}</p>
      </div>
      {/* 新会话 composer(ZCode 版式):文件夹行 + 输入区 + 控件行一张卡。
          外面套投放区:还没有会话也能先把图拖进来,建会话后随首条消息一起走 */}
      <AttachDropZone className="w-[min(640px,90%)]" disabled={busy}>
      {/* 外壳与会话中的输入框同一套(elements/composer 的 ComposerBar):
          这两处都是"写一条要发出去的东西",长得不一样就像两个产品 */}
      {/* 焦点态与会话中的输入框同一套(见 ChatComposer):描边稍微提亮一档,不上主色。
          蓝框太响 —— 这一屏上它是唯一的彩色，眼睛会先落在框上而不是要写的字上，
          而"光标在这儿"这件事本来就有光标在说 */}
      <ComposerBar className="focus-within:border-border dark:border-muted-foreground/15 dark:focus-within:border-muted-foreground/30 w-full text-left transition-colors duration-[120ms]">
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
        <StagedChips />
        {/* 与会话中的输入框逐字同款(见 ComposerTextarea):
            bg-transparent 得连 dark: 一起写 —— shadcn 的 Textarea 自带
            dark:bg-input/30,它和裸 bg-transparent 是两个变体,谁也盖不掉谁,
            结果就是深色下卡里浮着一个灰盒子(之前会话中那个输入框栽过同一处)。
            内边距也跟着改成 px-3 py-2:px-1 会让占位符贴着卡的左边缘, 
            和底下那排控件对不上一条线 */
        }
        <Textarea
          className="border-none shadow-none resize-none bg-transparent dark:bg-transparent text-foreground text-sm leading-[1.45] min-h-[52px] max-h-[200px] px-3 py-2 focus-visible:ring-0 placeholder:text-foreground/35"
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
          <BypassToggle value={mode} onChange={setMode} />
          <Tooltip>
            <TooltipTrigger asChild>
              <ComposerAttachButton
                className="size-7"
                aria-label="添加文件"
                {...(busy ? {} : { onClick: () => void useChat.getState().pickFiles() })}
              />
            </TooltipTrigger>
            <TooltipContent>添加文件(图片/文本)，也可直接粘贴或拖入</TooltipContent>
          </Tooltip>
          <span className="flex-1" />
          <ModelPicker
            value={model}
            onChange={setModel}
            disabled={busy}
            className={NSC_SELECT + " max-w-[180px]"}
          />
          {/* 挡位单独一枚钮,与会话中的输入框同一套 */}
          <ThinkingPicker
            spec={thinkingSpec}
            value={thinking}
            onChange={setThinking}
            disabled={busy}
          />
          <ComposerSend
            streaming={false}
            idle={!workspace || busy}
            disabled={!workspace || busy}
            className="shrink-0 disabled:pointer-events-none"
            title={workspace ? "开始会话" : "先选工程文件夹"}
            aria-label="开始会话"
            onClick={() => void launch()}
          />
        </div>
      </ComposerBar>
      </AttachDropZone>
      <p className="text-muted-foreground text-xs leading-[1.7]">agent 的文件读写限制在所选文件夹内，危险操作先经你审批。</p>
      {error && <p className={ERR_TXT}>{error}</p>}
    </div>
  );
}

/** 输入框本体。
    从 ChatComposer 里再抽一层是**必须**的:它要调
    unstable_useTriggerPopoverAriaProps() 判断补全浮层开没开,而那个 hook 读的是
    TriggerPopoverRoot 的 context —— root 由 ChatComposer 自己渲染,同一个组件里
    调等于在 provider 外面调。

    为什么非得判浮层开没开:asChild 合并事件时,**我们的 onKeyDown 先跑**,
    assistant-ui 的键盘处理在后面。所以浮层开着按 Enter,会先被下面这段当成
    "发送"处理掉,浮层压根没机会选中当前项 —— 实测就是打个 `/` 再回车,
    发出去一条 `/`,然后报「未知指令 /」。
    aria-expanded 是官方给出的公开信号:ComposerPrimitive.Input 在浮层开着时
    把这套 ARIA 属性算给 textarea(见它的文档注释),这里读同一份 */
function ComposerTextarea({
  inputRef,
  disabled,
  onSubmit,
  onPasteFiles,
}: {
  /** ChatComposer 拿它做一件事:composerInject 注入文本后把焦点放回输入框 */
  inputRef: React.Ref<HTMLTextAreaElement>;
  disabled: boolean;
  onSubmit: () => void;
  onPasteFiles: (files: File[]) => void;
}) {
  const aria = unstable_useTriggerPopoverAriaProps();
  const popoverOpen = aria["aria-expanded"] === true;

  return (
    // textarea + Enter 发送 / Shift+Enter 换行（Slack 约定）。
    // 自动长高走 field-sizing: content（纯 CSS，max-height 封顶出滚动条）。
    //
    // ComposerPrimitive.Input 接管文本状态(值/受控/焦点管理),外观仍是本仓的 Textarea。
    // 三个关闭项都是刻意的:
    // - submitMode="none":发送归 ChatComposer 的 submit()(理由见那边的头注释)
    // - addAttachmentOnPaste={false}:粘贴附件走 store 的闸门(intakePastedFiles),
    //   不走 assistant-ui 的附件通道
    // - cancelOnEscape={false}:Esc 在本仓是"停止 turn"(App 里挂 window 的那个监听),
    //   不是"清空正在打的字"
    <ComposerPrimitive.Input
      asChild
      submitMode="none"
      addAttachmentOnPaste={false}
      cancelOnEscape={false}
    >
      <Textarea
        ref={inputRef}
        className="border-none shadow-none min-h-0 bg-transparent dark:bg-transparent text-foreground px-3 py-2 text-sm leading-[1.45] resize-none max-h-[40vh] focus-visible:ring-0 placeholder:text-foreground/35"
        autoFocus
        rows={1}
        placeholder={disabled ? "turn 进行中…" : "输入消息，回车发送，Shift+回车换行"}
        disabled={disabled}
        onPaste={(e) => {
          // 剪贴板里有文件(截图 Cmd+Ctrl+Shift+4、Finder 复制的文件)就当附件收,
          // 并拦掉默认行为——不然 Chromium 会把文件名当文本塞进输入框。
          // 没有文件就完全不插手:粘文字仍是原生行为(含撤销栈)
          const files = Array.from(e.clipboardData.files);
          if (files.length === 0) return;
          e.preventDefault();
          onPasteFiles(files);
        }}
        onKeyDown={(e) => {
          // 浮层开着 = 这一下键盘归浮层(↑↓ 选、Tab 补全、Enter 选中、Esc 关)。
          // 一律放行,别在这动手
          if (popoverOpen || e.defaultPrevented) return;
          // Shift+Enter 走默认行为 = 插换行；裸 Enter 发送（IME 选字除外）。
          // preventDefault 必须有：不拦的话换行会先插进 textarea 再被清空,闪一帧
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
    </ComposerPrimitive.Input>
  );
}

/** 会话中的输入框。
    从 App() 里抽出来是**必须**的,不是顺手整理:它现在读 assistant-ui 的 composer
    作用域(useAui/useAuiState),而 OttoRuntimeProvider 是 App() 自己渲染的 ——
    同一个组件里的 hook 跑在 provider 外面,一挂载就抛。抽成独立组件、放进 provider
    里面渲染,hook 才在作用域内。

    为什么文本改由 assistant-ui 持有(原来是 App 的一个 useState):
    `/` 和 `$` 的弹出菜单接下来要换成官方的 TriggerPopover + directive 适配器,
    那一整套都长在 composer 作用域上 —— 文本不交出去,它们无从挂载。

    为什么**发送**仍然走本仓自己的路(没有用 ComposerPrimitive.Send / runtime 的 onNew):
    附件的所有权在 store(staged),不在 assistant-ui。这不是懒:新会话卡(Welcome)
    也往同一个 staged 里粘图,建会话后由 send 原样带走 —— 而新会话卡渲染在
    provider 外面(那会儿还没有会话),够不着 composer 作用域。把附件交给 assistant-ui
    等于把这条交接掐断,或者养出两个所有者。既然附件不在它手上,它的
    "空输入框不给发"就会把"只贴了图不打字"这条正常路径判死,所以
    submitMode="none",Enter 和发送键都走下面这个 submit() */
function ChatComposer() {
  const status = useChat((s) => s.statusBySession[s.sessionId] ?? "idle");
  const staged = useChat((s) => s.staged);
  const send = useChat((s) => s.send);
  const stop = useChat((s) => s.stop);
  const attachPasted = useChat((s) => s.attachPasted);
  const composer = useAui().thread.composer();
  const input = useAuiState((s) => s.composer.text);
  const setInput = (text: string) => composer.setText(text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // `/` 和 `$` 的补全菜单 —— 换成 assistant-ui 的 TriggerPopover(两条 trigger 各一个)。
  // 手写那版(match/选中态/↑↓/Tab/Enter 全套)整个删掉了:触发时机、键盘导航、
  // 与 IME 的相处、光标位置的插入,这些都是 composer 作用域里的事,它比外面看得清。
  //
  // 两条 trigger 的行为不一样:
  // - `$skill`:directive(插入),选中只把 `$名字 ` 填进输入框 —— 任务正文还等着用户打
  //   (旧的 pickSkill 就是这个手感)。发送时 submit() 再把名字切给 harness
  // - `/指令`:action(执行),但带参的指令(takesArgs)不当场跑,而是同样填进输入框 ——
  //   /rename 直接跑等于把标题改成空串。无参的(/compact)当场跑,和旧菜单的 Enter 一致
  const skills = useChat((s) => s.skills);
  const skillFormatter = useMemo(
    () => ottoDirectiveFormatter(skills.map((k) => k.name)),
    [skills]
  );
  // 刻意不用 unstable_useMentionAdapter:它的 matchesQuery 连 **description** 一起匹,
  // 而 skill 的 description 是几十字的说明。实测打 "review" 命中五条毫不相干的
  // (apple-design / cloudflare-one / durable-objects…都因为描述里有 "review"),
  // 真正的那条被挤到看不见的地方。补全菜单是按名字找东西的地方,不是全文检索。
  // 形状照抄它的 flat 分支(categories/categoryItems 返回空 + 全靠 search)
  const skillAdapter = useMemo<Unstable_TriggerAdapter>(() => {
    const items = skills.map((k) => ({
      id: k.name,
      type: "skill",
      label: `$${k.name}`,
      ...(k.description ? { description: k.description } : {}),
    }));
    return {
      categories: () => [],
      categoryItems: () => [],
      search: (query: string) => {
        const lower = query.toLowerCase();
        return lower === "" ? items : items.filter((i) => i.id.toLowerCase().includes(lower));
      },
    };
  }, [skills]);
  const skillDirective = useMemo(() => ({ formatter: skillFormatter }), [skillFormatter]);
  const slashTrigger = unstable_useSlashCommandAdapter({
    removeOnExecute: true,
    commands: Object.entries(SLASH_COMMANDS).map(([name, c]) => ({
      id: name,
      label: name,
      description: c.desc,
      execute: () => {
        if (c.takesArgs) setInput(`${name} `);
        else dispatchSlash(name);
      },
    })),
  });


  // composerInject 是一次性通道:收到就立刻清空 store,不然"又注入一次同样的文本"
  // 时对象引用没变,selector 判定无变化,下次不会重新触发这个 effect
  const composerInject = useChat((s) => s.composerInject);
  useEffect(() => {
    if (!composerInject) return;
    // 追加档要读当前值。composer.getState() 而不是闭包里的 input:
    // 这个 effect 只依赖 composerInject,input 的闭包会是旧的
    const prev = composer.getState().text;
    composer.setText(
      composerInject.append
        ? (prev.trim() === "" ? "" : prev.replace(/\s*$/, "\n\n")) + composerInject.text
        : composerInject.text
    );
    useChat.setState({ composerInject: null });
    textareaRef.current?.focus();
  }, [composerInject, composer]);


  // 「有东西可发」:只贴了图不打字也算(附件本身就是内容,同 submit 的判据)
  const canSend = input.trim() !== "" || staged.length > 0;

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

  return (
    // TriggerPopoverRoot 是两条 trigger 的公共作用域(它管"现在哪条 trigger 活着")
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.Root
        onSubmit={(e) => e.preventDefault()}
        className="aui-composer-root relative flex w-full flex-col"
        // 版式三件套是 assistant-ui composer 的量纲(圆角/底色/内边距),
        // thread.tsx 把它们设在 Thread 根上 —— 而这个输入框住在 Thread 外面
        // (App 的 footer),够不着那份作用域,所以在自己这一层再设一遍。
        // 值与 thread.tsx 保持一致:同一个界面里两个输入框(会话/编辑)不该长得不一样
        style={{
          ["--composer-bg" as string]: "var(--color-card)",
          ["--composer-radius" as string]: "1.5rem",
          ["--composer-padding" as string]: "8px",
        }}
      >
        {/* 投放区是本仓自己的:附件归 store(ADR-0040),不走 assistant-ui 的
            AttachmentDropzone —— 那条路会把文件交给它的附件通道 */}
        <AttachDropZone disabled={status === "running"}>
          {/* 外壳换成 elements/composer 的 ComposerBar:同样是 paper + 大圆角,
              但它把「这一条要发的东西」当成一摞来排(附件行 / 输入 / 工具条),
              而不是三个各管各的块 */}
          <ComposerBar className="focus-within:border-border dark:border-muted-foreground/15 dark:focus-within:border-muted-foreground/30 relative cursor-text shadow-sm transition-[border-color,background-color]">
            {/* 两个补全浮层:锚在会话框上沿(popover 自己 absolute bottom-full),
                和旧的手写菜单同一个位置 */}
            <ComposerTriggerPopover
              char="$"
              className={TRIGGER_POP}
              adapter={skillAdapter}
              directive={skillDirective}
              emptyItemsLabel="没有匹配的 skill"
              emptyCategoriesLabel="还没装 skill"
              backLabel="返回"
              loadingLabel="加载中…"
            />
            <ComposerTriggerPopover
              char="/"
              className={TRIGGER_POP}
              adapter={slashTrigger.adapter}
              action={slashTrigger.action}
              emptyItemsLabel="没有匹配的指令"
              emptyCategoriesLabel="没有可用指令"
              backLabel="返回"
              loadingLabel="加载中…"
            />
            {/* 附件暂存区也是本仓的(同上):ComposerAttachments 读的是 assistant-ui
                自己那份附件状态,本仓那份在 store.staged */}
            <StagedChips />
            <ComposerTextarea
              inputRef={textareaRef}
              disabled={status === "running"}
              onSubmit={submit}
              onPasteFiles={(files) => void filesToPayload(files).then(attachPasted)}
            />
            {/* 工具条:上游左边是「＋ 附件」、右边是发送/停止的圆钮。
                本仓左边换成会话偏好条(审批模式/模型/用量环)—— 附件的 ＋ 在它里面。
                items-end:窄宽时偏好条换两行,圆钮贴末行底对齐,不悬在行间 */}
            <ComposerToolbar className="relative items-end gap-2">
              <ComposerPrefsBar />
              <ComposerActions>
                {/* running 时发送键原位变停止键：同一个位置、同一块肌肉记忆（Esc 同效）。
                    element 的 ComposerSend 把两个图标叠在同一枚钮里做交换(缩放+模糊),
                    而不是换掉整枚钮 —— 位置不动,眼睛不用重新找它在哪。
                    没东西可发时是素底：一枚常亮的实底钮在说「点我」，可它点了没用 */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <ComposerSend
                      streaming={status === "running"}
                      idle={!canSend}
                      disabled={status !== "running" && !canSend}
                      aria-label={status === "running" ? "停止 turn" : "发送消息"}
                      onClick={() => (status === "running" ? void stop() : submit())}
                      className="shrink-0 disabled:pointer-events-none"
                    />
                  </TooltipTrigger>
                  <TooltipContent>
                    {status === "running" ? "停止 turn（Esc）" : "发送(Enter)"}
                  </TooltipContent>
                </Tooltip>
              </ComposerActions>
            </ComposerToolbar>
          </ComposerBar>
        </AttachDropZone>
      </ComposerPrimitive.Root>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
}


export function App() {
  const { phase, sessionId, workspace, events, boot, stop } = useChat();
  const mode = useChat((s) => s.sessionMode);
  const status = useChat((s) => s.statusBySession[s.sessionId] ?? "idle");
  // 会话名走侧栏那份投影(改名/首条消息都已归一在那),不在这里重算一遍
  const sessionTitle = useChat((s) => s.sessions.find((x) => x.sessionId === s.sessionId)?.title ?? null);
  const replayCursor = useChat((s) => s.replayCursor);
  const setReplayCursor = useChat((s) => s.setReplayCursor);
  const settingsSection = useChat((s) => s.settingsSection);
  const protocolOpen = useChat((s) => s.protocolOpen);
  const openProtocol = useChat((s) => s.openProtocol);
  const gitGraphOpen = useChat((s) => s.gitGraphOpen);
  const openGitGraph = useChat((s) => s.openGitGraph);
  const terminalPanelOpen = useChat((s) => s.terminalPanelOpen);
  const openTerminalPanel = useChat((s) => s.openTerminalPanel);
  const browserPanelOpen = useChat((s) => s.browserPanelOpen);
  const openBrowserPanel = useChat((s) => s.openBrowserPanel);
  const friendChat = useChat((s) => s.friendChat);
  const panelWide = useChat((s) => s.panelWide);
  // 会话目录 = 事件投影，不是 UI 状态（同 TodoPanel 的路子）
  const sections = useMemo(() => deriveSections(events), [events]);
  const [activeSection, setActiveSection] = useState<number | null>(null);
  // HTMLDivElement 而不是 HTMLElement:滚动元素现在是 ThreadPrimitive.Viewport
  // 渲染的 div(见 components/assistant-ui/thread.tsx),不再是 ThreadViewport 自己的 <section>
  const scrollRef = useRef<HTMLDivElement>(null);

  // 当前分区：IntersectionObserver 只当"位置变了"的廉价触发器，
  // 真判定靠回调里一次性读那几个锚点的 rect（锚点数就是分区数，个位数，读得起）。
  // 不挂 scroll 事件逐帧读 rect —— 那是每帧一次强制重排
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || sections.length === 0) return;
    const anchors = Array.from(root.querySelectorAll<HTMLElement>("[data-section]"));
    if (anchors.length === 0) return;

    const recompute = () => {
      // 判定线：容器顶部往下 15% —— 用户读的是屏幕上方那段，不是正中间
      const line = root.getBoundingClientRect().top + root.clientHeight * 0.15;
      let active: number | null = null;
      for (const a of anchors) {
        if (a.getBoundingClientRect().top <= line) {
          active = Number(a.dataset["section"]);
        }
      }
      setActiveSection(active);
    };

    const io = new IntersectionObserver(recompute, { root, threshold: 0 });
    anchors.forEach((a) => io.observe(a));
    recompute();
    return () => io.disconnect();
  }, [sections]);

  const jumpToSection = useCallback((index: number) => {
    const root = scrollRef.current;
    const anchor = root?.querySelector<HTMLElement>(`[data-section="${index}"]`);
    anchor?.scrollIntoView({
      block: "start",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }, []);

  // 划词引用(SelectionQuote)的宿主:选区两端都要落在这个容器里才算「选中了消息」。
  // 原来挂在 ThreadViewport 自己的滚动 <section> 上;ThreadViewport 没人渲染了,
  // 换成包住 OttoThread 的这层容器 —— composer 是它的兄弟(在 footer 里),不在此结构内,
  // 所以「跨区域选择」的判定边界没变
  const threadHostRef = useRef<HTMLDivElement>(null);
  const replaying = replayCursor !== null;
  // main 侧这里还有 items(groupThread)/toolIndex(buildToolIndex)/turnPhase(agentPhase)——
  // 三者都是旧 ThreadViewport 渲染路径专用的投影,在这条路径下已经没有消费者:
  // 消息渲染整个交给 toThreadMessages(见 aui/OttoThread.tsx),turnPhase 的等价物
  // 也已经搬进 OttoThread.tsx 的 RunIndicator(同一份 agentPhase 逻辑,原样搬回)。
  // sectionAnchors 是分区功能真正要留的部分,重做版本见下面 OttoThread 的
  // viewportRef/sections 两个 prop 和 aui/OttoThread.tsx 里的 SectionAnchor 槽


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

  // ⌘K = 会话搜索(见 components/SessionSearch.tsx)
  useSessionSearchHotkey();

  // ⌃` = 开/关终端面板(VS Code 同款肌肉记忆)。挂 window:焦点可能在
  // xterm 里,输入框收不到
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        if (useChat.getState().terminalPanelOpen) useChat.getState().closeTerminalPanel();
        else useChat.getState().openTerminalPanel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);


  if (phase === "connecting") return <main className="flex-1 min-w-0 px-6 py-24 text-muted-foreground">连接主进程…</main>;

  // 布局：侧栏常驻，主区按 settingsSection 分发（账号 / 模型配置 / 外观 / Skill 库 / 欢迎 / 聊天）。
  // Protocol/Git Graph/DM 不整页替换而是右侧叠加面板:默认半屏(会话还看得见),可展开全屏
  // friendChat 优先——DM 面板打开时不该被 Protocol/GitGraph 顶掉
  const panel = friendChat ? <FriendChatView />
    : browserPanelOpen ? <BrowserPanel />
    : terminalPanelOpen ? <TerminalView />
    : gitGraphOpen ? <GitGraphView />
    : protocolOpen ? <ProtocolView /> : null;
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
  ) : settingsSection === "appearance" ? (
    <AppearancePage />
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
            <DropdownMenuItem onClick={() => openTerminalPanel()}>
              <TerminalIcon /> 终端
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openBrowserPanel()}>
              <Globe /> 浏览器
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
        //
        // OttoRuntimeProvider 包住的是**整列**(消息区 + 审批卡 + footer),不是只包消息区:
        // 输入框那一排里的 assistant-ui 组件(上下文用量、模型选择器、composer)都要
        // 读 runtime 的 context(useAui/useAuiState),provider 只包消息区的话它们一挂载就抛。
        // 包到这一层的代价是零:runtime 本身是 useOttoRuntime 从 store 派生的,
        // 上移只是把同一个 context 的作用域放大,没有多算任何东西
        <OttoRuntimeProvider>
          <div ref={threadHostRef} className="flex-1 min-h-0 flex flex-col relative">
            {/* viewportRef:分区轨要量的是真正滚动的那个元素(scrollspy 的判定线、
                  跳转的 scroll-mt 都以它为准)。ThreadPrimitive.Viewport 自己转发 ref
                  (见 components/assistant-ui/thread.tsx 的 viewportRef prop),接进去就够,
                  不用像旧 ThreadViewport 那样另开一个回调 ref 去接管 DOM 节点。
                  sections:锚点(哪条消息前面插第几个分区的起点)算在 OttoThread 内部——
                  它需要 toThreadMessages 产出的消息 id 顺序才能对齐,这份顺序只有
                  OttoThread 自己手上有,不值得为了传出来再破坏封装(见 aui/OttoThread.tsx) */}
            <OttoThread viewportRef={scrollRef} sections={sections} />
            <SelectionQuote hostRef={threadHostRef} />
            {/* 只有一个分区时目录没有意义(一条目录 = 噪音),不渲染。轨是绝对定位的浮层,
                挂在 threadHostRef 这层(SelectionQuote 的宿主)的兄弟位置——出现和消失
                都不动布局,不需要占位符防重排。main 原来挂在 ThreadViewport 的 overlay
                插槽里,那层容器没了,threadHostRef 是新架构里同等地位的宿主 */}
            {sections.length >= 2 && (
              <SectionRail
                items={sections.map((s) => ({ title: s.title, preview: s.preview }))}
                activeIndex={activeSection}
                onJump={jumpToSection}
              />
            )}
          </div>

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
            <ChatComposer />
          </footer>
        </OttoRuntimeProvider>
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
          {/* 会话搜索(⌘K):侧栏按工程分堆,堆多了只能翻——这条是"记得说过什么就找得到" */}
          <SessionSearchDialog />
        </SidebarInset>
      </TooltipProvider>
    </SidebarProvider>
  );
}
