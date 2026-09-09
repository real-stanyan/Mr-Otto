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
// 不出就原样显示全文当正文。assistant_message **只有最终答案画得出来**
// （#1055）：要了工具的、或一个字没说的那几条是「中间步骤」，
// `hiddenFromCloudTimeline` 第 ⑥ 条把它们整段挡在时间线外，人要知道的
// 「它此刻在忙」由末尾那几行输入指示器说（PendingTurnLines）。
//
// 审批卡不搬 App.tsx 那套 ApprovalCardBody——那一套是围着本地 decide()
// 的五种意志（批/拒/中止/授权档位/改过的参数）与 diff 分块取舍搭的，云端
// 协议只认 approved/denied 两种（cloudSessionClient.ts deliverEvent 的
// availableDecisions 写死 ["approve","deny"]），硬套只会引入一堆点了也没
// 效果的按钮。这里另起一张更薄的卡，可视觉语言（圆角边框、pill 按钮）不
// 新造。

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, AtSign, Download, Phone, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Bubble, BubbleContent } from "@/components/ui/bubble.js";
import { splitBubbles } from "@/lib/chatBubbles.js";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.js";
import { Textarea } from "@/components/ui/textarea.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { COMPOSER_METRICS, ComposerActions, ComposerBar, ComposerSend, ComposerToolbar } from "@/components/elements/composer.js";
import { TypingIndicator } from "@/components/elements/typing-indicator.js";
import { ghostButton } from "@/lib/surfaces.js";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover.js";
import { useChat, type CloudSessionState } from "../store.js";
import { EventRow, TimelineProjectionContext } from "./Timeline.js";
import { buildToolIndex } from "../lib/toolIndex.js";
import { groupSubagentSpawns } from "../lib/subagentTimeline.js";
import { formatProxyTime } from "../lib/proxyShare.js";
import { agentNameOf, labelOf, memberAvatarOf } from "../lib/workspaceView.js";
import { agentAvatarSrc } from "../lib/agentAvatar.js";
import { applyAgentMention, mentionQueryAt, pickerEmptyState, resolveSendMentions } from "../lib/agentMentionInput.js";
import { filterMentionRows, mentionRows, MENTION_KIND_LABEL, type MentionRow } from "../lib/workspaceMentionItems.js";
import {
  approvalCardTitle, assistantLabel, canStopTurn, cloudEmptyState, hiddenFromCloudTimeline, relayLineText,
  stopButtonRows, systemNoteText, turnEndedLineText, userRowIdentity, voiceCallLineText,
} from "../lib/cloudTimeline.js";
import { systemNoteDetail } from "../lib/systemNote.js";
import { TurnErrorState } from "./TurnErrorState.js";
import { ThreadHistorySkeleton } from "./assistant-ui/thread.js";
import { openTurns } from "../../../shared/turnLedger.js";
import { safeSpeakerLabel, SYSTEM_SPEAKER_UID } from "../../../shared/promptSafe.js";
import { mentionTokens, parseMemberMentions, parseMentions, type MentionCandidate } from "../../../shared/remote/agentMention.js";
import type {
  AgentBriefedEvent, AgentRelayEvent, ApprovalDecisionEvent, ApprovalRequestEvent, AssistantMessageEvent,
  ChatMessageEvent, SessionEvent, VoiceCallChangedEvent,
} from "../../../session/events.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";
import type { CloudAck } from "../../../shared/shellBridge.js";
import { CS_PROTOCOL_VERSION } from "../../../shared/remote/cloudSession.js";
import { modelStatusText } from "../lib/cloudModelStatus.js";
import { buildCloudLogExport } from "../lib/cloudExport.js";
import { downloadText } from "../lib/downloadText.js";
import { sandboxApprovalBanner, sandboxApprovalControl } from "../lib/sandboxApprovalControl.js";
import { SandboxApprovalToggle } from "./BypassSwitch.js";
import { CloudContextRing } from "./CloudContextRing.js";
import { VoiceCallBar } from "./VoiceCallBar.js";
import { VoiceCallOverlay } from "./VoiceCallOverlay.js";
import { callStarterUid } from "../lib/voiceCallView.js";
import { VoicePickerPopover } from "./VoicePickerPopover.js";
import { voiceCallAvailable } from "../lib/voiceCall.js";
import { voiceCallOf } from "../../../shared/voiceCall.js";
import { useConfirm } from "@/components/ui/confirm-dialog.js";

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
      return "你不是这个团队的成员";
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
  /** 点到的人类成员 uid（#1064）。重发要连它一起带——不带的话「重新发送」
      那一下把提醒悄悄吞了，而用户以为这次和上次发的是同一句话 */
  memberMentions: string[];
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
  /** 头部那颗「设置」（#991）：打开这个团队的设置抽屉（仓库 / 智能体 / 成员 /
      连接器）。省掉 = 不画（抽屉时代这一页自己就在设置里） */
  onSettings?: () => void;
}) {
  const cs = useChat((s) => s.cloudSession);
  const cloudSay = useChat((s) => s.cloudSay);
  const cloudApprove = useChat((s) => s.cloudApprove);
  const cloudArchive = useChat((s) => s.cloudArchive);
  // 语音通话（#1163）：名单是日志事实（voiceCallOf），「我在听」是本机状态（store.voice）
  const cloudCall = useChat((s) => s.cloudCall);
  const voice = useChat((s) => s.voice);
  const billing = useChat((s) => s.billing);
  const joinVoiceCall = useChat((s) => s.joinVoiceCall);
  const setVoiceMuted = useChat((s) => s.setVoiceMuted);
  const setVoiceMic = useChat((s) => s.setVoiceMic);
  const confirm = useConfirm();
  const setSandboxApproval = useChat((s) => s.setWorkspaceSandboxApproval);
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
  // 「免审批」那颗开关（#1029，ADR-0243）：值是快照的投影（受控），
  // 这两格只管「写在飞吗」与「上一次写为什么没成」。错误**不进 actionError**——
  // 那一格随便哪件不相干的成功都会把它清掉，而这条说的是一次安全设置没改上。
  // `sandboxBusy` **故意不随换会话清**：清了之后，A 那次写回来时的
  // `setSandboxBusy(false)` 会把 B 此刻在飞的那次也解禁，于是同一颗开关点得动两次。
  // 代价是从 A 换到 B 的那一小段里 B 的开关是灰的——比多发一次写好
  const [sandboxBusy, setSandboxBusy] = useState(false);
  const [sandboxError, setSandboxError] = useState<string | null>(null);
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
  // 通话旁白要看前一条名单（差集出「拉进 / 移出 / 开始 / 结束」，#1163）：一次扫出
  // 每条 voice_call_changed 的前一条，渲染循环里 O(1) 查
  const call = useMemo(() => voiceCallOf(events), [events]);
  const voiceAvailable = voiceCallAvailable(billing);
  // 全屏通话视图（#1185，ADR-0278）：本机界面状态；通话结束（call 变 null）时随之关掉
  const [callOpen, setCallOpen] = useState(false);
  const callView = useMemo(
    () => ({ selfUid, starterUid: call ? callStarterUid(events, call) : null, openAgentIds: new Set(openTurns(events).map((t) => t.agentId)) }),
    [events, call, selfUid]
  );
  /** 结束通话 = 全组（拍板 ⑥）：一条空名单事件让所有人的栏消失，所以先问一句 */
  const endCall = async (): Promise<CloudAck> => {
    const ok = await confirm({
      title: "结束语音通话？",
      description: "所有人的通话栏都会消失，之后的回复只出字。只想自己不听的话用「静音」。",
      confirmLabel: "结束",
      tone: "danger",
    });
    if (!ok) return { ok: true };
    return cloudCall([]);
  };
  const prevVoiceCall = useMemo(() => {
    const m = new Map<number, VoiceCallChangedEvent | null>();
    let prev: VoiceCallChangedEvent | null = null;
    for (const e of events) {
      if (e.type !== "voice_call_changed") continue;
      m.set(e.seq, prev);
      prev = e;
    }
    return m;
  }, [events]);

  // 时间线行共读的日志投影,同 OttoThread 顶层的算法(aui/OttoThread.tsx:957)
  const timelineProjection = useMemo(
    () => ({ index: buildToolIndex(events), groups: groupSubagentSpawns(events), events }),
    [events]
  );
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

  // ── @ 选人（#932 切片 1b；名单加人 + 换版式见 #1059 / ADR-0252）──────────
  // 名单第一只 = 这个团队的管理员（服务端按 created_at 升序给，见 Task 3）
  //
  // **两份名单，各管一件事，故意不合并**：
  //   · `candidates`（只有 agent）→ parseMentions / chip 行 / 发送时的 `mentions`。
  //     服务端 resolveTargets 按 agent id 过滤，人类 uid 放进去只会被静默丢掉。
  //   · `rows`（agent + 人类成员）→ 弹层画哪几行。云会话是**群聊**，房里两族都在，
  //     人类成员的头像与署名时间线上一直画着（#971），唯独 @ 的时候他们不存在。
  // 第三份 `memberCandidates` 是给 resolveSendMentions 判「这个 @ 认不认得」用的
  // ——不加它，@ 一个人类成员会被当成打错字整句拦下来
  const candidates = useMemo(
    () => ws.agents.map((a) => ({ agentId: a.agentId, name: a.name, description: a.description })),
    [ws.agents]
  );
  const rows = useMemo(() => mentionRows(ws), [ws]);
  // 人类那一族的候选（uid 借 agentId 那一格，永远不会进 `mentions`）。#1064
  // 之后它有了第二个消费方：算出这句话点到了哪几个人，好让他们真收到提醒
  const memberCandidates = useMemo(
    () => ws.members.map((m) => ({ agentId: m.uid, name: m.label })),
    [ws.members]
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
  const options = picking ? filterMentionRows(rows, picking.query) : [];
  // 名单刚变过（改名/新增）时 options 会是空的——不画空态的话弹层压根不开，
  // 用户以为自己没打对字，实际是这份本地快照过期了（#935 / #957 C-I4）
  const emptyState = pickerEmptyState(picking, options);
  // 发送时点了谁：与 chip 行**同一次**调用算出来的同一份 —— 界面上写着发给
  // 谁，服务端就跑谁。两边各算各的就会分家（坑 ④）
  const mentions = useMemo(() => parseMentions(draft, candidates), [draft, candidates]);
  // 这句话点到了哪几个**人类成员**（#1064）。撞名归 agent：判据是**同一个 @
  // 的位置**（parseMemberMentions），不是名字前缀——agent「小红助手」+ 成员
  // 「小红」时，`@小红助手` 在成员那一遍照样匹配得到「小红」，按名字判会给
  // 一个根本没被点到的人发提醒
  const memberMentions = useMemo(
    () => parseMemberMentions(draft, candidates, memberCandidates),
    [draft, candidates, memberCandidates]
  );
  // 候选变了高亮归零：不归零的话，从三个候选里选中第三个、再多打一个字缩到
  // 一个候选时，hi 还停在 2，Enter 什么都选不中
  // key 而不是 agentId：人类那一族的 agentId 恒为 null，按它拼出来的串在
  // 「三个人 → 两个人」这种变化上完全不动，hi 于是停在一个已经不存在的下标上
  const optionKey = options.map((o) => o.key).join(",");
  useEffect(() => {
    setHi(0);
  }, [optionKey]);

  const csSessionId = cs?.sessionId ?? null;
  // 换云会话时把这四格本地状态清干净（复审 H1；第四格是 #1029 那颗开关的错误行）。
  // **这个组件在换会话时不卸载**
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
    // 「免审批没改上」是一句关于**某个团队**的话；换到另一个团队的会话上
    // 还挂着它就是在说一件跟这里无关的事。`sandboxBusy` 故意不清，理由写在它的
    // 声明处；这道闸也不是全部——await 回来得更晚的那一次由 toggleSandbox 自己比对
    setSandboxError(null);
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
      // memberMentions 从**此刻的名单**重算（#1064）：这条 seed 来自开局卡那一句，
      // 它当初算过一次，但那份没有被交接过来——重算比把它一路带下来简单，
      // 而且这一刻的名单只会更新
      setUnsent({
        sessionId: csSessionId,
        text: seed.text,
        mentions: undefined,
        memberMentions: parseMemberMentions(seed.text, candidates, memberCandidates),
        note: unknownNote(seed.text),
      });
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
  // owner 判据在 `sandboxApprovalControl` 里取 `ws.ownerUid` 不取 `cs.ownerUid`：
  // 后者在开会话的占位期间是空串（welcome 到了才真），照它判 owner 自己会先看到
  // 一拍「所有者可改」再跳变——所以这里喂进去的是快照不是 cs
  const sandbox = sandboxApprovalControl(ws, selfUid);
  const sandboxBanner = sandboxApprovalBanner(sandbox);

  /** 翻那颗开关。**不做乐观翻转**：值是快照的投影，写成功才 patch 那一格
      （store.setWorkspaceSandboxApproval），失败原样停在旧值 + 一行原因 */
  const toggleSandbox = async (next: boolean): Promise<void> => {
    if (sandboxBusy) return;
    const at = csSessionId;
    setSandboxBusy(true);
    setSandboxError(null);
    const r = await setSandboxApproval(ws.id, next ? "auto" : "ask");
    setSandboxBusy(false);
    // **回来时人可能已经换到别的会话了**（同 `unsent.sessionId` 那道闸的道理，复审 H1）：
    // 这个组件换会话不卸载，而上面那个按 csSessionId 清空的 effect 在这次 await
    // 之前就跑完了——判据必须在数据里，不能靠 effect 的时序。那句失败原文里没有
    // 团队名，落在 B 的页面上看不出它说的是 A
    if (!r.ok && useChat.getState().cloudSession?.sessionId === at) setSandboxError(r.message);
  };

  /** 一次发送：mentions 缺席就不传第二参（老语义，服务端按名字解析 + 回落
      名单第一只），给了就以它为准 —— 重发走的是同一条路 */
  const sendOnce = async (payload: UnsentLine): Promise<CloudAck> =>
    // 第一格 `undefined` 与 `[]` 是两句不同的话（缺席 = 交给云端解析），所以
    // 这里仍然分两条；第二格没有这个区别（空数组 = 没点到人 = 一行都不写），
    // 原样带过去就行
    payload.mentions === undefined
      ? await cloudSay(payload.text, undefined, payload.memberMentions)
      : await cloudSay(payload.text, payload.mentions, payload.memberMentions);

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
    // await 期间人可能已经切到同团队的另一条会话（**这个组件换会话不卸载**），
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
    // 人类成员（#1059）：**同一次刷新里取**，不从上面那个 `ws` 闭包读 —— 与
    // freshCandidates 同一条纪律。名字来自 profiles.name（label），uid 只是拿来
    // 占 MentionCandidate 的 agentId 那一格，永远不会进 `mentions`
    let freshMembers: MentionCandidate[] = [];
    let sendMemberMentions = memberMentions;
    if (mentionTokens(text).length > 0 && mentions.length === 0) {
      await refreshWorkspaceGroups();
      // 不从这个组件已经渲染出的 `ws`/`candidates` 闭包读（那份还是刷新前的
      // 旧值），直接问 store 要这一刻的真实状态
      const fresh = useChat.getState();
      refreshFailed = fresh.workspaceGroupsError !== null;
      const freshWs = fresh.workspaceGroups.find((g) => g.id === ws.id);
      // 刷新「成功」但这个团队不在返回的清单里 = 名单同样没拿到（被踢出去 /
      // 团队没了），按 null 走「交给云端按名字解析」那条：拿它当「名单里没有
      // 这个人」去拦，就是对着一句完全正常的话说「没有叫 X 的智能体」
      freshCandidates = freshWs ? freshWs.agents.map((a) => ({ agentId: a.agentId, name: a.name })) : null;
      freshMembers = freshWs ? freshWs.members.map((m) => ({ agentId: m.uid, name: m.label })) : [];
      // 提醒名单也用这一次刷新的结果重算（#1064）：走到这条分支说明本地快照
      // 很可能过期，而 `memberMentions` 那个 memo 算的正是过期那份。找不到
      // 这个团队时（被踢 / 群没了）两份名单都是空的，于是谁都不通知——
      // 这与「把解析权交给云端」并不矛盾：云端认得 agent，认不得人
      sendMemberMentions = parseMemberMentions(text, freshCandidates ?? [], freshMembers);
    }
    const plan = resolveSendMentions({
      text, parsed: mentions, refreshFailed, freshCandidates, memberCandidates: freshMembers,
    });
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
      // 于是一句 "@管理员 帮我看下" 照旧有人接；`[]` 是权威的「没点任何 agent」，
      // resolveSendMentions 只在**这几个 @ 全点在人类成员上**时才给出它（#1059）
      mentions: plan.mentions,
      memberMentions: sendMemberMentions,
      note: unknownNote(text),
    };
    const r = await sendOnce(payload);
    // 会话对不上就什么都不写（终审 Finding 4）：await 期间人可能已经切到同团队的
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
          跟着内容滚，翻旧消息时「这是哪个团队、路由走哪条、设置在哪」全看不见。
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
          // 没有返回键时团队名仍然要在：这一行回答的是「我在哪个团队里」，
          // 而云会话的每一件事（谁能看见、扣谁的额度、用哪把 key）都挂在它上面
          <span className="px-1.5 py-1 text-[12.5px] text-muted-foreground">{ws.name}</span>
        )}
        <div className="flex items-center gap-1.5">
          {/* 归档不在这儿（#993 第 5 条）：它属于侧栏那条会话行的 ⋮ 菜单，同本地
              会话——头部是"这条会话是什么"，不是"对它做什么"。协议 9 把 archive
              搬进控制房正是为了让那颗菜单项不必先开着这条会话 */}
          {/* 模型那一格**只在起不了 turn 的时候出现**（#1052，ADR-0246）：正常那两态
              （hosted / 探不到）不画——「一切正常」不需要常驻标签，何况 hosted 报的
              只是团队默认款，真跑一轮按 agent 白名单/Auto 现取，两者可以不一样。
              仓库同理不在头部（#991）：不是每个团队都有仓库，常驻一格「未配仓库」
              对文案类团队是噪音——它去了「设置」里的仓库 tab */}
          {modelStatus && (
            <span className="max-w-[150px] truncate text-[11px] text-err" title={modelStatus.full}>
              {modelStatus.short}
            </span>
          )}
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
          {/* 导出本会话全部事件日志（#1117）：jsonl 无损全量，拿出去分析优化用。
              数据本来就在渲染层（backlog 全量 + 直播），纯本地动作不打网络。
              历史有缺口（gapNote）时照导不误，但 title 里说出来——那份文件
              不是「全部」，读它的人必须知道 */}
          <Button
            variant="outline"
            size="xs"
            className="shrink-0"
            disabled={!cs || events.length === 0}
            onClick={() => {
              if (!cs || events.length === 0) return;
              const file = buildCloudLogExport({
                sessionId: cs.sessionId,
                events,
                exportedTs: Date.now(),
              });
              downloadText(file.filename, file.mime, file.text);
            }}
            title={
              !cs || events.length === 0
                ? "还没有可导出的事件"
                : cs.gapNote
                  ? `导出本会话全部事件日志（jsonl）。注意：${cs.gapNote}`
                  : "导出本会话全部事件日志（jsonl），用于分析优化"
            }
          >
            <Download className="size-[13px]" aria-hidden />
            导出
          </Button>
        </div>
      </div>

      {/* 语音通话中（#1163）：头部之下一条常驻栏，照微信群语音。判据是日志里的名单，
          谁都看得见；「我在听」那份只在 sessionId 对得上时才算（换会话不带过去） */}
      {call && cs && (
        <VoiceCallBar
          ws={ws}
          call={call}
          voice={voice && voice.sessionId === cs.sessionId ? voice : null}
          available={voiceAvailable}
          ready={ready}
          onJoin={joinVoiceCall}
          onMute={setVoiceMuted}
          onMic={setVoiceMic}
          onUpdate={(ids) => cloudCall(ids)}
          onEnd={endCall}
          onExpand={() => setCallOpen(true)}
        />
      )}
      {call && cs && (
        <VoiceCallOverlay
          open={callOpen}
          onOpenChange={setCallOpen}
          ws={ws}
          call={call}
          voice={voice && voice.sessionId === cs.sessionId ? voice : null}
          view={callView}
          available={voiceAvailable}
          ready={ready}
          onJoin={joinVoiceCall}
          onMic={setVoiceMic}
          onMute={setVoiceMuted}
          onUpdate={(ids) => cloudCall(ids)}
          onEnd={endCall}
        />
      )}

      {/* 滚动区：横幅 + 时间线 + 错误行。scrollbar-stable 同外层原来那份；
          px-4 与本地会话一条量尺（aui viewport 的 `max-w-(--thread-max-width) px-4`，
          那个变量本仓没定义 = 无上限，所以本地就是「占满 + px-4」，#993 第 2 条）；
          pb-14 不是「留口气」是**算出来的**：footer 顶上那道滚动缘渐隐是
          `-top-10 h-10`，即压在滚动区最后 40px 上，而原来的 pb-3 只有 12px——
          末尾 28px 的正文因此永远蒙着一层暗底（#995 第 1 条）。本地会话那边
          留的是 mb-14（56px，thread.tsx 的 message-group）且运行指示条
          `sticky bottom-0 z-10` 骑在渐隐之上，所以从来不糊；这里照同一把尺，
          40px 渐隐之外还剩 16px 是真正看得见的间距。onScroll 记「此刻在不在底部」
          给上面那条跟底 effect 用（阈值 48px：滚动条抖一下不算离开） */}
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className="flex flex-1 min-h-0 flex-col gap-3 overflow-y-auto scrollbar-stable px-4 pt-3 pb-14"
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
              // 一道判据管所有「这一行画不画」（#1055 把中间步骤那道合了进来）
              if (hiddenFromCloudTimeline(e)) return null;
              if (e.type === "chat_message") {
                return (
                  <ChatMessageRow
                    key={e.seq}
                    event={e}
                    mine={e.fromUid === selfUid}
                    avatarUrl={memberAvatarOf(ws, e.fromUid)}
                  />
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
                    mine={identity.mine}
                    avatarUrl={identity.uid ? memberAvatarOf(ws, identity.uid) : ""}
                  />
                );
              }
              if (e.type === "assistant_message") {
                return <AssistantMessageRow key={e.seq} event={e} ws={ws} />;
              }
              if (e.type === "agent_briefed") {
                return <AgentBriefedRow key={e.seq} event={e} />;
              }
              if (e.type === "voice_call_changed") {
                return <VoiceCallRow key={e.seq} text={voiceCallLineText(prevVoiceCall.get(e.seq) ?? null, e, ws)} />;
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
                  return (
                    <TurnErrorState
                      key={e.seq}
                      title={agentTitle}
                      detail={e.error ?? "没有错误信息"}
                      interactive={false}
                      className="max-w-none"
                    />
                  );
                }
                return <EventRow key={e.seq} event={e} isLast={false} />;
              }
              return <EventRow key={e.seq} event={e} isLast={i === events.length - 1} />;
            })
          )}
          {/* 排队中/正在回复画在时间线**末尾**而不是贴在各自那条 @ 消息下面：
              排队的东西说的是"接下来会发生什么"，那是时间线尾巴的事，不是
              历史里某一行的注脚（跟 turn_ended 的错误行不同——那是已经发生
              的事实，钉在它发生的位置）*/}
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
        {/* 这一行如今只剩「读不到」一种情形：免审开着时的常驻警示 2026-09-08
            被维护者撤掉（开着就是开着，警示色药丸自己说）；「读不到」那句留下，
            因为那一格恰恰可能正开着免审，闷着等于把危险藏进 title（判据与原文
            都在 sandboxApprovalControl.ts 的 `sandboxApprovalBanner` 头注里） */}
        {sandboxBanner && <p className="mb-[6px] px-1 text-[11px] text-warn">{sandboxBanner}</p>}
        {/* 这次翻开关自己的失败原因，不进共享的 actionError（那一格随便哪件不相干
            的成功都会把它清掉，而这条说的是一次安全设置没改上） */}
        {sandboxError && <p className="mb-[6px] px-1 text-[11px] text-err">{sandboxError}</p>}
        {/* 外壳与本地会话的输入框**同一套**（#985；App.tsx 的 ChatComposer）：
            elements/composer 的 ComposerBar 把「这一条要发的东西」当成一摞来排——
            点名行 / 输入 / 工具条——类名逐字照抄那边。工具条左边那条偏好栏只留下
            **免审那一颗**（#1029，ADR-0243）：型号 / thinking 在云会话里是**团队**的
            属性不是这条会话的（ADR-0202 / 0233，同 CloudWelcome 头注），摆上来就是
            两个点了不生效的控件；用量环**回来了**（#1138，发送键左边，同本地的位置）
            ——上下文是每只 agent 各自的事实，日志里推得出来，见 CloudContextRing.tsx。
            而免审那颗虽然也是团队级的，却是**踩刹车
            的地方就该在手边**——它要在一张审批卡挡着群聊的那一刻够得着，而不是让人先
            去翻设置抽屉。作用域上的代价（翻一次全团队跟着变）由它自己的文案 + 开着时
            那条常驻警示行说出口。cursor-text + 点空白处聚焦：本地那边由
            ComposerPrimitive.Root 代劳，这里没有它，自己接一下 */}
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
                placeholder={ready ? "输入 @ 点名智能体或成员；不 @ 的话，谁的活谁接" : "还没连上，暂时发不了消息"}
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
                  <span>没有叫「{emptyState.query}」的成员或智能体（名单可能刚变过）</span>
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
                  <MentionOptionRow
                    key={o.key}
                    ws={ws}
                    row={o}
                    selected={i === hi}
                    onPick={() => pick(i)}
                    onHover={() => setHi(i)}
                  />
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
            {/* 左簇包一层：ComposerToolbar 是 justify-between，直接摆三个兄弟会把
                中间那个推到正中央。本地那边靠偏好栏外壳 flex-1 做同一件事 */}
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                disabled={!ready}
                onClick={insertAt}
                title="@ 智能体或成员"
                aria-label="@ 智能体或成员"
                className={cn(ghostButton, "size-8 disabled:pointer-events-none disabled:opacity-30")}
              >
                <AtSign className="size-4" aria-hidden />
              </button>
              {/* 语音通话（#1163）：拉谁进语音。没订阅 / 还没查到 / 网关不供语音一律不画
                  （同 modelMenu 对 hosted 的处置，#722 纪律）；通话进行中这颗钮亮成品牌色，
                  点开是同一个弹层改名单 */}
              {voiceAvailable && cs && (
                <VoicePickerPopover
                  ws={ws}
                  current={call?.participants.map((p) => p.agentId) ?? null}
                  ready={ready}
                  onSubmit={(ids) => cloudCall(ids)}
                  onStarted={joinVoiceCall}
                >
                  <button
                    type="button"
                    disabled={!ready}
                    title={call ? "更新通话名单" : "开始语音通话"}
                    aria-label={call ? "更新通话名单" : "开始语音通话"}
                    className={cn(ghostButton, "size-8 disabled:pointer-events-none disabled:opacity-30", call && "text-[var(--brand)]")}
                  >
                    <Phone className="size-4" aria-hidden />
                  </button>
                </VoicePickerPopover>
              )}
              {/* 本地会话的免审开关就在这个位置（App.tsx 的 approvalToggle）。
                  管的东西不一样，所以名字也不一样——见 lib/sandboxApprovalControl.ts */}
              <SandboxApprovalToggle
                control={sandbox}
                busy={sandboxBusy}
                onChange={(next) => void toggleSandbox(next)}
              />
            </div>
            <ComposerActions>
              {/* 上下文用量环（#1138）：数据源全是日志投影——每只 agent 各自的视野 +
                  信封里的工具表 + 目录里的窗口，画最吃紧那只；额度那半只在我是 owner
                  时画（云会话烧的是 owner 的额度，ADR-0233，而 store.billing 是我的）。
                  团队默认型号只给还没跑过一轮的 agent 兜底 */}
              {cs && (
                <CloudContextRing
                  events={events}
                  ws={ws}
                  fallbackModel={cs.modelRoute?.kind === "hosted" ? cs.modelRoute.model : null}
                  quotaApplies={cs.ownerUid === selfUid}
                />
              )}
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
function ChatMessageRow({
  event,
  mine,
  avatarUrl,
}: {
  event: ChatMessageEvent;
  mine: boolean;
  avatarUrl: string;
}) {
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
    <SpeakerRow mine={mine} avatar={<PersonAvatar name={name} src={avatarUrl} />}>
      <span className="px-1 text-[10.5px] text-muted-foreground">
        {name} · {formatProxyTime(event.ts)}
      </span>
      <Bubble align={mine ? "end" : "start"} variant={mine ? "tinted" : "muted"}>
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
    每一行都有脸比「有的有有的没有」整齐。

    `mine` 这个参数 #993 第 4 条整个删过一次又在 #995 第 2 条加了回来，两次
    要的不是同一件事：#993 说的是**标签行**（人和 agent 一样只写「名字 ·
    时间」，不写「→ 发给谁」），当时连着排布一起拿掉是做过头了；#995 说的是
    **排布**（自己发的靠右，其他群成员跟 agent 一样靠左）。所以现在两条同时
    成立：标签行一视同仁，靠边只区分「是不是我」。改这里之前先分清动的是哪一层 */
function SpeakerRow({
  mine,
  avatar,
  children,
}: {
  mine: boolean;
  avatar: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex max-w-[85%] gap-2", mine ? "flex-row-reverse self-end" : "self-start")}>
      <div className="shrink-0 pt-[3px]">{avatar}</div>
      <div className={cn("flex min-w-0 flex-col gap-0.5", mine ? "items-end" : "items-start")}>
        {children}
      </div>
    </div>
  );
}

/** 成员头像：profiles.avatar_url 有就画图，没有退回首字母（同 FriendChatView /
    identity.ts 的 initial 纪律——取首个码点不取 charAt，emoji 名字按 UTF-16
    切会得到半个代理对） */
function PersonAvatar({ name, src }: { name: string; src: string }) {
  return (
    <Avatar size="sm">
      {src !== "" && <AvatarImage src={src} alt={name} />}
      <AvatarFallback>{initialOf(name)}</AvatarFallback>
    </Avatar>
  );
}

/** 首字母兜底：取首个**码点**不取 charAt —— emoji 名字按 UTF-16 切会得到半个
    代理对（同 identity.ts / FriendChatView 的既有纪律）。三处头像共用一份 */
function initialOf(name: string): string {
  return ([...name.trim()][0] ?? "?").toUpperCase();
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
      <AvatarFallback>{initialOf(name)}</AvatarFallback>
    </Avatar>
  );
}

