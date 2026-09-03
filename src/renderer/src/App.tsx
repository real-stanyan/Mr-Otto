// 聊天主界面 — 功能优先（视觉设计等 harness 完工后再做）。
// 消息区就是事件日志的直接渲染：又一个投影，UI 不持有自己的对话状态。

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ThinkingOrb } from "thinking-orbs";
import { Archive, ArrowLeft, BookMarked, Boxes, Bot, ChevronRight, CircleDot, Ellipsis, FolderOpen, GitBranch, Globe, ListChecks, Loader2 as Loader2Icon, Plug, Plus, Search, Smartphone, Terminal as TerminalIcon, UploadCloud, UserRound, Users } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useChat } from "./store.js";
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
import { composeContent, diffDoc, diffView } from "../../shared/diffView.js";
import type { GrantScope } from "../../shared/permissionGrants.js";
import type {
  ApprovalDecisionKind,
  ApprovalRequest,
  IslandDisplay,
  McpConfigurePreview,
  MotionPref,
  MotionSettings,
  McpToolPreview,
  SessionSummary,
} from "../../shared/shellBridge.js";
import { contextBreakdown, cachedTokensNow } from "../../shared/contextEstimate.js";
import { countTodos, deriveTodos, turnsSinceTodoUpdate } from "../../session/deriveTodos.js";
import { deriveSections } from "../../session/deriveSections.js";
import type { ToolDefinition } from "../../model/adapter.js";
import { dispatchSlash, slashCommandName, SLASH_COMMANDS } from "./commands.js";
import { mcpPromptCommandDescription } from "./lib/mcpPromptMenu.js";
import { TrajectoryView } from "./replay/TrajectoryView.js";
import { ProtocolView } from "./components/ProtocolView.js";
import { GitGraphView } from "./components/GitGraphView.js";
import { TerminalView } from "./components/TerminalView.js";
import { BrowserPanel } from "./components/BrowserPanel.js";
import { FilesView } from "./components/FilesView.js";
import { SimulatorPanel } from "./components/SimulatorPanel.js";
import { WorkTreePill } from "./components/WorkTreePill.js";
import { SkillImportDialog } from "./components/SkillImportDialog.js";
import { TurnDiffPanel } from "./components/TurnDiffPanel.js";
import { AttachDropZone } from "./components/AttachDropZone.js";
import { BackgroundTasksPanel } from "./components/BackgroundTasksPanel.js";
import { useBackgroundWatch } from "./lib/useBackgroundWatch.js";
import { panelKeyOf } from "./lib/sidePanel.js";
import { StagedChips } from "./components/StagedChips.js";
import { filesToPayload } from "./lib/attachIntake.js";
import { FriendsSection } from "./components/FriendsSection.js";
import { friendMentionItems, searchFriendMentions } from "./lib/friendMentionItems.js";
import { WorkspacesPanel } from "./components/WorkspacesPanel.js";
import { PublishSessionDialog } from "./components/PublishSessionDialog.js";
import { ShareGrantDialog, type ShareGrantTarget } from "./components/ShareGrantDialog.js";
import { serversUsedInSession } from "../../shared/shareGrant.js";
import { SEARCH_LEFT, SidebarNub, SidebarToggle, SidebarTriggerSlot, TOGGLE_TOP } from "./components/SidebarNub.js";
import { FriendChatView } from "./components/FriendChatView.js";
import { SideChatWindow } from "./components/SideChatWindow.js";
import { ProfileCard } from "./components/ProfileCard.js";
import { CostPanel } from "./components/CostPanel.js";
import { SessionActivity } from "./components/SessionActivity.js";
import { SessionOrb } from "./components/SessionOrb.js";
import { spawnedFromOf } from "./lib/subagentTimeline.js";
import { fallbackSessionLabel, sessionDisplayName } from "./lib/sessionLabel.js";
import { cn, isMac } from "@/lib/utils.js";
import { ERR_TXT, HEADER, HEADER_GHOST, HEADER_H, HINT, MAIN_COL, SETTINGS_BODY, SETTINGS_SECTIONS, SettingsTitle } from "./settingsShell.js";
import { orbState } from "./lib/sessionOrb.js";
import { MessageQueue } from "@/components/elements/message-queue.js";
import { pickGreeting } from "./lib/greeting.js";
import { composeInjectedText } from "./lib/composerInject.js";
import { NumberTicker } from "@/components/elements/number-ticker.js";
import { ProfileSetupDialog } from "./components/ProfileSetupDialog.js";
import { ResiduePanel } from "./components/ResiduePanel.js";
import { SignInCard } from "./components/SignInCard.js";
import { SignInScreen } from "./components/SignInScreen.js";
import { SetPasswordDialog } from "./components/SetPasswordDialog.js";
import { WorkspaceSettings } from "./components/WorkspaceSettings.js";
import { ModelSetupDialog } from "./components/ModelSetupDialog.js";
import { ThinkingPicker } from "./components/ThinkingPicker.js";
import { BypassSwitch, BypassToggle } from "./components/BypassSwitch.js";
import { SessionSearchDialog, useSessionSearchHotkey } from "./components/SessionSearch.js";
import { displayIdentity, showsSignInScreen } from "./lib/identity.js";
import { QuestionnaireCard } from "./components/QuestionnaireCard.js";
import { McpPromptCard } from "./components/McpPromptCard.js";
// RetryButton 不在这里 import 了:main 侧原来在这渲染它,新路径下 OttoThread 自己的
// ErrorBanner 槽已经内置了同一颗按钮(见 aui/OttoThread.tsx),App.tsx 不用重复渲染
import { SectionRail } from "./components/SectionRail.js";
import { FolderIcon } from "./components/FileTypeIcon.js";
import { DEFAULT_MODEL, describeModel } from "../../shared/modelCatalog.js";
import type { ModelLane } from "../../shared/modelLane.js";
import { clampThinking, thinkingLabel, type ThinkingMode } from "../../shared/thinking.js";
import { thinkingSpecOf, useModelChoice } from "./lib/useModelChoice.js";
import { modelChipLabel } from "./lib/modelChip.js";
import { ModelPicker } from "./components/ModelPicker.js";
import { ModelProviderSettings } from "./components/ModelProviderSettings.js";
import { BillingSettings } from "./components/BillingSettings.js";
import { SubagentSettings } from "./components/SubagentSettings.js";
import { McpSettings } from "./components/McpSettings.js";
import { PermissionsSettings } from "./components/PermissionsSettings.js";
import { MemorySettings } from "./components/MemorySettings.js";
import { RemoteDevicesSettings } from "./components/RemoteDevicesSettings.js";
import { AutoCompactSettings } from "./components/AutoCompactSettings.js";
import { AboutUpdateSettings } from "./components/AboutUpdateSettings.js";
import { UpdatePill } from "./components/UpdatePill.js";
import { themeController, type ThemePref } from "./theme.js";
import {
  archivedTaskSessions,
  folderName,
  groupArchivedByWorkspace,
  groupSessionsByWorkspace,
  groupTasksByTopic,
  partitionShared,
  taskSessions,
} from "./sessionGroups.js";
import { SEED_TOPICS, withSeedTopics } from "../../shared/memoryTopics.js";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
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
} from "@/components/ui/sidebar.js";
import type { SessionEvent } from "../../session/events.js";
import { lastUserMessage } from "./lib/lastUserMessage.js";
import {
  ComposerPrimitive,
  unstable_useTriggerPopoverAriaProps,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  ContextDisplayRoot,
  ContextDisplayTrigger,
  ContextDisplayRingVisual,
} from "@/components/assistant-ui/context-display.js";
import type { Unstable_TriggerAdapter, Unstable_TriggerItem } from "@assistant-ui/core";
import { ComposerTriggerPopover } from "@/components/assistant-ui/composer-trigger-popover.js";
import {
  findFriendMention,
  findSkillDirective,
  ottoDirectiveFormatter,
  ottoFriendFormatter,
  ottoPathFormatter,
  ottoSlashFormatter,
} from "./aui/ottoDirectives.js";
import { segmentComposerText } from "./aui/composerDirectives.js";
import type { Unstable_DirectiveSegment } from "@assistant-ui/react";
import { OttoRuntimeProvider } from "./aui/OttoRuntimeProvider.js";
import { OttoThread } from "./aui/OttoThread.js";
import { SendErrorBanner } from "./components/SendErrorBanner.js";
import { SelectionQuote } from "./components/SelectionQuote.js";

/* ─── Tailwind 迁移(ADR-0010)的共享 className 组合 ───
   多处复用的样式串抽成常量:一处改全局生效,JSX 里不抄长串。
   一次性样式直接内联在各自元素上 */
const V = "font-mono tabular-nums text-foreground whitespace-nowrap";
const POP_ROW = "flex justify-between items-baseline gap-3 text-muted-foreground py-[2.5px]";
/** 清单定稿之后用户又开了这么多轮还没更新过 = 当它被丢下了（理由见 TodoPanel） */
const STALE_TODO_TURNS = 2;

/** 只在 macOS 上给隐藏标题栏(hiddenInset)做红绿灯让位/拖拽区;别的平台原生标题栏照旧 */
const IS_MAC = isMac();


const TITLE_SPAN = "text-[13px] max-w-full truncate";
/** 侧栏平铺列表里的小段头（任务栏的「已同步 / 本地」分区，issue #809）。
    与「史前会话」那行同一副长相——同一层级的东西一张脸 */
const SECTION_HEADING = "text-[11px] text-muted-foreground tracking-[0.04em] pt-[10px] px-[10px] pb-[2px]";
const WHEN_SPAN = "text-[11px] text-muted-foreground font-mono max-w-full truncate";
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

/** 四类占用的配色 —— 条形段与图例色块共用一处，两边永远同色。
    对话消息用品牌色（和圆环同源，"主角"一眼认出）；工具用紫，项目指令用青，
    系统提示词用灰。前三段是**每轮都要重付**的固定开销，排在一起，
    条形上看到的第一截就是"这个会话的底噪有多厚"（issue #524） */
const CTX_CATEGORIES = [
  { key: "system" as const, label: "系统提示词", color: "color-mix(in srgb, var(--foreground) 45%, transparent)" },
  { key: "tools" as const, label: "工具", color: "#8b7fe0" },
  { key: "instructions" as const, label: "项目指令", color: "#5fa8b8" },
  { key: "messages" as const, label: "对话消息", color: "var(--brand)" },
];

/** 用量环的详情浮层：全部数字都是投影（日志 + 主进程报的工具表），没有独立状态。
    主视觉 = 一条按来源分段的占用条 + 图例，回答"上下文被谁吃掉了"。

    壳换成了 assistant-ui 的 ContextDisplay（悬停 Tooltip，Root 管百分比/配色/开合），
    内容仍是本仓这一份：上游 Content 报的是"上一次请求的 usage 分项"（入/缓存/出/推理），
    本仓要回答的是"当前上下文由什么构成"（系统提示词/工具/项目指令/对话消息）——两码事，换不得。
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
      // 不要箭头:这是一张信息卡,不是一句提示气泡(原先那句 [&>svg]:hidden 从来没生效,
      // 见 ui/tooltip.tsx 里 arrow 这个 prop 的注释)
      arrow={false}
      className="w-[300px] px-3 py-[10px] bg-card border border-border text-foreground text-xs cursor-default"
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
        aria-label={`上下文占用 ${pct}%：系统提示词 ${breakdown.system}、工具 ${breakdown.tools}、项目指令 ${breakdown.instructions}、对话消息 ${breakdown.messages} tokens`}
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
/** 排队面板 —— assistant-ui 的 message-queue。
    turn 跑着时敲的回车排进队里(store.enqueue),这里把队伍摊开:头一行是**正在跑
    的那条**(取日志里最后一条 user_message),底下按序是排着的。

    只在"跑着 + 队里有货"时出现:队列空着时这张卡只会重复说一遍聊天流里已经
    在说的事(那条消息就在上面),白占一层楼。
    位置在输入框正上方、任务清单之下:它讲的是"接下来要发生什么",和清单同一个语境 */
function QueuePanel() {
  const running = useChat((s) => (s.statusBySession[s.sessionId] ?? "idle") === "running");
  const queued = useChat((s) => s.queuedBySession[s.sessionId]);
  const unqueue = useChat((s) => s.unqueue);
  const events = useChat((s) => s.events);
  const nowRunning = useMemo(() => lastUserMessage(events), [events]);

  if (!running || !queued || queued.length === 0) return null;

  return (
    <MessageQueue
      running={nowRunning?.content ?? "这一 turn"}
      queued={queued}
      onCancel={unqueue}
      runningLabel="进行中"
      queuedLabel={(n) => `${n} 条排队`}
      hint="这条跑完自动发出"
      // element 默认 max-w-sm(它设想自己是一张独立卡);这里它贴着输入框,
      // 宽度该由输入框那一栏定
      className="max-w-none"
    />
  );
}

