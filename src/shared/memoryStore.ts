// 记忆文件的纯函数层：解析 / 序列化 / 操作。对标 hermes-agent tools/memory_tool.py。
// 放 shared：工具（主进程）和设置页（渲染层）都要算占用、都要认同一种格式。
// 字符上限而不是 token：字符数与模型无关（hermes 同款理由）。

export type MemoryTarget = "memory" | "user" | "project";

/** 运行时守卫（issue #186）：IPC/工具入参都是 unknown，非法值会一路传进文件路径拼接 */
export function isMemoryTarget(v: unknown): v is MemoryTarget {
  return v === "memory" || v === "user" || v === "project";
}

// 三档预算（ADR 见 docs/adr/）。全局 MEMORY 从 2200 降到 1100：三档之后它的职责
// 变窄了——项目约定全搬去项目档，它只装「换个项目也成立」的事（本机环境、工具怪癖）。
// 不做成配置：紧上限不是为了省 token，是为了逼出策展；可配置会诱导调数字而非合并条目。
export const MEMORY_LIMITS: Record<MemoryTarget, number> = { memory: 1100, user: 1375, project: 2200 };

export const MEMORY_DIR = "memories";
/** 项目记忆目录里的两个文件。root.txt 让目录自描述（设置页要显示「这份记忆属于
    哪个项目」），不引入中心索引——索引是派生物，会和磁盘现实脱节 */
export const PROJECT_MEMORY_FILE = "MEMORY.md";
export const PROJECT_ROOT_FILE = "root.txt";

/** 记忆文件的配置目录相对路径。projectDir 由主进程算好传进来（形如
    "memories/projects/<hash16>"）——src/shared 不许 import node:crypto（手机端要跑这一层） */
export function memoryRelPath(target: MemoryTarget, projectDir?: string | null): string {
  if (target === "user") return `${MEMORY_DIR}/USER.md`;
  if (target === "memory") return `${MEMORY_DIR}/MEMORY.md`;
  if (!projectDir) throw new Error("project 档需要 projectDir——没有项目根时不该走到这里");
  return `${projectDir}/${PROJECT_MEMORY_FILE}`;
}

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

// 写互斥（issue #185）：memory 工具与设置页 applyUserEdit 都是 read-modify-write。
// key 是**文件相对路径**而不是 target——三档之后两个不同项目的项目档是两个文件，
// 按 target 加锁会把它们无谓地串起来。
const fileLocks = new Map<string, Promise<unknown>>();

export function withMemoryFileLock<T>(relPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(relPath) ?? Promise.resolve();
  // 前一次成功失败都不影响这一次排队（失败的写不该把后面的写都堵死）
  const run = prev.then(fn, fn);
  fileLocks.set(relPath, run.catch(() => {}));
  return run;
}

export type MemoryOp =
  | { action: "add"; target: MemoryTarget; content: string }
  | { action: "replace"; target: MemoryTarget; old_text: string; content: string }
  | { action: "remove"; target: MemoryTarget; old_text: string };

export type ApplyResult =
  | { ok: true; entries: string[]; changed: { added: string[]; updated: string[]; removed: string[] } }
  | { ok: false; error: string };

const LABEL: Record<MemoryTarget, string> = { memory: "MEMORY", user: "USER", project: "PROJECT" };

/** 按 old_text 子串找唯一一条。0 条 / 多条都是错：模型给的定位词不够具体，
    让它换个更长的——绝不猜 */
/** content 混进分隔符会把一条写成两条（或撕裂后续 parseEntries）——整段
    ENTRY_DELIMITER（"\n§\n"）出现，或某一行独立就是 "§"，都拒 */
function containsDelimiter(content: string): boolean {
  if (content.includes(ENTRY_DELIMITER)) return true;
  return content.split("\n").some((line) => line === "§");
}

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
      if (containsDelimiter(c)) return { ok: false, error: "条目内容不能包含分隔符 §" };
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
        if (containsDelimiter(c)) return { ok: false, error: "条目内容不能包含分隔符 §" };
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

/** 机器可读尾行的序列化（写侧，issue #186）：JSON 里的 `<`/`>` 全部转成 \uXXXX
    转义——JSON.stringify 只会在字符串字面量里出现这两个字符，转义后语义不变，
    但条目内容再也拼不出 `-->`（终止符）或 `<!--memory:`（起始标记），
    parseMemoryResult 的 lastIndexOf 定界从此撕不裂。解析侧不用改：旧日志的
    输出照旧解析 */
export function formatMemoryResultLine(result: MemoryToolResult): string {
  const json = JSON.stringify(result).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  return `${MEMORY_RESULT_MARK}${json}-->`;
}

/** UI 从 tool_result.output 末行解析 chips。解析失败 = null，UI 退回通用工具行；
    写侧已把 JSON 里的尖括号转义（见 formatMemoryResultLine），条目内容不可能再撕裂定界 */
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
