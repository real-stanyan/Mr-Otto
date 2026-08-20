// 失败提示条 —— 换成 assistant-ui 的 error-state element(components/elements/error-state.tsx)。
//
// 替掉的是原来那枚红边 chip + 旁边一枚 RetryButton 的组合(RetryButton.tsx 已随之删除,
// 它的两个调用点就是下面这两处)。换的理由不是外观:失败和它的出口本来就是**一件事**,
// 拆成"一行红字"和"一枚钮"之后,两边各判一次"现在能不能重试",判据还不一样。
// element 把它们收进一个组件,这里只回答一次那个判断。
//
// 本仓要的三处语义,element 的 props 都留了口(见 error-state.tsx 里的"本仓改动"):
// ① 出口可能不存在(历史里的旧失败行 / turn 正在跑)—— 没有出口就不长钮
// ② 出口有两档(lib/retry.ts):原样重发 / 只把正文填回输入框(原消息带附件时),
//    钮的文案得跟着变,否则点了以为发出去了
// ③ retrying 那一档只属于"当下这一条":历史行不该因为现在有个 turn 在跑就变成转圈

import { ErrorState } from "@/components/elements/error-state.js";
import { lastUserMessage } from "../lib/lastUserMessage.js";
import { retryPlan } from "../lib/retry.js";
import { retryLastUserMessage } from "../lib/retryAction.js";
import { useChat } from "../store.js";

export function TurnErrorState({
  title,
  detail,
  interactive,
  className,
}: {
  title: string;
  detail: string;
  /** 这一条是不是"当下这一条"。false = 历史里的旧失败:不挂重试、也不转圈 ——
      重试重发的是「上一条用户消息」,而那条旧失败之后用户早就又说过别的话了,
      点它会重发一句不相干的 */
  interactive: boolean;
  className?: string;
}) {
  const events = useChat((s) => s.events);
  const status = useChat((s) => s.statusBySession[s.sessionId] ?? "idle");
  const staged = useChat((s) => s.staged);

  const prev = lastUserMessage(events);
  // retryPlan(null, x) 返 null;prev 非 null 时必然返 RetryPlan
  const plan = prev ? retryPlan(prev, staged.length) : null;
  const retrying = interactive && status === "running";
  const canRetry = interactive && !retrying && prev !== null && plan !== null;

  return (
    <ErrorState
      title={title}
      detail={detail}
      retrying={retrying}
      {...(canRetry
        ? {
            onRetry: () => retryLastUserMessage(prev!, plan!),
            retryLabel: plan!.mode === "resend" ? "重试" : "填回输入框",
            retryTitle:
              plan!.mode === "resend"
                ? "重试：把上一条消息原样再发一遍"
                : plan!.reason === "attachments"
                  ? "把上一条消息填回输入框（附件要重新添加）"
                  : "输入框里有待发送的附件，先填回正文，你确认后再发",
          }
        : {})}
      {...(className !== undefined ? { className } : {})}
    />
  );
}
