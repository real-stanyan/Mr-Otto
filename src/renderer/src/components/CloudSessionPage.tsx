// CloudSessionPage —— 云会话页：桌面当显示器，接 VPS 上常驻的 runtime（Task 13，ADR-0199）。
//
// 页而不是弹窗：聊天式的长内容，弹窗只会滚动条套滚动条。布局同本地会话
// （#987）：头部 + 横幅 + 时间线住在一个自己滚的区里，输入框钉在它下面不动——
// 人翻到哪儿都摸得到它。抽屉时代这一页是"整块内容一起滚"的堆叠流（那时挂在
// 窄侧栏里，内部滚动区用不上），搬进主区之后那条理由不成立了。滚动区**贴底才
// 跟底**：新事件到了、人原本就在底部才跟过去，人往上翻旧消息时不抢。
//
// 事件流复用 EventRow + TimelineProjectionContext（同 OttoThread 的用法，
// 见 aui/OttoThread.tsx:938 附近）：chat_message 是云会话独有的事件类型，
// EventRow 的 switch 里没有这个 case（也没有 default），落到这个类型时
// 隐式 return undefined——不会崩，只是不渲染，所以在这一层单独渲一行
// （label + content）。approval_request 同样不走 EventRow，是因为它的
// 呈现不是"时间线上的一行"，而是"贴着输入区的一张可操作的卡"（同本地
// 会话 App.tsx 的 ApprovalCard 紧贴 composer 的既有位置约定）。
//
// user_message / assistant_message 也单独渲（复审 Rejected #1 补齐，brief
// 原稿的设计漏洞，不是实现偏离）：EventRow 的 switch 里同样没有这两个
// case（该文件注释原话"这两个分支从此到不了"——本地会话里它们由
// assistant-ui 的主渲染管线接管，EventRow 只兜审计层）。但云会话真正点火
// 一个 turn 时，`services/runtime/src/sessionService.ts` 的 say() 走的是
// `engine.runTurn(\`[${label}]: ${text}\`)`，落盘的是 user_message（不是
// chat_message——chat_message 只在 `logged_only` 分支，即没点火的插话），
// Agent 的回复落 assistant_message。只认 chat_message 会让"@Agent 之后
// 那句话和 Agent 的回答"整段静默消失，只剩闲聊和被拒的审批——spec 里
// "云会话在 UI 里就是一个 session"这句话就不成立了。
// user_message.content 是 `"[label]: text"` 这个人工拼的前缀（协议没有
// 独立 fromUid/label 字段），parseUserMessageLabel 做尽力而为的解析，解析
// 不出就原样显示全文当正文。assistant_message.content 在纯工具调用的
// turn 里可能是空串（events.ts 的字段注释）——AssistantMessageRow 据此
// 只在有正文时才画气泡，同时无条件把 toolCalls 摊成一行行工具活动
// （ToolActivityLine，复用 timelineProjection.index 查执行状态），这样
// 一次纯工具 turn 依旧看得见"发生过什么"，不会全程无声。
//
// 审批卡不搬 App.tsx 那套 ApprovalCardBody——那一套是围着本地 decide()
// 的五种意志（批/拒/中止/授权档位/改过的参数）与 diff 分块取舍搭的，云端
// 协议只认 approved/denied 两种（cloudSessionClient.ts deliverEvent 的
// availableDecisions 写死 ["approve","deny"]），硬套只会引入一堆点了也没
// 效果的按钮。这里另起一张更薄的卡，可视觉语言（圆角边框、pill 按钮）不
// 新造。

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, AtSign, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Bubble, BubbleContent } from "@/components/ui/bubble.js";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.js";
import { Textarea } from "@/components/ui/textarea.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { COMPOSER_METRICS, ComposerActions, ComposerBar, ComposerSend, ComposerToolbar } from "@/components/elements/composer.js";
import { ghostButton } from "@/lib/surfaces.js";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover.js";
import { useChat, type CloudSessionState } from "../store.js";
import { EventRow, TimelineProjectionContext } from "./Timeline.js";
import { buildToolIndex, type ToolIndex } from "../lib/toolIndex.js";
import { groupSubagentSpawns } from "../lib/subagentTimeline.js";
import { formatProxyTime } from "../lib/proxyShare.js";
import { agentNameOf, labelOf, memberAvatarOf } from "../lib/workspaceView.js";
import { agentAvatarSrc } from "../lib/agentAvatar.js";
import { applyAgentMention, filterAgentCandidates, mentionQueryAt, pickerEmptyState, resolveSendMentions } from "../lib/agentMentionInput.js";
import {
  agentStepsSummary, approvalCardTitle, assistantLabel, canStopTurn, cloudEmptyState, foldAgentSteps, hiddenFromCloudTimeline, relayLineText,
  stopButtonRows, systemNoteText, turnEndedLineText, userRowIdentity, type AgentStepsFold,
} from "../lib/cloudTimeline.js";
import { systemNoteDetail } from "../lib/systemNote.js";
import { TurnErrorState } from "./TurnErrorState.js";
import { ThreadHistorySkeleton } from "./assistant-ui/thread.js";
import { openTurns } from "../../../shared/turnLedger.js";
import { safeSpeakerLabel, SYSTEM_SPEAKER_UID } from "../../../shared/promptSafe.js";
import { toolSummary } from "../../../shared/toolSummary.js";
import { mentionTokens, parseMentions, type MentionCandidate } from "../../../shared/remote/agentMention.js";
import type {
  AgentBriefedEvent, AgentRelayEvent, ApprovalDecisionEvent, ApprovalRequestEvent, AssistantMessageEvent,
  ChatMessageEvent, SessionEvent, ToolCallRequest, ToolResultEvent,
} from "../../../session/events.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";
import type { CloudAck } from "../../../shared/shellBridge.js";
import { CS_PROTOCOL_VERSION } from "../../../shared/remote/cloudSession.js";
import { modelStatusText } from "../lib/cloudModelStatus.js";

// cs 还没到位时兜底（正常路径下 WorkspacePage 只在 cloudSession 非空时才
// 挂载这个组件，但 hooks 不能条件调用，events 得先算出一个稳定引用——
// 同 FriendChatView 的 EMPTY 先例，模块级常量避免每次渲染新建 []）
const EMPTY_EVENTS: SessionEvent[] = [];

/** join() 之后持续状态的 deniedCode → 人话（渲染层自己的翻译）。
    main/cloudSessionClient.ts 的 deniedMessage() 只服务 create() 那一次性
    RPC 失败，该函数注释原话："这里不重复造一份会跟渲染层文案走岔的翻译"——
    持续状态（join 之后经 onCloudSessionStatus 推来的 deniedCode）由这一份
    负责。五个码逐一给人话，version_mismatch 特别提示升级；认不出的码原样
    带出来兜底，不装死 */
function cloudDeniedMessage(code: string | undefined, serverVersion?: number): string {
  switch (code) {
    case "bad_jwt":
      return "登录状态已过期，请重新登录后再试";
    case "not_member":
      return "你不是这个工作区的成员";
    case "version_mismatch":
      // 方向说得出来才有用（复审 C2-I6，与 main/cloudSessionClient.ts 的
      // deniedMessage 同一判据）：「更新 Mr Otto」对「云端还没部署」的那半是
      // 错的指引——照做也连不上，且再没有别的线索
      if (serverVersion !== undefined && serverVersion < CS_PROTOCOL_VERSION) {
        return `云端协议版本（${serverVersion}）低于本客户端（${CS_PROTOCOL_VERSION}），云端还没升级，联系维护者`;
      }
      return "客户端版本与云端不匹配，请更新 Mr Otto 后再试";
    case "no_session":
      return "云会话不存在或已归档";
    case "not_authorized":
      return "没有权限执行此操作";
    default:
      return code ? `无法加入云会话（${code}）` : "无法加入云会话";
  }
}

/** 状态条文案（口径同 T4「云端状态三态化」：拿不到状态说"未知"不说"不可用"）。
    connecting/gone 都不是"连不上"的断言，只是"这一刻还没有可展示的事实"——
    gone 时 wsTransport 会自动重连，不代表这次云会话失败（main/cloudSessionClient.ts
    文件头注释）。ready 没有横幅：一切正常不值得占一行——**除非这份历史缺了
    东西**（issue #957 C-I7）。那一行画在这里而不是 actionError 那格，正是因为
    这里不会被别的操作擦掉——`actionError`（`workspaceGroupsError`）是一格共享
    状态，名单刷新/建房/配置保存里随便哪一件成功都会把它清成 null（第四批
    C2-I4 之后发送/审批/停止已经不进那一格，但清它的人仍然有一堆）：
    「我看到的就是全部」和「我看到的少了一条」需要的动作完全不同，不能只差一行
    会被一件不相干的成功抹掉的灰字。缺口补齐（重连后 backlog 拉全了）时主进程
    不再下发它，这一行自己就没了 */
