// 桌面 → 手机的时间线投影。**和 trim.ts 并列的第二处"什么东西离开这台机器"的收口**:
// fleet 那条走 trimForMobile,会话正文走这里。
//
// 三条设计约束,都不是随手定的:
//
// 1. **只认三种事件。** user_message / assistant_message / tool_result。
//    日志里另外二十多种(model_changed、approval_decision、turn_diff…)一律不出机器
//    —— 手机端的职责是"看 + 审批"(ADR-0094),不是第二个完整的会话视图。
//    加字段的人必须来这里显式决定它该不该发,这就是这个函数存在的意义。
// 2. **reasoning 一个字都不发。** 它是模型的思考过程,信息量最大、最不该跨公网,
//    而且手机上根本没地方显示。assistant 只出 content。
// 3. **截断在这一侧做,不在 UI 做。** 一条 bash 的 stdout 能有几百 KB;
//    发出去再让手机截,等于白付了加密和流量。truncated 标记跟着帧走,
//    UI 拿它显示"在电脑上看全文"。
//
// 纯文件:不许 import node builtin / electron(手机端 import 同一份)。
// SessionEvent 只做类型导入 —— 编译后擦除,不进手机端的包。

import type { SessionEvent } from "../../session/events.js";
import type { MobileMessage } from "./frames.js";

export interface TimelineLimits {
  /** 最多几条。留最后 N 条 —— 手机上没人往上翻两千条 */
  maxMessages?: number;
  /** 用户/助手正文的字符上限 */
  maxChars?: number;
  /** 工具输出的字符上限。压得比正文狠得多:它最长、最不适合在手机上读 */
  maxToolChars?: number;
}

const DEFAULTS = { maxMessages: 80, maxChars: 2_000, maxToolChars: 400 } as const;

export function projectTimelineForMobile(
  events: readonly SessionEvent[],
  limits: TimelineLimits = {},
): MobileMessage[] {
  const maxMessages = limits.maxMessages ?? DEFAULTS.maxMessages;
  const maxChars = limits.maxChars ?? DEFAULTS.maxChars;
  const maxToolChars = limits.maxToolChars ?? DEFAULTS.maxToolChars;

  // 工具名不在 tool_result 上,在发起它的那条 assistant 的 toolCalls 里。
  // 先扫一遍建索引 —— 没有名字的话手机上是一堆无主的输出
  const toolNames = new Map<string, string>();
  for (const e of events) {
    if (e.type !== "assistant_message") continue;
    for (const call of e.toolCalls ?? []) toolNames.set(call.id, call.name);
  }

  const out: MobileMessage[] = [];
  for (const e of events) {
    switch (e.type) {
      case "user_message":
        push(out, "user", e.content, maxChars);
        break;
      case "assistant_message":
        // 纯工具调用那条 content 是空串:不发一条空气泡,工具结果自己会出现
        push(out, "assistant", e.content, maxChars);
        break;
      case "tool_result": {
        const name = toolNames.get(e.toolCallId) ?? "工具";
        // 状态进正文而不是另加字段:MobileMessage 的形状是协议的一部分,
        // 为一个前缀改线格式不值当
        const head = e.status === "ok" ? name : `${name}(${e.status})`;
        push(out, "tool", `${head}\n${e.output}`, maxToolChars);
        break;
      }
      default:
        // 其余事件一律不出机器 —— 见文件头第 1 条
        break;
    }
  }
  return out.length > maxMessages ? out.slice(-maxMessages) : out;
}

function push(out: MobileMessage[], role: MobileMessage["role"], text: string, cap: number): void {
  const t = text.trim();
  if (!t) return;
  if (t.length <= cap) return void out.push({ role, text: t });
  out.push({ role, text: t.slice(0, cap), truncated: true });
}

/* ── 渲染前的一次归并 ───────────────────────────────────
   桌面那侧连着几次工具调用只显示一行 `2 tool calls ›`,展开才看内容。
   手机上更需要这个:一次 bash 的输出能把整屏占满,而人翻这一屏是为了看
   模型说了什么。**连续的工具消息并成一组,默认收起。** */

/** 时间线渲染的一项:要么是一条普通消息,要么是一组折叠起来的工具调用 */
export type TimelineItem =
  | { kind: "message"; message: MobileMessage; index: number }
  | { kind: "tools"; tools: MobileMessage[]; index: number };

export function groupTimeline(messages: readonly MobileMessage[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (const [index, message] of messages.entries()) {
    const last = out[out.length - 1];
    if (message.role === "tool") {
      // 只并**相邻**的:中间夹一句助手正文就是两次独立的动作,并了会看不出顺序
      if (last?.kind === "tools") last.tools.push(message);
      else out.push({ kind: "tools", tools: [message], index });
    } else {
      out.push({ kind: "message", message, index });
    }
  }
  return out;
}

/** 工具消息的第一行是工具名(投影时拼上去的),正文从第二行起 */
export function splitTool(m: MobileMessage): { name: string; output: string } {
  const i = m.text.indexOf("\n");
  return i < 0
    ? { name: m.text, output: "" }
    : { name: m.text.slice(0, i), output: m.text.slice(i + 1) };
}
