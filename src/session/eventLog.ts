// EventLog —— LoopEngine 与 boundedContextEvents 需要的那几个读写口,抽成接口(#928)。
//
// 为什么要这个接口:多智能体会话里,同一份日志装着好几只 agent 的痕迹,而一只
// agent 不该看见别人的工具调用与结果。隔离必须**靠构造**——装配那一刻递给 engine
// 一份变换过的日志,而不是在 engine 内部每处读点补一道过滤:model-facing 的读有
// 三处(snapshot 首圈 / snapshot 增量圈 / compactInner 全量),漏一处就安静地
// 把别人的上下文灌进模型(ADR-0047 否掉「子 agent 事件写进父日志」的同一条理由)。
//
// 为什么不能裸包一层 EventStore:它是 class 且有 private 成员(db / stmts /
// prep / loadRaw),结构类型检查过不了——必须有一个双方都实现的接口。
//
// 五个方法是实测出来的,不是照着 EventStore 的公开面抄的:engine.ts 只碰
// append / load,另外三个来自 boundedContextEvents(它也收 store)。接口窄一分,
// agentView 那侧要负责的语义就少一分。

import type { SessionEvent } from "./events.js";
import type { NewSessionEvent } from "./store.js";

export interface EventLog {
  append(event: NewSessionEvent): SessionEvent;
  load(sessionId: string, opts?: { afterSeq?: number; untilSeq?: number }): SessionEvent[];
  forkOrigin(sessionId: string): { sessionId: string; endSeq: number } | null;
  lastOfType(
    sessionId: string,
    type: SessionEvent["type"],
    opts?: { beforeSeq?: number }
  ): SessionEvent | null;
  ofType(
    sessionId: string,
    type: SessionEvent["type"],
    opts?: { beforeSeq?: number }
  ): SessionEvent[];
}
