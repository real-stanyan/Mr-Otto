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
  /** 由 index.ts 注入(内部走 LocalWorld.openTerminal)。注入而非直接 import:
      测试要能塞假 pty,v2 要能换成容器世界 */
  openTerminal(workspace: string, opts: OpenTerminalOptions): Promise<TerminalSession>;
  push: {
    data(id: string, data: string): void;
    exit(id: string, exitCode: number): void;
  };
  /** 每会话标签上限,防手滑刷出一堆 shell。缺省 8 */
  maxPerSession?: number;
  /** 每终端回滚缓冲字节数,缺省 200 KB */
  bufferBytes?: number;
}

interface Record_ {
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
  const terms = new Map<string, Record_>();

  const ofSession = (sessionId: string) =>
    [...terms.values()].filter((t) => t.sessionId === sessionId);

  /** 环形缓冲:整段整段地丢最老的,丢到总量落回上限内。
      按 chunk 丢会让快照从半个转义序列开始,xterm 会渲出乱码,
      所以最后一段还要按字符裁 */
  const remember = (rec: Record_, data: string) => {
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

  const drop = (rec: Record_) => {
    for (const off of rec.offs) off();
    rec.offs = [];
    rec.session.kill();
    terms.delete(rec.id);
  };

  return {
    async open(sessionId: string, workspace: string, cols: number, rows: number) {
      const mine = ofSession(sessionId);
      if (mine.length >= maxPerSession) {
        throw new Error(`一个会话最多开 ${maxPerSession} 个终端,先关掉一个再开`);
      }
      const id = randomUUID();
      const session = await deps.openTerminal(workspace, { cols, rows });
      const rec: Record_ = {
        id,
        sessionId,
        title: `终端 ${mine.length + 1}`,
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
