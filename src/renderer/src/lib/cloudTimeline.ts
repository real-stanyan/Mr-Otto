// cloudTimeline —— 云会话时间线：谁说的 / 说给谁 / 谁还没回（Task 10，#932 切片 1b）。
//
// 从 CloudSessionPage.tsx 搬出来的纯逻辑（parseUserMessageLabel 原样搬 +
// 两个新的署名/归属函数）：组件旁边放一个 lib 是本仓的既有惯例
// （src/renderer/src/lib/workspaceView.ts 同款），纯函数零 React 也方便
// 单独写测试（tests/renderer/cloudTimelineLabels.test.ts）。

import { agentAvatarSrc } from "./agentAvatar.js";
import { agentNameOf, labelOf, memberAvatarOf } from "./workspaceView.js";
import { isSystemNote, systemNoteBody } from "./systemNote.js";
import type {
  AgentRelayEvent, ApprovalDecisionEvent, ApprovalRequestEvent, AssistantMessageEvent, RouteChangedEvent, SessionEvent, TurnEndedEvent,
  UserMessageEvent, VoiceCallChangedEvent,
} from "../../../session/events.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";
import { CREATE_AGENT_TOOL_NAME } from "../../../shared/createAgentDraft.js";
import { countdown } from "./billingView.js";
import type { OpenTurn } from "../../../shared/turnLedger.js";

/** sessionService.ts 的 say() 点火一个 turn 时拼的前缀:`\`[${label}]: ${text}\``。
    协议没有给 user_message 配独立的 fromUid/label 字段（这个事件本来就是
    "普通会话的一条用户消息"，云会话群聊只是把发言人编进了正文），只能在
    渲染层尽力而为地把它解析回来：非贪婪匹配第一个 "]: " 之前的内容当
    label，其余原样当正文。解析不出（旧日志 / 前缀被破坏）就把 label 记
    null、正文原样显示全文，不装作解析成功了 */
export function parseUserMessageLabel(content: string): { label: string | null; text: string } {
  const m = /^\[(.*?)\]: ([\s\S]*)$/.exec(content);
  return m ? { label: m[1]!, text: m[2]! } : { label: null, text: content };
}

/** user_message 行的署名与归属（Task 1 补的 fromUid/mentions 上线后的正路）：
    fromUid 在就按 uid 判"是不是我"——同名两个人也分得开（1a 的前缀比对做
    不到这点）；fromUid 缺席（旧日志）才退回 1a 的"解析出的 label 跟自己
    的展示名比对"。targets 是这句话点了谁（用于标签行末尾的 "→ 谁"），
    查不到名字的 agentId 由 agentNameOf 自己兜底（回 agentId 本身）。
    uid 是画头像用的把手（#971）：fromUid 在场原样透出，缺席（旧日志）回 null——
    渲染层据此决定查成员表还是退回首字母，不在这里替它查（这里不认识头像） */
export function userRowIdentity(
  e: UserMessageEvent,
  ws: WorkspaceSnapshot,
  selfUid: string
): { label: string | null; text: string; mine: boolean; targets: string[]; uid: string | null } {
  const parsed = parseUserMessageLabel(e.content);
  const mine = e.fromUid ? e.fromUid === selfUid : parsed.label === labelOf(ws, selfUid);
  const targets = (e.mentions ?? []).map((id) => agentNameOf(ws, id));
  return { label: parsed.label, text: parsed.text, mine, targets, uid: e.fromUid ?? null };
}

// ─── agent 的中间步骤（#971，ADR-0229；#1055 把折叠头也撤了） ──────────────

/** 一条 assistant_message 是「步骤」还是「答案」：要了工具 = 步骤（这一条的
    全部意义是接下来要干活）；一个字没说也算步骤（画出来是一个空气泡）；
    有正文且没要工具 = 答案。
    判据本身没变，变的是步骤的下场——ADR-0229 折成一行摘要，#1055 整段不画，
    见 `hiddenFromCloudTimeline` 第 ⑥ 条 */
export function isAgentStep(e: AssistantMessageEvent): boolean {
  return (e.toolCalls?.length ?? 0) > 0 || e.content.trim() === "";
}

