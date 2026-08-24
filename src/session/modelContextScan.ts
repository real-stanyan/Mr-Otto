// 模型上下文的有界重建（issue #351，codex ModelContextScan 对照）。
//
// 会话变长后，「从日志重建模型上下文」不该全量读：context_compacted 之后
// 投影清场重来（replacement 语义），checkpoint 之前的绝大多数事件对模型
// 视野再无贡献。从日志尾部反向凑齐两个条件即停：
//   ① 最近一个压缩 checkpoint（context_compacted）
//   ② 一个完整的**真实 user turn 边界**——日志层的 user_message 就是显式
//     标记：skill 注入 / 图片解析 / 记忆等"伪装成 user 消息"的内容都是独立
//     事件类型（skill_invoked / image_described / memory_loaded），投影期才
//     变成 user role。不猜前缀，按事件类型判定（issue #351 ③ 在本仓的形态）
// 然后**正向重放**这份有界事件集，语义精确。
//
// checkpoint 之前仍要带上的少数事件（deriveMessages 的清场逻辑读它们）：
//   - session_created（围栏 system 消息）+ memory_loaded（system 尾部）
//   - 全部 skill_invoked（台账语义"启用过=仍生效"，清场后重注入，ADR-0066）
//   - 最后一个非空跑 user turn 的连续段（compact 中途触发时投影兜底重注
//     当前请求原文，issue #193）——从该 user_message 到 checkpoint 连续取，
//     空跑判定（barren）在段内自洽
//
// 逃生舱（保守正确 > 优化）：没有 checkpoint / 往回找不到活的 user turn
// （连试 MAX_BACKTRACK 个都是空跑）→ 返回 null，调用方退回全量重建。
//
// 等价性契约：deriveMessages(有界集) 必须与 deriveMessages(全量) 逐字节一致
// ——前缀缓存命中依赖这一点（ADR-0073），一致性测试钉住。

import type { SessionEvent } from "./events.js";
import type { EventStore } from "./store.js";
import { barrenEventIndexes } from "./barrenTurns.js";

/** 空跑 turn 连续回溯的上限：正常日志一两步就找到活 turn，连着五个空跑
    （全是 429/中断）还没找到就别赌了——退回全量，多花的只是一次读 */
const MAX_BACKTRACK = 5;

export function boundedContextEvents(store: EventStore, sessionId: string): SessionEvent[] | null {
  // fork 链（issue #352）：typed 原子步（lastOfType/ofType）是单会话查询，
  // 看不到父会话前缀里的 checkpoint / skill / memory——分支一律退回全量
  // （load 沿链取数，正确性不受影响；分支的有界重建留给真实需求出现时）
  if (store.forkOrigin(sessionId) !== null) return null;
  const cp = store.lastOfType(sessionId, "context_compacted");
  if (!cp) return null; // 没有 checkpoint = 没有可跳过的历史，全量本来就是答案

  // 尾段：checkpoint（含）到日志末尾
  const tail = store.load(sessionId, { afterSeq: cp.seq - 1 });

  // checkpoint 之前的三类"清场幸存者"
  const head: SessionEvent[] = [
    ...store.ofType(sessionId, "session_created", { beforeSeq: cp.seq }),
    ...store.ofType(sessionId, "memory_loaded", { beforeSeq: cp.seq }),
    ...store.ofType(sessionId, "skill_invoked", { beforeSeq: cp.seq }),
  ];

  // 最后一个活的 user turn 段：从候选 user_message 连续取到 checkpoint 前，
  // 空跑（barren）就把上一个 user turn 也接进来（段保持连续，判定自洽）
  let segment: SessionEvent[] = [];
  let cursor = cp.seq;
  let foundLive = false;
  for (let i = 0; i < MAX_BACKTRACK; i++) {
    const u = store.lastOfType(sessionId, "user_message", { beforeSeq: cursor });
    if (!u) {
      foundLive = true; // checkpoint 之前根本没有 user turn（理论上只在裸测试日志出现）
      break;
    }
    const piece = store.load(sessionId, { afterSeq: u.seq - 1, untilSeq: cursor - 1 });
    segment = [...piece, ...segment];
    cursor = u.seq;
    // 空跑判定在"段 + 尾段"上跑：compact 中途触发时（auto），当前请求的
    // turn_ended 落在 checkpoint 之后——判定必须看得到尾段，与全量口径一致
    const probe = [...segment, ...tail];
    if (!barrenEventIndexes(probe).has(0)) {
      foundLive = true;
      break;
    }
  }
  if (!foundLive) return null; // 逃生舱：退化全量

  // 合并（head 可能与 segment 重叠——段里的 skill_invoked 两边都取到了）：
  // 按 seq 去重排序，正向重放的输入必须是一个严格递增的事件序列
  const bySeq = new Map<number, SessionEvent>();
  for (const e of [...head, ...segment, ...tail]) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