function statusBanner(cs: CloudSessionState): { tone: "muted" | "warn" | "err"; text: string } | null {
  switch (cs.state) {
    case "connecting":
      return { tone: "muted", text: "连接中…" };
    case "gone":
      return { tone: "muted", text: "云端连接已断开，正在自动重连…" };
    case "denied":
      return { tone: "err", text: cloudDeniedMessage(cs.deniedCode, cs.deniedServerVersion) };
    case "ready":
      // warn 不是 muted（终审 minor）：muted 那一档在这张页面上说的是「稍等，
      // 还在连」——数据完整性警告穿它的衣服，就成了一句会被当作过场的灰字，
      // 而它恰恰是唯一告诉你「别照着这段历史下判断」的话。也不用 err：
      // 没有任何东西坏了，是这一份历史不全
      return cs.gapNote === null ? null : { tone: "warn", text: cs.gapNote };
  }
}

/** composer 上方那行「不确定有没有发出去」的一整份状态（第四批 C2-I4）。
    `sessionId` = 它属于哪条云会话（复审 H1：这个组件换会话时不卸载，而
    `workspaceCloudSay` 打的是主进程当前那条连接，不带 sessionId）；
    `mentions` 缺席 = 老语义（服务端按名字解析 + 回落名单第一只），重发要走
    与原来那次**同一条路**；`note` = 这一行此刻说的那句话（复审 L3）。 */
type UnsentLine = {
  sessionId: string;
  text: string;
  mentions: string[] | undefined;
  note: string;
};

/** 那一行的初始措辞。正文只回显前 40 字——这一行是「哪一句话」的提示，
    不是那句话本身（它还完整地存在 `UnsentLine.text` 里，重发发的是全文） */
function unknownNote(text: string): string {
  return `没有收到回执，不确定有没有发出去：${text.slice(0, 40)}${text.length > 40 ? "…" : ""}`;
}

