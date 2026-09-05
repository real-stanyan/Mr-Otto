// workspaceMemory —— 工作区多智能体的记忆纯层（spec §6，#949）。
// 两档：shared（工作区共享，换一只 agent 还成立的事）/ own（这只 agent 自己的手感）。
// 档位枚举是**云侧自己的一份**，不动 memoryStore.ts 的 MemoryTarget——那个类型手机端也在用，
// 收窄它会把桌面四档一起打红（spec §6.1）。条目切分/上限/原子批量复用 memoryStore.ts。
// 三端共用（桌面设置页算占用、runtime 工具写入、将来手机端），纪律同 memoryStore.ts。

import { promptSafe } from "./promptSafe.js";

export type WorkspaceMemoryTier = "shared" | "own";

/** 共享档在 workspace_memories 表里的 agent_id：空串（一档一行，主键 (workspace_id, agent_id)） */
export const SHARED_MEMORY_AGENT_ID = "";

/** 字符上限沿用本机记忆的量级（spec §6）：共享接替 project 档的位置（2200），私有同 MEMORY（1100）。
    紧上限不是为了省 token，是为了逼出策展（memoryStore.ts 头注的同一条理由） */
export const WORKSPACE_MEMORY_LIMITS: Record<WorkspaceMemoryTier, number> = { shared: 2200, own: 1100 };

export const WORKSPACE_MEMORY_LABEL: Record<WorkspaceMemoryTier, string> = { shared: "SHARED", own: "OWN" };

export function isWorkspaceMemoryTier(v: unknown): v is WorkspaceMemoryTier {
  return v === "shared" || v === "own";
}

/** 两档判据的唯一正文（同 tierRuleText 的纪律，#589：判据必须是一个可回答的问题）。
    upper = 提示词里用大写档名，工具描述用小写（对齐 target 枚举值） */
export function workspaceTierRuleText(opts: { upper?: boolean } = {}): string {
  const S = opts.upper ? "SHARED" : "shared";
  const O = opts.upper ? "OWN" : "own";
  return (
    `${S} 记这个工作区里所有智能体都该知道的事（业务口径、数据定义、客户约定、谁负责什么）；` +
    `${O} 记只对你这只智能体成立的事（你的工作习惯、你常用的查询方式、你踩过的坑）。` +
    `判据一句话：换一只 agent 还成立吗？成立写 ${S}，不成立写 ${O}。` +
    `一个事实只住一档；${S} 的每条会自动带上写入者名字，矛盾的口径要看得出是谁说的。`
  );
}

/** 共享档写入者前缀（spec §6.2）：两只 agent 写进矛盾事实时，人要能看出去问谁。
    由写入路径拼，不靠模型自觉。已带同一前缀的不再加（模型照着旧条目的样子重写时常会自带）。
    名字过 `promptSafe`（终审 I4）：这里拼出来的是 `[名字] 正文` 这个**结构**，
    一个 `]` 就把前缀提前闭合——`A]x[B` 拼出的 `[A]x[B] …` 读起来是「A 说的，
    正文以 x[B] 开头」，署名被伪造。`validateAgentName` 已经拦了新名字，但旧日志/
    未经这轮校验落库的名字照样走到这里，两道闸各自独立成立（promptSafe.ts 头注）。
    转义后的名字与前缀是同一份，所以 startsWith 的幂等判断照旧成立 */
export function withWriterPrefix(writer: string, content: string): string {
  const prefix = `[${promptSafe(writer)}] `;
  return content.startsWith(prefix) ? content : `${prefix}${content}`;
}

/** 共享档条目单行化（B-I3，#957）：一条共享条目只带一次写入者前缀——换行是伪造第二行
    `[名字] ...` 签名的唯一手段（applyEntryOps 只拦 `\n§\n`/独立一行 `§` 这两种分隔符，
    不拦普通换行）。折行必须在 withWriterPrefix 之前跑：折完再拼前缀，前缀天然只出现
    一次；调用方在own 档（每只 agent 自己的私档，没有「谁写的」这个问题）不折。
    `[\r\n]+\s*` 一次性吃掉换行本身与它带出来的整段前导空白，折成单个空格——避免
    "a\n\n  b" 这种多重换行 + 缩进折出 "a   b" 式的多个空格 */
export function collapseSharedEntry(content: string): string {
  return content.replace(/[\r\n]+\s*/g, " ").trim();
}

/** 读改写互斥的锁键（配 memoryStore.withMemoryFileLock）：同一个 daemon 进程里，同一工作区的
    两条云会话可能同时写共享档——按 (workspaceId, agentId) 分格，不同工作区互不串 */
export function workspaceMemoryLockKey(workspaceId: string, agentId: string): string {
  return `ws-memory:${workspaceId}:${agentId}`;
}