/** assistant_message 的署名：agentId 查名单（agentNameOf 查不到回 agentId 本身，
    同旧消息 @提及上留个把手的纪律）；没有 agentId（旧日志/单 agent 会话，
    见 events.ts AssistantMessageEvent.agentId 字段注释）→ "Agent"，
    维持多智能体上线前的既有文案 */
export function assistantLabel(e: AssistantMessageEvent, ws: WorkspaceSnapshot): string {
  return e.agentId ? agentNameOf(ws, e.agentId) : "Agent";
}

/** 接力线文案（#950）：谁 → 谁 · 接力第几棒。名字现查 agentNameOf——被删的
    agent 回 id（同 assistantLabel/targets 的纪律，旧接力线上还得有个把手） */
export function relayLineText(e: AgentRelayEvent, ws: WorkspaceSnapshot): string {
  return `${agentNameOf(ws, e.fromAgentId)} → ${agentNameOf(ws, e.toAgentId)} · 接力第 ${e.depth} 棒`;
}

/** 这条事件在云会话时间线上要不要**藏起来**（#950；#993 扩了四类，#1055 又添一类）。
    群聊时间线的读者是团队里各行各业的人，不是在读一份审计日志——本地会话
    那套 AUDIT 小灰字（会话已创建 / 请求信封已更新 / 由谁批准）在这里是纯噪音：
    它们说的是机器的内务，不是群里发生的事。

    六类：
    ① 带 relay 的 `user_message`——那条开场白是给模型看的（"[系统] 「运营」@ 了你"），
       人看接力线（agent_relay 那一行）就够，画出来是同一件事说两遍；
    ② `session_created`——点开一条会话本来就意味着它存在了，这行字零信息；
    ③ `agent_briefed`（「「管理员」就位」）——brief 是每次提示词/花名册变了就补一条的
       内务事件（ADR-0231 之后 name + roster 指纹也算），群里会看到一串「就位」而
       没有任何人做了任何事；
    ④ `request_envelope`——「请求信封已更新：型号 · 工具 3 把」是给维护者调参用的；
    ⑤ **批准**了的 `approval_decision`——放行不是对话事实。**拒绝仍然画**：它中断了
       流程，群里得看得见"这件事没做成、以及为什么"，那不是噪音；
    ⑥ agent 的**中间步骤**（`isAgentStep`：要了工具的、或一个字没说的
       `assistant_message`）——ADR-0229 已经把它们折进一行「「管理员」处理过程 ·
       1 步 · 1 次工具调用」，#1055 连那一行也撤了：那句摘要说的是机器干活的量
       （几步、几次调用），不是群里发生的事，而人要知道的「它此刻在忙」已经由
       输入指示器（`elements/typing-indicator`，画在时间线末尾那几行未收口的
       turn 上）说了。**判据合进这一个函数**：原来渲染层要连问两道
       （`hiddenFromCloudTimeline` + `foldAgentSteps().hidden`），同一个问题两份
       判据迟早分家。代价写在这里——工具调用在云会话时间线上**没有任何痕迹**，
       只跑工具没说话的一轮，收口后什么都不留（`turn_ended{error}` 那行还在）。

    ⑦ 语音通话的**招呼开场白**（#1174，带 `greeting` 的 `user_message`）——runtime 替
       改名单的人落的「打个招呼」，与接力开场白同款：正文是写给模型的措辞，而
       `voice_call_changed` 那一行已经说了「拉进了通话」，两条都画是同一件事说两遍。
    ⑧ `session_autotitled`（#1213）——会话被自动命名了是机器的内务：人不能据此
       行动（ADR-0260 的判据），而侧栏那一行的字已经跟着换了，画出来是同一件事
       说两遍。**藏的是投影不是事实**：落盘/重放/隐私闸一个字不动。

    留在时间线上的因此只剩：人说的话、agent 的最终答案、接力线、出错、归档。 */
export function hiddenFromCloudTimeline(e: SessionEvent): boolean {
  if (e.type === "user_message") return e.relay !== undefined || e.greeting !== undefined;
  if (e.type === "approval_decision") return e.decision === "approved";
  if (e.type === "assistant_message") return isAgentStep(e);
  return (
    e.type === "session_created" ||
    e.type === "agent_briefed" ||
    e.type === "request_envelope" ||
    e.type === "session_autotitled"
  );
}

