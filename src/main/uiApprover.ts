// UIApprover — Approver 的 GUI 实现：把"问人"变成一次 UI 往返。
// decide() 返回一个不 resolve 的 Promise → 整条工具管线在审批门里悬停，
// 直到渲染进程按了按钮、IPC 调 resolve(toolCallId, outcome) 把它唤醒。
// 引擎对此毫无感知——它只是在 await 一个接口方法。

import type { Approver, ApprovalOutcome } from "../loop/approvalGate.js";
import { evaluateCommand, type ExecRule } from "../shared/execPolicy.js";
import type { Tool } from "../tools/tool.js";
import type { ToolCallRequest } from "../session/events.js";
import type {
  ApprovalDecisionKind,
  ApprovalDecisionOutcome,
  ApprovalMode,
} from "../shared/shellBridge.js";

export type { ApprovalMode };

/** 这张审批卡可以出示哪些按钮（issue #341 规则①：后端下发，前端不硬编码）。
    永久档只有装配里真有永久授权存储时才出现——按不出效果的按钮不该被画出来 */
export function availableDecisionsFor(opts: { hasAlwaysStore: boolean }): ApprovalDecisionKind[] {
  return [
    "deny",
    "abort",
    "approve_session",
    ...(opts.hasAlwaysStore ? (["approve_always"] as const) : []),
    "approve",
  ];
}

/** IPC 进来的决定 → 审批门吃的 outcome + 是否要顺带中止 turn（issue #341 规则②）。
    "abort" 映射成 denied + abortTurn：approval_decision 事件 schema 不加宽
    （旧日志重放路径零变化），中止本身以 turn_ended:"aborted" 落盘。
    reason 兜底：abort 没写原因也要给模型一句能懂的话 */
export function mapApprovalDecision(incoming: ApprovalDecisionOutcome): {
  outcome: ApprovalOutcome;
  abortTurn: boolean;
} {
  if (incoming.decision === "abort") {
    return {
      outcome: { decision: "denied", reason: incoming.reason ?? "用户在审批卡上中止了整个 turn" },
      abortTurn: true,
    };
  }
  return {
    outcome: {
      decision: incoming.decision,
      ...(incoming.reason ? { reason: incoming.reason } : {}),
      ...(incoming.grant ? { grant: incoming.grant } : {}),
      ...(incoming.revisedArgs !== undefined ? { revisedArgs: incoming.revisedArgs } : {}),
    },
    abortTurn: false,
  };
}

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

  /** fail-closed（issue #341 规则③）：审批等待通道断了（渲染进程崩/永远回不来），
      把所有挂起审批立刻按拒绝收场——决定照旧流经审批门落 approval_decision，
      日志能解释"为什么没执行"。任何异常路径收敛到「不执行」，永远不悬停等一个
      不存在的人。幂等：没有挂起项就是 no-op */
  failPending(reason: string): void {
    const outcome: ApprovalOutcome = { decision: "denied", reason };
    for (const [id, wake] of [...this.pending]) {
      this.pending.delete(id);
      this.pendingTool.delete(id);
      wake(outcome);
    }
  }

  /** 这个挂起中的调用是哪个工具。已收场/不认识的返 undefined —— 调用方据此不授权 */
  toolFor(toolCallId: string): string | undefined {
    return this.pendingTool.get(toolCallId)?.call.name;
  }

  /** 挂起中的完整调用（含 args）。授权 key 要从参数算（issue #342），
      光有工具名不够——同 toolFor 的语义：不认识 = 不授权 */
  callFor(toolCallId: string): ToolCallRequest | undefined {
    return this.pendingTool.get(toolCallId)?.call;
  }

  /** 此刻挂着的审批(给 UI 补快照用)。一个会话同一时刻至多挂一张卡 ——
      工具管线是串行的,审批门里悬停的只会有一个 —— 所以取第一个就是那一个。
      没有挂起项返 undefined:岛窗据此显示"没有待审批" */
  pendingRequest(): { call: ToolCallRequest; tool: Tool } | undefined {
    for (const entry of this.pendingTool.values()) return entry;
    return undefined;
  }
}

/** 授权感知的 Approver：这次调用已经被授过权(本会话 / 永久)就直接放行，不弹卡。
    ADR-0041；判定粒度是规范化 key 而非整个工具（issue #342，见 shared/grantKey.ts），
    所以把完整调用（含 args）递给判定函数。放行照旧流经审批门 → approval_decision
    照常落盘，reason 写明是哪一档授权放的行 —— 日志里不会出现"没人批过就跑了"
    的危险操作。

    每次 decide 现查（两个都是活引用）：会话中途授的权，下一个调用立即生效；
    永久授权文件被改了，也不用重启。 */
export function createGrantAwareApprover(
  isGranted: (call: ToolCallRequest) => "session" | "always" | undefined,
  ui: Approver
): Approver {
  return {
    decide(call, tool, signal) {
      const scope = isGranted(call);
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
/** execpolicy 感知的 Approver（issue #347）：bash 命令先过声明式前缀规则。
    forbidden = 硬拒（放在链条最外层——连 bypass 模式都压不过它：规则是用户
    亲手写的"永不放行"）；allow = 免弹卡放行；prompt/没意见 = 交给内层
    （审批记忆 → 模式 → 弹卡）。每次 decide 现读规则（getPolicy 是活引用）——
    审批 UI 追加规则后下一次判定立即生效（热更新），跨会话由文件天然承担。
    非 bash 工具、复杂脚本（token 化失败）不掺和——静态判定只管它说得清的 */
export function createPolicyAwareApprover(
  getPolicy: () => { rules: ExecRule[] },
  cwd: string | undefined,
  inner: Approver,
  // #876：execpolicy 的「allow 降级 prompt」不该压过「免审批」——auto 模式下
  // prompt 直接批准。forbidden 仍然硬拒（用户亲手写的"永不放行"比免审批更硬）。
  getMode?: () => ApprovalMode
): Approver {
  return {
    decide(call, tool, signal) {
      if (call.name === "bash") {
        const cmd = (call.args as { cmd?: unknown } | null)?.cmd;
        if (typeof cmd === "string") {
          const verdict = evaluateCommand(cmd, getPolicy().rules, cwd);
          if (verdict?.decision === "forbidden") {
            return Promise.resolve({ decision: "denied", reason: verdict.reason } satisfies ApprovalOutcome);
          }
          if (verdict?.decision === "allow") {
            return Promise.resolve({ decision: "approved", reason: verdict.reason } satisfies ApprovalOutcome);
          }
          // prompt / undefined：auto 模式直接批，否则往里走
          if (verdict?.decision === "prompt" && getMode?.() === "auto") {
            return Promise.resolve({ decision: "approved", reason: `自动批准（execpolicy prompt 降级，免审批模式）` } satisfies ApprovalOutcome);
          }
        }
      }
      return inner.decide(call, tool, signal);
    },
  };
}

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
