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

import type { EventLog } from "./eventLog.js";
import type { SessionEvent } from "./events.js";

/** 别人干活留下的痕迹 —— 整条不进我的上下文 */
const OTHERS_TURN_EVENTS: ReadonlySet<SessionEvent["type"]> = new Set([
  "tool_result",
  "tool_execution_started",
  "approval_request",
  "approval_decision",
  "request_envelope",
  "turn_ended",
]);

export function projectForAgent(events: SessionEvent[], agentId: string): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (const e of events) {
    const owner = "agentId" in e ? e.agentId : undefined;
    // 没有 agentId = 全场共有(session_created / user_message / chat_message /
    // memory_loaded / context_compacted …),或者这是一条单 agent 会话的旧事件
    if (owner === undefined || owner === agentId) {
      out.push(e);
      continue;
    }
    if (OTHERS_TURN_EVENTS.has(e.type)) continue;
    if (e.type === "assistant_message") {
      // 纯工具调用那一轮它没说话,剥完就是一条空消息 —— 不该占我上下文一格
      if (e.content.trim() === "") continue;
      const { toolCalls: _tc, reasoning: _r, usage: _u, ...stripped } = e;
      out.push(stripped as unknown as SessionEvent);
      continue;
    }
    out.push(e);
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
