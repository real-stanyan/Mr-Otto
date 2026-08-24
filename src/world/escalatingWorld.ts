// 沙箱升级环（issue #346，codex orchestrator 对照）—— withAbortSignal 同款
// 装饰器手法：把"沙箱拒绝 → 带失败原因二次审批 → 无沙箱重跑"焊进 world.exec，
// 工具照旧只调 world.exec(cmd)，对升级环的存在无感（硬规则原样成立）。
//
// 只包 exec：升级环解决的是"命令被沙箱拦了"（codex 的场景就是它）。fs 读写
// 在 v2 里天然落在容器文件系统内，不存在"逃逸到宿主盘重写"的合法语义——
// 真需要时另开决定，不顺手预埋。
//
// v1 装配不建这个环（LocalWorld 无沙箱，tier "none" 没有可升级的东西）；
// 单测用假 world 钉住协议，v2 SandboxWorld 按 sandbox.ts 的契约抛
// SandboxDeniedError 即可接上，协议一字不改。

import type { ExecOptions, ExecResult, ExecutionWorld } from "./executionWorld.js";
import { isSandboxDenied, type SandboxPolicy } from "./sandbox.js";

export interface EscalationRequest {
  /** 被拦的命令（原样） */
  command: string;
  /** 沙箱给出的失败原因（SandboxDeniedError.reason），二次审批弹窗要带上它 */
  reason: string;
}

export interface EscalationOptions {
  policy: SandboxPolicy;
  /** 二次审批：问人"沙箱拒绝了，要不要无沙箱重跑"。true = 同意。
      装配层把它接到审批 UI + 落盘（全链路事件），这里只管问 */
  requestEscalation(req: EscalationRequest): Promise<boolean>;
}

/** 升级被硬拒时抛给工具的错误（进 tool_result.output，模型能读到人话） */
function denyReadRefusal(reason: string): Error {
  return new Error(
    `沙箱拒绝：${reason}。该策略含拒读路径，不允许升级到无沙箱重跑` +
      `——拒读只有沙箱能实施，逃逸等于对拒读清单的静默授权（issue #346）`
  );
}

/**
 * 把升级环焊进 world.exec。语义按档位：
 * - tier "container"：sandboxed.exec 抛 SandboxDeniedError → 二次审批
 *   （带失败原因）→ 同意则 unsandboxed.exec 重跑，拒绝则原错误上抛。
 *   **policy 含拒读路径时升级分支硬拒**（不问人，直接抛；见 sandbox.ts）。
 * - tier "external"：已在外部沙箱内——没有"更外面的无沙箱"可逃逸，
 *   环不存在，本函数不该被调（调了就是装配错误，直接抛）。
 * - tier "none"：同上，无沙箱无环。
 * 其余能力（fs/http/…）原样透传自 sandboxed。
 */
export function withSandboxEscalation(
  sandboxed: ExecutionWorld,
  unsandboxed: ExecutionWorld,
  opts: EscalationOptions
): ExecutionWorld {
  if (opts.policy.tier !== "container") {
    // external：沙箱在外部，全盘访问已经给了、网络约束仍在外部实施——
    // 本进程没有可升级的档位。none：压根没有沙箱。两者建环都是装配 bug
    throw new Error(`沙箱升级环只适用于 container 档位（当前 ${opts.policy.tier}）`);
  }
  const denyRead = (opts.policy.denyReadPaths?.length ?? 0) > 0;

  const exec = async (cmd: string, execOpts?: ExecOptions): Promise<ExecResult> => {
    try {
      return await sandboxed.exec(cmd, execOpts);
    } catch (err) {
      // 只认确定性标记（issue #346 ④）：普通失败照常上抛，升级环不掺和
      if (!isSandboxDenied(err)) throw err;
      if (denyRead) throw denyReadRefusal(err.reason);
      const approved = await opts.requestEscalation({ command: cmd, reason: err.reason });
      if (!approved) throw err;
      // 同意 = 无沙箱重跑。直播回调/中断信号原样带过去——重跑仍是这次调用
      return unsandboxed.exec(cmd, execOpts);
    }
  };

  return { ...sandboxed, exec };
}