/** @ 选人弹层里那一枚（#1059）：两族共用一格，agent 画内置像素头像、人类画
    profiles.avatar_url —— 头像是这张列表上「这一行是谁」的第一眼，两族画法不同
    才认得出来（右边那格标注是第二道，给撞脸/没头像的情形兜底）。
    20px 而不是上面两处的 24px（`size="sm"`）：这一行的字号是 12.5px，脸跟气泡
    旁边一样大会把行撑到 34px，一屏就少两行。所以不复用 PersonAvatar/AgentAvatar，
    尺寸是这一格与那两处唯一的差别，但它决定整张列表能一眼扫几行 */
/** @ 选人弹层里的一行（#1068 从 CloudSessionPage 内联那段提出来）：
    **头像 · 名字 · 灰字 · 靠右的「成员 / 智能体」**。
    导出是为了让 `tests/renderer/mentionOptionRow.test.tsx` 真渲染一遍——纯逻辑那份
    （`workspaceMentionItems.test.ts`）钉的是 `MentionRow` 每一格的值，钉不到"这几格
    有没有真被画出来"；维护者对这块 UI 提的两件事（左边圆圈是这个人的脸、右边标出
    人还是 agent）恰好都只在这一层看得见。行为一字未改，纯提取。 */
export function MentionOptionRow({
  ws, row, selected, onPick, onHover,
}: {
  ws: WorkspaceSnapshot;
  row: MentionRow;
  selected: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  return (
    <div
      role="option"
      aria-selected={selected}
      // mousedown + preventDefault：用 click 的话 textarea 会先失焦，
      // 写回之后那次 setSelectionRange 就落在一个没焦点的框上
      onMouseDown={(e) => {
        e.preventDefault();
        onPick();
      }}
      onMouseEnter={onHover}
      // **高亮不给 transition**：这一行是方向键连着按出来的，一次挑人可能扫过
      // 五六行，补间会让高亮拖在手指后面 —— 键盘发起的动作不做动效（同 App.tsx
      // 的 ⌘K 那套）。上游 assistant-ui 那份带 transition-colors，是因为它主要
      // 靠鼠标悬停
      className={cn(
        "flex cursor-default items-center gap-2 rounded-sm px-2 py-[5px] text-[12.5px]",
        selected && "bg-foreground/[0.06]"
      )}
    >
      <MentionAvatar ws={ws} row={row} />
      {/* 名字**可截断**（原来是 shrink-0）：右边那格标注是常驻的，再加上一个不肯
          让位的名字，长名字会把这张 320px 的卡顶破。截了还能悬停看全（title） */}
      <span className="min-w-0 truncate font-medium" title={row.name}>{row.name}</span>
      {row.detail !== "" && (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.detail}</span>
      )}
      {/* 贴右边缘（ms-auto）：一列扫下来对齐，而不是跟着名字长短漂。这一格回答的是
          「这一行是人还是 agent」——两族并排在同一张列表里，不标出来就只能靠头像
          的画风猜 */}
      <span className="ms-auto shrink-0 text-[11px] text-muted-foreground/70">
        {MENTION_KIND_LABEL[row.kind]}
      </span>
    </div>
  );
}

