// Thinking 挡位下拉框 —— 选项跟着当前型号走。
//
// 以前这里是写死的两条"开/关"，不管选的是哪家的型号。可"开/关"只是 GLM 那一派的说法：
// GPT-5 只有低/中/高（关不掉），Grok 4 一直思考、压根没有请求级开关。写死两条的后果是
// UI 给出了型号并不存在的选择，而请求体里发出去的是对方不认的字段。
//
// 所以选项由 ModelChoice.thinking 给（shared/thinking.ts），这个组件只负责画。
// 没得选的型号照样出现在控件行上——灰着并说明为什么，比整个控件消失好：
// 控件忽然少一个，用户会以为界面坏了，而不是"这款没有这回事"。

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import {
  thinkingLabel,
  thinkingSwitchable,
  type ThinkingMode,
  type ThinkingSpec,
} from "../../../shared/thinking.js";

interface Props {
  spec: ThinkingSpec;
  value: ThinkingMode;
  onChange: (mode: ThinkingMode) => void;
  /** turn 进行中等外部原因（与"这型号没得选"是两回事，提示语也不同） */
  disabled?: boolean;
  className?: string;
}

/** 灰掉时给出的理由。两种"没得选"分开说——一种是型号一直在思考，
    一种是它根本不思考，对用户是完全不同的两件事 */
function whyFixed(spec: ThinkingSpec): string {
  if (spec.modes.length === 0) return "当前型号没有请求级 thinking 开关";
  return `当前型号的思考常开（${thinkingLabel(spec.modes[0]!)}），不可关闭`;
}

export function ThinkingPicker({ spec, value, onChange, disabled, className }: Props) {
  const switchable = thinkingSwitchable(spec);
  return (
    <Select
      value={switchable ? value : (spec.modes[0] ?? "")}
      onValueChange={(v) => onChange(v as ThinkingMode)}
      disabled={disabled || !switchable}
    >
      <SelectTrigger
        className={className}
        title={switchable ? "thinking：模型先推理再作答（更好也更贵）" : whyFixed(spec)}
      >
        {/* 没有任何档的型号连个占位值都没有，SelectValue 会是空的——给它一句话，
            空控件比灰控件更像故障 */}
        {spec.modes.length === 0 ? <span>无思考</span> : <SelectValue />}
      </SelectTrigger>
      <SelectContent>
        {spec.modes.map((m) => (
          <SelectItem key={m} value={m}>
            Thinking {thinkingLabel(m)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
