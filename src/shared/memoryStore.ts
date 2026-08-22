// 记忆文件的纯函数层：解析 / 序列化 / 操作。对标 hermes-agent tools/memory_tool.py。
// 放 shared：工具（主进程）和设置页（渲染层）都要算占用、都要认同一种格式。
// 字符上限而不是 token：字符数与模型无关（hermes 同款理由）。

export type MemoryTarget = "memory" | "user";

export const MEMORY_LIMITS: Record<MemoryTarget, number> = { memory: 2200, user: 1375 };
export const MEMORY_FILES: Record<MemoryTarget, string> = {
  memory: "memories/MEMORY.md",
  user: "memories/USER.md",
};
export const ENTRY_DELIMITER = "\n§\n";

export function charCount(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** 切条目：trim、去空、保序去重（hermes 用 dict.fromkeys 的同款语义） */
export function parseEntries(text: string | null): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(ENTRY_DELIMITER)) {
    const e = raw.trim();
    if (!e || seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

export function formatEntries(entries: string[]): string {
  return entries.join(ENTRY_DELIMITER);
}

export type MemoryOp =
  | { action: "add"; target: MemoryTarget; content: string }
  | { action: "replace"; target: MemoryTarget; old_text: string; content: string }
  | { action: "remove"; target: MemoryTarget; old_text: string };

export type ApplyResult =
  | { ok: true; entries: string[]; changed: { added: string[]; updated: string[]; removed: string[] } }
  | { ok: false; error: string };

const LABEL: Record<MemoryTarget, string> = { memory: "MEMORY", user: "USER" };

/** 按 old_text 子串找唯一一条。0 条 / 多条都是错：模型给的定位词不够具体，
    让它换个更长的——绝不猜 */
function locate(entries: string[], oldText: string): { idx: number } | { error: string } {
  const hits = entries.map((e, i) => (e.includes(oldText) ? i : -1)).filter((i) => i >= 0);
  if (hits.length === 0) return { error: `没有条目包含「${oldText}」` };
  if (hits.length > 1) return { error: `有 ${hits.length} 条都包含「${oldText}」，换一段更具体的 old_text` };
  return { idx: hits[0]! };
}

/** 原子批量：任一条失败整批不落；上限只在最终结果上校验 */
export function applyOps(target: MemoryTarget, entries: string[], ops: MemoryOp[]): ApplyResult {
  const next = [...entries];
  const changed = { added: [] as string[], updated: [] as string[], removed: [] as string[] };
  for (const op of ops) {
    if (op.target !== target) return { ok: false, error: `这一批只能操作 ${LABEL[target]}，混进了 ${LABEL[op.target]} 的操作` };
    if (op.action === "add") {
      const c = op.content.trim();
      if (!c) return { ok: false, error: "content 为空" };
      if (next.includes(c)) return { ok: false, error: `已存在完全相同的条目：「${c}」` };
      next.push(c);
      changed.added.push(c);
    } else {
      const loc = locate(next, op.old_text);
      if ("error" in loc) return { ok: false, error: loc.error };
      if (op.action === "remove") {
        changed.removed.push(next[loc.idx]!);
        next.splice(loc.idx, 1);
      } else {
        const c = op.content.trim();
        if (!c) return { ok: false, error: "content 为空" };
        next[loc.idx] = c;
        changed.updated.push(c);
      }
    }
  }
  const used = charCount(formatEntries(next));
  const limit = MEMORY_LIMITS[target];
  if (used > limit) {
    return {
      ok: false,
      error:
        `${LABEL[target]} 超限：这批操作后 ${used}/${limit} 字符。` +
        `不会自动淘汰——先用 remove/replace 合并或删掉过时条目腾出空间，再加。`,
    };
  }
  return { ok: true, entries: next, changed };
}

// Memory tool result interface and parser

export interface MemoryToolResult {
  ok: true;
  target: MemoryTarget;
  added: string[];
  updated: string[];
  removed: string[];
  used: number;
  limit: number;
}

export const MEMORY_RESULT_MARK = "<!--memory:";

/** UI 从 tool_result.output 末行解析 chips。解析失败 = null，UI 退回通用工具行；note: lastIndexOf("-->") assumes entry text never contains "-->" */
export function parseMemoryResult(output: string): MemoryToolResult | null {
  const i = output.lastIndexOf(MEMORY_RESULT_MARK);
  if (i < 0) return null;
  const json = output.slice(i + MEMORY_RESULT_MARK.length, output.lastIndexOf("-->"));
  try {
    const v = JSON.parse(json) as MemoryToolResult;
    return v.ok === true ? v : null;
  } catch {
    return null;
  }
}
