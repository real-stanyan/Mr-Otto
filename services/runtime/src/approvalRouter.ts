// 审批路由 — cs approve 帧落到哪个 pending decide、谁能批（ADR-0199）
// decide 挂起 + onRequest 回调（daemon 拿去落盘/广播）+ 定时器超时自动 deny。
// resolve 只认发起人或 owner；无关成员回 false 且不消化 pending（daemon 只回 error 帧，不落盘）。

import type { Approver, ApprovalOutcome } from "../../../src/loop/approvalGate.js";
import type { ToolCallRequest } from "../../../src/session/events.js";
import type { Tool } from "../../../src/tools/tool.js";

export interface ApprovalRouterOpts {
  ownerUid: string;
  timeoutMs?: number; // 默认 600_000
  now?: () => number;
  onRequest: (req: {
    callId: string;
    toolName: string;
    argsSummary: string;
    initiatorUid: string;
    expiresTs: number;
  }) => void; // daemon 拿去落盘+广播
  /** 审批卡上「参数摘要」那一段的文案（#954）：回字符串就用它，回 null 退回默认
      `JSON.stringify(args).slice(0, 200)`。默认那 200 字对 bash/write_file 够用，对
      create_agent 不够——一条 4000 字的提示词被截成 200 字，等于让人批一段没看见的
      提示词（ADR-0118 第二条：卡片含糊 = 闸形同虚设）。可选：不传 = 现状一字不变 */
  summarizeArgs?: (toolName: string, args: unknown) => string | null;
}

export interface ApprovalRouter extends Approver {
  setInitiator(uid: string): void; // 每条 turn 起跑前设
  /** cs approve 帧进来。回 false = 无此 pending 或无权（daemon 只回 error 帧，不落盘）。
      decidedBy：这次决定是谁按下的按钮，随 outcome 一起喂给 decide() 的 resolve——
      **显式参数，不是旁路存取**（复审 Important，issue #799 系列）：早先版本让调用方
      在 resolve() 之前把 {uid,label} 存进一个按 callId 键控的旁路 Map、resolve 内部
      再回读，这在"同 callId 背靠背两次 approve、不 await 中间态"时有 TOCTOU 窗口——
      第二次调用可能先覆盖 Map 里的条目、又因为 resolve 失败（pending 已被第一次消化）
      把整个 key 删掉，等第一次 resolve 触发的 decide() 续体去读时 Map 已空，
      decidedBy 静默丢失（decision 本身仍对，但审计"谁批的"这一列空了）。改成参数直接
      随 settle() 一起传，同一个 callId 的 pending 只能被消化一次（pending.delete 在
      settle 里发生），第二次调用连 entry 都查不到，早早短路返回 false——不存在
      "读到别人刚写的值"的窗口，因为压根没有共享的旁路状态可读 */
  resolve(callId: string, byUid: string, decision: "approved" | "denied", decidedBy?: { uid: string; label: string }): boolean;
  canDecide(uid: string): boolean; // uid === initiator || uid === owner
}

interface Pending {
  initiatorUid: string;
  settle: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  abortHandler?: () => void;
}

const DEFAULT_TIMEOUT_MS = 600_000;

export function createApprovalRouter(opts: ApprovalRouterOpts): ApprovalRouter {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts.now ?? (() => Date.now());
  const pending = new Map<string, Pending>();
  let initiatorUid = "";

  function canDecide(uid: string): boolean {
    // 答的是「此 uid 此刻能不能当审批人」（用 live initiator），不是「能不能批某个具体 pending」
    // 具体归属判定以 resolve() 的快照为准
    return uid === initiatorUid || uid === opts.ownerUid;
  }

  return {
    setInitiator(uid: string): void {
      initiatorUid = uid;
    },

    canDecide,

    async decide(call: ToolCallRequest, tool: Tool, signal?: AbortSignal): Promise<ApprovalOutcome> {
      const callId = call.id;
      const expiresTs = now() + timeoutMs;

      return new Promise<ApprovalOutcome>((resolvePromise) => {
        const cleanup = () => {
          clearTimeout(entry.timer);
          if (entry.abortHandler && signal) {
            signal.removeEventListener("abort", entry.abortHandler);
          }
          if (pending.get(callId) === entry) {
            pending.delete(callId);
          }
        };

        const settle = (outcome: ApprovalOutcome) => {
          cleanup();
          resolvePromise(outcome);
        };

        const timer = setTimeout(() => {
          settle({ decision: "denied", reason: "审批超时" });
        }, timeoutMs);

        const entry: Pending = { initiatorUid, settle, timer };
        pending.set(callId, entry);

        if (signal) {
          if (signal.aborted) {
            settle({ decision: "denied", reason: "turn 已中断" });
            return;
          }
          const abortHandler = () => {
            settle({ decision: "denied", reason: "turn 已中断" });
          };
          entry.abortHandler = abortHandler;
          signal.addEventListener("abort", abortHandler, { once: true });
        }

        opts.onRequest({
          callId,
          toolName: tool.def.name,
          argsSummary: opts.summarizeArgs?.(tool.def.name, call.args) ?? JSON.stringify(call.args).slice(0, 200),
          initiatorUid,
          expiresTs,
        });
      });
    },

    resolve(
      callId: string,
      byUid: string,
      decision: "approved" | "denied",
      decidedBy?: { uid: string; label: string }
    ): boolean {
      const entry = pending.get(callId);
      if (!entry) return false;
      if (byUid !== entry.initiatorUid && byUid !== opts.ownerUid) return false;
      entry.settle({ decision, ...(decidedBy ? { decidedBy } : {}) });
      return true;
    },
  };
}
