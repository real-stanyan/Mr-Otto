// subagent 库 — 扫描本机定义的 subagent（<根目录>/<名字>.md + YAML frontmatter）。
// 与 skills.ts 同构（ADR-0007 的规则原样搬过来）：根目录按序覆盖、同名先到先得、
// 每次现扫磁盘不缓存。差别只有两处：这里是平铺的 .md（不是 <名字>/SKILL.md），
// 而且 frontmatter 字段多，需要真解析而不是两个正则。
// 主进程模块（组装根特权可碰 fs）；解析是纯函数，fs 以接口注入，测试喂假实现。

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SUBAGENT_TOOLS,
  type SubagentApproval,
  type SubagentDef,
} from "../shared/subagent.js";
import type { ThinkingMode } from "../shared/thinking.js";

export interface SubagentDirReader {
  /** root 下的 .md 文件名（不含路径）；root 不存在/读不了 = [] */
  listFiles(root: string): string[];
  /** 文件全文；不存在/读不了 = null */
  readFile(path: string): string | null;
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

const APPROVALS: readonly SubagentApproval[] = ["ask", "auto", "deny"];
const THINKINGS: readonly ThinkingMode[] = ["off", "low", "on", "medium", "high", "max"];

/** 解析 frontmatter 的单行 `键: 值`。不引 YAML 库——字段就这六个，
    一个正则的事，别为它背一棵依赖树（同 parseSkillMd 的理由） */
function parseFrontmatter(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (kv?.[1] && kv[2]) out[kv[1]] = kv[2];
  }
  return out;
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
  }
): SubagentDef | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  // 没有 frontmatter = 不是 subagent。与 skill 不同：skill 的正文本身就是全部指令，
  // 而 subagent 至少要有 description 才可能被模型挑中，裸正文没有意义
  if (!m) return null;

  const fm = parseFrontmatter(m[1] ?? "");
  const declared = splitList(fm["tools"]);
  // task 明确剔除（不进 unknownTools）：子 agent 不能再派子 agent 是设计边界，
  // 不是"名字写错了"，不该在设置页报成无法识别
  const wanted = declared.filter((t) => t !== "task");
  const tools = wanted.filter((t) => opts.knownTools.includes(t));
  const unknownTools = wanted.filter((t) => !opts.knownTools.includes(t));

  const approval = fm["approval"];
  const thinking = fm["thinking"];

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
    path: opts.path,
    source: opts.source,
    readOnly: opts.readOnly,
  };
}

/** 按 roots 顺序扫描全部 subagent。同名先到先得——原生目录排在前面 = 覆盖优先。
    每次调用都现扫磁盘：定义是用户随时增删的外部文件，缓存只会陈旧（同 scanSkills）。 */
export function scanSubagents(
  roots: readonly { root: string; readOnly: boolean }[],
  knownTools: readonly string[],
  reader: SubagentDirReader = nodeReader
): SubagentDef[] {
  const byName = new Map<string, SubagentDef>();
  for (const { root, readOnly } of roots) {
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
      });
      if (!def) continue;
      if (!byName.has(def.name)) byName.set(def.name, def);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