function TodoPanel() {
  const events = useChat((s) => s.events);
  const todos = useMemo(() => deriveTodos(events), [events]);
  // turn 没在跑时,in_progress 只是"模型开了个头就收工了",不是此刻正在发生的事。
  // 清单是日志的投影(不改),改的是措辞和动效:转圈的球 + shimmer 是"活的"的语言,
  // 静止的会话不该说这句话
  const live = useChat((s) => (s.statusBySession[s.sessionId] ?? "idle") === "running");
  const stale = useMemo(() => turnsSinceTodoUpdate(events), [events]);
  // 默认收起:清单是"背景进度",不是此刻要读的东西。头行那句摘要已经把
  // "干到哪了"说完了,细目要看再点开
  const [open, setOpen] = useState(false);

  if (todos.length === 0) return null; // 没拆过任务就完全不占地方
  const c = countTodos(todos);
  const allDone = c.completed === c.total;
  // 全做完了就收摊:一张写着"3 项全部完成"的卡会一直挂在输入框上方,
  // 而它已经没有任何"接下来"可讲了 —— 完成这件事在聊天流里说过了
  if (allDone) return null;
  // 疑似被丢下的清单同样收摊:模型写完就不再维护它是常态(压缩之后它自己
  // 都不记得那张表了),而一张没人更新的清单报的是一个早就不成立的进度。
  // 门槛两轮:一轮之内不动很正常(用户接着说"继续"、模型接着干同一件事),
  // 两轮还一动没动,就是它已经走到别的事上去了。turn 在跑时不判:那正是
  // 它可能马上更新清单的时刻
  if (!live && stale >= STALE_TODO_TURNS) return null;
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
    <div className="bg-card border border-border/60 rounded-xl overflow-hidden transition-[opacity,transform] duration-150 ease-strong starting:opacity-0 starting:translate-y-[2px]">
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
  const lane = useChat((s) => s.lane);
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
  // 圆环就会按一个假数报占用（实测 qwen3:30b 是 256k）。
  // contextWindowKnown = false（兜底常量/目录外猜测）时不画环（issue #193）：
  // 按假分母报百分比比不报更糟——主进程判定自动压缩用的也是同一个开关（agent.ts）
  const choice = useModelChoice(model);
  const ctxWindow = choice?.contextWindowKnown ? choice.contextWindow : null;
  // 环和弹窗读同一份拆分：两处数字永远对得上（弹窗展开时不会"忽然变个数"）
  // memo 在 [events, toolDefs] 上：这条链里有对全量事件的多次线性扫描,
  // 不 memo 的话流式期间每个 token 的重渲染都要全量重算一遍
  const used = useMemo(() => contextBreakdown(events, toolDefs).total, [events, toolDefs]);

  // 审批模式是两态,用开关不用下拉框(理由见 BypassSwitch 的开篇)
  const approvalToggle = (
    <BypassToggle value={approvalMode} onChange={(m) => void setApprovalMode(m)} />
  );

  // 型号名默认写全,挤不下了才省略:原来封了 164px 的顶,于是"GLM-4.5 Flash"
  // 这种明明放得下的名字也被砍成"GLM-4.5 Flash…" —— 省略号是**没地方了**的信号,
  // 常态挂着它等于一直在报一个假警。去掉硬顶之后,触发器按内容取宽(w-fit),
  // 行里挤了才收缩(min-w-0 + flex 默认可收缩),里面那层照旧 truncate。
  // thinking 挡位收进同一个浮层(ModelSelector.Effort)——挡位是型号的属性,
  // 并排两个下拉框会让人以为可以先定挡位再挑型号,而实际顺序是反的
  const modelSelect = (
    <ModelPicker
      value={model}
      lane={lane}
      onChange={(m, l) => void switchModel(m, l)}
      disabled={status === "running"}
      className={BAR_SELECT}
      // 只有这一处传缓存量：换的是这条活会话的型号，作废的就是它的缓存（issue #434）
      cachedTokens={cachedTokensNow(events)}
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
              (入/缓存/出/推理),本仓的分项是"上下文构成",在 CtxDetails 里自己算。
              窗口未知（兜底常量）时整个环不画:假百分比不如没有 */}
          {ctxWindow !== null && (
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
          )}
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

/** MCP 工具的审批卡正文（issue #157）。
    没有它的时候这里长这样：标题是 `mcp__github__create_pr`，正文是一坨原始 JSON。
    而每把 MCP 工具都 requiresApproval、授权记忆按完整工具名记（ADR-0041），
    一台 everything 级的 server（13 把刀）等于一个会话里 13 次这样的决定——
    这是这个功能的主交互面，值得自己的排版。

    三件事按重要性排：**哪台 server**（第三方代码的来源，最该先看清）、
    **哪把刀 + 它自称干什么**、**参数**。参数一格一项，值等宽，长的自己滚，
    不再是一行 JSON 里找逗号。 */
function McpToolApproval({ preview }: { preview: McpToolPreview }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="rounded-md bg-foreground/[0.06] px-[6px] py-[2px] font-mono text-[11px] text-foreground/60">
          MCP · {preview.server}
        </span>
        <span className="font-mono text-[13.5px] font-medium">{preview.tool}</span>
      </div>
      {preview.description !== "" && (
        <div className="text-xs text-muted-foreground">{preview.description}</div>
      )}
      {preview.args.length === 0 ? (
        <div className="text-xs text-muted-foreground">（这次调用没有参数）</div>
      ) : (
        <div className="flex flex-col gap-[6px]">
          {preview.args.map((a) => (
            <div key={a.name} className="flex flex-col gap-[2px]">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[11px] text-foreground/45">{a.name}</span>
                {a.truncated && (
                  <span className="text-[11px] text-warn">
                    只显示前 {a.value.length} 字符，共 {a.fullLength}
                  </span>
                )}
              </div>
              {/* 单个值自己滚：一个塞了整段脚本的参数不该把整张卡撑到屏幕外 */}
              <pre className="max-h-[160px] overflow-y-auto rounded-md bg-foreground/[0.04] px-2 py-[6px] font-mono text-xs whitespace-pre-wrap break-all text-foreground/75">
                {a.value === "" ? "（空）" : a.value}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** McpConfigureApproval 的三件排版积木。模块级而不是组件体内（#474）：
    体内声明 = 每次父组件重渲染都得到一个**新的组件类型**，React 按类型
    对不上就整棵子树卸载重挂——长值 <pre> 的滚动位置每次重渲染都归零 */
const McpCfgRow = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex flex-col gap-[2px]">
    <div className="flex items-baseline gap-2">
      <span className="font-mono text-[11px] text-foreground/45">{label}</span>
    </div>
    {children}
  </div>
);
const McpCfgValue = ({ text }: { text: string }) => (
  <pre className="max-h-[160px] overflow-y-auto rounded-md bg-foreground/[0.04] px-2 py-[6px] font-mono text-xs whitespace-pre-wrap break-all text-foreground/75">
    {text === "" ? "（空）" : text}
  </pre>
);
// url / command / 每条 args 都可能在主进程被截断（Task 9 审查 Important 2）——
// 截断了就在标签同一行说清"只显示前 N 字符，共 M"，照抄 McpToolApproval
// 参数表那一行的写法（那边 a.truncated 也是这么挂在标签旁边的）
const McpCfgField = ({
  label,
  text,
  truncated,
  fullLength,
  note,
}: {
  label: string;
  text: string;
  truncated?: boolean;
  fullLength?: number;
  /** 挂在标签旁边的一句提醒（同 truncated 的位置）。目前只有 enabled 用它
      说"这次调用会改变启用状态" */
  note?: string;
}) => (
  <div className="flex flex-col gap-[2px]">
    <div className="flex items-baseline gap-2">
      <span className="font-mono text-[11px] text-foreground/45">{label}</span>
      {note !== undefined && <span className="text-[11px] text-warn">{note}</span>}
      {truncated === true && (
        <span className="text-[11px] text-warn">
          只显示前 {text.length} 字符，共 {fullLength}
        </span>
      )}
    </div>
    <McpCfgValue text={text} />
  </div>
);

/** mcp_configure 的审批卡正文（Task 9）。这张卡是"agent 自助配置 MCP server"
    这条路上**唯一**的安全闸：stdio 的配置就是 command + args + env，折成
    一句"配置一台 MCP server"等于闸形同虚设——所以逐字段列，一格不省。

    排版照抄 McpToolApproval：同样的间距尺度、同样的标签/值排版、
    同样的等宽字体处理，值长了自己滚，不发明新的视觉语言。

    凭据只出键名不出值（ADR-0044 口径）：credentialKeys 只列名字，
    真值从来不会走到这张卡上。 */
/** 导出：tests/renderer/McpConfigureApproval.test.tsx 直接渲染这个组件——
    Task 9 复审 Important 1 指出，光测预览数据层测不出渲染层把 args 重新
    join 回一句话这种回归，得有一层真的渲染 DOM 的测试。 */
export function McpConfigureApproval({ preview }: { preview: McpConfigurePreview }) {
  const actionLabel =
    preview.action === "add" ? "新增" : preview.action === "update" ? "更新" : "删除";
  const Row = McpCfgRow;
  const Value = McpCfgValue;
  const Field = McpCfgField;
  // enabled 是唯一一个"有执行后果却曾经不在卡上"的字段（终审 B Important）：
  // stdio 的 enabled: true 就是"这条 command 会被 spawn"。而它翻转的那一次，
  // command/url 可能与 before 逐字相同——只显示新值的话，用户看到的是一次
  // "什么都没变的更新"。所以变化时显示 "false → true"，并在标签旁点破
  const enabledFlipped =
    preview.enabled !== null && preview.before !== null && preview.before.enabled !== preview.enabled;
  // 凭据键的集合变化（#472）：只在 update 上画「旧 → 新」——remove 本来就是
  // 整台删掉，add 没有旧集合可比。掉键单独点破：那可能是一把 Authorization，
  // 丢了这台 server 就 401，而「不带 headers 的更新」在其他字段上看起来
  // 什么都没变
  const beforeCredKeys = preview.action === "update" ? (preview.before?.credentialKeys ?? null) : null;
  const credKeysChanged =
    beforeCredKeys !== null && JSON.stringify(beforeCredKeys) !== JSON.stringify(preview.credentialKeys);
  const droppedCredKeys = credKeysChanged
    ? beforeCredKeys.filter((k) => !preview.credentialKeys.includes(k))
    : [];
  const fmtCredKeys = (keys: string[]) => (keys.length === 0 ? "（不含凭据）" : keys.join("、"));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="rounded-md bg-foreground/[0.06] px-[6px] py-[2px] font-mono text-[11px] text-foreground/60">
          MCP 配置 · {actionLabel}
        </span>
        <span className="font-mono text-[13.5px] font-medium">{preview.server}</span>
      </div>
      <div className="flex flex-col gap-[6px]">
        <Field label="action" text={preview.action} />
        <Field
          label="server"
          text={preview.server}
          truncated={preview.truncated.server}
          fullLength={preview.fullLength.server}
        />
        {preview.transport !== null && <Field label="transport" text={preview.transport} />}
        {preview.enabled !== null && (
          <Field
            label="enabled"
            text={
              enabledFlipped
                ? `${String(preview.before?.enabled)} → ${String(preview.enabled)}`
                : String(preview.enabled)
            }
            {...(enabledFlipped
              ? {
                  note: preview.enabled
                    ? "这次调用会启用这台 server（stdio = 这条命令会被执行）"
                    : "这次调用会停用这台 server",
                }
              : {})}
          />
        )}
        {/* 独立、永不截断的真实主机名（Task 9 复审 Critical A 修法②）：放在
            url 那一行之前——无论下面那行怎么变形、多长、被截成什么样，
            "到底连哪个主机"必须先出现、且必须完整 */}
        {preview.host !== null && <Field label="host" text={preview.host} />}
        {preview.url !== null && (
          <Field
            label="url"
            text={preview.url}
            truncated={preview.truncated.url}
            fullLength={preview.fullLength.url}
          />
        )}
        {preview.command !== null && (
          <>
            <Field
              label="command"
              text={preview.command}
              truncated={preview.truncated.command}
              fullLength={preview.fullLength.command}
            />
            {preview.args.length === 0 ? (
              <Row label="args">
                <div className="text-xs text-muted-foreground">（这次调用没有参数）</div>
              </Row>
            ) : (
              // 每条 arg 自己一行、自己一个框——不 join 成一句话（Task 9 审查
              // Important 1）：`["-y", "some pkg"]` 和 `["-y", "some", "pkg"]`
              // join 之后长得一模一样，用户分不清是几个参数
              preview.args.map((argValue, i) => (
                <Field
                  key={i}
                  label={`args[${i}]`}
                  text={argValue}
                  truncated={preview.truncated.args[i] ?? false}
                  fullLength={preview.fullLength.args[i] ?? 0}
                />
              ))
            )}
          </>
        )}
        <Row label="credentialKeys">
          {credKeysChanged ? (
            <>
              {droppedCredKeys.length > 0 && (
                <span className="text-[11px] text-warn">
                  这次更新会去掉凭据键：{droppedCredKeys.join("、")}（对应的旧值会被丢弃）
                </span>
              )}
              <Value text={`${fmtCredKeys(beforeCredKeys)} → ${fmtCredKeys(preview.credentialKeys)}`} />
            </>
          ) : preview.credentialKeys.length === 0 ? (
            <div className="text-xs text-muted-foreground">（不含凭据）</div>
          ) : (
            <Value text={preview.credentialKeys.join("、")} />
          )}
        </Row>
        {preview.before && (
          <Row label="before（改之前）">
            <Value
              text={`${preview.before.url ?? preview.before.command ?? "（无）"} · ${
                preview.before.enabled ? "已启用" : "已停用"
              } · 现有 ${preview.before.toolCount} 把工具`}
            />
          </Row>
        )}
      </div>
    </div>
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

  // 按钮集合由后端下发（issue #341 规则①）：这里只做「种类 → 按钮」的通用映射，
  // 新增审批场景不改前端按钮代码。缺席 = 旧主进程的包，退回全集（向后兼容）
  const kinds =
    approval.availableDecisions ??
    (["deny", "abort", "approve_session", "approve_always", "approve"] satisfies ApprovalDecisionKind[]);
  const has = (k: ApprovalDecisionKind): boolean => kinds.includes(k);

  // Esc 永远 = 取消，收敛到「不执行」（issue #341 规则③ fail-closed）：
  // 关掉这张卡的唯一键盘路径就是拒绝，不存在"关了卡但操作还挂着"的状态
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      void decide({ decision: "denied", reason: "用户取消了审批（Esc）" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decide]);

  const preview = approval.preview;
  // 四种预览各管各的：write_file 那一路要 diff，MCP 工具那一路要 server + 参数表，
  // mcp_configure 那一路要逐字段的配置卡，没有预览的退回通用卡。
  // 先分家再取字段——联合类型不分家就取不到字段
  const filePreview = preview?.kind === "write_file" ? preview : null;
  const mcpPreview = preview?.kind === "mcp_tool" ? preview : null;
  const configurePreview = preview?.kind === "mcp_configure" ? preview : null;
  // 分块只对"改文件"有意义:新文件整份都是新增,拆块之后每一块都是"要不要这一段",
  // 而模型给的是一整个文件 —— 拼出半个文件不是任何人想要的结果
  const doc = useMemo(
    () => (filePreview && filePreview.oldText !== null ? diffDoc(filePreview.oldText, filePreview.newText) : null),
    [filePreview]
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
      filePreview && doc && discarded.size > 0
        ? composeContent(filePreview.oldText, filePreview.newText, discarded)
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

  // 入场:偶发事件才配动画,从下方 8px 淡入——它物理上贴着输入框,从来处进场
  // relative z-10:footer 顶上那条 -top-10 的滚动缘渐隐会盖到紧贴它的这张卡底部,
  // 卡是活控制件,得压在渐隐上面
  const ENTER =
    "relative z-10 mx-5 mb-2 transition-[opacity,transform] duration-[220ms] ease-strong starting:opacity-0 starting:translate-y-2 motion-reduce:transition-opacity motion-reduce:duration-200 motion-reduce:starting:translate-y-0";

  // 通用工具那一路:PermissionGrant 自己就是一张卡,外面不再套橙框/标题/拒绝原因框,
  // 四颗钮塞进卡的动作条(元件自带的那排形状:h-8 胶囊)。拒绝因此不带原因 ——
  // 模型只看到 denied;要说理由的场景走输入框里的下一句话
  if (!filePreview && !mcpPreview && !configurePreview) {
    const PILL =
      "h-8 rounded-full px-3 text-xs font-medium transition-[background-color,color,scale] duration-150 active:scale-[0.96]";
    return (
      <div className={ENTER}>
        <PermissionGrant
          capability={approval.call.name}
          requester={approval.toolDescription}
          reach={reachOf(approval)}
          scope="pending"
          className="max-w-none"
          actions={
            <>
              {has("abort") && (
                <button
                  type="button"
                  className={`${PILL} text-destructive/70 hover:bg-destructive/10 hover:text-destructive`}
                  title="拒绝这一步并中止整个 turn"
                  onClick={() => void decide({ decision: "abort" })}
                >
                  中止
                </button>
              )}
              {has("deny") && (
                <button
                  type="button"
                  className={`${PILL} text-destructive hover:bg-destructive/10`}
                  onClick={() => void decide({ decision: "denied" })}
                >
                  拒绝
                </button>
              )}
              {has("approve_session") && (
                <button
                  type="button"
                  className={`${PILL} text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/90`}
                  title={`本次会话内不再为这次调用的规范化 key 弹审批（换会话恢复询问）`}
                  onClick={() => approve("session")}
                >
                  本次会话
                </button>
              )}
              {has("approve_always") && (
                <button
                  type="button"
                  className={`${PILL} text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/90`}
                  title={`以后不再为这次调用的规范化 key 弹审批（存在 userData/permissions.json）`}
                  onClick={() => approve("always")}
                >
                  永久
                </button>
              )}
              {has("approve") && (
                <button
                  type="button"
                  className={`${PILL} bg-ok text-white hover:bg-ok/90`}
                  onClick={() => approve()}
                >
                  批准
                </button>
              )}
            </>
          }
        />
      </div>
    );
  }

  return (
    <div className={`${ENTER} border border-warn rounded-[10px] bg-warn/[0.07]`}>
      <div className="pt-2 px-[14px] text-xs text-warn font-semibold">危险操作待审批</div>
      <div className="px-[14px] py-[6px]">
        {doc && filePreview ? (
          <ReviewableDiff
            filename={filePreview.path}
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
        ) : filePreview ? (
          <>
            <div className="mb-1 text-xs text-ok">（新文件）</div>
            <DiffPreview
              path={filePreview.path}
              oldText={filePreview.oldText}
              newText={filePreview.newText}
            />
          </>
        ) : mcpPreview ? (
          <McpToolApproval preview={mcpPreview} />
        ) : (
          <McpConfigureApproval preview={configurePreview!} />
        )}
      </div>
      <div className="flex flex-wrap gap-2 px-[14px] pb-3">
        <input
          className={`${FOCUS_INPUT} min-w-[140px] flex-1 px-[10px] py-[6px] text-[13px]`}
          placeholder="拒绝原因（可空，模型会看到）"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {has("abort") && (
          <Button
            variant="ghost"
            className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"
            title="拒绝这一步并中止整个 turn"
            onClick={() =>
              void decide({ decision: "abort", ...(reason.trim() ? { reason: reason.trim() } : {}) })
            }
          >
            中止
          </Button>
        )}
        {has("deny") && (
          <Button
            variant="outline"
            className="bg-transparent dark:bg-transparent text-destructive border-destructive hover:bg-destructive/10 dark:hover:bg-destructive/10 hover:text-destructive"
            onClick={() => void decide({ decision: "denied", ...(reason.trim() ? { reason: reason.trim() } : {}) })}
          >
            拒绝
          </Button>
        )}
        {/* 两档长期许可（ADR-0041）。都顺带批准这一次 —— 授权是"以后也别问了"，
            不是"这次不算"。改过参数的那一次照旧只应用留下的块 */}
        {has("approve_session") && (
          <Button
            variant="ghost"
            className="text-muted-foreground hover:text-foreground"
            title={`本次会话内不再为这次调用的规范化 key 弹审批（换会话恢复询问）`}
            onClick={() => approve("session")}
          >
            本次会话
          </Button>
        )}
        {has("approve_always") && (
          <Button
            variant="ghost"
            className="text-muted-foreground hover:text-foreground"
            title={`以后不再为这次调用的规范化 key 弹审批（存在 userData/permissions.json）`}
            onClick={() => approve("always")}
          >
            永久
          </Button>
        )}
        {has("approve") && (
          <Button
            className="bg-ok border-ok text-white hover:bg-ok/90 hover:border-ok/90"
            onClick={() => approve()}
          >
            {approveLabel}
          </Button>
        )}
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
  const configured = useChat((s) => (s.keyStatus[envName] ?? "") !== "");
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
    sizeCls 让侧栏登录槽用小一号(20px),设置页默认 28px。
    走 shadcn Avatar(issue #411):原来手写的 img 只有"没有 url"这一档降级,
    url 在但加载不出来(网关下发的第三方图挂了)时会把裂图标留在脸上——
    Radix 的 fallback 认的是加载结果,不是字符串空不空。
    字号单独一个 prop:Avatar 的 fallback 自带 text-sm,跟着 sizeCls 放在根上会被它盖掉 */
function AccountAvatar({ name, avatarUrl, sizeCls = "size-7", textCls = "text-[13px]" }: {
  name: string;
  avatarUrl: string;
  sizeCls?: string;
  textCls?: string;
}) {
  return (
    <Avatar className={`${sizeCls} shrink-0`}>
      <AvatarImage src={avatarUrl} alt={name} referrerPolicy="no-referrer" />
      <AvatarFallback className={`bg-accent font-semibold text-foreground ${textCls}`}>
        {name.charAt(0).toUpperCase() || "?"}
      </AvatarFallback>
    </Avatar>
  );
}

/** 账号页（设置栏目之一）：已登录 = 头像+身份+退出;未登录 = 那张登录卡。
    进门闸（ADR-0182）之后未登录这一支不是死代码 —— 闸门认的是「有没有登录记录」,
    离线或 session 过期的人正是被它故意放进来的,进来之后处处是未登录态 */
function AccountPage() {
  const account = useChat((s) => s.account);
  const closeSettings = useChat((s) => s.closeSettings);
  const error = useChat((s) => s.error);

  return (
    <div className={MAIN_COL}>
      <header className={HEADER}>
        <SidebarNub />
        <SettingsTitle id="account" />
      </header>
      <section className={SETTINGS_BODY}>
        {account.signedIn ? (
          <>
            {/* 显示即编辑:名字和头像就地可改,和首登引导共用同一张表单
                (components/ProfileCard.tsx → ProfileEditor.tsx) */}
            <ProfileCard />
          </>
        ) : (
          /* 未登录时这一屏只有一张登录卡,水平垂直都居中:
             flex-1 吃掉 SETTINGS_BODY(flex-col)的剩余高度,再在其中定心 */
          <div className="flex flex-1 items-center justify-center">
            <SignInCard />
          </div>
        )}
        {/* 会话热力图。放这一页而不是新会话屏:它是"我用了多久"这类统计,
            和额度卡是同一类东西;而新会话屏的正事是开始干活,一张半年统计摆在
            输入框底下只是让人多看一眼。只在登录后画 —— 数据虽是本机日志,
            但未登录时这一屏的正事是登录,一张半年统计只会把登录卡挤成配角 */}
        {account.signedIn && <SessionActivity workspace={null} className="max-w-none" />}
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
        <SettingsTitle id="keys" />
      </header>
      <section className={SETTINGS_BODY}>
        <BillingSettings />
        <ModelProviderSettings />
        {error && <p className={ERR_TXT}>{error}</p>}
      </section>
    </div>
  );
}

/** 外观页（设置栏目之一）：主题 + 灵动岛显示内容。
    分段控件而不是下拉框——选项全部可见时，"选哪个"和"现在是哪个"是同一眼的事 */
function AppearancePage() {
  const closeSettings = useChat((s) => s.closeSettings);
  const [themePref, setThemePref] = useState<ThemePref>(() => themeController().pref());
  // 灵动岛设置(#199)。null = 还没从主进程读回来(控件禁用,同 AutoCompactSettings
  // 的 loaded 模式);set 一点就落盘——低频离散动作,主进程 set 完立刻重推岛快照
  const [islandDisplay, setIslandDisplay] = useState<IslandDisplay | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.otter
      .getIslandSettings()
      .then((s) => {
        if (!cancelled) setIslandDisplay(s.display);
      })
      .catch(() => {
        /* 读不到就保持禁用——非 mac 或桥出错,控件灰着比假装能切要诚实 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const OPTIONS: { value: ThemePref; label: string; hint: string }[] = [
    { value: "light", label: "浅色", hint: "始终用浅色底盘" },
    { value: "dark", label: "深色", hint: "始终用深色底盘" },
    { value: "system", label: "跟随系统", hint: "跟着 macOS 的外观设置走" },
  ];

  // 动效(#607)。null = 还没读回来(同 islandDisplay 的 loaded 模式)。
  // set 完主进程当场挂/撤覆盖,不用重启,所以这里不需要"存了但还没生效"那一档
  const [motion, setMotion] = useState<MotionSettings | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.otter
      .getMotionSettings()
      .then((m) => {
        if (!cancelled) setMotion(m);
      })
      .catch(() => {
        /* 读不到就保持禁用——灰着比假装能切要诚实 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const MOTION_OPTIONS: { value: MotionPref; label: string; hint: string }[] = [
    { value: "system", label: "跟随系统", hint: "系统开了「减弱动效」就跟着停——Windows 的「动画效果」默认在不少机器上是关的" },
    { value: "always", label: "始终开启", hint: "无视系统的「减弱动效」,球会转、高光会扫、卡片会滑" },
  ];

  const ISLAND_OPTIONS: { value: IslandDisplay; label: string; hint: string }[] = [
    { value: "sessions", label: "会话列表", hint: "展开时显示各会话状态,点选切换、当场审批" },
    { value: "usage", label: "Token 用量", hint: "展开时显示各模型 今天/7天/14天 的 token 消耗" },
  ];

  return (
    <div className={MAIN_COL}>
      <header className={HEADER}>
        <SidebarNub />
        <SettingsTitle id="appearance" />
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
        <div className="flex flex-col gap-[6px]">
          <h2 className="px-1 text-[11px] tracking-[0.06em] text-muted-foreground uppercase">动效</h2>
          <div
            role="radiogroup"
            aria-label="动效"
            className="inline-flex gap-1 rounded-[10px] border border-border bg-card p-1"
          >
            {MOTION_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={motion?.pref === o.value}
                disabled={motion === null}
                title={o.hint}
                className={`press-scale flex-1 rounded-[7px] px-4 py-[6px] text-[13px] transition-colors duration-150 disabled:opacity-50 ${
                  motion?.pref === o.value
                    ? "bg-foreground/[0.10] font-[550] text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => {
                  if (!motion) return;
                  setMotion({ pref: o.value });
                  void window.otter.setMotionSettings({ pref: o.value });
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
          <p className={HINT}>
            {motion === null
              ? "系统开了「减弱动效」时,整个界面(包括跑 turn 时那颗球)都会停住"
              : MOTION_OPTIONS.find((o) => o.value === motion.pref)?.hint}
          </p>
        </div>
        <div className="flex flex-col gap-[6px]">
          <h2 className="px-1 text-[11px] tracking-[0.06em] text-muted-foreground uppercase">灵动岛</h2>
          <div
            role="radiogroup"
            aria-label="灵动岛显示内容"
            className="inline-flex gap-1 rounded-[10px] border border-border bg-card p-1"
          >
            {ISLAND_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={islandDisplay === o.value}
                disabled={islandDisplay === null}
                title={o.hint}
                className={`press-scale flex-1 rounded-[7px] px-4 py-[6px] text-[13px] transition-colors duration-150 disabled:opacity-50 ${
                  islandDisplay === o.value
                    ? "bg-foreground/[0.10] font-[550] text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => {
                  setIslandDisplay(o.value);
                  void window.otter.setIslandSettings({ display: o.value });
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
          <p className={HINT}>
            {islandDisplay === null
              ? "刘海展开时显示的内容(仅 macOS)"
              : ISLAND_OPTIONS.find((o) => o.value === islandDisplay)?.hint}
          </p>
        </div>
      </section>
    </div>
  );
}

/** skill 库页（设置栏目之一）：本机已安装 skill 的清单（磁盘扫描的投影，零持久化）。
    只认 ~/.mr-otto/skills——别家 agent 的安装位不再静默混入，走「导入 skill」弹窗
    复制进来。手动安装/卸载 = 在根目录里增删 <名字>/SKILL.md 文件夹 */
function SkillsPage() {
  const skills = useChat((s) => s.skills);
  const closeSettings = useChat((s) => s.closeSettings);

  return (
    <div className={MAIN_COL}>
      <header className={HEADER}>
        <SidebarNub />
        <SettingsTitle id="skills" />
      </header>
      <section className={SETTINGS_BODY}>
        <SkillImportDialog />
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
    白屏是大事。
    两屏各存一份：同一个工程在会话列表里收着、在归档区展开着是两件独立的事，
    共用一个键会让人在这屏收一下、那屏跟着没了 */
const COLLAPSED_KEY = "otter-sidebar-collapsed-projects";
const ARCHIVED_COLLAPSED_KEY = "otter-sidebar-collapsed-archived";
/** 归档区「没有工程记录」那段的折叠键。真路径都以 / 开头，撞不上 */
const NO_WORKSPACE_KEY = "\u0000no-workspace";

function loadCollapsedProjects(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function saveCollapsedProjects(key: string, dirs: Set<string>): void {
  localStorage.setItem(key, JSON.stringify([...dirs]));
}

/** 归档区的一组：会话列表那套折叠组的精简版——同样的箭头/标题/收起才报数,
    去掉了「在此工程下开新会话」的 +（归档区是翻旧账的地方,不是开工的地方） */
function ArchivedGroup({
  groupKey,
  label,
  title,
  count,
  collapsed,
  onToggle,
  children,
}: {
  groupKey: string;
  label: string;
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: (key: string) => void;
  children: ReactNode;
}) {
  return (
    <SidebarGroup className="py-1">
      <SidebarGroupLabel asChild>
        <button
          className="w-full gap-1 pr-2 hover:text-sidebar-foreground"
          onClick={() => onToggle(groupKey)}
          title={title}
        >
          <ChevronRight
            className={`w-[13px] h-[13px] shrink-0 transition-transform duration-150 ease-out ${collapsed ? "" : "rotate-90"}`}
          />
          <span className="min-w-0 truncate">{label}</span>
          {collapsed && <span className="shrink-0 font-mono text-[10px] opacity-70">{count}</span>}
        </button>
      </SidebarGroupLabel>
      {!collapsed && (
        <SidebarGroupContent>
          {/* 竖脊 + 缩进:和会话列表同一条视觉线索——这些行挂在上面那个标题下 */}
          <SidebarMenu className="border-l border-sidebar-border ml-[11px] w-[calc(100%-11px)] pl-[6px]">
            {children}
          </SidebarMenu>
        </SidebarGroupContent>
      )}
    </SidebarGroup>
  );
}

/** 左侧常驻侧栏（shadcn Sidebar,offcanvas）：会话列表（设置模式下换成栏目导航）
    + 底部设置/登录槽。handler 与原自制版一字不动,只换结构壳（spec 修订 2026-08-18） */
/** 会话名右侧那串「同步给谁了」的小头像（issue #809）。
    session_shared 只记**分享那一刻**的显示名不记 uid（events.ts 的取舍——日志是
    历史记录），所以头像按名字对当前好友表匹配，是尽力而为：好友改了名就退回
    首字母圆点。最多画 3 枚，多的折成 +N；全名单在 title 里 */
function SharedAvatars({ names }: { names: readonly string[] }) {
  const friends = useChat((s) => s.friendsSnapshot.friends);
  if (names.length === 0) return null;
  return (
    <span
      className="flex shrink-0 items-center -space-x-[5px]"
      title={`已同步给 ${names.join("、")}`}
    >
      {names.slice(0, 3).map((n) => {
        const url = friends.find((f) => f.profile.name === n)?.profile.avatarUrl;
        return (
          <Avatar key={n} className="size-4 border border-sidebar">
            {url ? <AvatarImage src={url} alt={n} /> : null}
            <AvatarFallback className="text-[9px]">{n.slice(0, 1)}</AvatarFallback>
          </Avatar>
        );
      })}
      {names.length > 3 && (
        <span className="pl-[7px] font-mono text-[10px] text-muted-foreground">+{names.length - 3}</span>
      )}
    </span>
  );
}

function AppSidebar() {
  const sessions = useChat((s) => s.sessions);
  const asks = useChat((s) => s.asks);
  const sessionId = useChat((s) => s.sessionId);
  const phase = useChat((s) => s.phase);
  const settingsSection = useChat((s) => s.settingsSection);
  const resume = useChat((s) => s.resume);
  const newSession = useChat((s) => s.newSession);
  const setSessionSearchOpen = useChat((s) => s.setSessionSearchOpen);
  const openSettings = useChat((s) => s.openSettings);
  const closeSettings = useChat((s) => s.closeSettings);
  // 齿轮角标点:更新待装时亮(pill 是主入口,这颗点管的是 pill 被无视之后——
  // 设置里「关于与更新」还有一条路)
  const updatePending = useChat(
    (s) => s.updater !== null && (s.updater.phase === "ready" || s.updater.phase === "manual"),
  );
  const deleteSession = useChat((s) => s.deleteSession);
  const archiveSession = useChat((s) => s.archiveSession);
  const unarchiveSession = useChat((s) => s.unarchiveSession);
  const renameSessionById = useChat((s) => s.renameSessionById);
  const statusBySession = useChat((s) => s.statusBySession);
  const approvals = useChat((s) => s.approvals);
  const account = useChat((s) => s.account);
  // 侧栏那一行显示的是"好友看到的我",所以以 profiles 为准而不是 auth.users(ADR-0028)
  const myProfile = useChat((s) => s.myProfile);
  const identity = displayIdentity(account, myProfile);
  /** 右侧槽位现在开着哪块(null = 空着)。会话行的"我在聊天视图"就是这个判据——
      原来那串手抄的 !aOpen && !bOpen 漏了 filesPanelOpen,开着文件面板时侧栏
      仍然把那条会话画成"正在看" */
  const openPanel = useChat(panelKeyOf);
  const friendChat = useChat((s) => s.friendChat);
  const unreadByFriend = useChat((s) => s.unreadByFriend);
  const friendsSnapshot = useChat((s) => s.friendsSnapshot);
  // 好友区显隐:侧栏常驻版收进 footer 的 icon(齿轮左边),点开弹 Drawer(vaul)。
  // 纯 UI 偏好,不进事件日志(同 collapsed 组折叠的待遇)。放 store 不放本地 state,
  // 是因为点系统通知要能把它掀开(store.onNotificationActivated)
  const friendsOpen = useChat((s) => s.friendsPanelOpen);
  const setFriendsOpen = useChat((s) => s.setFriendsPanelOpen);
  // 工作区区显隐:同好友区一样收进 footer 的 icon、点开弹 Drawer(ADR-0198 切片 3,
  // issue #811)。没有系统通知会掀开它这回事,纯本地 state 就够,不用像 friendsOpen
  // 那样搬进 store
  const [workspacesOpen, setWorkspacesOpen] = useState(false);
  // 窗口模式(mac + 非全屏)下红绿灯叠在侧栏左上角,logo 得让位;全屏红绿灯隐掉,logo 回来
  const fullscreen = useChat((s) => s.fullscreen);
  const trafficInset = IS_MAC && !fullscreen;

  // icon 角标 = 好友区"有事"的总和:未读 DM + 待处理请求。区收着也能被看见
  const friendActivity =
    Object.values(unreadByFriend).reduce((a, b) => a + b, 0) +
    friendsSnapshot.incoming.length;
  // 抽屉是模态层,盖在主区上;点开 DM 面板时弹窗让位——不然 DM 被抽屉挡住看不见
  useEffect(() => {
    if (friendChat) setFriendsOpen(false);
  }, [friendChat]);

  // 任务/项目切换器（60e0479 那颗 Work/Game 分段控件的还魂，位置照旧）：
  // 任务 = 内置 Default 工作区的会话——新手不用先懂「文件夹」就能开聊；
  // 项目 = 其余工程的分组视图。语义钉在内置路径上（builtinWorkspace，与设置里
  // 改没改默认无关）：钉在「当前默认」上的话，用户一改默认，整批会话就在
  // 两栏之间跳来跳去。档位在 store 里(Welcome 要按它锁 Default),不落日志
  const workspaceSettings = useChat((s) => s.workspaceSettings);
  const loadWorkspaceSettings = useChat((s) => s.loadWorkspaceSettings);
  useEffect(() => {
    void loadWorkspaceSettings();
  }, [loadWorkspaceSettings]);
  const builtin = workspaceSettings?.builtinWorkspace ?? null;
  const tab = useChat((s) => s.sidebarTab);
  const setTab = useChat((s) => s.setSidebarTab);
  // 初值只定一次：库里已有项目会话的老用户落「项目」，全新用户落「任务」。
  // 之后完全听点击——别在用户切走后又被数据变化拽回来
  const tabDecided = useRef(false);
  useEffect(() => {
    if (tabDecided.current || !builtin || sessions.length === 0) return;
    tabDecided.current = true;
    if (sessions.some((s) => !s.archived && s.workspace !== null && s.workspace !== builtin)) {
      setTab("projects");
    }
  }, [sessions, builtin, setTab]);
  // 没记 workspace 的史前会话（schema 长出 workspace 之前的日志）无法重建围栏，
  // 不可恢复——但事实不该被藏：藏 = 用户看不见也删不掉的库存垃圾。
  // 灰显示人 + 开放删除，点击不响应（能力问题诚实呈现，不是数据问题）
  const prehistoric = sessions.filter((s) => s.workspace === null && !s.archived);
  // 用户归档的会话（ADR-0087）：不进工程组，走「已归档会话」这个独立视图，可恢复。
  // 归档区自己也按工程分组：这一屏和会话列表是同一批东西的两个状态，
  // 平铺的话「哪个工程的」这条线索在归档那一刻就断了，攒多了只能靠标题猜。
  // 归档也分栏(#559 后续)：任务栏只看 Default 的旧账、项目栏只看工程的——
  // 两栏各自的「已归档」计数和列表互不掺和
  const archivedTask = useMemo(() => archivedTaskSessions(sessions, builtin), [sessions, builtin]);
  const archived = useMemo(
    () => groupArchivedByWorkspace(sessions.filter((s) => s.workspace !== builtin)),
    [sessions, builtin]
  );
  const archivedCount =
    tab === "tasks"
      ? archivedTask.length
      : archived.groups.reduce((n, g) => n + g.sessions.length, 0) + archived.ungrouped.length;
  // 归档行：分组区和"没有工程记录"那段共用同一份行，行为完全一致——
  // 点击只是翻历史（不自动恢复归档），⋮ 里放恢复和删除
  const archivedRow = (s: SessionSummary, groupLabel: string | null) => (
    <SidebarMenuItem key={s.sessionId}>
      <SidebarMenuButton
        className="h-auto flex-row items-center gap-2 py-[7px] opacity-70"
        onClick={() => void resume(s.sessionId)}
        title="查看历史（不会自动恢复归档）"
      >
        <span className={cn(TITLE_SPAN, "min-w-0 flex-1")}>
          {s.title ?? groupLabel ?? s.sessionId}
        </span>
      </SidebarMenuButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction showOnHover title="会话操作" onClick={(e) => e.stopPropagation()}>
            <Ellipsis />
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem onClick={() => void unarchiveSession(s.sessionId)}>
            恢复归档
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => {
              if (confirm(`彻底删除会话 ${s.sessionId}？\n整段事件日志将从数据库抹除，不可恢复。`)) {
                void deleteSession(s.sessionId);
              }
            }}
          >
            删除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
  /** 会话行:任务平铺列表和项目分组视图共用同一副行（球+标题+⋮ 菜单），
      长得不一样就像两种东西——其实都是会话。fallbackLabel = 还没发话时的标题
      （项目视图给文件夹名，任务视图给「任务」） */
  const sessionRow = (s: SessionSummary, fallbackLabel: string) => (
    <SidebarMenuItem key={s.sessionId}>
      <SidebarMenuButton
        className="h-auto flex-row items-center gap-2 py-[7px]"
        isActive={phase === "chat" && settingsSection === null && openPanel === null && !friendChat && s.sessionId === sessionId}
        onClick={() => void resume(s.sessionId)}
      >
        {/* 后台会话的动静收进这颗球:等你 > 在跑 > 闲着(lib/sessionOrb)。
            原来那行「日期 · 条数 运行中」里,只有最后两个字会改变你的
            下一步动作,前两样不会 —— 所以留状态、去掉日期和条数 */}
        <SessionOrb
          state={orbState({
            waiting: Boolean(approvals[s.sessionId] ?? asks[s.sessionId]),
            running: statusBySession[s.sessionId] === "running",
          })}
        />
        {/* 标题 = 第一条 user_message 首行（日志投影）；还没发话的会话退回 fallback */}
        <span className={cn(TITLE_SPAN, "min-w-0 flex-1")}>
          {s.title ?? fallbackLabel}
        </span>
        {/* 独立副本（ADR-0157）：组头只说「哪个项目」，副本身份下沉到行（#692，同岛的
            ADR-0172）。只是一个记号，不写分支名——日志里那条会陈旧（ADR-0158） */}
        {s.projectRoot !== null && (
          <GitBranch className="w-3 h-3 shrink-0 text-muted-foreground/70" aria-label="独立副本" />
        )}
        {/* 同步给谁了（issue #809）：只有分享过的会话才有这串，本地会话零占位 */}
        <SharedAvatars names={s.sharedWith} />
      </SidebarMenuButton>
      {/* ✕ 直删换成 ⋮ 菜单（ADR-0087）：删除旁边有了"归档"这条
          后悔药,菜单让两种语义并排可辨——归档可逆不设闸,
          删除不可逆才弹 confirm */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction
            showOnHover
            title="会话操作"
            onClick={(e) => e.stopPropagation() /* 别触发外层的"切换到该会话" */}
          >
            <Ellipsis />
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem
            onClick={() => setRenaming({ sessionId: s.sessionId, title: s.title ?? fallbackLabel })}
          >
            重命名
          </DropdownMenuItem>
          {/* 归到…（#846）：只有任务栏（内置 Default 工作区）的会话才有主题桶这个概念 */}
          {s.workspace === builtin && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>归到…</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={s.topic ?? "__none"}
                  onValueChange={(v) => void window.otter.setSessionTopic(s.sessionId, v === "__none" ? null : v)}
                >
                  {topicSlugs.map((slug) => (
                    <DropdownMenuRadioItem key={slug} value={slug}>{labelOf(slug)}</DropdownMenuRadioItem>
                  ))}
                  <DropdownMenuRadioItem value="__none">未分类</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          <DropdownMenuItem
            disabled={statusBySession[s.sessionId] === "running"}
            onClick={() => void archiveSession(s.sessionId)}
          >
            归档
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => {
              if (confirm(`彻底删除会话 ${fallbackLabel} · ${s.sessionId}？\n整段事件日志将从数据库抹除，不可恢复。`)) {
                void deleteSession(s.sessionId);
              }
            }}
          >
            删除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
  // 已归档是侧栏的一个**视图**，不是列表底部的一截折叠区（ADR-0089）：
  // 归档的会话越攒越多时，折叠区在长列表最底下，等于藏在滚动条尽头；
  // 换成和设置模式同一套互斥逻辑——整个侧栏切过去，带一条返回的路。
  // 纯 UI 位置，不进事件日志，也不必跨会话记忆：切走再回来该回到会话列表
  const [archivedView, setArchivedView] = useState(false);
  // 重命名走应用内对话框：Electron 的 window.prompt 是**抛异常**的
  // （"prompt() is not supported."），原来那句 prompt() 让整条 onClick 半路夭折，
  // 点「重命名」什么都不发生。alert/confirm 在 Electron 里能用，prompt 不能
  const [renaming, setRenaming] = useState<{ sessionId: string; title: string } | null>(null);
  // 进设置就退出归档视图：两者抢同一块地皮，回来时该落在会话列表上
  useEffect(() => {
    if (settingsSection !== null) setArchivedView(false);
  }, [settingsSection]);
  // 任务平铺列表：sessions 本来就是最近活跃在前,不再分组。
  // 同步（分享）过的会话抽出来单列一段（issue #809）——分享之后「对面还有一份」，
  // 和纯本地会话不再是同一种东西，混在一摞里这条身份就看不见了
  const taskParts = useMemo(() => partitionShared(taskSessions(sessions, builtin)), [sessions, builtin]);
  // 主题分组（#846）：标签优先取用户改过的自定义 label,种子表兜底,再兜底 slug 本身
  const [topicLabels, setTopicLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    void window.otter.listTopicMemories().then((ts) => setTopicLabels(Object.fromEntries(ts.map((t) => [t.slug, t.label]))));
  }, [sessions]); // 会话列表变了（含主题事件刷新）顺手刷一次标签；量小，不值得单独订阅
  const labelOf = (slug: string) => topicLabels[slug] ?? SEED_TOPICS[slug] ?? slug;
  const topicSlugs = useMemo(() => withSeedTopics(Object.keys(topicLabels)), [topicLabels]);
  // known 桶集合：桶被删了的会话回未分类而不是画出一个死链组（spec §3）
  const knownTopics = useMemo(() => new Set(topicSlugs), [topicSlugs]);
  const taskGroups = useMemo(
    () => groupTasksByTopic(taskParts.local, labelOf, knownTopics),
    [taskParts, topicLabels, knownTopics]
  );
  // 可恢复的按工程文件夹分组：平铺流里同一工程被别的工程插花，工程一多就找不着。
  // 内置 Default 的会话归任务栏,不在这儿再出现一组。
  // 项目栏同样先把同步过的抽走：分区那段平铺（分享的单位是会话不是工程），
  // 剩下的照旧按工程分组
  const projectParts = useMemo(
    () =>
      partitionShared(
        sessions.filter(
          (s) => !s.archived && s.spawnedFrom === null && s.workspace !== null && s.workspace !== builtin
        )
      ),
    [sessions, builtin]
  );
  const groups = useMemo(() => groupSessionsByWorkspace(projectParts.local), [projectParts]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsedProjects(COLLAPSED_KEY));
  const [archivedCollapsed, setArchivedCollapsed] = useState<Set<string>>(() =>
    loadCollapsedProjects(ARCHIVED_COLLAPSED_KEY)
  );
  /** 收/放一组。两屏各自的 Set + 各自的存储键，互不影响 */
  const makeToggle =
    (setter: typeof setCollapsed, key: string) =>
    (dir: string) =>
      setter((prev) => {
        const next = new Set(prev);
        if (!next.delete(dir)) next.add(dir);
        saveCollapsedProjects(key, next);
        return next;
      });
  const toggleGroup = makeToggle(setCollapsed, COLLAPSED_KEY);
  const toggleArchivedGroup = makeToggle(setArchivedCollapsed, ARCHIVED_COLLAPSED_KEY);

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className={cn("drag-region relative", trafficInset && "pt-1")}>
        <div
          className={cn(
            "pr-2 pb-[6px] font-[650] flex items-center gap-2",
            // 行首是 fixed 开关钮(SidebarToggle)的占位:钮本身不在这棵树里,
            // 展开/收起两态同一坐标。窗口模式 x=82(红绿灯右侧留一段空当),全屏 x=12
            trafficInset ? "pl-[74px]" : "pt-1 pl-1"
          )}
        >
          <SidebarTriggerSlot />
          {/* logo 原图白底方图:圆角裁成小图标块,暗色界面里当 app icon 看。
              窗口模式下红绿灯叠在左上角,logo + 标题都让位(全屏红绿灯被 macOS 隐掉才回来) */}
          {!trafficInset && (
            <>
              <img className="w-[22px] h-[22px] rounded-md" src={ottoLogo} alt="" />
              Mr Otto
            </>
          )}
          {/* 搜索挪到顶行、收起钮左边:它是"去别的会话"的路口,和下面那一长串
              会话列表是同一件事的两个入口 —— 站在列表顶上比夹在按钮堆里好找。
              只留图标:这一行的宽度归标题,而 ⌘K 的人不看字,不知道有这功能的人
              看见放大镜就够了(悬停有全称和快捷键) */}
          {/* 搜索钮:窗口模式下和红绿灯、开关钮排成一行(绝对定位到开关右侧,
              top 与 SidebarToggle 同值(TOGGLE_TOP));全屏没有红绿灯,照旧靠右 */}
          <div className={cn("flex shrink-0 items-center", trafficInset ? `absolute ${TOGGLE_TOP} ${SEARCH_LEFT}` : "ml-auto")}>
            {settingsSection === null && (
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:bg-foreground/[0.06]"
                title="搜索会话（⌘K）"
                aria-label="搜索会话"
                onClick={() => setSessionSearchOpen(true)}
              >
                <Search className="size-4" aria-hidden />
              </Button>
            )}
          </div>
        </div>
        {/* ＋ 只是导航去 composer 视图：文件夹/偏好在那里配齐才建会话。
            设置模式下侧栏不是会话导航，这颗按钮没有落点，隐掉 */}
        {settingsSection === null && (
          <>
            {/* 任务/项目档位（原 Work/Game 的位置与实现套路,60e0479）：它切的是
                整个会话列表在展示什么,属于导航。面板不在这棵树里,Root 只当分段
                控件用——把 Root 提出去罩住两边会让 shadcn sidebar 的 peer 兄弟
                选择器算错宽度(主区不被推开);代价是 trigger 的 aria-controls
                指向一个不存在的 panel id */}
            <Tabs value={tab} onValueChange={(v) => setTab(v as "tasks" | "projects")}>
              <TabsList className="w-full">
                {/* 图标沿用两栏各自的既有语汇:任务清单面板用的就是 ListChecks,
                    工程分组/设置「工作区」用的是 FolderOpen——同一个概念一张脸 */}
                <TabsTrigger value="tasks">
                  <ListChecks aria-hidden />
                  任务
                </TabsTrigger>
                <TabsTrigger value="projects">
                  <FolderOpen aria-hidden />
                  项目
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Button
              variant="ghost"
              className="justify-start px-3 py-[7px] text-[13px] border border-border hover:bg-foreground/[0.06]"
              onClick={() => {
                setArchivedView(false); // 开新会话就是回到干活那一屏,别把人留在归档里
                // 任务档的新会话直接落进内置 Default(不用选文件夹);
                // 项目档保持空白开局,文件夹在 composer 里配
                newSession(tab === "tasks" && builtin ? builtin : undefined);
              }}
            >
              ＋ 新会话
            </Button>
            {/* 已归档入口。次级:不描边、字色压一档 —— 它和上面那颗不是并列的两件事,
                上面是"开始干活",这里是"去翻旧账"。再点一次原路返回,省一次找返回钮 */}
            <Button
              variant="ghost"
              aria-pressed={archivedView}
              className={cn(
                "justify-start gap-2 px-3 py-[6px] text-[13px] font-normal text-muted-foreground hover:bg-foreground/[0.06] hover:text-sidebar-foreground",
                archivedView && "bg-foreground/[0.06] text-sidebar-foreground"
              )}
              onClick={() => setArchivedView((v) => !v)}
            >
              <Archive className="size-4 shrink-0" aria-hidden />
              已归档会话
              {archivedCount > 0 && (
                <span className="ml-auto shrink-0 font-mono text-[10px] opacity-70">
                  {archivedCount}
                </span>
              )}
            </Button>
          </>
        )}
      </SidebarHeader>
      <SidebarContent>
        {settingsSection !== null ? (
          // 设置模式：会话列表让位给栏目导航（同一块地皮，互斥展示）。
          // 会话那边包在 SidebarGroup(p-2)里,这边裸 SidebarMenu 得自己补同样的边距
          <SidebarMenu className="p-2">
            {/* 和主侧栏的「＋ 新会话」同一副模样(四边描边的长钮):两者都是
                "离开当前列表去别处"的主入口,该长得一样。主区头部不再放返回钮,
                这颗是设置模式唯一的出口 */}
            <SidebarMenuItem className="mb-2">
              <Button
                variant="ghost"
                className="w-full justify-start px-3 py-[7px] text-[13px] border border-border hover:bg-foreground/[0.06]"
                onClick={closeSettings}
              >
                <ArrowLeft className="size-3.5" />
                返回会话
              </Button>
            </SidebarMenuItem>
            {SETTINGS_SECTIONS.map((sec) => (
              <SidebarMenuItem key={sec.id}>
                <SidebarMenuButton
                  isActive={settingsSection === sec.id}
                  onClick={() => void openSettings(sec.id)}
                >
                  <sec.icon className="size-4 text-muted-foreground" />
                  <span className={TITLE_SPAN}>{sec.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        ) : archivedView ? (
          // 已归档视图（ADR-0089，取代 ADR-0087 那截底部折叠区）：整个侧栏切过去。
          // 行点击只是看历史，不自动恢复——归档是用户的判断，不该被"点一下"推翻
          <>
            <SidebarMenu className="p-2 pb-0">
              <SidebarMenuItem>
                <button
                  className="flex w-full items-center gap-[6px] px-1 py-[6px] text-[13px] text-muted-foreground hover:text-sidebar-foreground"
                  onClick={() => setArchivedView(false)}
                >
                  <ArrowLeft className="size-4 shrink-0" aria-hidden />
                  返回会话列表
                </button>
              </SidebarMenuItem>
            </SidebarMenu>
            {archivedCount === 0 ? (
              // 空态照直说：入口常驻(不随条数显隐),那这一屏就得自己交代"空"这件事
              <div className="px-[10px] py-3 text-[12px] text-muted-foreground">
                还没有归档的会话。会话行的 ⋮ 菜单里有「归档」。
              </div>
            ) : tab === "tasks" ? (
              // 任务栏的归档:只看 Default 的旧账,平铺(#559 后续)——
              // 和任务列表同一个道理,这一栏不谈"工程"
              <SidebarMenu className="p-2 pt-0">
                {archivedTask.map((s) => archivedRow(s, "任务"))}
              </SidebarMenu>
            ) : (
              <>
                {/* 和会话列表同一套分组骨架(可收放的工程名 + 竖脊缩进)：归档区是同一批
                    东西的另一个状态,平铺就把"哪个工程的"这条线索弄丢了;
                    收放也照抄——归档攒多了,一屏全展开同样翻不动。
                    折叠状态另存一个键:两屏的收放互不牵连 */}
                {archived.groups.map((g) => (
                  <ArchivedGroup
                    key={g.workspace}
                    groupKey={g.workspace}
                    label={g.label}
                    title={g.workspace}
                    count={g.sessions.length}
                    collapsed={archivedCollapsed.has(g.workspace)}
                    onToggle={toggleArchivedGroup}
                  >
                    {g.sessions.map((s) => archivedRow(s, g.label))}
                  </ArchivedGroup>
                ))}
                {archived.ungrouped.length > 0 && (
                  // 史前归档会话：日志里没记 workspace,归不进任何工程。
                  // 不塞进"未知"组也不藏起来,单列一段照直说(同侧栏底部那摞)
                  <ArchivedGroup
                    groupKey={NO_WORKSPACE_KEY}
                    label="没有工程记录"
                    title="日志里没记工程文件夹，归不到任何工程下"
                    count={archived.ungrouped.length}
                    collapsed={archivedCollapsed.has(NO_WORKSPACE_KEY)}
                    onToggle={toggleArchivedGroup}
                  >
                    {archived.ungrouped.map((s) => archivedRow(s, null))}
                  </ArchivedGroup>
                )}
              </>
            )}
          </>
        ) : tab === "tasks" ? (
          // 任务视图：内置 Default 工作区的会话，不出现路径——这一栏的全部意义
          // 就是不用先懂「文件夹」。按主题桶分组（#846），组内仍是最近活跃在前。
          // 同步过的单列一段在上（issue #809）；一条都没分享过时不出段头，
          // 列表长相和从前一模一样——分区是给用过分享的人的，不是给所有人的税
          <SidebarMenu className="p-2">
            {taskParts.shared.length > 0 && (
              <>
                <div className={SECTION_HEADING}>已同步</div>
                {taskParts.shared.map((s) => sessionRow(s, "任务"))}
                <div className={SECTION_HEADING}>本地</div>
              </>
            )}
            {taskGroups.map((g) => (
              <Fragment key={g.topic ?? "__none"}>
                {/* 只有一组且是未分类时不画组头：从没分类过的人看到的列表和从前一模一样 */}
                {!(taskGroups.length === 1 && g.topic === null) && <div className={SECTION_HEADING}>{g.label}</div>}
                {g.sessions.map((s) => sessionRow(s, "任务"))}
              </Fragment>
            ))}
          </SidebarMenu>
        ) : (
          <>
            {/* 同步过的会话单列一段在最上（issue #809）：分享的单位是会话不是工程，
                平铺；行的 fallback 标题给它原属工程的文件夹名，线索不断 */}
            {projectParts.shared.length > 0 && (
              <SidebarGroup className="py-1">
                <SidebarGroupLabel>已同步</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {projectParts.shared.map((s) =>
                      sessionRow(s, s.workspace ? folderName(s.workspace) : "会话")
                    )}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )}
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
                  {/* g.workspace 是项目根而不是某只水獭的副本目录（projectOf）：
                      新会话从项目根起、由主进程再开一份自己的副本 */}
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
                        {g.sessions.map((s) => sessionRow(s, g.label))}
                      </SidebarMenu>
                    </SidebarGroupContent>
                  )}
                </SidebarGroup>
              );
            })}
            {groups.length === 0 && projectParts.shared.length === 0 && (
              // 新手第一次切过来的空态:顺手把「项目是什么」讲了
              <div className="px-[10px] py-2 text-xs text-muted-foreground leading-relaxed">
                还没有项目。项目就是在你自己指定的文件夹里开的会话——
                点「＋ 新会话」，在输入框上方选一个文件夹就有了。
              </div>
            )}
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
        {/* OTA 更新卡片（ADR-0075，设计改版 issue #362）:available/downloading/ready/manual 才出现 */}
        <UpdatePill />
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
                <AccountAvatar name={identity.name} avatarUrl={identity.avatarUrl} sizeCls="size-5" textCls="text-[11px]" />
                <span className="flex-1 min-w-0 truncate">{identity.name}</span>
              </>
            ) : (
              <>
                {/* 未登录也占同一个头像槽：登录前后这一行的左起点不跳 */}
                <span className="w-5 h-5 rounded-full shrink-0 bg-accent inline-flex items-center justify-center">
                  <UserRound className="w-[12px] h-[12px]" />
                </span>
                <span className="flex-1 min-w-0 truncate">未登录 · 点击登录</span>
              </>
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
          {/* 工作区 icon:同好友区一样的抽屉入口(ADR-0198 切片 3,issue #811)。
              和好友之间不共用一个开关——两块内容独立,同时开着也各自有各自的 Drawer */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className={
                  "relative shrink-0 flex items-center justify-center px-2 py-[6px] text-[13px] bg-transparent hover:text-foreground " +
                  (workspacesOpen ? "text-foreground bg-foreground/[0.08]" : "text-muted-foreground")
                }
                aria-label="工作区"
                aria-pressed={workspacesOpen}
                onClick={() => setWorkspacesOpen(!workspacesOpen)}
              >
                <Boxes className="w-[14px] h-[14px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent>工作区</TooltipContent>
          </Tooltip>
          {/* 齿轮:纯图标按钮,颜色/hover 沿用 ghost 风 */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                // 纯图标按钮：Tooltip 只在悬停时才挂 aria-describedby，读屏和自动化
                // 平时看到的是一颗没有名字的按钮。aria-label 才是它的名字
                aria-label="设置"
                className="relative shrink-0 flex items-center justify-center px-2 py-[6px] text-[13px] text-muted-foreground bg-transparent hover:text-foreground"
                onClick={() => void openSettings(updatePending ? "about" : "keys")}
              >
                <GearIcon />
                {updatePending && (
                  <span
                    className="absolute top-0 right-[2px] w-[7px] h-[7px] rounded-full bg-brand"
                    aria-label="有可用更新"
                  />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent>设置</TooltipContent>
          </Tooltip>
        </div>
      </SidebarFooter>
      {/* 改标题的输入框。open 由 renaming 是不是 null 决定,关掉即丢草稿 */}
      <RenameSessionDialog
        target={renaming}
        onClose={() => setRenaming(null)}
        onSubmit={(title) => {
          if (renaming) void renameSessionById(renaming.sessionId, title);
          setRenaming(null);
        }}
      />
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
      {/* 工作区弹窗:同一件事的第二份(ADR-0198 切片 3,issue #811)。
          WorkspacesPanel 自己管"列表 or 详情页"这一层,这里只负责开/关抽屉本身 */}
      <Drawer open={workspacesOpen} onOpenChange={setWorkspacesOpen} direction="right" shouldScaleBackground={false}>
        <DrawerContent side="right" className="w-[min(380px,90vw)]">
          <DrawerHeader className="flex items-center justify-between gap-2 text-left px-4 py-3 border-b border-border">
            <DrawerTitle className="text-sm">工作区</DrawerTitle>
            <button
              className="text-muted-foreground hover:text-foreground bg-transparent px-1 rounded-md text-[13px]"
              aria-label="关闭工作区面板"
              onClick={() => setWorkspacesOpen(false)}
            >
              ✕
            </button>
          </DrawerHeader>
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-stable px-[6px] py-2">
            <SidebarProvider defaultOpen className="flex-col min-h-0">
              <WorkspacesPanel embedded />
            </SidebarProvider>
          </div>
        </DrawerContent>
      </Drawer>
    </Sidebar>
  );
}

/** 改会话标题的小对话框。Electron 里 window.prompt 直接抛
    "prompt() is not supported."，所以这类「要一行输入」的地方只能自己搭
    （alert/confirm 没这问题，删除那条 confirm 照旧）。
    target 换人时 key 跟着换，草稿重新从当前标题起头，不会串到上一个会话 */
function RenameSessionDialog({ target, onClose, onSubmit }: {
  target: { sessionId: string; title: string } | null;
  onClose: () => void;
  onSubmit: (title: string) => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md" key={target?.sessionId ?? "none"}>
        <DialogHeader>
          <DialogTitle className="text-sm">重命名会话</DialogTitle>
          <DialogDescription className="text-[12px]">
            只改侧栏显示的标题，不动这条会话的事件日志。
          </DialogDescription>
        </DialogHeader>
        {target && <RenameForm initial={target.title} onSubmit={onSubmit} onCancel={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

/** 单独拆一层是为了拿 initial 起头 state：写在上面那层的话，
    target 从 null 变成有值时 Dialog 已经挂着，useState 的初值吃不到新标题 */
function RenameForm({ initial, onSubmit, onCancel }: {
  initial: string;
  onSubmit: (title: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const trimmed = draft.trim();
  return (
    <form
      className="contents"
      onSubmit={(e) => {
        e.preventDefault();
        if (trimmed) onSubmit(trimmed);
      }}
    >
      <Input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="新标题"
        aria-label="新标题"
      />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>取消</Button>
        {/* 空标题不给提交:清空不是「改名」的一种,是把侧栏那行变成无名氏 */}
        <Button type="submit" disabled={!trimmed}>保存</Button>
      </DialogFooter>
    </form>
  );
}

/** 齿轮：侧栏底部设置入口图标（内联 SVG：currentColor 描边，不吃色板变量，
    跟着按钮的文字色走。文件夹那枚已经换成 material 的彩色图标，见 FileTypeIcon）。
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
        {value ? folderName(value) : "选择工作区"}
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
                <span className="shrink-0">{folderName(dir)}</span>
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
/** 这个会话在不在独立副本上（issue #643）。日志第 0 条说了算——与主进程同一个事实来源 */
function isolatedOf(events: SessionEvent[]): { projectRoot: string; branch: string } | null {
  const first = events[0];
  return first?.type === "session_created" && first.isolated ? first.isolated : null;
}

/** 头部那枚「独立副本」标记（issue #643，ADR-0159）。
    只是状态，不是控件：常驻、不动画、不抢注意力。用户真正需要知道的一句话
    （你的项目目录不会变）挂在 title 上——头部一行放不下，也不该放下。 */
function IsolatedChip({ events }: { events: SessionEvent[] }) {
  const iso = isolatedOf(events);
  if (!iso) return null;
  return (
    <>
      <span className="text-muted-foreground text-xs shrink-0">·</span>
      <span
        className="shrink-0 inline-flex items-center gap-1 rounded-full border border-border/60 px-1.5 py-px text-[11px] text-muted-foreground"
        title={`这只水獭在一份独立副本上干活，你的项目目录（${iso.projectRoot}）暂时不会变。合并请用右边的「更多」菜单。`}
      >
        <GitBranch className="w-3 h-3" />
        独立副本
      </span>
    </>
  );
}

/** 「合并回项目」菜单项（issue #643）。合到项目目录此刻所在的那条分支——
    不猜、不写死 main。四档失败各有一句人话，原样显示，不翻译成「失败了」。
    结果留在菜单里而不是弹窗：合并是用户主动发起的，他此刻正看着这儿 */
function IsolatedMergeItem({ events, disabled }: { events: SessionEvent[]; disabled: boolean }) {
  const iso = isolatedOf(events);
  const mergeIsolated = useChat((s) => s.mergeIsolated);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (!iso) return null;
  return (
    <>
      <DropdownMenuItem
        disabled={disabled || busy}
        onSelect={(e) => {
          e.preventDefault(); // 菜单别关：结果就显示在下面那行
          setBusy(true);
          setNote(null);
          void mergeIsolated()
            .then((r) => {
              if (!r) return setNote("没有可合并的会话");
              setNote(r.ok ? `已合并 ${r.branch} → ${r.into}` : r.detail);
            })
            .catch((err: unknown) => setNote(err instanceof Error ? err.message : String(err)))
            .finally(() => setBusy(false));
        }}
      >
        <GitBranch /> {busy ? "合并中…" : "合并回项目"}
      </DropdownMenuItem>
      {note && (
        <div className="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground max-w-[280px] whitespace-pre-wrap">
          {note}
        </div>
      )}
    </>
  );
}

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
        <SelectTrigger
          data-testid="branch-select"
          className={BAR_SELECT + " max-w-[180px]"}
          title={busy ? "切换中…" : "当前分支——可切换"}
        >
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
  const fullscreen = useChat((s) => s.fullscreen);
  // 侧栏工程分组的 ＋ 带过来的文件夹初值。Welcome 常驻不卸载，所以用 effect 跟着变，
  // 不用 key 重挂——重挂会连草稿一起清掉
  const pendingWorkspace = useChat((s) => s.pendingWorkspace);
  const [workspace, setWorkspace] = useState<string | null>(pendingWorkspace);
  useEffect(() => setWorkspace(pendingWorkspace), [pendingWorkspace]);
  const workspaceSettings = useChat((s) => s.workspaceSettings);
  const loadWorkspaceSettings = useChat((s) => s.loadWorkspaceSettings);
  useEffect(() => {
    void loadWorkspaceSettings();
  }, [loadWorkspaceSettings]);
  // 任务档锁死内置 Default(#559 后续):不出现文件夹/分支 UI,零决策开聊;
  // 项目档保持"自己选文件夹"——两档各是一条完整的路,不再互相兜底
  const taskMode = useChat((s) => s.sidebarTab) === "tasks";
  const effectiveWorkspace = taskMode
    ? (workspaceSettings?.builtinWorkspace ?? null)
    : workspace;
  const [text, setText] = useState("");
  // 招呼语只抽一次:Welcome 常驻不卸载,放进 render 体里的话每敲一个字都换一句话
  const myProfile = useChat((s) => s.myProfile);
  const account = useChat((s) => s.account);
  const [roll] = useState(() => Math.random());
  const greeting = pickGreeting(displayIdentity(account, myProfile).name, roll);
  const [model, setModel] = useState(() =>
    describeModel(lastModel) ? lastModel : DEFAULT_MODEL
  );
  // 新会话卡还没有日志可投影,lane 只能是本地草稿;落地时跟着 startSession 过去
  const [lane, setLane] = useState<ModelLane>("auto");
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
    if (!effectiveWorkspace || busy) return;
    setBusy(true);
    try {
      // 显式传全部偏好：下拉框显示什么就落地什么（宁多一条 model_changed，不让 UI 说谎）
      await startSession({ workspace: effectiveWorkspace, model, lane, approvalMode: mode, thinking });
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
    <div className="relative flex-1 min-w-0 h-full flex flex-col items-center justify-center gap-4">
      {/* 欢迎页没有头部可排,窗口模式下顶部这一条空地带接住拖拽(全屏不需要) */}
      {IS_MAC && !fullscreen && (
        <div className="drag-region absolute top-0 inset-x-0 h-7" aria-hidden />
      )}
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
        {/* 任务档整行文件夹 UI 都不出现:那一档统一 Default,零决策——
            出一排锁死的控件只会引人去点(#559 后续) */}
        {!taskMode && (
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
        )}
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
            lane={lane}
            onChange={(m, l) => {
              setModel(m);
              setLane(l);
            }}
            disabled={busy}
            // 同上:不封硬顶,写得下就写全(新会话卡这一行本来就宽)
            className={NSC_SELECT}
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
            idle={!effectiveWorkspace || busy}
            disabled={!effectiveWorkspace || busy}
            className="shrink-0 disabled:pointer-events-none"
            title={effectiveWorkspace ? "开始会话" : "先选工程文件夹"}
            aria-label="开始会话"
            onClick={() => void launch()}
          />
        </div>
      </ComposerBar>
      </AttachDropZone>
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
/** textarea 和它底下的高亮镜像层必须**逐字同排**:字号/行高/内边距/换行规则
    一个字节都不能差,否则 chip 会偏离光标下的字。共用这一份 */
const COMPOSER_METRICS = "px-3 py-2 text-sm leading-[1.45] whitespace-pre-wrap break-words";

/** 输入框里的 directive chip(assistant-ui 的 DirectiveText 只管发出去的消息,
    composer 内没有官方方案)。做法是经典的 highlight-backdrop:textarea 的字
    画成透明、只留光标,底下叠一层同字号的镜像把同一段文本画出来,命中的
    `$skill` / `/指令` 段加底色。chip 的"内边距"用 ring(box-shadow)画,不占
    排版宽度 —— 一占宽,后面的字就和 textarea 里的错位了 */
function ComposerHighlight({
  text,
  segments,
  scrollTop,
}: {
  text: string;
  segments: readonly Unstable_DirectiveSegment[];
  scrollTop: number;
}) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-0 overflow-hidden text-foreground ${COMPOSER_METRICS}`}
    >
      <div style={{ transform: `translateY(${-scrollTop}px)` }}>
        {segments.map((seg, i) =>
          seg.kind === "text" ? (
            <span key={i}>{seg.text}</span>
          ) : (
            <span
              key={i}
              className="rounded-[4px] bg-brand/15 text-brand ring-[3px] ring-brand/15 [box-decoration-break:clone]"
            >
              {seg.label}
            </span>
          )
        )}
        {/* 末尾换行在 pre-wrap 里不占高度,补一个零宽字符把那一行撑出来 */}
        {text.endsWith("\n") ? "\u200b" : null}
      </div>
    </div>
  );
}

function ComposerTextarea({
  inputRef,
  running,
  onSubmit,
  onPasteFiles,
  text,
  segments,
}: {
  /** 当前文本 + 切好的段,给高亮层画 chip */
  text: string;
  segments: readonly Unstable_DirectiveSegment[];
  /** ChatComposer 拿它做一件事:composerInject 注入文本后把焦点放回输入框 */
  inputRef: React.Ref<HTMLTextAreaElement>;
  /** turn 在跑。**不再据此 disabled** —— 跑着的时候敲下的回车是"插话"
      (注入正在跑的 turn，issue #344)，⌥回车才是排队(lib/messageQueue.ts)。
      这里只用来换一句提示语 */
  running: boolean;
  /** queue = 用户按住 ⌥ 敲的回车：跑着时明确要排队，不插话 */
  onSubmit: (opts: { queue: boolean }) => void;
  onPasteFiles: (files: File[]) => void;
}) {
  const aria = unstable_useTriggerPopoverAriaProps();
  const popoverOpen = aria["aria-expanded"] === true;
  const [scrollTop, setScrollTop] = useState(0);
  const hasChip = segments.some((s) => s.kind !== "text");

  return (
    <div className="relative">
    {hasChip && <ComposerHighlight text={text} segments={segments} scrollTop={scrollTop} />}
    {/* textarea + Enter 发送 / Shift+Enter 换行（Slack 约定）。
    // 自动长高走 field-sizing: content（纯 CSS，max-height 封顶出滚动条）。
    //
    // ComposerPrimitive.Input 接管文本状态(值/受控/焦点管理),外观仍是本仓的 Textarea。
    // 三个关闭项都是刻意的:
    // - submitMode="none":发送归 ChatComposer 的 submit()(理由见那边的头注释)
    // - addAttachmentOnPaste={false}:粘贴附件走 store 的闸门(intakePastedFiles),
    //   不走 assistant-ui 的附件通道
    // - cancelOnEscape={false}:Esc 在本仓是"停止 turn"(App 里挂 window 的那个监听),
    //   不是"清空正在打的字"
    //
    // 有 chip 时字画成透明(text-transparent),由上面的镜像层代画;光标色另给。
    // 没 chip 时不开透明,省掉镜像层,也避免两层字的亚像素差 */}
    <ComposerPrimitive.Input
      asChild
      submitMode="none"
      addAttachmentOnPaste={false}
      cancelOnEscape={false}
    >
      <Textarea
        ref={inputRef}
        className={cn(
          "relative border-none shadow-none min-h-0 bg-transparent dark:bg-transparent text-foreground resize-none max-h-[40vh] focus-visible:ring-0 placeholder:text-foreground/35 caret-foreground",
          COMPOSER_METRICS,
          hasChip && "text-transparent"
        )}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        autoFocus
        rows={1}
        placeholder={
          running ? "回车插话（注入当前任务），⌥回车排队" : "输入消息，回车发送，Shift+回车换行"
        }
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
            onSubmit({ queue: e.altKey });
          }
        }}
      />
    </ComposerPrimitive.Input>
    </div>
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
  const enqueue = useChat((s) => s.enqueue);
  const steer = useChat((s) => s.steer);
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
  // - `/指令`:同样是 directive(插入)。Tab/点选只把 `/名字 ` 填进输入框,回车才算发出 ——
  //   菜单里"选中"和"执行"是两个动作,不让一次误触的 Tab 直接跑掉一次 /compact。
  //   回车后 submit() 按名字分发:本地指令走 dispatchSlash,MCP prompt 开表单卡
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
    const items = skills.map((k) => {
      // argument-hint 拼进 description 尾巴：菜单项没有第三个展示位，
      // 而"这个 skill 吃什么参数"正是选它之前想知道的事
      const desc = [k.description, k.argumentHint && `参数 ${k.argumentHint}`]
        .filter(Boolean)
        .join(" · ");
      return {
        id: k.name,
        type: "skill",
        label: `$${k.name}`,
        ...(desc ? { description: desc } : {}),
      };
    });
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
  // MCP prompt 混进同一份 `/` 菜单:只回**连上**的 server 的 prompt(见 store 的
  // refreshMcpPrompts 注释),清单跟着 onMcpChanged 活着——server 掉线/重连,
  // 这份 commands 数组下一渲染就跟着变,不用额外订阅。
  // 零参数直接展开、带参数开表单卡,两条路都在 store.openMcpPromptForm 里判——
  // 这里的 execute 只管"选中了就把 prompt 交出去"，不复述那份判断
  const mcpPrompts = useChat((s) => s.mcpPrompts);
  const openMcpPromptForm = useChat((s) => s.openMcpPromptForm);
  const slashItems = useMemo<Unstable_TriggerItem[]>(
    () => [
      ...Object.entries(SLASH_COMMANDS).map(([name, c]) => ({
        id: name.slice(1),
        type: "command",
        label: name,
        description: c.desc,
      })),
      ...mcpPrompts.map((p) => ({
        id: p.name,
        type: "command",
        label: `/${p.name}`,
        description: mcpPromptCommandDescription(p.description, p.server),
        // iconMap 见下方 ComposerTriggerPopover:"mcp" 这个 key 换成插头图标,
        // 与本地指令用同一枚 fallback(闪光)分开——这是这版唯一的"分组"信号,
        // 没有另起一套 TriggerCategory 浏览机制(本仓 `/` 菜单一直是纯搜索/
        // 扁平列表)
        icon: "mcp",
      })),
    ],
    [mcpPrompts]
  );
  const slashAdapter = useMemo<Unstable_TriggerAdapter>(
    () => ({
      categories: () => [],
      categoryItems: () => [],
      search: (query: string) => {
        const lower = query.toLowerCase();
        return lower === ""
          ? slashItems
          : slashItems.filter((i) => i.id.toLowerCase().includes(lower));
      },
    }),
    [slashItems]
  );
  const slashDirective = useMemo(
    () => ({ formatter: ottoSlashFormatter(slashItems.map((i) => i.id)) }),
    [slashItems]
  );
  // 路径那份不依赖任何名单(靠形状判定),造一次就够
  const pathFormatter = useMemo(() => ottoPathFormatter(), []);
  // @好友(issue #611):名单是 accepted 好友,选中把 `@显示名 ` 填进输入框,
  // 发送时 submit() 用 findFriendMention 认出并先调 shareSession 再发留言。
  // 数据源直接是 friendsSnapshot.friends(FriendsSection 同款),不用新增 hook
  const friends = useChat((s) => s.friendsSnapshot.friends);
  const friendMentions = useMemo(
    () => friends.map((e) => ({ uid: e.profile.id, name: e.profile.name })),
    [friends]
  );
  const friendFormatter = useMemo(() => ottoFriendFormatter(friendMentions), [friendMentions]);
  // 一行 = 一个人:最左头像 · 中间显示名 · 最右邮箱(issue #831)。
  // 显示名是对方随时能改、还可以重名的字段,而 @好友 的后果是把会话连同服务借用
  // 一起发出去(ADR-0177)——选错人不是打错字那一级,所以行上得有邮箱这个准地址。
  // 建条目与过滤都在 lib/friendMentionItems(显示什么就搜什么,两条判定同一份)
  const friendAdapter = useMemo<Unstable_TriggerAdapter>(() => {
    const items = friendMentionItems(friends);
    return {
      categories: () => [],
      categoryItems: () => [],
      search: (query: string) => searchFriendMentions(items, query),
    };
  }, [friends]);
  const friendDirective = useMemo(() => ({ formatter: friendFormatter }), [friendFormatter]);
  // 分享前那次确认的对象（null = 没在问）。候选服务现算不订阅：@ 一次算一次，
  // 而 events/mcpServers 变一次就重算的话，这个组件每个流式 token 都要重跑一遍
  const [shareTarget, setShareTarget] = useState<ShareGrantTarget | null>(null);
  const shareGrantCandidates = (): string[] => {
    const st = useChat.getState();
    return serversUsedInSession(
      st.events,
      st.mcpServers.servers.map((m) => ({
        id: m.id, live: m.status === "connected", tools: m.tools,
      }))
    );
  };
  const composerSegments = useMemo(
    () =>
      segmentComposerText(input, [
        skillFormatter,
        slashDirective.formatter,
        friendFormatter,
        pathFormatter,
      ]),
    [input, skillFormatter, slashDirective, friendFormatter, pathFormatter]
  );


  // composerInject 是一次性通道:收到就立刻清空 store,不然"又注入一次同样的文本"
  // 时对象引用没变,selector 判定无变化,下次不会重新触发这个 effect
  const composerInject = useChat((s) => s.composerInject);
  useEffect(() => {
    if (!composerInject) return;
    // 追加档要读当前值。composer.getState() 而不是闭包里的 input:
    // 这个 effect 只依赖 composerInject,input 的闭包会是旧的
    const prev = composer.getState().text;
    composer.setText(composeInjectedText(prev, composerInject.text, composerInject.append));
    useChat.setState({ composerInject: null });
    textareaRef.current?.focus();
  }, [composerInject, composer]);


  // 「有东西可发」:只贴了图不打字也算(附件本身就是内容,同 submit 的判据)
  const canSend = input.trim() !== "" || staged.length > 0;

  /** 发出去、插话，还是排进队里。turn 跑着时敲的回车默认是"插话"
      （注入正在跑的 turn，issue #344），⌥回车明确排队；带 $skill 的
      也退回排队——skill 注入（skill_invoked 快照）是 turn 开场的事，
      往跑到一半的 turn 里塞说明书没有清晰语义。分岔只在这一处 ——
      上面那些解析($skill / 空正文校验)几条路共用 */
  const dispatch = (text: string, skill?: string, skillArgs?: string, queue = false) => {
    if (status === "running") {
      if (queue || skill) enqueue(text, skill, skillArgs);
      else void steer(text);
      return;
    }
    void send(text, skill, skillArgs);
  };

  const submit = (opts?: { queue?: boolean }) => {
    const queue = opts?.queue ?? false;
    const text = input.trim();
    // 只贴了图不打字也算一条消息:附件本身就是内容
    if (!text && staged.length === 0) return;
    // 但**排队**只排文字:队列里存不下附件(它们是 staged 里的一份暂存,
    // 一条队列项挂不住)。turn 跑着时附件入口整个是关的(AttachDropZone
    // disabled),所以这一条正常撞不到;真撞到了就什么都不做,而不是
    // 把图悄悄丢掉发一条空消息
    if (status === "running" && !text) return;
    // "$skill名(参数)"：名字和参数给 harness（注入 skill），剩下的正文才是给模型的话。
    // 参数在括号里显式分隔（issue #214，ponytail 的 argument-hint 档位同款需求）。
    // 指令头**在句中也算**（issue #438）——判定和输入框高亮共用一份名单、同一套
    // 最长优先规则（findSkillDirective），画的和发的从此是同一件事。
    // 报错时不清输入框——让用户就地改
    const directive = findSkillDirective(
      text,
      useChat.getState().skills.map((s) => s.name)
    );
    if (directive) {
      if (!directive.task) {
        useChat.setState({ error: `任务不能为空（用法：$${directive.name} 任务描述）` });
        return;
      }
      setInput("");
      dispatch(directive.task, directive.name, directive.args, queue);
      return;
    }
    // 行首打了 `$` 却一个已安装的名字都没命中 = 名字打错了。当场说，别悄悄发给
    // 模型——模型收到一个不认识的 token 只会瞎猜，这正是 #438 的病根
    if (text.startsWith("$")) {
      const space = text.search(/\s/);
      const token = (space === -1 ? text : text.slice(0, space)).slice(1);
      const name = token.match(/^(.+?)\((.*)\)$/)?.[1] ?? token;
      useChat.setState({ error: `skill 不存在: ${name}（$ 后跟已安装的 skill 名，可带参数：$名字(参数)）` });
      return;
    }
    // @好友 分享会话(issue #611):句子里带 @好友名 时,先把当前会话快照分享给
    // 这位好友,正文作为留言随包发过去。
    //
    // **正文不发给模型**(issue #705 定的口径,注释以前说反了):`@好友` 是发送侧的
    // 一个动作信号,不是给模型的话——同 `/指令` 那一族。「@小明 帮我把这批订单退了」
    // 要是照样 dispatch,本地这只水獭会去做你刚刚才委托出去的同一件事,两边同时
    // 动同一个 Shopify;那不是多余,是有害。
    // 代价是这条消息在时间线上什么都不留、输入框一清像被吞了——所以分享成功后
    // 主进程往日志追一条 session_shared,那一行就是这个动作的痕迹(不是渲染层
    // 自己记的一笔:刷新即失忆的东西不配叫事实)。
    //
    // 失败已落 friendError,输入框不清让用户改。判定与 composer 高亮共用一份名单、
    // 同一套最长优先(findFriendMention)——画的和发的认的是同一个好友
    const friendHit = findFriendMention(text, friendMentions);
    if (friendHit) {
      // 这个会话用到了 MCP 服务的话，分享前先问一次「要不要连带借给 TA」
      // （issue #694，ADR-0177）——问的是授权，不是分享本身，所以没有服务
      // 可借时一步都不多走：直接分享，与这个功能上线前完全一样
      const candidates = shareGrantCandidates();
      if (candidates.length > 0) {
        setShareTarget({
          uid: friendHit.uid, name: friendHit.name, message: friendHit.task, servers: candidates,
        });
        return;
      }
      void (async () => {
        const ok = await useChat.getState().shareSession(
          useChat.getState().sessionId,
          friendHit.uid,
          friendHit.name,
          friendHit.task
        );
        if (ok) setInput("");
      })();
      return;
    }
    setInput("");
    // "/" 开头 = 对 harness 说话，不进模型 —— 也就不排队:它们是本地动作
    // (开面板、改标题),等一个 turn 跑完再执行没有道理。
    // MCP prompt 和本地指令共用 `/` 菜单,回车时先认 MCP prompt 的名字
    // (本地指令表里没有的才轮到它),认上了就开表单卡/直接展开(store 判)
    // slashCommandName 判"命令形"：/Users/... 这类路径开头的消息判不上，照常走 send
    const slashName = slashCommandName(text);
    if (slashName !== null) {
      const name = slashName;
      if (!(name in SLASH_COMMANDS)) {
        const prompt = mcpPrompts.find((p) => `/${p.name}` === name);
        if (prompt) {
          openMcpPromptForm(prompt);
          return;
        }
      }
      dispatchSlash(text);
      return;
    }
    dispatch(text, undefined, undefined, queue);
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
              char="@"
              // 好友这一族比指令宽(头像 + 名字 + 邮箱三格),但得封顶 ——
              // TRIGGER_POP 是 w-auto,不封顶的话一个长邮箱就把弹层拉过整屏,
              // 而 truncate 也只有在有上界时才会真的截
              className={`${TRIGGER_POP} max-w-[26rem]`}
              adapter={friendAdapter}
              directive={friendDirective}
              emptyItemsLabel="没有匹配的好友"
              emptyCategoriesLabel="还没有好友"
              backLabel="返回"
              loadingLabel="加载中…"
            />
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
              adapter={slashAdapter}
              directive={slashDirective}
              // MCP prompt 条目在 execute() 里挂了 icon:"mcp"(见上方 slashTrigger),
              // 换成插头图标——本地指令没挂 icon,照旧落回 fallbackIcon(闪光)。
              // 这是这一版"分组"的全部实现:纯扁平搜索列表里靠图标分出两类来源,
              // 没有另起一套分类导航
              iconMap={{ mcp: Plug }}
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
              running={status === "running"}
              onSubmit={submit}
              onPasteFiles={(files) => void filesToPayload(files).then(attachPasted)}
              text={input}
              segments={composerSegments}
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
      <ShareGrantDialog
        target={shareTarget}
        onCancel={() => setShareTarget(null)}
        onConfirm={async (selected) => {
          if (!shareTarget) return false;
          const ok = await useChat.getState().shareSession(
            useChat.getState().sessionId,
            shareTarget.uid,
            shareTarget.name,
            shareTarget.message,
            selected
          );
          if (ok) setInput("");
          return ok;
        }}
      />
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
}


export function App() {
  // 逐字段选择器,不整店订阅:App 在树根,无选择器的 useChat() 让**每次** set()
  // (每个流式 token、每段 bash 输出、每次 presence 推送)都重渲染整棵树。
  // boot/stop/resume 是建店时定义的 action,引用稳定,单选不会多触发
  const phase = useChat((s) => s.phase);
  // 进门闸的两个入参。都是低频字段（登录/登出才动），订在树根不会带来额外重渲染
  const account = useChat((s) => s.account);
  const authRecord = useChat((s) => s.authRecord);
  /** 闸门抬不抬还多一条：从闸门发起的重置，要在门外把新密码设完（issue #744） */
  const holdGateForPasswordReset = useChat((s) => s.holdGateForPasswordReset);
  const sessionId = useChat((s) => s.sessionId);
  const workspace = useChat((s) => s.workspace);
  const events = useChat((s) => s.events);
  const boot = useChat((s) => s.boot);
  const stop = useChat((s) => s.stop);
  const resume = useChat((s) => s.resume);
  // 这个会话是不是被派活派出来的子会话(ADR-0047)——是就带上父会话 id，
  // header 露一颗"← 回到父会话"。纯粹从 events[0] 的 spawnedBy 推导
  const spawnedFrom = useMemo(() => spawnedFromOf(events), [events]);
  const status = useChat((s) => s.statusBySession[s.sessionId] ?? "idle");
  // 会话名走侧栏那份投影(改名/首条消息都已归一在那),不在这里重算一遍
  const sessionTitle = useChat((s) => s.sessions.find((x) => x.sessionId === s.sessionId)?.title ?? null);
  // 内置 Default 的路径:兜底名要按它分「任务」还是工程文件夹名(与侧栏同一口径)
  const builtinWorkspace = useChat((s) => s.workspaceSettings?.builtinWorkspace ?? null);
  const replayCursor = useChat((s) => s.replayCursor);
  const setReplayCursor = useChat((s) => s.setReplayCursor);
  const settingsSection = useChat((s) => s.settingsSection);
  const isPackaged = useChat((s) => s.isPackaged);
  // 残留清单弹窗（issue #759，review finding 1/2）：上次(boot latch) / 本次
  // (直播累加) 两份各自的 items + 各自的 open 开关 + 收尾动作。items 空或
  // open=false 时 ResiduePanel 自己不渲染，这里不用先判
  const bootResidue = useChat((s) => s.bootResidue);
  const bootResidueOpen = useChat((s) => s.bootResidueOpen);
  const liveResidue = useChat((s) => s.liveResidue);
  const liveResidueOpen = useChat((s) => s.liveResidueOpen);
  const dismissBootResidue = useChat((s) => s.dismissBootResidue);
  const dismissLiveResidue = useChat((s) => s.dismissLiveResidue);
  const openLiveResidue = useChat((s) => s.openLiveResidue);
  // 清理走哪个会话（review I1）：正看着的会话优先，welcome 页（sessionId 为空）
  // 退到最后一条残留事件自带的那个——归档的清单就是这么送到 welcome 页上的
  const lastResidueSessionId = useChat((s) => s.lastResidueSessionId);
  const residueSessionId = sessionId !== "" ? sessionId : lastResidueSessionId;
  const protocolOpen = useChat((s) => s.protocolOpen);
  const openProtocol = useChat((s) => s.openProtocol);
  const gitGraphOpen = useChat((s) => s.gitGraphOpen);
  const openGitGraph = useChat((s) => s.openGitGraph);
  const filesPanelOpen = useChat((s) => s.filesPanelOpen);
  const bgPanelOpen = useChat((s) => s.bgPanelOpen);
  /** 现在开着哪块面板 —— 每会话的面板记忆记的就是它 */
  const panelKey = useChat(panelKeyOf);
  const terminalPanelOpen = useChat((s) => s.terminalPanelOpen);
  const openTerminalPanel = useChat((s) => s.openTerminalPanel);
  const browserPanelOpen = useChat((s) => s.browserPanelOpen);
  const simPanelOpen = useChat((s) => s.simPanelOpen);
  const openSimPanel = useChat((s) => s.openSimPanel);
  const openBrowserPanel = useChat((s) => s.openBrowserPanel);
  const openSettings = useChat((s) => s.openSettings);
  const friendChat = useChat((s) => s.friendChat);
  const panelWide = useChat((s) => s.panelWide);
  // 会话目录 = 事件投影，不是 UI 状态（同 TodoPanel 的路子）
  const sections = useMemo(() => deriveSections(events), [events]);
  const [activeSection, setActiveSection] = useState<number | null>(null);
  // 「发布到工作区…」弹窗开关（头部「更多」菜单，ADR-0198 切片 3，issue #811）
  const [publishOpen, setPublishOpen] = useState(false);
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

  // ⌘⇧E = 开/关 Files 面板(VS Code 的 Explorer 同款肌肉记忆)。挂 window:
  // 焦点可能在树或预览区里,输入框收不到
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        if (useChat.getState().filesPanelOpen) useChat.getState().closeFilesPanel();
        else useChat.getState().openFilesPanel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);


  // 后台任务:轮询 live 名单 + 「刚从没有变成有」时自己把面板掀开。
  // 挂在这儿(不在面板组件里)是因为面板默认关着——关着的时候也得有人盯着
  useBackgroundWatch();

  // 每个会话上次开着哪块右侧面板,记一笔;切回来时 enterChat 按这份还原
  // (issue #578)。写在 effect 里而不是每个 open/close action 里:开关面板的
  // 入口有十几个(菜单/快捷键/工具结果/自动开),挂在**结果**上只需要一处
  useEffect(() => {
    if (!sessionId) return;
    useChat.getState().rememberPanel(sessionId, panelKey);
  }, [sessionId, panelKey]);

  if (phase === "connecting") return <main className="flex-1 min-w-0 px-6 py-24 text-muted-foreground">连接主进程…</main>;

  // 进门那道闸（ADR-0182）：没有登录记录 = 整个 app 只画这一屏。
  // 位置卡在 connecting 之后 —— boot() 没回来之前 authRecord 还是初值 false，
  // 那一拍判定出来的"没登录"是假的（这一拍的画面本来也被 Splash 盖着）。
  // 放在这里而不是包在 main.tsx 外层：boot() 挂在 App 的 effect 上，
  // 不让 App 挂载就永远拿不到登录记录，闸门会把所有人都关在外面。
  // 早退在返回值这一层而不是提前 return：上面所有 hook 照常跑（含 boot），
  // 而下面那棵树（侧栏 / 会话 / ⌘K 搜索框 / 各种弹窗）一个都不挂 —— 没登录的人
  // 按 ⌘K 不该有东西浮在登录卡上面
  if (showsSignInScreen(account, authRecord, holdGateForPasswordReset)) return <SignInScreen />;

  // 布局：侧栏常驻，主区按 settingsSection 分发（账号 / 模型配置 / 外观 / Skill 库 / 欢迎 / 聊天）。
  // Protocol/Git Graph/DM 不整页替换而是右侧叠加面板:默认半屏(会话还看得见),可展开全屏
  // friendChat 优先——DM 面板打开时不该被 Protocol/GitGraph 顶掉
  const panel = friendChat ? <FriendChatView />
    : browserPanelOpen ? <BrowserPanel />
    : simPanelOpen ? <SimulatorPanel />
    : terminalPanelOpen ? <TerminalView />
    : filesPanelOpen ? <FilesView />
    : bgPanelOpen ? <BackgroundTasksPanel />
    : gitGraphOpen ? <GitGraphView />
    : protocolOpen ? <ProtocolView /> : null;
  const base = settingsSection === "account" ? (
    <AccountPage />
  ) : settingsSection === "workspace" ? (
    <WorkspaceSettings />
  ) : settingsSection === "keys" ? (
    <KeysPage />
  ) : settingsSection === "appearance" ? (
    <AppearancePage />
  ) : settingsSection === "skills" ? (
    <SkillsPage />
  ) : settingsSection === "agents" ? (
    <SubagentSettings />
  ) : settingsSection === "mcp" ? (
    <McpSettings />
  ) : settingsSection === "permissions" ? (
    <PermissionsSettings />
  ) : settingsSection === "memory" ? (
    <MemorySettings />
  ) : settingsSection === "context" ? (
    <AutoCompactSettings />
  ) : settingsSection === "remote" ? (
    <RemoteDevicesSettings />
  ) : settingsSection === "about" ? (
    <AboutUpdateSettings />
  ) : phase === "welcome" ? (
    <Welcome />
  ) : (
    <div className={MAIN_COL}>
      <header className={HEADER}>
        <SidebarNub />
        {/* 子会话(ADR-0047)才有的返程键:它不在侧栏里,唯一的出路是回它的父会话 */}
        {spawnedFrom && (
          <Button
            variant="ghost"
            size="sm"
            className={HEADER_GHOST}
            onClick={() => void resume(spawnedFrom)}
          >
            <ArrowLeft /> 回到父会话
          </Button>
        )}
        {/* 会话名 · 工程 · 分支：一行说清"我在哪个会话、哪个工程、哪根枝上"。
            会话名可长可短,只让它伸缩截断;工程名和分支控件定宽不挤掉 */}
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span className="font-[650] text-sm min-w-0 truncate" title={sessionId}>
            {sessionDisplayName(sessionTitle, events, fallbackSessionLabel(workspace, builtinWorkspace))}
          </span>
          <span className="text-muted-foreground text-xs shrink-0">·</span>
          <span className="text-muted-foreground text-xs font-mono shrink-0 max-w-[180px] truncate" title={workspace}>
            {folderName(workspace)}
          </span>
          {/* 分支从 composer 上方搬来:它回答的是"我在哪",属于头部这排身份信息,
              不是输入区的控件 */}
          <BranchPicker dir={workspace} disabled={status === "running"} leadingSep />
          <IsolatedChip events={events} />
        </div>
        {/* 对话 / 轨迹 两个视图外显成 tab(deepseek-harness 版式):同一份日志的两种投影,
            切换零成本,不该藏在溢出菜单里。replayCursor 非 null = 轨迹视图 */}
        <Tabs
          value={replaying ? "trajectory" : "chat"}
          onValueChange={(v) => setReplayCursor(v === "trajectory" ? 0 : null)}
          className="shrink-0"
        >
          <TabsList variant="line" className="h-7">
            <TabsTrigger value="chat" className="text-xs px-2">对话</TabsTrigger>
            <TabsTrigger value="trajectory" className="text-xs px-2">轨迹</TabsTrigger>
          </TabsList>
        </Tabs>
        {/* 头部只留一颗「更多」溢出菜单:回放/Protocol 等功能收进去,后续新功能有地方放 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className={HEADER_GHOST} title="更多">
              <Ellipsis className="w-[14px] h-[14px]" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {/* Protocol 仪表盘对应各工作区,入口挂会话头部,不进全局侧栏 */}
            <DropdownMenuItem onClick={() => void openProtocol()}>
              <BookMarked /> Protocol 仪表盘
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void openGitGraph()}>
              <GitBranch /> Git Graph
            </DropdownMenuItem>
            {/* 独立副本（issue #643）：只有在副本上的会话才有这一项——
                不在副本上时整条不出现，而不是灰着，菜单里没有意义的行不该占位置 */}
            <IsolatedMergeItem events={events} disabled={status === "running"} />
            <DropdownMenuItem onClick={() => useChat.getState().openFilesPanel()}>
              <FolderOpen /> 文件
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openTerminalPanel()}>
              <TerminalIcon /> 终端
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openBrowserPanel()}>
              <Globe /> 浏览器
            </DropdownMenuItem>
            {/* iOS 模拟器(issue #401):macOS + Xcode 才有意义,但入口常驻——
                没设备时面板自己会说"没有可用设备",比藏起来让人猜好 */}
            <DropdownMenuItem onClick={() => openSimPanel()}>
              <Smartphone /> iOS 模拟器
            </DropdownMenuItem>
            {/* 自动开面板只在"槽位空着"时发生(见 lib/useBackgroundWatch.ts),
                所以必须有一条手动的路把它叫回来 */}
            <DropdownMenuItem onClick={() => useChat.getState().openBgPanel()}>
              <Loader2Icon /> 后台任务
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {/* 发布到工作区(ADR-0198 切片 3,issue #811):跟 @好友 分享是两条不同的路——
                分享是一次性给一个人,发布是常驻挂在工作区里给全体成员(含未来加入者)
                反复导入。没有工作区时对话框自己说"先建一个",这一项不藏起来 */}
            <DropdownMenuItem onClick={() => setPublishOpen(true)}>
              <UploadCloud /> 发布到工作区…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {/* 子智能体设置页开页时自动落到当前会话的 workspace 那一层
                (SubagentSettings 的 initialSubagentScope),所以从这进去编的就是
                <工程>/.mr-otto/agents 里的定义,不是用户级那份 */}
            <DropdownMenuItem onClick={() => void openSettings("agents")}>
              <Bot /> 子智能体
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {replaying ? (
        <>
          {/* 轨迹视图:泳道时间轴 + 一步一行 + 详情面板,看 agent 每一步做了什么 */}
          <TrajectoryView />
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
          {/* MCP prompt 参数表单:composer `/` 菜单选中的产物,同一类"管线停这等人"的卡,
              贴在输入框正上方,同 QuestionnaireCard 的位置逻辑 */}
          <McpPromptCard />

          <footer className="relative px-5 pt-[10px] pb-3">
            {/* 滚动缘渐隐:对话内容淡入 footer 底色,消掉硬切割线(scroll edge effect,非 1px 分隔) */}
            <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-10 h-10 bg-gradient-to-b from-transparent to-background" />
            <WorkTreePill />
            {/* 输入框上方那三条(任务 / 本轮改动 / 排队消息)横排,不再上下摞:
                它们各自只有一行高,摞起来却按"有几条"往上顶掉几行对话——而这块
                地方最贵的是**竖向**空间。有几条显示几列,每列等宽摊满整行。
                左起顺序 = 用户指定的「任务在左、消息在右」。
                :empty 时整行不占地方(三条都 return null 时这个 div 是空的);
                窄面板下 basis-[200px] + flex-wrap 让它们自己折回去摞着,
                不至于挤成三条读不出字的窄条 */}
            <div className="mb-2 flex flex-wrap items-start gap-2 empty:hidden empty:mb-0 [&>*]:min-w-0 [&>*]:grow [&>*]:basis-[200px]">
              <TodoPanel />
              <TurnDiffPanel />
              <QueuePanel />
            </div>
            {/* 「消息没发出去」= 输入框的回执,所以贴着输入框,不在消息流里 */}
            <SendErrorBanner />
            {/* 项目指令信任横幅(issue #353):开工前的决定,同样贴着输入框 */}
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
          {main}
          {/* 首登引导:只在 profiles.onboarded_at 还是空的时候自己弹一次 */}
          <ProfileSetupDialog />
          {/* 点完重置链接回来的人,进的是这棵树(已登录),所以它挂在这儿不在闸门里 */}
          <SetPasswordDialog />
          {!isPackaged && <DevBadge />}
          {/* 首登引导第二步:上面那个关掉后,一把 key 都没配的新用户接着配模型
              (接力逻辑在 store 的 setProfileSetupOpen,盖章见 lib/modelSetup.ts) */}
          <ModelSetupDialog />
          {/* 会话搜索(⌘K):侧栏按工程分堆,堆多了只能翻——这条是"记得说过什么就找得到" */}
          <SessionSearchDialog />
          {/* 发布到工作区(ADR-0198 切片 3,issue #811):头部「更多」菜单开的口。
              sessionId 为空(欢迎页)时头部本来就不渲染,菜单项也点不到,这里不用再判 */}
          <PublishSessionDialog
            open={publishOpen}
            onOpenChange={setPublishOpen}
            sessionId={sessionId}
            events={events}
            defaultTitle={sessionTitle ?? ""}
          />
          {/* 残留清单（issue #759，review finding 1/2 + review I1/I2）：boot latch
              非空 = 上次退出没收干净，一进这个会话就弹一次；本次残留只有
              origin==="archive" 的直播事件才自动弹（applyResidueEvent 判的，
              不在这儿判）——turn 收口那批只进 liveResidue、不弹窗，靠下面的
              角标点开。
              **不再要求 sessionId !== ""**（review I1）：归档会把 currentSessionId
              清成 null、渲染层切回 welcome，而归档那一刻算出来的全量 diff 恰恰是
              这时候才到——挂载条件卡着 sessionId 的话，这批残留在界面上永远不
              出现。清理要的会话 id 走 lastResidueSessionId（事件自带的那个）。
              **items 非空才挂载**（review I2）：ResiduePanel 的"owned 默认勾选"
              是挂载那一刻算的初值，先挂空壳再灌数据 = 初值算的是空集；条件挂载
              让它挂上去就有数据（组件内另有一条 effect 兜住"分两批到达"） */}
          <>
            {bootResidue.length > 0 && (
              <ResiduePanel
                sessionId={residueSessionId}
                items={bootResidue}
                open={bootResidueOpen}
                title="上次残留"
                onDone={dismissBootResidue}
              />
            )}
            {liveResidue.length > 0 && (
              <ResiduePanel
                sessionId={residueSessionId}
                items={liveResidue}
                open={liveResidueOpen}
                title="本次残留"
                onDone={dismissLiveResidue}
              />
            )}
            {/* 角标（review finding 1d）：turn 收口那批只并入 liveResidue 不
                自动弹窗，得有个入口让用户自己翻出来看——找不到 BackgroundTasksPanel
                那种"自动开侧栏"的先例能照抄(它是自动开,这里明确不该自动开)，
                照顾"别过度建设"就做最简的一个带计数的圆角 chip，点开 = 打开
                同一个 ResiduePanel（本次残留）。弹窗开着时这颗自己藏起来，
                不叠在 Dialog 上方 */}
            {liveResidue.length > 0 && !liveResidueOpen && (
              <button
                type="button"
                onClick={openLiveResidue}
                title="有残留没处理，点开清单"
                className="fixed bottom-3 left-3 z-40 flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-[11px] text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground"
              >
                <span className="size-[6px] shrink-0 rounded-full bg-err" aria-hidden />
                残留 {liveResidue.length}
              </button>
            )}
          </>
        </SidebarInset>
        {/* 侧栏开关常驻左上角,两态同位(见 SidebarNub.tsx)。必须排在侧栏和内容区
            **之后**:Chromium 按文档顺序叠加 app-region 矩形、后者覆盖前者,放前面
            的话侧栏头部的 drag 矩形会盖掉它的 no-drag,真鼠标点击被当成拖窗口吞掉
            (CDP 模拟点击正常、真点无反应,就是这个) */}
        <SidebarToggle />
        {/* /btw SideChat 浮窗(issue #502):fixed 定位自己找位置,不占布局;
            宽度 < 阈值时组件内部自己 return null(显示不下) */}
        <SideChatWindow />
      </TooltipProvider>
    </SidebarProvider>
  );
}

/** dev 角标（未打包的 dev 实例）：右下角一枚小三角，别和线上版搞混。
    fixed 挂在视口上，不占布局；pointer-events-none 不挡点击 */
function DevBadge() {
  return (
    <div
      aria-label="dev 实例"
      className="pointer-events-none fixed bottom-0 right-0 z-50 flex h-8 w-8 items-end justify-end overflow-hidden"
    >
      <div className="h-0 w-0 border-b-[32px] border-l-[32px] border-b-amber-500/90 border-l-transparent" />
      <span className="absolute bottom-px right-px text-[8px] font-bold leading-none text-black">
        dev
      </span>
    </div>
  );
}
