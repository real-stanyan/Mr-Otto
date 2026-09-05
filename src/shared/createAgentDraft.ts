// create_agent 的纯逻辑（#954，spec §10 切片 6）：模型给的参数 → 一份能落库的草稿，
// 以及审批卡上逐字段的文案。桌面与 runtime 共用（纪律同 workspaceAgents.ts）。
//
// 为什么校验比桌面表单严：桌面那份的写入方是带类型的 IPC，这里的写入方是模型——
// 形状不对一律抛人话让它改，不猜、不 fail-open（normalizeAgentTools 那条
// 「形状不对整份回 []」在这里是错的：[] 的意思是整池放行）。

import type { AgentToolAllow } from "./agentToolAllow.js";
import { validateAgentName } from "./workspaceAgents.js";

export const CREATE_AGENT_TOOL_NAME = "create_agent";
export const AGENT_DESCRIPTION_MAX = 200;
export const AGENT_INSTRUCTIONS_MAX = 4000;
export const AGENT_MODELS_MAX = 8;

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

export function parseCreateAgentArgs(raw: unknown): CreateAgentDraft {
  const a = asRecord(raw);
  const rawName = a["name"];
  if (typeof rawName !== "string") throw new Error("name 必填，且必须是字符串（群里 @ 它用的名字）");
  const nameErr = validateAgentName(rawName);
  if (nameErr !== null) throw new Error(`name 不合法：${nameErr}`);
  const name = rawName.trim();

  const description = optionalText(a, "description", AGENT_DESCRIPTION_MAX);
  const instructions = optionalText(a, "instructions", AGENT_INSTRUCTIONS_MAX);

  let models: string[] = [];
  if (a["models"] !== undefined) {
    const m = a["models"];
    if (!Array.isArray(m) || !m.every((x) => typeof x === "string")) throw new Error("models 必须是字符串数组（型号 id）");
    models = dedupeStrings(m as string[]);
    if (models.length > AGENT_MODELS_MAX) throw new Error(`models 最多 ${AGENT_MODELS_MAX} 个`);
  }

  let tools: AgentToolAllow[] = [];
  if (a["tools"] !== undefined) {
    const t = a["tools"];
    if (!Array.isArray(t)) throw new Error("tools 必须是数组：[{serverId, tools: []}]，[] = 全部连接器都能用");
    tools = t.map((item) => {
      const o = asRecord(item);
      if (typeof o["serverId"] !== "string" || o["serverId"].trim() === "") throw new Error("tools 每一项要有 serverId（连接器 id）");
      const names = o["tools"];
      if (!Array.isArray(names) || !names.every((x) => typeof x === "string")) {
        throw new Error("tools 每一项的 tools 要是字符串数组（[] = 这台整台放行）");
      }
      return { serverId: o["serverId"].trim(), tools: dedupeStrings(names as string[]) };
    });
  }

  return { name, description, instructions, models, tools };
}

/** 审批卡文案（ADR-0118 第二条）：逐字段、提示词**全文**——截断的卡等于让人批一段没看见的提示词 */
export function createAgentApprovalSummary(d: CreateAgentDraft): string {
  const connectors = d.tools.length === 0
    ? "全部（不限）"
    : d.tools.map((t) => (t.tools.length === 0 ? `${t.serverId}（整台）` : `${t.serverId}（${t.tools.join("、")}）`)).join("；");
  return [
    `名字：${d.name}`,
    `职责：${d.description || "（没写）"}`,
    `型号：${d.models.length === 0 ? "工作区默认" : d.models.join(", ")}`,
    `连接器：${connectors}`,
    `提示词（${d.instructions.length} 字）：${d.instructions ? `\n${d.instructions}` : "（没写）"}`,
  ].join("\n");
}
