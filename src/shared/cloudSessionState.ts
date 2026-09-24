// cloudSessionState —— 云会话在客户端那一格的两条状态规则 + 两句文案（#1356 A1）。
//
// 桌面渲染层的 store 与手机端的 chat store 做同两件事：事件推送来了插到哪儿、状态推送
// 来了哪几格照抄哪几格留着。两条都是「抄错了不报错」的——插错位置时间线乱序且一行都不
// 报错；把 chat 的缺席读成团队会话就是 #1301。原来长在桌面 store.ts 的两个回调里，手机
// 端要照做就得抄第二份，所以挪进这里，两端各调一份（spec §2「不抄第二份」）。

import type { SessionEvent } from "../session/events.js";
import { CS_PROTOCOL_VERSION, type CsChatInfo, type CsModelRoute } from "./remote/cloudSession.js";
import type { CloudSessionStatus } from "./shellBridge.js";

/**
 * 一条事件插进按 seq 升序的时间线。**已经有这个 seq 就回 null**：:gone 之后 host 回来
 * 重连会把 backlog 全量再推一遍（`remote/cloudSessionClient.ts` 文件头「:gone」段），
 * 重复送达在这里无害地被滤掉。
 *
 * 快路径是追加。往前翻的那一页落在**前面**，走一次二分——**不能**只判「比头还小」：
 * 同一页是按 seq 升序到达的，第二条就不再比新的头小了，会被甩到末尾。也不每条都全量
 * 排序：一页 200 条，逐条排就是 200 次 O(n log n)。
 *
 * 去重靠二分落点那一格判：时间线由构造保证按 seq 升序（每一条都经过这里），所以
 * 「有没有同 seq」等价于「落点那一格是不是同 seq」，不必全表扫一遍。
 */
export function insertCloudEvent(events: readonly SessionEvent[], event: SessionEvent): SessionEvent[] | null {
  const n = events.length;
  if (n === 0 || event.seq > events[n - 1]!.seq) return [...events, event];
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid]!.seq < event.seq) lo = mid + 1;
    else hi = mid;
  }
  if (lo < n && events[lo]!.seq === event.seq) return null;
  return [...events.slice(0, lo), event, ...events.slice(lo)];
}

/** 状态推送落到的那一格里、两端共有的部分。桌面 `CloudSessionState` 与手机端
    `ChatSession` 各自在这之上多几格（翻页状态、事件数组） */
export interface CloudSessionCore {
  workspaceId: string;
  sessionId: string;
  state: "connecting" | "ready" | "denied" | "gone";
  deniedCode?: string;
  deniedServerVersion?: number;
  initiatorUid: string | null;
  ownerUid: string;
  selfUid: string;
  modelRoute: CsModelRoute | null;
  gapNote: string | null;
  chat: CsChatInfo | null | undefined;
  hasOlder: boolean;
}

/**
 * 一次状态推送落到手上那一格。三类字段、三种规矩：
 *
 * - `state` / `initiatorUid` / `ownerUid` / `selfUid` / `modelRoute`：照抄。
 * - `gapNote` / `hasOlder`：照抄推送，**缺席即结论**（缺席 → null / false）。主进程
 *   每次推送都重算这两格：缺口补齐时正是靠**不带** `gapNote` 来说「补齐了」，翻到头时
 *   正是靠不带 `hasOlder` 来说「到头了」——「没带就留着旧的」等于一直说一句已经不成立
 *   的话（issue #957 C-I7 / #1280）。
 * - `chat`：**缺席就留着手上那份**（打开时按清单行或建会话的 spec 种下的种子）。与上一
 *   类相反而理由对称：welcome 每条连接只说一次，把缺席读成「团队会话」正是 #1301。
 * - `deniedCode` / `deniedServerVersion`：来了才覆盖、没来就留着；没来的键不写成
 *   undefined（exactOptionalPropertyTypes：「键不存在」与「值是 undefined」是两回事）。
 *
 * 回 `CloudSessionCore`：调用方手上那格多出来的字段（翻页状态、事件）照旧由它自己
 * 展开保留——`{ ...cur, ...applyCloudStatus(cur, status) }`。
 */
export function applyCloudStatus(cur: CloudSessionCore, status: CloudSessionStatus): CloudSessionCore {
  return {
    ...cur,
    state: status.state,
    initiatorUid: status.initiatorUid,
    ownerUid: status.ownerUid,
    selfUid: status.selfUid,
    modelRoute: status.modelRoute,
    gapNote: status.gapNote ?? null,
    ...(status.chat === undefined ? {} : { chat: status.chat }),
    hasOlder: status.hasOlder ?? false,
    ...(status.deniedCode === undefined ? {} : { deniedCode: status.deniedCode }),
    ...(status.deniedServerVersion === undefined ? {} : { deniedServerVersion: status.deniedServerVersion }),
  };
}

/**
 * join 之后持续状态里的 deniedCode → 人话（原桌面 CloudSessionPage 的 `cloudDeniedMessage`）。
 * `remote/cloudSessionClient.ts` 的 `deniedMessage()` 只服务 create() 那一次性 RPC 失败；
 * 这一份多一档：认不出的码原样带出来兜底，不装死。
 *
 * version_mismatch 说得出方向才有用（复审 C2-I6）：严格相等判出的不匹配有两个方向，
 * 「更新 Mr Otto」对「云端还没部署」的那半是错的指引——照做也连不上，且再没有别的线索。
 */
export function cloudDeniedText(code: string | undefined, serverVersion?: number): string {
  switch (code) {
    case "bad_jwt":
      return "登录状态已过期，请重新登录后再试";
    case "not_member":
      return "你不是这个团队的成员";
    case "version_mismatch":
      if (serverVersion !== undefined && serverVersion < CS_PROTOCOL_VERSION) {
        return `云端协议版本（${serverVersion}）低于本客户端（${CS_PROTOCOL_VERSION}），云端还没升级，联系维护者`;
      }
      return "客户端版本与云端不匹配，请更新 Mr Otto 后再试";
    case "no_session":
      return "云会话不存在或已归档";
    case "not_authorized":
      return "没有权限执行此操作";
    default:
      return code ? `无法加入云会话（${code}）` : "无法加入云会话";
  }
}

/** 「不确定有没有发出去」那一行的初始措辞（第四批 C2-I4）。正文只回显前 40 字——这一行
    是「哪一句话」的提示，不是那句话本身（重发发的是全文） */
export function unknownSendNote(text: string): string {
  return `没有收到回执，不确定有没有发出去：${text.slice(0, 40)}${text.length > 40 ? "…" : ""}`;
}
