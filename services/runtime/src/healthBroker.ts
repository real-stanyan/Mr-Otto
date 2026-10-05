// 健康读取的定向往返（#1656，spec §3.2）：哪几条 cid 声明了「能读健康」、给其中一条发 health_query、等它回。
// 纯逻辑，发送注入（daemon 给 globalSend）——frameHandler 喂 caps / health_result / onGone 进来，read_health 工具从这里取 cid 与结果。
//
// 结果永远 resolve 成 HealthResult，不 reject：四种收场（回帧 / 超时 / 断开 / abort）都是「这次没读到」的不同说法，
// 工具那一侧统一把 ok:false 的 error 抛给模型。回帧只认发请求的那一条 cid：别的连接（哪怕同一个人）冒充的不收。

import { randomUUID } from "node:crypto";
import type { HealthQuery, HealthResult } from "../../../src/shared/health.js";
import type { CsDown } from "../../../src/shared/remote/cloudSession.js";

export const HEALTH_TIMEOUT_MS = 30_000;

export interface HealthBroker {
  setCaps(cid: string, uid: string, health: boolean): void;
  gone(cid: string): void;
  /** 这个人此刻能读健康的连接里最近声明的那一条；没有回 null */
  cidOf(uid: string): string | null;
  request(cid: string, query: HealthQuery, signal?: AbortSignal): Promise<HealthResult>;
  /** true = 对上了一条挂着的请求 */
  resolve(cid: string, reqId: string, result: HealthResult): boolean;
}

export function createHealthBroker(deps: {
  send: (cid: string, msg: CsDown) => void;
  timeoutMs?: number;
  newId?: () => string;
}): HealthBroker {
  const timeoutMs = deps.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const newId = deps.newId ?? (() => randomUUID());
  /** cid → uid；Map 保插入序，「最近声明」= 迭代里最后一条 */
  const capable = new Map<string, string>();
  const pending = new Map<string, { cid: string; settle: (r: HealthResult) => void }>();

  /** 每条的 settle 自己从 pending 里摘（并清计时器、摘 abort 监听），所以这里先拷一份再逐个收场 */
  function failAllOf(cid: string, error: string): void {
    for (const p of [...pending.values()]) if (p.cid === cid) p.settle({ ok: false, error });
  }

  return {
    setCaps(cid, uid, health) {
      capable.delete(cid);
      if (health) capable.set(cid, uid);
    },
    gone(cid) {
      capable.delete(cid);
      failAllOf(cid, "手机断开了");
    },
    cidOf(uid) {
      let hit: string | null = null;
      for (const [cid, u] of capable) if (u === uid) hit = cid;
      return hit;
    },
    request(cid, query, signal) {
      if (signal?.aborted === true) return Promise.resolve({ ok: false, error: "这一轮被停了" });
      const reqId = newId();
      return new Promise<HealthResult>((resolve) => {
        const timer = setTimeout(() => settle({ ok: false, error: `手机 ${Math.round(timeoutMs / 1000)} 秒没回` }), timeoutMs);
        const onAbort = (): void => settle({ ok: false, error: "这一轮被停了" });
        function settle(r: HealthResult): void {
          if (!pending.has(reqId)) return;
          pending.delete(reqId);
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(r);
        }
        pending.set(reqId, { cid, settle });
        signal?.addEventListener("abort", onAbort, { once: true });
        deps.send(cid, { t: "health_query", reqId, query });
      });
    },
    resolve(cid, reqId, result) {
      const p = pending.get(reqId);
      if (p === undefined || p.cid !== cid) return false;
      p.settle(result);
      return true;
    },
  };
}
