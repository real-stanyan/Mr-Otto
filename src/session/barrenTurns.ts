// 哪些事件"什么也没产出",不该进模型上下文(ADR-0042)。
//
// 一个 turn 可能死在模型调用之前:429、断网、用户按了停止。这时日志里留下的是
//   user_message → turn_ended(error|aborted)
// 中间什么都没有 —— 模型压根没读到过这条消息,一个字也没回。可它照旧躺在投影里,
// 于是用户每重试一次,上下文就多囤一份同样的话(真实日志里出现过同一句 4 遍)。
//
// 这是**投影层**的规则,不是日志层的:那几条 user_message 是事实(用户确实按了
// 发送),日志一个字节不改,UI 照旧显示、回放照旧走它们 —— 只是不喂给模型。
//
// 判据保守:判不出来的一律留着。
//   · 中间出现过 assistant_message 或 tool_result → 这个 turn 产出过东西,留着
//   · turn_ended 是 completed → 留着(正常结束)
//   · turn_ended 是 interrupted → **留着**(见下)
//   · 后面根本没有 turn_ended(turn 还在跑 / 日志被截断)→ 留着,不猜
//
// interrupted 为什么在这一侧(#1260):#383 加它进来时,它只有一个来源——resume 时
// 给上一进程没收口的 turn 补的那条,语义是「崩在半路」。#1223 之后 loop 自己也会写
// 它(合盖睡眠 / 笔被别人拿走),而那两条路的语义是**「这条人话还没人答,接手的一方
// 会接着答」**(`lastUnanswered` 就是这么判的,#1253 的云端执行器也照这条契约:拿到笔
// 先补 interrupted 收口再接着答)。两条规则撞在一起时,接手的那一方起 turn 时
// **模型看不见那句话**——它在这里被当成空跑剔掉了,于是对着更早的一句话作答,
// 不崩不报错。所以 interrupted 归「还没答」,不归「作废」。
// error / aborted 照旧(429、断网、人按了停止——ADR-0042 原本的那三种)。
// 代价:崩在模型开口前、人自己重打一遍的那种,上下文里会多一份同样的话(#383
// 顺带拿到的那点好处没了)。对应地,任务会话的崩溃修尾不再给「尾巴只有人话」
// 补 interrupted(src/main/agent.ts),因为那不是一次崩溃,是一句还没人答的话。

import type { SessionEvent } from "./events.js";

/** 返回**要跳过**的事件下标。跳的是 user_message,以及紧挨在它前面、专为它生成的
    image_described(那句话的原文是"以下是**随后**消息附带图片的解析",
    随后的消息没了,它就是一句悬空的话) */
export function barrenEventIndexes(events: readonly SessionEvent[]): Set<number> {
  const skip = new Set<number>();

  for (let i = 0; i < events.length; i++) {
    if (events[i]?.type !== "user_message") continue;

    let barren: boolean | null = null; // null = 还没判出来
    for (let j = i + 1; j < events.length; j++) {
      const e = events[j]!;
      if (e.type === "assistant_message" || e.type === "tool_result") {
        barren = false;
        break;
      }
      if (e.type === "turn_ended") {
        // interrupted = 「还没人答」不是「作废」(#1260,见文件头注)
        barren = e.outcome !== "completed" && e.outcome !== "interrupted";
        break;
      }
      // 下一条用户消息之前都没见到 turn_ended:上一个 turn 的收口没落盘
      // (旧日志 / 崩溃)。判不出来 → 留着
      if (e.type === "user_message") break;
    }

    if (barren !== true) continue;
    skip.add(i);
    if (events[i - 1]?.type === "image_described") skip.add(i - 1);
  }

  return skip;
}
