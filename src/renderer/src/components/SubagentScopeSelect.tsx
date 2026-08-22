// 作用域下拉。列表页头部和新建页表单里是同一个控件、同一份 store 状态:
// 它不是筛选器,是"当前编辑的那一层"——新建、保存、复制都落在它指的地方。
//
// 走 shadcn 的 Select(本仓用的是 radix 那一版,和分支切换 / 模型选择同一套),
// 不用原生 <select>:原生的在 macOS 上弹系统菜单,和这一页的其它控件不是一个质感。

import { cn } from "@/lib/utils.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import type { SubagentScopeView } from "../lib/useSubagentScope.js";

/** 「用户」那一层在 store 里是 null;radix Select 的 value 不能是空串,这里用哨兵 */
const USER = "__user__";

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
    <Select
      value={scope.current.workspace ?? USER}
      onValueChange={(v) => void scope.setScope(v === USER ? null : v)}
    >
      <SelectTrigger
        id={id}
        size="sm"
        className={cn("w-fit min-w-32 max-w-60 bg-card text-[12.5px]", className)}
        title={scope.current.workspace ?? "所有工程都能用的那一层"}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {scope.options.map((o) => (
          <SelectItem key={o.workspace ?? USER} value={o.workspace ?? USER}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
