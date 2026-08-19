// 把 Zustand 里的会话状态接到 assistant-ui 的 runtime 上。
// 只做订阅和转交:所有判断都在 buildOttoAdapter / toThreadMessages 那两个纯函数里

import { useExternalStoreRuntime } from "@assistant-ui/react";
import { useChat } from "../store.js";
import { buildOttoAdapter } from "./ottoAdapter.js";
import { lastUserMessage } from "../lib/lastUserMessage.js";
import { retryPlan } from "../lib/retry.js";
import { retryLastUserMessage } from "../lib/retryAction.js";

export function useOttoRuntime() {
  const sessionId = useChat((s) => s.sessionId);
  const events = useChat((s) => s.events);
  const live = useChat((s) => s.streamingBySession[s.sessionId]);
  const status = useChat((s) => s.statusBySession[s.sessionId]);
  const staged = useChat((s) => s.staged);

  // 动作从 store 上直接取(它们是稳定引用,不进依赖数组)
  const send = useChat((s) => s.send);
  const cancel = useChat((s) => s.stop);

  void sessionId; // 换会话时 events/live 自然变,这里只是让意图显式

  // retry:找「上一条用户消息」,决定重发还是填回输入框(见 lib/retry.ts)。
  // 没有可重试的消息(prev 为空)就什么都不做——onReload 的入口不像 RetryButton
  // 那样能先判断"要不要渲染这颗按钮",只能在点击时自己兜底
  const retry = (): void => {
    const prev = lastUserMessage(events);
    const plan = retryPlan(prev, staged.length);
    if (!prev || !plan) return;
    retryLastUserMessage(prev, plan);
  };

  return useExternalStoreRuntime(
    buildOttoAdapter({ events, live, isRunning: status === "running", send, cancel, retry })
  );
}