/** 审批卡第一行（#957 C-I3）：多智能体是这一批六片的全部意义，两张卡工具名
    相同、argsSummary 前 200 字也可能相同时，"批准哪一张"必须先说清"是哪只
    agent 要的这份权限"。agentId 缺席（旧日志）→ 沿用现状的裸工具名，不装作
    答得出这个问题（同 assistantLabel 的兜底纪律） */
export function approvalCardTitle(e: ApprovalRequestEvent, ws: WorkspaceSnapshot): string {
  return e.agentId ? `「${agentNameOf(ws, e.agentId)}」请求 ${e.toolName}` : e.toolName;
}

/** 「谁批的」（#957 M8）：decidedBy 是云 runtime 专门认定的字段，本地单人会话
    没有意义（缺席=本地会话/旧日志，同字段自身的注释），此时不装作有答案，
    交给调用方决定要不要画这一行。**不收 ws**：decidedBy.label 已经是落盘时
    算好的展示名（同 agentId 那批字段"带 id 不带名"的反面——这里存的就是名字），
    这里不用像 agentNameOf/labelOf 那样另查一次成员表（复审 Minor：没有第二个
    消费方需要重新解析这个名字，收一个用不上的参数只是摆样子） */
export function decisionLineText(e: ApprovalDecisionEvent): string | null {
  if (!e.decidedBy) return null;
  return `由 ${e.decidedBy.label} ${e.decision === "approved" ? "批准" : "拒绝"}`;
}

/** 管理员刚建成一只 agent（#954）：create_agent 的 tool_result{status:"ok"}。桌面的名册住在
    WorkspaceSnapshot.agents，没有推送通道（store.ts refreshWorkspaceGroups 的注释），看见这条
    就重拉一次——不新增事件类型（那是十一处清单的代价），判据从日志里既有的两条事件反查：
    tool_result 只带 toolCallId，工具名在配对的 assistant_message.toolCalls 里 */
export function createAgentLanded(events: readonly SessionEvent[], e: SessionEvent): boolean {
  if (e.type !== "tool_result" || e.status !== "ok") return false;
  return events.some(
    (p) => p.type === "assistant_message" && (p.toolCalls ?? []).some((c) => c.id === e.toolCallId && c.name === CREATE_AGENT_TOOL_NAME)
  );
}

/** 护栏 / 后台任务回注在云时间线上的文案（#957 C-I5 / #936）：`origin` 不在场
    （人打的话）→ null，调用方按 null 落回既有的 UserMessageRow 气泡渲染；
    在场时画成 `AgentBriefedRow` 同款审计旁白（调用方负责套样式），不再是
    I5 描述的"一条没有署名的群聊气泡"。agent 名查 `agentNameOf`——批次 1
    已经把 engine 落这两类事件时改成 `env()`（带 agentId）而不是 `envBase()`
    （见 engine.ts loop_guard/background 两处落盘的注释），查不到/缺席
    才落"某只智能体"这句兜底话（同 assistantLabel 等函数的纪律：不装作
    答得出这个问题）。正文本身与本机时间线共用一份（lib/systemNote.ts 的
    systemNoteBody）——名字从哪查是两端唯一的差异，文案不让两处各写一遍。
    只回摘要那一行：后台任务那一档还有一份可展开的全文，走同一个文件的
    systemNoteDetail（第四批 C2-I1），调用方两处各自去取——把两样塞进这个
    函数的返回值等于让每个只要一行字的 call site 也去解构一个对象 */
export function systemNoteText(e: UserMessageEvent, ws: WorkspaceSnapshot): string | null {
  if (!isSystemNote(e)) return null;
  return systemNoteBody(e, e.agentId ? agentNameOf(ws, e.agentId) : null);
}

/** `turn_ended{error}` 行说是哪只 agent（#957 M16）：`outcome !== "error"`
    （aborted/completed/interrupted）或没有 `agentId`（旧日志/本机单 agent
    会话）→ null，调用方落回现状（裸的"turn 失败"标题，同 approvalCardTitle
    等函数"查不到就不装作答得出"的纪律）。**只回前缀**，不把 `error` 拼
    进来——`ErrorState`（TurnErrorState 用的那个 element）本来就是 title/
    detail 两行分开画，`error` 依旧走 detail（连带保留 humanizeError 的
    人话/原文折叠），这里只换 title 那一行，不是重新拼一整句 */
