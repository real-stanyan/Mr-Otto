// pxEscrowSync —— A 侧托管的上传编排（ADR-0197 切片 2，issue #797）。
//
// 职责一句话：**让 edge 那只箱子跟上本机的真实状态**。触发源有四个
// （index.ts 接线）：授权变了（发/改/撤）、服务清单变了（mcpHub.onChange，
// 连上/掉线/工具表变）、mcp-auth.json 被重写（token 刷新——issue #797 的
// re-sync 那一刀就是这条）、登录恢复（resume）。四个源都只调 schedule()，
// 防抖合并成一次上传——mcpHub.onChange 一天响几十次，不能一响一发。
//
// 整箱语义（pxEscrow.buildEscrowDoc）：
//   有授权 → PUT 全量覆盖；一条授权都不剩 → DELETE（撤销级联的后半——
//   proxyRevoke 清的是本地白名单，这里保证云端那份跟着消失）。
//   内容没变（escrowDigest 相同）→ 不打网络。
//
// 崩溃窗口：撤销落盘后、上传前进程死掉，云端会残留旧箱。所以登录恢复那次
// schedule 不看「上次发过什么」（进程新生，lastSent 本来就空），一定会对齐一次。
// 反过来，从没托管过的账号不该每次开机白打一个 DELETE——everHosted 挡掉。
//
// 依赖全注入，fetch 也注入：本模块不碰网络实现，假 fetch 即可测试。

import { escrowDigest, type EscrowDoc } from "../shared/remote/pxEscrow.js";

export type EscrowSyncOutcome = "put" | "deleted" | "unchanged" | "skipped" | "failed";

export interface EscrowSyncDeps {
  /** edge 服务根（edgeBaseUrl()），不带尾斜杠 */
  baseUrl: () => string;
  /** 当前 Supabase access token。null = 没登录/拿不到 → 这轮跳过，不重试
      （登录那一刻 resume 会再触发一次） */
  accessToken: () => Promise<string | null>;
  /** 本机此刻该托管的整箱。null = 一条授权都没有 */
  buildDoc: () => EscrowDoc | null;
  /** 有没有托管过的迹象（grants 或 channels 非空）。false + doc 为 null =
      从没碰过代理的账号，连 DELETE 都不必发 */
  everHosted: () => boolean;
  fetchImpl?: typeof fetch;
  /** 防抖窗口（默认 800ms）与失败重试间隔（默认 30s）。测试注小值 */
  debounceMs?: number;
  retryMs?: number;
  log?: (m: string) => void;
}

export interface EscrowSync {
  /** 防抖触发一次同步。所有触发源都走这里 */
  schedule(): void;
  /** 立即同步（测试与 resume 用）。并发调用会被串行化 */
  syncNow(): Promise<EscrowSyncOutcome>;
  /**
   * 上一次成功 PUT 进箱的 serverId 清单（「云端可用」徽标的数据源，切片 4）。
   * null = 箱子不在云端（没上传过 / 已 DELETE / 重启后还没同步——resume 那次
   * schedule 很快会把它填回来，短暂的 null 是接受的代价，宁可少报不虚报）
   */
  hostedServerIds(): readonly string[] | null;
  /**
   * 强制清箱（登出钩子用，issue #799）：不看 digest、不看 everHosted，直接 DELETE。
   * 登出把所有设备的 session 都吊销了，云端却还留着能刷新的 MCP 凭证——那只箱子
   * 必须跟着走。**要在 signOut 之前调**（之后 token 就没了）。失败不阻塞登出
   * （断网也得能登出），回 false 让调用方记一笔；箱子里的授权靠好友关系闸兜底。
   */
  purge(): Promise<boolean>;
  dispose(): void;
}

export function createEscrowSync(deps: EscrowSyncDeps): EscrowSync {
  const log = deps.log ?? (() => {});
  const doFetch = deps.fetchImpl ?? fetch;
  const debounceMs = deps.debounceMs ?? 800;
  const retryMs = deps.retryMs ?? 30_000;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  /** 上一次**成功**送达的内容指纹。进程内存态——重启后为 null，首轮必对齐 */
  let lastSent: string | null = null;
  /** 上一次成功 PUT 的箱内 serverId 清单。null = 箱子不在云端（见接口注释） */
  let hosted: readonly string[] | null = null;
  /** 串行化：同步进行中又被触发 → 记一笔，跑完再来一轮 */
  let inflight: Promise<EscrowSyncOutcome> | null = null;
  let rerun = false;

  async function syncOnce(): Promise<EscrowSyncOutcome> {
    const token = await deps.accessToken();
    if (!token) return "skipped";
    const doc = deps.buildDoc();
    if (!doc && !deps.everHosted()) return "skipped";
    const digest = escrowDigest(doc);
    if (digest === lastSent) return "unchanged";
    try {
      const res = doc
        ? await doFetch(`${deps.baseUrl()}/px/v1/escrow`, {
            method: "PUT",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(doc),
          })
        : await doFetch(`${deps.baseUrl()}/px/v1/escrow`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${token}` },
          });
      if (!res.ok) {
        log(`托管上传被拒（HTTP ${res.status}）——${retryMs}ms 后重试`);
        scheduleRetry();
        return "failed";
      }
      lastSent = digest;
      hosted = doc ? doc.services.map((s) => s.serverId) : null;
      log(doc ? `托管已上传：${doc.services.length} 台服务 / ${doc.grants.length} 条授权` : "托管已从云端删除");
      return doc ? "put" : "deleted";
    } catch (e) {
      log(`托管上传失败（${e instanceof Error ? e.message : String(e)}）——${retryMs}ms 后重试`);
      scheduleRetry();
      return "failed";
    }
  }

  function scheduleRetry(): void {
    if (disposed || timer !== null) return;
    timer = setTimeout(() => { timer = null; void run(); }, retryMs);
  }

  async function run(): Promise<EscrowSyncOutcome> {
    if (inflight) {
      rerun = true;
      return inflight;
    }
    inflight = syncOnce();
    try {
      return await inflight;
    } finally {
      inflight = null;
      if (rerun && !disposed) {
        rerun = false;
        void run();
      }
    }
  }

  return {
    schedule() {
      if (disposed) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void run(); }, debounceMs);
    },
    syncNow: () => run(),
    hostedServerIds: () => hosted,
    async purge() {
      const token = await deps.accessToken();
      if (!token) return false;
      try {
        const res = await doFetch(`${deps.baseUrl()}/px/v1/escrow`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${token}` },
          // 登出流程不能被一个挂死的请求卡住
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) {
          log(`登出清箱被拒（HTTP ${res.status}）`);
          return false;
        }
        lastSent = null;
        hosted = null;
        log("登出：托管已从云端删除");
        return true;
      } catch (e) {
        log(`登出清箱失败（${e instanceof Error ? e.message : String(e)}）——不阻塞登出`);
        return false;
      }
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
