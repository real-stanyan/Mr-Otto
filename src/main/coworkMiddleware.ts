// coworkMiddleware —— 让两只水獭在同一个文件夹里各干各的活，而不是排队（issue #658）
//
// 三件事，都挂在工具管线上：
//   1. **记账**：write_file 成功之后，往工作区的协作记录里追一条「谁、几点、
//      动了哪个文件、为什么」。
//   2. **按需注入**：read_file 读到一个别的水獭最近动过的文件时，在结果尾巴上
//      补一句「它被谁改过、为什么」。不是每轮灌整本——本子会长，上下文不跟着长。
//   3. **文件级的闸**：要覆盖的文件在「我上次看过它」之后被别的家族改过 → 拦一次，
//      要求先重读。不同文件一律放行，这是这套东西的重点。
//
// 为什么拦**一次**就放行：模型收到错误后的默认反应是重试。如果每次都拦，一个不肯
// 重读的模型会原地死循环，把一次协作问题变成一次挂死。拦一次已经把事实摆到它眼前
// （谁改的、为什么、去重读），它坚持要写，那是它带着完整信息做的决定。
//
// 覆盖不到的：bash 里的 `mv` / `rm` / 重定向。工具管线看得见 write_file 的参数，
// 看不懂一条 shell 命令要动哪些文件。这是这套机制的天花板，写在 ADR-0161 里——
// git 仓那条路不靠它（各自拿独立副本，ADR-0157），非 git 文件夹里这类命令本来少见。

import type { ToolMiddleware, ToolOutcome } from "../loop/middleware.js";
import {
  fileNoticeFor,
  staleWrite,
  staleWriteMessage,
  type CoworkRecord,
} from "../shared/coworkLog.js";
import { appendRecord, readRecords, relativeInWorkspace, trimIfNeeded } from "./coworkLogFile.js";

export interface CoworkOptions {
  workspace: string;
  sessionId: string;
  /** 这个会话 id 跟我是不是一家人（子会话 / SideChat）。同家族不互拦——
      它们共享工作区是故意的，父 turn 跑着的时候子会话就在跑（沿用 ADR-0152） */
  isMyFamily: (sessionId: string) => boolean;
  /** 会话标题，模型没写 reason 时拿它兜底（「在做什么」比什么都不写强） */
  title: () => string | null;
  /** 注入的时钟与时区，测试里换掉 */
  now?: () => number;
  tzOffsetMinutes?: () => number;
}

export function createCoworkMiddleware(opts: CoworkOptions): ToolMiddleware {
  const now = opts.now ?? (() => Date.now());
  const tz = opts.tzOffsetMinutes ?? (() => -new Date().getTimezoneOffset());
  /** 我最后一次看见每个文件是什么时候（读到 / 写成都算「看见」）。
      运行时状态，随会话生死——重启后当没看过，于是第一次覆盖别人动过的文件
      会被拦一次。这正是想要的：重启之后我手上那份内容确实是旧的 */
  const lastSeen = new Map<string, number>();
  /** 已经为「这个文件的这一次外来改动」拦过一回了，不再拦第二次 */
  const warned = new Set<string>();

  const record = (rel: string, reason: string): CoworkRecord => ({
    ts: now(),
    sessionId: opts.sessionId,
    path: rel,
    reason,
  });

  return async (ctx, next) => {
    const name = ctx.call.name;
    if (name !== "write_file" && name !== "read_file") return next();

    const args = ctx.call.args as { path?: unknown; reason?: unknown } | null;
    const rawPath = args?.path;
    // 参数出自模型，不赌形状：不像样就放行（工具自己会报错）
    if (typeof rawPath !== "string" || rawPath === "") return next();
    const rel = relativeInWorkspace(opts.workspace, rawPath);
    if (rel === null) return next(); // 围栏外的文件不属于「这个文件夹里的分工」

    if (name === "read_file") {
      const outcome = await next();
      if (outcome.status !== "ok") return outcome;
      lastSeen.set(rel, now());
      const notice = fileNoticeFor(await readRecords(opts.workspace), rel, opts.isMyFamily, tz());
      return notice ? { ...outcome, output: `${outcome.output}\n\n${notice}` } : outcome;
    }

    // ── write_file ──
    const records = await readRecords(opts.workspace);
    const foreign = staleWrite(records, rel, lastSeen.get(rel) ?? null, opts.isMyFamily);
    if (foreign) {
      const key = `${rel}@${foreign.ts}`;
      if (!warned.has(key)) {
        warned.add(key);
        const blocked: ToolOutcome = { status: "error", output: staleWriteMessage(rel, foreign) };
        return blocked; // 短路：工具不执行，文件一个字节都不动
      }
    }

    const outcome = await next();
    if (outcome.status !== "ok") return outcome;
    lastSeen.set(rel, now());
    const reason = typeof args?.reason === "string" && args.reason ? args.reason : (opts.title() ?? "");
    await appendRecord(opts.workspace, record(rel, reason), tz());
    await trimIfNeeded(opts.workspace);
    return outcome;
  };
}