export function turnEndedLineText(e: TurnEndedEvent, ws: WorkspaceSnapshot): string | null {
  if (e.outcome !== "error" || !e.agentId) return null;
  return `「${agentNameOf(ws, e.agentId)}」这一轮出错`;
}

const ROUTE_LABEL: Record<RouteChangedEvent["from"], string> = {
  hosted: "托管",
  workspace: "团队自带 key",
  direct: "自带 key",
};

const ROUTE_REASON_TEXT: Record<RouteChangedEvent["reason"], string> = {
  quota_exhausted: "本周额度用完",
  probe_failed: "订阅探测失败",
  no_subscription: "所有者没有活跃订阅",
  subscription_active: "订阅恢复",
};

/** `route_changed` 的时间线文案（第一批 Task 6 复审 Minor 7，#957 Task 7b）：`to==="direct"`
    是桌面唯一的、在这套 reason 语义之前就有的换轨（额度用完退回本机 key），旧日志里全是
    这句话——**逐字节保留**，不套下面的通用模板（brief 的硬约束，同 schema 向后兼容的
    Hard rule：旧日志必须永远可重放）。
    `subscription_active` 只在换回 hosted 时出现（`decideRuntimeRoute` 只在 `route.kind
    === "hosted"` 时判这个 reason），措辞走「改回」不走「改道：X → Y」——「改道」暗示
    从谁那儿抢了额度，而这一格说的是恢复原状。
    其余（`probe_failed` / `no_subscription` / `quota_exhausted` 落在非 direct 的
    团队↔托管之间）用通用模板：改道：<from> → <to>（<原因>）。`resetAt` 有值时在原因后面
    追加「，X 恢复」——用 Timeline.tsx 原本就在用的 `countdown`（同一扇窗两处不能各写一份，
    ADR-0209 那条纪律） */
export function routeChangedText(e: RouteChangedEvent, now: number = Date.now()): string {
  if (e.to === "direct") {
    const base = "订阅额度已用完，本次起用的是你自己的 key";
    return e.resetAt !== undefined ? `${base}（${countdown(e.resetAt, now)}）` : base;
  }
  if (e.reason === "subscription_active") {
    return `改回${ROUTE_LABEL[e.to]}（订阅恢复）`;
  }
  const resetSuffix = e.resetAt !== undefined ? `，${countdown(e.resetAt, now)}` : "";
  return `改道：${ROUTE_LABEL[e.from]} → ${ROUTE_LABEL[e.to]}（${ROUTE_REASON_TEXT[e.reason]}${resetSuffix}）`;
}

/** 「停止」按钮的显示判据（#957 第三批）：与审批同一判据——发起人或 owner——
    但这里不重判权限，服务端的 stop_result 才是唯一事实，这只决定按钮画不画。
    state !== "ready" 时云会话本身还没连上/已断，按钮不该出现；turn 不是
    running（已经排队还没跑，或早收口了）也不该出现——停的是"这一轮"。 */
export function canStopTurn(
  turn: OpenTurn,
  selfUid: string,
  cs: { state: string; ownerUid: string }
): boolean {
  if (cs.state !== "ready") return false;
  if (turn.state !== "running") return false;
  return selfUid === turn.fromUid || selfUid === cs.ownerUid;
}

/** 哪几行该画「停止」按钮（第四批 C2-I3）。key = `${seq}:${agentId}`，与
    `PendingTurnLines` 画每一行时用的那把 key 逐字同一份。
    为什么不是「每行 running 都画」：`turnLedger` 认不出「那条动静属于哪一轮」
    （事件上没有 turn id，只有 agentId，见该文件头「已知不精确的一格」），同一只
    agent 排了两句话时**两行都会读成 running**，而此刻真正在跑的只有最早那一条
    ——另一行那颗钮点下去停的是别人的轮次。判据因此不是「看起来在跑」而是
    「每只 agent seq 最小的那条 running」：那是这只 agent 手上唯一可能正在跑的
    一轮。服务端还会拿 seq 与采样边界再核一次（`not_current`），两道闸各管一头
    ——这一道让界面不画出点了会停错的钮，那一道让并发窗口里点下去的那次不生效。
    **取最小 seq 不靠入参顺序**：`openTurns` 眼下是按 seq 升序回的，但「第一条
    running」与「seq 最小的 running」是两句话，靠前者等于把这个函数的正确性押在
    调用方的排序上，而那个前提一旦变了这里不会红、只会安静地把钮画到错的行上 */
