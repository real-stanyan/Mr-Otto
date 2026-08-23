// 工具调用的一行摘要 —— 从 args 里挑出人看得懂的那一点。
// 从 App.tsx 抽出来:工具行和工具折叠组都要用,谁也不该 import 谁

import type { ToolCallRequest } from "../session/events.js";
import { ASK_USER_TOOL_NAME, parseAskUserArgs } from "../tools/askUser.js";
import { parseTodoArgs, TODO_TOOL_NAME } from "../session/deriveTodos.js";

/** orb 的几档状态。原本是 App.tsx 里的局部 type(645 行),
    toolPhase 搬过来就跟着搬——agentPhase 还留在 App.tsx,从这里 import 回去 */
export type OrbState =
  | "listening"
  | "searching"
  | "working"
  | "composing"
  | "solving"
  | "breathing"
  | "weaving";

/** 工具执行阶段 → orb + 文案。read_file 是"找"，todo_write 是"想"，其余(bash/write)是"做" */
export function toolPhase(name: string): { orb: OrbState; label: string } {
  if (name === "read_file") return { orb: "searching", label: "检索中…" };
  if (name === TODO_TOOL_NAME) return { orb: "composing", label: "整理清单…" };
  // 提问时管线其实停着等人，不该显示"执行中"——它在等你
  if (name === ASK_USER_TOOL_NAME) return { orb: "composing", label: "等你回答…" };
  return { orb: "working", label: "执行中…" };
}

/** 工具调用摘要行的文案：动词 + 目标 + 统计（Claude Code 版式）。
    全部从 call.args 推导——UI 不知道工具"做了什么"，只知道日志里请求了什么 */
export function toolSummary(call: ToolCallRequest): { verb: string; target: string; stat: string } {
  const a = (call.args ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
  switch (call.name) {
    case "write_file": {
      const content = str("content");
      return {
        verb: "写入",
        target: str("path").split("/").pop() ?? "",
        stat: content ? `+${content.split("\n").length} 行` : "",
      };
    }
    case "read_file":
      return { verb: "读取", target: str("path").split("/").pop() ?? "", stat: "" };
    case "bash":
      return { verb: "终端", target: str("cmd"), stat: "" };
    case ASK_USER_TOOL_NAME: {
      const questions = parseAskUserArgs(call.args) ?? [];
      return {
        verb: "提问",
        target: questions[0]?.question ?? "",
        stat: questions.length > 1 ? `${questions.length} 题` : "",
      };
    }
    case TODO_TOOL_NAME: {
      // 目标位显示当前在做的那项——一行摘要里最有信息量的就是它
      const items = parseTodoArgs(call.args) ?? [];
      const doing = items.find((t) => t.status === "in_progress");
      const done = items.filter((t) => t.status === "completed").length;
      return {
        verb: "任务清单",
        target: doing?.text ?? "",
        stat: items.length > 0 ? `${done}/${items.length}` : "",
      };
    }
    default:
      return { verb: call.name, target: "", stat: "" };
  }
}

/** 这次调用动的是哪个文件的**完整路径**;不碰文件的工具返回 null。
    单独一支而不是让 toolSummary 多带一个字段:摘要里的 target 已经被砍成了
    basename(那一行要短),而图标要认的是完整路径(路径里可能还有信息,
    比如 tests/ 下的同名文件)。两者要的东西不一样,别硬塞进一个返回值里。

    只认 read_file / write_file:bash 的 target 是一条命令,给它画一枚文件图标
    是在说假话 —— "认不出就别画"和图标本身同样重要 */
export function toolFilePath(call: ToolCallRequest): string | null {
  if (call.name !== "read_file" && call.name !== "write_file") return null;
  const a = (call.args ?? {}) as Record<string, unknown>;
  const path = a["path"];
  return typeof path === "string" && path !== "" ? path : null;
}

/** 折叠头的摘要:按动作归并计数。
    "读取 ×5 · 写入 ×2" 比 "7 个工具调用" 有信息量——折着也知道这一段干了什么。
    顺序按首次出现,不按字母/数量重排:那是动作发生的顺序,读者按这个顺序理解 */
export function summarizeGroup(calls: ToolCallRequest[]): string {
  const byVerb = new Map<string, number>();
  for (const c of calls) {
    const { verb } = toolSummary(c);
    byVerb.set(verb, (byVerb.get(verb) ?? 0) + 1);
  }
  return [...byVerb].map(([verb, n]) => `${verb} ×${n}`).join(" · ");
}
