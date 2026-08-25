// 沙箱档位与升级环协议（issue #346，codex orchestrator.rs 对照）。
//
// v1 只有 LocalWorld（无沙箱），这份协议现在就定下来：v2 Docker 上线时
// SandboxWorld 只需要按这里的契约抛 SandboxDeniedError，升级环
// （world/escalatingWorld.ts）一字不改。
//
// codex 的执行环：审批 → 选沙箱 → 尝试 → 沙箱拒绝 → 带 retry_reason
// 二次审批 → 无沙箱重跑。第一道审批已在工具管线第一层（approvalGate），
// 这里管的是"沙箱拒绝之后"的那半环。

/** 沙箱档位：
    - none      v1 现状：LocalWorld 直接跑在本机，没有沙箱，也就没有升级环
    - external  已在外部沙箱内（用户自带容器/VM 跑整个 app）：允许全盘访问，
                但仍守网络设置——沙箱由外部实施，本进程不再套一层，
                也没有"逃逸到无沙箱"可言（v2 Docker 上线不用改协议，语义现在钉死）
    - container v2：每 bot 一个 Docker 容器（SandboxWorld），沙箱拒绝可走升级环 */
export type SandboxTier = "none" | "external" | "container";

/** 沙箱策略：档位 + 约束。约束的实施者是沙箱实现（v2 SandboxWorld），
    这里只承载"升级环需要读的那部分"语义 */
export interface SandboxPolicy {
  tier: SandboxTier;
  /** 拒读路径（存在即生效）：这些路径连读都不允许。
      **硬约束（issue #346 ③，照抄 codex）：含拒读路径时禁止无沙箱重跑**——
      拒读只有沙箱能实施，逃逸到无沙箱 = 对拒读清单的静默授权 */
  denyReadPaths?: string[];
  /** 网络开关：external 档位下唯一仍然生效的约束（全盘访问但仍守网络设置） */
  networkAllowed?: boolean;
}

/** v1 缺省策略：本机直跑。装配不给 policy 时升级环整个不存在 */
export const NO_SANDBOX: SandboxPolicy = { tier: "none" };

/** 沙箱拒绝的**确定性**标记（issue #346 ④）：升级环只认这个类型，
    不做 stderr 关键词启发式——codex 源码自认那不可靠。判定责任在沙箱实现：
    v2 Docker 有确定的 exit code / OCI 错误可依据，判定出"是沙箱拦的"
    就抛这个；判不出来的失败照常抛普通错误，升级环不掺和 */
export class SandboxDeniedError extends Error {
  /** 给二次审批弹窗看的失败原因（"沙箱拒绝写 /etc/hosts"这种人话） */
  readonly reason: string;

  constructor(reason: string) {
    super(`沙箱拒绝：${reason}`);
    this.name = "SandboxDeniedError";
    this.reason = reason;
  }
}

export function isSandboxDenied(err: unknown): err is SandboxDeniedError {
  return err instanceof SandboxDeniedError;
}

/** 沙箱 enforcement 事实（issue #389，dsh 对照）：命令**跑完了**、但沙箱
    在过程中拦了什么/自身出了什么状况——随 ExecResult 回来的事实，不是错误。
    与 SandboxDeniedError 的分工：整条命令被拒 = 抛错走升级环；命令跑完但
    部分操作被拦（写日志失败但主任务成功这类）= 事实上报，模型自己判断。
    生产者是沙箱实现（v2 SandboxWorld）——判定责任与 SandboxDeniedError 同款
    钉在沙箱侧（确定性依据：seccomp/OCI 错误码），**不做 stderr 关键词启发式**
    （issue #346 ④ 的既有立场，这里只是把判定结果的载体定下来）。
    v1 LocalWorld 无沙箱，永远不产这个字段——协议即测试（ADR-0083 同款交付形态） */
export interface SandboxEnforcementFacts {
  /** full = 策略里的全部约束都在实施中；partial = 有约束没能实施
      （external 档全盘放行只守网络，就是天然的 partial） */
  enforcement: "full" | "partial";
  /** 「沙箱拦了」：被拒绝的具体操作，人话（"写 /etc/hosts 被拒"）。
      每条都该让模型能决定下一步（换路径 / 请求升级 / 放弃） */
  denials?: string[];
  /** 「沙箱坏了」：沙箱自身的异常（profile 加载失败、监控进程退出）——
      与 denials 严格分开：拦截是约束在工作，异常是约束可能已失效 */
  failures?: string[];
}
