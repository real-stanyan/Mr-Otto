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
  /** 这次批准同时授予的长期许可（ADR-0041）。审批门只负责把它转告 onDecision
      （engine 据此落进 approval_decision.grant）—— 谁记住、下次谁短路，
      是外面那层 approver 的事，门本身不认识"以后" */
  grant?: "session" | "always";
  /** 人在审批时改过的参数：**执行用这一份**（write_file 的分块取舍）。
      门在放行前把它写回 ctx.call.args —— 执行器只认 ctx.call，
      改在别处都会变成"日志说一套、磁盘上是另一套" */
  revisedArgs?: unknown;
  /** 云会话群聊场景（issue #799 系列，ADR-0199）：这次决定是谁按下的按钮。
      桌面单人会话里审批人就是唯一操作者，字段没意义——普通 Approver 实现
      不填即可（可选 = 老实现零改动）。engine 的内置 onDecision 把它原样
      落进 approval_decision.decidedBy；门本身不判断"谁"，只负责转告——
      "谁能批、谁批的"是 Approver 实现（云 runtime 里是 approvalRouter）的事 */
  decidedBy?: { uid: string; label: string };
}

/** 审批人 —— 谁实现都行，engine 只认这个形状。
    signal（ADR-0006）：turn 中断时实现方必须让挂起的 decide 立即返回
    （UIApprover resolve 成 denied），否则整条管线卡死在审批门里等一个
    永远不会来的人。可选参数 = 向后兼容，测试假人不用管它 */
export interface Approver {
  decide(call: ToolCallRequest, tool: Tool, signal?: AbortSignal): Promise<ApprovalOutcome>;
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

    const outcome = await opts.approver.decide(ctx.call, ctx.tool, ctx.signal);
    opts.onDecision(ctx.call, outcome);

    if (outcome.decision === "denied") {
      return {
        status: "denied",
        output: outcome.reason ? `用户拒绝执行：${outcome.reason}` : "用户拒绝执行",
      };
    }
    if (outcome.revisedArgs !== undefined) {
      // 换一个**新对象**,不是改 ctx.call.args ——
      // ctx.call 指的就是 assistant_message 事件里那条 toolCall(同一个对象引用),
      // 原地改它等于把已经落盘的那条事件也一起改了:DB 里的行还是老样子,
      // 但推给渲染层的那份内存对象已经变了,于是界面上"模型请求的参数"显示成了
      // 人改过之后的样子 —— append-only 的日志在内存里被改写,这正是硬规则禁的事。
      // 洋葱后面每一层(执行器在内)拿的都是 ctx,所以换引用照样生效
      ctx.call = { ...ctx.call, args: outcome.revisedArgs };
    }
    const result = await next(); // 放行 —— 进洋葱下一层
    if (outcome.revisedArgs === undefined || result.status !== "ok") return result;
    // 模型必须知道执行的不是它请求的那一份。不说 = 它会照着自己的请求继续推理,
    // 而磁盘上是另一个样子 —— 这比拒绝更危险,因为看起来成功了
    return {
      ...result,
      output: `${result.output}\n（注意：用户在审批时修改了参数，实际执行的内容与你的请求不同。需要确认请重新读取。）`,
    };
  };
}
