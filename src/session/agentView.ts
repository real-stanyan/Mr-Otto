// agentView —— 群聊云会话里,一只 agent 看得见日志的哪一部分(#928)。
// 设计出处:docs/superpowers/specs/2026-09-04-workspace-multi-agent-design.md §5。
//
// 判据一句话:**群里我听得见你说话,看不见你在你电脑上敲了什么**。
//
// 这是**变换**不是过滤,区别是要命的:只按 agentId 丢事件的话,别人的
// assistant_message.toolCalls 会留下、配对的 tool_result 被丢掉,于是
// deriveMessages 的悬空工具调用自愈(ADR-0005 保命层,deriveMessages.ts:351)
// 替它造一条「没执行」的 tool 消息塞进我的上下文 —— 别人明明跑成功了,我的
// 模型读到的是它没执行。安静地捏造事实,比 400 难查。
//
// **而且那是你在说，不是我说过的**（#1146，ADR-0268）：别人的 assistant_message 投影成
// 一条带名字的 chat_message（`[名字]: 内容`，user 角色），不是一条剥掉字段的
// assistant_message。原来那样做有两个病，真机上一起发作：① 每只 agent 把别人的话读成
// 自己说过的（「开发」答「收到接力，管理员这棒我来收个尾」——那棒是 @ 管理员的）；
// ② DeepSeek thinking 模式 + 请求带 tools 时，**最后一条 user 之后的每一条 assistant
// 消息都得带 reasoning_content**，别人的话没有、也不该有它的思考，于是接力开场白后面
// 跟着别人两句话 = 这一轮开口前就 400（用真接口对着日志重建的请求逐字复现，记在 #1146）。
// 名字从它自己的 agent_briefed 里现取——那是日志里唯一写着「a_8e93… 叫开发」的地方，
// 按日志顺序推进 = 发言那一刻的名字（同 chat_message.label 的快照规矩）；日志里没有就
// 退回 agentId，不编。reasoning / usage 从此不用单独剥：chat_message 本来没这两格。
// **自己**那轮的 reasoning 则随投影带出来、由 adapter 按厂商门控回传（#1151，
// DeepSeek 按它发的 tool_call id 在服务端缓存思考，缓存没了同样 400；ADR-0274）。
//
// **这是一个 Record 不是一张名单**:每个事件类型都必须表态,加了新事件类型不来
// 这里写一笔,tsc 直接红。形状照 sessionPackage.ts 的 PRIVACY_VERDICTS。
// 这张表的初稿就是一张名单,而它漏掉 context_compacted 的代价是:别人压缩一次,
// 我的整段真实历史被抹掉换成别人视角的摘要(deriveMessages 对它的处理是
// messages.length = 0,清场重来)。名单漏一个是静默灾难,Record 漏一个是编译错误。

import type { EventLog } from "./eventLog.js";
import type { AssistantMessageEvent, ChatMessageEvent, SessionEvent } from "./events.js";

/** 别人的这条事件,我看得见吗(#928)。判据一句话:这条事件说的是「群里发生的事」,
    还是「那只 agent 自己干活的过程」?后者 drop */
type OtherAgentVerdict =
  /** 全场共有的事实,或与「谁干的」无关 —— 原样进我的上下文 */
  | "keep"
  /** 别人干活留下的痕迹 —— 整条不进 */
  | "drop"
  /** 只留它说出口的那部分:assistant_message 变成一条带名字的 chat_message（#1146） */
  | "spoken";

