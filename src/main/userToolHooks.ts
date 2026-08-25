// 用户钩子 → engine ToolHook 适配器（issue #395，Claude Code hooks 对照）。
//
// engine 的钩子基础设施（Pre/PostToolUse + tool_hook 落盘，issue #350）早就
// 在了，这里只做翻译：hooks.json 里的一条声明 = 一只 ToolHook，pre/post 里
// 跑用户命令、把 stdout 的 JSON 裁决翻成 PreHookResult/PostHookResult。
// 干预的落盘归 engine 统一管——钩子作者碰不到日志，也碰不坏日志。
//
// exec 从外面注入（组装根给 LocalWorld.exec，cwd = 工作区、凭据已剥、
// 带 stdin）：本模块不碰 child_process，v2 想让钩子跑在别处只换注入。
// 失败语义全线 fail-open（弃权 + console.warn）：钩子是观察/干预者，不是
// 安全边界——安全边界是守卫（deny-only）和审批门（middleware.ts 的立场）。

import type { ToolHook } from "../loop/middleware.js";
import type { ExecResult } from "../world/executionWorld.js";
import {
  exit2Reason,
  parsePostVerdict,
  parsePreVerdict,
  type UserHookDef,
  type UserHookInput,
} from "../shared/userHooks.js";

/** 钩子进程的硬超时：与 engine 的 HOOK_TIMEOUT_MS（10s 弃权）对齐——
    engine 那边 10s 就不等裁决了，进程多活也只是烧 CPU */
export const USER_HOOK_EXEC_TIMEOUT_MS = 10_000;

export type HookExec = (
  cmd: string,
  opts: { stdin: string; timeoutMs: number }
) => Promise<ExecResult>;

async function runHookCommand(
  exec: HookExec,
  def: UserHookDef,
  input: UserHookInput
): Promise<ExecResult | null> {
  try {
    return await exec(def.command, {
      stdin: JSON.stringify(input),
      timeoutMs: USER_HOOK_EXEC_TIMEOUT_MS,
    });
  } catch (err) {
    // exec reject 只发生在外力中断（ADR-0006）——turn 都停了，裁决无意义
    console.warn(`[userHooks] 钩子「${def.name}」执行失败，按弃权处理`, err);
    return null;
  }
}

/** 把校验过的用户钩子声明翻成 engine 认的 ToolHook。每次调用现翻（无状态、
    零缓存）——engine 的 hooks getter 每次工具调用现读配置，热更新由此免费 */
export function buildUserToolHooks(
  defs: readonly UserHookDef[],
  exec: HookExec,
  workspace?: string
): ToolHook[] {
  return defs.map((def): ToolHook => {
    const base = { name: def.name, tools: def.tools };
    if (def.phase === "pre") {
      return {
        ...base,
        async pre(ctx) {
          const res = await runHookCommand(exec, def, {
            phase: "pre",
            tool: ctx.call.name,
            toolCallId: ctx.call.id,
            args: ctx.call.args,
            ...(workspace ? { workspace } : {}),
          });
          if (!res) return undefined;
          if (res.exitCode === 2) return { block: exit2Reason(res.stdout, res.stderr) };
          if (res.exitCode !== 0) {
            console.warn(`[userHooks] 钩子「${def.name}」exit ${res.exitCode}，按弃权处理`);
            return undefined;
          }
          return parsePreVerdict(res.stdout) ?? undefined;
        },
      };
    }
    return {
      ...base,
      async post(ctx, outcome) {
        const res = await runHookCommand(exec, def, {
          phase: "post",
          tool: ctx.call.name,
          toolCallId: ctx.call.id,
          args: ctx.call.args,
          status: outcome.status,
          output: outcome.output,
          ...(workspace ? { workspace } : {}),
        });
        if (!res) return undefined;
        if (res.exitCode === 2) return { reject: exit2Reason(res.stdout, res.stderr) };
        if (res.exitCode !== 0) {
          console.warn(`[userHooks] 钩子「${def.name}」exit ${res.exitCode}，按弃权处理`);
          return undefined;
        }
        return parsePostVerdict(res.stdout) ?? undefined;
      },
    };
  });
}
