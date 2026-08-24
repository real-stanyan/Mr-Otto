// Thread 的组装 —— assistant-ui 出骨架,本仓只补三样东西。
//
// 「保留 Mr Otto 现有视觉」这条决定的落点在 SystemMessage:八类审计行直接喂回
// 既有的 EventRow,一行没重写,也不需要第二条渲染路径。

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ComponentType, FC, Ref } from "react";
import { useAuiState } from "@assistant-ui/react";
import type { PartState, ToolCallMessagePartProps } from "@assistant-ui/react";
import { ThinkingOrb } from "thinking-orbs";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker.js";
import { Thread, type ThreadComponents } from "../components/assistant-ui/thread.js";
import {
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "../components/assistant-ui/reasoning.js";
import { ToolFallback } from "../components/assistant-ui/tool-fallback.js";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "../components/assistant-ui/tool-group.js";
import { Sources } from "../components/assistant-ui/sources.js";
import { createDirectiveText } from "../components/assistant-ui/directive-text.js";
import { Sparkles } from "lucide-react";
import { ToolLiveTail } from "../components/ToolLiveTail.js";
import { ToolError } from "../components/elements/tool-error.js";
import { WebSearch } from "../components/elements/web-search.js";
import { WebPreview } from "../components/elements/web-preview.js";
import { MemoryChips } from "../components/elements/memory-chips.js";
import { RetrievalChunks } from "../components/elements/retrieval-chunks.js";
import { DocumentReference } from "../components/elements/document-reference.js";
import { domainOf, extractPage, extractSources } from "./toolArtifacts.js";
import { chipEntryText, memoryChipsFromResult } from "./memoryChips.js";
import { parseMemoryResult, type MemoryToolResult } from "../../../shared/memoryStore.js";
import { parseSessionSearchResult, type SessionSearchResult } from "../../../shared/sessionSearch.js";
import { toDocumentProps, toRetrievalProps } from "../lib/sessionSearchCard.js";
import { bridgeErrorMessage } from "../lib/bridgeError.js";
import { MessageTiming } from "../components/elements/message-timing.js";
import { EventRow, TimelineProjectionContext } from "../components/Timeline.js";
import { buildToolIndex } from "../lib/toolIndex.js";
import { groupSubagentSpawns } from "../lib/subagentTimeline.js";
import { UserAttachments } from "../components/UserAttachments.js";
import { CHIP } from "../timelineStyles.js";
import { thinkingLabel } from "../lib/thinkingLabel.js";
import { useChat } from "../store.js";
import { spawnedToolCallIds } from "../lib/subagentTimeline.js";
import { totalTokens } from "../../../session/deriveUsage.js";
import { toThreadMessages } from "./toThreadMessages.js";
import { ottoDirectiveFormatter } from "./ottoDirectives.js";
import { liveTimingStats, turnTimingStats, type TurnTimingAgg } from "./messageTiming.js";
import { contextBreakdown, estimateTokens } from "../../../shared/contextEstimate.js";
import type { ToolDefinition } from "../../../model/adapter.js";
import type { Section } from "../../../session/deriveSections.js";
import type { SessionEvent, ToolCallRequest } from "../../../session/events.js";
import { toolFilePath, toolSummary } from "../../../shared/toolSummary.js";
import { FileTypeIcon } from "../components/FileTypeIcon.js";
import type { OrbState } from "../../../shared/toolSummary.js";

/** 审计行:原始事件挂在 metadata.custom.otto 上(Task 3 的投影)。metadata.custom
    的类型是 Record<string, unknown> ——不认识 SessionEvent,这一转型没有更窄的写法。
    isLast 必须传:turn_ended(error) 那条行只在最后一条上挂重试键 ——
    重发的是「上一条用户消息」,对历史里的旧失败行没有意义 */
const SystemMessage: ComponentType = () => {
  const event = useAuiState(
    (s) => s.message.metadata.custom["otto"] as SessionEvent | undefined,
  );
  const isLast = useAuiState((s) => s.message.isLast);
  if (event === undefined) return null;
  return <EventRow event={event} isLast={isLast} />;
};

/** 用户附件:原始事件挂在 metadata.custom.otto 上,交给既有的 UserAttachments 渲染。
    它自己走 window.otter.attachmentDataUrl 懒取图片、自己有内存缓存、
    图片丢失时自己降级成占位卡 —— 这些都不该在投影层重做一遍。
    命名 OttoUserAttachments(不叫 UserMessageAttachments)——那个名字已经是
    thread.tsx 从 attachment.js 引入的上游组件,同名会读着别扭 */
const OttoUserAttachments: ComponentType = () => {
  const event = useAuiState(
    (s) => s.message.metadata.custom["otto"] as SessionEvent | undefined,
  );
  if (event === undefined || event.type !== "user_message") return null;
  return <UserAttachments attachments={event.attachments} textFiles={event.textFiles} />;
};

/** 搜索这一步:查询词 + 读回来的来源。
    结果解析用的是投影层那个宽松的 extractSources —— web_search 的输出格式
    没有任何保证(见 toolArtifacts.ts 的注释),捞不到就一条不显示,不猜。
    点一条走内嵌浏览器,理由同 OttoSource:Electron 里 target="_blank"
    等于弹一个 Otto 管不着的裸窗口 */
const WebSearchCard: FC<{ part: ToolCallMessagePartProps }> = ({ part }) => {
  const sessionId = useChat((s) => s.sessionId);
  const openBrowserPanel = useChat((s) => s.openBrowserPanel);
  const query = (part.args as { query?: unknown } | undefined)?.query;
  const searching = part.result === undefined;
  const sources =
    typeof part.result === "string" ? extractSources(part.result) : [];
  const results = sources.map((s) => ({
    title: s.title,
    domain: domainOf(s.url),
    url: s.url,
  }));

  return (
    <WebSearch
      query={typeof query === "string" ? query : part.toolName}
      results={results}
      visibleResults={results.length}
      searching={searching}
      cycle={0}
      searchingLabel="搜索中…"
      statusLabel={results.length > 0 ? `读了 ${results.length} 个来源` : "没捞到可用的链接"}
      onOpenResult={(r) => {
        if (r.url === undefined) return;
        openBrowserPanel();
        void window.otter.browserNavigate(sessionId, r.url);
      }}
      className="my-1 max-w-none"
    />
  );
};

/** memory 工具这一步:模型这次记了 / 改了哪几条,配一枚能点的「忘掉」×。
    result 是调用方(ToolFallbackWithLiveTail)已经用 parseMemoryResult 解析好的
    结果——那边判过 null(解析不出来就落回通用工具行),这里不用再解析一遍。
    忘掉之后 chip 只在本地隐藏(forgotten 这个 state),不改事件日志:
    forgetMemory 已经把 remove 操作落成一条新的 memory_user_edit 事件,
    这一条历史工具卡还是"当时发生的事"的忠实记录。
    forgetMemory 失败(比如条目已经不在文件里了)要把 chip 退回来——
    不然本地状态和磁盘对不上,用户以为忘掉了其实压根没生效 */
const MemoryCard: FC<{ result: MemoryToolResult }> = ({ result }) => {
  const sessionId = useChat((s) => s.sessionId);
  const [forgotten, setForgotten] = useState<Set<string>>(new Set());
  const chips = memoryChipsFromResult(result).filter((c) => !forgotten.has(c.id));
  if (chips.length === 0) return null;
  return (
    <MemoryChips
      chips={chips}
      onForget={(id) => {
        setForgotten((prev) => new Set(prev).add(id));
        window.otter.forgetMemory(result.target, chipEntryText(id), sessionId).catch((e: unknown) => {
          setForgotten((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          console.error("forgetMemory 失败:", bridgeErrorMessage(e));
        });
      }}
      className="my-1"
    />
  );
};

/** session_search 的 discovery 形态:按 session 去重后的候选段落。
    result 是调用方(ToolFallbackWithLiveTail)已经用 parseSessionSearchResult 解析好的
    结果(或者还没出结果时现拼的一份占位 result,见下面 searching 分支),这里只管
    映射成 element 的 props(纯函数在 lib/sessionSearchCard.ts,方便单测)。
    searching 默认 false:大多数调用方走的是"已经解析出 discovery 结果"那条路径,
    part.result 早已是字符串,天然不在搜索中。真正会传 true 的是
    ToolFallbackWithLiveTail 里那条"还没出结果、但 args.query 已经能看出这是一次
    discovery 调用"的分支——同 WebSearchCard 的 pre-result 写法,判据也和
    inferMode(src/tools/sessionSearch.ts)的第一条一致(query 存在即 discovery),
    但这里是本地重写的一行判断,没有 import src/tools/(渲染进程不许 import 那边,
    硬规则,见 AGENTS.md) */
const RetrievalCard: FC<{ result: SessionSearchResult; searching?: boolean }> = ({
  result,
  searching = false,
}) => {
  const { query, chunks, visibleCount } = toRetrievalProps(result);
  return (
    <RetrievalChunks
      query={query}
      chunks={searching ? [] : chunks}
      visibleCount={searching ? 0 : visibleCount}
      searching={searching}
      searchingLabel="检索中…"
      statusLabel={chunks.length > 0 ? `命中 ${chunks.length} 段` : "没捞到"}
      className="my-1 max-w-none"
    />
  );
};

/** session_search 的 read 形态:整段会话的目录 + 命中的锚点。点一条锚点不是"跳到
    那一页"(这不是分页文档,是一段会话),而是切过去那个会话本身——resume 是
    store 里切会话的 action(见 store.ts,底层是 window.otter.resumeSession)。
    activePage 恒为 0:这里没有"正在看第几页"的概念,只用它换来 DocumentReference
    的高亮态别乱选 */
const DocumentCard: FC<{ result: SessionSearchResult }> = ({ result }) => {
  const document = result.document;
  if (!document) return null;
  const { title, pages, anchors } = toDocumentProps(result);
  return (
    <DocumentReference
      title={title}
      pages={pages}
      anchors={anchors}
      activePage={0}
      onJump={() => void useChat.getState().resume(document.sessionId)}
      className="my-1 max-w-none"
    />
  );
};

/** 读网页这一步:browser_read / web_extract。
    通用工具行只会写「browser_read」+ 一坨折起来的 JSON,而这一步真正发生的事是
    "打开了这个地址,读回了这些字"—— web-preview 的地址栏 + 正文框正好是这句话。
    地址是可点的:走 Otto 自己的内嵌浏览器(理由同 OttoSource)。
    没有刷新钮:重读一次是一件新的事,得走新的 tool_call 落盘(同 ToolError 的 actions={null}) */
const WebPageCard: FC<{ part: ToolCallMessagePartProps }> = ({ part }) => {
  const sessionId = useChat((s) => s.sessionId);
  const openBrowserPanel = useChat((s) => s.openBrowserPanel);
  const loading = part.result === undefined;
  const argUrl = (part.args as { url?: unknown } | undefined)?.url;
  const page =
    typeof part.result === "string"
      ? extractPage(part.result, argUrl)
      : { url: typeof argUrl === "string" ? argUrl : null, title: null, body: "" };

  const url = page.url;

  return (
    <WebPreview
      origin={url ?? "当前页面"}
      loading={loading}
      className="my-1 max-w-none"
      {...(url === null
        ? {}
        : {
            onOpenExternal: () => {
              openBrowserPanel();
              void window.otter.browserNavigate(sessionId, url);
            },
          })}
    >
      {/* 只给一眼:读回来的正文常常是几千字,全铺出来会把这条回复顶出屏外。
          要全文的人点地址进浏览器看,那才是它本来的样子 */}
      <div className="flex flex-col gap-1 px-3 py-2.5">
        {page.title !== null && (
          <span className="truncate text-[13px] font-medium">{page.title}</span>
        )}
        <p className="text-muted-foreground line-clamp-6 text-xs leading-relaxed whitespace-pre-wrap">
          {page.body}
        </p>
      </div>
    </WebPreview>
  );
};

/** 工具组:默认折起,出了错的那一组**不自动弹开**,只在折叠头右边挂一枚黄色
    三角感叹号。一屏五个 read_file 谁也不想逐个看,但"这一步没成"也不能
    藏得无声无息 —— 标一下,要看的人自己点开 */
const OttoToolGroup: NonNullable<ThreadComponents["ToolGroup"]> = ({ group, children }) => {
  const failed = useAuiState((s) =>
    group.indices.some((i) => {
      const part = s.message.content[i];
      return part?.type === "tool-call" && part.isError === true;
    }),
  );

  return (
    <ToolGroupRoot variant="ghost">
      <ToolGroupTrigger
        count={group.indices.length}
        active={group.status.type === "running"}
        warning={failed}
      />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  );
};

/** 工具行那一句话。上游写死的是 "Used tool: read_file" —— 中文界面里冒一句英文
    是一回事;只报工具名、不报**动的是哪个文件**是更要紧的一回事:这一行最常见的
    两种就是读文件和写文件,而 "read_file" 这个词对读的人没有信息量,"App.tsx" 才有。

    动词/目标/统计三段沿用 toolSummary(工具折叠组的摘要也读它,两处措辞一致);
    读写文件时在目标前面加一枚类型图标 —— 一段连续的工具行里,眼睛先认出的是
    颜色和形状,不是第七行那个文件名的后缀。 */
function ToolRowLabel({ name, args }: { name: string; args: unknown }) {
  const call: ToolCallRequest = { id: "", name, args };
  const { verb, target, stat } = toolSummary(call);
  const path = toolFilePath(call);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0">{verb}</span>
      {path !== null && <FileTypeIcon path={path} className="size-[15px]" />}
      {target !== "" && (
        // 封顶 42ch:bash 的目标是一整条命令,不封顶会把这一行拉到屏幕外
        <span className="max-w-[42ch] truncate font-mono text-[13px] text-foreground/75">
          {target}
        </span>
      )}
      {stat !== "" && <span className="text-muted-foreground shrink-0 text-xs">{stat}</span>}
    </span>
  );
}

/** 派活出去的 task 工具行名单(spawnedToolCallIds 的结果)。在 OttoThread 顶层
    算一次、Context 分发——不让每条工具行自己订阅 events 各扫一遍(#115 教训,
    同下面 SectionAnchorsContext 的理由) */
const SpawnedToolCallsContext = createContext<ReadonlySet<string>>(new Set());

/** 工具行:用 assistant-ui 的 ToolFallback,外挂一条直播尾巴 + 一张出错卡。
    直播尾巴:ToolFallback 没有「执行中的输出」这个概念,而 bash 跑长命令时
    那条尾巴是唯一的进度信号。
    出错卡:ToolFallback 把错误塞在折叠区里,默认收着——工具失败是这一步的结论,
    收起来等于让人点开才知道刚才没成 */
const ToolFallbackWithLiveTail: NonNullable<ThreadComponents["ToolFallback"]> = (part) => {
  // 派活的那条 task 工具行压掉（issue #141）：同一次派活在时间线上还有一张
  // 派活卡，卡上已经有 agent、任务、状态、汇报和"点进子会话"的入口，
  // 工具行是同一份信息的原始形态。只压真的派出去了的那些——派活之前就失败
  // 的那次没有卡，压掉等于把唯一的报错也吞了（判据见 spawnedToolCallIds）。
  // 名单从 Context 读,不在这订阅 events:本组件每条工具行一个实例,
  // 各自订阅 + 各自全量扫一遍日志就是 #115 教训里的 O(行数×事件数)
  const spawned = useContext(SpawnedToolCallsContext);
  // label 记忆化:ToolFallback 包着 memo,内联元素每次渲染都是新引用,等于把 memo 拆了
  const label = useMemo(
    () => <ToolRowLabel name={part.toolName} args={part.args} />,
    [part.toolName, part.args]
  );
  const call: ToolCallRequest = { id: part.toolCallId, name: part.toolName, args: part.args };
  if (part.toolName === "task" && spawned.has(part.toolCallId)) return null;
  const summary = toolSummary(call);
  const path = toolFilePath(call);
  // memory 这一步换成 memory-chips element:通用工具行只会写「memory」+ 一坨
  // 折起来的 JSON。解析不出来(旧日志 / 格式变了)就落回下面的通用工具行,不猜
  if (part.toolName === "memory" && part.isError !== true) {
    const parsed = typeof part.result === "string" ? parseMemoryResult(part.result) : null;
    if (parsed) return <MemoryCard result={parsed} />;
  }
  // session_search 这一步换成 retrieval-chunks / document-reference 两张卡:discovery
  // 结果是"搜到的候选段落",read 结果是"整段会话的目录"。scroll/browse 两种形态
  // 没有对应的 element(那是"翻这一段""列最近会话",不是"给我看几条结果"),
  // parsed 为 null 或 mode 对不上就落回下面的通用工具行,不猜。
  // 还没出结果、但 args.query 已经是字符串——同 WebSearchCard 的 pre-result 写法,
  // 判据对齐 inferMode 的第一条(query 存在即 discovery),但这行判断本地重写,
  // 没有 import src/tools/ 那份 inferMode(渲染进程不许 import,硬规则)
  if (
    part.toolName === "session_search" &&
    part.isError !== true &&
    part.result === undefined &&
    typeof (part.args as { query?: unknown } | undefined)?.query === "string"
  ) {
    return (
      <RetrievalCard
        result={{ mode: "discovery", query: String((part.args as { query: string }).query), chunks: [] }}
        searching
      />
    );
  }
  if (part.toolName === "session_search" && part.isError !== true) {
    const parsed = typeof part.result === "string" ? parseSessionSearchResult(part.result) : null;
    if (parsed?.mode === "discovery" && parsed.chunks) return <RetrievalCard result={parsed} />;
    if (parsed?.mode === "read" && parsed.document) return <DocumentCard result={parsed} />;
  }
  // 搜索这一步换成 web-search element:通用工具行只会写「web_search」+ 一坨折起来的
  // JSON,而这一步真正发生的事是"用这句话去查,读回了这几条"。出错的那次不走这条路
  // (下面那张 tool-error 卡才是结论)
  if (part.toolName === "web_search" && part.isError !== true) {
    return <WebSearchCard part={part} />;
  }
  // 读网页这两条同理:换成 web-preview 那张卡(地址栏 + 正文)。出错的那次不走这条路
  if (
    (part.toolName === "browser_read" || part.toolName === "web_extract") &&
    part.isError !== true
  ) {
    return <WebPageCard part={part} />;
  }
  return (
    <>
      <ToolFallback
        {...part}
        label={label}
        // 悬停给完整路径:行里只留了 basename(短才读得快),而同名文件在
        // src/ 和 tests/ 下各有一个是常事
        {...(path !== null ? { title: path } : {})}
      />
      <ToolLiveTail
        toolCallId={part.toolCallId}
        command={summary.target || part.toolName}
        done={part.result !== undefined}
      />
      {part.isError === true && (
        <ToolError
          name={part.toolName}
          target={summary.target}
          {...(path !== null ? { filePath: path } : {})}
          message={typeof part.result === "string" ? part.result : JSON.stringify(part.result)}
          // 没有单条工具的重试/跳过:重跑一次是一件新的事,得有新的 tool_call 落盘。
          // 下一步归模型——错误就在它的上下文里
          actions={null}
          className="mt-1 max-w-none"
        />
      )}
    </>
  );
};

/** 来源 chip:点开走 Otto 自己的内嵌浏览器,不放 <a target="_blank">。
    上游 registry 的 Sources 就是一个开新标签页的 <a> —— 在 Electron 里那等于弹出
    一个 Otto 管不着的裸窗口(主窗口没有 setWindowOpenHandler,只有内嵌浏览器那块
    view 有,见 main/webContentsViewFactory.ts)。这里改成:开右侧浏览器面板 + 让
    那块 view 导航过去。navigate 自己会 ensure(sessionId) 把 view 建出来
    (main/browserHub.ts),所以不用等面板挂载完再发,没有先后顺序的坑。
    href 仍然写上:中键/复制链接地址这些浏览器原生动作还指望它,
    也让这一条在无障碍树里仍然是个链接 */
const OttoSource: NonNullable<ThreadComponents["Source"]> = (part) => {
  const sessionId = useChat((s) => s.sessionId);
  const openBrowserPanel = useChat((s) => s.openBrowserPanel);
  if (part.sourceType !== "url") return null; // 投影只产 url 型来源
  const url = part.url;
  return (
    <Sources.Root
      href={url}
      onClick={(e) => {
        e.preventDefault();
        openBrowserPanel();
        void window.otter.browserNavigate(sessionId, url);
      }}
    >
      <Sources.Icon url={url} />
      <Sources.Title>{part.title ?? url}</Sources.Title>
    </Sources.Root>
  );
};

// ─── ReasoningGroup:折叠头复刻旧版"思考 823 字 · 1.2s"(补回接线时丢掉的功能,见 Task 11) ───
//
// reasoningMs 已经投影到 message.metadata.custom.reasoningMs(toThreadMessages.ts,
// ADR-0032),但没人读——上游 ReasoningTrigger 默认只拼 "Reasoning (Xs)" 英文文案,
// 且不认字数。字数来自本组同属的 reasoning part(用 group.indices 取消息里对应下标,
// text 累加),和 reasoningMs 一起喂给 thinkingLabel()(lib/thinkingLabel.ts),
// 换上 ReasoningTrigger 新加的 label 覆盖槽(见 reasoning.tsx)。
// 默认组装原样照抄 thread.tsx 里 group-reasoning 分支的写法(ReasoningRoot streaming +
// ReasoningTrigger active + ReasoningContent aria-busy + ReasoningText),
// 唯一区别是 label 换成算出来的中文文案 —— 不走 thread.tsx 那条默认路径是因为
// duration 参数拼不出"字数 · 耗时"这个格式
const ReasoningGroupWithLabel: NonNullable<ThreadComponents["ReasoningGroup"]> = ({
  group,
  children,
}) => {
  const running = group.status.type === "running";
  const reasoningMs = useAuiState(
    (s) => s.message.metadata.custom["reasoningMs"] as number | undefined,
  );
  const reasoningText = useAuiState((s) =>
    group.indices
      .map((i) => s.message.parts[i])
      .filter((p): p is Extract<PartState, { type: "reasoning" }> => p?.type === "reasoning")
      .map((p) => p.text)
      .join(""),
  );
  return (
    // variant="ghost" = 不要外框。上游默认 outline(圆角 + 边框 + 内边距),
    // 那个框在本仓是多余的一层:折叠头本身已经是一枚可点的胶囊,
    // 外面再套一圈就成了"框里的框",而思考只是回答的一段前情,不该比正文更重
    <ReasoningRoot streaming={running} variant="ghost">
      <ReasoningTrigger active={running} label={thinkingLabel(reasoningText, reasoningMs)} />
      <ReasoningContent aria-busy={running}>
        <ReasoningText>{children}</ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
};

/** 消息页脚那一行数字:耗时 · 吞吐 · token · 花费 —— **整个 turn 的总计**。
    投影(toThreadMessages)只把 turnTiming 挂在最终那条回复上,中间几波工具调用
    的消息没有这个字段,页脚就不出现。四个值全部从日志推得出(aui/messageTiming.ts),
    这里只负责读出来交给 element,不做任何计算 */
const MessageTimingFooter: ComponentType = () => {
  const agg = useAuiState(
    (s) => s.message.metadata.custom["turnTiming"] as TurnTimingAgg | undefined,
  );
  const running = useAuiState((s) => s.message.status?.type === "running");
  if (agg === undefined) return null;
  const stats = turnTimingStats(agg);
  if (stats.length === 0) return null;
  return <MessageTiming stats={stats} streaming={running} className="w-auto" />;
};

// ─── RunIndicator:turn 运行时的相位指示器(补回接线时丢掉的功能,见 Task 11) ───
//
// 投影(toThreadMessages.ts)只在 live.content / live.reasoning 非空时才产出消息,
// turn 开始到第一个 token 到达之间没有任何消息可渲染 —— 这个指示器不认消息,
// 直接订阅 store 的 status/approval,所以它能在"消息还不存在"的这段窗口里出现。
// 以下几个纯函数原样取回自 git show d2e3357:src/renderer/src/App.tsx,不重写:
// fmtTokens(121)、fmtElapsed(126)、TurnMeta(175)、currentTool(618)、agentPhase(633)。
// 没有放回 App.tsx 再 export 回来 —— 那样 App.tsx 就要 import OttoThread.tsx
// (渲染它),OttoThread.tsx 又要 import App.tsx(用这些函数),两个模块互相 import
// 形成循环依赖。这几个函数只有这里一个消费者,直接放在这里最干净

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

/** orb 旁的那一行数字 —— 和消息页脚同一个 element(message-timing),
    区别只在数字是估的(见 aui/messageTiming.ts 的 liveTimingStats)。
    用同一个 element 是有意的:turn 跑完之后这一行会被消息页脚那一行接替,
    两者长得一样,读起来就是"同一行数字从估的变成结算过的",而不是换了个东西。

    挂载即计时——本组件只在 turn 进行中存在，出生时刻就是 turn 起点。
    1 秒一跳:再快就是抖动(毫秒位每帧都在变,眼睛只会觉得吵),再慢就不像活的 */
function TurnMeta({ events, toolDefs, output }: {
  events: SessionEvent[];
  toolDefs: ToolDefinition[];
  /** 已经吐出来的字(正文 + 思考——思考也计费) */
  output: string;
}) {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // 送进去的 ≈ 此刻上下文有多大(和上下文圆环读同一份估算,两处数字不会打架)
  const promptTokens = useMemo(() => contextBreakdown(events, toolDefs).total, [events, toolDefs]);
  // 吐出来的字跟着 1 秒的钟重估,不跟着 token 流:output 每个 token 都变,
  // 每次都对全量已累积文本重估是 O(n²)——回答越长掉帧越狠。数字本来就 1 秒一跳,
  // 估算也只需要 1 秒一次(deps 刻意只挂 now,不挂 output)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const completionTokens = useMemo(() => estimateTokens(output), [now]);
  const stats = liveTimingStats({
    elapsedMs: now - start,
    promptTokens,
    completionTokens,
  });
  return <MessageTiming stats={stats} streaming className="w-auto" />;
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
  compacting?: boolean;
  streamingThinking: string;
  streamingText: string;
  tool: ToolCallRequest | null;
}): { orb: OrbState; label: string } {
  if (opts.hasApproval) return { orb: "listening", label: "等待审批…" };
  if (opts.status !== "running") return { orb: "breathing", label: "空闲" };
  // 压缩上下文:主进程把它复用成 running 灯,靠 store 里的瞬时标记分辨。
  // weaving = 把一长段历史织成一份摘要,比"思考"的旋转更贴这件事
  if (opts.compacting) return { orb: "weaving", label: "压缩中…" };
  if (opts.tool?.name === "read_file") return { orb: "searching", label: "检索中…" };
  if (opts.tool) return { orb: "working", label: "执行中…" };
  if (opts.streamingText) return { orb: "solving", label: "作答中…" };
  return { orb: "composing", label: "思考中…" }; // reasoning 或模型首次调用：都还在想
}

/** ViewportFooter 里的相位指示器:数据照旧从 store 订阅(statusBySession / approvals /
    events / streamingBySession)。status 不是 running 且没有挂起审批就不渲染——
    这两个条件合起来正是原来 App.tsx 里 `(status === "running" || approval !== null)` */
const RunIndicator: ComponentType = () => {
  const events = useChat((s) => s.events);
  const toolDefs = useChat((s) => s.toolDefs);
  const status = useChat((s) => s.statusBySession[s.sessionId] ?? "idle");
  const approval = useChat((s) => s.approvals[s.sessionId] ?? null);
  const streamingText = useChat((s) => s.streamingBySession[s.sessionId]?.content ?? "");
  const streamingThinking = useChat((s) => s.streamingBySession[s.sessionId]?.reasoning ?? "");
  const compacting = useChat((s) => s.compactingBySession[s.sessionId] === true);

  const turnPhase = agentPhase({
    status,
    hasApproval: approval !== null,
    compacting,
    streamingThinking,
    streamingText,
    tool: currentTool(events),
  });

  if (status !== "running" && approval === null) return null;

  return (
    <Marker role="status" className="py-[2px] text-[13px]">
      <MarkerIcon className="size-5">
        <ThinkingOrb state={turnPhase.orb} size={20} theme="auto" />
      </MarkerIcon>
      <MarkerContent className="shimmer">{turnPhase.label}</MarkerContent>
      <span className="ml-auto shrink-0 text-xs">
        <TurnMeta events={events} toolDefs={toolDefs} output={streamingText + streamingThinking} />
      </span>
    </Marker>
  );
};

// ─── MessageAnchor:会话分区轨的锚点(合并 main 后重接,见 App.tsx 里 SectionRail 的挂载) ───
//
// 每条 assistant-ui 消息的 id 就是产出它的那条 SessionEvent 的 seq(toThreadMessages.ts
// 里三处 push 都是 `id: String(e.seq)`),分区起点(Section.startSeq)也是 seq——两边
// 同一把尺子。但严格相等会漏锚点:分区起点可能落在一条不产出消息的事件上
// (tool_result、被 isAuditEvent 过滤掉的事件…),这条 seq 上没有消息可挂。
// 改成"沿消息顺序找第一个 id >= startSeq 的消息",跟旧 App.tsx 里 sectionAnchors 的算法
// 一模一样,只是索引换成了 toThreadMessages 产出的消息 id 而不是 groupThread 的渲染项键。
//
// 这张表需要"消息的完整顺序"才算得出来,只能在能拿到完整 events 的地方建一次,
// 不能建在单条消息的组件里——那是 O(消息数) 的算法在 O(消息数) 条组件上各跑一遍,
// 变成 O(n²)(toolIndex 当年就是因为这个教训才从"各自扫"改成"建一次传下去",见 #115)。
// 建在 OttoThread 顶层,用 Context 分发给挂在 thread.tsx MessageAnchor 槽上的组件读
const SectionAnchorsContext = createContext<Map<string, number[]>>(new Map());

function buildSectionAnchors(events: SessionEvent[], sections: Section[]): Map<string, number[]> {
  // ThreadMessageLike.id 类型上是可选的(assistant-ui 允许调用方不给、自己生成),
  // 但 toThreadMessages 的三处 push 都显式写了 `id: String(e.seq)` —— 运行时永远有值。
  // 这里用 ?? "" 兜底而不是断言:空串在下面 Number("") 是 NaN,永远不会匹配到任何
  // startSeq,是无害的降级,不是掩盖问题
  const messageIds = toThreadMessages(events).map((m) => m.id ?? "");
  const map = new Map<string, number[]>();
  let si = 0;
  for (const id of messageIds) {
    const seq = Number(id);
    while (si < sections.length && sections[si]!.startSeq <= seq) {
      const at = map.get(id);
      if (at) at.push(si);
      else map.set(id, [si]);
      si++;
    }
  }
  return map;
}

/** 零高度、不参与布局,只给 scrollspy(IntersectionObserver)和跳转(scrollIntoView)
    一个可测量的位置——同一份 `data-section` 约定,App.tsx 那边原样沿用旧版 */
const SectionAnchor: ComponentType = () => {
  const anchorsByMessageId = useContext(SectionAnchorsContext);
  const id = useAuiState((s) => s.message.id);
  const indices = anchorsByMessageId.get(id);
  if (!indices) return null;
  return (
    <>
      {indices.map((si) => (
        // absolute + 不设 top/left = 停在自己的静态位置,同时彻底退出 flex 流(issue #112):
        // 零高度的 div 在 `flex flex-col gap-2` 里照样占一格,每个分区边界上下各多 8px,
        // 跟上面那句"不参与布局"对不上
        <div key={si} data-section={si} aria-hidden className="absolute h-0 scroll-mt-4" />
      ))}
    </>
  );
};

// 除 UserText 外都是模块级常量:每次渲染新建对象会让整棵子树白重挂。
// UserText 造不成常量 —— 它要认「哪些 $名字 是真 skill」,而那份名单来自 store
// (装了哪些 skill 是运行时的事)。所以下面按 skills 记忆化地造,skills 不变就不重造
const STATIC_COMPONENTS = {
  SystemMessage,
  UserAttachments: OttoUserAttachments,
  ToolFallback: ToolFallbackWithLiveTail,
  ToolGroup: OttoToolGroup,
  Source: OttoSource,
  ReasoningGroup: ReasoningGroupWithLabel,
  RunIndicator,
  MessageFooter: MessageTimingFooter,
  MessageAnchor: SectionAnchor,
} satisfies ThreadComponents;

export function OttoThread({
  viewportRef,
  sections,
}: {
  /** 转给 thread.tsx 的 ThreadPrimitive.Viewport——分区轨拿它做 scrollspy/跳转的量尺 */
  viewportRef?: Ref<HTMLDivElement> | undefined;
  /** deriveSections(events) 的结果,App.tsx 那边已经算过一份(SectionRail 也要用),
      传进来避免在这再扫一遍事件日志算同样的东西 */
  sections: Section[];
}) {
  const events = useChat((s) => s.events);
  const skills = useChat((s) => s.skills);
  const anchorsByMessageId = useMemo(
    () => buildSectionAnchors(events, sections),
    [events, sections]
  );
  // 每次事件追加算一次,所有工具行共读(替代原来每行各订阅各扫的写法)
  const spawnedIds = useMemo(() => spawnedToolCallIds(events), [events]);
  // 时间线行(派活卡/交接行)共读的投影,同上理由(#115):顶层算一次,Context 分发
  const timelineProjection = useMemo(
    () => ({ index: buildToolIndex(events), groups: groupSubagentSpawns(events), events }),
    [events]
  );
  // 用户正文里的 `$skill名` 画成 chip(directive-text)。名单来自已装的 skill ——
  // 没有名单的话 `$100`、`$PATH` 也会被画成 chip(见 aui/ottoDirectives.ts)
  const components = useMemo<ThreadComponents>(
    () => ({
      ...STATIC_COMPONENTS,
      // 闪光图标:和 composer `$` 菜单里 skill 条目用的同一枚(TRIGGER_POP 的 fallback),
      // 输入时看到的和发出去之后看到的是同一个东西
      UserText: createDirectiveText(ottoDirectiveFormatter(skills.map((s) => s.name)), {
        iconMap: { skill: Sparkles },
      }),
    }),
    [skills]
  );
  return (
    <SectionAnchorsContext.Provider value={anchorsByMessageId}>
      <SpawnedToolCallsContext.Provider value={spawnedIds}>
        <TimelineProjectionContext.Provider value={timelineProjection}>
          <Thread components={components} viewportRef={viewportRef} />
        </TimelineProjectionContext.Provider>
      </SpawnedToolCallsContext.Provider>
    </SectionAnchorsContext.Provider>
  );
}
