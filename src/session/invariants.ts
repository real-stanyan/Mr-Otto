// 运行时不变量校验（issue #389，dsh runtime invariant registry 对照）。
// 事件流的结构合法性此前全靠投影层静默自愈（healDanglingToolCalls / 孤儿
// tool_result 过滤 / steer 延迟重排）——自愈让系统能跑，但把 bug 藏进了
// 「反正投影会修」的暗处。这层校验把「流本来该长什么样」写成可执行断言：
// 违例 = 写入方（engine / 修复逻辑）有 bug 的线索，不是日志不可用的判决。
//
// 刻意不断言的（都有合法反例）：
// - ts 顺序：修复事件盖的是修复时刻的 Date.now()，晚于所属 turn 是常态
// - session_created 唯一 / 在头部：fork 链视图合法地含两条（store.load 拼接）
// - 一个 turn 只有一条 user_message：steer（issue #344）就是中途多补几条
// - turn 尾部收口：日志尾部开着的 turn = 正在跑或刚崩，等修复合成收口
// - turn_ended 后必须紧跟 user_message：ADR-0005 悬空修复把合成 tool_result
//   追加在已收口的 turn 之后（快照式扫描），合法尾巴
import type { SessionEvent } from "./events.js";

export interface InvariantViolation {
  /** 短标识（稳定，可 grep）：tool_result_orphan / tool_result_duplicate /
      tool_call_id_reused / execution_started_orphan /
      execution_started_duplicate / execution_after_result / turn_ended_empty */
  invariant: string;
  /** 违例事件的 seq */
  seq: number;
  detail: string;
}

// nudge 派活的收口 tool_result（issue #186）：toolCallId = memory-nudge-N，
// 没有对应的 assistant_message.toolCalls——已知的历史合法违例，投影层同款豁免
const EXEMPT_TOOL_CALL_ID = /^memory-nudge-/;

/** turn 活动判据——与 createAgent 崩溃合成收口用的同一组（保持一致，
    这里不 import 是因为那组集合是 agent.ts 的局部实现细节） */
const TURN_ACTIVITY: ReadonlySet<SessionEvent["type"]> = new Set([
  "user_message",
  "assistant_message",
  "tool_result",
  "tool_execution_started",
]);

/** 纯函数：全量扫一遍，返回全部违例（空数组 = 干净）。
    调用方决定后果——resume 只告警不拦（硬规则「旧日志永远可重放」优先），
    测试里当严格断言用（engine 产出的日志必须零违例）。 */
export function checkInvariants(events: readonly SessionEvent[]): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  const known = new Set<string>(); // assistant_message.toolCalls 声明过的 id
  const answered = new Set<string>(); // 已有 tool_result 的 id
  const started = new Set<string>(); // 已有 tool_execution_started 的 id
  let activitySinceClose = false; // 自上一条 turn_ended 后是否有 turn 活动

  for (const e of events) {
    switch (e.type) {
      case "assistant_message":
        for (const tc of e.toolCalls ?? []) {
          if (known.has(tc.id)) {
            out.push({
              invariant: "tool_call_id_reused",
              seq: e.seq,
              detail: `toolCallId「${tc.id}」在多条 assistant_message 里声明`,
            });
          }
          known.add(tc.id);
        }
        break;
      case "tool_result":
        if (!known.has(e.toolCallId) && !EXEMPT_TOOL_CALL_ID.test(e.toolCallId)) {
          out.push({
            invariant: "tool_result_orphan",
            seq: e.seq,
            detail: `tool_result 引用的 toolCallId「${e.toolCallId}」没有对应的 assistant_message.toolCalls 声明`,
          });
        }
        if (answered.has(e.toolCallId)) {
          out.push({
            invariant: "tool_result_duplicate",
            seq: e.seq,
            detail: `toolCallId「${e.toolCallId}」有多条 tool_result`,
          });
        }
        answered.add(e.toolCallId);
        break;
      case "tool_execution_started":
        if (!known.has(e.toolCallId)) {
          out.push({
            invariant: "execution_started_orphan",
            seq: e.seq,
            detail: `tool_execution_started 引用的 toolCallId「${e.toolCallId}」没有对应声明`,
          });
        }
        if (started.has(e.toolCallId)) {
          out.push({
            invariant: "execution_started_duplicate",
            seq: e.seq,
            detail: `toolCallId「${e.toolCallId}」有多条 tool_execution_started`,
          });
        }
        if (answered.has(e.toolCallId)) {
          out.push({
            invariant: "execution_after_result",
            seq: e.seq,
            detail: `toolCallId「${e.toolCallId}」的 tool_execution_started 晚于它的 tool_result`,
          });
        }
        started.add(e.toolCallId);
        break;
      case "turn_ended":
        if (!activitySinceClose) {
          out.push({
            invariant: "turn_ended_empty",
            seq: e.seq,
            detail: "turn_ended 之前没有任何 turn 活动（双收口或收口错位）",
          });
        }
        activitySinceClose = false;
        break;
    }
    if (TURN_ACTIVITY.has(e.type)) activitySinceClose = true;
  }
  return out;
}