const OTHER_AGENT_VERDICTS: Record<SessionEvent["type"], OtherAgentVerdict> = {
  // ── 全场共有或与执行者无关 ──
  session_created: "keep",
  chat_message: "keep",
  memory_loaded: "keep",
  memory_user_edit: "keep",
  memory_nudge: "keep",
  session_archived: "keep",
  session_unarchived: "keep",
  session_renamed: "keep",
  session_autotitled: "keep",
  session_shared: "keep",
  session_topic_assigned: "keep",
  session_topic_set: "keep",
  route_changed: "keep",
  model_changed: "keep",
  image_model_changed: "keep",

  // ── 那只 agent 说出口的话 ──
  assistant_message: "spoken",

  // ── 别人干活的过程 ──
  // **只影响带 agentId 的那些**（#957 A-5）：人在群里说的话、接力开场白都没有
  // agentId，走 projectForAgent 开头那条早退路径，一律放行——这张表根本轮不到。
  // 带 agentId 的 user_message 只有一种来路：engine 注给某一只 agent 看的私话
  // （退化循环护栏 ADR-0212 的「你在原地打转」、后台任务结果回注 ADR-0205）。
  // 那是它自己干活过程里的事，进别人的上下文就成了一句没头没脑的指责/通知，
  // 而且在投影里和人说的话逐字节一样，读的那只分不出来
  user_message: "drop",
  tool_execution_started: "drop",
  tool_result: "drop",
  tool_hook: "drop",
  approval_request: "drop",
  approval_decision: "drop",
  request_envelope: "drop",
  turn_ended: "drop",
  context_compacted: "drop",
  micro_compacted: "drop",
  model_usage: "drop",
  residue_baseline: "drop",
  residue_detected: "drop",
  residue_cleaned: "drop",
  checkpoint_created: "drop",
  branch_checked_out: "drop",
  project_instructions: "drop",
  skill_invoked: "drop",
  skill_released: "drop",
  subagent_spawned: "drop",
  subagent_briefed: "drop",
  // 别人的 briefing 不进我的上下文：我需要知道群里有「广告」这个人
  // （那来自我自己 briefing 里的 roster），不需要读它的提示词
  agent_briefed: "drop",
  workspace_memory_loaded: "drop", // 别人的记忆快照是它的上下文，不是我的（#949）
  // 接力棒（#950）：没有 agentId 字段，早退路径本来就放行（两只 agent 都要看得见
  // 这一棒），这里仍要表态——Record 是穷尽表，"反正放行了"不构成不写的理由
  agent_relay: "keep",
  // 语音通话名单（#1163）：群事实，每只都要读到——派活只在通话成员里进行、system 尾块
  // 列出谁在通话里。没有 agentId 字段，早退路径本来就放行，这里仍要表态（Record 是穷尽表）
  voice_call_changed: "keep",
  background_task_started: "drop",
  background_task_completed: "drop",
  image_described: "drop",
  section_classified: "drop",
  suggestions_generated: "drop",
  share_grant_note: "drop",
  workspace_restored: "drop",
};

/** 往回跳过别人的私话最多跳几条(见 agentView.lastOfType)。一条 turn 里护栏最多
    喊几次是有数的,连着 64 条别人的私话意味着日志本身不正常。
    跳不完回 null——modelContextScan.ts 的 boundedContextEvents 现在把这个 null
    与"checkpoint 之前根本没有 user_message"一视同仁,一律退回全量重建(#961):
    两种成因在 agentView 这一层分不清,保守起见都当"问不出来"处理 */
const FOREIGN_SCAN_LIMIT = 64;

export function projectForAgent(events: SessionEvent[], agentId: string): SessionEvent[] {
  const out: SessionEvent[] = [];
  // agentId → 此刻的名字。别人的 agent_briefed 不进我的视图（drop），但要先从它读名字
  const names = new Map<string, string>();
  for (const e of events) {
    if (e.type === "agent_briefed") names.set(e.agentId, e.name);
    const owner = "agentId" in e ? e.agentId : undefined;
    // 没有 agentId = 全场共有(session_created / user_message / chat_message /
    // memory_loaded …),或者这是一条单 agent 会话的旧事件。这条早退路径别动
    if (owner === undefined || owner === agentId) {
      out.push(e);
      continue;
    }
    // owner !== agentId 且存在 —— 查表判决这条事件
    const verdict = OTHER_AGENT_VERDICTS[e.type];
    if (verdict === "drop") continue;
    if (verdict === "keep") {
      out.push(e);
      continue;
    }
    if (verdict === "spoken") {
      // assistant_message:纯工具调用那一轮它没说话,说出口的部分是空的 —— 不该占我上下文一格
      if (e.type === "assistant_message") {
        if (e.content.trim() === "") continue;
        out.push(memberSpeech(e, owner, names.get(owner) ?? owner));
      } else {
        out.push(e);
      }
      continue;
    }
  }
  return out;
}

