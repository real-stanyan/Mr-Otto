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

export function parseCreateAgentArgs(raw: unknown): CreateAgentDraft {
  const a = asRecord(raw);
  const rawName = a["name"];
  if (typeof rawName !== "string") throw new Error("name 必填，且必须是字符串（群里 @ 它用的名字）");
  // B-C2/B-I2（#957）：短字段先折空白再落库前归一化（NFKC + trim），校验跑在归一化
  // 之后的值上——不然"Ａｄｓ"这种全角名字会绕开校验、落库后与半角"Ads"肉眼分不清
  const name = normalizeAgentName(collapseWhitespace(rawName));
  const nameErr = validateAgentName(name);
  if (nameErr !== null) throw new Error(`name 不合法：${nameErr}`);

  // 顺序固定：noNewline 先挡真换行（不能被折叠悄悄吞掉再放行），collapseWhitespace
  // 再挡"一串空格 + pre-wrap 自动换行"这条等价的伪造通道（B-C2 终审实测）
  const description = collapseWhitespace(noNewline(optionalText(a, "description", AGENT_DESCRIPTION_MAX), "description"));
  const instructions = optionalText(a, "instructions", AGENT_INSTRUCTIONS_MAX);

  let models: string[] = [];
  if (a["models"] !== undefined) {
    const m = a["models"];
    if (!Array.isArray(m) || !m.every((x) => typeof x === "string")) throw new Error("models 必须是字符串数组（型号 id）");
    models = dedupeStrings(m as string[]).map((s) => collapseWhitespace(noNewline(s, "models")));
    if (models.length > AGENT_MODELS_MAX) throw new Error(`models 最多 ${AGENT_MODELS_MAX} 个`);
  }

  let tools: AgentToolAllow[] = [];
  if (a["tools"] !== undefined) {
    const t = a["tools"];
    if (!Array.isArray(t)) throw new Error("tools 必须是数组：[{serverId, tools: []}]，[] = 全部连接器都能用");
    if (t.length > AGENT_TOOLS_MAX) throw new Error(`tools 最多 ${AGENT_TOOLS_MAX} 台连接器`);
    tools = t.map((item) => {
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

  return { name, description, instructions, models, tools };
}

/** 审批卡的字段清单，唯一的事实来源——`createAgentApprovalSummary`（旧客户端/旧日志
    仍要读的整块字符串）与 `createAgentApprovalFields`（B-C2，逐字段渲染用）都从这里
    派生，不各写一份，两处才不会因为各自改动而分家。 */
function buildApprovalFields(d: CreateAgentDraft): { label: string; value: string }[] {
  const connectors = d.tools.length === 0
    ? "全部（不限）"
    : d.tools.map((t) => (t.tools.length === 0 ? `${t.serverId}（整台）` : `${t.serverId}（${t.tools.join("、")}）`)).join("；");
  return [
    { label: "名字", value: d.name },
    { label: "职责", value: d.description || "（没写）" },
    { label: "型号", value: d.models.length === 0 ? "工作区默认" : d.models.join(", ") },
    { label: "连接器", value: connectors },
    { label: `提示词（${d.instructions.length} 字）`, value: d.instructions ? `\n${d.instructions}` : "（没写）" },
  ];
}

/** 审批卡文案（ADR-0118 第二条）：逐字段、提示词**全文**——截断的卡等于让人批一段没看见的提示词。
    旧客户端/旧日志读这一个整块字符串（argsSummary），新客户端读 `createAgentApprovalFields`。 */
export function createAgentApprovalSummary(d: CreateAgentDraft): string {
  return buildApprovalFields(d).map((f) => `${f.label}：${f.value}`).join("\n");
}

/** B-C2：审批卡逐字段渲染用（`ApprovalRequestEvent.argsFields`）——五项，名字/职责/
    型号/连接器/提示词，提示词是最后一项、值不截断。与 `createAgentApprovalSummary`
    共用 `buildApprovalFields`，不会各写一份而分家。 */
export function createAgentApprovalFields(d: CreateAgentDraft): { label: string; value: string }[] {
  return buildApprovalFields(d);
}

/** M3：威胁扫描抽成共用的一份，工具的 run() 与 sessionService 的 summarizeArgs
    钩子都调它——避免两份实现各说各话。命中回 `<field> 含可疑指令（<hit>）`，否则 null。
    只扫 description / instructions（提示词会成为一只 agent 的永久 system 提示）。 */
export function scanCreateAgentThreat(d: CreateAgentDraft): string | null {
  for (const [field, text] of [["description", d.description], ["instructions", d.instructions]] as const) {
    const hit = scanThreat(text);
    if (hit) return `${field} 含可疑指令（${hit}）`;
  }
  return null;
}