export function stopButtonRows(turns: readonly OpenTurn[]): Set<string> {
  const earliest = new Map<string, number>();
  for (const t of turns) {
    if (t.state !== "running") continue;
    const cur = earliest.get(t.agentId);
    if (cur === undefined || t.seq < cur) earliest.set(t.agentId, t.seq);
  }
  return new Set([...earliest].map(([agentId, seq]) => `${seq}:${agentId}`));
}

/** 时间线为空时主区画什么（#983）。三档：
    - `skeleton`：历史**还没拉到**——connecting（welcome/backlog 在路上），或
      gone 且一条事件都没有（还没拉到过就断了，wsTransport 正在自动重连）。
      这时写「还没有消息。」是句假话：不是没有，是还没看到。
    - `empty`：ready 且零事件——ready 的定义就是 backlog 已补完全量
      （shellBridge 的 CloudSessionStatus 注释），这才是真的「还没有消息」。
    - `none`：denied（横幅那一行已经说了为什么，再画一行空态是把「进不来」
      说成「里面是空的」），或者已有事件（gone 时旧历史还在，照画不动）。
    判据只看 state + 事件数，不看「我刚点了什么」——同 statusBanner 的纪律 */
export function cloudEmptyState(
  state: "connecting" | "ready" | "denied" | "gone",
  eventCount: number
): "skeleton" | "empty" | "none" {
  if (eventCount > 0) return "none";
  switch (state) {
    case "connecting":
    case "gone":
      return "skeleton";
    case "ready":
      return "empty";
    case "denied":
      return "none";
  }
}

/** 通话那一行里的一格（#1228）。`text` 是它在句子里的**字面**——整串 part 的 text 一路
    拼起来就是这句话本身（文案用例正是这么钉的），所以「这句话怎么说」不会因为多了一层
    结构而分成两份判据。`party` 那一档额外带着画脸要的两样：`name` 是裸名（渲染层拿它
    取首字母兜底），`avatarSrc` 空串 = **名册里查不到，不给脸**——`agentAvatarSrc` 对
    陌生 id 会按哈希派生一张，画上去等于宣称它还在名册里（同 ADR-0264 用量表那条纪律）。
    人那一侧的空串来自 `memberAvatarOf`（没设过头像 / 已退群），退回首字母是同一条路 */
export type VoiceCallPart =
  | { kind: "text"; text: string }
  | { kind: "party"; text: string; name: string; avatarSrc: string };

/** 语音通话名单那一行旁白（#1163）：判据是**前后两条名单的差集**，不是事件上的一个
    「动作」字段——事件只记事实（此刻谁在通话里），动作是投影出来的：
    从无到有 = 开始；空 = 结束；只多 = 拉进；只少 = 移出；有增有减 = 更新。
    名字现查名单（`agentNameOf`），查不到（那只后来被删了）退回事件里的快照——同
    `assistantLabel` 的兜底纪律。`byAgentId` 在场 = agent 用 invite_to_call 拉的，署它的名。

    **回分段不回整串**（#1228）：判据与文案一个字没改，改的是返回结构——头像要画在每个
    名字左边，而一整个字符串里「哪一段是名字」这件事根本不在。分段之后名字自成一格，
    text 拼起来仍然逐字节等于原来那句话 */
