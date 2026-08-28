// dirtyTreeApprover —— 破坏性 git + 工作区脏 = 必须问人（issue #633，ADR-0153）
//
// 挂在审批链上，位置有意：**在 policy-aware 里面、mode-aware 外面**。
//   policyAware( dirtyTree( modeAware( grantAware( ui ) ) ) )
// 于是：
//   - 用户亲手写的 execpolicy `forbidden` 仍然最先赢（那是「永不放行」）；
//   - 但「完全访问」模式和任何长期授权**压不过这一条**——命中时直接问 UI，
//     绕开 modeAware/grantAware 的短路。
//
// 越过用户选的 bypass 模式是**故意的**，理由与 forbiddenGuard 同款：bypass 说的是
// 「机器上的操作我都认」，而这里要丢的东西**可能根本不是水獭做的**——用户自己在
// 编辑器里改了一半没提交的活也在里面。这一下值得打断。
//
// 摩擦只在真的会丢东西时出现：工作区干净 = 一路放行，与从前逐字节一致。
//
// dirtyFiles 由装配根注入（index.ts）——本模块不碰 child_process，可单测。

import type { Approver, ApprovalOutcome } from "../loop/approvalGate.js";
import { destructiveGit, dirtyWarning } from "../shared/gitSafety.js";

export interface DirtyTreeApproverDeps {
  /** 工作区里带未提交改动的文件（含未跟踪）。读不到 → 抛，调用方按「读不到」处理 */
  dirtyFiles: (cwd: string) => Promise<string[]>;
  /** 这个会话的围栏根 */
  cwd: string;
}

export function createDirtyTreeAwareApprover(
  deps: DirtyTreeApproverDeps,
  inner: Approver,
  /** 命中时直接找的那个人（UI）——绕开 mode/grant 的短路 */
  ui: Approver
): Approver {
  return {
    async decide(call, tool, signal) {
      if (call.name !== "bash") return inner.decide(call, tool, signal);
      const cmd = (call.args as { cmd?: unknown } | null)?.cmd;
      if (typeof cmd !== "string") return inner.decide(call, tool, signal);

      const d = destructiveGit(cmd);
      if (!d) return inner.decide(call, tool, signal);

      let dirty: string[];
      try {
        dirty = await deps.dirtyFiles(deps.cwd);
      } catch {
        // 读不到工作区状态（不是 git 仓 / git 不在 / 目录没了）：不知道脏不脏就不加摩擦。
        // fail-open 在这里是对的——这一层是**额外**的一道，不是唯一那道：
        // 审批链原来的判定照常继续，该弹卡的还是会弹
        return inner.decide(call, tool, signal);
      }
      if (dirty.length === 0) return inner.decide(call, tool, signal);

      const outcome = await ui.decide(call, tool, signal);
      // 带上「会丢什么」——UI 拿 reason 展示；被拒时这句也进 tool_result，
      // 模型据此知道该先 commit 而不是换个写法再试一次
      return {
        ...outcome,
        reason: outcome.reason
          ? `${dirtyWarning(d, dirty)}\n\n${outcome.reason}`
          : dirtyWarning(d, dirty),
      } satisfies ApprovalOutcome;
    },
  };
}