export function CloudSessionPage({
  ws,
  selfUid,
  onBack,
  onSettings,
}: {
  ws: WorkspaceSnapshot;
  selfUid: string;
  /** 省掉 = 不画返回键（issue #919：这一页搬进主区之后没有"上一层"可回——
      离开云会话的方式和离开本地会话一样，点侧栏里别的一行）。抽屉时代它是
      唯一的出口，所以那时是必填 */
  onBack?: () => void;
  /** 头部那颗「设置」（#991）：打开这个工作区的设置抽屉（仓库 / 智能体 / 成员 /
      连接器）。省掉 = 不画（抽屉时代这一页自己就在设置里） */
  onSettings?: () => void;
}) {
  const cs = useChat((s) => s.cloudSession);
  const cloudSay = useChat((s) => s.cloudSay);
  const cloudApprove = useChat((s) => s.cloudApprove);
  const cloudArchive = useChat((s) => s.cloudArchive);
  // 名单陈旧时的刷新（#935 / #957 C-I4）：选人弹层的空态按钮、发送前对认不出
  // 的 @ 先刷一次都要它
  const refreshWorkspaceGroups = useChat((s) => s.refreshWorkspaceGroups);
  // 建这条会话的人（issue #822）：清单那一行本来就带 publisherUid，不用为
  // 这个再往协议里加字段。清单还没拉到时查不到 → 按钮不显示（服务端才是
  // 判据，这里少显示一颗按钮的代价远小于显示一颗按了被拒的）
  const creatorUid = useChat((s) =>
    s.cloudSession
      ? s.cloudSessionList[s.cloudSession.workspaceId]?.find((r) => r.id === s.cloudSession?.sessionId)?.publisherUid
      : undefined
  );
  // 名单刷新/建房/配置保存那类**共享**失败落这一格（复审 Medium：这条错误此前
  // 只在 WorkspacePage 原来那条 return 路径里渲染，云会话走的是提前 return，
  // 根本到不了）。发送/审批/停止已经**不走这一格**了（第四批 C2-I4）：那三件事
  // 的结果只跟点它的那一处有关，归属必须是确定的，见下面 sendError 与 ApprovalRow
  const actionError = useChat((s) => s.workspaceGroupsError);
  const takeDraftSeed = useChat((s) => s.takeCloudDraftSeed);
  // 种子那一格本身要订阅（不只是 take 那个 action）：它是在这个组件**已经挂载
  // 之后**由 CloudSessionMain 种下的（开局卡那句话要等 ready 才发），只依赖
  // draft/sessionId 的话下面那个 effect 永远等不到它，那份原文就只在用户碰巧
  // 清空输入框时才冒出来
  const draftSeed = useChat((s) => s.cloudDraftSeed);

  const [draft, setDraft] = useState("");
  // **一格在飞标记管两条路**（发送 + 重新发送，复审 L2）：两条各记一格的话，
  // 一次 Enter 和一次「重新发送」可以同时在飞，两次结果都写 unsent，后回来的
  // 那次盖掉前一次——而被盖掉的那句正文（unknown 时草稿已经清了）从此在任何
  // 地方都不存在了。共用一格 = 同一时刻只有一次发送在飞，由构造保证
  const [sending, setSending] = useState(false);
  // 这一次发送自己的结果（第四批 C2-I4）——组件本地，不进共享的 actionError：
  // sendError = 确定失败的原因（红），sendNotice = 发出去了但有话要说（中性灰）
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendNotice, setSendNotice] = useState<string | null>(null);
  // 「没收到回执」的那一句（第四批 C2-I4）。**不塞回输入框**：输入框里躺着原文
  // 是「再发一次」这个指令的最强信号，而这句话很可能已经落地了，重发就是发两遍。
  // 摆成一行带「重新发送」/「放弃」的提示，由人决定——桌面这一层没有任何办法
  // 知道它到底有没有生效，把这个不确定性如实交给用户比替他猜一个更安全。
  // **带 sessionId**（复审 H1）：这个组件在换云会话时**不卸载**（openCloudSession
  // 直接整格替换 cloudSession，中间没有 null，而 CloudSessionMain 挂它时没给
  // key），所以本地 state 会跟着人从 A 飘到 B；而 `workspaceCloudSay` 打的是
  // 主进程**当前**那条连接、不带 sessionId——那颗「重新发送」在 B 上点下去
  // 就是把 A 的话发进 B。同一件事 store 给 cloudDraftSeed 做过一次挂靠
  // （见那一格的注释），落地之后这一格也得做。
  // `note` 是这一行此刻说的那句话（复审 L3）：初值是「没有收到回执…」，
  // 重发**确定失败**时换成「重新发送失败：<原因>」——否则屏幕上一条红字
  // 「限速…」旁边挂着一行灰字「没有收到回执」，读起来像两件事
  const [unsent, setUnsent] = useState<UnsentLine | null>(null);
  // 光标位置（#932 切片 1b）：「正在打 @ 吗」是 draft × caret 的函数，光标
  // 不跟着走的话，把光标挪回一个旧的 @ 后面时弹层不会出来。textarea 自己的
  // selectionStart 是 DOM 状态，读不进渲染——所以四个入口（改字/选区/键起/
  // 点击）都往这一格里抄一次
  const [caret, setCaret] = useState(0);
  // Escape 关掉的是**这一个** @（记它的下标）：记成布尔的话，同一句话里
  // 再打一个 @ 会因为上一次的关闭而不弹
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [hi, setHi] = useState(0); // 弹层高亮下标
  const boxRef = useRef<HTMLTextAreaElement>(null);

  // hooks 不能条件调用：cs 可能是 null 的这一拍(WorkspacePage 换页与
  // cloudSession 置空之间那一帧)也得让下面这些 Hook 正常跑完
  const events = cs?.events ?? EMPTY_EVENTS;

  // 时间线行共读的日志投影,同 OttoThread 顶层的算法(aui/OttoThread.tsx:957)
  const timelineProjection = useMemo(
    () => ({ index: buildToolIndex(events), groups: groupSubagentSpawns(events), events }),
    [events]
  );
  // agent 的中间步骤折起来、只画最终答案（#971，ADR-0229）：被折的行跳过，
  // fold 画在收口那条事件（答案 / turn_ended）前面，还没收口的画在时间线末尾
  const folds = useMemo(() => foldAgentSteps(events), [events]);

  // 未决审批:approval_request 事件里,还没有一条 toolCallId 匹配的
  // approval_decision 的那些(ApprovalRequestEvent.callId 与
  // ApprovalDecisionEvent.toolCallId 是同一个 id,同本地 ToolCallRequest.id
  // 的口径)
  const pendingApprovals = useMemo(() => {
    const decided = new Set(
      events
        .filter((e): e is ApprovalDecisionEvent => e.type === "approval_decision")
        .map((e) => e.toolCallId)
    );
    return events.filter(
      (e): e is ApprovalRequestEvent => e.type === "approval_request" && !decided.has(e.callId)
    );
  }, [events]);

  // ── @ 选人（#932 切片 1b）────────────────────────────────────────────
  // 名单第一只 = 这个工作区的管理员（服务端按 created_at 升序给，见 Task 3）
  const candidates = useMemo(
    () => ws.agents.map((a) => ({ agentId: a.agentId, name: a.name, description: a.description })),
    [ws.agents]
  );
  // 「此刻是不是停在一个没打完的 @ 后面」——只决定弹不弹层，**不**决定这句
  // 话点了谁（那是下面 parseMentions 的事，两个问题，见 agentMentionInput 头注）
  const rawPicking = mentionQueryAt(draft, caret);
  const picking = rawPicking !== null && rawPicking.at === dismissedAt ? null : rawPicking;
  // 光标离开这个 @（打完空格 / 退掉那个 @ / 挪到别处）就把关闭记号擦掉。
  // 不擦的话「打 @ → Escape → 退格删掉 → 在同一个位置再打一个 @」会因为
  // 下标撞上而永远不弹——一个只能靠换行躲开的死角
  const pickingAt = rawPicking?.at ?? null;
  useEffect(() => {
    if (pickingAt === null) setDismissedAt(null);
  }, [pickingAt]);
  const options = picking ? filterAgentCandidates(candidates, picking.query) : [];
  // 名单刚变过（改名/新增）时 options 会是空的——不画空态的话弹层压根不开，
  // 用户以为自己没打对字，实际是这份本地快照过期了（#935 / #957 C-I4）
  const emptyState = pickerEmptyState(picking, options);
  // 发送时点了谁：与 chip 行**同一次**调用算出来的同一份 —— 界面上写着发给
  // 谁，服务端就跑谁。两边各算各的就会分家（坑 ④）
  const mentions = useMemo(() => parseMentions(draft, candidates), [draft, candidates]);
  // 候选变了高亮归零：不归零的话，从三个候选里选中第三个、再多打一个字缩到
  // 一个候选时，hi 还停在 2，Enter 什么都选不中
  const optionKey = options.map((o) => o.agentId).join(",");
  useEffect(() => {
    setHi(0);
  }, [optionKey]);

  const csSessionId = cs?.sessionId ?? null;
  // 换云会话时把这三格本地状态清干净（复审 H1）。**这个组件在换会话时不卸载**
  // ——侧栏点另一条云会话走 openCloudSession，它直接把 cloudSession 整格替换，
  // 中间没有 null，而 CloudSessionMain 挂它时没给 key。不清的话 A 的那行提示
  // 和红字会摆在 B 的页面上，说着一件跟 B 无关的事。
  // 这道闸与 `unsent.sessionId` 的比对**两道都要**：这一条清得干净（错误/提示
  // 也一起走），那一条挡的是 effect 跑起来之前那一帧、以及异步回来时会话已经
  // 换了的那种情形（判据在数据里，不依赖 effect 的时序）。
  // 排在下面取种子那个 effect **之前**：同一次 commit 里两个都会跑（换会话时
  // csSessionId 与 draftSeed 一起变），顺序反了就是刚种下的那份被当场清掉
  useEffect(() => {
    setUnsent(null);
    setSendError(null);
    setSendNotice(null);
  }, [csSessionId]);

  // 开局卡那句话没发出去时的原文（issue #957 C-I6）的去处。两种失败去处不同
  // （第四批 C2-I4）：
  //   · `unsent`（确定没发出去）→ 摆回输入框。这一步之后它就是一份普通草稿，
  //     后面每一次失败都归下面 submit() 那条既有纪律管（「草稿在发送成功之后
  //     才清」），不需要另一套保管机制。**只在草稿是空的时候取**：用户已经在
  //     打字了就别覆盖他（也别把那份原文悄悄丢掉——不取走它就还留在 store 里，
  //     等这一格空了再摆回来）。
  //   · `unknown`（没收到回执）→ 进上面那行提示，**不进输入框**，所以也不受
  //     「草稿得是空的」这条限制约束：它根本不动输入框，等待没有任何意义。
  useEffect(() => {
    if (csSessionId === null || draftSeed === null || draftSeed.sessionId !== csSessionId) return;
    if (!draftSeed.unknown && draft !== "") return;
    const seed = takeDraftSeed(csSessionId);
    if (seed === null) return;
    if (seed.unknown) {
      // mentions 缺席：开局卡那句走的是老语义（不 @ 也由名单第一只接），
      // 重发要走同一条路，不能凭空补一个权威空数组（ADR-0220 决策 2）
      setUnsent({ sessionId: csSessionId, text: seed.text, mentions: undefined, note: unknownNote(seed.text) });
      return;
    }
    setDraft(seed.text);
    setCaret(seed.text.length); // 光标落在末尾：接着改比从头挪过去顺手
  }, [csSessionId, draft, draftSeed, takeDraftSeed]);

  // 输入框长高不在这里管：#985 之后它是 ui/Textarea（field-sizing: content 自动
  // 长高，max-h-[40vh] 封顶），同本地的 ComposerTextarea。原来那段按 scrollHeight
  // 写死 style.height 的 effect 会压掉这两条，已删。

  // 滚动区贴底才跟底（#987）：新事件到了、人原本就在底部（或还没滚过）才跟过去；
  // 人往上翻旧消息时不抢。「原本在底部」按上一次滚动时记下的位置判——事件一进来
  // scrollHeight 就变了，事后判永远是"不在底部"
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const eventCount = cs?.events.length ?? 0;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [eventCount, cs?.state]);

  if (!cs) return null;

  const ready = cs.state === "ready";
  const banner = statusBanner(cs);
  const modelStatus = modelStatusText(cs.modelRoute);
  const canSend = ready && !sending && draft.trim().length > 0;
  const timelineEmpty = cloudEmptyState(cs.state, events.length);

  /** 一次发送：mentions 缺席就不传第二参（老语义，服务端按名字解析 + 回落
      名单第一只），给了就以它为准 —— 重发走的是同一条路 */
  const sendOnce = async (payload: UnsentLine): Promise<CloudAck> =>
    payload.mentions === undefined ? await cloudSay(payload.text) : await cloudSay(payload.text, payload.mentions);

  /** 一次发送的结果落地（第四批 C2-I4），三态各有各的去处：
      · `ok` → 那行「不确定」的提示可以撤了（这一次是确定成功的）
      · `ok:false` + `unknown` → 摆成那一行，等人决定重发还是放弃；**从重发
        回来的这一支保持 payload 原来那条 note**——同一件事，换措辞或另起一行
        都是在说「又出了件新事」
      · 其余（确定失败）→ 画原因，正文留在原处（草稿 / 那一行）不动
      **`unknown` 一个字都不写进 sendError**：它不是失败，是「不知道」，
      画成红字会把人推向「重发一次」，而重发很可能就是发两遍。
      `from` 只影响「确定失败」那一支（复审 L3）：composer 那次没有对应的行，
      原因画进 sendError；重发那次有——写进那一行自己的 note，否则屏幕上一条
      红字「限速…」旁边挂着一行灰字「没有收到回执」，读起来像两件事 */
  const applySendResult = (r: CloudAck, payload: UnsentLine, from: "submit" | "resend"): void => {
    if (r.ok) {
      setUnsent(null);
      return;
    }
    if (r.unknown) {
      setUnsent(payload);
      return;
    }
    if (from === "resend") {
      setUnsent({ ...payload, note: `重新发送失败：${r.message}` });
      return;
    }
    setSendError(r.message);
  };

  const resend = async (): Promise<void> => {
    // 会话对不上就不发（复审 H1）：异步期间人可能已经切走，而这颗钮打的是
    // 主进程**当前**那条连接——判据在数据里，不靠上面那个 effect 的时序
    if (unsent === null || sending || !ready || unsent.sessionId !== csSessionId) return;
    setSending(true);
    setSendError(null);
    setSendNotice(null);
    const r = await sendOnce(unsent);
    // await 期间人可能已经切到同工作区的另一条会话（**这个组件换会话不卸载**），
    // 那一格清空 effect 已经跑过了，这里再写就是把 A 的结果画在 B 的 composer 上。
    // 判据在数据里（同 `unsent.sessionId` 那条纪律），不靠 effect 的时序
    if (useChat.getState().cloudSession?.sessionId !== unsent.sessionId) {
      setSending(false);
      return;
    }
    applySendResult(r, unsent, "resend");
    setSending(false);
  };

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || sending || !ready) return;
    setSending(true);
    // 三条本地提示都归这一次发送管：新的一次开始时先清干净，免得上一次的
    // 红字挂在新结果旁边（成功时它们保持 null，等于「下一次成功发送时清」）
    setSendError(null);
    setSendNotice(null);
    // 复审 Medium：草稿在发送成功之后才清——**确定失败**时原样留在输入框里，
    // 不用另外找地方把文字塞回去；失败原因画在下面 sendError 那一行

    // 正文里写了 @token，但一个候选都解析不出来（#935 / #957 C-I4；第四批 C2-I5
    // 换掉了判据）：最常见的诱因是名单刚变过（改名/新增）而这份本地快照没跟上——
    // 发一个 authoritative 的 `[]` 会被服务端读成「我确认谁都没点」（ADR-0220
    // 决策 2），于是消息安静地变成一句没人接的闲聊，用户还以为自己 @ 到了人。
    // 发送前先刷一次名单，然后把**两件不同的事**分开交给 resolveSendMentions：
    // 「名单读没读出来」决定要不要把解析权交给云端，「新名单里有没有这个人」
    // 决定该不该发。旧判据「刷新后名单长度是不是 0」两件事都答错——
    // refreshWorkspaceGroups() 失败时只 set workspaceGroupsError、**旧名单原样
    // 留着**（store.ts），于是最常见的那种失败在它眼里跟成功长得一模一样
    let refreshFailed = false;
    let freshCandidates: MentionCandidate[] | null = null;
    if (mentionTokens(text).length > 0 && mentions.length === 0) {
      await refreshWorkspaceGroups();
      // 不从这个组件已经渲染出的 `ws`/`candidates` 闭包读（那份还是刷新前的
      // 旧值），直接问 store 要这一刻的真实状态
      const fresh = useChat.getState();
      refreshFailed = fresh.workspaceGroupsError !== null;
      const freshWs = fresh.workspaceGroups.find((g) => g.id === ws.id);
      // 刷新「成功」但这个工作区不在返回的清单里 = 名单同样没拿到（被踢出去 /
      // 工作区没了），按 null 走「交给云端按名字解析」那条：拿它当「名单里没有
      // 这个人」去拦，就是对着一句完全正常的话说「没有叫 X 的智能体」
      freshCandidates = freshWs ? freshWs.agents.map((a) => ({ agentId: a.agentId, name: a.name })) : null;
    }
    const plan = resolveSendMentions({ text, parsed: mentions, refreshFailed, freshCandidates });
    if (plan.kind === "block") {
      // 这一句压根不发：草稿原样留在输入框里等人改名字（同「确定失败」那条路）
      setSendError(plan.error);
      setSending(false);
      return;
    }
    const payload: UnsentLine = {
      // csSessionId 在这里必然非空（上面 `if (!cs) return null` 之后才走得到），
      // 断言只是为了不给这一格造一个 null 的可能性
      sessionId: csSessionId ?? "",
      text,
      // `undefined` = 缺席，让服务端拿它自己那份名单解析正文、再回落名单第一只，
      // 于是一句 "@管理员 帮我看下" 照旧有人接；`[]` 是权威的「谁都没点」，
      // resolveSendMentions 保证正文写了 @ 时永远不会给出它
      mentions: plan.mentions,
      note: unknownNote(text),
    };
    const r = await sendOnce(payload);
    // 会话对不上就什么都不写（终审 Finding 4）：await 期间人可能已经切到同工作区的
    // 另一条会话，**这个组件不卸载**，[csSessionId] 那个清空 effect 早就跑完了 ——
    // 这之后每一次 setState 都会落在 B 的 composer 上（A 的失败原因、A 的 notice，
    // 连 setDraft("") 都会清掉 B 的草稿）。`unsent` 那一格靠自带的 sessionId 躲过了，
    // 错误/提示两格没有，这里补齐同一条纪律：判据落在数据里，不靠 effect 的时序
    if (useChat.getState().cloudSession?.sessionId !== payload.sessionId) {
      setSending(false);
      return;
    }
    // `unknown` 也清输入框（第四批 C2-I4）：那句话很可能已经落地，把原文留在
    // 输入框里等于催用户再按一次回车。原文没丢——它去了下面那行「不确定」的
    // 提示，那里有一颗要人主动点的「重新发送」
    if (r.ok || r.unknown) {
      // mentions 是 draft 的函数，清了正文点名自然跟着清（chip 行也跟着没）
      setDraft("");
      setCaret(0);
      setDismissedAt(null);
      // 这句提示说的是「这条**已经交出去**的话点到谁不由本机说了算」，所以只在
      // 真发出去（或不确定）时才说 —— 确定失败时它旁边会挂一行红字，一句灰字
      // 说「云端会解析」加一句红字说「没发出去」，读起来是两件互相矛盾的事
      if (plan.notice !== null) setSendNotice(plan.notice);
    }
    applySendResult(r, payload, "submit");
    setSending(false);
  };

  /** 选中弹层里第 i 只：写回正文并把光标放回 "@名字 " 之后 */
  const pick = (i: number): void => {
    if (picking === null) return;
    const chosen = options[i];
    if (chosen === undefined) return;
    const next = applyAgentMention(draft, picking.at, caret, chosen.name);
    setDraft(next.text);
    setCaret(next.caret);
    setDismissedAt(null);
    // 光标要等这一帧 commit 完再设：React 在 commit 期间会做一次**选区保全**
    // ——把改动前那个选区偏移恢复到当前有焦点的元素上，于是同一个 tick 里设的
    // 光标会被它盖掉。rAF 排在 commit 之后，设进去才留得住
    const c = next.caret;
    requestAnimationFrame(() => boxRef.current?.setSelectionRange(c, c));
  };

  /** 「插入 @」：在光标处打一个 @，弹层随之出现（钮不再是开关，见 footer 处注） */
  const insertAt = (): void => {
    const box = boxRef.current;
    const pos = box?.selectionStart ?? draft.length;
    // 前一个字符是构词字符时先补一个空格：parseMentions 要求 @ 前是行首或
    // 非构词字符（否则 rick@运营 这种邮箱形状会被当成点名），不补的话这颗钮
    // 插出来的 @ 既不弹层也解析不出人
    const insert = /[\p{L}\p{N}_]/u.test(draft[pos - 1] ?? "") ? " @" : "@";
    const c = pos + insert.length;
    setDraft(draft.slice(0, pos) + insert + draft.slice(pos));
    setCaret(c);
    setDismissedAt(null);
    requestAnimationFrame(() => {
      const b = boxRef.current;
      b?.focus();
      b?.setSelectionRange(c, c);
    });
  };

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {/* 头部钉在顶上（#993）：与 footer 对称——#987 那次只钉了输入框，头部还
          跟着内容滚，翻旧消息时「这是哪个工作区、路由走哪条、设置在哪」全看不见。
          本地会话的 header 也是这么钉的（settingsShell 的 HEADER：h-11 + border-b） */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-4 py-2">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className={cn(
              "press-scale -ml-1 inline-flex w-fit items-center gap-1.5 rounded-[7px] px-1.5 py-1",
              "text-[12.5px] text-muted-foreground transition-colors duration-150",
              "hover:bg-foreground/[0.06] hover:text-foreground"
            )}
          >
            <ArrowLeft className="size-[13px]" aria-hidden />
            {ws.name}
          </button>
        ) : (
          // 没有返回键时工作区名仍然要在：这一行回答的是「我在哪个工作区里」，
          // 而云会话的每一件事（谁能看见、扣谁的额度、用哪把 key）都挂在它上面
          <span className="px-1.5 py-1 text-[12.5px] text-muted-foreground">{ws.name}</span>
        )}
        <div className="flex items-center gap-1.5">
          {/* 归档不在这儿（#993 第 5 条）：它属于侧栏那条会话行的 ⋮ 菜单，同本地
              会话——头部是"这条会话是什么"，不是"对它做什么"。协议 9 把 archive
              搬进控制房正是为了让那颗菜单项不必先开着这条会话 */}
          {/* 模型那一格只读路由（ADR-0233）：blocked 才是**会挡住干活**的那一格，
              给所有成员看。仓库不在头部（#991）：不是每个工作区都有仓库，常驻一格
              「未配仓库」对文案类工作区是噪音——它去了「设置」里的仓库 tab */}
          <span
            className={cn("max-w-[150px] truncate text-[11px]", modelStatus.bad ? "text-err" : "text-muted-foreground")}
            title={modelStatus.full}
          >
            {modelStatus.short}
          </span>
          {onSettings && (
            <Button
              variant="outline"
              size="xs"
              className="shrink-0"
              onClick={onSettings}
              title={`${ws.name} 的设置：仓库、智能体、成员、连接器`}
            >
              <Settings2 className="size-[13px]" aria-hidden />
              设置
            </Button>
          )}
        </div>
      </div>

      {/* 滚动区：横幅 + 时间线 + 错误行。scrollbar-stable 同外层原来那份；
          px-4 与本地会话一条量尺（aui viewport 的 `max-w-(--thread-max-width) px-4`，
          那个变量本仓没定义 = 无上限，所以本地就是「占满 + px-4」，#993 第 2 条）；
          pb-3 给最后一条消息和输入框之间留口气；onScroll 记「此刻在不在底部」
          给上面那条跟底 effect 用（阈值 48px：滚动条抖一下不算离开） */}
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className="flex flex-1 min-h-0 flex-col gap-3 overflow-y-auto scrollbar-stable px-4 pt-3 pb-3"
      >
      {banner && (
        <p
          className={cn(
            "text-xs",
            banner.tone === "err" ? "text-err" : banner.tone === "warn" ? "text-warn" : "text-muted-foreground"
          )}
        >
          {banner.text}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <TimelineProjectionContext.Provider value={timelineProjection}>
          {timelineEmpty === "skeleton" ? (
            // 历史还在路上（#983）：画骨架不画「还没有消息。」——后者在这一刻
            // 是假话。形状复用主聊天切会话时那份，不另造一套
            <ThreadHistorySkeleton />
          ) : timelineEmpty === "empty" ? (
            <p className="text-xs text-muted-foreground">还没有消息。</p>
          ) : (
            events.map((e, i) => {
              // 接力开场白（user_message 带 relay）不画：那是给模型看的
              // "[系统] 「运营」@ 了你"，人看下面那条 agent_relay 接力线就够，
              // 画出来是同一件事说两遍（#950）
              if (hiddenFromCloudTimeline(e)) return null;
              if (folds.hidden.has(e.seq)) return null;
              // 收口这条事件的那段步骤先画（折叠的一行），再画事件本身。
              // 用 fragment 而不是给每个分支各包一层：fold 与下面哪个分支配对
              // 是 foldAgentSteps 的事，这里不重判
              const fold = folds.byCloser.get(e.seq);
              const withFold = (row: ReactNode): ReactNode =>
                fold ? (
                  <Fragment key={e.seq}>
                    <AgentStepsFoldRow fold={fold} ws={ws} index={timelineProjection.index} />
                    {row}
                  </Fragment>
                ) : row;
              if (e.type === "chat_message") {
                return (
                  <ChatMessageRow key={e.seq} event={e} avatarUrl={memberAvatarOf(ws, e.fromUid)} />
                );
              }
              if (e.type === "user_message") {
                // 护栏 / 后台任务回注（#957 C-I5，#936）：engine 自己注的话，
                // 不是群里哪个人说的——I5 描述的"一条没有署名的群聊气泡"就是
                // 落在这条分支之前的老代码。systemNoteText 只对 origin 在场
                // 的事件给出非 null，人打的话仍然走下面的气泡渲染
                const note = systemNoteText(e, ws);
                if (note !== null) {
                  // detail 非 null（后台任务那一档）时这一行变成可展开的
                  // <details>，全文折在里面（第四批 C2-I1）
                  return <SystemNoteRow key={e.seq} text={note} detail={systemNoteDetail(e)} />;
                }
                const identity = userRowIdentity(e, ws, selfUid);
                return (
                  <UserMessageRow
                    key={e.seq}
                    ts={e.ts}
                    label={identity.label}
                    text={identity.text}
                    avatarUrl={identity.uid ? memberAvatarOf(ws, identity.uid) : ""}
                  />
                );
              }
              if (e.type === "assistant_message") {
                return withFold(
                  <AssistantMessageRow key={e.seq} event={e} ws={ws} index={timelineProjection.index} />
                );
              }
              if (e.type === "agent_briefed") {
                return <AgentBriefedRow key={e.seq} event={e} />;
              }
              if (e.type === "agent_relay") {
                return <AgentRelayRow key={e.seq} event={e} ws={ws} />;
              }
              if (e.type === "turn_ended") {
                // isLast 恒 false：EventRow 的"重试"钮只看这个 prop（Timeline.tsx:649），
                // 而那颗钮点了走本地 resendMessage——云端没有重发这条路，钮出来就是撒谎
                //
                // turnEndedLineText 非 null（#957 M16）：多智能体并发时"谁挂了"看不出来，
                // 只换 title 那一行（「运营」这一轮出错），detail 仍是 e.error——不是重新
                // 拼一整句，ErrorState 本来就是 title/detail 分两行画（含 humanizeError 的
                // 人话/原文折叠）。查不到 agentId（旧日志/本机会话）落回现状的 EventRow
                const agentTitle = turnEndedLineText(e, ws);
                if (agentTitle !== null) {
                  return withFold(
                    <TurnErrorState
                      key={e.seq}
                      title={agentTitle}
                      detail={e.error ?? "没有错误信息"}
                      interactive={false}
                      className="max-w-none"
                    />
                  );
                }
                return withFold(<EventRow key={e.seq} event={e} isLast={false} />);
              }
              return <EventRow key={e.seq} event={e} isLast={i === events.length - 1} />;
            })
          )}
          {/* 排队中/正在回复画在时间线**末尾**而不是贴在各自那条 @ 消息下面：
              排队的东西说的是"接下来会发生什么"，那是时间线尾巴的事，不是
              历史里某一行的注脚（跟 turn_ended 的错误行不同——那是已经发生
              的事实，钉在它发生的位置）*/}
          {/* 还没收口的步骤段画在末尾、排队/正在回复那几行之前：它们说的都是
              「此刻正在发生什么」，是时间线尾巴的事 */}
          {folds.open.map((fold) => (
            <AgentStepsFoldRow key={`open:${fold.steps[0]!.seq}`} fold={fold} ws={ws} index={timelineProjection.index} />
          ))}
          <PendingTurnLines events={events} ws={ws} selfUid={selfUid} cs={cs} />
        </TimelineProjectionContext.Provider>
      </div>

      {pendingApprovals.length > 0 && (
        <div className="flex flex-col gap-2">
          {pendingApprovals.map((req) => (
            <ApprovalRow
              key={req.callId}
              event={req}
              ws={ws}
              waitingLabel={labelOf(ws, req.initiatorUid)}
              canDecide={selfUid === req.initiatorUid || selfUid === cs.ownerUid}
              ready={ready}
              onApprove={() => cloudApprove(req.callId, "approved")}
              onDeny={() => cloudApprove(req.callId, "denied")}
            />
          ))}
        </div>
      )}

      {actionError && <p className="text-xs text-err">{actionError}</p>}
      {/* 这一次发送自己的结果（第四批 C2-I4）：与上面那条共享的错误带并排画，
          但归属是分开的——共享那格里躺着的可能是名单刷新失败，跟这句话无关 */}
      {sendError && <p className="text-xs text-err">{sendError}</p>}
      {sendNotice && <p className="text-xs text-muted-foreground">{sendNotice}</p>}
      {/* 「不知道有没有发出去」那一行：中性灰不是红色——它不是一次失败，
          是一个桌面这一层无法消除的不确定性。两颗钮把决定权交回给人：
          「重新发送」= 我认了可能发两遍，「放弃」= 我认了可能没发出去。
          **只画属于这条会话的那一份**（复审 H1）：换会话时这个组件不卸载，
          比对 sessionId 才不会把 A 的话摆在 B 的页面上 */}
      {unsent && unsent.sessionId === csSessionId && (
        <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
          <span className="min-w-0 break-words">{unsent.note}</span>
          <Button variant="ghost" size="xs" disabled={!ready || sending} onClick={() => void resend()}>
            重新发送
          </Button>
          <Button variant="ghost" size="xs" disabled={sending} onClick={() => setUnsent(null)}>
            放弃
          </Button>
        </div>
      )}

      </div>

      <footer className="relative shrink-0 px-4 pt-[10px] pb-3">
        {/* 滚动缘渐隐，同 App.tsx 的 footer：正文淡进底色，不画 1px 分隔线 */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-10 h-10 bg-gradient-to-b from-transparent to-background" />
        {/* 外壳与本地会话的输入框**同一套**（#985；App.tsx 的 ChatComposer）：
            elements/composer 的 ComposerBar 把「这一条要发的东西」当成一摞来排——
            点名行 / 输入 / 工具条——类名逐字照抄那边。少掉的是工具条左边那条偏好栏
            （审批模式 / 型号 / thinking / 用量环）：那几样在云会话里是**工作区**的属性
            不是这条会话的（ADR-0202 / 0233，同 CloudWelcome 头注），摆上来就是几个
            点了不生效的控件。cursor-text + 点空白处聚焦：本地那边由 ComposerPrimitive.Root
            代劳，这里没有它，自己接一下 */}
        <ComposerBar
          className="focus-within:border-border dark:border-muted-foreground/15 dark:focus-within:border-muted-foreground/30 relative cursor-text shadow-sm transition-[border-color,background-color]"
          onClick={(e) => {
            if (e.target === e.currentTarget) boxRef.current?.focus();
          }}
        >
          {/* 「发给谁」预览。**只读**：去掉一枚 = 从正文里把那个 @ 删掉——正文
              才是事实，给 pill 配一颗 × 就等于开了第二个事实来源，两边迟早不一致。
              位置同本地的附件暂存区（StagedChips）：输入框上方那一行 */}
          {mentions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 px-1 text-[11px] text-muted-foreground">
              <span>发给</span>
              {mentions.map((id) => (
                <span key={id} className="rounded-full border border-border px-2 py-[1px]">
                  {agentNameOf(ws, id)}
                </span>
              ))}
            </div>
          )}
          {/* 弹层走 Radix 的 Popover 而不是自己 absolute 定位：这一页整个装在
              滚动容器旁边（#987 之前是 CloudSessionMain 的 overflow-y-auto 里面），
              `absolute bottom-full` 画出来的列表一旦高过可用空间就会被裁掉且滚不到
              （当年新会话只有一行「还没有消息。」时 footer 离顶不到 90px，三只就削掉一行）。
              Radix 把内容 portal 到 body、位置不够时自己翻到下面——这正是那个裁切的修法。
              键盘**仍然全部**由下面的 textarea onKeyDown 管（方向键/Enter 不能交给 Radix，
              它会拿去做菜单导航）；焦点也一步都不许挪，靠两个 AutoFocus 的 preventDefault */}
          <Popover open={picking !== null && (options.length > 0 || emptyState !== null)}>
            <PopoverAnchor asChild>
              {/* 与本地的 ComposerTextarea 逐字同款：无边框、自动长高（Textarea 自带
                  field-sizing: content）、max-h 封顶出滚动条、度量走 COMPOSER_METRICS */}
              <Textarea
                ref={boxRef}
                rows={1}
                disabled={!ready}
                className={cn(
                  "relative border-none shadow-none min-h-0 bg-transparent dark:bg-transparent text-foreground resize-none max-h-[40vh] focus-visible:ring-0 placeholder:text-foreground/35 caret-foreground",
                  COMPOSER_METRICS
                )}
                placeholder={ready ? "输入 @ 点名智能体；不 @ 就只是群里说一句" : "还没连上，暂时发不了消息"}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setCaret(e.target.selectionStart);
                }}
                onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
                onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
                onClick={(e) => setCaret(e.currentTarget.selectionStart)}
                // **故意没有 onBlur**：写进 dismissedAt 的是"这个 @ 不要了"这个
                // 判断，而切窗口不是那个意思——alt-tab 出去再回来，光标一个字没动，
                // 于是 picking 永远是 null，接着打字列表再也不出来。
                // 该关的两条路都有人管了：指针点到外面走 onInteractOutside（Radix 的
                // DismissableLayer 连 focus-outside 一起管），键盘则出不去（Tab /
                // Shift+Tab 在下面被拦去选人了）。切窗口留着它开着没关系——回来时
                // 那份候选依然是这句话此刻要的
                onKeyDown={(e) => {
                  // 输入法组词途中的按键是"选词"不是命令（Enter 尤其——同
                  // FriendChatView 的既有约定），整段跳过
                  if (e.nativeEvent.isComposing) return;
                  if (picking !== null && options.length > 0) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setHi((h) => (h + 1) % options.length);
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setHi((h) => (h - 1 + options.length) % options.length);
                      return;
                    }
                    // Enter 在弹层开着时**选人不发送**：正在挑人的那一下按回车，
                    // 意思一定是"就他"，不是"发出去"
                    if (e.key === "Enter" || e.key === "Tab") {
                      e.preventDefault();
                      pick(hi);
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setDismissedAt(picking.at);
                      return;
                    }
                  } else if (picking !== null && emptyState !== null && e.key === "Escape") {
                    // 空态那张卡没有候选可挑，方向键/Enter/Tab 都没有意义——
                    // 只接 Escape 关掉它，同有候选时的既有约定
                    e.preventDefault();
                    setDismissedAt(picking.at);
                    return;
                  }
                  // Enter 发送、Shift+Enter 换行
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />
            </PopoverAnchor>
            <PopoverContent
              side="top"
              align="start"
              role="listbox"
              // 焦点一步都不许挪：这个列表是 textarea 的附属显示，人还在打字。
              // Radix 默认开时把焦点吸进内容、关时还回触发器，两下都会打断输入
              onOpenAutoFocus={(e) => e.preventDefault()}
              onCloseAutoFocus={(e) => e.preventDefault()}
              // 键盘那条路由 textarea 的 onKeyDown 管，这里只兜「焦点不在框里
              // 时按了 Escape」；两边都设成同一个值，重复触发也无所谓
              onEscapeKeyDown={() => setDismissedAt(rawPicking?.at ?? null)}
              onInteractOutside={(e) => {
                // 点回 textarea 不算「点到外面」——它是这个弹层的锚，同一个部件。
                // 算成外面的话，点进 @ 查询词中间会把弹层关掉且**再也不开**
                // （dismissedAt 撞上同一个下标），而人此刻明明还在挑
                if (e.detail.originalEvent.target === boxRef.current) return;
                setDismissedAt(rawPicking?.at ?? null);
              }}
              // 进出场在 app.css 的 [data-slot="popover-content"] 那段（手写 keyframes——
              // 上游那串 animate-in/zoom-in-95 在本仓库是死类名，见 ui/dialog.tsx 顶部）
              className="w-auto min-w-[200px] max-w-[320px] p-1"
            >
              {options.length === 0 && emptyState ? (
                // 空态（#935 / #957 C-I4）：只读的一行说明 + 一颗刷新钮，不是
                // 一个可选的选项——名单可能真的刚变过（别人改了名/新建了 agent），
                // 也可能用户就是打错了字，这里不替他判断，只给出"再核实一次"的路
                <div className="flex flex-col gap-1.5 px-2 py-1.5 text-[12.5px] text-muted-foreground">
                  <span>没有叫「{emptyState.query}」的智能体（名单可能刚变过）</span>
                  <button
                    type="button"
                    // 同选项行的道理：mousedown + preventDefault 保住 textarea 的焦点
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void refreshWorkspaceGroups()}
                    className="press-scale self-start text-foreground underline decoration-dotted underline-offset-2 hover:no-underline"
                  >
                    刷新名单
                  </button>
                </div>
              ) : (
                options.map((o, i) => (
                  <div
                    key={o.agentId}
                    role="option"
                    aria-selected={i === hi}
                    // mousedown + preventDefault：用 click 的话 textarea 会先失焦，
                    // 写回之后那次 setSelectionRange 就落在一个没焦点的框上
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(i);
                    }}
                    onMouseEnter={() => setHi(i)}
                    className={cn(
                      "flex cursor-default items-baseline gap-2 rounded-sm px-2 py-[5px] text-[12.5px]",
                      i === hi && "bg-foreground/[0.06]"
                    )}
                  >
                    <span className="shrink-0">{o.name}</span>
                    <span className="truncate text-muted-foreground">{o.description}</span>
                  </div>
                ))
              )}
            </PopoverContent>
          </Popover>
          {/* 工具条：本地那边左边是偏好栏、右边是发送/停止圆钮。这里左边只剩一颗 @
              （形状抄 ComposerAttachButton 的 ghost 圆钮，本地那颗「＋ 附件」的位置）；
              发送键**不变停止键**——云会话的停止按 agent 挂在时间线那一行上
              （stopButtonRows），一条会话可能同时跑着好几只，底下一颗钮说不清停谁 */}
          <ComposerToolbar className="relative items-end gap-2">
            {/* 这颗钮不再是"对 Agent 说"的开关（有了名单，得说清对哪一只）——
                它现在只做一件事：在光标处插一个 @，把弹层叫出来 */}
            <button
              type="button"
              disabled={!ready}
              onClick={insertAt}
              title="@ 智能体"
              aria-label="@ 智能体"
              className={cn(ghostButton, "size-8 disabled:pointer-events-none disabled:opacity-30")}
            >
              <AtSign className="size-4" aria-hidden />
            </button>
            <ComposerActions>
              <Tooltip>
                <TooltipTrigger asChild>
                  <ComposerSend
                    streaming={false}
                    idle={!canSend}
                    disabled={!canSend}
                    aria-label="发送消息"
                    onClick={() => void submit()}
                    className="shrink-0 disabled:pointer-events-none"
                  />
                </TooltipTrigger>
                <TooltipContent>发送(Enter)</TooltipContent>
              </Tooltip>
            </ComposerActions>
          </ComposerToolbar>
        </ComposerBar>
      </footer>
    </div>
  );
}

