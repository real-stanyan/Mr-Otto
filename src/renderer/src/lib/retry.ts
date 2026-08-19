// 重试能不能一键发出去,要看两件互不相干的事——只查其中一件会漏掉另一半 bug:
// ① 被重试的消息自己带没带附件(附件本体在附件库,一键重发做不到,要新增 bridge 方法)
// ② 此刻输入框暂存区里是否已经有待发的附件——send() 在调用那一刻读 get().staged,
//    跟被重试的那条消息毫无关系。原消息没附件也可能重发出错的东西:
//    用户刚粘了张图准备问别的,这时点"重试"会把那张图静默塞进重发的消息里,
//    "原样再发一遍"就成了假话。两条原因都判成"填回输入框"而不是直接发送;
//    消息自身的附件优先报告(reason: "attachments"),因为它是更根本的原因——
//    暂存区可以让用户自己清或确认,消息里的附件没法凭空重新读出来发送

import type { UserMessageEvent } from "../../../session/events.js";

export type RetryPlan =
  | { mode: "resend" }
  | { mode: "fill"; reason: "attachments" | "staged" };

/** prev = 上一条用户消息(null = 压根没有可重试的);stagedCount = 此刻输入框暂存区的附件数 */
export function retryPlan(prev: UserMessageEvent | null, stagedCount: number): RetryPlan | null {
  if (!prev) return null;
  const hasAttachments = (prev.attachments?.length ?? 0) > 0 || (prev.textFiles?.length ?? 0) > 0;
  if (hasAttachments) return { mode: "fill", reason: "attachments" };
  if (stagedCount > 0) return { mode: "fill", reason: "staged" };
  return { mode: "resend" };
}
