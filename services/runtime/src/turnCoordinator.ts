// 云 runtime 的 turn 协调器:@ 点名、串行队列(#928,原为 ADR-0199 的单 turn 互斥)
//
// 换掉而不是并列:onChat 那台状态机的生产调用方只有 sessionService.say() 一处,
// 而多智能体版把它整段重写了。两台状态机共用同一个 state 会互相踩。

import type { UserMessageEvent } from "../../../src/session/events.js";

export interface TurnJob {
  agentId: string;
  fromUid: string;
  /** 开场那条 user_message（say() 已经落盘、带 seq）。runJob 直接拿它起 turn，
      不再自己拼 `[label]: text`——那句话只存在于日志里一处（#932 坑 ②） */
  opening: UserMessageEvent;
}

export type EnqueueDecision = "start_turn" | "queued" | "logged_only";

export interface TurnCoordinator {
  enqueue(job: TurnJob): EnqueueDecision;
  nextJob(): TurnJob | null;
  isRunning(): boolean;
  /** 还排着队的每个 job 的开场白 seq，入队顺序（#1280）。尾巴分页拿它当第一页的
      下界：这几条开场白还没人答，它们落在尾巴外面时「排队中」那一行就画不出来，
      而且不报错。空队列回空数组——调用方拿它去算 `Math.min`，undefined 会把下界
      变成 NaN */
  pendingOpeningSeqs(): number[];
}

export function createTurnCoordinator(): TurnCoordinator {
  const queue: TurnJob[] = [];
  let running = false;

  return {
    enqueue(job: TurnJob): EnqueueDecision {
      // 没点名任何人:只落 chat_message,靠 engine 每轮从日志重新投影天然生效
      //(ADR-0199 的既有语义,不变)
      if (!job.agentId) return "logged_only";
      // 同一只已经在队里就不重复排。连点三下 @运营 不该跑三遍 —— 它这一轮
      // 开跑时读的是整份日志,三句话都在里面
      if (queue.some((q) => q.agentId === job.agentId)) return "logged_only";
      queue.push(job);
      // **回 start_turn 时任务也已经在队里**:调用方开始 while (nextJob()) 排空,
      // 不是拿着手上这个 job 去跑。两种写法差一个 job,而那正是最容易错的地方
      if (running) return "queued";
      running = true;
      return "start_turn";
    },

    nextJob(): TurnJob | null {
      const next = queue.shift() ?? null;
      if (!next) running = false;
      return next;
    },

    isRunning(): boolean {
      return running;
    },

    pendingOpeningSeqs(): number[] {
      return queue.map((q) => q.opening.seq);
    },
  };
}
