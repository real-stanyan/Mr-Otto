// 内置子智能体 —— 随 app 一起发的定义，不在磁盘上。
//
// 为什么不是"首次启动往 ~/.mr-otto/agents 里写两个文件"：那样它们立刻变成用户的
// 文件，以后升级改了正文或工具集，装过老版本的人永远跟不上；而删掉它们又会在
// 下次启动时凭空长回来，看着像 bug。住在代码里，磁盘上同名的定义盖住它（跟
// "工作区盖用户"同一条规则），想改就 materialize 成自己那一份——这条路是显式的。
//
// 一个后果写在这儿：清单从此永远非空，于是 **task 工具永远挂着**（agent.ts 里
// "挂没挂一次定终身"那段）。以前不配 subagent 的用户，模型没有派活这个选项；
// 现在有了，它的 def 也常驻上下文。这是要的效果，不是副作用，但不是纯增量。

import { type SubagentDef } from "../shared/subagent.js";
import { DEFAULT_MODEL } from "../shared/modelCatalog.js";
import { tierRuleText, topicRuleText } from "../shared/memoryStore.js";

/** 内置定义的 source —— 设置页拿它当"这份来自哪儿"显示。不是路径：它没有路径 */
export const BUILTIN_SOURCE = "内置";

/** 除 task 外全给。task 不在这里排除也会被 parse/装配剔掉（子 agent 不能再派子
    agent 是设计边界），列在这里只是不想让读代码的人以为它漏了。
    skill 在里面（ADR-0122 的 D9：子会话自己也拿得到说明书）——这份白名单是
    `allowTools`，不点名就等于没有，所以漏了它 general-purpose 连挂都挂不上。
    一把 skill 都没装的机器上它会被下面的 knownTools 过滤掉，这是对的：
    那种机器上这把刀本来就 available() === false */
const ALL_TOOLS = [
  "read_file",
  "write_file",
  "bash",
  "web_search",
  "web_extract",
  "browser_read",
  "todo_write",
  "skill",
];

/** 内置那三份钉死在便宜档（ADR-0108）。以前它们不写 model，靠 createAgent 的
    兜底默认落到同一个型号上——数值一样，但那是"没人做过的选择"，而现在
    「不写 model」的含义已经变成**跟着父会话走**：不钉的话，用户在贵档会话里
    随手派个 Explore 横扫目录，账单量级就变了，而他从没为这件事做过决定。
    钉上之后"便宜"是写出来的选择，想让某一份跟着会话走，materialize 成自己
    那份、清掉型号即可——那条路是显式的（同这个文件开头那条规则） */
const BUILTIN_MODEL = DEFAULT_MODEL;

/** 只读那几把：去掉 write_file 和 bash */
const READ_ONLY_TOOLS = ["read_file", "web_search", "web_extract", "browser_read", "todo_write"];

/** 名字保持英文:它是模型调 task 时要打出来的那个词（SUBAGENT_NAME_RE 只收
    [A-Za-z0-9_-]），中文名塌成连字符串,叫不出来 */
