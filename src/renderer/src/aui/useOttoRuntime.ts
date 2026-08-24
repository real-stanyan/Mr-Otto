// 把 Zustand 里的会话状态接到 assistant-ui 的 runtime 上。
// 只做订阅和转交:所有判断都在 buildOttoAdapter / toThreadMessages 那两个纯函数里

import { useMemo } from "react";
import { useExternalStoreRuntime } from "@assistant-ui/react";
import { useChat } from "../store.js";
import { buildOttoAdapter } from "./ottoAdapter.js";
import { retryLatest } from "../lib/retryAction.js";

export function useOttoRuntime() {
  const sessionId = useChat((s) => s.sessionId);
  const events = useChat((s) => s.events);
  const live = useChat((s) => s.streamingBySession[s.sessionId]);
  const status = useChat((s) => s.statusBySession[s.sessionId]);

  // 动作从 store 上直接取(它们是稳定引用,不进依赖数组)
  const send = useChat((s) => s.send);
  const cancel = useChat((s) => s.stop);

  void sessionId; // 换会话时 events/live 自然变,这里只是让意图显式

  // retry:找「上一条用户消息」,决定重发还是填回输入框(见 lib/retry.ts)。
  // 动作条上的"换模型重新生成"走的是同一个动作(见 aui/OttoThread.tsx)
  const retry = retryLatest;

  // memo 在真正的输入上:buildOttoAdapter 里的 toThreadMessages 是全量投影
  // (走一遍所有事件、每条消息新建对象),不 memo 的话与本 hook 无关的任何
  // 重渲染都要把整份转录重投影一遍。retry 是模块常量,不进依赖
  const adapter = useMemo(
    () => buildOttoAdapter({ events, live, isRunning: status === "running", send, cancel, retry }),
    [events, live, status, send, cancel]
  );
  return useExternalStoreRuntime(adapter);
}
