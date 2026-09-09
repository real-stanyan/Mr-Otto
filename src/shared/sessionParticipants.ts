// sessionParticipants —— 「最近谁在这条会话里说过话」的纯投影（#1213）。
//
// 云会话侧栏那行右边要画一排头像，回答的是「最近有过对话的那个 5 小时窗里，
// 有哪些人类成员参与过」。窗口是**固定窗**（floor(ts / 5h) 切成不重叠的桶），
// 显示的永远是**最后一个有过对话的窗**——所以一旦有过对话这一格就不会再变空，
// 也不需要一个定时器让它到点过期。这条化简掉了历史维度：只有一个当前值。
//
// runtime 把这个投影写进 `workspace_sessions` 的两列，桌面直查那张表——权威日志
// 在 VPS 上，桌面够不着（要先开一条会话房才读得到 backlog），而这一格必须在一条
// 会话都没开的时候就画得出来（同 #1064 点名角标的形状）。**库是投影不是事实**。
//
// 放 shared 而不是 services/runtime：窗口长度这个数桌面写文案时要用（「最近 5 小时」），
// 同一个数在两处各写一遍必然分家。

import type { SessionEvent } from "../session/events.js";

/** 一个窗口多长。**只在这里定义一次** */
export const PARTICIPANT_WINDOW_MS = 5 * 60 * 60 * 1000;

/** 时刻 → 窗口编号。固定窗按 epoch 切，边界归后一个窗 */
export function windowIndexOf(ts: number): number {
  return Math.floor(ts / PARTICIPANT_WINDOW_MS);
}

/**
 * 这条事件是不是「有个人真的打出来的一句话」；是就回他的 uid。
 *
 * 三条：
 * - `chat_message` 且 `fromUid` 不是保留名 `system`（系统旁白不是人说的）；
 * - `user_message` 且 `fromUid` 在场、**且 `relay` / `greeting` 都缺席**；
 * - agent 的话走 `assistant_message`，压根没有 `fromUid`，天然不进。
 *
 * 排除 relay / greeting 是这条判据里唯一不显然的一处：那两种开场白的 `fromUid`
 * 是**点火的那个人**（ADR-0223 §4.2 / #1174），不排除的话一条接力链会在几小时
 * 之后、在他早就离开的窗里，替他重新「参与」一次。判据与 `hiddenFromCloudTimeline`
 * 第 ①⑦ 条逐字相同——问的是同一件事。
 *
 * `dispatch: "auto"` 的那条**照常算**：那就是人自己打出来的话，只是收件人由分类器
 * 挑的（#1153）。
 */
export function humanSpeakerOf(e: SessionEvent): string | null {
  if (e.type === "chat_message") {
    return e.fromUid !== "" && e.fromUid !== "system" ? e.fromUid : null;
  }
  if (e.type === "user_message") {
    if (e.relay !== undefined || e.greeting !== undefined) return null;
    return e.fromUid !== undefined && e.fromUid !== "" ? e.fromUid : null;
  }
  return null;
}

/** 最后一个有过人类发言的窗，以及那个窗里说过话的人（首次出现的顺序、已去重） */
export interface ParticipantWindow {
  window: number;
  uids: string[];
}

/**
 * 从日志算出当前该显示的那一份。倒着扫，找最后一条人类发言、算它的窗，继续往前
 * 收同窗的人，越过窗起点就停——**有界**（一个 5 小时窗里的消息数），不扫全量。
 *
 * 顺序是**首次出现**：先倒着收原始序列（不去重），再反过来去重。按最近说话的排前面
 * 会让那排头像因为谁又说了一句就整排跳动。
 */
export function lastActiveWindowParticipants(events: readonly SessionEvent[]): ParticipantWindow | null {
  let window: number | null = null;
  const backwards: string[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    const uid = humanSpeakerOf(e);
    if (uid === null) continue;
    const w = windowIndexOf(e.ts);
    if (window === null) window = w;
    else if (w < window) break;
    backwards.push(uid);
  }
  if (window === null) return null;
  const uids: string[] = [];
  for (const uid of backwards.reverse()) if (!uids.includes(uid)) uids.push(uid);
  return { window, uids };
}

/**
 * 增量推进（装配时整份折叠一次、之后每条事件推一步，同 sessionService 里
 * `relayBounds` / `voiceCall` 的手法）。**没变时回同一个引用**——调用方据此决定
 * 要不要打一次网络。时钟回拨（更早的窗）一律忽略，不让窗口倒退。
 */
export function advanceParticipants(
  cur: ParticipantWindow | null,
  e: SessionEvent
): ParticipantWindow | null {
  const uid = humanSpeakerOf(e);
  if (uid === null) return cur;
  const w = windowIndexOf(e.ts);
  if (cur === null || w > cur.window) return { window: w, uids: [uid] };
  if (w < cur.window) return cur;
  return cur.uids.includes(uid) ? cur : { window: cur.window, uids: [...cur.uids, uid] };
}

/** 这条会话累计有多少条人类发言（标题的档位判据用它） */
export function countHumanMessages(events: readonly SessionEvent[]): number {
  let n = 0;
  for (const e of events) if (humanSpeakerOf(e) !== null) n++;
  return n;
}
