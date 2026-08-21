// 设置页作用域下拉的候选。
// 候选来自"有过会话的工程文件夹"——不新开一条 IPC 去列目录:会话列表本来就在
// store 里,而一个从没开过会话的文件夹,用户也没有在那儿建子智能体的由头。
// 代价写在 ADR-0048「接受的代价」里:要先在那个工程开一次会话。

import { groupSessionsByWorkspace } from "../sessionGroups.js";
import type { SessionSummary } from "../../../shared/shellBridge.js";

export interface SubagentScopeOption {
  /** null = 用户级 */
  workspace: string | null;
  label: string;
}

export function subagentScopeOptions(sessions: readonly SessionSummary[]): SubagentScopeOption[] {
  return [
    { workspace: null, label: "用户" },
    ...groupSessionsByWorkspace([...sessions]).map((g) => ({
      workspace: g.workspace,
      label: g.label,
    })),
  ];
}

/**
 * 打开设置页时该停在哪一层:跟着此刻在看的那个会话的工程走,它不在候选里才回「用户」。
 *
 * 恒定停在「用户」不是"少看几行"的事,是一条静默写错地方的路:用户在工程 W 的会话里
 * 已经定过两个工作区级的子智能体,打开这一页看到的却是空清单 + "把文件放进
 * ~/.otter/agents"的提示——他照着点「新建」,文件就落在了全局那一层,处处可见,
 * 而全局命名空间污染正是作用域这整个特性要治的病(ADR-0048)。
 *
 * 候选里没有(那个工程还没开过会话、或者是没记 workspace 的史前会话)就回 null:
 * 主进程的写路径只认"日志里出现过的围栏",给它一个认不出的路径只会在保存时抛
 * 「不认识这个工作区」——不如老老实实停在用户级。
 *
 * 它是"开页时的落点"而不是一条偏好:不做持久化、不记住上次手选的那一层,
 * 每次打开都重新跟着当前会话算——页面跟着会话走,不跟着上一次的页面走。
 */
export function initialSubagentScope(
  workspace: string | null | undefined,
  options: readonly SubagentScopeOption[]
): string | null {
  if (!workspace) return null;
  return options.some((o) => o.workspace === workspace) ? workspace : null;
}

/** 复制一份时用哪个名字。挑第一个当前清单里没被占的 —— `-copy`、`-copy-2`…
    不挑的话「再点一次」是一条走不通的路：第一次点击已经把 `X-copy` 建出来了
    （只是内容还没抄过去），第二次点撞的就是「已经有一个叫 X-copy 的子智能体了」，
    而那个空壳文件谁也够不着。让死路不存在，比让一句提示活下来更可靠 ——
    提示会被切作用域时的清单重置连同整行一起卸载掉。
    比较不分大小写：落地的是 macOS 文件名，APFS 大小写不敏感。 */
export function freeCopyName(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  const first = `${base}-copy`;
  if (!used.has(first.toLowerCase())) return first;
  for (let i = 2; ; i++) {
    const candidate = `${first}-${i}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}