/** 群聊一行:自己发的靠右(align="end"),标签行只在别人发的那边显示——
    自己发的一眼就能从靠右的位置认出来,再挂一遍自己的名字是噪音
    (同典型群聊 UI 的既有约定,如 FriendChatView 两人 DM 靠头像位置区分,
    这里人数不定,靠文字标签)。event.mention 为真时补一个 "@Agent" 角标——
    它是发送那一刻"这句话是对 Agent 说的"这个事实的展示,不分是谁发的 */
function ChatMessageRow({ event, avatarUrl }: { event: ChatMessageEvent; avatarUrl: string }) {
  // runtime 自己说的话（接力护栏、棒数上限、被踢那句：sessionService 落
  // chat_message 时用的 fromUid: "system"）不画成气泡（第四批 B2-I1 的 UI 半）：
  // 气泡的全部含义是「群里有个人说了这句」，而这几句没有人说。判据取 fromUid
  // 这个**稳定键**不取 label——`safeSpeakerLabel` 已经把保留名「系统」锁给了
  // system 这个 uid，但那是发言人**名字**那一层的闸；这里问的是另一个问题
  // （画成什么），两道各自独立
  if (event.fromUid === SYSTEM_SPEAKER_UID) {
    return <SystemNoteRow text={event.content} />;
  }
  // 名字过一次 safeSpeakerLabel（第四批 B2-I1）：label 是服务端递下来的
  // 展示名，而 profiles.name 从没走过写入校验——一个把自己改名叫「系统」
  // 的成员照原样画出来就与 runtime 自己的旁白分不开了。这一层与
  // daemon.labelOf / deriveMessages 投影那两处跑的是同一个幂等函数，
  // 少跑一处就等于那条路上的闸没关（ADR-0226）
  const name = safeSpeakerLabel(event.label, event.fromUid);
  return (
    <SpeakerRow avatar={<PersonAvatar name={name} src={avatarUrl} />}>
      <span className="px-1 text-[10.5px] text-muted-foreground">
        {name} · {formatProxyTime(event.ts)}
      </span>
      <Bubble align="start" variant="muted">
        <BubbleContent className="whitespace-pre-wrap break-words">{event.content}</BubbleContent>
      </Bubble>
    </SpeakerRow>
  );
}

