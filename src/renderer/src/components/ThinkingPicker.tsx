// Thinking 挡位选择器 —— 一枚独立的浮窗钮,用 assistant-ui 的 reasoning-effort。
//
// 为什么单独拉出来:挡位曾经挂在型号浮层底部(ModelSelector.Effort),那一排随
// "型号浮层只回答用哪个型号"一起被拿掉了,结果是**没有任何界面能改它** ——
// 触发器上还显示着当前档,但那只是显示。
//
// 为什么是浮窗而不是常显的一排:挡位有四档(off/low/medium/high),摊在控件行上
// 要占一条 pill 组的宽度,而它是"设一次就不动"的会话偏好,不是每条消息都碰的东西。
// 收进浮窗 = 面上只留当前档(一眼可见),要改再点开。
//
// 挡位是**型号的属性**(shared/thinking.ts 的开篇就在讲这件事):可选档来自
// 当前型号的 spec,只有一档或零档的型号整个不出现 —— 一个只有一个选项的
// 选择器是在假装用户有得选。

import { Brain } from "lucide-react";
import { useState } from "react";
import { ReasoningEffort } from "@/components/elements/reasoning-effort.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { cn } from "@/lib/utils.js";
import {
  thinkingLabel,
  thinkingSwitchable,
  type ThinkingMode,
  type ThinkingSpec,
} from "../../../shared/thinking.js";

export function ThinkingPicker({
  spec,
  value,
  onChange,
  disabled = false,
  className,
}: {
  /** 当前型号的挡位表 */
  spec: ThinkingSpec;
  value: ThinkingMode;
  onChange: (mode: ThinkingMode) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // 换不了就不画:关不掉思考的型号(GPT-5/Gemini 2.5 Pro 那一类)、
  // 以及压根没有请求级开关的型号,都在这一条里被挡住
  if (!thinkingSwitchable(spec)) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        title={`Thinking：${thinkingLabel(value)}（点开换挡）`}
        className={cn(
          // 与旁边的型号触发器同一套:整块可点、按压回弹、悬停才浮出底色
          "press-scale text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground data-[state=open]:text-foreground flex h-auto shrink-0 items-center gap-1 rounded-full px-2 py-[3px] text-xs transition-colors duration-150 disabled:opacity-40",
          className,
        )}
      >
        <Brain className="size-3" aria-hidden />
        {thinkingLabel(value)}
      </PopoverTrigger>
      {/* 从触发器底边长出来(origin-aware,ADR-0010 的惯例);
          w-auto:分段控件自己就那么宽,浮层不该比它宽出一圈空白 */}
      <PopoverContent align="end" side="top" sideOffset={8} className="w-auto p-3">
        <ReasoningEffort
          label="Thinking"
          levels={spec.modes.map((m) => ({ key: m, label: thinkingLabel(m) }))}
          selectedKey={value}
          onSelect={(key) => {
            onChange(key as ThinkingMode);
            setOpen(false);
          }}
          className="w-[184px] max-w-none"
        />
      </PopoverContent>
    </Popover>
  );
}
