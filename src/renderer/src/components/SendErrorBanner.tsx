// 「消息没发出去」提示条 —— IPC 层瞬时失败(会话不存在 / turn 撞上了 / 主进程
// 抛错),消息压根没进事件日志。与 turn_ended(error) 是两类失败:那一类发出去了、
// 死在半路,是日志里的事实,由 Timeline 渲染在消息流里;这一类不对应任何
// SessionEvent,只能直接订阅 store。
//
// 住在 App.tsx 的 footer 里(输入框正上方),而不是 Thread 的 ViewportFooter:
// 它报的是"你刚在这个框里敲的那条没发出去",是输入框的回执 —— 位置和宽度都该
// 跟着输入框走。挂在 Thread 里的时候它跟着正文那层走(还要让出滚动条的宽度),
// 于是永远比输入框窄一截、右边对不齐。
//
// 外观和重试出口交给 TurnErrorState(error-state element),与 Timeline 里
// turn_ended(error) 那条行同一个组件 —— 两类失败长相一致,差别只在标题。

import { TurnErrorState } from "./TurnErrorState.js";
import { useChat } from "../store.js";

export function SendErrorBanner() {
  const error = useChat((s) => s.error);
  if (!error) return null;
  // max-w-none:element 自带 max-w-sm(24rem),摞在输入框上方时比输入框窄一大截,
  // 看着像另一个悬浮层,而不是这个输入框自己的回执
  return (
    <TurnErrorState title="消息没发出去" detail={error} interactive className="mb-2 max-w-none" />
  );
}
