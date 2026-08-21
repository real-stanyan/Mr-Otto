// SubagentDef — 一个用户定义的 subagent。渲染层（设置页）和主进程（runner）共用。
// 纯类型 + 常量，不碰 fs：渲染层 import 它不该拖进主进程模块。

import type { ThinkingMode } from "./thinking.js";

/** subagent 碰到危险工具时怎么办。
    比 ApprovalMode（"ask" | "auto"）多一档 "deny"：子 agent 没人盯着，
    "一律拒绝"是它才需要的默认，主会话不需要（用户就在屏幕前） */
export type SubagentApproval = "ask" | "auto" | "deny";

/** 缺省工具集：只读那几把。
    缺 tools 字段 ≠ "全给" —— 派出去的 agent 默认不该有 bash 和 write_file */
export const DEFAULT_SUBAGENT_TOOLS: readonly string[] = [
  "read_file",
  "web_search",
  "web_extract",
  "todo_write",
];

/** 定义住在哪一层。工作区级只在本工程的会话里可用（ADR-0048） */
export type SubagentScope = "user" | "workspace";

/** 一个子智能体的前置词取哪儿来。
    custom 是**覆盖**全局而不是追加：追加的话它和 instructions 拼起来对模型
    完全一样，那它就只是 UI 分栏，没有 instructions 表达不了的能力 */
export type SubagentPreamble =
  | { mode: "default" }
  | { mode: "off" }
  | { mode: "custom"; text: string };

/** 内置的全局前置词。用户没在 ~/.otter/subagent-preamble.md 写自己的那份时用它。
    放 shared 不放 runner：设置页要拿它当「恢复默认」后显示的正文 */
export const DEFAULT_PREAMBLE =
  "你是被派来做一件具体任务的子 agent。你的最终一段文本就是返回值——" +
  "它会直接交回给派你来的那个 agent，不是给人看的消息。" +
  "做完就把结论写出来，不要寒暄，不要问「还需要什么帮助吗」。" +
  "你看不到派你来的那个 agent 和用户的对话，任务里没写的背景你就是不知道；" +
  "缺信息时在汇报里说清缺什么，别猜。";

/** context 只收 basename。这是安全边界不是格式洁癖：定义文件可能是用户从别处
    抄来的，收全路径就等于让一份 .md 变成任意文件读取原语。
    解析时挡一次、运行时读盘前再挡一次（两处独立判断比互相信任更皮实） */
export function isSafeContextFile(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !/[/\\,]/.test(name);
}

/** 合法的 subagent 名字：只有它会变成磁盘上的文件名（`<名字>.md`），也只有它
    是模型调 task 时要打出来的那个词。
    定义放 shared：主进程和设置页共用同一条规则——两边各写一条正则，迟早分家
    （曾经就是：渲染层挡住了中文，主进程那侧把中文 replace 成 "-"，
    "搜索员" 塌成 "---" 照样建出来，review I6） */
export const SUBAGENT_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** 名字不合法时的说法（两侧同一句，用户在哪看到都一样）。
    合法就回 null */
export function subagentNameError(name: string): string | null {
  if (!name) return "名字不能为空";
  return SUBAGENT_NAME_RE.test(name)
    ? null
    : "名字只能用英文字母、数字、下划线、连字符——这是模型调 task 工具时要打出来的名字";
}

export interface SubagentDef {
  name: string;
  /** 写给**模型**看的：它进 task 工具的 def，模型靠它挑人。
      这是它和 SkillInfo.description（只给人看）最大的不同 */
  description: string;
  /** frontmatter 之后的正文（system prompt 本体，不含 runner 拼的内置前言） */
  instructions: string;
  /** 已过滤，只剩本仓认识的工具名 */
  tools: string[];
  /** 认不出的原样留着——设置页标注「N 个工具名无法识别」，不让整个 subagent 报废 */
  unknownTools: string[];
  /** 缺席 = 跟主会话当前模型 */
  model?: string;
  /** 缺席 = 该型号默认档（落地前过 clampThinking） */
  thinking?: ThinkingMode;
  approval: SubagentApproval;
  /** 前置词从哪儿来。缺席的老文件解析成 { mode: "default" } */
  preamble: SubagentPreamble;
  /** 派活时按会话 workspace 读进来拼在正文前的文档（basename，已过滤） */
  context: string[];
  /** 用户级还是工作区级。由扫到它的那条根目录决定，不来自文件内容 */
  scope: SubagentScope;
  /** .md 绝对路径 */
  path: string;
  /** 哪个根目录来的 */
  source: string;
  /** ~/.claude/agents/ 扫来的 = true：不去改用户 Claude Code 的配置 */
  readOnly: boolean;
}
