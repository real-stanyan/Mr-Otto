// memory 工具卡的纯逻辑:MemoryToolResult → chip 列表,以及 chip id ↔ 条目原文
// 的编解码。单独抽出来(不写在 OttoThread.tsx 里)是因为这俩函数不碰 React,
// 值得被单测直接覆盖——tests/renderer 没有 RTL(vitest.config.ts 的 include
// 只认 *.test.ts,jsdom 环境也没配),组件本体测不了,但这一层能测。

import type { MemoryToolResult } from "../../../shared/memoryStore.js";
import type { MemoryChip } from "../components/elements/memory-chips.js";

/** id 前两个字符编码来源(`a:`=added,`u:`=updated),chipEntryText 负责解回去。
    两种前缀等长,slice(2) 才安全 */
const ADDED_PREFIX = "a:";
const UPDATED_PREFIX = "u:";

export function memoryChipsFromResult(result: MemoryToolResult): MemoryChip[] {
  return [
    ...result.added.map((t) => ({ id: `${ADDED_PREFIX}${t}`, text: t, change: "added" as const })),
    ...result.updated.map((t) => ({ id: `${UPDATED_PREFIX}${t}`, text: t, change: "updated" as const })),
  ];
}

/** chip id → 原始条目文本,用于 forgetMemory(target, entry, sessionId) 的 entry 参数 */
export function chipEntryText(id: string): string {
  return id.slice(2);
}