function MentionAvatar({ ws, row }: { ws: WorkspaceSnapshot; row: MentionRow }) {
  const src = row.kind === "agent" && row.agentId !== null ? agentAvatarSrc(ws, row.agentId) : row.avatarUrl;
  return (
    <Avatar className="size-5 shrink-0">
      {src !== "" && <AvatarImage src={src} alt={row.name} />}
      <AvatarFallback className="text-[10px]">{initialOf(row.name)}</AvatarFallback>
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
  mine,
  avatarUrl,
}: {
  ts: number;
  label: string | null;
  text: string;
  mine: boolean;
  avatarUrl: string;
}) {
  return (
    <SpeakerRow mine={mine} avatar={<PersonAvatar name={label ?? "?"} src={avatarUrl} />}>
      <span className="px-1 text-[10.5px] text-muted-foreground">
        {label ? `${label} · ` : ""}
        {formatProxyTime(ts)}
      </span>
      <Bubble align={mine ? "end" : "start"} variant={mine ? "tinted" : "muted"}>
        <BubbleContent className="whitespace-pre-wrap break-words">{text}</BubbleContent>
      </Bubble>
    </SpeakerRow>
  );
}

/** Agent 的**最终答案**（复审 Rejected #1 补齐；署名换成 assistantLabel 是
    Task 10）：恒左对齐（Agent 不可能是"我"）。走到这里的必然「有正文且没要
    工具」——中间步骤在 `hiddenFromCloudTimeline` 第 ⑥ 条就被挡下了（#1055），
    所以这里既不判 `content` 空不空、也不画 toolCalls：那两条分支是**由构造
    保证**到不了的（同 ADR-0214「让『只有一个』由构造保证」的纪律），留着就是
    两条永远跑不到的死支。ws 是查 agentId → 名字的名单，多智能体上线前落的
    旧消息没有 agentId，assistantLabel 据此回退到 "Agent" */