const BUILTINS: readonly Omit<SubagentDef, "unknownTools" | "path" | "source" | "readOnly" | "builtin">[] = [
  {
    name: "general-purpose",
    description:
      "通用子 agent：研究复杂问题、翻代码、跑多步任务。不确定该派给谁、或者任务要动手改东西时派它。",
    instructions:
      "你是通用子 agent。派给你的任务通常要跨好几个文件、好几步才有结论。\n\n" +
      "先弄清楚现状再动手：读到的东西比你记得的可靠。改动要小步、可回滚，" +
      "每一步都说清为什么改，不只是改了什么。\n\n" +
      "跑不通、或者任务本身的前提就不成立时，把这件事写进汇报，别绕过去交一份看着像完成的结果。",
    tools: ALL_TOOLS,
    approval: "inherit",
    model: BUILTIN_MODEL,
    preamble: { mode: "default" },
    context: [],
    scope: "user",
  },
  {
    name: "Explore",
    description:
      "只读检索子 agent：要横扫很多文件、目录或命名方式才答得上来的问题派它。它只定位，不评审、不改动。",
    instructions:
      "你是只读检索子 agent。你的活是**找到**东西并说清它在哪儿，不是评价它、也不是改它。\n\n" +
      "汇报里给路径和行号，附上足够判断的片段——别把整个文件贴回来。" +
      "找遍了也没有，就说没有，并说清你按哪几种命名方式找过：一个准确的\"不存在\"比一个含糊的猜测有用。",
    tools: READ_ONLY_TOOLS,
    approval: "inherit",
    model: BUILTIN_MODEL,
    preamble: { mode: "default" },
    context: [],
  scope: "user",
  },
  {
    name: "memory-reviewer",
    description: "记忆审查员：回顾一段对话，把值得跨会话记住的事实写进长期记忆。由系统每 10 轮自动派出，用户一般不用手动派。",
    instructions:
      "你是记忆审查员。任务里附的是父会话最近一段对话的摘要投影，以及当前的 MEMORY/USER 内容" +
      "（这次派活带着项目档的话，还会有 PROJECT）。\n\n" +
      "判断有没有**新的、一周后仍然成立的**事实值得记：用户偏好、环境细节、工具怪癖、稳定约定、用户纠正过你的事。" +
      "有就用 memory 工具写（陈述句；与已有条目重复的合并而不是再加一条；过时的 replace/remove 掉）；没有就什么也不写。\n\n" +
      `三档判据：${tierRuleText({ upper: true })}` +
      "没有项目档时（工作区不在 git 仓库里）只有两档，别提 PROJECT——那时 memory 工具里也压根没有这个选项。\n\n" +
      `主题桶：${topicRuleText({ upper: true })}任务里附了主题索引；写 topic 档时 topic 参数给索引里的 slug。\n` +
      "不记任务进度、文件清单、PR/issue 号、commit、正在做的事。汇报一句话：记了什么/没记为什么。",
    tools: ["memory"],
    approval: "inherit",
    model: BUILTIN_MODEL,
    preamble: { mode: "default" },
    context: [],
    scope: "user",
  },
];

/**
 * 这一版的内置定义。knownTools = 此刻真挂得上的工具表：内置写死的工具名如果
 * 这个装配里不存在（探针失败时 TOOL_NAMES 是空的），过滤掉而不是记成
 * unknownTools —— 那个徽章是说"你的文件里有个名字我不认识"，内置的文件不是
 * 用户写的，让他去修一份他改不了的东西没有意义。
 *
 * 一把都不剩时仍然把这份定义留在清单里（tools 为空由装配那侧兜底），
 * 而不是让「内置」那一栏凭空消失：一栏消失了没人知道为什么。
 */
export function builtinSubagents(knownTools: readonly string[]): SubagentDef[] {
  return BUILTINS.map((b) => ({
    ...b,
    tools: b.tools.filter((t) => knownTools.includes(t)),
    unknownTools: [],
    path: "",
    source: BUILTIN_SOURCE,
    readOnly: true,
    builtin: true as const,
  }));
}

/**
 * 把内置定义并进磁盘扫出来的清单。**磁盘优先**：同名（不分大小写，落地的是
 * macOS 文件名）的磁盘定义盖住内置那份 —— 这正是 materialize 的落地方式，
 * 用户改了模型就在可写根里写出一份同名 .md，从此看到的是他自己的。
 *
 * 刻意不写进 scanSubagents：那个函数还被 subagentSlotTaken 用来查"落点这一层
 * 占了没"，内置混进去的话新建 general-purpose 会被拦掉，materialize 这条路
 * 从第一步就走不通。
 */
export function withBuiltins(
  onDisk: readonly SubagentDef[],
  knownTools: readonly string[]
): SubagentDef[] {
  const builtins = builtinSubagents(knownTools);
  const builtinNames = new Set(builtins.map((b) => b.name.toLowerCase()));
  // 盖住内置的磁盘定义标 overridesBuiltin：内置是身份不是状态——用户配了个
  // 模型，它仍是内置那只（设置页留在「内置」栏，挂"已自定义"），不该看起来
  // 像内置的消失了、多出来一个重名的"我的"
  const marked = onDisk.map((d) =>
    builtinNames.has(d.name.toLowerCase()) ? { ...d, overridesBuiltin: true as const } : d
  );
  const taken = new Set(onDisk.map((d) => d.name.toLowerCase()));
  const extra = builtins.filter((b) => !taken.has(b.name.toLowerCase()));
  return [...marked, ...extra].sort((a, b) => a.name.localeCompare(b.name));
}
