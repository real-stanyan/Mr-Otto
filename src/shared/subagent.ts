// SubagentDef — 一个用户定义的 subagent。渲染层（设置页）和主进程（runner）共用。
// 纯类型 + 常量，不碰 fs：渲染层 import 它不该拖进主进程模块。

import type { ThinkingMode } from "./thinking.js";

/** subagent 碰到危险工具时怎么办。
    比 ApprovalMode（"ask" | "auto"）多两档：
    - "deny"：一律拒绝。子 agent 没人盯着，这是它才需要的默认，主会话不需要
      （用户就在屏幕前）
    - "inherit"：跟父会话此刻那一档走——用户开了免审批就免审批，没开就把卡弹给他。
      不复用 "ask" 来表达这件事：那会让所有已有的 `approval: ask` 定义在用户开
      bypass 时**静默变成放行**，而写 ask 的人意思就是问我。内置那两份用它
      （builtinSubagents），用户自己的定义写得出来但界面上不给编 */
export type SubagentApproval = "ask" | "auto" | "deny" | "inherit";

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

/** 全局前置词 —— 拼在每个子智能体正文前面的那一段。写死在代码里，不给用户改。
 *
 * 曾经它住在 ~/.mr-otto/subagent-preamble.md、设置页有一张卡可以编。删掉的理由是
 * 这段话说的是**协议事实**而不是偏好：「你的最终一段文本就是返回值」「你看不到
 * 父会话的对话」——它们描述的是这个 harness 的运行方式。用户删掉第一句，此后每个
 * 子智能体都会开始写寒暄，而父 agent 拿到的返回值就是那句寒暄，界面上不报任何错。
 * 一个改坏了没有反馈的旋钮，不如没有。
 *
 * 需要覆盖的场合已经有出口：每份定义自己的 preamble 三档（自定义 / 不加 / 用全局）。
 *
 * 用英文：模型对英文指令的服从度更稳，而这段话是给模型看的，不是给用户看的。
 * 以后要做多语言，换掉这一个常量就够——它是唯一的出处 */
export const DEFAULT_PREAMBLE =
  "You are a subagent dispatched to carry out one specific task. " +
  "Your final block of text IS the return value: it goes straight back to the agent that " +
  "dispatched you, not to a human reader. When you are done, state the conclusion — no " +
  "pleasantries, and never ask whether there is anything else you can help with. " +
  "You cannot see the conversation between that agent and the user, so any background the " +
  "task text does not spell out is background you do not have; when something is missing, " +
  "say what is missing in your report instead of guessing.";

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
  /** 父会话已启用的 skill 是否随派活下发（ADR-0068）。缺席 = 继承（用户 $ 启用的
      行为约束默认覆盖整个任务，包括派出去的部分——ponytail 的 fail-open 同思路）；
      "none" = 本 subagent 明确不收（机械型/分类型 agent 不该被行为 skill 污染）。
      可选而不是必填枚举：加必填字段要动每一处构造点，而"没写"和"继承"是同一件事 */
  skills?: "none";
  /** 用户级还是工作区级。由扫到它的那条根目录决定，不来自文件内容 */
  scope: SubagentScope;
  /** .md 绝对路径 */
  path: string;
  /** 哪个根目录来的 */
  source: string;
  /** 不能写回磁盘的 = true。现在只有内置那两份 —— 它们压根不在磁盘上
      （曾经还有 ~/.claude/agents/ 扫来的那些，ADR-0056 之后不再扫） */
  readOnly: boolean;
  /** 随 app 一起发的内置定义（builtinSubagents），不在磁盘上。
      可选而不是必填：加个必填字段要动每一处构造点（含全部测试夹具），
      而"没有这个字段"和"不是内置"是同一件事 */
  builtin?: true;
  /** 磁盘定义，但同名盖住了一份内置（materialize 的产物）。设置页据此把它
      留在「内置」栏（挂"已自定义"徽章）而不是挪去「我的」——用户配了个模型
      不该看起来像内置的那份消失了。可选，理由同 builtin */
  overridesBuiltin?: true;
}
