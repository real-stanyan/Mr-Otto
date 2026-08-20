// 中断提示条 —— 用 assistant-ui 的 stopped-run element。
//
// 替掉的是一枚居中的灰 chip「已中断」。换的理由和 TurnErrorState 一样:
// 「停了」和「怎么往下走」本来是一件事,只报状态不给出口,人得自己去输入框
// 重打一遍「继续」——那句话本来就是这枚钮该替他打的。
//
// 出口只有一个「继续」:它发的就是一条普通的用户消息(内容「继续」),
// 与手打完全等价,日志里也长得一模一样——不新造事件类型,不给模型看
// 一条它理解不了的东西。element 自带的 Discard 去掉了,理由见 stopped-run.tsx。

import { StoppedRun } from "@/components/elements/stopped-run.js";
import { useChat } from "../store.js";

/** 点了「继续」发出去的那句话。写在这里而不是散在 onClick 里:
    它是给模型看的内容,改措辞是改产品行为,得有个明确的出处 */
const CONTINUE_TEXT = "继续";

export function TurnStoppedState({
  interactive,
  className,
}: {
  /** 这一条是不是"当下这一条"。false = 历史里的旧中断:不给「继续」——
      那次中断之后用户早就又说过别的话了,从那里接着跑没有意义(同 TurnErrorState) */
  interactive: boolean;
  className?: string;
}) {
  const status = useChat((s) => s.statusBySession[s.sessionId] ?? "idle");
  const send = useChat((s) => s.send);
  // 已经有 turn 在跑的时候不给这个钮:再发一句「继续」只会排队,
  // 而人点的时候以为是"现在就接着跑"
  const canContinue = interactive && status !== "running";

  return (
    <StoppedRun
      reason="已中断"
      className={className}
      actions={
        canContinue ? (
          <button
            type="button"
            title="接着跑：发一条「继续」——和你自己打这两个字完全一样"
            onClick={() => void send(CONTINUE_TEXT)}
            className="ms-auto flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium text-foreground/70 transition-[background-color,color,scale] duration-150 hover:bg-foreground/[0.06] hover:text-foreground/95 active:scale-[0.96] motion-reduce:transition-none"
          >
            继续
          </button>
        ) : null
      }
    />
  );
}
