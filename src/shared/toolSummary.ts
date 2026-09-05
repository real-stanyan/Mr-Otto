// 工具调用的一行摘要 —— 从 args 里挑出人看得懂的那一点。
// 从 App.tsx 抽出来:工具行和工具折叠组都要用,谁也不该 import 谁

import type { ToolCallRequest } from "../session/events.js";
import { ASK_USER_TOOL_NAME, parseAskUserArgs } from "../tools/askUser.js";
import { parseTodoArgs, TODO_TOOL_NAME } from "../session/deriveTodos.js";
import { CREATE_AGENT_TOOL_NAME } from "./createAgentDraft.js";

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
    case CREATE_AGENT_TOOL_NAME:
      return { verb: "创建智能体", target: str("name"), stat: "" };
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

/** 折叠头那一行:这一段干了多久、用了几把工具、动了几个文件。
    以前这里按动作归并计数(「终端 ×26 · 读取 ×2」)—— 那是一张工具清单,
    折着看等于把展开后的内容抄一遍到头上,步数一多还撑满一行。折叠头该回答的是
    「这一段花了多久、动静有多大」,清单展开自己看(对齐 assistant-ui
    tool-timeline 的 "Worked for 12s · 4 steps · 2 files changed")。

    后半段用英文:这两个数是同一句话里的两个计量,中文量词("2 把工具、1 个文件")
    在这一行里比英文更占地方,而 "tools used / files changed" 本来就是这个版式的原话。

    elapsedMs 为 null = 日志里推不出起止(还没开跑 / 调用被拒,执行器未达),
    那就不报耗时 —— UI 不许拿别的 ts 硬凑一个数。
    filesChanged 为 0 时整段不出现:「0 files changed」是句废话。 */
export function timelineLabel(
  tools: number,
  filesChanged: number,
  elapsedMs: number | null,
  running: boolean,
): string {
  const t = formatSpan(elapsedMs);
  const head = running ? (t === null ? "工作中" : `工作中 ${t}`) : t === null ? null : `工作了 ${t}`;
  const counts = `${tools} ${plural(tools, "tool")} used${
    filesChanged > 0 ? `, ${filesChanged} ${plural(filesChanged, "file")} changed` : ""
  }`;
  return head === null ? counts : `${head} · ${counts}`;
}

const plural = (n: number, word: string): string => (n === 1 ? word : `${word}s`);

/** 明显不可能的耗时(时钟跳变、系统挂起)当坏数据丢掉 —— 同 thinkingLabel 的立场 */
const MAX_SANE_MS = 3_600_000;

/** 一段时长的人话。不到一秒走毫秒(「0.4s」不如「420ms」精确,「0.0s」等于没说),
    到分钟就别再报小数 —— 跑了三分钟的那一段,零点几秒的精度没有意义 */
function formatSpan(ms: number | null): string | null {
  if (ms === null || ms < 0 || ms > MAX_SANE_MS) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}分${total % 60}秒`;
}

// ─── 工具行的小图标 ───
// 返回 lucide 的图标名（string）而不是组件：这个文件在 src/shared/，
// 主进程也在 import——直接 import lucide-react 会把 React 组件库拽进
// 主进程的依赖图。渲染层 OttoThread 拿这个名字去查表。

/** 工具名 → lucide 图标名。认不出的给 "Wrench"。
    读写文件故意给 null：它们走 FileTypeIcon（文件类型图标比一枚通用
    的 Read/Pencil 有信息量），调用方自己决定 fallback */
export function toolIcon(name: string): string | null {
  switch (name) {
    case "read_file":
    case "write_file":
      return null; // 走 FileTypeIcon
    case "bash":
      return "SquareTerminal";
    case "web_search":
    case "session_search":
      return "Search";
    case "web_extract":
    case "browser_read":
      return "Globe";
    case "task":
      return "Bot";
    case "ask_user":
      return "MessageCircleQuestion";
    case "todo_write":
      return "ListChecks";
    case "memory":
      return "Brain";
    default:
      return "Wrench"; // MCP 工具、认不出的——通用扳手
  }
}
