// terminalHub —— 主进程的 pty 注册表。
//
// 为什么缓冲在这儿而不在渲染层:产品前提是"关面板不杀进程"。面板一关,
// 渲染层的 xterm 实例就没了,而 pty 还在吐输出——得有人接住,重开面板时
// 一次性灌回去,用户看到的才是连续的。放渲染层等于没放。
//
// 终端输出不进事件日志、不进模型上下文(ADR-0031):它不是某个事实的投影,
// 是人的旁路工具。日志推不出它,也不需要推出它。

import { randomUUID } from "node:crypto";
import type { OpenTerminalOptions, TerminalSession } from "../world/executionWorld.js";

/** 渲染层看得见的终端形态(标签行用) */
export interface TerminalInfo {
  id: string;
  title: string;
  /** 进程已经退了。标签还留着——遗言得让人看得见,是用户点 × 才消失 */
  exited: boolean;
}

export interface TerminalHubDeps {
  /** 由 index.ts 注入,内部路由到该会话 agent 的 ExecutionWorld(ADR-0031 §1)——
      不是自己另起一个 LocalWorld:v2 里 agent 的 world 换成 SandboxWorld,
      终端才会自动跟着开进那个 bot 的容器,而不是宿主机。sessionId 就是给这层路由用的。
      注入而非直接 import:测试要能塞假 pty,v2 要能换成容器世界 */
  openTerminal(sessionId: string, workspace: string, opts: OpenTerminalOptions): Promise<TerminalSession>;
  push: {
    data(id: string, data: string): void;
    exit(id: string, exitCode: number): void;
  };
  /** 每会话标签上限,防手滑刷出一堆 shell。缺省 8 */
  maxPerSession?: number;
  /** 每终端回滚缓冲字节数,缺省 200 KB */
  bufferBytes?: number;
}

interface TerminalRecord {
  id: string;
  sessionId: string;
  title: string;
  session: TerminalSession;
  chunks: string[];
  size: number;
  exited: boolean;
  /** 退订函数,close 时解掉——pty 死了还挂着监听器就是泄漏 */
  offs: Array<() => void>;
}

export function createTerminalHub(deps: TerminalHubDeps) {
  const maxPerSession = deps.maxPerSession ?? 8;
  const bufferBytes = deps.bufferBytes ?? 200_000;
  const terms = new Map<string, TerminalRecord>();

  // open() 里 await deps.openTerminal(...) 之前的这一段必须留出座位/号牌,
  // 否则两个并发 open() 会在都还没落地时读到同一个"当前数量",
  // 上限检查和标题编号都会被绕过(见 issue 复核)。
  //
  // pending: 会话名下"已经通过上限检查、但 pty 还没建好"的座位数——
  // 上限检查 = 已落地的 + 还占着座的,不是只看已落地的。
  const pending = new Map<string, number>();
  // seq: 会话名下发出去过的题号最大值,只增不减——close 掉的题号不回收,
  // 不然重开一个新终端会撞上还活着的那个,人从标签上分不清谁是谁。
  const seq = new Map<string, number>();

  const ofSession = (sessionId: string) =>
    [...terms.values()].filter((t) => t.sessionId === sessionId);

  const seatsUsed = (sessionId: string) =>
    ofSession(sessionId).length + (pending.get(sessionId) ?? 0);

  /** 环形缓冲:整段整段地丢最老的,丢到总量落回上限内。
      chunk 数量降到只剩一段之后,那一段自己就可能比上限还大
      (比如一次性吐出一大坨),所以还要在字符级别把它裁到位 */
  const remember = (rec: TerminalRecord, data: string) => {
    rec.chunks.push(data);
    rec.size += data.length;
    while (rec.size > bufferBytes && rec.chunks.length > 1) {
      rec.size -= rec.chunks.shift()!.length;
    }
    if (rec.size > bufferBytes) {
      const only = rec.chunks[0]!.slice(rec.size - bufferBytes);
      rec.chunks = [only];
      rec.size = only.length;
    }
  };

  const drop = (rec: TerminalRecord) => {
    for (const off of rec.offs) off();
    rec.offs = [];
    rec.session.kill();
    terms.delete(rec.id);
  };

  return {
    async open(sessionId: string, workspace: string, cols: number, rows: number) {
      // 上限检查 + 占座必须在 await 之前同步做完:两次并发 open() 调用,
      // 第一次的这段同步代码会跑到 await 才让出控制权,第二次调用
      // 这时候看到的是"已经占了座"之后的数字,才挡得住绕过上限
      if (seatsUsed(sessionId) >= maxPerSession) {
        throw new Error(`一个会话最多开 ${maxPerSession} 个终端,先关掉一个再开`);
      }
      pending.set(sessionId, (pending.get(sessionId) ?? 0) + 1);
      const num = (seq.get(sessionId) ?? 0) + 1;
      seq.set(sessionId, num);

      const id = randomUUID();
      let session: TerminalSession;
      try {
        session = await deps.openTerminal(sessionId, workspace, { cols, rows });
      } catch (err) {
        // 开失败了,占的座得还回去——不然一次失败的 open 永久吃掉一个名额
        pending.set(sessionId, (pending.get(sessionId) ?? 1) - 1);
        throw err;
      }
      pending.set(sessionId, (pending.get(sessionId) ?? 1) - 1);

      const rec: TerminalRecord = {
        id,
        sessionId,
        title: `终端 ${num}`,
        session,
        chunks: [],
        size: 0,
        exited: false,
        offs: [],
      };
      rec.offs.push(
        session.onData((d) => {
          remember(rec, d);
          deps.push.data(id, d);
        }),
        session.onExit((code) => {
          rec.exited = true;
          deps.push.exit(id, code);
        })
      );
      terms.set(id, rec);
      return { id, snapshot: "" };
    },

    attach(id: string) {
      const rec = terms.get(id);
      if (!rec) throw new Error("终端不存在(可能已经关掉了)");
      return { snapshot: rec.chunks.join("") };
    },

    list(sessionId: string): TerminalInfo[] {
      return ofSession(sessionId).map((t) => ({ id: t.id, title: t.title, exited: t.exited }));
    },

    // 下面三个对未知 id 静默无视:渲染层的键盘事件和 resize 可能比
    // "终端已经关了"这个消息跑得快,为一次竞态抛错没有意义
    input(id: string, data: string) {
      terms.get(id)?.session.write(data);
    },
    resize(id: string, cols: number, rows: number) {
      terms.get(id)?.session.resize(cols, rows);
    },
    close(id: string) {
      const rec = terms.get(id);
      if (rec) drop(rec);
    },

    /** 会话被删 = 它名下的终端一起走(ADR-0002 的物理抹除延伸到进程) */
    killSession(sessionId: string) {
      for (const rec of ofSession(sessionId)) drop(rec);
    },

    /** app 退出。孤儿 dev server 占着端口而没人知道是谁占的,是最难查的一类问题 */
    killAll() {
      for (const rec of [...terms.values()]) drop(rec);
    },
  };
}

export type TerminalHub = ReturnType<typeof createTerminalHub>;
