// cloudStreaming —— 云会话流式缓冲的纯逻辑（issue #1107，协议 16 的 delta 帧）。
// 与本机 `streamingBySession`（store.ts）同一份契约，两条差别：
//   ① 分槽键是 **agentId** 不是 sessionId——群里同一刻可能有好几只在打字；
//   ② 帧里的 text 是**累计快照**不是增量（协议文件那条帧的注释），所以这里
//      是整槽替换，不是拼接——中继掉帧/中途 join/gone 后重连都不会在预览上
//      咬出洞，丢一帧只是少一次刷新。
// 碎片永远不落任何持久层；终态事件（assistant_message / turn_ended）一到，
// 那一槽作废——「不完整就不是消息」，与本机 absorbEvent 清 streamingBySession
// 是同一条纪律。

import type { SessionEvent } from "../../../session/events.js";
import type { CloudSessionDelta } from "../../../shared/shellBridge.js";

/** agentId → 这一轮到此刻为止攒下的正文预览 */
export type CloudStreaming = Record<string, string>;

/** 进一片 delta：整槽替换（快照语义）。reasoning 不缓冲——终态气泡
    （CloudSessionPage 的 AssistantMessageRow）只画 content，预览不该展示
    终态不存在的东西；runtime 那侧今天也只发 content，这一判是兜底 */
export function applyCloudDelta(prev: CloudStreaming, delta: CloudSessionDelta): CloudStreaming {
  if (delta.kind !== "content") return prev;
  if (prev[delta.agentId] === delta.text) return prev;
  return { ...prev, [delta.agentId]: delta.text };
}

/** 终态清槽：这条事件若收掉了某只 agent 的预览（最终答案落盘 / 这一轮
    结束），回清掉那一槽后的新表；与预览无关的事件原样返回（===，调用方
    据此跳过一次不必要的 set） */
export function clearCloudStreamingOn(prev: CloudStreaming, event: SessionEvent): CloudStreaming {
  if (event.type !== "assistant_message" && event.type !== "turn_ended") return prev;
  // 缺席 agentId = 旧日志/本机会话形状的事件，本来也没有槽可清
  const agentId = event.agentId;
  if (agentId === undefined || !(agentId in prev)) return prev;
  const next = { ...prev };
  delete next[agentId];
  return next;
}
