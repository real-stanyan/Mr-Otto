// UIApprover — Approver 的 GUI 实现：把"问人"变成一次 UI 往返。
// decide() 返回一个不 resolve 的 Promise → 整条工具管线在审批门里悬停，
// 直到渲染进程按了按钮、IPC 调 resolve(toolCallId, outcome) 把它唤醒。
// 引擎对此毫无感知——它只是在 await 一个接口方法。

import type { Approver, ApprovalOutcome } from "../loop/approvalGate.js";
import type { Tool } from "../tools/tool.js";
import type { ToolCallRequest } from "../session/events.js";

export class UIApprover implements Approver {
  private pending = new Map<string, (outcome: ApprovalOutcome) => void>();

  constructor(
    /** 怎么把审批请求送到 UI（主进程注入 webContents.send） */
    private readonly requestFromUI: (call: ToolCallRequest, tool: Tool) => void
  ) {}

  decide(call: ToolCallRequest, tool: Tool): Promise<ApprovalOutcome> {
    return new Promise((resolve) => {
      this.pending.set(call.id, resolve);
      this.requestFromUI(call, tool);
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