export function voiceCallLineParts(
  prev: VoiceCallChangedEvent | null,
  e: VoiceCallChangedEvent,
  ws: WorkspaceSnapshot
): VoiceCallPart[] {
  const t = (text: string): VoiceCallPart => ({ kind: "text", text });
  const agentParty = (p: { agentId: string; name: string }): VoiceCallPart => {
    const known = ws.agents.some((a) => a.agentId === p.agentId);
    const name = known ? agentNameOf(ws, p.agentId) : p.name;
    return { kind: "party", text: name, name, avatarSrc: known ? agentAvatarSrc(ws, p.agentId) : "" };
  };
  // 人名后空一格、书名号后不空：「Stan 开始了」与「「运营」把」——中文排版里括号自己就是间隔
  const byAgentId = e.byAgentId;
  const who: VoiceCallPart[] =
    byAgentId !== undefined
      ? [{
          kind: "party",
          text: `「${agentNameOf(ws, byAgentId)}」`,
          name: agentNameOf(ws, byAgentId),
          // 拉人的那只自己没有快照可退（事件上只有 id），名册里查不到就不给脸
          avatarSrc: ws.agents.some((a) => a.agentId === byAgentId) ? agentAvatarSrc(ws, byAgentId) : "",
        }]
      : [
          { kind: "party", text: labelOf(ws, e.byUid), name: labelOf(ws, e.byUid), avatarSrc: memberAvatarOf(ws, e.byUid) },
          t(" "),
        ];
  const before = new Set((prev?.participants ?? []).map((p) => p.agentId));
  const after = new Set(e.participants.map((p) => p.agentId));
  const list = (ps: readonly { agentId: string; name: string }[]): VoiceCallPart[] =>
    ps.flatMap((p, i) => (i === 0 ? [agentParty(p)] : [t("、"), agentParty(p)]));
  if (after.size === 0) return [...who, t("结束了语音通话")];
  if (before.size === 0) return [...who, t("开始了语音通话："), ...list(e.participants)];
  const added = e.participants.filter((p) => !before.has(p.agentId));
  const removed = (prev?.participants ?? []).filter((p) => !after.has(p.agentId));
  if (added.length > 0 && removed.length === 0) return [...who, t("把"), ...list(added), t("拉进了通话")];
  if (removed.length > 0 && added.length === 0) return [...who, t("把"), ...list(removed), t("移出了通话")];
  return [...who, t("更新了通话名单："), ...list(e.participants)];
}

// ─── 一场通话折成一张卡（#1233，ADR-0288） ─────────────────────────────

/** 卡里的一行。两种形状用 `parts` 区分：非 null = 名单变了那道分隔线（复用
    `voiceCallLineParts`，所以「「开发」把「运营」拉进了通话」这句话在卡里和
    原来在时间线上逐字相同）；null = 有人说了一句话。 */
export interface VoiceCallCardLine {
  seq: number;
  parts: readonly VoiceCallPart[] | null;
  /** 说话人显示名。名单变更那行不用（parts 自带名字） */
  label: string;
  /** 空串 = 没有脸可画，退回首字母（同 `VoiceCallPart` 那条纪律） */
  avatarSrc: string;
  /** 相对通话开始的毫秒。画成 mm:ss —— 通话里的时间是「第几分几秒说的」，
      墙上时间在这张卡里没有意义（整场通常只跨几分钟） */
  offsetMs: number;
  text: string;
  /** 我说的（画得比别人略重一点，同气泡那侧的 mine） */
  mine: boolean;
}

/** 一场通话。`seq` 是它在时间线上的位置 = 这场通话**第一条**
    `voice_call_changed` 的 seq，也就是原来那行「XX 开始了语音通话」的位置。 */
export interface VoiceCallCard {
  seq: number;
  sinceTs: number;
  /** null = 还开着（卡片画「通话中」，时长自己按 now 走一只表） */
  endedTs: number | null;
  /** 说出来的话 + 通话里那几只 agent 的回复，不含名单变更那几行 —— 收起时报的
      「N 句」就是这个数。名单变更计进去的话，一场谁都没说话、只是拉了两次人的
      通话会报「2 句」 */
  utterances: number;
  /** 整场出现过的人与 agent（并集，不是此刻的名单）：中途被移出的那只照旧算
      参与过这场通话，收起时那一排脸报的是「这场通话里有谁」 */
  parties: readonly { name: string; avatarSrc: string }[];
  lines: readonly VoiceCallCardLine[];
}

