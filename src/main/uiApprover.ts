// UIApprover — Approver 的 GUI 实现：把"问人"变成一次 UI 往返。
// decide() 返回一个不 resolve 的 Promise → 整条工具管线在审批门里悬停，
// 直到渲染进程按了按钮、IPC 调 resolve(toolCallId, outcome) 把它唤醒。
// 引擎对此毫无感知——它只是在 await 一个接口方法。

import type { Approver, ApprovalOutcome } from "../loop/approvalGate.js";
import type { Tool } from "../tools/tool.js";
import type { ToolCallRequest } from "../session/events.js";
import type { ApprovalMode } from "../shared/shellBridge.js";

export type { ApprovalMode };

export class UIApprover implements Approver {
  private pending = new Map<string, (outcome: ApprovalOutcome) => void>();

  constructor(
    /** 怎么把审批请求送到 UI（主进程注入 webContents.send） */
    private readonly requestFromUI: (call: ToolCallRequest, tool: Tool) => void
  ) {}

  decide(call: ToolCallRequest, tool: Tool, signal?: AbortSignal): Promise<ApprovalOutcome> {
    return new Promise((resolve) => {
      // turn 中断（ADR-0006）：挂起的审批立即按"拒绝"收场——走既有 denied 管道，
      // approval_decision + tool_result(denied) 照常落盘，不需要新事件类型。
      // 已中止的信号直接短路，不给 UI 发一张必死的卡
      const abortOutcome: ApprovalOutcome = { decision: "denied", reason: "turn 被用户中断" };
      if (signal?.aborted) return resolve(abortOutcome);
      this.pending.set(call.id, resolve);
      this.requestFromUI(call, tool);
      signal?.addEventListener(
        "abort",
        () => {
          // 人已经点过按钮（pending 里没了）就不重复收场
          if (this.pending.delete(call.id)) resolve(abortOutcome);
        },
        { once: true }
      );
    });
  }

  /** IPC 入口：用户按了按钮。没有对应挂起项 = 重复点击/过期卡，忽略 */
  resolve(toolCallId: string, outcome: ApprovalOutcome): void {
    const wake = this.pending.get(toolCallId);
    if (!wake) return;
    this.pending.delete(toolCallId);
    wake(outcome);
  }
}

/** 模式感知的 Approver：auto 模式短路 UI 往返，直接放行。
    每次 decide 现读模式（getMode 是活引用）——turn 跑到一半切模式，下一个
    工具调用立即遵守新模式。批准照样流经审批门 → approval_decision 照常落盘，
    日志永远记着"这一步是自动批的"（reason 说明），行为可从日志推导。 */
export function createModeAwareApprover(getMode: () => ApprovalMode, ui: Approver): Approver {
  return {
    decide(call, tool, signal) {
      if (getMode() === "auto") {
        return Promise.resolve({ decision: "approved", reason: "自动批准（bypass 模式）" });
      }
      return ui.decide(call, tool, signal);
    },
  };
}
