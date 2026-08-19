// retryPlan 是纯函数判断(在 node 环境单测),碰不到副作用。这个函数会改 store 状态
// 它与 retryPlan 放一起会让测试连带求值整个 store 及其 localStorage 依赖(将来若加
// persist() 中间件或 eager 读 localStorage 就会报 ReferenceError)。分离到独立模块
// 避免 retry.test.ts 的 import 链路包含 store。

import type { UserMessageEvent } from "../../../session/events.js";
import { useChat } from "../store.js";
import type { RetryPlan } from "./retry.js";

// 两处重试 UI(动作条图标钮 / 错误行文字钮)外观不同,但"点了发生什么"是同一件事——
// 抽出来避免两处 onClick 逐字重复、将来改一处漏一处
export function retryLastUserMessage(prev: UserMessageEvent, plan: RetryPlan): void {
  if (plan.mode === "fill") {
    useChat.getState().injectComposer(prev.content, false);
    return;
  }
  void useChat.getState().send(prev.content);
}
