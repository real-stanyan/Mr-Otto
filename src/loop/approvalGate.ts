// 审批门 — requiresApproval 工具的人工关卡（管线第一层中间件）
// 决定权在 Approver 接口后面：CLI = 终端问答，Electron = 审批卡片，测试 = 脚本假人。
// 两条落盘线分工（见 events.ts）：
//   approval_decision —— 给 UI/审计看，模型不消费
//   tool_result(denied) —— 模型从这条知道"被拒了"，不变量不破

import type { ToolMiddleware } from "./middleware.js";
import type { ToolCallRequest } from "../session/events.js";
import type { Tool } from "../tools/tool.js";

export interface ApprovalOutcome {
  decision: "approved" | "denied";
  reason?: string;
}

/** 审批人 —— 谁实现都行，engine 只认这个形状 */
export interface Approver {
  decide(call: ToolCallRequest, tool: Tool): Promise<ApprovalOutcome>;
}

export interface ApprovalGateOptions {
  /** 不给 = 无人在场，危险操作一律默认拒绝（fail-closed） */
  approver?: Approver | undefined;
  /** 决定一做出就回调 —— engine 挂在这，把 approval_decision 落盘 */
  onDecision: (call: ToolCallRequest, outcome: ApprovalOutcome) => void;
}

export function createApprovalGate(opts: ApprovalGateOptions): ToolMiddleware {
  return async (ctx, next) => {
    // 免批工具（read_file）和未知工具（执行器会兜底成 error）直接放行
    if (!ctx.tool || !ctx.tool.requiresApproval) return next();

    if (!opts.approver) {
      const reason = "无审批人在场，危险操作默认拒绝";
      opts.onDecision(ctx.call, { decision: "denied", reason });
      return { status: "denied", output: reason };
    }

    const outcome = await opts.approver.decide(ctx.call, ctx.tool);
    opts.onDecision(ctx.call, outcome);

    if (outcome.decision === "denied") {
      return {
        status: "denied",
        output: outcome.reason ? `用户拒绝执行：${outcome.reason}` : "用户拒绝执行",
      };
    }
    return next(); // 放行 —— 进洋葱下一层
  };
}
