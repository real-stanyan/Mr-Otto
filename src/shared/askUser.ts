// ask_user 的共享世界 —— 纯类型，零运行时依赖，主进程/渲染进程/工具三边共 import。
// 与 shellBridge.ts 同一法理：形状定义放中间，两端各自实现。
//
// 为什么问卷不需要新事件类型：问题存在 assistant_message.toolCalls[].args 里，
// 答案存在 tool_result.output 里，两头本来就落盘、本来就进投影——
// 再加一个 question_asked 事件就是把同一件事记两遍（ADR-0018，先例见 ADR-0017）。

/** 一个选项。description 是选项底下那行小字（讲清代价/取舍），可省 */
export interface AskUserOption {
  label: string;
  description?: string;
}

/** 一道题。header 是卡片顶上的短标签（分类用，别写成一句话）；
    multiSelect = 可多选（互不排斥的选项），缺省单选 */
export interface AskUserQuestion {
  header: string;
  question: string;
  options: AskUserOption[];
  multiSelect?: boolean;
}

/** 主进程推给渲染层的一张问卷卡。toolCallId 是唤醒挂起 Promise 的钥匙 */
export interface AskUserRequest {
  sessionId: string;
  toolCallId: string;
  questions: AskUserQuestion[];
}

/** 一道题的作答。selected 空数组 = 跳过（用户明确表示"这题不答"）；
    custom = 用户自填的答案（"其他"），与 selected 可并存 */
export interface AskUserAnswer {
  header: string;
  selected: string[];
  custom?: string;
}

/** 作答结果。cancelled = 用户关了卡片 / turn 被中断，模型得知道没人回答，
    而不是收到一份空答卷误以为"用户全跳过了" */
export type AskUserOutcome =
  | { status: "answered"; answers: AskUserAnswer[] }
  | { status: "cancelled"; reason: string };

/** 问人的能力接口 —— 工具只认这个形状。
    GUI 实现 = 一次 UI 往返（UIQuestioner）；测试假人 = 直接返回脚本答案。
    signal：turn 被中断时必须让挂起的 ask 立即返回，否则管线卡死等一个不会来的人 */
export interface Asker {
  ask(request: Omit<AskUserRequest, "sessionId">, signal?: AbortSignal): Promise<AskUserOutcome>;
}
