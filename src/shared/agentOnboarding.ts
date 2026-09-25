// agentOnboarding —— 新建的智能体先开口，第一句回话就是它的职责（#1356 A2，spec §5.5 / §7.2）。
//
// 状态是 `workspace_agents.onboarding` 那一格（migration 0041）：
//   'greet' —— 手机「建一只」插入时写；
//   'role'  —— runtime 建这只的**新**私聊时一条条件更新抢到它（'greet' → 'role'），抢到才替建的人
//              落一条带 `greeting: "new_agent"` 的开场白；
//   null    —— 私聊里人的第一句话到了（职责还空着就写成那句话的第一行），或手机「不建了」清掉。
// 判据是一格显式状态，不是推断：按「新私聊 + 职责为空」推断的话，桌面上一条职责为空的智能体第一次
// 被私聊时会先问一句「你想让我干什么」、紧接着再答人刚发的那句（双答），还会把那句随口的话写成
// 职责——两个失败都是安静的（spec §7.2）。
//
// 这里是两边共用的判据（runtime 与手机，进 vitest）；runtime 只管 IO（agentRegistry 的两条条件
// 更新 + daemon 的接线），手机只画。

import type { SessionEvent } from "../session/events.js";
import { isAgentStep } from "./cloudTimeline.js";
import { AGENT_DESCRIPTION_MAX, scanCreateAgentThreat } from "./createAgentDraft.js";
import { promptSafe } from "./promptSafe.js";
import { humanSpeakerOf } from "./sessionParticipants.js";
import { collapseWhitespace } from "./workspaceAgents.js";

export type AgentOnboarding = "greet" | "role";

/** 库里那一格读回来。认不出（null / 脏值 / 列还不存在时的 undefined）一律 null = 不在建它的流程里 */
export function parseOnboarding(raw: unknown): AgentOnboarding | null {
  return raw === "greet" || raw === "role" ? raw : null;
}

/**
 * 开场白正文（模型直接读的那一条 user_message）。形状同 `voiceCallGreetingText`：`[系统]` 开头、
 * 名字过 `promptSafe`（成员可写字段，`]` 与换行都能撑破 `[系统] …` 这个结构）。
 * **带名字**：一只刚建出来、没有交代的智能体在私聊里拿不到 brief（`briefIfNeeded` 在「没提示词、
 * 没同伴」时一条都不落），不在这里说，它就不知道自己叫什么。
 */
export function newAgentGreetingText(name: string): string {
  return `[系统] 你刚被建出来，名字叫「${promptSafe(name)}」，还没人告诉你要干什么。用一两句话问用户想让你干什么，可以举一个例子；别列清单。`;
}

/**
 * 六句现成的话（demo 的 presets；Grok 那页「Give each Bot a job」那一排）。只在它等着我说它是
 * 干什么的时候画在它第一句话底下，点一下**只填进输入框、不发出去**（多数人想改两个字）。
 * `label` 是 chip 上那几个字，`text` 是填进去的那一句——发出去就是它的职责，所以每一句都得原样
 * 过得了 `roleFromReply`（有测试钉着）。
 */
export const ROLE_PRESETS: readonly { label: string; text: string }[] = [
  { label: "写代码的", text: "帮我写代码、跑测试、推分支，推之前先跟我说一声" },
  { label: "做设计的", text: "帮我改界面和文案，先给两个方向再动手" },
  { label: "管部署的", text: "帮我部署和看监控，出事了第一时间说人话" },
  { label: "管店的", text: "帮我排班、看库存、算进货" },
  { label: "做调研的", text: "帮我读资料、比价、整理成一页纸" },
  { label: "管钱的", text: "帮我收发票、对账、月底出一张表" },
];

/**
 * 人的那句回话 → 它的职责：第一行非空文字、折叠空白、最多 `AGENT_DESCRIPTION_MAX` 字（按 UTF-16
 * 长度——落库前那道闸 `createAgentDraft` 的 `optionalText` 就是这么量的；截断不劈开代理对）。
 * 只剩空白、或撞了威胁扫描（职责会进别的智能体的花名册，同 `scanCreateAgentThreat` 那道闸）→
 * null：不写职责，那一格照样清掉。
 */
