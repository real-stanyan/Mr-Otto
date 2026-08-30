// pxAuditSync —— A 侧云端审计的回流编排（ADR-0197 切片 4，issue #799）。
//
// 云端执行发生在 A 不在场的时候，账却记在 A 的箱子里（Escrow DO 的环形 500）。
// 这只模块把它增量拉回本地台账：游标（proxyStore.cloudAuditCursor）记「已拉到
// 的最大 ts」，每次只要 ts > 游标的那段；并入与去重是 proxyStore.mergeCloudAudits
// 的事，这里只管编排（何时拉、串行化、别把「拉不到」当「没有」）。
//
// 触发源两个（index.ts 接线）：登录恢复（resume——A 上线第一时间把离线期间的
// 账补齐，hostStatus 的 lastCallAt 才不撒谎）+ 用户打开调用记录（proxyAudit
// IPC——看账那一刻要新鲜的）。不做定时轮询：审计是给人看的台账，人不看的时候
// 拉回来也没人消费，等看的那一刻拉最省。
//
// 依赖全注入，与 pxEscrowSync 同一套纪律：假 fetchAudit / 假 store 即可测试。

import { mergeCloudAudits, type ProxyStoreData } from "./proxyStore.js";
import type { PxAudit } from "../shared/remote/pxEscrow.js";

export type AuditPullOutcome = "merged" | "empty" | "skipped" | "failed";

export interface AuditBackflowDeps {
  /** 云端那段增量（pxCloudClient.fetchAudit）。null = 拿不到 */
  fetchAudit: (since: number) => Promise<readonly PxAudit[] | null>;
  loadStore: () => ProxyStoreData;
  saveStore: (d: ProxyStoreData) => void;
  log?: (m: string) => void;
}

export interface AuditBackflow {
  /** 拉一次增量并入台账。并发调用共享同一轮（看账那格 UI 可能连点） */
  pullNow(): Promise<AuditPullOutcome>;
}

export function createAuditBackflow(deps: AuditBackflowDeps): AuditBackflow {
  const log = deps.log ?? (() => {});
  let inflight: Promise<AuditPullOutcome> | null = null;

  async function pullOnce(): Promise<AuditPullOutcome> {
    const cur = deps.loadStore();
    // 从没授过权、也从没拉到过账的账号：云端箱子根本不存在，别白打网络
    if (cur.grants.length === 0 && (cur.cloudAuditCursor ?? 0) === 0) return "skipped";
    const entries = await deps.fetchAudit(cur.cloudAuditCursor ?? 0);
    if (entries === null) return "failed";
    if (entries.length === 0) return "empty";
    // fetch 是 await 过的：落盘前重读一遍，别把这段时间里别处写进的账覆盖掉
    deps.saveStore(mergeCloudAudits(deps.loadStore(), entries));
    log(`云端审计回流：${entries.length} 笔并入本地台账`);
    return "merged";
  }

  return {
    pullNow() {
      if (inflight) return inflight;
      inflight = pullOnce().finally(() => { inflight = null; });
      return inflight;
    },
  };
}
