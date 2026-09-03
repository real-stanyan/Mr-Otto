// 用户在 UI 改记忆文件：写盘 + 落 memory_user_edit（ADR-0060：人手改的也要留证）。
// 没有当前会话时落到保留会话——事件必须挂在某个 sessionId 上，而"设置页"不是会话。

import type { EventStore } from "../session/store.js";
import {
  formatEntries, isMemoryTarget, parseEntries, withMemoryFileLock, memoryRelPath,
  PROJECT_ROOT_FILE, type MemoryTarget,
} from "../shared/memoryStore.js";

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
  sessionId: string = MEMORY_EDITS_SESSION,
  // 三档记忆（Task 6）：project 档需要知道写哪个项目，缺省 null = 不是项目档。
  // 缺 project 时 memoryRelPath 会抛——绝不能悄悄落到全局档。
  // id（作用域键，#886）和 dir（配置目录相对路径）成对传，形状同 createMemoryTool：
  // dir 是 id 的哈希，分开传两个参数迟早会有一处只传一半，落出一条对不上号的证据。
  // 这条路径（设置页 / 忘掉按钮）**只知道键不知道本机路径**——渲染层拿到的就是键
  project?: { id: string; dir: string } | null,
  /** topic 档改的是哪个桶；其他档忽略。缺了 memoryRelPath 会抛——绝不悄悄落到别的档 */
  topic?: string | null
): Promise<void> {
  // IPC 入参是 unknown（issue #186）：非法 target 会让 memoryRelPath(target) 抛出
  // 一个语义不明的错误，在唯一入口处先挡掉
  if (!isMemoryTarget(target)) throw new Error(`target 只能是 memory / user / project / topic，收到 ${String(target)}`);
  const rel = memoryRelPath(target, project?.dir, topic);
  // 与 memory 工具共用同一把 per-file 锁（issue #185）：工具的 read-modify-write
  // 进行中时这里进不来，before 永远是写入时刻的真实磁盘原文
  await withMemoryFileLock(rel, async () => {
    const before = await deps.readFile(rel);
    const after = formatEntries(parseEntries(text));
    if (before === after) return;
    await deps.writeFile(rel, after);
    // 目录自描述：项目档的写入必须同时补 root.txt，和 memory 工具那侧同款（幂等覆盖）。
    // 少了它，这条路径造出来的项目目录生下来就没有自描述——listProjectMemories 按
    // root.txt 列，于是它永远不出现在设置页，可注入是按哈希查目录、根本不看 root.txt，
    // 结果是一份看不见却仍在进模型上下文的记忆（ADR-0116）
    if (target === "project" && project) {
      await deps.writeFile(`${project.dir}/${PROJECT_ROOT_FILE}`, project.id);
    }
    if (sessionId === MEMORY_EDITS_SESSION && deps.store.load(sessionId).length === 0) {
      deps.store.append({ sessionId, ts: Date.now(), type: "session_created" });
      deps.store.append({ sessionId, ts: Date.now(), type: "session_archived", reason: "system" });
    }
    // projectScope 只在项目档上带（可选字段）：三档之后 target: "project" 不再唯一
    // 标识一份文件，不带的话两个 repo 的手编在日志里分不开（ADR-0116）。
    // 落的是作用域键而不是本机路径（#886）——这条路径本来也拿不到路径
    deps.store.append({
      sessionId, ts: Date.now(), type: "memory_user_edit", target, before, after,
      ...(target === "project" && project ? { projectScope: project.id } : {}),
      ...(target === "topic" && topic ? { topic } : {}),
    });
  });
}
