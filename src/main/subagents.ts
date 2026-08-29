// subagent 库 — 扫描本机定义的 subagent（<根目录>/<名字>.md + YAML frontmatter）。
// 与 skills.ts 同构（ADR-0007 的规则原样搬过来）：根目录按序覆盖、同名先到先得、
// 每次现扫磁盘不缓存。差别只有两处：这里是平铺的 .md（不是 <名字>/SKILL.md），
// 而且 frontmatter 字段多，需要真解析而不是两个正则。
// 主进程模块（组装根特权可碰 fs）；解析是纯函数，fs 以接口注入，测试喂假实现。

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./configDir.js";
import {
  DEFAULT_SUBAGENT_TOOLS,
  isSafeContextFile,
  type SubagentApproval,
  type SubagentDef,
  type SubagentPreamble,
  type SubagentScope,
} from "../shared/subagent.js";
import type { ThinkingMode } from "../shared/thinking.js";

export interface SubagentDirReader {
  /** root 下的 .md 文件名（不含路径）；root 不存在/读不了 = [] */
  listFiles(root: string): string[];
  /** 文件全文；不存在/读不了 = null */
  readFile(path: string): string | null;
}

export interface SubagentRoot {
  root: string;
  readOnly: boolean;
  scope: SubagentScope;
}

/** 扫描根，按覆盖优先级排（同名先到先得，所以工作区排在用户前面 = 工作区盖用户）。
    workspace 为 null（设置页选「用户」、探针装配）时只有用户那一条。
    只认自己的目录：`.claude/agents/`（Claude Code 的定义）不再扫——那些文件的
    工具名、模型名是另一套产品的词，混进清单就是一排「N 个工具名无法识别」的只读
    条目，模型还会把活派给它们（ADR-0056 撤销 ADR-0048 的第 2/4 条根）。

    用户那条根收的是**解析好的配置目录**而不是 home：自 ADR-0187 起它是
    `~/.mr-otto/accounts/<抽屉>/`（跟着账号走），不再是 `<home>/.mr-otto/`。
    算法在 accountScope.ts，不在这儿重拼一遍 */
export function subagentRoots(userConfigDir: string, workspace: string | null): SubagentRoot[] {
  return [
    ...(workspace
      ? [{ root: join(workspace, CONFIG_DIR, "agents"), readOnly: false, scope: "workspace" as const }]
      : []),
    { root: join(userConfigDir, "agents"), readOnly: false, scope: "user" as const },
  ];
}

/** 渲染层给的 workspace 只有出现在已知会话围栏里才作数 —— 它会变成写文件的落点。
    白名单只是把写入面收窄到「日志里真出现过的会话围栏」，这比直接信参数强得多，
    但它**不是**「用户在目录选择器里亲手指过」的证据：startSession 只校验了
    `typeof workspace === "string" && workspace !== ""`（见 src/main/index.ts），
    没有来源校验、也没有存在性校验。要堵死那个口子得在 startSession 那侧验来源。

    **读路径**用这个：认不出就降级成 null（= 只看用户级），因为读只影响界面看到哪一层。 */
export function trustedWorkspace(
  workspace: unknown,
  known: readonly (string | null)[]
): string | null {
  if (typeof workspace !== "string" || workspace === "") return null;
  return known.includes(workspace) ? workspace : null;
}

/** **写路径**用这个：认不出就抛，绝不降级。
    降级在读路径上只是"少看一层"，在写路径上是一次**静默写错地方**——对话框上写着
    「建在 W 这一层」，文件却落进 ~/.mr-otto/agents/。今天还够不着（下拉框的选项恒是
    会话清单的子集，也还没有删会话的入口），但删会话一上线它就是真的写错地方了。
    null / "" 仍然合法,那是"用户级"这个真实意图,不是"我说了个你不认识的工作区"。 */
export function trustedWorkspaceForWrite(
  workspace: unknown,
  known: readonly (string | null)[]
): string | null {
  if (workspace === null || workspace === "") return null;
  if (typeof workspace !== "string") throw new Error("工作区必须是一个路径字符串");
  if (!known.includes(workspace)) {
    throw new Error(`不认识这个工作区：${workspace}——它不在任何一次会话的围栏里，不能往里写`);
  }
  return workspace;
}

const nodeReader: SubagentDirReader = {
  listFiles(root) {
    try {
      return readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith(".md"))
        .map((d) => d.name);
    } catch {
      return [];
    }
  },
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
};

const APPROVALS: readonly SubagentApproval[] = ["ask", "auto", "deny", "inherit"];
const THINKINGS: readonly ThinkingMode[] = ["off", "low", "on", "medium", "high", "max"];

/** 缩进宽度（只数前导空白的字符数，tab 按一个字符算——frontmatter 里混 tab
    本来就不该有，这里不为它设计） */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** 解析结果。`blocks` 记的是「这个键的值来自块标量 `|`」——不记的话
    `preamble: off` 和块标量写的 off 回来是同一个字符串，那条保留字判断就把
    用户自定义的 off 吃掉了，而序列化那侧一律把 custom 写成块标量，
    于是存进去读回来语义变了，用户看不出来 */