/** 一行「有人说了一句话」的骨架（#971）：头像 + 右边（自己发的在左边）那一摞
    标签行 + 气泡。三种气泡（成员闲聊 / 点火的那句 / agent 的回复）共用——
    头像的位置、尺寸、与气泡的间距只能有一份，各写各的迟早三种对不齐。
    头像与**标签行**顶对齐而不是与气泡：多行气泡里头像贴着第一行读起来才像
    「这个人说的」，贴底（MessageAvatar 的 self-end 默认）在长消息上会掉到
    看不见的地方。自己发的头像也画（维护者原话「不同人类成员发消息时也要显示
    每个人各自的头像」）——靠右的位置已经说明是我，但群里多人时一眼扫过去，
    每一行都有脸比「有的有有的没有」整齐 */
function SpeakerRow({ avatar, children }: { avatar: ReactNode; children: ReactNode }) {
  return (
    <div className="flex max-w-[85%] gap-2 self-start">
      <div className="shrink-0 pt-[3px]">{avatar}</div>
      <div className="flex min-w-0 flex-col items-start gap-0.5">{children}</div>
    </div>
  );
}

/** 成员头像：profiles.avatar_url 有就画图，没有退回首字母（同 FriendChatView /
    identity.ts 的 initial 纪律——取首个码点不取 charAt，emoji 名字按 UTF-16
    切会得到半个代理对） */
