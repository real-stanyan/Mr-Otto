// workspaceLock —— 同一个团队的容器同一时刻只让一条会话动手（#979 第 2 条，ADR-0232）。
//
// 为什么需要：每个团队**一容器一卷**（ADR-0199 / sandbox.ts），而一个团队可以开
// 多条会话，每条会话各自 `drain`。两条会话里的 agent 于是可以同时在 `/work` 里
// `cat > 同一个文件`、一边 `git checkout` 一边改文件——桌面那套 workspaceExclusion
// （ADR-0152）/ coworkLog（ADR-0161）在 services/runtime 里一处都没接，云端此前是零互斥。
//
// 与桌面的差别（故意的）：桌面**拒绝**第二条 turn（「只拒绝，不做魔法」，判据是
// engine.runningTurnId，没有要 release 的锁）；云端**排队等**。两点理由：
//   ① 云端所有会话都在同一个 daemon 进程里，一把带 release 的锁不存在「忘记解锁」
//      之外的失败模式（进程死了锁跟着死），try/finally 就够；
//   ② 云会话的 turn 是排队制的（turnCoordinator），「排队中」这盏灯本来就在——
//      被拒绝反而要用户把话再发一遍，而这句话早已落盘、openTurns 欠着它一个回答。
// 锁的粒度是**会话**不是 agent：同一条会话内 drain 本来就串行，不需要更细。
//
// 拿锁的时机在 sessionService：**第一次碰容器才拿**（read_file / write_file / bash），
// 只聊天不动手的 turn 一次都不排队；这一轮收口才放。等待可被中断（signal）：人按了
// 停止不该等到别人做完才生效。**不可重入**——同一个 owner 拿两次会死等，调用方
// 自己保证一轮只拿一次（sessionService 用 heldRelease 守着）。

export interface WorkspaceLock {
  /** 拿锁；已被占则 FIFO 排队。`signal` 在等待期间 abort → reject 且从队列里摘掉。
      返回的函数是放锁，幂等 */
  acquire(owner: string, signal?: AbortSignal): Promise<() => void>;
  /** 此刻谁拿着（null = 空闲） */
  holder(): string | null;
  /** 排队中的人数（给日志 / 测试看） */
  waiting(): number;
}

/** 等锁时被中断。措辞对齐 dockerWorld 的 abortedError：中断永远是外力 */
export function lockAbortedError(): Error {
  return new Error("等容器时被中断：用户停止了 turn");
}

/** 排队时在群里说的那句话（chat_message，system 署名，模型可见——正在等的那只自己
    读得到，知道自己为什么慢） */
export const CONTAINER_BUSY_TEXT =
  "这个团队的容器正被另一条会话占着（每个团队只有一个容器），这一轮的工具调用排队等它那一轮做完";

interface Waiter {
  owner: string;
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export function createWorkspaceLock(): WorkspaceLock {
  let holder: string | null = null;
  const queue: Waiter[] = [];

  function grant(owner: string): () => void {
    holder = owner;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holder = null;
      const next = queue.shift();
      if (next) {
        if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
        next.resolve(grant(next.owner));
      }
    };
  }

  return {
    acquire(owner, signal) {
      if (signal?.aborted) return Promise.reject(lockAbortedError());
      // holder 为 null 时队列必空（放锁那一刻就把下一位提上来了），直接给
      if (holder === null) return Promise.resolve(grant(owner));
      return new Promise<() => void>((resolve, reject) => {
        const entry: Waiter = { owner, resolve, reject, ...(signal ? { signal } : {}) };
        if (signal) {
          entry.onAbort = () => {
            const i = queue.indexOf(entry);
            if (i >= 0) queue.splice(i, 1);
            reject(lockAbortedError());
          };
          signal.addEventListener("abort", entry.onAbort, { once: true });
        }
        queue.push(entry);
      });
    },
    holder: () => holder,
    waiting: () => queue.length,
  };
}

/** daemon 持有的那张表：workspaceId → 锁。按需建、不回收（一个团队一把、
    几十字节，daemon 生命周期内活跃过的团队数量有限） */
export function createWorkspaceLocks(): { for(workspaceId: string): WorkspaceLock } {
  const locks = new Map<string, WorkspaceLock>();
  return {
    for(workspaceId) {
      let lock = locks.get(workspaceId);
      if (!lock) {
        lock = createWorkspaceLock();
        locks.set(workspaceId, lock);
      }
      return lock;
    },
  };
}
