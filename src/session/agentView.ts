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
// reasoning / usage 一并剥掉:前者 API 明令禁止塞回上下文,后者是账不是话。
//
// **这是一个 Record 不是一张名单**:每个事件类型都必须表态,加了新事件类型不来
// 这里写一笔,tsc 直接红。形状照 sessionPackage.ts 的 PRIVACY_VERDICTS。
// 这张表的初稿就是一张名单,而它漏掉 context_compacted 的代价是:别人压缩一次,
// 我的整段真实历史被抹掉换成别人视角的摘要(deriveMessages 对它的处理是
// messages.length = 0,清场重来)。名单漏一个是静默灾难,Record 漏一个是编译错误。

import type { EventLog } from "./eventLog.js";
import type { SessionEvent } from "./events.js";

/** 别人的这条事件,我看得见吗(#928)。判据一句话:这条事件说的是「群里发生的事」,
    还是「那只 agent 自己干活的过程」?后者 drop */
type OtherAgentVerdict =
  /** 全场共有的事实,或与「谁干的」无关 —— 原样进我的上下文 */
  | "keep"
  /** 别人干活留下的痕迹 —— 整条不进 */
  | "drop"
  /** 只留它说出口的那部分(assistant_message:剥掉 toolCalls / reasoning / usage) */
  | "spoken";

const OTHER_AGENT_VERDICTS: Record<SessionEvent["type"], OtherAgentVerdict> = {
  // ── 全场共有或与执行者无关 ──
  session_created: "keep",
  user_message: "keep",
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

  // ── 那只 agent 说出口的话 ──
  assistant_message: "spoken",

  // ── 别人干活的过程 ──
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
  background_task_started: "drop",
  background_task_completed: "drop",
  image_described: "drop",
  section_classified: "drop",
  suggestions_generated: "drop",
  share_grant_note: "drop",
  workspace_restored: "drop",
};

export function projectForAgent(events: SessionEvent[], agentId: string): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (const e of events) {
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
      // assistant_message:纯工具调用那一轮它没说话,剥完就是一条空消息 —— 不该占我上下文一格
      if (e.type === "assistant_message") {
        if (e.content.trim() === "") continue;
        const { toolCalls: _tc, reasoning: _r, usage: _u, ...stripped } = e;
        out.push(stripped as unknown as SessionEvent);
      } else {
        out.push(e);
      }
      continue;
    }
  }
  return out;
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
    // user_message 不带 agentId(那是人说的话),照旧原样转发 —— 它回的是定位用的
    // seq,过滤反而会让后续按 seq 取的范围错位
    lastOfType: (sessionId, type, opts) => {
      const hit = store.lastOfType(sessionId, type, opts);
      if (!hit) return null;
      const owner = "agentId" in hit ? hit.agentId : undefined;
      return owner === undefined || owner === agentId ? hit : null;
    },
    ofType: (sessionId, type, opts) => projectForAgent(store.ofType(sessionId, type, opts), agentId),
  };
}
