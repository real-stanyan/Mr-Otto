// 免审批开关 —— 审批模式的门面。原来是个两项下拉框（逐条审批 / 完全访问）。
//
// 换成开关的理由不是"好看"：审批模式**只有两态**，而下拉框是"从若干里挑一个"
// 的控件——它要点开才知道另一头是什么，也读不出哪一边是危险的那一边。
// 开关自己就把这两件事说清楚了：拨过去 = 打开了一个东西，一眼看得见开没开。
//
// 命名从「完全访问」改成「免审批」：前者说的是"agent 得到了什么"，
// 后者说的是"你放弃了什么"——放弃的那一头才是用户需要盯着的。
//
// 开着的时候整枚染警示色（连轨道一起），与折叠态那枚 ⋯ 钮同一套：
// 危险状态绝不能低调，它不是一个普通的偏好。

import type { ApprovalMode } from "../../../shared/shellBridge.js";
import { cn } from "../lib/utils.js";
import { Switch } from "./ui/switch.js";

const TITLE = "免审批：危险操作免问直批（批了什么照样落日志）。关掉 = 逐条问你";

/** 光秃秃那一枚。给已经自带标签的地方用（浮层里的 SettingRow） */
export function BypassSwitch({
  value,
  onChange,
  className,
}: {
  value: ApprovalMode;
  onChange: (mode: ApprovalMode) => void;
  className?: string;
}) {
  return (
    <Switch
      size="sm"
      checked={value === "auto"}
      onCheckedChange={(on) => onChange(on ? "auto" : "ask")}
      aria-label="免审批"
      title={TITLE}
      // 开 = 警示色,不是主色。主色的语义是"这是正常的那一档",而这一档不是
      className={cn("data-[state=checked]:bg-warn", className)}
    />
  );
}

/** 带字的一枚药丸,给控件行用。与旁边的型号/挡位钮同一套外形（圆角胶囊、悬停浮底色） */
export function BypassToggle({
  value,
  onChange,
  className,
}: {
  value: ApprovalMode;
  onChange: (mode: ApprovalMode) => void;
  className?: string;
}) {
  const on = value === "auto";
  return (
    <div
      title={TITLE}
      className={cn(
        "flex shrink-0 select-none items-center gap-[6px] rounded-full px-2 py-[3px] text-xs transition-colors duration-150",
        on ? "text-warn bg-warn/[0.12]" : "text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06]",
        className,
      )}
    >
      {/* 字也能点:开关本体只有 24px 宽,旁边就是它的名字,点名字却没反应会读成失灵。
          点击口留在字上而不是整块,免得点开关本体时两个 handler 各翻一次 = 原地不动 */}
      <span className="cursor-pointer" onClick={() => onChange(on ? "ask" : "auto")}>
        免审批
      </span>
      <BypassSwitch value={value} onChange={onChange} />
    </div>
  );
}
