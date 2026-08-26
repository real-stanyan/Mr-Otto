// 设置页 / 面板骨架:所有顶栏、正文容器、栏目导航共用的那几个类名和 SettingsTitle。
//
// 单独成模块而不是留在 App.tsx 里(issue #141):十来个组件要用它们,而 App.tsx
// 又要 import 那十来个组件——从 App.tsx 导出等于全仓循环 import。能跑(只在组件体内
// 用),但 timelineStyles.ts 早就立了正确的先例:共用的样式常量住自己的模块。

import { BadgeInfo, BookMarked, Bot, Brain, KeyRound, Palette, Plug, ShieldCheck, Shrink, Smartphone, UserRound, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils.js";
import type { SettingsSection } from "./store.js";

/* 设置页骨架(账号/模型配置/Skill 库/Subagent 共用) */
export const MAIN_COL = "flex-1 min-w-0 flex h-full flex-col";

/* h-11 是所有顶栏的公约数:会话区这条和右侧工具面板(终端/浏览器/Protocol/Git Graph)
   的顶栏并排,高度不一样的话分割线在中间错一截。写死高度而不是靠 padding + 内容
   撑,两边内容不一样高也对得齐 */
export const HEADER_H = "h-11";
export const HEADER = `flex ${HEADER_H} items-center gap-3 px-5 border-b border-border drag-region`;
export const HEADER_GHOST = "shrink-0 text-xs text-muted-foreground hover:text-foreground";
/* 内容铺满主区宽度,只靠两侧内边距留呼吸:居中定宽那版在宽窗口里两边空一大片,
   列表本身又是整行可点的卡,宽一点反而更像"一页设置"而不是一张浮在中间的表单 */
export const SETTINGS_BODY =
  "flex-1 overflow-y-auto scrollbar-stable px-8 py-6 flex flex-col gap-4 w-full";
export const HINT = "text-muted-foreground text-[13px]";

/** 设置栏目导航项：id 对应 store 的 settingsSection，label 是侧栏显示文案 */
export const SETTINGS_SECTIONS: { id: SettingsSection; label: string; icon: LucideIcon }[] = [
  { id: "account", label: "账号", icon: UserRound },
  { id: "keys", label: "模型配置", icon: KeyRound },
  { id: "appearance", label: "外观", icon: Palette },
  { id: "skills", label: "Skill 库", icon: BookMarked },
  { id: "agents", label: "子智能体", icon: Bot },
  { id: "mcp", label: "MCP", icon: Plug },
  { id: "permissions", label: "权限", icon: ShieldCheck },
  { id: "memory", label: "记忆", icon: Brain },
  { id: "context", label: "上下文", icon: Shrink },
  { id: "remote", label: "手机", icon: Smartphone },
  { id: "about", label: "关于与更新", icon: BadgeInfo },
];

/** 设置页 header 的标题:和侧栏导航同一个图标 + 同一个文案,一处定义(SETTINGS_SECTIONS)。
    面包屑页(新建/编辑子智能体)把它当第一级用 */
export function SettingsTitle({ id, className }: { id: SettingsSection; className?: string }) {
  const sec = SETTINGS_SECTIONS.find((s) => s.id === id)!;
  return (
    <span className={cn("font-[650] inline-flex items-center gap-[6px]", className)}>
      <sec.icon className="size-4 text-muted-foreground" />
      {sec.label}
    </span>
  );
}
