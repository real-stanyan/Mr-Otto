"use client";

import { UserMessageAttachments } from "@/components/assistant-ui/attachment.js";
import { File } from "@/components/assistant-ui/file.js";
import { ThreadFollowupSuggestions } from "@/components/assistant-ui/follow-up-suggestions.js";
import { Sources } from "@/components/assistant-ui/sources.js";
import { Image } from "@/components/assistant-ui/image.js";
import { MarkdownText } from "@/components/assistant-ui/markdown-text.js";
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/reasoning.js";
import { ToolFallback } from "@/components/assistant-ui/tool-fallback.js";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/tool-group.js";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button.js";
import { Button } from "@/components/ui/button.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { cn } from "@/lib/utils.js";
import { OTTO_GROUP_PARTS_BY } from "@/lib/partGrouping.js";
import type { SessionEvent } from "../../../../session/events.js";
import {
  AuiIf,
  type AssistantState,
  BranchPickerPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type FileMessagePartComponent,
  type SourceMessagePartComponent,
  type TextMessagePartComponent,
  type ImageMessagePartComponent,
  type ToolCallMessagePartComponent,
  unstable_useThreadMessageIds,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type FC,
  type PropsWithChildren,
  type Ref,
} from "react";
import { windowIds } from "@/lib/messageWindow.js";

export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;

/**
 * Optional component overrides for the thread. `AssistantMessage` and
 * `Welcome` replace whole sections; the remaining slots override how the
 * assistant message renders tool calls and part groups. Tool UIs registered
 * by name (toolkit `render`, `useAssistantDataUI`) take precedence over
 * `ToolFallback`.
 */
export type ThreadComponents = {
  AssistantMessage?: ComponentType | undefined;
  /** 本仓加的槽:事件日志里的审计行(会话创建/模型切换/skill 注入/turn 暴死…)
      投成 role:"system" 消息,由它渲染。上游 registry 没有这个槽 —— 升级时要人工合 */
  SystemMessage?: ComponentType | undefined;
  /** 本仓加的槽:用户消息的附件由既有的 UserAttachments 渲染 ——
      图片本体在附件库、走 IPC 懒取,投影塞不进 assistant-ui 的 attachments 字段。
      上游 registry 没有这个槽 —— 升级时要人工合 */
  UserAttachments?: ComponentType | undefined;
  /** 本仓加的槽:turn 运行时的相位指示器(orb + 相位标签 + 实时耗时/token)。
      它不是消息 —— 是 turn 级的状态,所以挂在 ViewportFooter 而不是消息流里。
      上游 registry 没有这个槽 —— 升级时要人工合 */
  RunIndicator?: ComponentType | undefined;
  /** 本仓加的槽:会话分区轨的锚点(零高度、不参与布局,只给 scrollspy/跳转一个可测量
      的位置)。每条消息 id 就是产生它的那条 SessionEvent 的 seq(见
      aui/toThreadMessages.ts),分区起点也是 seq——同一把尺子,所以锚点该不该出现在
      "这条消息前面"这件事,只有这条消息自己的 id 知道。挂在 ThreadMessage 里、每条
      消息都过一遍,而不是挂在消息内容里面——system/user/assistant 三条分支都要经过它,
      放进某一条分支会漏掉另外两种角色的消息。上游 registry 没有这个槽 —— 升级时要人工合 */
  MessageAnchor?: ComponentType | undefined;
  Welcome?: ComponentType | undefined;
  ToolFallback?: ToolCallMessagePartComponent | undefined;
  /** 本仓加的槽:来源 chip。上游 registry 的 Sources 直接开 <a target="_blank">,
      在 Electron 里那是飘出一个 Otto 管不着的裸窗口 —— 本仓要把它接到内嵌浏览器上,
      所以得有个口子换掉整条渲染。上游 registry 没有这个槽 —— 升级时要人工合 */
  Source?: SourceMessagePartComponent | undefined;
  /** 本仓加的槽:用户消息正文的渲染。默认是纯文本(上游的行为),给了就换成它 ——
      本仓拿来把句中的 `$skill名` 画成 chip(directive-text)。只作用于用户消息:
      assistant 正文走 MarkdownText,那条路和 directive 无关。
      上游 registry 没有这个槽 —— 升级时要人工合 */
  UserText?: TextMessagePartComponent | undefined;
  /** 本仓加的槽:assistant 消息页脚左侧那一行数字(耗时/吞吐/token/花费)。
      放在动作条左边,同一行 —— 它和"复制/重来"是同一层的东西:关于这条回复本身,
      而不是回复的内容。上游 registry 没有这个槽 —— 升级时要人工合 */
  MessageFooter?: ComponentType | undefined;
  ToolGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
  ReasoningGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
};

