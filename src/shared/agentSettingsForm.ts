// agentSettingsForm —— 手机智能体设置页的表单（#1356 A1，spec §5.4）。判据全在这里，
// mobile/src/agent/ 只画。真正落库前还会过 agentAdmin.updateAgentChecked（校验 + 查重名），
// 这里的校验只负责「当场说出口、按不动」，与服务端那道同口径（长度按 UTF-16 长度算，
// 同 validateAgentPatch 的 optionalText——否则表单放行的东西落库时被拒）。

import { AGENT_DESCRIPTION_MAX, AGENT_INSTRUCTIONS_MAX } from "./createAgentDraft.js";
import { FACE_PACKS, pickSlotOf, type FaceState } from "./ottoFace/index.js";
import { validateAgentName } from "./workspaceAgents.js";
import type { WorkspaceAgentRow } from "./workspaces.js";

export interface AgentForm {
  name: string;
  description: string;
  /** 「还有什么要交代的」——它自己看得见这一段 */
  instructions: string;
  /** 表单此刻的头像选择；null = 没挑过（按 agentId 派生） */
  avatarSlot: number | null;
}

export function agentFormOf(a: WorkspaceAgentRow): AgentForm {
  return { name: a.name, description: a.description, instructions: a.instructions, avatarSlot: a.avatarSlot };
}

export interface AgentFormErrors {
  name: string | null;
  description: string | null;
  instructions: string | null;
}

export function agentFormErrors(f: AgentForm): AgentFormErrors {
  const description = f.description.trim();
  const instructions = f.instructions.trim();
  return {
    name: validateAgentName(f.name),
    description: /[\r\n]/.test(f.description)
      ? "职责不能换行"
      : description.length > AGENT_DESCRIPTION_MAX
        ? `职责最多 ${AGENT_DESCRIPTION_MAX} 字`
        : null,
    instructions: instructions.length > AGENT_INSTRUCTIONS_MAX ? `最多 ${AGENT_INSTRUCTIONS_MAX} 字` : null,
  };
}

export function agentFormValid(e: AgentFormErrors): boolean {
  return e.name === null && e.description === null && e.instructions === null;
}

export type AgentFormPatch = { name?: string; description?: string; instructions?: string; avatarSlot?: number | null };

/** 只带改了的那几格；什么都没改 → null（「存」按不动）。文字按 trim 之后比；头像**换了才写**
    （spec §5.4「没换就不写」：写一格等于替用户确认「我挑的就是它」） */
export function agentFormPatch(a: WorkspaceAgentRow, f: AgentForm): AgentFormPatch | null {
  const p: AgentFormPatch = {};
  const name = f.name.trim();
  if (name !== a.name) p.name = name;
  const description = f.description.trim();
  if (description !== a.description) p.description = description;
  const instructions = f.instructions.trim();
  if (instructions !== a.instructions) p.instructions = instructions;
  if (f.avatarSlot !== a.avatarSlot) p.avatarSlot = f.avatarSlot;
  return Object.keys(p).length === 0 ? null : p;
}

export interface PickableFace {
  id: string;
  name: string;
  /** 挑它时存进 avatar_slot 的那一格（`pickSlotOf`：自己的坑位，不是暂借格） */
  slot: number;
}

/** 挑头像那面墙。按 FACE_PACKS 的顺序；**cap 没有自己的坑位，不进这面墙**——它只借住在
    坑 2，存进暂借格的人会在补齐旧 03 那天被悄悄换脸（ADR-0316 法理③），所以这面墙是
    10 张不是 demo 的 11 张（spec §5.4，维护者 2026-09-24 确认） */
export function pickableFaces(): PickableFace[] {
  const out: PickableFace[] = [];
  for (const p of FACE_PACKS) {
    const slot = pickSlotOf(p.id);
    if (slot !== null) out.push({ id: p.id, name: p.name, slot });
  }
  return out;
}

/** 大脸上那一遍「它干活时长什么样」：排队 → 思考 → 检索 → 执行 → 作答 → 完成 → 活着，
    走完从头来（demo 的 FACE_TOUR；最后一格是 alive 不是 idle——idle 带一枚「空闲」角标，
    那是在声称一件我们不知道的事）。queued 只给 900ms：它是唯一完全不动的那一格，停久了
    看着像坏了 */
export const FACE_TOUR: readonly { state: FaceState; ms: number }[] = [
  { state: "queued", ms: 900 },
  { state: "composing", ms: 1500 },
  { state: "searching", ms: 1400 },
  { state: "working", ms: 1600 },
  { state: "solving", ms: 1800 },
  { state: "done", ms: 1200 },
  { state: "alive", ms: 1500 },
];