interface Frontmatter {
  fields: Record<string, string>;
  blocks: Set<string>;
}

/** 解析 frontmatter 的 `键: 值`。不引 YAML 库——字段就这几个（同 parseSkillMd）。
    唯一的例外是块标量 `键: |`：前置词是散文，塞进单行里没法写。
    只认 `|` 这一种块写法，`>` / `|-` / `|+` 照旧当普通单行值处理 */
function parseFrontmatter(block: string): Frontmatter {
  const fields: Record<string, string> = {};
  const blocks = new Set<string>();
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (!kv?.[1]) continue;
    const key = kv[1];
    const value = kv[2] ?? "";
    if (value === "|") {
      const body: string[] = [];
      const keyIndent = indentOf(line);
      // 吃掉后续缩进比键行深的连续行。空行留在块里（块中间的空行是内容的一部分），
      // 块首块尾多余的空行由末尾的 trim 收走
      while (i + 1 < lines.length) {
        const next = lines[i + 1] ?? "";
        if (next.trim() !== "" && indentOf(next) <= keyIndent) break;
        body.push(next);
        i++;
      }
      const indents = body.filter((s) => s.trim() !== "").map(indentOf);
      const common = indents.length > 0 ? Math.min(...indents) : 0;
      // 首尾的空行都不是内容——跟公共缩进一样,是排版不是正文。
      // 留着块首那行空行,设置页组装出来的 preamble.text 会跟磁盘上这份差一个 "\n",
      // 于是一个没人碰过的行显示"有未保存改动",而"已保存"是那一行唯一的诚实信号
      const text = body.map((s) => s.slice(common)).join("\n").trim();
      // 空块 = 什么都没写，退回"这个键没写过"——不是"前置词是空字符串"
      if (text) {
        fields[key] = text;
        blocks.add(key);
      }
      continue;
    }
    if (value) fields[key] = value;
  }
  return { fields, blocks };
}

/** 逗号分隔的列表；空串 = 空数组 */
function splitList(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseSubagentMd(
  text: string,
  opts: {
    fallbackName: string;
    knownTools: readonly string[];
    path: string;
    source: string;
    readOnly: boolean;
    scope: SubagentScope;
  }
): SubagentDef | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  // 没有 frontmatter = 不是 subagent。与 skill 不同：skill 的正文本身就是全部指令，
  // 而 subagent 至少要有 description 才可能被模型挑中，裸正文没有意义
  if (!m) return null;

  const { fields: fm, blocks } = parseFrontmatter(m[1] ?? "");
  const declared = splitList(fm["tools"]);
  // task 明确剔除（不进 unknownTools）：子 agent 不能再派子 agent 是设计边界，
  // 不是"名字写错了"，不该在设置页报成无法识别
  const wanted = declared.filter((t) => t !== "task");
  const tools = wanted.filter((t) => opts.knownTools.includes(t));
  const unknownTools = wanted.filter((t) => !opts.knownTools.includes(t));

  const approval = fm["approval"];
  const thinking = fm["thinking"];

  const preambleRaw = fm["preamble"];
  // "off" 只在**单行**写法下是保留字。块标量写出来的 off 是用户真的想要的
  // 那两个字母——序列化那侧一律把 custom 写成块标量，所以这也是往返闭合的条件
  const preamble: SubagentPreamble =
    preambleRaw === undefined
      ? { mode: "default" }
      : preambleRaw === "off" && !blocks.has("preamble")
        ? { mode: "off" }
        : { mode: "custom", text: preambleRaw };

  return {
    name: fm["name"] ?? opts.fallbackName,
    description: fm["description"] ?? "",
    instructions: (m[2] ?? "").trim(),
    // 一把都没剩 = 退回缺省，不是零工具：零工具的 agent 什么也干不成，
    // 而用户写 tools 的意图显然不是"什么都不给"
    tools: tools.length > 0 ? tools : [...DEFAULT_SUBAGENT_TOOLS],
    unknownTools,
    ...(fm["model"] ? { model: fm["model"] } : {}),
    ...(thinking && (THINKINGS as readonly string[]).includes(thinking)
      ? { thinking: thinking as ThinkingMode }
      : {}),
    // 缺席/非法一律 deny：子 agent 没人盯着，保守默认
    approval:
      approval && (APPROVALS as readonly string[]).includes(approval)
        ? (approval as SubagentApproval)
        : "deny",
    preamble,
    context: splitList(fm["context"]).filter(isSafeContextFile),
    // 只认 "none" 这一个值：写了别的（含 "inherit"）= 缺席 = 继承。
    // 不进 unknownTools 式的报错——这是开关不是清单，非法值的安全解释就是默认档
    ...(fm["skills"] === "none" ? { skills: "none" as const } : {}),
    scope: opts.scope,
    path: opts.path,
    source: opts.source,
    readOnly: opts.readOnly,
  };
}

