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

/** 「已知工具名单」要不要算上 "skill"：工具本身的 available() 只问"此刻有没有
    装 skill"（见下方 available），所以判断"这个名字认不认识"的一方也不能吃
    开机那一刻的旧快照——零 skill 开机时开机探针装不出这把刀，之后用户在设置页
    导入第一把 skill：设置页复选框列表用的是现算的活工具表，能勾上，但保存时若
    校验方还信旧快照，"skill" 就会被打进 unknownTools，报"1 个工具名无法识别"。
    同 mcpToolNamesNow 的既有惯用法（ADR-0054）：认不认得这个名字不能停在装配
    那一刻——调用方现扫磁盘算出 installedCount，这里只管现算这条件，不碰 fs */
export function knownSkillToolName(installedCount: number): string[] {
  return installedCount > 0 ? [SKILL_TOOL_NAME] : [];
}

/** 索引体积上限。数值取自 exposure.ts 的单工具预算（8KB）减 1KB 给动作说明，
    但那是**自我约束，无人强制**：`applyExposurePolicy` 只套在 MCP 工具上
    （agent.ts:488），没有任何东西在量这把内置工具。写清楚免得下一个人以为
    超了会被自动降级——超了就是超了，只有这里的 break 挡着 */
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

/** 索引拼装。装得下全列；装不下**按传入序**列前 N，尾注还有几条、怎么找——
    静默截半句会让模型以为清单就这些。
    传入序此刻是**磁盘序**（三个调用点给的都是 `scanSkills(skillRoots)`：主会话
    装配、subagentRunner 的子会话装配，以及 src/main/index.ts 的
    probeToolDefs——开机探针，也读 t.def 拼一次索引）：
    D6 说的「按最近启用时间排序」没有实现。留在这里当公开的欠账，不是假声明——
    真要实现得让装配层把台账（activeSkills 的启用次序）也喂进来排一次，
    是另一条改动。今天的后果：skill 装得多到超预算时，被截掉的是磁盘上排在
    后面的那些，而不是最久没用过的那些 */
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
  return {
    // getter 而不是对象字面量里的一次求值（同 task.ts:68 的写法）：索引要**动态拼**
    // （ADR-0122 §一），而字面量里的 `index()` 在 createSkillTool 那一刻就冻住了。
    // 冻住的后果不是理论问题：app 自带「导入 skill」弹窗（CHANNELS.importSkills），
    // 而「导入一把 skill 然后让 Otto 用它」正是这个功能存在的理由——会话已经开着的话，
    // 模型的索引里没有它，而 available() / list / acquire 都是活的，三者各说各话。
    // 零 skill 起步更糟：装了第一把之后 available() 翻成 true，模型却拿到一把
    // description 以光秃秃的「可用 skill：」结尾的工具。
    // TS 里 getter 满足 `def: ToolDefinition`，Tool 接口一个字不用改
    get def() {
      return {
        name: SKILL_TOOL_NAME,
        description:
          "本机已装的 skill（说明书式的提示词包）。判断某把 skill 与当前任务相关时，" +
          "acquire 它——它的正文会进入你的上下文并在此后一直生效，直到 release。\n" +
          'action："list" 按关键词检索（清单装不下时用）、"acquire" 启用、"release" 停用。\n' +
          "只能 release 你自己 acquire 的；用户启用的那些你动不了。\n\n" +
          "可用 skill：\n" +
          composeSkillIndex(deps.listSkills()),
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
      };
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