export type ThreadProps = {
  components?: ThreadComponents | undefined;
  /** 本仓加的:会话分区轨(SectionRail)量的是真正滚动的那个元素——scrollspy 的判定线、
      跳转的 scroll-mt 都以它为准。ThreadPrimitive.Viewport 自己会转发 ref(内部用
      useComposedRefs 拼了 autoScroll/size/element 三个 ref,forwardRef 出来的还是同一个
      DOM 节点),所以直接接这个口子,不用像旧 ThreadViewport 那样另开一个回调 ref 去接管
      DOM、也不用退回 data-slot 查询。上游没有暴露这个 prop —— 升级时留意 Viewport 是否
      仍然转发 ref */
  viewportRef?: Ref<HTMLDivElement> | undefined;
  /** 本仓加的:时间线窗口(ADR-0284 决定 2,#1190)——只挂载消息列表的后缀,
      前面 hiddenCount 条不渲染(不付它们的 markdown 解析钱)。窗口状态由
      OttoThread 持有,这里只执行。缺省 0 = 全量挂载(行为与上游逐字相同) */
  hiddenCount?: number | undefined;
  /** 本仓加的:顶部哨兵进入视口(或兜底按钮被点)时回调一次,语义是「窗口再往上
      扩一档」。每次回调扩多少、什么时候停,由调用方(lib/messageWindow.ts)决定 */
  onGrowWindow?: (() => void) | undefined;
};

const EMPTY_COMPONENTS: ThreadComponents = {};

const ThreadComponentsContext =
  createContext<ThreadComponents>(EMPTY_COMPONENTS);

// Startup exposes a loading placeholder thread; treat it as a new chat so
// the composer mounts centered. Loads after startup keep the docked layout.
const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  (!s.thread.isLoading || s.threads.isLoading);

// A switched thread that is still fetching its history: skeleton, not welcome.
const isHistoryLoadingView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  s.thread.isLoading &&
  !s.thread.isDisabled &&
  !s.threads.isLoading;

// Exported so the cloud session page (CloudSessionPage.tsx, #983) can show the
// same "history still loading" shape instead of inventing a second one.
export const ThreadHistorySkeleton: FC = () => (
  <div
    data-slot="aui_thread-history-skeleton"
    role="status"
    className="flex flex-col gap-y-6 transition-opacity duration-200 delay-150 ease-strong starting:opacity-0"
  >
    <span className="sr-only">Loading conversation</span>
    <Skeleton className="ml-auto h-9 w-2/5 rounded-xl motion-reduce:animate-none" />
    <div className="flex flex-col gap-y-2">
      <Skeleton className="h-4 w-11/12 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-4/5 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-3/5 motion-reduce:animate-none" />
    </div>
    <Skeleton className="ml-auto h-9 w-1/3 rounded-xl motion-reduce:animate-none" />
    <div className="flex flex-col gap-y-2">
      <Skeleton className="h-4 w-10/12 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-2/3 motion-reduce:animate-none" />
    </div>
  </div>
);

export const Thread: FC<ThreadProps> = ({
  components = EMPTY_COMPONENTS,
  viewportRef,
  hiddenCount = 0,
  onGrowWindow,
}) => {
  const isEmpty = useAuiState(isNewChatView);

  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadRoot
        isEmpty={isEmpty}
        viewportRef={viewportRef}
        hiddenCount={hiddenCount}
        onGrowWindow={onGrowWindow}
      />
    </ThreadComponentsContext.Provider>
  );
};

