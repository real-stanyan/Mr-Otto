// create_agent 的纯逻辑（#954，spec §10 切片 6）：模型给的参数 → 一份能落库的草稿，
// 以及审批卡上逐字段的文案。桌面与 runtime 共用（纪律同 workspaceAgents.ts）。
//
// 为什么校验比桌面表单严：桌面那份的写入方是带类型的 IPC，这里的写入方是模型——
// 形状不对一律抛人话让它改，不猜、不 fail-open（normalizeAgentTools 那条
// 「形状不对整份回 []」在这里是错的：[] 的意思是整池放行）。

import type { AgentToolAllow } from "./agentToolAllow.js";
import { collapseWhitespace, normalizeAgentName, validateAgentName } from "./workspaceAgents.js";
import { scanThreat } from "./threatPatterns.js";

export const CREATE_AGENT_TOOL_NAME = "create_agent";
export const AGENT_DESCRIPTION_MAX = 200;
export const AGENT_INSTRUCTIONS_MAX = 4000;
export const AGENT_MODELS_MAX = 8;
/** 连接器台数上限（M5，终审顺手）——models 封 8，tools 原来没封 */
export const AGENT_TOOLS_MAX = 16;
/** 每台连接器的工具名数上限（M5，终审顺手） */
export const AGENT_TOOL_NAMES_MAX = 32;

export interface CreateAgentDraft {
  name: string;
  description: string;
  instructions: string;
  /** 允许的型号；[0] 是默认；[] = 工作区默认（ADR-0202） */
  models: string[];
  /** 连接器白名单；[] = 整池放行（与 workspace_agents.tools 同口径） */
  tools: AgentToolAllow[];
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function optionalText(a: Record<string, unknown>, key: string, max: number): string {
  const v = a[key];
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new Error(`${key} 必须是字符串`);
  const t = v.trim();
  if (t.length > max) throw new Error(`${key} 最多 ${max} 字（收到 ${t.length} 字）`);
  return t;
}

function dedupeStrings(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const s = raw.trim();
    if (s !== "" && !out.includes(s)) out.push(s);
  }
  return out;
}

/** 上卡的短字段一律禁换行（终审 Critical，#954）：卡是逐行呈现的，字段里一个 \n 就能
    在真正的提示词上方伪造出一张完整的良性卡。套在 models 条目 / serverId / 连接器
    工具名 / description 上；instructions 是卡上最后一段，多行是设计，不套这层。 */
const noNewline = (s: string, what: string): string => {
  if (/[\r\n]/.test(s)) throw new Error(`${what} 不能换行——审批卡逐行呈现，换行等于伪造卡上的其它字段`);
  return s;
};

/** 一份 patch：只带在场的字段。改一只 agent 时"没传的字段"与"传了空值"必须分得开——
    给没传的字段补上默认值（"" / []）等于把它清空，而 updateAgentRow 是把 patch 直接
    摊进 UPDATE 的。 */
export type AgentDraftPatch = Partial<CreateAgentDraft>;

/** 逐字段校验 + 归一化的唯一一份实现：`parseCreateAgentArgs`（模型给的整份草稿）与
    `validateAgentPatch`（桌面改一只 agent 的 patch）都从这里派生。字段只在**键在场**时
    才出现在结果里，缺席的字段不补默认值（谁需要默认值谁自己补，见 parseCreateAgentArgs）。 */
function parseAgentFields(a: Record<string, unknown>): AgentDraftPatch {
  const out: AgentDraftPatch = {};

  if (a["name"] !== undefined) {
    const rawName = a["name"];
    if (typeof rawName !== "string") throw new Error("name 必填，且必须是字符串（群里 @ 它用的名字）");
    // 顺序同其它短字段：noNewline 先挡真换行——collapseWhitespace 会把 \n 折成空格，
    // 先折叠再校验会让真换行被悄悄吞掉、错报成「不能有空白」而不是「不能换行」
    // （B-C2/B-I2）：短字段先折空白再落库前归一化（NFKC + trim），校验跑在归一化
    // 之后的值上——不然"Ａｄｓ"这种全角名字会绕开校验、落库后与半角"Ads"肉眼分不清
    const name = normalizeAgentName(collapseWhitespace(noNewline(rawName, "name")));
    const nameErr = validateAgentName(name);
    if (nameErr !== null) throw new Error(`name 不合法：${nameErr}`);
    out.name = name;
  }

  // 顺序固定：noNewline 先挡真换行（不能被折叠悄悄吞掉再放行），collapseWhitespace
  // 再挡"一串空格 + pre-wrap 自动换行"这条等价的伪造通道（B-C2 终审实测）
  if (a["description"] !== undefined) {
    out.description = collapseWhitespace(noNewline(optionalText(a, "description", AGENT_DESCRIPTION_MAX), "description"));
  }
  if (a["instructions"] !== undefined) {
    out.instructions = optionalText(a, "instructions", AGENT_INSTRUCTIONS_MAX);
  }

  if (a["models"] !== undefined) {
    const m = a["models"];
    if (!Array.isArray(m) || !m.every((x) => typeof x === "string")) throw new Error("models 必须是字符串数组（型号 id）");
    const models = dedupeStrings(m as string[]).map((s) => collapseWhitespace(noNewline(s, "models")));
    if (models.length > AGENT_MODELS_MAX) throw new Error(`models 最多 ${AGENT_MODELS_MAX} 个`);
    out.models = models;
  }

  if (a["tools"] !== undefined) {
    const t = a["tools"];
    if (!Array.isArray(t)) throw new Error("tools 必须是数组：[{serverId, tools: []}]，[] = 全部连接器都能用");
    if (t.length > AGENT_TOOLS_MAX) throw new Error(`tools 最多 ${AGENT_TOOLS_MAX} 台连接器`);
    out.tools = t.map((item) => {
      const o = asRecord(item);
      if (typeof o["serverId"] !== "string" || o["serverId"].trim() === "") throw new Error("tools 每一项要有 serverId（连接器 id）");
      const names = o["tools"];
      if (!Array.isArray(names) || !names.every((x) => typeof x === "string")) {
        throw new Error("tools 每一项的 tools 要是字符串数组（[] = 这台整台放行）");
      }
      const toolNames = dedupeStrings(names as string[]).map((s) => collapseWhitespace(noNewline(s, "tools")));
      if (toolNames.length > AGENT_TOOL_NAMES_MAX) throw new Error(`tools 每一项最多 ${AGENT_TOOL_NAMES_MAX} 个工具名`);
      return { serverId: collapseWhitespace(noNewline(o["serverId"].trim(), "serverId")), tools: toolNames };
    });
  }

  return out;
}

