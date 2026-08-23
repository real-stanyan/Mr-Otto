// 用户在 UI 改记忆文件：写盘 + 落 memory_user_edit（ADR-0060：人手改的也要留证）。
// 没有当前会话时落到保留会话——事件必须挂在某个 sessionId 上，而"设置页"不是会话。

import type { EventStore } from "../session/store.js";
import { formatEntries, parseEntries, withMemoryFileLock, MEMORY_FILES, type MemoryTarget } from "../shared/memoryStore.js";

export const MEMORY_EDITS_SESSION = "sys-memory-edits";

export interface MemoryEditDeps {
  store: EventStore;
  readFile: (rel: string) => Promise<string>;
  writeFile: (rel: string, content: string) => Promise<void>;
}

/** 写记忆文件 + 落证。text 先归一化（parseEntries/formatEntries：去空条目、保序去重）
    再落盘——磁盘上永远是归一化后的样子。before 是写之前磁盘上的原文（不是归一化过的
    上一版），after 是这次归一化后的新文本。两者相等 = 无实质变更（用户随手保存一次、
    或"忘掉"一个本就不存在的条目）：不写盘、不落事件——静默 no-op，不留一条空提交 */
export async function applyUserEdit(
  deps: MemoryEditDeps,
  target: MemoryTarget,
  text: string,
  sessionId: string = MEMORY_EDITS_SESSION
): Promise<void> {
  const rel = MEMORY_FILES[target];
  // 与 memory 工具共用同一把 per-target 锁（issue #185）：工具的 read-modify-write
  // 进行中时这里进不来，before 永远是写入时刻的真实磁盘原文
  await withMemoryFileLock(target, async () => {
    const before = await deps.readFile(rel);
    const after = formatEntries(parseEntries(text));
    if (before === after) return;
    await deps.writeFile(rel, after);
    if (sessionId === MEMORY_EDITS_SESSION && deps.store.load(sessionId).length === 0) {
      deps.store.append({ sessionId, ts: Date.now(), type: "session_created" });
      deps.store.append({ sessionId, ts: Date.now(), type: "session_archived" });
    }
    deps.store.append({ sessionId, ts: Date.now(), type: "memory_user_edit", target, before, after });
  });
}