const ThreadRoot: FC<{
  isEmpty: boolean;
  viewportRef: Ref<HTMLDivElement> | undefined;
  hiddenCount: number;
  onGrowWindow: (() => void) | undefined;
}> = ({ isEmpty, viewportRef, hiddenCount, onGrowWindow }) => {
  const {
    Welcome = ThreadWelcome,
    RunIndicator: RunIndicatorComponent,
  } = useContext(ThreadComponentsContext);

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bg-background @container flex h-full flex-col"
      style={{
        // 本仓改动:上游写死 44rem 居中定宽。本仓会话区撑满宽度、气泡各自
        // max-w-[76%](见 src/renderer/src/timelineStyles.ts 的 ROW),宽度约束
        // 交给 App.tsx 外层容器决定,这里只让内容撑满
        ["--thread-max-width" as string]: "100%",
        ["--composer-bg" as string]: "var(--color-card)",
        ["--composer-radius" as string]: "1.5rem",
        ["--composer-padding" as string]: "8px",
      }}
    >
      <ThreadPrimitive.Viewport
        ref={viewportRef}
        /* 本仓改动:registry 那份抄来的是 turnAnchor="top" —— 新一轮把用户那条消息钉在
           视口顶端,然后**整轮不动**。上游那个默认值背后还藏着一条:autoScroll 的默认值
           是 `turnAnchor !== "top"`(见 useThreadViewportAutoScroll),所以 top 锚同时
           关掉了跟随;就算显式把 autoScroll 打开也不够,内容变高那一段还有
           `!(isRunning && hasActiveTopAnchor())` 挡着,跑起来照样不跟。
           本仓要的是"视线跟着模型的输出走":一轮里工具行、思考、正文一段段往下长,
           人要看的是**最新那一段**,不是顶上那句自己刚打的话。
           改回 bottom 锚 = autoScroll 默认为真:内容长高就贴着底,人往上滑一下就松手
           (handleScroll 里的 isUserScrollUp),滑回底部又自动接上。 */
        turnAnchor="bottom"
        data-slot="aui_thread-viewport"
        className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth"
      >
        <div
          className={cn(
            "mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4",
            isEmpty && "justify-center",
          )}
        >
          <AuiIf condition={isNewChatView}>
            <Welcome />
          </AuiIf>
          <AuiIf condition={isHistoryLoadingView}>
            <ThreadHistorySkeleton />
          </AuiIf>

          <div
            data-slot="aui_message-group"
            // 本仓改动:相邻两条 assistant 消息(一 turn 里的几波工具调用各是一条)
            // 之间收到 gap-y-6 的一半 —— 它们是同一个回答的连续步骤,和思考行
            // 与工具行之间的间距一档,不该像换了个话题
            className="mb-14 flex flex-col gap-y-6 empty:hidden [&>[data-role=assistant]+[data-role=assistant]]:-mt-3"
          >
            {/* 本仓改动:上游是 <ThreadPrimitive.Messages> 按 index 全量挂载。
                换成按 id 的后缀窗口(ADR-0284 决定 2):首渲只付窗口内消息的解析钱,
                早的消息由哨兵按需补挂。hiddenCount = 0 时与上游逐字相同 */}
            <WindowedMessages hiddenCount={hiddenCount} onGrowWindow={onGrowWindow} />
          </div>

          {/* 本仓改动:这一条不铺底色、也不留那么厚的下边距。
              上游这里是"消息区 + 输入框"一整块的收尾,底色是为了把滚上来的正文挡在
              输入框后面;而本仓的输入框住在 Thread 外面(见下方注释),这一条footer
              里只剩跟进建议/运行指示/错误条——都是自带底色的小块。
              铺一层不透明底色 = 在正文和输入框之间横一条实心带子,把两者切开;
              下边距同理:建议是"接着说什么"的入口,它该贴着输入框,不是浮在半空 */}
          <ThreadPrimitive.ViewportFooter
            className={cn(
              // 本仓改动:抬一层。footer(App.tsx)顶边那道滚动缘渐隐是绝对定位的,
              // DOM 上排在消息区之后 —— 同为 z-auto 时它按后来居上盖在这一条上,
              // 快速回复整片被蒙了一层暗底。渐隐的活是"把滚上来的正文淡进 footer 底色",
              // 淡的是正文,不是钉在底边的控件:控件得在它之上
              "aui-thread-viewport-footer relative z-10 flex flex-col gap-2 overflow-visible pb-1",
              !isEmpty &&
                "sticky bottom-0 mt-auto rounded-t-(--composer-radius)",
            )}
          >
            {RunIndicatorComponent ? <RunIndicatorComponent /> : null}
            <ThreadScrollToBottom />
            {/* 本仓改动:这里**不**渲染 <Composer />,但输入框用的就是它 ——
                registry 那份 Composer 的外壳(shell 版式 / gap / 圆角底色内边距三件套 /
                ComposerAction 那一排的左右分栏 / 右侧的圆钮)整套照搬到了 App.tsx 的
                ChatComposer 里,只是壳子里装的是本仓自己的东西:投放区和附件暂存区归
                store(ADR-0040),左边那一栏是会话偏好条,发送键不走 ComposerPrimitive.Send
                (理由见 ChatComposer 的头注释)。搬过去而不是在这渲染,是因为输入框在本仓
                住在 Thread 外面(App 的 footer,和工作区胶囊/待办面板同层);
                这里再渲染一个,界面上就是两个输入框。
                跟进建议留在这:它属于"这一屏对话的收尾",贴着消息区底部读最顺,
                数据来自 suggestions_generated 事件的投影(aui/suggestions.ts) */}
            <ThreadFollowupSuggestions />
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC = () => {
  const {
    AssistantMessage: AssistantMessageComponent = AssistantMessage,
    SystemMessage: SystemMessageComponent,
    MessageAnchor: MessageAnchorComponent,
  } = useContext(ThreadComponentsContext);
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);

  // 锚点在角色分支之前渲染一次:三条分支(编辑/用户/系统/assistant)都要经过它,
  // 分区起点可能落在任意角色的消息前面
  const anchor = MessageAnchorComponent ? <MessageAnchorComponent /> : null;

  if (isEditing) return <>{anchor}<EditComposer /></>;
  if (role === "user") return <>{anchor}<UserMessage /></>;
  // 本仓加的分支:不认 system 的话,审计行会掉进 assistant 分支、被当成模型回复渲染。
  // 没给 SystemMessage 时退回 assistant —— 与上游行为一致,不静默吞掉消息
  if (role === "system" && SystemMessageComponent) return <>{anchor}<SystemMessageComponent /></>;
  return <>{anchor}<AssistantMessageComponent /></>;
};