export function parseCreateAgentArgs(raw: unknown): CreateAgentDraft {
  const a = asRecord(raw);
  if (a["name"] === undefined) throw new Error("name 必填，且必须是字符串（群里 @ 它用的名字）");
  const p = parseAgentFields(a);
  return {
    name: p.name!,
    description: p.description ?? "",
    instructions: p.instructions ?? "",
    models: p.models ?? [],
    tools: p.tools ?? [],
  };
}

/** B-C1（#957）：改一只 agent 的那条路与建的那条路过同一份校验。桌面主进程
    `workspaceManager.updateAgent` 在 UPDATE 之前调它——原来这条路上**服务端一条校验
    都没有**（validateAgentName 只跑在渲染层），改一个客户端就能把任意文本写进别人的
    briefing。与 `parseCreateAgentArgs` 共用 `parseAgentFields`，两条路不可能分家。
    名字冲突（同名/前缀）不在这里判：那要现查一次名单，是 IO，留给调用方
    （`agentNameConflict`）。 */
export function validateAgentPatch(raw: unknown): AgentDraftPatch {
  return parseAgentFields(asRecord(raw));
}

/** 审批卡的字段清单，唯一的事实来源——`createAgentApprovalSummary`（旧客户端/旧日志
    仍要读的整块字符串）与 `createAgentApprovalFields`（B-C2，逐字段渲染用）都从这里
    派生，不各写一份，两处才不会因为各自改动而分家。
    **值是渲染就绪的**：不带 label 前缀，也不带任何前导换行——逐字段卡的 label 与
    value 分开渲染（label 一栏、value 一栏），value 里混进格式字符是 `createAgentApprovalSummary`
    自己的排版细节，不该泄给这一层的消费方。 */
function buildApprovalFields(d: CreateAgentDraft): { label: string; value: string }[] {
  const connectors = d.tools.length === 0
    ? "全部（不限）"
    : d.tools.map((t) => (t.tools.length === 0 ? `${t.serverId}（整台）` : `${t.serverId}（${t.tools.join("、")}）`)).join("；");
  return [
    { label: "名字", value: d.name },
    { label: "职责", value: d.description || "（没写）" },
    { label: "型号", value: d.models.length === 0 ? "工作区默认" : d.models.join(", ") },
    { label: "连接器", value: connectors },
    { label: `提示词（${d.instructions.length} 字）`, value: d.instructions || "（没写）" },
  ];
}

/** 审批卡文案（ADR-0118 第二条）：逐字段、提示词**全文**——截断的卡等于让人批一段没看见的提示词。
    旧客户端/旧日志读这一个整块字符串（argsSummary），新客户端读 `createAgentApprovalFields`。
    只有提示词这一行有「冒号后换行」的排版（多行内容紧贴在 label 下一行更好读）——
    那是这个整块字符串自己的排版决定，`buildApprovalFields` 的 value 不携带它。 */
export function createAgentApprovalSummary(d: CreateAgentDraft): string {
  const fields = buildApprovalFields(d);
  const lastIndex = fields.length - 1;
  return fields
    .map((f, i) => {
      const sep = i === lastIndex && d.instructions ? "：\n" : "：";
      return `${f.label}${sep}${f.value}`;
    })
    .join("\n");
}

/** B-C2：审批卡逐字段渲染用（`ApprovalRequestEvent.argsFields`）——五项，名字/职责/
    型号/连接器/提示词，提示词是最后一项、值不截断。与 `createAgentApprovalSummary`
    共用 `buildApprovalFields`，不会各写一份而分家。 */
export function createAgentApprovalFields(d: CreateAgentDraft): { label: string; value: string }[] {
  return buildApprovalFields(d);
}

/** M3：威胁扫描抽成共用的一份，工具的 run() 与 sessionService 的 summarizeArgs
    钩子都调它——避免两份实现各说各话。命中回 `<field> 含可疑指令（<hit>）`，否则 null。
    只扫 description / instructions（提示词会成为一只 agent 的永久 system 提示）。
    收 `AgentDraftPatch` 而不是整份草稿：改一只 agent 时只传了 description 的那种 patch
    也要过这道扫描（B-C1，#957），缺席的字段跳过。 */
export function scanCreateAgentThreat(d: AgentDraftPatch): string | null {
  for (const [field, text] of [["description", d.description], ["instructions", d.instructions]] as const) {
    // patch 里缺席的字段没什么可扫的（validateAgentPatch 的结果只带在场的字段）
    if (typeof text !== "string") continue;
    const hit = scanThreat(text);
    if (hit) return `${field} 含可疑指令（${hit}）`;
  }
  return null;
}
