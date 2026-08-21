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
  /** .md 绝对路径 */
  path: string;
  /** 哪个根目录来的 */
  source: string;
  /** ~/.claude/agents/ 扫来的 = true：不去改用户 Claude Code 的配置 */
  readOnly: boolean;
}