// ─── 本仓改动:时间线窗口(ADR-0284 决定 2,#1190)───
//
// 上游的 ThreadPrimitive.Messages 按 index 作 key 全量挂载,长会话首渲要为
// 几百条历史消息各付一遍 Streamdown 解析。这里换成:unstable_useThreadMessageIds
// 拿全量 id(内容变化时数组引用不变,流式 token 不会重跑这里),切掉前
// hiddenCount 条,剩下的用 ThreadPrimitive.Unstable_MessageById 按 id 挂载 ——
// key 是消息 id 而不是 index,前缀补挂时既有消息一行都不用重挂重解析。
//
// 升级风险:这两个 API 在 @assistant-ui/react 里标了 @deprecated(unstable/
// experimental,随时可能变)。升级 assistant-ui 时先核对他们还在不在、签名
// 变没变;不在了就把这里退回 <ThreadPrimitive.Messages>(本文件 git 历史里
// 那份就是),窗口功能先撤,不要带病升级。
//
// 本仓自己的消息组件不走 components 槽位的类型(它读 ThreadComponentsContext),
// 所以给 MessageById 的 components 只传一个壳
const WINDOW_MESSAGE_COMPONENTS = { Message: ThreadMessage };

const WindowedMessages: FC<{
  hiddenCount: number;
  onGrowWindow: (() => void) | undefined;
}> = ({ hiddenCount, onGrowWindow }) => {
  const ids = unstable_useThreadMessageIds();
  const shown = useMemo(() => windowIds(ids, hiddenCount), [ids, hiddenCount]);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // 补挂补偿用的基准:补挂前的「第一条已挂载节点」与它的 offsetTop。
  // prepend 前后它是同一个 DOM 节点(key 是消息 id,React 复用),它的位移
  // 就是 prepend 的净高度 —— 不量 scrollHeight 的差:同一次提交里流式消息
  // 可能还在往底部长,会被一起算进来
  const firstNodeRef = useRef<Element | null>(null);
  const firstTopRef = useRef(0);
  const prevHiddenRef = useRef(hiddenCount);

  // 补挂的滚动补偿:prepend 会把视口里的内容往下顶,在 paint 之前把 scrollTop
  // 顶回去,用户读的那一行不动。只用一层 —— Chromium 原生的 scroll anchoring
  // (overflow-anchor 默认开,assistant-ui 与本仓的 CSS 都没关它)管的是
  // content-visibility 消息的**延迟尺寸修正**;这里管的是 prepend 这个结构性
  // 变化,量的对象不同,不叠两层。hiddenCount 归 0 之后窗口全开,不用再跟踪
  useLayoutEffect(() => {
    const prevHidden = prevHiddenRef.current;
    prevHiddenRef.current = hiddenCount;
    if (prevHidden > hiddenCount) {
      const el = firstNodeRef.current;
      if (el !== null && el.isConnected) {
        const delta = (el as HTMLElement).offsetTop - firstTopRef.current;
        if (delta > 0) {
          const viewport = el.closest('[data-slot="aui_thread-viewport"]');
          if (viewport instanceof HTMLElement) {
            // 视口上有 scroll-smooth,直接赋 scrollTop 会被它动画化
            // (补偿会变成一次看得见的漂移)——必须瞬时
            viewport.scrollTo({ top: viewport.scrollTop + delta, behavior: "instant" });
          }
        }
      }
    }
    if (hiddenCount > 0) {
      const first = sentinelRef.current?.nextElementSibling ?? null;
      if (first !== null) {
        firstNodeRef.current = first;
        firstTopRef.current = (first as HTMLElement).offsetTop;
      }
    }
  });

  return (
    <>
      {hiddenCount > 0 && (
        <WindowSentinel
          ref={sentinelRef}
          hiddenCount={hiddenCount}
          onGrowWindow={onGrowWindow}
        />
      )}
      {shown.map((id) => (
        <ThreadPrimitive.Unstable_MessageById
          key={id}
          messageId={id}
          components={WINDOW_MESSAGE_COMPONENTS}
        />
      ))}
    </>
  );
};