/** 把日志折成「一场通话 = 一张卡」（#1233，ADR-0288）。
 *
 * 维护者原话：「把通话的所有文本内容集成为一个卡片居中显示在会话框里，如果用户
 * 想看的话，自己点进去再看。」改动前一场 12 句的通话把时间线撑开一千多像素，
 * 前后真正的工作对话被挤到看不见。
 *
 * **判据不是 seq 区间**（ADR-0288 决策 1）：那条路零 schema 改动，但云会话是群聊
 * —— 通话期间**没在通话里的人打的字会被吞进一张他没参与的通话卡**，而这条 issue
 * 修的正是「不该进时间线的东西进了时间线」，方向修反就是同一类 bug 的新一版。
 * 所以人说的话认 `voice` 记号（协议 19 新加的那一格，麦克风那侧唯一知道这件事），
 * agent 的回复认「它此刻在通话名单里」—— 后者不用第二个字段：通话里那几只的回复
 * 会被读出来（ADR-0271），这本身就是日志推得出的事实。
 *
 * **已知代价**：通话期间有人打字提问、而通话里的 agent 答了，那条答案进卡片、
 * 问题留在时间线上（卡里出现一句没有问题的答案）。混着说与打字的用法很少见，
 * 且两半都还读得到；反过来（把打字的也吞进去）会连旁人的话一起吞。
 *
 * 回的是两样：`cards` 按「开场那条 `voice_call_changed` 的 seq」索引，渲染循环
 * 走到那一条就画卡；`folded` 是被卡吞掉的每一条 seq，渲染循环见到就 return null。
 * **不塞进 `hiddenFromCloudTimeline`**：那个函数是逐事件的纯谓词，而「这一条属不
 * 属于某场通话」要跨事件才答得出（同渲染循环里 `prevVoiceCall` 那张表的手法）。
 */
