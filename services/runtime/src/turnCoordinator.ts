// 云 runtime 的 turn 协调器:@ 点名、串行队列(#928,原为 ADR-0199 的单 turn 互斥)
//
// 换掉而不是并列:onChat 那台状态机的生产调用方只有 sessionService.say() 一处,
// 而多智能体版把它整段重写了。两台状态机共用同一个 state 会互相踩。

export interface TurnJob {
  agentId: string;
  fromUid: string;
  label: string;
  text: string;
}

export type EnqueueDecision = "start_turn" | "queued" | "logged_only";

export interface TurnCoordinator {
  enqueue(job: TurnJob): EnqueueDecision;
  nextJob(): TurnJob | null;
  isRunning(): boolean;
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
  };
}