/** 窗口顶部那枚「向上加载更早」的哨兵。IntersectionObserver 可见即补挂;
    jsdom(没有 IO)或 IO 失效时,它自己就是那颗「显示更早的消息」按钮 ——
    两种环境下用户都有一条走得通的路 */
const WindowSentinel: FC<{
  ref: Ref<HTMLDivElement>;
  hiddenCount: number;
  onGrowWindow: (() => void) | undefined;
}> = ({ ref, hiddenCount, onGrowWindow }) => {
  useEffect(() => {
    const el = typeof ref === "object" && ref !== null ? ref.current : null;
    if (el === null || onGrowWindow === undefined) return;
    if (typeof IntersectionObserver === "undefined") return; // jsdom:只剩点按那条路
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((t) => t.isIntersecting)) onGrowWindow();
      },
      // root 是滚动视口;向上提前 200px 触发,别等撞上顶才付解析钱。
      // 已知代价:首挂载(scrollTop 还是 0、跟随滚动还没落地)那一帧哨兵在
      // 视口内,会多补挂一档 —— 60 条,一次,补完哨兵就远在视口外了
      { root: el.closest('[data-slot="aui_thread-viewport"]'), rootMargin: "200px 0px 0px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, onGrowWindow]);
  return (
    <div ref={ref} data-slot="otto_window-sentinel" className="flex justify-center">
      <button
        type="button"
        onClick={onGrowWindow}
        className="text-muted-foreground/70 hover:text-muted-foreground rounded-full px-3 py-1 text-xs transition-colors"
      >
        显示更早的消息（还有 {hiddenCount} 条）
      </button>
    </div>
  );
};


const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        variant="outline"
        className="aui-thread-scroll-to-bottom dark:border-border dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const ThreadWelcome: FC = () => {
  return (
    <div className="aui-thread-welcome-root mb-6 flex flex-col items-center px-4 text-center">
      <h1 className="aui-thread-welcome-message-inner text-2xl font-medium tracking-tight transition-[opacity,transform] duration-200 ease-strong starting:opacity-0 starting:translate-y-1 motion-reduce:transition-opacity motion-reduce:starting:translate-y-0">
        How can I help you today?
      </h1>
    </div>
  );
};

// 本仓改动:分组表搬到 lib/partGrouping.ts —— 思考(group-reasoning)与工具时间线
// (group-tool)分家、旁白算在工具那边,这几条判断是本仓的,该能单独验
const GROUP_PARTS_BY = OTTO_GROUP_PARTS_BY;

