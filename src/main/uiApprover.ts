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
  /** 挂起中的调用请求了什么。授权授的是"工具"这个粒度,
      而 IPC 回来的只有 toolCallId —— 这张表是两者之间唯一的桥。
      存整个 (call, tool) 而不只是工具名:岛窗 boot / 切会话时要把"此刻挂着的那张卡"
      原样补给 UI(#175 I1),而 requestFromUI 当初拿到的就是这两样东西。
      与 pending 同生共死(同一处 set、同一处 delete) */
  private pendingTool = new Map<string, { call: ToolCallRequest; tool: Tool }>();

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
      this.pendingTool.set(call.id, { call, tool });
      this.requestFromUI(call, tool);
      signal?.addEventListener(
        "abort",
        () => {
          // 人已经点过按钮（pending 里没了）就不重复收场
          this.pendingTool.delete(call.id);
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
    this.pendingTool.delete(toolCallId);
    wake(outcome);
  }

  /** 这个挂起中的调用是哪个工具。已收场/不认识的返 undefined —— 调用方据此不授权 */
  toolFor(toolCallId: string): string | undefined {
    return this.pendingTool.get(toolCallId)?.call.name;
  }

  /** 此刻挂着的审批(给 UI 补快照用)。一个会话同一时刻至多挂一张卡 ——
      工具管线是串行的,审批门里悬停的只会有一个 —— 所以取第一个就是那一个。
      没有挂起项返 undefined:岛窗据此显示"没有待审批" */
  pendingRequest(): { call: ToolCallRequest; tool: Tool } | undefined {
    for (const entry of this.pendingTool.values()) return entry;
    return undefined;
  }
}

/** 授权感知的 Approver：这个工具已经被授过权(本会话 / 永久)就直接放行，不弹卡。
    ADR-0041。放行照旧流经审批门 → approval_decision 照常落盘，reason 写明是
    哪一档授权放的行 —— 日志里不会出现"没人批过就跑了"的危险操作。

    每次 decide 现查（两个都是活引用）：会话中途授的权，下一个调用立即生效；
    永久授权文件被改了，也不用重启。 */
export function createGrantAwareApprover(
  isGranted: (tool: string) => "session" | "always" | undefined,
  ui: Approver
): Approver {
  return {
    decide(call, tool, signal) {
      const scope = isGranted(call.name);
      if (scope) {
        return Promise.resolve({
          decision: "approved",
          reason: `已授权（${scope === "session" ? "本次会话" : "永久"}）`,
        } satisfies ApprovalOutcome);
      }
      return ui.decide(call, tool, signal);
    },
  };
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

/** 一律拒绝的审批人（ADR-0047）。给 approval: "deny" 的 subagent 用——
    子 agent 没人盯着屏幕，"弹卡等人"在它身上等于永久挂起。
    拒绝照样流经审批门 → approval_decision 照常落盘，日志永远记着
    "这一步是被配置拒的"（reason 说明），行为可从日志推导。
    刻意不短路到"工具压根不挂"：模型试一次、吃一个明确的拒绝，比对着一把
    不存在的工具瞎猜下一步更省 token，也更好排查 */
export const denyingApprover: Approver = {
  decide: () =>
    Promise.resolve({
      decision: "denied" as const,
      reason: "这个 subagent 被配置为拒绝一切需要审批的操作（approval: deny）",
    }),
};
