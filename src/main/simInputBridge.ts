// 模拟器输入桥 —— 主进程 ↔ Swift helper(native/MrOttoSimInput)的 NDJSON 通道。
// 形状照 islandBridge:spawn 注入,所以整套逻辑(编解码/配对/超时/重启)
// 能在普通 vitest 里跑,不用真的有 Xcode、真的有授权。
//
// 与岛的桥有一处根本不同:岛是**单向推**(主进程推状态,helper 回命令),
// 这里是**请求-响应**——点一下要知道点没点上。于是每条请求带自增 id,
// 回来的行按 id 认领;认不出的行丢掉(不是错误:helper 的 stderr 不走这条管子)。

import type { SimUiElement } from "../shared/simulator.js";

export interface SimInputRequest {
  type: "probe" | "requestPermission" | "windowRect" | "describe" | "tap" | "swipe" | "text" | "key";
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  duration?: number;
  text?: string;
  button?: string;
  shotWidth?: number;
  shotHeight?: number;
}

/** helper 回来的一行。字段按命令各取所需,统一用 ok/error 表达成败 */
export interface SimInputResponse {
  id: number;
  ok: boolean;
  error?: string;
  trusted?: boolean;
  simulatorRunning?: boolean;
  pid?: number;
  rect?: { x: number; y: number; width: number; height: number };
  /** "screen" = 无障碍树里那块设备屏(准);"window" = 只有窗口外框(等比内切的估计值) */
  rectSource?: "screen" | "window";
  /** 屏幕坐标系(左上原点)下的元素框;换算到截图像素由 hub 做 */
  elements?: (Omit<SimUiElement, "frame"> & { x: number; y: number; width: number; height: number })[];
}

export interface SimInputChild {
  stdin: { write(s: string): void };
  stdout: { on(ev: "data", cb: (b: Buffer) => void): void };
  on(ev: "exit", cb: () => void): void;
  kill(): void;
}
export type SimInputSpawn = (binPath: string) => SimInputChild;

/** 一条请求最多等多久。点击/截图都是毫秒级;走无障碍树读一屏元素慢一些,
    但也不该到秒级——超了大概率是 helper 卡死,与其挂着不如报错让人看见 */
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RESTARTS = 3;

export interface SimInputBridge {
  send(req: SimInputRequest): Promise<SimInputResponse>;
  dispose(): void;
}

export function createSimInputBridge(opts: {
  binPath: string;
  spawn: SimInputSpawn;
  timeoutMs?: number;
  log?: (m: string) => void;
}): SimInputBridge {
  const log = opts.log ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let child: SimInputChild | null = null;
  let restarts = 0;
  let disposed = false;
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (r: SimInputResponse) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  const settleAll = (err: Error) => {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  };

  const start = (): SimInputChild | null => {
    if (disposed) return null;
    if (restarts > MAX_RESTARTS) return null;
    const c = opts.spawn(opts.binPath);
    child = c;
    // 每代一个局部行缓冲:上一代崩溃后的迟到字节不能混进新一代(同 islandBridge)
    let buf = "";
    c.stdout.on("data", (b) => {
      buf += b.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let o: unknown;
        try {
          o = JSON.parse(line);
        } catch {
          log(`模拟器输入桥:无法解析 ${line.slice(0, 120)}`);
          continue;
        }
        const r = o as SimInputResponse;
        if (!r || typeof r.id !== "number") continue;
        const p = pending.get(r.id);
        if (!p) continue; // 迟到的回复(请求已超时):丢掉,不是错误
        pending.delete(r.id);
        clearTimeout(p.timer);
        p.resolve(r);
      }
    });
    c.on("exit", () => {
      if (disposed) return;
      child = null;
      restarts += 1;
      // 挂起的请求不能干等:helper 没了,它们永远不会有回复
      settleAll(new Error("模拟器输入 helper 退出了(下一次调用会重开)"));
    });
    return c;
  };

  return {
    send(req) {
      if (disposed) return Promise.reject(new Error("模拟器输入桥已关闭"));
      const c = child ?? start();
      if (!c) {
        return Promise.reject(
          new Error("模拟器输入 helper 反复退出,已停止重启——重开 app 再试")
        );
      }
      const id = nextId++;
      return new Promise<SimInputResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`模拟器输入 helper 超时未回(${req.type})`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          c.stdin.write(JSON.stringify({ id, ...req }) + "\n");
        } catch (e) {
          pending.delete(id);
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    },
    dispose() {
      disposed = true;
      settleAll(new Error("模拟器输入桥已关闭"));
      child?.kill();
      child = null;
    },
  };
}
