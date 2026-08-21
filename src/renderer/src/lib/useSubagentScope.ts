// 「当前在编哪一层」这件事的唯一推导处。列表页和新建页都要它:两处各自从
// scopeOptions 里挑一遍 current、各自拼一遍目录字符串,迟早在某个边角上分家
// (一边显示「用户」、另一边把文件写进工程),而这正是作用域这个特性要治的病。
//
// 只推导,不带副作用:把死掉的作用域拨回用户级那条 effect 仍然只在设置页挂载时跑
// 一次(见 SubagentSettings)——两个组件各跑一遍会互相打架。

import { useMemo } from "react";
import { useChat } from "../store.js";
import { subagentScopeOptions, type SubagentScopeOption } from "./subagentScopes.js";

export interface SubagentScopeView {
  options: SubagentScopeOption[];
  /** 下拉此刻实际显示的那一项。store 里的 scope 可能指着一条已经没有会话的死路径,
      页面上所有跟作用域有关的字都从这里取,不从 store 那个值取 */
  current: SubagentScopeOption;
  /** current 对应的目录,给提示文案和按钮 title */
  scopeDir: string;
  /** 这份清单装不装得下两层——「用户」视图里两条根都是用户级,标签没有信息量 */
  showScope: boolean;
  setScope: (workspace: string | null) => Promise<void>;
}

export function useSubagentScope(): SubagentScopeView {
  const sessions = useChat((s) => s.sessions);
  const scope = useChat((s) => s.subagentScope);
  const setScope = useChat((s) => s.setSubagentScope);

  const options = useMemo(() => subagentScopeOptions(sessions), [sessions]);
  const current = options.find((o) => o.workspace === scope) ?? options[0]!;

  return {
    options,
    current,
    scopeDir: current.workspace ? `${current.workspace}/.otter/agents` : "~/.otter/agents",
    showScope: current.workspace !== null,
    setScope,
  };
}
