// 新建页的种子定义 + 撞名查询。
// 抽成纯函数是为了能测:新建页本身没有渲染测试(#147),但"新建出来的那份长什么样"
// 是会进磁盘的东西——缺省工具集给错、审批档给成 auto,是静默放权,不是显示问题。

import {
  DEFAULT_SUBAGENT_TOOLS,
  type SubagentDef,
  type SubagentScope,
} from "../../../shared/subagent.js";

/**
 * 新建页开局那份草稿。刻意和主进程 createSubagent 写出来的空壳一字不差
 * （tools = 缺省只读那几把、approval = deny、preamble = 用全局）：新建页是
 * "先在界面上填好、再一次落盘"，用户没碰过的字段落地后必须跟他不填时一模一样。
 *
 * path / source 留空:这份草稿还没有磁盘地址。真地址来自 createSubagent 回传的
 * 那份清单(渲染层猜的路径后端一概不采信,见 saveSubagent 的 IPC handler)。
 */
export function blankSubagentDef(scope: SubagentScope): SubagentDef {
  return {
    name: "",
    description: "",
    instructions: "",
    tools: [...DEFAULT_SUBAGENT_TOOLS],
    unknownTools: [],
    approval: "deny",
    preamble: { mode: "default" },
    context: [],
    scope,
    path: "",
    source: "",
    readOnly: false,
  };
}

/**
 * 这个名字在当前清单里被谁占着。不分大小写:落地的是 macOS 文件名(APFS 大小写
 * 不敏感),`Reviewer` 和 `reviewer` 是同一个文件。
 *
 * 查到不等于建不出来——后端只问"落点那一层占了没",工作区级盖住同名的用户级那份
 * 正是覆盖规则的用法。这里查出来是为了**先说一声**:清单去重之后用户只看得见赢的
 * 那一份,不提示的话他刚才盯着的那行会被一个新的顶掉,没有任何交代。
 */
export function shadowedSubagent(
  name: string,
  subagents: readonly SubagentDef[]
): SubagentDef | null {
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) return null;
  return subagents.find((d) => d.name.toLowerCase() === trimmed) ?? null;
}
