// skill 工具 —— 模型自己发现并取用本机已装的 skill（渐进披露）。
//
// 索引（name — description）拼进 def.description：工具表本来就常驻、本来就不落
// 事件、本来就受 exposure.ts 的单工具预算管着——零新注入面，也不用为「索引凭什么
// 不落盘」另编一套解释（同 tool_search 的先例）。
//
// 正文走 skill_invoked 事件，不进 tool_result：投影层削 tool_result 的输出、
// 不削 user 消息（见 subagentPrompt.ts 文件头）。正文留在 tool_result 里，长任务
// 跑一阵就被削掉——技能无声失效，正是 ADR-0066 刚修好的那个病。
//
// 不碰 fs：读盘与落盘都是装配期注入的闭包（硬规则：src/tools 不 import fs）。

import type { Tool } from "./tool.js";

export const SKILL_TOOL_NAME = "skill";

/** 索引体积上限，与 exposure.ts 的单工具预算同一把尺子。留 1KB 给动作说明 */
const INDEX_BUDGET = 7 * 1024;
const MAX_LIST_RESULTS = 10;

export interface SkillToolDeps {
  /** 现扫磁盘的已装 skill（装配期注入——工具层不碰 fs） */
  listSkills(): {
    name: string;
    description: string;
    content: string;
    argumentHint?: string;
  }[];
  /** 此刻台账：名字 → 来源。release 的来源校验读它 */
  activeSkills(): Map<string, { source?: "user" | "model" }>;
  /** 落 skill_invoked（source: "model"）。装配根接线：store.append + push.event */
  appendInvoked(name: string, content: string, args?: string): void;
  /** 落 skill_released */
  appendReleased(name: string): void;
}

/** 索引拼装。装得下全列；装不下按传入序（装配层给的是最近启用序）列前 N，
    尾注还有几条、怎么找——静默截半句会让模型以为清单就这些 */
export function composeSkillIndex(
  skills: { name: string; description: string }[],
  maxBytes: number = INDEX_BUDGET
): string {
  const lines: string[] = [];
  let used = 0;
  let listed = 0;
  for (const s of skills) {
    const line = `- ${s.name} — ${s.description || "（无描述）"}`;
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    // 尾注本身也要装得下，所以留出余量再收
    if (used + bytes > maxBytes - 120) break;
    lines.push(line);
    used += bytes;
    listed++;
  }
  const rest = skills.length - listed;
  if (rest > 0) {
    lines.push(`（另有 ${rest} 个未列出，用 action:"list" 加关键词检索）`);
  }
  return lines.join("\n");
}

export function createSkillTool(deps: SkillToolDeps): Tool {
  const index = () => composeSkillIndex(deps.listSkills());
  return {
    def: {
      name: SKILL_TOOL_NAME,
      description:
        "本机已装的 skill（说明书式的提示词包）。判断某把 skill 与当前任务相关时，" +
        'acquire 它——它的正文会进入你的上下文并在此后一直生效，直到 release。\n' +
        'action："list" 按关键词检索（清单装不下时用）、"acquire" 启用、"release" 停用。\n' +
        "只能 release 你自己 acquire 的；用户启用的那些你动不了。\n\n" +
        "可用 skill：\n" +
        index(),
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "acquire", "release"], description: "要做什么" },
          name: { type: "string", description: "skill 名（acquire / release 必填）" },
          args: { type: "string", description: "skill 参数（可选，如档位 lite/ultra）" },
          query: { type: "string", description: "检索关键词（list 用）" },
        },
        required: ["action"],
      },
    },
    requiresApproval: false,
    // 并发不安全：acquire 会落事件、改台账，两把同时跑顺序不确定
    parallelSafe: false,
    // 一把 skill 都没装就别出这把刀——报一把只会返回空的工具是白让模型试
    available: () => deps.listSkills().length > 0,
    async run(rawArgs) {
      const a = (rawArgs ?? {}) as { action?: unknown; name?: unknown; args?: unknown; query?: unknown };
      const action = a.action;
      if (action === "list") {
        const query = typeof a.query === "string" ? a.query.trim() : "";
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        const all = deps.listSkills();
        const scored = (words.length === 0 ? all.map((s) => ({ s, score: 1 })) : all
          .map((s) => {
            const hay = `${s.name} ${s.description}`.toLowerCase();
            return { s, score: words.filter((w) => hay.includes(w)).length };
          })
          .filter((x) => x.score > 0))
          .sort((x, y) => y.score - x.score)
          .slice(0, MAX_LIST_RESULTS);
        if (scored.length === 0) return `没有匹配「${query}」的 skill。`;
        return `找到 ${scored.length} 个：\n${scored
          .map(({ s }) => `- ${s.name} — ${s.description || "（无描述）"}`)
          .join("\n")}`;
      }

      const name = a.name;
      if (typeof name !== "string" || name === "") {
        throw new Error(`skill: action "${String(action)}" 必须带 name`);
      }

      if (action === "acquire") {
        if (deps.activeSkills().has(name)) return `skill「${name}」已经启用，指令仍在生效。`;
        const found = deps.listSkills().find((s) => s.name === name);
        if (!found) throw new Error(`skill 不存在: ${name}（用 action:"list" 看有哪些）`);
        const args = typeof a.args === "string" && a.args !== "" ? a.args : undefined;
        deps.appendInvoked(found.name, found.content, args);
        return `skill「${name}」已启用，它的指令随后进入你的上下文，此后一直生效。`;
      }

      if (action === "release") {
        const entry = deps.activeSkills().get(name);
        if (!entry) throw new Error(`skill「${name}」未启用，无需停用。`);
        if (entry.source !== "model") {
          throw new Error(`skill「${name}」由用户启用，模型不能停用它。`);
        }
        deps.appendReleased(name);
        return `skill「${name}」已停用，它的指令不再随压缩重注入。`;
      }

      throw new Error(`skill: 未知 action「${String(action)}」（只认 list / acquire / release）`);
    },
  };
}
