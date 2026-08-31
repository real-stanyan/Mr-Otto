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
}

export interface ApprovalRouter extends Approver {
  setInitiator(uid: string): void; // 每条 turn 起跑前设
  /** cs approve 帧进来。回 false = 无此 pending 或无权（daemon 只回 error 帧，不落盘） */
  resolve(callId: string, byUid: string, decision: "approved" | "denied"): boolean;
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
          argsSummary: JSON.stringify(call.args).slice(0, 200),
          initiatorUid,
          expiresTs,
        });
      });
    },

    resolve(callId: string, byUid: string, decision: "approved" | "denied"): boolean {
      const entry = pending.get(callId);
      if (!entry) return false;
      if (byUid !== entry.initiatorUid && byUid !== opts.ownerUid) return false;
      entry.settle({ decision });
      return true;
    },
  };
}
