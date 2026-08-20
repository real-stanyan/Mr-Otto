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
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  type AssistantState,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  groupPartByType,
  MessagePrimitive,
  ThreadPrimitive,
  type FileMessagePartComponent,
  type SourceMessagePartComponent,
  type TextMessagePartComponent,
  type ImageMessagePartComponent,
  type ToolCallMessagePartComponent,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RefreshCwIcon,
} from "lucide-react";
import {
  createContext,
  useContext,
  type ComponentType,
  type FC,
  type PropsWithChildren,
  type Ref,
} from "react";

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
  /** 本仓加的槽:IPC 层瞬时发送失败的提示条(会话不存在/turn 冲突——消息压根
      没进事件日志,与 turn_ended(error) 是不同的失败类别,见 store.ts send() 的
      注释)。它不是消息、也不是事件投影,同样挂在 ViewportFooter 而不是消息流里。
      上游 registry 没有这个槽 —— 升级时要人工合 */
  ErrorBanner?: ComponentType | undefined;
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

const ThreadHistorySkeleton: FC = () => (
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
}) => {
  const isEmpty = useAuiState(isNewChatView);

  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadRoot isEmpty={isEmpty} viewportRef={viewportRef} />
    </ThreadComponentsContext.Provider>
  );
};

const ThreadRoot: FC<{
  isEmpty: boolean;
  viewportRef: Ref<HTMLDivElement> | undefined;
}> = ({ isEmpty, viewportRef }) => {
  const {
    Welcome = ThreadWelcome,
    RunIndicator: RunIndicatorComponent,
    ErrorBanner: ErrorBannerComponent,
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
        turnAnchor="top"
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
            className="mb-14 flex flex-col gap-y-6 empty:hidden"
          >
            <ThreadPrimitive.Messages>
              {() => <ThreadMessage />}
            </ThreadPrimitive.Messages>
          </div>

          {/* 本仓改动:这一条不铺底色、也不留那么厚的下边距。
              上游这里是"消息区 + 输入框"一整块的收尾,底色是为了把滚上来的正文挡在
              输入框后面;而本仓的输入框住在 Thread 外面(见下方注释),这一条footer
              里只剩跟进建议/运行指示/错误条——都是自带底色的小块。
              铺一层不透明底色 = 在正文和输入框之间横一条实心带子,把两者切开;
              下边距同理:建议是"接着说什么"的入口,它该贴着输入框,不是浮在半空 */}
          <ThreadPrimitive.ViewportFooter
            className={cn(
              "aui-thread-viewport-footer flex flex-col gap-2 overflow-visible pb-1",
              !isEmpty &&
                "sticky bottom-0 mt-auto rounded-t-(--composer-radius)",
            )}
          >
            {ErrorBannerComponent ? <ErrorBannerComponent /> : null}
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

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/10 text-destructive dark:bg-destructive/5 mt-2 rounded-md border p-3 text-sm dark:text-red-200">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

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

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="relative -mb-7.5 pb-7.5 transition-[opacity,transform] duration-150 ease-strong starting:opacity-0 starting:translate-y-1 motion-reduce:transition-opacity motion-reduce:starting:translate-y-0 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <div
        data-slot="aui_assistant-message-content"
        className="text-foreground px-2 leading-relaxed wrap-break-word"
      >
        <MessagePrimitive.GroupedParts
          groupBy={groupPartByType({
            reasoning: ["group-chainOfThought", "group-reasoning"],
            "tool-call": ["group-chainOfThought", "group-tool"],
            "standalone-tool-call": [],
            // 本仓加的:来源 chip 挨在一起时排成一行(每条自己一行会把回复撑散)。
            // 与 tool 组不同,这一组不进 chain-of-thought:它是"这次回答引了哪些页",
            // 属于结论的一部分,不该跟着思考过程一起折叠
            source: ["group-sources"],
          })}
        >
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought":
                return <div data-slot="aui_chain-of-thought">{children}</div>;
              case "group-tool":
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
        <MessageError />
      </div>

      <div
        data-slot="aui_assistant-message-footer"
        className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}
      >
        {/* 本仓改动:不渲染 BranchPicker。对话分支要 adapter 提供 setMessages,
            而本仓刻意不给(ADR-0036:给了就等于凭空长出一条绕开事件日志的写路径)。
            实测它仍会冒出「< 2/2 >」——切过去什么也不会发生,是个只承诺不兑现的控件 */}
        {MessageFooterComponent ? <MessageFooterComponent /> : null}
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-assistant-action-bar-root text-muted-foreground col-start-3 row-start-2 -ms-1 flex gap-1 transition-opacity duration-200 ease-strong starting:opacity-0"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy">
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="transition-[opacity,transform] duration-200 ease-strong starting:opacity-0 starting:scale-50 motion-reduce:transition-opacity motion-reduce:starting:scale-100" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="transition-[opacity,transform] duration-150 ease-strong starting:opacity-0 starting:scale-75 motion-reduce:transition-opacity motion-reduce:starting:scale-100" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton tooltip="Refresh">
          <RefreshCwIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <TooltipIconButton
            tooltip="More"
            className="data-[state=open]:bg-accent"
          >
            <MoreHorizontalIcon />
          </TooltipIconButton>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="aui-action-bar-more-content menu-pop bg-popover text-popover-foreground z-50 min-w-[8rem] overflow-hidden rounded-xl border p-1.5"
        >
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className="aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none">
              <DownloadIcon className="size-4" />
              Export as Markdown
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
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

const UserMessage: FC = () => {
  // 本仓改动:附件槽默认仍是上游的 UserMessageAttachments(它读 message.attachments,
  // 本仓一直是空的),有槽值时换成 OttoUserAttachments(读 metadata.custom.otto)
  const {
    UserAttachments: UserAttachmentsComponent = UserMessageAttachments,
    UserText,
  } = useContext(ThreadComponentsContext);
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 transition-[opacity,transform] duration-150 ease-strong starting:opacity-0 starting:translate-y-1 motion-reduce:transition-opacity motion-reduce:starting:translate-y-0 [contain-intrinsic-size:auto_200px] [content-visibility:auto] [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <UserAttachmentsComponent />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div className="aui-user-message-content peer bg-primary text-primary-foreground rounded-[12px_12px_2px_12px] px-3 py-2 wrap-break-word empty:hidden">
          <MessagePrimitive.Parts
            components={{
              File: UserFilePart,
              Image: UserImagePart,
              ...(UserText ? { Text: UserText } : {}),
            }}
          />
        </div>
        <div className="aui-user-action-bar-wrapper absolute start-0 top-1/2 -translate-x-full -translate-y-1/2 pe-2 peer-empty:hidden rtl:translate-x-full">
          <UserActionBar />
        </div>
      </div>

      {/* 本仓改动:同上,用户消息这一侧的分支选择器也不渲染 */}
    </MessagePrimitive.Root>
  );
};

const UserActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-user-action-bar-root flex flex-col items-end"
    >
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton tooltip="Edit" className="aui-user-action-edit">
          <PencilIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
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
