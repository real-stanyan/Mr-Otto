// systemNote —— 护栏 / 后台任务回注的旁白判据（#936 / #957 C-I5）。
//
// 这两条都是 engine 自己往日志里注的 user_message（loop_guard 检测到
// 退化循环时提醒模型、background 是后台任务结果回注，见 events.ts
// UserMessageEvent.origin 的字段注释），不是人打的话。云时间线
// （lib/cloudTimeline.ts）与本机时间线（components/Timeline.tsx 的
// EventRow）在此之前各自按"这是一条普通 user_message"处理，前者画成
// 一条没有署名的群聊气泡（I5：读起来像"有个不知道是谁的人在教训水獭"），
// 后者画成一条本地 user 气泡——都在冒充"这是人说的话"。
//
// 抽成独立小文件而不是塞进 cloudTimeline.ts：本机投影（aui/toThreadMessages.ts）
// 是纯逻辑文件，故意只依赖 session/events + 同目录的 aui 小模块（不依赖
// WorkspaceSnapshot/agentNameOf 这套云会话专属基础设施），把判据单独摘出来
// 两边都能直接 import，不必为了一个布尔判断把云会话的名册解析也一起拖进来。
//
// 判据只看 origin 在场——不看 agentId：loop_guard 在本机单 agent会话里也
// 活着（护栏是 engine 级、无条件的，不是云会话专属），本机没有工作区/名册
// 概念，agentId 缺席是本机的常态，不能拿它当判据。

import type { SessionEvent, UserMessageEvent } from "../../../session/events.js";

export type SystemNoteEvent = UserMessageEvent & { origin: "background" | "loop_guard" };

/** 这条 user_message 是不是 engine 自己注的旁白，不是人打的话 */
export function isSystemNote(e: SessionEvent): e is SystemNoteEvent {
  return e.type === "user_message" && e.origin !== undefined;
}

/** 旁白正文。agent 名由调用方解析好传进来——云端有名册（agentNameOf）、
    本机没有工作区概念，永远传 null（同 assistantLabel 等函数的"查不到/
    没有名册就不装作答得出"纪律）。origin 在场是这个函数的前提，调用方须
    先过 isSystemNote 收窄类型 */
export function systemNoteBody(e: SystemNoteEvent, agentName: string | null): string {
  if (e.origin === "background") {
    // 后台任务回注（第四批 C2-I1）：原来这里是一句写死的「后台任务结果已回注」，
    // 把跑的是哪条命令、退出码多少、输出是什么全吞了——一条终端任务失败时，
    // 时间线上唯一的痕迹是一句「已回注」，用户得去后台面板另外找一遍。正文的
    // 形状由 main/backgroundTasks.ts 的 formatCompletion 定死：首行
    // `[后台任务 bg-N 完成] <cmd>`、第二行 `exit code: N`、其余是输出。
    // 摘要行只取前两行（首行 + 括号里的退出码），输出全文进 systemNoteDetail
    // 那条可展开的路——旁白是一行淡字，把几百行 stdout 摊在时间线上就不是旁白了。
    // 缺第二行（旧日志 / 形状变过）就只回首行，不装作解析出了退出码
    const lines = e.content.split("\n");
    const first = lines[0] ?? "";
    const second = lines[1];
    return second ? `${first}（${second}）` : first;
  }
  return `护栏：「${agentName ?? "某只智能体"}」在原地打转，已提醒`;
}

/** 旁白摊开之后的全文（第四批 C2-I1）：非 null = 调用方要画一个可展开的
    `<details>`，null = 这条旁白没有别的可看的、一行就是全部。
    background 回**原始正文**（不是重新拼的）——摘要那两行已经是它的投影，
    详情这一格再拼一遍就成了第二份会漂移的真相；loop_guard 的正文是注给
    模型看的那段提醒话术，摘要行「护栏：「X」在原地打转，已提醒」已经把它
    说完了，摊开只是把提示词泄给用户看，回 null。
    参数收宽到 `SessionEvent`（`systemNoteBody` 是收窄的 `SystemNoteEvent`）：
    两条时间线都是在 `isSystemNote` / `systemNoteText` 已经判过一次之后再取
    详情的，收窄会逼每个 call site 为了类型再套一层同样的判断——「不是旁白
    就没有详情」这句话本来就该由这一个函数回答 */
export function systemNoteDetail(e: SessionEvent): string | null {
  if (!isSystemNote(e)) return null;
  return e.origin === "background" ? e.content : null;
}
