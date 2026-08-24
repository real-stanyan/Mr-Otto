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
  AuiIf,
  type AssistantState,
  BranchPickerPrimitive,
  ComposerPrimitive,
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
  ChevronLeftIcon,
  ChevronRightIcon,
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
            // 本仓改动:相邻两条 assistant 消息(一 turn 里的几波工具调用各是一条)
            // 之间收到 gap-y-6 的一半 —— 它们是同一个回答的连续步骤,和思考行
            // 与工具行之间的间距一档,不该像换了个话题
            className="mb-14 flex flex-col gap-y-6 empty:hidden [&>[data-role=assistant]+[data-role=assistant]]:-mt-3"
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

// 模块级常量而不是渲染内联:内联调用每次渲染都产出新的分组函数引用,
// 每条 assistant 消息每次重渲染都要重新分组(同 markdown-text.tsx:28 的既有写法)
const GROUP_PARTS_BY = groupPartByType({
  reasoning: ["group-chainOfThought", "group-reasoning"],
  "tool-call": ["group-chainOfThought", "group-tool"],
  "standalone-tool-call": [],
  // 本仓加的:来源 chip 挨在一起时排成一行(每条自己一行会把回复撑散)。
  // 与 tool 组不同,这一组不进 chain-of-thought:它是"这次回答引了哪些页",
  // 属于结论的一部分,不该跟着思考过程一起折叠
  source: ["group-sources"],
});

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