export function roleFromReply(text: string): string | null {
  const line = text.split(/[\r\n]+/).map((l) => collapseWhitespace(l).trim()).find((l) => l !== "") ?? "";
  let out = "";
  for (const ch of line) {
    if (out.length + ch.length > AGENT_DESCRIPTION_MAX) break;
    out += ch;
  }
  out = out.trimEnd();
  if (out === "") return null;
  return scanCreateAgentThreat({ description: out }) === null ? out : null;
}

/**
 * 「它在等人说它是干什么的」那一段（null = 谁都没在等）。
 * asking —— 开场白落了、它还没答；asked —— 它答过了（anchor = 那一条回话的 seq，六句现成话挂在它
 * 底下）；failed —— 它那一轮收口了却一句话都没答出来（出错 / 被人停了 / 只跑了工具）：它没问过，
 * 人的下一句就不是回答。
 */
export interface RoleWait {
  agentId: string;
  phase: "asking" | "asked" | "failed";
  anchor: number | null;
}

/**
 * 这一条事件之后，「它在等人说它是干什么的」那一段处于哪个阶段。runtime（这句话要不要去结算
 * 职责）与手机（六句现成话画不画）共用这一份：
 * - 带 `greeting: "new_agent"` 的开场白 → 它点的那一只进入 `asking`（没点谁 → null）；
 * - 人的一句 `user_message`（判据同 `humanSpeakerOf`：不含接力 / 招呼开场白、不含 engine 旁白）→
 *   等完了（null）；
 * - 只在 `asking` 阶段才看接下来两种事件：它答出一句有正文的回话（不是工具中间步骤的
 *   `assistant_message`）→ `asked`（`anchor` 记那一条回话的 seq）；它那一轮收口了
 *   （`turn_ended`，`agentId` 是它、`outcome` 不是 `"interrupted"`）却还没进 `asked` → `failed`。
 *   **`"interrupted"` 不算收口**：那是重启补跑前写的记号（见 `TurnEndedEvent` 的文档注释与
 *   ADR-0296「interrupted = 还没人答」），一条正要被重跑的招呼不该被判成失败；
 * - 其余事件不改（群聊发言 `chat_message` 不起 turn，也不算「答了它那一问」；别的智能体的
 *   `assistant_message` / `turn_ended` 不算——开场白点的是谁就等谁）。
 */
export function advanceRoleWait(wait: RoleWait | null, e: SessionEvent): RoleWait | null {
  if (e.type === "user_message") {
    if (e.greeting === "new_agent") {
      const agentId = e.mentions?.[0];
      return agentId === undefined ? null : { agentId, phase: "asking", anchor: null };
    }
    return humanSpeakerOf(e) === null ? wait : null;
  }
  if (wait === null || wait.phase !== "asking") return wait;
  if (e.type === "assistant_message" && e.agentId === wait.agentId && !isAgentStep(e)) {
    return { agentId: wait.agentId, phase: "asked", anchor: e.seq };
  }
  if (e.type === "turn_ended" && e.agentId === wait.agentId && e.outcome !== "interrupted") {
    return { agentId: wait.agentId, phase: "failed", anchor: null };
  }
  return wait;
}

/** 整份日志折叠一次（runtime 装配时播种、手机进一条聊天时现算） */
export function roleWaitOf(events: readonly SessionEvent[]): RoleWait | null {
  let wait: RoleWait | null = null;
  for (const e of events) wait = advanceRoleWait(wait, e);
  return wait;
}

/**
 * 六句现成的话挂在哪一行底下：它答那句开场白的**第一条**回话（有正文、不是中间步骤的
 * `assistant_message`）的 seq。还没答（排队中 / 正在写）、人已经说过话了、或它那一轮没答出来就
 * 收口了（failed）→ null（不画）。判据从日志推，不另查库里那一格：那一格与这条开场白是 runtime
 * 在同一刻写的（抢到 'role' 才落开场白），人的第一句话一到两边一起翻篇——去读库就得在「它答完」
 * 之后再拉一次。
 */
export function roleChipsAnchor(events: readonly SessionEvent[]): number | null {
  const w = roleWaitOf(events);
  return w !== null && w.phase === "asked" ? w.anchor : null;
}

/**
 * 人的第一句话到了，要写成职责的是什么（null = 不写、只清那一格）：它那一轮没答出一句话就收口了
 * （failed）→ 不写；还在等它答（asking，人抢在它前面先说了）或它答过了（asked）→
 * `roleFromReply`(那句话)。
 */
export function settledRole(wait: RoleWait, reply: string): string | null {
  return wait.phase === "failed" ? null : roleFromReply(reply);
}
