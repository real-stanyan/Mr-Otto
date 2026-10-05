// 外联挂断之后那段打字（#1673）：电话挂了，朋友还能在通话记录底下打字找主人的智能体。挂断那一刻的汇报
// （outreachHub.ended → reportOutreach）只带一次，之后这里说的话没有任何出口——真机 2026-10-05：Stan 在
// 挂断四个钟头后打字「没找到，要不你再发一次？」，雨姐答「行，那我带回去」，手上有 relay_to_owner 却没调，
// 主人那边什么都没收到。
//
// 兜底：挂断后的这段对话安静下来（最后一轮收口后 IDLE_MS 内对面没再说话），这段里又没有调过 relay_to_owner，
// 就把这段原话自动带回主人和管理员的私聊（同 relay_to_owner 那条路：outreachRelay.toOwner）。
// 通话进行中不管——挂断时的汇报已经带着通话记录。纯状态机 + 注入的计时器，sessionService 只喂事件。
import type { SessionEvent } from "../../../src/session/events.js";
import { RELAY_TEXT_MAX, RELAY_TO_OWNER_TOOL_NAME } from "../../../src/shared/outreach.js";

export const OUTREACH_FOLLOWUP_IDLE_MS = 2 * 60_000;

export interface OutreachFollowupDeps {
  peerUid: string;
  peerName: string;
  agentName: () => string;
  send: (text: string) => Promise<string>;
  /** 房归档了就不送 */
  archived: () => boolean;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
  log: (m: string) => void;
}

type Line = { who: "peer" | "agent"; text: string };

/** 「[Stan Yan]: 行」→「行」：人话落盘时带着发话人前缀 */
function stripSpeaker(s: string): string {
  return s.replace(/^\[[^\]\n]{1,64}\]:\s*/u, "").trim();
}

/** 带回去的那段：说清是挂断后打的字，原话照录；超长留尾巴（最近的话最要紧） */
export function outreachFollowupText(peerName: string, agentName: string, lines: readonly Line[]): string {
  const head = `（电话挂断后 ${peerName} 在通话记录里打字，「${agentName}」答应带回来，原话：）`;
  const body = lines.map((l) => `${l.who === "peer" ? peerName : agentName}：${l.text.replace(/\s+/gu, " ")}`);
  let text = `${head}\n${body.join("\n")}`;
  while ([...text].length > RELAY_TEXT_MAX && body.length > 1) {
    body.shift();
    text = `${head}\n…\n${body.join("\n")}`;
  }
  return [...text].length > RELAY_TEXT_MAX ? [...text].slice(0, RELAY_TEXT_MAX).join("") : text;
}

export function createOutreachFollowup(d: OutreachFollowupDeps) {
  let lines: Line[] = [];
  let relayed = false;
  let timer: unknown = null;
  const stop = (): void => {
    if (timer !== null) d.clearTimer(timer);
    timer = null;
  };
  const reset = (): void => {
    stop();
    lines = [];
    relayed = false;
  };
  const fire = (): void => {
    timer = null;
    if (d.archived() || relayed || !lines.some((l) => l.who === "peer")) {
      reset();
      return;
    }
    const text = outreachFollowupText(d.peerName, d.agentName(), lines);
    reset();
    d.send(text).then(
      (r) => d.log(`外联挂断后的留言已带回主人（${d.peerName}）：${r}`),
      (err: unknown) => d.log(`外联挂断后的留言没带回去（${d.peerName}）：${String(err)}`),
    );
  };
  return {
    /** live = 此刻有一通外联正在进行（activeOutreach !== null） */
    observe(e: SessionEvent, live: boolean): void {
      if (live) {
        // 通话中说的话由挂断时的汇报带走；挂断前积的也一并作废
        if (lines.length > 0 || timer !== null) reset();
        return;
      }
      if (e.type === "user_message" && e.fromUid === d.peerUid && e.greeting === undefined && e.relay === undefined) {
        stop(); // 对面还在说：等这一段说完
        const t = stripSpeaker(e.content);
        if (t !== "") lines.push({ who: "peer", text: t });
        return;
      }
      if (e.type === "assistant_message") {
        if (e.toolCalls?.some((c) => c.name === RELAY_TO_OWNER_TOOL_NAME)) relayed = true;
        if (e.ack !== true && (e.toolCalls === undefined || e.toolCalls.length === 0) && e.content.trim() !== "" && lines.length > 0) {
          lines.push({ who: "agent", text: e.content.trim() });
        }
        return;
      }
      if (e.type === "turn_ended" && lines.some((l) => l.who === "peer")) {
        stop();
        timer = d.setTimer(fire, OUTREACH_FOLLOWUP_IDLE_MS);
      }
    },
    dispose: reset,
  };
}
