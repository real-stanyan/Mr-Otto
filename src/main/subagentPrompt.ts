// 子智能体的 system prompt 拼装（ADR-0048 §3）。
//
// 拼装本身是纯函数，读盘缩在两个小函数里、reader 以接口注入：这一段的返回值
// 就是落进 subagent_briefed 快照的那一段，也就是"模型看到的全部"——它必须能
// 在测试里不碰磁盘地跑遍每一条分支。

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PREAMBLE, isSafeContextFile, type SubagentDef } from "../shared/subagent.js";

/** 单份工作区文档的上限。一份 AGENTS.md 不该把子 agent 的上下文吃光；
    而"悄悄少读一半"比"读不到"更难查，所以截断这件事要写进正文 */
export const CONTEXT_DOC_LIMIT = 64 * 1024;

/** 所有工作区文档**加起来**的上限。为什么这一条比一般的体积限制重要得多：
    这段文本会拼进 subagent_briefed.instructions，而 deriveMessages 把它投影成一条
    **user 消息**；本仓的上下文压缩只削 tool_result 的输出和工具调用参数，user 消息
    从来不削。也就是说它每一轮都原样重发、永不缩水，而日志是 append-only——
    超了不是"变慢一点"，是那个子会话从第 1 轮起就爆上下文、并且**永久修不好**
    （事后改 .md 也救不回已经落盘的那份快照）。
    定在 128 KB = 单份上限的两倍，也正好是设置页那两个勾选框（AGENTS.md + CLAUDE.md）
    本来就能产生的最大值——不缩已有能力，只挡手写 context 列出十份文档那种。 */
export const CONTEXT_DOCS_BUDGET = 128 * 1024;

/** 全局前置词落在 ~/.otter/ 而不是 ~/.otter/agents/：agents/ 下每个 .md 都会被
    scanSubagents 读一遍（没有 frontmatter 会被丢掉，不至于显示成一个子智能体），
    但让配置文件和定义文件混住是在等一个未来的坑 */
export const GLOBAL_PREAMBLE_PATH = join(homedir(), ".otter", "subagent-preamble.md");

export interface FileReader {
  /** 读不到 = null */
  readFile(path: string): string | null;
}

export const nodeFileReader: FileReader = {
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
};

/** 全局前置词。文件不在／读不到／去空白后为空 = 内置默认。
    空文件退回默认而不是"空前置词"：存了个空文件更像是失手，不像是意图 */
export function readGlobalPreamble(path: string, reader: FileReader = nodeFileReader): string {
  const text = reader.readFile(path);
  return text && text.trim() ? text.trim() : DEFAULT_PREAMBLE;
}

export interface ContextDoc {
  file: string;
  text: string;
  truncated: boolean;
  /** 总预算已经花光,这份声明过的文档一个字都没注入。
      为什么要留下这条空记录而不是直接丢掉：静默丢掉一份用户声明过的文档，
      正是这次要修的那个毛病本身——模型不知道自己缺了什么，用户也看不出来 */
  skipped: boolean;
}

/** 按会话 workspace 读 def.context 声明的那几份文档。
    basename 在解析时已经过滤过一遍，这里再过滤一遍——两处独立判断比互相信任
    更皮实（同 saveSubagent 收权的理由）。读不到就跳过：一个工程没有 AGENTS.md
    是常态，不该因此派不出活 */
export function readContextDocs(
  workspace: string,
  files: readonly string[],
  reader: FileReader = nodeFileReader
): ContextDoc[] {
  const out: ContextDoc[] = [];
  let used = 0;
  for (const file of files) {
    if (!isSafeContextFile(file)) continue;
    // 预算见底就不再读盘了。仍然记一条 skipped——声明过却没注入这件事必须留痕
    if (used >= CONTEXT_DOCS_BUDGET) {
      out.push({ file, text: "", truncated: false, skipped: true });
      continue;
    }
    const text = reader.readFile(join(workspace, file));
    if (text === null) continue;
    // 空白文件跳过而不是拼出一个只有标题、没有正文的段落——那一段对模型是纯噪音。
    // 与 readGlobalPreamble 对空白文件的处置同一条规矩
    if (text.trim() === "") continue;
    // 这一份能占的位置 = 单份上限和"总预算还剩多少"里更小的那个
    const room = Math.min(CONTEXT_DOC_LIMIT, CONTEXT_DOCS_BUDGET - used);
    const truncated = text.length > room;
    const kept = truncated ? text.slice(0, room) : text;
    used += kept.length;
    out.push({ file, text: kept, truncated, skipped: false });
  }
  return out;
}

/** 模型看到的全部 = 前置词 + 工作区文档 + 正文。
    custom 是覆盖全局而不是追加（ADR-0048：追加的话它和 instructions 拼起来
    对模型完全一样，就只是 UI 分栏） */
export function composeSubagentPrompt(opts: {
  def: SubagentDef;
  globalPreamble: string;
  docs: readonly ContextDoc[];
}): string {
  const p = opts.def.preamble;
  const preamble =
    p.mode === "off" ? "" : p.mode === "custom" ? p.text.trim() : opts.globalPreamble.trim();

  const blocks: string[] = [];
  if (preamble) blocks.push(preamble);
  for (const doc of opts.docs) {
    // 整份没进来的也要出现在正文里,理由同 ContextDoc.skipped
    if (doc.skipped) {
      blocks.push(`## 工作区文档：${doc.file}\n\n（工作区文档总量已超上限，本文件未注入）`);
      continue;
    }
    const tail = doc.truncated ? "\n\n（本文件过长，已截断）" : "";
    blocks.push(`## 工作区文档：${doc.file}\n\n${doc.text.trim()}${tail}`);
  }
  const body = opts.def.instructions.trim();
  if (body) blocks.push(body);
  return blocks.join("\n\n");
}
