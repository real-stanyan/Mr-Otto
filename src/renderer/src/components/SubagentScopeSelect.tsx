// 作用域下拉。列表页头部和新建页表单里是同一个控件、同一份 store 状态:
// 它不是筛选器,是"当前编辑的那一层"——新建、保存、复制都落在它指的地方。

import { cn } from "@/lib/utils.js";
import type { SubagentScopeView } from "../lib/useSubagentScope.js";

export function SubagentScopeSelect({
  scope,
  id = "subagent-scope",
  className,
}: {
  scope: SubagentScopeView;
  /** 同一页上出现两次时要区分——label 的 htmlFor 指着它 */
  id?: string;
  className?: string;
}) {
  return (
    <select
      id={id}
      value={scope.current.workspace ?? ""}
      onChange={(e) => void scope.setScope(e.target.value === "" ? null : e.target.value)}
      className={cn(
        "press-scale border border-border rounded-md bg-card px-2 py-1 text-[12.5px] text-foreground transition-colors duration-150",
        className
      )}
      title={scope.current.workspace ?? "所有工程都能用的那一层"}
    >
      {scope.options.map((o) => (
        <option key={o.workspace ?? "user"} value={o.workspace ?? ""}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