/** 别人说出口的那句话，按群成员发言的样子进我的上下文：deriveMessages 把 chat_message 投影成
    `[名字]: 内容` 的 user 消息，label 过 safeSpeakerLabel、正文过 promptSafeBody——一只 agent 也
    伪造不出别人的说话人行。fromUid 填 agentId：它在投影里只用作保留名判定，不是 auth uid、
    也不落盘（spec §4.2「不给 agent 发伪 uid」管的是写路径，这里是读）*/
function memberSpeech(e: AssistantMessageEvent, agentId: string, label: string): ChatMessageEvent {
  return {
    seq: e.seq,
    sessionId: e.sessionId,
    ts: e.ts,
    ...(e.sandboxId !== undefined ? { sandboxId: e.sandboxId } : {}),
    type: "chat_message",
    fromUid: agentId,
    label,
    content: e.content,
    mention: false,
  };
}

/** 把一份日志包成「这只 agent 眼里的日志」。写路径原样转发 —— 只有读要隔离 */
export function agentView(store: EventLog, agentId: string): EventLog {
  return {
    append: (e) => store.append(e),
    load: (sessionId, opts) => projectForAgent(store.load(sessionId, opts), agentId),
    forkOrigin: (sessionId) => store.forkOrigin(sessionId),
    // **压缩检查点必须按 agent 分格**:摘要是按 view 生成的(ADR-0003),运营那只
    // 压缩之后,广告那只若捡到运营的检查点,就会把运营视角的摘要当成自己的历史 ——
    // 上下文串台,而且安静。boundedContextEvents 正是靠 lastOfType 找检查点的。
    // 别人的 → null:context_compacted 的 null 会让 boundedContextEvents 直接
    // `return null` 退回全量,保守正确。
    //
    // user_message 是**唯一的例外**(#957 A-5 的后果):从前它一定不带 agentId
    // (人说的话),现在护栏/后台注给某一只 agent 的私话也带。而
    // boundedContextEvents 拿它做的是**定位**——"上一个 user turn 从哪开始"。
    // 别人的私话不是我的 turn 边界,所以这一类往前走,跳过别人的那些
    // (最多跳 FOREIGN_SCAN_LIMIT 条,跳不完回 null)。
    //
    // 回 null = modelContextScan 退回全量(#961):它把这个 null 与"checkpoint
    // 之前根本没有 user_message"一视同仁,不再区分"问不出来"还是"确实没有"——
    // 两者在这一层本来就分不清,分不清就不该赌,退回全量语义精确
    lastOfType: (sessionId, type, opts) => {
      const mine = (e: SessionEvent) => {
        const owner = "agentId" in e ? e.agentId : undefined;
        return owner === undefined || owner === agentId;
      };
      if (type !== "user_message") {
        const hit = store.lastOfType(sessionId, type, opts);
        return hit && mine(hit) ? hit : null;
      }
      let before = opts?.beforeSeq;
      for (let i = 0; i < FOREIGN_SCAN_LIMIT; i++) {
        const hit = store.lastOfType(sessionId, type, before === undefined ? undefined : { beforeSeq: before });
        if (!hit) return null;
        if (mine(hit)) return hit;
        before = hit.seq;
      }
      return null;
    },
    ofType: (sessionId, type, opts) => projectForAgent(store.ofType(sessionId, type, opts), agentId),
  };
}
