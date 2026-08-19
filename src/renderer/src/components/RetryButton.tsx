// turn 失败那行右侧的重试钮(assistant-ui 的 Error primitive 同款:失败不该只是
// 一行红字,恢复出口就挂在它旁边)。
//
// 为什么单独成文件:「[turn 失败]」在两处渲染,两处都要它——
// ① Timeline 的 turn_ended 事件(落了盘的失败,重开 app 还在)
// ② App 的瞬时 error state(IPC 层没把消息发出去,没进日志)
// 而 store 的 send() 刻意不让两者重复:turn 暴死已作为事件渲染时就不再叠瞬时 error。
// 所以用户实际看到的多半是 ①——只给 ② 挂钮等于这个功能对用户不存在。
//
// onClick 逻辑与 MessageActions 动作条共享(retryPlan/retryLastUserMessage),
// 这里只是换一副外观:红色文字钮。文案随 plan 变——不然点了以为发出去了,
// 实际只是填回输入框。

import { Button } from "@/components/ui/button.js";
import { lastUserMessage } from "../lib/lastUserMessage.js";
import { retryPlan } from "../lib/retry.js";
import { retryLastUserMessage } from "../lib/retryAction.js";
import { useChat } from "../store.js";

export function RetryButton() {
  const events = useChat((s) => s.events);
  const status = useChat((s) => s.statusBySession[s.sessionId] ?? "idle");
  const staged = useChat((s) => s.staged);
  const prev = lastUserMessage(events);
  const plan = retryPlan(prev, staged.length);
  // retryPlan(null, x) 返 null，其它情况返 RetryPlan，所以 !plan ⟺ !prev，前一行已排除
  if (!prev || status === "running") return null;
  // retryPlan(prev, x) 当 prev 非 null 时必然返 RetryPlan，所以 plan 必然非 null
  const planNonNull = plan!;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      title={
        planNonNull.mode === "resend"
          ? "重试：把上一条消息原样再发一遍"
          : planNonNull.reason === "attachments"
            ? "把上一条消息填回输入框（附件要重新添加）"
            : "输入框里有待发送的附件，先填回正文，你确认后再发"
      }
      className="h-auto px-2 py-[1px] text-[12px] text-err hover:bg-err/[0.12] hover:text-err shrink-0"
      onClick={() => retryLastUserMessage(prev, planNonNull)}
    >
      {planNonNull.mode === "resend" ? "重试" : "填回输入框"}
    </Button>
  );
}