/** 按 roots 顺序扫描全部 subagent。同名先到先得——原生目录排在前面 = 覆盖优先。
    每次调用都现扫磁盘：定义是用户随时增删的外部文件，缓存只会陈旧（同 scanSkills）。 */
export function scanSubagents(
  roots: readonly SubagentRoot[],
  knownTools: readonly string[],
  reader: SubagentDirReader = nodeReader
): SubagentDef[] {
  const byName = new Map<string, SubagentDef>();
  for (const { root, readOnly, scope } of roots) {
    for (const file of reader.listFiles(root)) {
      const path = join(root, file);
      const content = reader.readFile(path);
      if (content === null) continue;
      const def = parseSubagentMd(content, {
        fallbackName: file.replace(/\.md$/, ""),
        knownTools,
        path,
        source: root,
        readOnly,
        scope,
      });
      if (!def) continue;
      if (!byName.has(def.name)) byName.set(def.name, def);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 落点那一层已经占了吗（新建查重）。
    为什么**不能**拿合并后的清单查重：合并清单是覆盖解析之后的结果。用户级有一份
    reviewer、想在工作区里建一份同名的把它盖住——这正是覆盖规则本身的用法，是特性
    不是事故。按合并清单拦，等于把整个覆盖能力锁死，只剩手工建文件一条路。
    真正的撞车只有一种：**落点这条根里**已经有同名的了。
    两道都查：文件名占了位（哪怕那份 .md 没 frontmatter、扫不出定义，覆盖上去也是
    抹掉别人的东西），或者这条根里已经有一份叫这个名字的定义（文件名和 `name:` 不
    一致时，撞的是名字不是路径）。 */
export function subagentSlotTaken(
  root: SubagentRoot,
  name: string,
  knownTools: readonly string[],
  reader: SubagentDirReader = nodeReader
): boolean {
  // 比较不分大小写:这是个 macOS app,APFS 默认大小写不敏感。分大小写地比,
  // `~/.mr-otto/agents/Reviewer.md` 存在时新建 `reviewer` 两道检查全过,
  // 然后 writeFileSync 落到同一个 inode 上——把用户那份直接抹了,没有确认也没有撤回
  const lower = name.toLowerCase();
  if (reader.listFiles(root.root).some((f) => f.toLowerCase() === `${lower}.md`)) return true;
  return scanSubagents([root], knownTools, reader).some((d) => d.name.toLowerCase() === lower);
}

/** 单行 frontmatter 值里的换行换成空格。值里带换行会在写盘时裂成好几行，
    于是 `description: "d\napproval: auto"` 就往 frontmatter 里注入了一个
    approval 键——单行区是结构化的，自由文本只能待在块标量和正文里 */
function oneLine(v: string): string {
  return v.replace(/[\r\n]+/g, " ");
}

/** SubagentDef → .md 全文。设置页保存走这条。
    unknownTools 原样写回：用户手写的工具名本仓认不出，不代表可以替他删掉
    （他可能正准备把这个文件拿去 Claude Code 用） */
export function serializeSubagent(def: SubagentDef): string {
  const lines = [
    `name: ${oneLine(def.name)}`,
    `description: ${oneLine(def.description)}`,
    `tools: ${oneLine([...def.tools, ...def.unknownTools].join(", "))}`,
    ...(def.model ? [`model: ${oneLine(def.model)}`] : []),
    ...(def.thinking ? [`thinking: ${oneLine(def.thinking)}`] : []),
    `approval: ${oneLine(def.approval)}`,
    ...(def.context.length > 0 ? [`context: ${oneLine(def.context.join(", "))}`] : []),
    // 缺席不写行（默认继承的老文件写回不长新行）；设置页现在不给编这个键，
    // 手写的 skills: none 必须在保存后活下来——serializeSubagent 丢字段即数据丢失
    ...(def.skills === "none" ? ["skills: none"] : []),
    ...preambleLines(def.preamble),
  ];
  return `---\n${lines.join("\n")}\n---\n\n${def.instructions}\n`;
}

/** preamble 写回：default 整行不写（老文件读进来是什么样，写回去还是什么样）；
    off 一行；custom 写块标量，每行两格缩进，空行不缩进——缩进的空行会被解析时
    的公共缩进算法当成内容行，往返就不对称了 */
function preambleLines(p: SubagentPreamble): string[] {
  if (p.mode === "default") return [];
  if (p.mode === "off") return ["preamble: off"];
  return ["preamble: |", ...p.text.split(/\r?\n/).map((l) => (l.trim() === "" ? "" : `  ${l}`))];
}

/** 写回磁盘。只写 readOnly: false 的——内置那两份不在磁盘上，没地方写 */
export function writeSubagent(def: SubagentDef, write = defaultWrite): void {
  if (def.readOnly) throw new Error(`${def.name} 是只读的（来自 ${def.source}），请先复制一份`);
  write(def.path, serializeSubagent(def));
}

function defaultWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}
