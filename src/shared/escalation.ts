// 专员上报（#1659 第二轮）：专员在一条没有管理员的对话里（多半是主人和它的私聊）接到域外的事、或自己手上没有那把刀的事
// （排定时、给别人打电话发消息、建人），用 escalate_to_admin 把话送进主人和管理员的私聊，叫起管理员那一轮。
// 纯文案与常量，runtime / 手机共用。
import { promptSafe } from "./promptSafe.js";

export const ESCALATE_TOOL_NAME = "escalate_to_admin";
/** 上报正文上限：一件事说清楚就够，不是转一整段对话 */
export const ESCALATION_TEXT_MAX = 800;
/** 每只专员每小时最多转几次（同一条私聊房里数）：防它把管理员当成每句话都要请示的上级 */
export const ESCALATION_PER_HOUR_MAX = 6;

/** 管理员那一轮的开场白正文（落盘的就是模型看见的）。fromUid 是主人：话是主人在专员那边说的，专员只是转 */
export function escalationOpeningText(o: { fromName: string; text: string; taskTitle?: string | null }): string {
  const from = promptSafe(o.fromName);
  const task = o.taskTitle ? `（关联任务「${promptSafe(o.taskTitle)}」）` : "";
  return (
    `【专员上报】「${from}」转来一件事${task}——主人在和它的私聊里提的，那条对话里没有你：\n${o.text}\n` +
    `你来接：能办的直接办（要到点做的用 schedule_task 记一条）；要「${from}」接着做的，bring_agent 把它拉进来再派。` +
    `专员已经说清的别再回头问主人。办完在这里跟主人说一句结果。`
  );
}

/** 专员那边工具的回执：说清话去了哪、这件之后归谁 */
export function escalationSentText(adminName: string): string {
  const a = promptSafe(adminName);
  return `已转给「${a}」，它会在主人和它的私聊里接着办。这件你别再管了，回主人一句「已经转给${a}了」就行。`;
}

/** 手机时间线上那条灰条（管理员私聊里）：让主人看得见管理员为什么开口 */
export function escalationNoteText(o: { fromName: string; text: string }): string {
  const t = o.text.replace(/\s+/g, " ").trim();
  return `📨 ${o.fromName} 转来：${t.length > 60 ? `${t.slice(0, 60)}…` : t}`;
}