export function voiceCallCards(
  events: readonly SessionEvent[],
  ws: WorkspaceSnapshot,
  selfUid: string
): { cards: Map<number, VoiceCallCard>; folded: ReadonlySet<number> } {
  const cards = new Map<number, VoiceCallCard>();
  const folded = new Set<number>();
  /** 正开着的那张卡的草稿。null = 此刻没有通话 */
  let draft: {
    seq: number;
    sinceTs: number;
    lines: VoiceCallCardLine[];
    /** 整场出现过的 agentId → 事件里那份名字快照（并集，保插入顺序）。
        **带快照不只带 id**：那只后来被删掉时名册里查不到，退回快照才还有个把手
        ——同 `voiceCallLineParts` / `assistantLabel` 那条兜底纪律 */
    agents: Map<string, string>;
    /** 整场出现过的人类 uid（并集，保插入顺序） */
    uids: Set<string>;
    utterances: number;
  } | null = null;
  /** 此刻的名单，用来判「这条 assistant_message 是通话里那几只说的吗」 */
  let roster = new Set<string>();
  let prevCall: VoiceCallChangedEvent | null = null;

  /** `snapshot` = 事件里那份名字快照（`voice_call_changed.participants[].name`）。
      名册里查得到就现查（改名不断账：脸与名字都跟着当前名册走），查不到退回快照，
      快照也没有才落回裸 id —— 三级兜底与 `voiceCallLineParts` 逐字同一条 */
  const partyOfAgent = (agentId: string, snapshot?: string): { name: string; avatarSrc: string } => {
    const known = ws.agents.some((a) => a.agentId === agentId);
    return {
      name: known ? agentNameOf(ws, agentId) : (snapshot ?? agentId),
      avatarSrc: known ? agentAvatarSrc(ws, agentId) : "",
    };
  };

  const close = (endedTs: number | null): void => {
    if (draft === null) return;
    cards.set(draft.seq, {
      seq: draft.seq,
      sinceTs: draft.sinceTs,
      endedTs,
      utterances: draft.utterances,
      // agent 排在人前面：一排脸里先看到会说话的那几只（同 @ 选人名单的顺序）
      parties: [
        ...[...draft.agents].map(([agentId, snapshot]) => partyOfAgent(agentId, snapshot)),
        ...[...draft.uids].map((uid) => ({ name: labelOf(ws, uid), avatarSrc: memberAvatarOf(ws, uid) })),
      ],
      lines: draft.lines,
    });
    draft = null;
  };

  const say = (e: { seq: number; ts: number }, label: string, avatarSrc: string, text: string, mine: boolean): void => {
    if (draft === null) return;
    folded.add(e.seq);
    draft.utterances += 1;
    draft.lines.push({ seq: e.seq, parts: null, label, avatarSrc, offsetMs: Math.max(0, e.ts - draft.sinceTs), text, mine });
  };

  for (const e of events) {
    if (e.type === "voice_call_changed") {
      if (draft === null) {
        // 开场那一条**留在时间线上**：卡就画在它的位置
        if (e.participants.length === 0) { prevCall = e; continue; } // 空名单开场 = 旧日志里的怪形状，不开卡
        draft = { seq: e.seq, sinceTs: e.ts, lines: [], agents: new Map(), uids: new Set([e.byUid]), utterances: 0 };
        for (const p of e.participants) draft.agents.set(p.agentId, p.name);
      } else {
        // 中途拉人 / 移出 / 结束：折进这张卡，不在时间线上另起一行
        folded.add(e.seq);
        draft.lines.push({
          seq: e.seq, parts: voiceCallLineParts(prevCall, e, ws),
          label: "", avatarSrc: "", offsetMs: Math.max(0, e.ts - draft.sinceTs), text: "", mine: false,
        });
        // `set` 不是 `has` 守卫：名字快照取**最后一次**看到的那份（中途改过名的话，
        // 卡上那一排该显示他后来叫什么）
        for (const p of e.participants) draft.agents.set(p.agentId, p.name);
        if (e.participants.length === 0) close(e.ts);
      }
      roster = new Set(e.participants.map((p) => p.agentId));
      prevCall = e;
      continue;
    }
    if (draft === null) continue;
    if (e.type === "user_message") {
      // relay / greeting 那两种开场白本来就不画（hiddenFromCloudTimeline 第 ①⑦ 条）：
      // 它们带不了 `voice`，走不到这里；这道判据是为了「藏起来的东西不会因为通话
      // 开着而冒出来」由构造保证，而不是靠那两条恰好不带记号
      if (e.voice !== true || hiddenFromCloudTimeline(e)) continue;
      const id = userRowIdentity(e, ws, selfUid);
      if (id.uid !== null) draft.uids.add(id.uid);
      say(e, id.label ?? "?", id.uid !== null ? memberAvatarOf(ws, id.uid) : "", id.text, id.mine);
      continue;
    }
    if (e.type === "chat_message") {
      if (e.voice !== true) continue;
      draft.uids.add(e.fromUid);
      say(e, e.label, memberAvatarOf(ws, e.fromUid), e.content, e.fromUid === selfUid);
      continue;
    }
    if (e.type === "assistant_message") {
      // 中间步骤照旧整段不画（#1055）：卡里也不该有「它跑了个工具」
      if (isAgentStep(e) || e.agentId === undefined || !roster.has(e.agentId)) continue;
      // 名单里必有它（上面 roster.has 那道闸），所以快照一定查得到
      const party = partyOfAgent(e.agentId, draft.agents.get(e.agentId));
      say(e, party.name, party.avatarSrc, e.content, false);
      continue;
    }
  }
  // 还开着的那场：卡片画「通话中」。**不 close 成 ended** —— 那会把一场正在
  // 进行的通话说成结束了（日志里那条空名单事件才是结束的唯一凭据）
  close(null);
  return { cards, folded };
}

/** 收起时那行「6 分 12 秒」。三档：不足一分钟只报秒（「48 秒」比「0 分 48 秒」像
    人话）；一小时以上报「小时 + 分」**不再报秒**（那一位在这个量级上没有意义，且
    这一格是会每秒一跳的）。
    超一小时这一档不是洁癖：日志里「通话结束」是一条真事件，daemon 崩在通话中的话
    那条永远不来，卡就一直是「通话中」——没有这一档它会写成「1483577 分 34 秒」 */
export function callDurationText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return m === 0 ? `${sec} 秒` : `${m} 分 ${sec} 秒`;
}

/** 卡里每一行左边那个 mm:ss。超过一小时照 `h:mm:ss` 展开，不把 61 分钟写成 01:00 */
export function callOffsetText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