function PersonAvatar({ name, src }: { name: string; src: string }) {
  const initial = ([...name.trim()][0] ?? "?").toUpperCase();
  return (
    <Avatar size="sm">
      {src !== "" && <AvatarImage src={src} alt={name} />}
      <AvatarFallback>{initial}</AvatarFallback>
    </Avatar>
  );
}

/** agent 头像：内置像素图（agentAvatar.ts）。agentId 缺席（旧日志/单 agent
    会话）时没有脸可查，退回首字母。**不开** image-rendering: pixelated：128px
    的像素画缩到 24px 时一格像素只剩一个多屏幕像素，最近邻会整行整列地丢掉
    （眼睛可能直接没了），平滑缩放反而认得出是谁 */
function AgentAvatar({ ws, agentId, name }: { ws: WorkspaceSnapshot; agentId: string | undefined; name: string }) {
  return (
    <Avatar size="sm">
      {agentId !== undefined && (
        <AvatarImage src={agentAvatarSrc(ws, agentId)} alt={name} />
      )}
      <AvatarFallback>{([...name.trim()][0] ?? "?").toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}

/** 点火了一个 turn 的那句话（复审 Rejected #1 补齐；targets 是 Task 10 补的
    "说给谁"）：user_message 本体，可视觉语言照抄 ChatMessageRow——群聊里
    这就是"有人说了一句话"，只是这一句额外触发了 Agent 干活。label 解析
    不出时（旧日志/前缀被破坏）就不画标签行，只显示时间，正文原样兜底显示
    全文（含没剥掉的前缀，宁可多显示一点也不假装解析成功了）。targets
    非空时标签行末尾追加 "· → 谁"——这是这句话点了谁的唯一可见痕迹，
    不点名的普通发言（targets 为空）不多这一截 */
function UserMessageRow({
  ts,
  label,
  text,
  avatarUrl,
}: {
  ts: number;
  label: string | null;
  text: string;
  avatarUrl: string;
}) {
  return (
    <SpeakerRow avatar={<PersonAvatar name={label ?? "?"} src={avatarUrl} />}>
      <span className="px-1 text-[10.5px] text-muted-foreground">
        {label ? `${label} · ` : ""}
        {formatProxyTime(ts)}
      </span>
      <Bubble align="start" variant="muted">
        <BubbleContent className="whitespace-pre-wrap break-words">{text}</BubbleContent>
      </Bubble>
    </SpeakerRow>
  );
}

/** Agent 的回复（复审 Rejected #1 补齐；署名换成 assistantLabel 是 Task 10）：
    恒左对齐（Agent 不可能是"我"）。content 在纯工具调用的 turn 里可能是
    空串（events.ts 的字段注释）——这时不画空气泡，改成无条件把 toolCalls
    摊成一行行 ToolActivityLine，这样即使模型这一轮一个字没说，用户也能
    看见"它干了什么"，不是全程无声。有正文又有工具调用时两者都画
    （events.ts 原话："文本和工具调用请求可以同时出现"）。ws 是查
    agentId → 名字的名单，多智能体上线前落的旧消息没有 agentId，
    assistantLabel 据此回退到 "Agent" */
function AssistantMessageRow({
  event,
  ws,
  index,
}: {
  event: AssistantMessageEvent;
  ws: WorkspaceSnapshot;
  index: ToolIndex;
}) {
  const hasText = event.content.trim() !== "";
  const toolCalls = event.toolCalls ?? [];
  const name = assistantLabel(event, ws);
  return (
    <SpeakerRow avatar={<AgentAvatar ws={ws} agentId={event.agentId} name={name} />}>
      <span className="px-1 text-[10.5px] text-muted-foreground">
        {name} · {formatProxyTime(event.ts)}
      </span>
      {hasText && (
        <Bubble align="start" variant="muted">
          <BubbleContent className="whitespace-pre-wrap break-words">{event.content}</BubbleContent>
        </Bubble>
      )}
      {toolCalls.map((call) => (
        <ToolActivityLine key={call.id} call={call} result={index.results.get(call.id)} />
      ))}
    </SpeakerRow>
  );
}

/** 一段折起来的中间步骤（#971，ADR-0229）：默认收着的 <details>，摘要一行写
    「「运营」处理过程 · 3 步 · 5 次工具调用」，展开是每一步的正文（有的话）
    + 工具行——**一个字都不丢**，只是不摊在时间线上。样式照 SystemNoteRow：
    这是审计性质的旁白，不是群里谁说的话；无动效——旁白不该因为能展开就在
    时间线上变重。正在跑的那段（closedBy null）摘要写「正在处理」，位置在
    时间线末尾（同 PendingTurnLines 的理由：说的是此刻） */
function AgentStepsFoldRow({ fold, ws, index }: { fold: AgentStepsFold; ws: WorkspaceSnapshot; index: ToolIndex }) {
  return (
    <details className="px-1 text-[10.5px] italic text-muted-foreground/70">
      <summary className="cursor-default select-none">{agentStepsSummary(fold, ws)}</summary>
      <div className="mt-1 flex flex-col gap-1 not-italic">
        {fold.steps.map((step) => (
          <div key={step.seq} className="flex flex-col gap-0.5">
            {step.content.trim() !== "" && (
              <p className="whitespace-pre-wrap break-words px-1 text-[11px] text-muted-foreground">{step.content}</p>
            )}
            {(step.toolCalls ?? []).map((call) => (
              <ToolActivityLine key={call.id} call={call} result={index.results.get(call.id)} />
            ))}
          </div>
        ))}
      </div>
    </details>
  );
}

/** agent 就位（Task 10）：改提示词生效了在界面上唯一的痕迹——`briefIfNeeded`
    (services/runtime/src/sessionService.ts) 每次改动派发新的 instructions
    才会落这条事件，光看聊天记录本身看不出"我刚改的提示词有没有吃上"，
    这一行就是那个回执。视觉上刻意比 ChatMessageRow/UserMessageRow 更淡更
    小——它是审计性质的旁白，不是群里任何人说的话 */
/** 护栏 / 后台任务回注的旁白（#957 C-I5，#936）：样式照 AgentBriefedRow/
    AgentRelayRow——同属审计性质的旁白，不是群里任何人说的话。正文由
    cloudTimeline.systemNoteText 算好（含 agent 名解析），这里只管画。
    `detail` 非 null 时多一层 `<details>`（第四批 C2-I1：后台任务的 stdout/
    stderr 全文）：**默认收着、无动效**——摘要那一行的字号与颜色一个字不改，
    展开与否是用户的事，旁白不该因为带了详情就在时间线上变重。`<pre>` 那格
    显式 `not-italic`：外面这层是斜体，而命令输出斜体读起来是另一种东西。
    群里 `fromUid === "system"` 的发言（接力护栏 / 棒数上限 / 被踢那句）也走
    这张——它们同样是 runtime 自己说的话，画成气泡就是冒充群里有个叫「系统」
    的人（第四批 B2-I1 的 UI 半） */
function SystemNoteRow({ text, detail }: { text: string; detail?: string | null }) {
  const cls = "px-1 text-[10.5px] italic text-muted-foreground/70";
  if (detail === undefined || detail === null) return <p className={cls}>{text}</p>;
  return (
    <details className={cls}>
      <summary>{text}</summary>
      <pre className="mt-1 whitespace-pre-wrap break-words not-italic text-[11px]">{detail}</pre>
    </details>
  );
}

function AgentBriefedRow({ event }: { event: AgentBriefedEvent }) {
  return (
    <p className="px-1 text-[10.5px] italic text-muted-foreground/70">
      「{event.name}」就位{event.instructions.trim() ? "（提示词已更新）" : ""}
    </p>
  );
}

/** 接力线（#950）：一只 agent 在自己的回复里 @ 了另一只，棒从谁传到谁、
    是第几棒。样式照 AgentBriefedRow——同属审计性质的旁白，不是群里任何
    人说的话。配对的那条 user_message（带 relay）不画（hiddenFromCloudTimeline），
    这一行是它在时间线上唯一的痕迹 */
function AgentRelayRow({ event, ws }: { event: AgentRelayEvent; ws: WorkspaceSnapshot }) {
  return (
    <p className="px-1 text-[10.5px] italic text-muted-foreground/70">
      {relayLineText(event, ws)}
    </p>
  );
}

/** 「谁还没回」（Task 10，src/shared/turnLedger.ts 的 openTurns 是事实来源）：
    画在时间线**末尾**而不是贴在各自那条 @ 消息下面——排队的东西说的是
    "接下来会发生什么"，那是时间线尾巴的事；这是日志的投影不是 UI 本地态，
    daemon 重启回来后重新算一遍照样对得上。running 前面一个跳动的点，
    queued 前面一个不跳动的点——同一屏里"正在做"和"还没轮到"要一眼分开 */
function PendingTurnLines({
  events,
  ws,
  selfUid,
  cs,
}: {
  events: readonly SessionEvent[];
  ws: WorkspaceSnapshot;
  selfUid: string;
  cs: CloudSessionState;
}) {
  const pending = useMemo(() => openTurns(events), [events]);
  // 哪几行画得出「停止」（第四批 C2-I3）：同一只 agent 排了两句话时两行都读成
  // running（turnLedger 认不出「那条动静属于哪一轮」），而在跑的只有最早那一条
  // ——晚的那行上那颗钮点下去停的是别人的轮次。stopButtonRows 把这条判据算成
  // 一份 key 集合，这里只查表；权限那一问仍旧归 canStopTurn，两者是且的关系
  const stoppable = useMemo(() => stopButtonRows(pending), [pending]);
  if (pending.length === 0) return null;
  return (
    <>
      {pending.map((t) => (
        <div key={`${t.seq}:${t.agentId}`} className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
          <span
            className={cn(
              "size-[6px] rounded-full",
              t.state === "running" ? "bg-brand animate-pulse motion-reduce:animate-none" : "bg-muted-foreground/40"
            )}
            aria-hidden
          />
          <span className="flex-1">
            {agentNameOf(ws, t.agentId)} {t.state === "running" ? "正在回复…" : "排队中…"}
          </span>
          {stoppable.has(`${t.seq}:${t.agentId}`) && canStopTurn(t, selfUid, cs) && <StopTurnButton seq={t.seq} />}
        </div>
      ))}
    </>
  );
}

/** 「停止」按钮（#957 第三批）：只对发起人或 owner 显示（canStopTurn，判据
    同审批卡的 canDecide）——不重判权限，服务端的 stop_result 才是唯一事实，
    这里只决定按钮画不画、点下去之后禁用到回执回来。回执前禁用；`ok:false`
    时把服务端的精确文案画在这一行末尾（同 ApprovalRow 的 localError 纪律，
    但这里没有"迟到的拒绝"兜底——stop 没有第二条确认路径，15s 超时兜底已经
    在 cloudSessionClient 的 pendingStop 里做过一次，store.cloudStop 直接
    转发那个 `CloudAck`，**不经 workspaceGroupsError 那格共享状态**，
    见 store 里那条注释与 #957 终审 M3）。
    `seq` = 这一行那句开场白的 seq（第四批 C2-I3）：并发时「此刻在跑的」未必
    是用户点的这一行，服务端拿它与采样边界比对，对不上就回 `not_current` 而
    不是停错一轮。**哪一行画这颗钮**是 Task 7 的事，这里只把 seq 送出去 */
function StopTurnButton({ seq }: { seq: number }) {
  const cloudStop = useChat((s) => s.cloudStop);
  const [stopping, setStopping] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const onClick = async (): Promise<void> => {
    setStopping(true);
    setLocalError(null);
    const r = await cloudStop(seq);
    setStopping(false);
    // 文案取这次调用自己的返回值，不去共享的 workspaceGroupsError 里捞
    // （#957 终审 M3）：那一格里躺着的可能是别人的失败，而这条错误只画在
    // 这一行末尾，归属必须是确定的（同 ApprovalRow 对"迟到拒绝"的立场）
    if (!r.ok) setLocalError(r.message);
  };

  return (
    <>
      <Button variant="ghost" size="xs" disabled={stopping} onClick={() => void onClick()}>
        停止
      </Button>
      {localError && <span className="text-err">{localError}</span>}
    </>
  );
}

/** 一次工具调用的一行可见提示（复审 Rejected #1 补齐）：不用 ToolRow——那
    是折叠展开的重组件，围着本地会话的详情面板设计；这里只要"看得见发生过
    什么"，`toolSummary` 已经把 verb/target 提炼好了，状态从
    `timelineProjection.index`（同一份，OttoThread 顶层算法同款）里查，
    没查到 = 还在执行中（tool_execution_started 落了、tool_result 还没落） */
function ToolActivityLine({ call, result }: { call: ToolCallRequest; result: ToolResultEvent | undefined }) {
  const { verb, target } = toolSummary(call);
  const statusText = !result
    ? "执行中…"
    : result.status === "ok"
      ? "完成"
      : result.status === "denied"
        ? "被拒绝"
        : "出错";
  return (
    <span className="px-1 text-[11px] text-muted-foreground">
      {verb}
      {target ? ` ${target}` : ""} · {statusText}
    </span>
  );
}

/** 未决审批卡(贴着输入区,不是时间线上的一行)。selfUid ∈ {initiatorUid,ownerUid}
    才有按钮——这个人要么是触发这次审批的那个操作的发起人,要么是这条云会话
    的 owner(据此复审别人的操作);其余成员只读一句"等待谁审批",不能替别人
    按下批准/拒绝(main/cloudSessionClient.ts deliverEvent 的资格判断在推送
    那一层就已经把卡只发给够格的人,这里的 canDecide 是同一条判据在渲染层
    的镜像——群聊场景大家共读同一份 events,不是每个人各收各的)。
    点下去的反馈(#957 C-I2/#927 桌面侧)：`submitting` 按这张卡自己记(卡本身
    按 callId 有 key，state 天然不会串到别的卡上)。`ok:false` 才把按钮放回来、
    在**卡内**画原因——不进 workspaceGroupsError 共享格，那一格里躺着的可能是
    别人的失败，卡外再画一遍反而像两件事。`ok:true` 就保持 disabled 到这张卡
    从 pendingApprovals 消失(父组件按 callId 卸载这一整行，本地 state 随之
    清空，不需要额外清理)。
    **两条启发式兜底已删**（第四批 C2-I2）：一条是"submitting 期间
    workspaceGroupsError 变了就当作这一条被拒了"，另一条是 15s 没动静就把按钮
    放回来。两条都写在协议还没有 `approve_result` 的年代——那时 `ok:true` 只
    确认"帧交给了 socket"，拒绝走不带 callId 的 error 帧，所以只能猜。协议 6
    起 `approve_result{callId}` 是权威回执，而 ACK 超时/连接没了已经在
    cloudSessionClient 里收敛成 `ok:false` + `unknown`——留着这两条兜底，它们
    在真回执之后**只可能说假话**：一件无关的失败（配置保存挂了、限速）会被
    抄成这张卡的拒绝理由，15s 那条则会在一次慢但成功的审批之后把按钮放回来，
    让人再批一次 */
function ApprovalRow({
  event,
  ws,
  waitingLabel,
  canDecide,
  ready,
  onApprove,
  onDeny,
}: {
  event: ApprovalRequestEvent;
  ws: WorkspaceSnapshot;
  waitingLabel: string;
  canDecide: boolean;
  ready: boolean;
  onApprove: () => Promise<CloudAck>;
  onDeny: () => Promise<CloudAck>;
}) {
  const [submitting, setSubmitting] = useState<"approved" | "denied" | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  // 「已批准，等待生效…」这类中性的话与 localError 分开存（第四批 C2-I2）：
  // 同一格两种色的话，样式就得靠一个额外的 tone 字段决定，而两条本来就不会
  // 同时出现——`ok:true` 只有 note，`ok:false` 只有 error
  const [localNote, setLocalNote] = useState<string | null>(null);

  const decide = async (decision: "approved" | "denied", run: () => Promise<CloudAck>): Promise<void> => {
    setSubmitting(decision);
    setLocalError(null);
    setLocalNote(null);
    const r = await run();
    if (r.ok) {
      // 保持 disabled：这张卡会因为 approval_decision 落地而消失。这句话是
      // 说给「回执到了但事件还在路上」那一两秒听的——按钮焊死而屏幕上一个字
      // 都没有，看起来就像点了没反应
      setLocalNote(decision === "approved" ? "已批准，等待生效…" : "已拒绝，等待生效…");
      return;
    }
    // `unknown`（没收到回执）也把按钮放回来：这一层确实不知道有没有生效，
    // 而"再点一次"在审批上是幂等的（服务端按 callId 去重，重复的那次回
    // no_pending），代价远小于把按钮永久焊死
    setSubmitting(null);
    setLocalError(r.message);
  };

  const fields = event.argsFields;
  const disabled = !ready || submitting !== null;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border px-3 py-2">
      <div className="min-w-0">
        <span className="text-xs font-medium">{approvalCardTitle(event, ws)}</span>
        {fields && fields.length > 0 ? (
          <div className="mt-1 flex flex-col gap-1.5">
            {fields.map((f, i) => (
              <div key={i}>
                <p className="text-[10.5px] text-muted-foreground">{f.label}</p>
                <p
                  className={cn(
                    "whitespace-pre-wrap break-words text-[12px]",
                    i === fields.length - 1 && "border border-border rounded-md p-2 max-h-48 overflow-y-auto"
                  )}
                >
                  {f.value}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-0.5 text-[12px] whitespace-pre-wrap break-words text-muted-foreground">
            {event.argsSummary}
          </p>
        )}
      </div>
      {canDecide ? (
        <div className="flex flex-col items-end gap-1">
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="xs" className="text-err" disabled={disabled} onClick={() => void decide("denied", onDeny)}>
              拒绝
            </Button>
            <Button size="xs" disabled={disabled} onClick={() => void decide("approved", onApprove)}>
              批准
            </Button>
          </div>
          {localNote ? (
            <p className="text-[11px] text-muted-foreground">{localNote}</p>
          ) : submitting ? (
            <p className="text-[11px] text-muted-foreground">已提交，等待生效…</p>
          ) : null}
          {localError && <p className="text-[11px] text-err">{localError}</p>}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">等待 {waitingLabel} 审批</p>
      )}
    </div>
  );
}