export function AssistantMessageRow({ event, ws }: { event: AssistantMessageEvent; ws: WorkspaceSnapshot }) {
  const name = assistantLabel(event, ws);
  return (
    <SpeakerRow mine={false} avatar={<AgentAvatar ws={ws} agentId={event.agentId} name={name} />}>
      <span className="px-1 text-[10.5px] text-muted-foreground">
        {name} · {formatProxyTime(event.ts)}
      </span>
      <AgentBubbles text={event.content} />
    </SpeakerRow>
  );
}

/** agent 的一轮回复画成几张气泡（#1132，ADR-0266）：按空行拆（chatBubbles.ts），
    像真人在群里连发几条。终态与流式预览共用这一份——预览是累计快照（#1107），
    每帧重新拆一遍，前几张早就定形、只有最后一张在长，答案落下来时张数不变。
    一个字都拆不出来（纯空白）时仍画一张，与改动前的形状一致：这一行能画出来
    就说明时间线认为它该在（isAgentStep 已经把空回复滤掉了）。
    第二张起 `mt-1`：SpeakerRow 那一摞的 gap 是给「署名行 → 气泡」定的 2px，
    两张气泡只隔 2px 读起来是一张裂开的，6px 才是两条消息 */
function AgentBubbles({ text }: { text: string }) {
  const parts = splitBubbles(text);
  const chunks = parts.length > 0 ? parts : [text];
  return (
    <>
      {chunks.map((part, i) => (
        <Bubble key={i} align="start" variant="muted" className={i > 0 ? "mt-1" : undefined}>
          <BubbleContent className="whitespace-pre-wrap break-words">{part}</BubbleContent>
        </Bubble>
      ))}
    </>
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

/** 通话名单那一行（#1163）：谁开的、拉了谁、结束了——审计性质的旁白，样式照
    AgentRelayRow。事件只记事实（此刻谁在通话里），动作是投影出来的，见 voiceCallLineText */
function VoiceCallRow({ text }: { text: string }) {
  return <p className="px-1 text-[10.5px] italic text-muted-foreground/70">{text}</p>;
}

/** 「谁还没回」（Task 10，src/shared/turnLedger.ts 的 openTurns 是事实来源）：
    画在时间线**末尾**而不是贴在各自那条 @ 消息下面——排队的东西说的是
    "接下来会发生什么"，那是时间线尾巴的事；这是日志的投影不是 UI 本地态，
    daemon 重启回来后重新算一遍照样对得上。

    两个状态**画成两种东西**，不是同一行换个颜色（#1055）：
    - `running` = 那只 agent 此刻正在攒话 → 一枚**输入指示器**（三点跳动的气泡），
      长在它待会儿那条回复要落的位置上：同一个 `SpeakerRow`、同一张 `muted` 气泡，
      答案到了就地把点换成字。协议 16 起（#1107）这只气泡还有第二态：这只 agent
      的流式帧攒出了正文就**把点换成正在长的文字**（同一张气泡、同一个位置，
      终态 assistant_message 到达时整份覆盖——预览从来不是事实）。中间步骤自
      #1055 起整段不画（`hiddenFromCloudTimeline` 第 ⑥ 条），所以这枚气泡是
      「它在忙」在界面上**唯一**的痕迹——不是装饰。
    - `queued` = 还没轮到它 → 照旧一行小灰字。**故意不给打字气泡**：那句话说的是
      「它正在打字」，而一个排着队的 turn 一个 token 都还没跑，画上去就是 #722
      那个撒谎的勾的一般形式。两者的分别因此是结构性的（有没有气泡），不是
      「跳的点 vs 不跳的点」——后者在一屏里要盯着看才分得出。

    `queued` 那支不画「停止」不是漏了：`stopButtonRows` 本来就只收 running，
    改动前那行上的判断永远是 false */
export function PendingTurnLines({
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
  // 流式缓冲（#1107）：agentId → 这一轮到此刻的正文预览。整表订阅——pending
  // 行一只手数得过来，不存在按行细分的必要；快照语义 = 读出来就是要画的那串
  const streaming = useChat((s) => s.cloudStreaming);
  // 哪几行画得出「停止」（第四批 C2-I3）：同一只 agent 排了两句话时两行都读成
  // running（turnLedger 认不出「那条动静属于哪一轮」），而在跑的只有最早那一条
  // ——晚的那行上那颗钮点下去停的是别人的轮次。stopButtonRows 把这条判据算成
  // 一份 key 集合，这里只查表；权限那一问仍旧归 canStopTurn，两者是且的关系
  const stoppable = useMemo(() => stopButtonRows(pending), [pending]);
  if (pending.length === 0) return null;
  return (
    <>
      {pending.map((t) => {
        const key = `${t.seq}:${t.agentId}`;
        const name = agentNameOf(ws, t.agentId);
        if (t.state === "queued") {
          return (
            <div key={key} className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
              <span className="size-[6px] rounded-full bg-muted-foreground/40" aria-hidden />
              <span className="flex-1">{name} 排队中…</span>
            </div>
          );
        }
        const streamed = streaming[t.agentId];
        return (
          <SpeakerRow key={key} mine={false} avatar={<AgentAvatar ws={ws} agentId={t.agentId} name={name} />}>
            <span className="flex items-center gap-1 px-1 text-[10.5px] text-muted-foreground">
              {name}
              {stoppable.has(key) && canStopTurn(t, selfUid, cs) && <StopTurnButton seq={t.seq} />}
            </span>
            {/* 气泡与 AssistantMessageRow 那张逐字同款（muted / align start）：
                答案落下来时人看到的是同一张气泡里点变成了字，不是一个东西消失、
                另一个东西出现。有正文预览（#1107）就画正在长的文字，否则照旧
                三点——文字本身就是「它在长」的信号，不再叠加光标或点。
                `py-2.5` 只留给三点那档：一行字的气泡约 39px，那枚是 26px，
                读起来是「还没成形的一句话」；预览档与终态同一把尺，答案落下时
                像素一动不动 */}
            {streamed ? (
              <AgentBubbles text={streamed} />
            ) : (
              <Bubble align="start" variant="muted">
                <BubbleContent className="flex items-center py-2.5">
                  <TypingIndicator variant="bare" label={`${name} 正在输入`} />
                </BubbleContent>
              </Bubble>
            )}
          </SpeakerRow>
        );
      })}
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