const AssistantMessage: FC = () => {
  const {
    ToolFallback: ToolFallbackComponent = ToolFallback,
    Source: SourceComponent = Sources,
    ToolGroup,
    ReasoningGroup,
    MessageFooter: MessageFooterComponent,
  } = useContext(ThreadComponentsContext);

  const ACTION_BAR_PT = "pt-1.5";
  // Keep the action bar inside the contained root's paint box, then cancel its reserved space in flow.
  const ACTION_BAR_HEIGHT = `min-h-7.5 ${ACTION_BAR_PT}`;
  // 本仓改动:页脚只挂在 turn 的最终回复上(投影把 turnTiming 只给那一条,见
  // aui/toThreadMessages.ts)。中间那些"1 tool call"消息没页脚,就不给它留页脚的
  // 位置 —— 原先每条都预留 min-h-7.5 + pt-1.5,一串工具调用之间就隔出 60px 的空
  const hasFooter = useAuiState(
    (s) => s.message.metadata.custom["turnTiming"] !== undefined,
  );
  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className={cn(
        "relative transition-[opacity,transform] duration-150 ease-strong starting:opacity-0 starting:translate-y-1 motion-reduce:transition-opacity motion-reduce:starting:translate-y-0 [contain-intrinsic-size:auto_200px] [content-visibility:auto]",
        hasFooter && "-mb-7.5 pb-7.5",
      )}
    >
      <div
        data-slot="aui_assistant-message-content"
        className="text-foreground px-2 leading-relaxed wrap-break-word"
      >
        <MessagePrimitive.GroupedParts groupBy={GROUP_PARTS_BY}>
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought":
                // 过程区:只是个容器,自己不折叠 —— 折叠头在下面两个子组身上。
                // gap 在这一层给:思考头和工作头一上一下交替,两条 trigger 自己的
                // py 加起来只有几 px,不撑开就糊成一坨;给在子组身上则会漏到
                // 过程区外面(思考的 mb-4 就是这么冒出来的,见 PR #575)
                return (
                  <div
                    data-slot="aui_chain-of-thought"
                    className="flex flex-col gap-y-2"
                  >
                    {children}
                  </div>
                );
              case "group-tool":
                // 工具(+旁白)收成一条 Tool Timeline;思考不在这里,它在 group-reasoning
                if (ToolGroup) {
                  return <ToolGroup group={part}>{children}</ToolGroup>;
                }
                return (
                  <ToolGroupRoot variant="ghost">
                    <ToolGroupTrigger
                      count={part.indices.length}
                      active={part.status.type === "running"}
                    />
                    <ToolGroupContent>{children}</ToolGroupContent>
                  </ToolGroupRoot>
                );
              case "group-reasoning": {
                if (ReasoningGroup) {
                  return (
                    <ReasoningGroup group={part}>{children}</ReasoningGroup>
                  );
                }
                const running = part.status.type === "running";
                return (
                  <ReasoningRoot streaming={running}>
                    <ReasoningTrigger active={running} />
                    <ReasoningContent aria-busy={running}>
                      <ReasoningText>{children}</ReasoningText>
                    </ReasoningContent>
                  </ReasoningRoot>
                );
              }
              case "group-sources":
                return (
                  <div
                    data-slot="aui_assistant-message-sources"
                    className="flex flex-wrap items-center gap-1.5 py-1"
                  >
                    {children}
                  </div>
                );
              case "source":
                return <SourceComponent {...part} />;
              case "text":
                return <MarkdownText />;
              case "reasoning":
                return <Reasoning {...part} />;
              case "tool-call":
                return part.toolUI ?? <ToolFallbackComponent {...part} />;
              case "data":
                return part.dataRendererUI;
              case "file":
                return (
                  <div data-slot="aui_assistant-message-file" className="py-1">
                    <File {...part} />
                  </div>
                );
              case "image":
                return (
                  <div data-slot="aui_assistant-message-image" className="py-1">
                    <Image {...part} />
                  </div>
                );
              case "indicator":
                return (
                  <span
                    data-slot="aui_assistant-message-indicator"
                    className="animate-pulse font-sans"
                    aria-label="Assistant is working"
                  >
                    {"●"}
                  </span>
                );
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        {/* 本仓改动:不画上游那个 message 级的错误框。它渲染的是英文的
            "An error occurred"(assistant-ui 的默认文案,拿不到具体原因),
            而本仓的失败**本来就在时间线上有一条**:turn 失败那条审计行,中文、
            带服务商原话、还带重试出口(components/TurnErrorState.tsx)。
            两个框说同一件事,其中一个还说得更少。
            消息的 status(incomplete/error|cancelled)保留 —— assistant-ui 内部
            要靠它判断这条消息是不是还在跑 */}
      </div>

      {hasFooter && <div
        data-slot="aui_assistant-message-footer"
        // 本仓改动:改成竖排。上游把「页脚数字」和「复制/重跑/更多」挤在同一行,
        // 而本仓的页脚是一整行数字(耗时·吞吐·token·花费),四组数后面再接三颗
        // 图标钮,这一行就同时是读物和控件 —— 眼睛先要把图标从数字里挑出来。
        // 拆成两行:上面一行只读,下面一行只按
        className={cn("ms-2 flex flex-col items-start gap-1", ACTION_BAR_HEIGHT)}
      >
        {/* 本仓改动:不渲染 BranchPicker。对话分支要 adapter 提供 setMessages,
            而本仓刻意不给(ADR-0036:给了就等于凭空长出一条绕开事件日志的写路径)。
            实测它仍会冒出「< 2/2 >」——切过去什么也不会发生,是个只承诺不兑现的控件 */}
        {MessageFooterComponent ? <MessageFooterComponent /> : null}
      </div>}
    </MessagePrimitive.Root>
  );
};

const UserFilePart: FileMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-file" className="py-1">
    <File {...part} />
  </div>
);

const UserImagePart: ImageMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-image" className="py-1">
    <Image {...part} />
  </div>
);

/** 后台任务回注的结果卡（issue #452 / ADR-0109）。
    居中、默认折叠成一行，展开才摊全文。
    - **居中**：时间线上系统事件的惯用位。右对齐的圆角气泡再怎么调灰，扫一眼
      仍然是「我发的」——这正是要治的那句「觉得自己莫名其妙发一条消息」。
    - **默认折叠**：回注正文是命令的完整输出（最长 8000 字符，见 formatCompletion），
      摊在时间线上会把真正的对话挤没。任务本身已经在输入框上方的面板里露过脸，
      这里只需要一个「结果落地了」的锚点。
    - **展开态没有出场动效**：这是键盘/鼠标一按就要看到的东西，动效只会让它显得慢。
      高度动画同理不做——正文可以很长，animate height 要么抖要么卡。 */
function BackgroundResultCard({
  taskIds,
  children,
}: {
  taskIds: string[];
  children: ReactNode;
}) {
  // 标题只用事件上的 id，不去正文里认 `[后台任务 bg-N 完成]` 那个前缀
  // ——ADR-0103 已经把「靠前缀反解」那条路否掉过一次。
  // 旧日志（#452 之前）没有 taskIds，那时只能说"后台任务"
  const label = taskIds.length > 0 ? taskIds.join(" · ") : "后台任务";
  return (
    <NotFromYouCard origin="background" label={label} suffix="的结果 · 不是你发的">
      {children}
    </NotFromYouCard>
  );
}

/** 退化循环护栏注的那句话（issue #891）。和后台结果同一张卡，两处不同：
    - **默认展开**：正文只有几行，而且它要治的病正是「没人注意到出事了」——
      折叠起来等于把唯一的信号又藏了一遍；
    - 图标换成警示：这不是「有结果落地了」，是「它在原地打转」。 */
function LoopGuardCard({ children }: { children: ReactNode }) {
  return (
    <NotFromYouCard
      origin="loop_guard"
      label="打转提醒"
      suffix="Mr Otto 在重复同样的操作 · 不是你发的"
      icon={<TriangleAlertIcon className="size-3 shrink-0" />}
      defaultOpen
    >
      {children}
    </NotFromYouCard>
  );
}

function NotFromYouCard({
  origin,
  label,
  suffix,
  icon,
  defaultOpen = false,
  children,
}: {
  origin: string;
  label: string;
  suffix: string;
  icon?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      data-role="user"
      data-origin={origin}
      className="flex flex-col items-center px-2 transition-[opacity,transform] duration-150 ease-strong starting:translate-y-1 starting:opacity-0 motion-reduce:transition-opacity motion-reduce:starting:translate-y-0"
    >
      <div className="w-full max-w-[min(100%,42rem)] overflow-hidden rounded-[10px] border border-border/60 bg-muted/40">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] text-muted-foreground transition-colors duration-[120ms] hover:bg-foreground/[0.04]"
        >
          {icon ?? <TerminalIcon className="size-3 shrink-0" />}
          <span className="font-mono">{label}</span>
          <span className="truncate">{suffix}</span>
          <ChevronDownIcon
            className={cn(
              "ml-auto size-3.5 shrink-0 transition-transform duration-150 ease-strong motion-reduce:transition-none",
              open && "rotate-180"
            )}
          />
        </button>
        {open && (
          // whitespace-pre-wrap 是必需的:回注正文是命令的原始输出,
          // 换行就是它的结构(exit code 一行、stdout 一行)。用户气泡那份 pre-wrap
          // 来自 .aui-user-message-content,这张卡不走那个类,得自己声明
          <div className="border-t border-border/60 px-3 py-2 font-mono text-[12px] whitespace-pre-wrap text-muted-foreground wrap-break-word">
            {children}
          </div>
        )}
      </div>
    </MessagePrimitive.Root>
  );
}

const UserMessage: FC = () => {
  // 本仓改动:附件槽默认仍是上游的 UserMessageAttachments(它读 message.attachments,
  // 本仓一直是空的),有槽值时换成 OttoUserAttachments(读 metadata.custom.otto)
  const {
    UserAttachments: UserAttachmentsComponent = UserMessageAttachments,
    UserText,
  } = useContext(ThreadComponentsContext);
  // 本仓改动(issue #428 起,issue #452 / ADR-0109 改定):后台任务回注的消息载体
  // 也是 user_message,但它不是人打的字。事件上带着 origin,别让 UI 去猜。
  //
  // #428 那次只做了「静音气泡 + 一行来源标记」,位置和对齐没动,理由是
  // 「挪到左边会让时间线读起来像模型在自言自语」。那个顾虑成立,但它反对的是
  // **挪到左边**,没覆盖到居中这一档 —— 而居中恰恰是时间线上系统事件的惯用位:
  // 读起来是「发生了一件事 → 模型回应它」。右对齐的圆角气泡再怎么调灰,
  // 扫一眼仍然是「我发的」,这正是维护者反馈的那句「觉得自己莫名其妙发一条消息」。
  const otto = useAuiState(
    (s) => s.message.metadata.custom["otto"] as SessionEvent | undefined,
  );
  if (otto?.type === "user_message" && otto.origin !== undefined) {
    const parts = (
      <MessagePrimitive.Parts
        components={{
          File: UserFilePart,
          Image: UserImagePart,
          ...(UserText ? { Text: UserText } : {}),
        }}
      />
    );
    // 两种「不是你发的」共用居中卡片，各自的标题/默认展开见各自的组件
    return otto.origin === "loop_guard" ? (
      <LoopGuardCard>{parts}</LoopGuardCard>
    ) : (
      <BackgroundResultCard taskIds={otto.backgroundTaskIds ?? []}>{parts}</BackgroundResultCard>
    );
  }
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 transition-[opacity,transform] duration-150 ease-strong starting:opacity-0 starting:translate-y-1 motion-reduce:transition-opacity motion-reduce:starting:translate-y-0 [contain-intrinsic-size:auto_200px] [content-visibility:auto] [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <UserAttachmentsComponent />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div className="aui-user-message-content peer rounded-[12px_12px_2px_12px] bg-primary px-3 py-2 text-primary-foreground wrap-break-word empty:hidden">
          <MessagePrimitive.Parts
            components={{
              File: UserFilePart,
              Image: UserImagePart,
              ...(UserText ? { Text: UserText } : {}),
            }}
          />
        </div>
        {/* 本仓改动:用户消息那支「编辑」笔不画了。adapter 刻意没接 onEdit
            (日志 append-only,本仓没有消息编辑也没有对话分支,见 aui/ottoAdapter.ts),
            运行时据此把 capabilities.edit 算成 false —— 那颗钮渲染出来就是
            disabled 的,点下去什么也不会发生。一颗永远点不动的钮,不如不画。
            下面的 EditComposer 保留:它是上游的编辑态版式,将来真接了 onEdit
            还要用它,删掉只会让升级时更难对 */}
      </div>

      {/* 本仓改动:同上,用户消息这一侧的分支选择器也不渲染 */}
    </MessagePrimitive.Root>
  );
};

const EditComposer: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="flex flex-col px-2 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <ComposerPrimitive.Root className="aui-edit-composer-root border-border/60 dark:border-muted-foreground/15 ms-auto flex w-full max-w-[85%] cursor-text flex-col rounded-(--composer-radius) border bg-(--composer-bg)">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base outline-none"
          autoFocus
        />
        <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 rounded-full px-3.5"
            >
              Cancel
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm" className="h-8 rounded-full px-3.5">
              Update
            </Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({
  className,
  ...rest
}) => {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn(
        "aui-branch-picker-root text-muted-foreground -ms-2 me-2 inline-flex items-center text-xs",
        className,
      )}
      {...rest}
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip="Previous">
          <ChevronLeftIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="aui-branch-picker-state font-medium">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip="Next">
          <ChevronRightIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};
