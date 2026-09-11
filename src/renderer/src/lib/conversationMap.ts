// conversationMap —— 会话地图的纯逻辑：一轮怎么切、每一格叫什么、此刻在读哪一轮。
//
// 会话地图 = assistant-ui elements 的 conversation-map（registry `conversation-map` +
// `elements-conversation-map`，取回于 2026-09-11）：时间线左缘一列短横线，一轮一格，
// 悬停出预览卡，点一下跳过去。它取代了原来那条分区轨（SectionRail，ADR-0292）——那条
// 轨的格子是便宜模型判出来的「话题换了」，要凑够两个才画，而真库里 15 条长会话只有 2 条
// 凑够过，于是它在实际用的时候从来不出现。这里的格子是**投影**：一句人话加上回它的那几条
// 就是一轮，不打模型、不落事件，两轮就画得出来。
//
// 上游把前半（切轮 / 取名 / 量位置）写在 `conversation-map.aui.tsx` 组件里，本仓搬进
// lib：本地会话（assistant-ui runtime 的 ThreadMessage）与云会话（自绘时间线的
// SessionEvent）两个消费方共用同一把尺子，且纯函数单独可测
// （tests/renderer/conversationMap.test.ts）。
//
// 相对上游的改动（升级时要人工合）：
//  ① 兜底标签中文化（「Reasoning」→「思考」…）；
//  ② 本仓的附件不在 assistant-ui 的 `attachments` 里（本体在附件库、投影不碰 IPC，
//     ADR-0009），挂在 `metadata.custom.otto` 上——只发了一张图的那一轮照样叫「图片」；
//  ③ 一格都没过判定线时，「正在读哪一轮」兜底取**第一个挂着的**那一轮，不是整场第一轮：
//     本地时间线是窗口挂载（ADR-0285），窗口上沿以上的消息不在 DOM 里，视口停在窗口顶时
//     读的是窗口里的第一条，不是会话开头；
//  ④ `cloudConversationEntries` 是本仓加的（云会话那半，上游没有群聊）；
//  ⑤ 本地视口是贴底跟随（turnAnchor="bottom"），跳走那一刻要把 assistant-ui 的 autoScroll 关掉，
//     不然内容一长高就把人拽回底部——开关在 OttoThread（Viewport 公开的 autoScroll prop），不在这里；
//  ⑥ 标题 / 预览剥掉行内的 `**` `__` 反引号（上游只剥行首记号）；
//  ⑦ 落地后按住目标一小会儿：本地消息是 content-visibility，滚到附近才换成真高（见 holdOnTarget）。

import type { ThreadMessage } from "@assistant-ui/react";
import type { SessionEvent, UserAttachmentRef } from "../../../session/events.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";
import { safeSpeakerLabel, SYSTEM_SPEAKER_UID } from "../../../shared/promptSafe.js";
import {
  assistantLabel, hiddenFromCloudTimeline, systemNoteText, userRowIdentity, type VoiceCallCard,
} from "./cloudTimeline.js";

export interface ConversationMapEntry {
  id: string;
  title: string;
  preview?: string;
  /** 本仓加的：标题上面那行小字。云会话是群聊，卡片上得说是谁说的；本地只有你一个人，不给 */
  eyebrow?: string;
}

const TITLE_LENGTH = 72;
const PREVIEW_LENGTH = 240;

/** 少于这么多轮不画：一格的地图没有「别处」可去，是噪音（同原来那条分区轨的门槛理由——
    门槛本身没错，错的是它数的是「话题」） */
export const MIN_TURNS = 2;

/** 消息滚到视口顶时会落在顶边往下零点几像素处，不留这点余量的话「当前」那格会交给上一轮 */
const TOP_TOLERANCE = 1;

const partsOf = (message: ThreadMessage) => [...message.content];

const textOf = (message: ThreadMessage) =>
  partsOf(message)
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .trim();

/** 本仓的附件（改动 ②）：user_message 原事件挂在 metadata.custom.otto（toThreadMessages） */
function ottoAttachments(message: ThreadMessage): readonly UserAttachmentRef[] {
  const otto = message.metadata.custom["otto"] as { attachments?: unknown } | undefined;
  return Array.isArray(otto?.attachments) ? (otto.attachments as UserAttachmentRef[]) : [];
}

const labelOf = (message: ThreadMessage) => {
  const parts = partsOf(message);
  const tools = parts.flatMap((part) => (part.type === "tool-call" ? [part.toolName] : []));
  if (tools.length === 1) return tools[0]!;
  if (tools.length > 1) return `${tools.length} 次工具调用`;
  if (parts.some((part) => part.type === "reasoning")) return "思考";

  // 上游原话：composer 发出去的那一条把文件放在 `attachments`、`content` 留空，
  // 所以只有附件的那一轮要两处一起看。本仓还有第三处（改动 ②）
  const carriers = [...parts, ...(message.attachments ?? [])];
  const refs = ottoAttachments(message);
  if (carriers.some((carrier) => carrier.type === "image") || refs.some((r) => r.mediaType.startsWith("image/"))) {
    return "图片";
  }
  if (carriers.some((carrier) => carrier.type === "file")) return "文件";
  if (carriers.length > 0 || refs.length > 0) return "附件";
  return message.role === "user" ? "消息" : "回复";
};

/** 按词切，标题不会断在一个词中间。中文没有空格，退回硬切——上游同一个判据 */
export const cutAtWord = (text: string, limit: number) => {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const boundary = head.lastIndexOf(" ");
  return boundary > limit / 2 ? head.slice(0, boundary) : head;
};

/** 正文拆行、剥掉 markdown 的行首记号（# > * ` -）与行内的粗体 / 代码记号（改动 ⑥）、去空行。
    行内那一半是本仓加的：上游只剥行首，而本仓 agent 的回答 markdown 很重，卡片上一排
    `**你在国内还是国外？**` 读起来像乱码（#1259 真机截图）。单个 `*` 不动——它也可能是乘号 */
const linesOfText = (text: string) =>
  text
    .split("\n")
    .map((line) => line.replace(/^[\s#>*`-]+/, "").replace(/\*\*|__|`/g, "").trim())
    .filter(Boolean);

const linesOf = (message: ThreadMessage) => linesOfText(textOf(message));

/** 一句人话，加上回它的那几条 */
export type Turn = {
  head: ThreadMessage;
  members: ThreadMessage[];
};

/** system 那一族（本仓的审计行：会话创建、模型切换…）不进任何一轮 */
export const groupIntoTurns = (messages: readonly ThreadMessage[]): Turn[] => {
  const turns: Turn[] = [];

  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;

    const current = turns.at(-1);
    if (message.role === "user" || !current) {
      turns.push({ head: message, members: [message] });
      continue;
    }
    current.members.push(message);
  }

  return turns;
};

/** 标题取问的那句，预览取回答；还在答的那一轮，预览退回这句话自己剩下的部分（上游原话：
    问了什么给这一轮起名，答了什么才是有用的预览） */
export const describeTurn = ({ head, members }: Turn): ConversationMapEntry => {
  const lines = linesOf(head);
  const first = lines[0] ?? "";
  const title = cutAtWord(first, TITLE_LENGTH);

  const answer = members.find((member) => member !== head && textOf(member));
  const preview = (
    answer
      ? linesOf(answer).join(" ")
      : [first.slice(title.length), ...lines.slice(1)].join(" ")
  )
    .trim()
    .slice(0, PREVIEW_LENGTH);

  return {
    id: head.id,
    title: title || labelOf(head),
    ...(preview ? { preview } : {}),
  };
};

/** 每条消息属于哪一轮：视口里任何一条消息都能替它那一轮说「我在屏幕上」 */
export function turnOwners(turns: readonly Turn[]): Map<string, string> {
  const owners = new Map<string, string>();
  for (const turn of turns) {
    for (const member of turn.members) owners.set(member.id, turn.head.id);
  }
  return owners;
}

/** 流式期间 runtime 的消息数组每个 token 换一次引用，而条目里真在变的只有最后一轮的
    预览（且过了 240 字就不再变）。逐项比一遍，一样就交回上一份——刻度那一列不跟着每个
    token 重渲，悬停卡也不会在人读的时候被一帧帧换掉内容对象 */
export function reuseEntries(
  prev: readonly ConversationMapEntry[],
  next: readonly ConversationMapEntry[]
): readonly ConversationMapEntry[] {
  if (prev.length !== next.length) return next;
  for (let i = 0; i < next.length; i++) {
    const a = prev[i]!;
    const b = next[i]!;
    if (a.id !== b.id || a.title !== b.title || a.preview !== b.preview || a.eyebrow !== b.eyebrow) return next;
  }
  return prev;
}

/** 云会话那半（改动 ④）。一轮的头是**人说的话**——点火的那句（`UserMessageRow`）与没点火
    的闲聊（`ChatMessageRow`），外加一场语音通话那张卡（它在时间线上本来就自成一段对话）；
    agent 的答案、接力线、出错行都算前一个头的成员，第一条答案当预览。

    跳过的判据与渲染循环逐条同一套（hiddenFromCloudTimeline / 被通话卡吞掉的 / 系统旁白 /
    runtime 自己的发言）：这里多认一个头，就是一格点了跳不过去的刻度；少认一个，就是时间线
    上有一句话地图上找不到。渲染循环给头行打记号时查的就是这份结果的 id，不另判一遍 */
export function cloudConversationEntries(
  events: readonly SessionEvent[],
  ws: WorkspaceSnapshot,
  selfUid: string,
  voice: { cards: ReadonlyMap<number, VoiceCallCard>; folded: ReadonlySet<number> }
): ConversationMapEntry[] {
  const entries: ConversationMapEntry[] = [];
  /** 还在等预览的那个头的下标；-1 = 没有（还没出现过头，或上一个头是通话卡） */
  let open = -1;

  const pushHead = (seq: number, text: string, eyebrow: string | null): void => {
    const first = linesOfText(text)[0] ?? "";
    entries.push({
      id: String(seq),
      title: cutAtWord(first, TITLE_LENGTH) || "消息",
      ...(eyebrow ? { eyebrow } : {}),
    });
    open = entries.length - 1;
  };

  for (const e of events) {
    if (hiddenFromCloudTimeline(e) || voice.folded.has(e.seq)) continue;
    if (e.type === "user_message") {
      // 护栏 / 后台任务回注：engine 自己注的话，时间线上画成旁白，不是谁说的一句
      if (systemNoteText(e, ws) !== null) continue;
      const identity = userRowIdentity(e, ws, selfUid);
      pushHead(e.seq, identity.text, identity.label);
      continue;
    }
    if (e.type === "chat_message") {
      // runtime 自己说的话（接力护栏 / 棒数上限…）同样画成旁白
      if (e.fromUid === SYSTEM_SPEAKER_UID) continue;
      pushHead(e.seq, e.content, safeSpeakerLabel(e.label, e.fromUid));
      continue;
    }
    if (e.type === "voice_call_changed") {
      const card = voice.cards.get(e.seq);
      if (!card) continue;
      const names = card.parties.map((p) => p.name).join("、");
      entries.push({ id: String(e.seq), title: "语音通话", preview: `${names} · ${card.utterances} 句` });
      // 通话里的答案已经折进卡里了；卡后面冒出来的答案属于这张卡之后的事，不是它的预览
      open = -1;
      continue;
    }
    if (e.type === "assistant_message" && open !== -1) {
      const entry = entries[open]!;
      const text = linesOfText(e.content).join(" ");
      if (entry.preview === undefined && text !== "") {
        entries[open] = { ...entry, preview: `${assistantLabel(e, ws)}：${text}`.slice(0, PREVIEW_LENGTH) };
      }
    }
  }
  return entries;
}

/** 读到哪条线才算「在读这一轮」。大半场钉在视口顶，最后一屏滑到底：离结尾不到一屏高的
    消息永远到不了顶，线要是钉死，最后一屏那几格就永远点不亮（上游原话） */
export const readingLine = (viewport: HTMLElement): number => {
  const rect = viewport.getBoundingClientRect();
  const height = viewport.clientHeight;
  if (height <= 0) return rect.top + TOP_TOLERANCE;

  const remaining = viewport.scrollHeight - height - viewport.scrollTop;
  const descent = Math.min(1, Math.max(0, (height - remaining) / height));
  return rect.top + rect.height * descent + TOP_TOLERANCE;
};

/** 一次扫描给出刻度要画的两件事：正在读哪一轮、视口里有哪几轮（上游 measure 的本体）。
    `marks` 按 DOM 顺序；`ownerOf` 把带记号的元素映射到它那一轮的头，认不出回 undefined */
export function measureTurns(
  viewport: HTMLElement,
  marks: Iterable<HTMLElement>,
  ownerOf: (el: HTMLElement) => string | undefined
): { current: string | undefined; onScreen: string[] } {
  const view = viewport.getBoundingClientRect();
  const line = readingLine(viewport);

  let current: string | undefined;
  let firstSeen: string | undefined;
  const onScreen: string[] = [];
  for (const element of marks) {
    const head = ownerOf(element);
    if (head !== undefined) firstSeen ??= head;
    const box = element.getBoundingClientRect();
    if (box.top >= view.bottom) break;
    if (head === undefined) continue;

    if (box.top <= line) current = head;
    if (box.bottom > view.top && !onScreen.includes(head)) onScreen.push(head);
  }
  return { current: current ?? firstSeen, onScreen };
}

/** 用户自己动了就别再替他对准：滚轮、按下、键盘、触摸，任何一样都说明他有了新主意 */
const USER_INPUT = ["wheel", "pointerdown", "keydown", "touchstart"] as const;
/** 按住目标的最长时限：落稳就提前收手，这只是封顶 */
const HOLD_MS = 1000;
/** 连续这么多帧目标没挪（或已经挪不动了）就算落稳 */
const STABLE_FRAMES = 8;
/** 平滑滚动的 scrollend 最多等这么久：它只在真滚了之后才来，目标本来就在顶上时一个都不会来 */
const SCROLLEND_TIMEOUT_MS = 1500;

const nextFrame = (fn: () => void): void => {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(fn);
  else setTimeout(fn, 16);
};

/** 落地之后按住目标一小会儿（改动 ⑦，#1259 真机撞见的）。本地时间线的消息是
    `content-visibility: auto`（thread.tsx，`contain-intrinsic-size: auto 200px`）：没渲染过的
    消息按 200px 估，滚到附近才换成真高。平滑滚动瞄的是出发那一刻算出的绝对位置，一路上被经过
    的消息纷纷换成真高，落点跟着偏（真机上落在了前一轮）；落地之后目标**上方**那条消息也还会
    换成真高，而浏览器的滚动锚定这时未必锚在目标上（真机上它锚在上一条、目标被顶下去 225px）。
    所以落地后逐帧量一次，偏了就瞬时补回去，连续几帧不动（或已经挪不动了——最后一屏的轮次
    到不了顶）就收手，最多按住 HOLD_MS。用户在这期间自己动了（USER_INPUT）立刻放手——替人拽回去
    是抢方向盘。`onSettled` 在收手时回调一次（不论落稳、超时还是被用户打断） */
function holdOnTarget(
  viewport: HTMLElement,
  element: HTMLElement,
  waitForScrollEnd: boolean,
  onSettled: (() => void) | undefined
): void {
  let done = false;
  let holding = false;
  let stable = 0;
  let deadline = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const finish = (): void => {
    if (done) return;
    done = true;
    for (const type of USER_INPUT) viewport.removeEventListener(type, finish);
    viewport.removeEventListener("scrollend", hold);
    if (timer !== undefined) clearTimeout(timer);
    onSettled?.();
  };
  const step = (): void => {
    if (done) return;
    if (!element.isConnected) return finish();
    const drift = element.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    if (Math.abs(drift) > 1) {
      const before = viewport.scrollTop;
      viewport.scrollTo({ top: before + drift, behavior: "instant" });
      // 挪不动了（到头了）也算落稳：再按下去只是空转到时限
      stable = viewport.scrollTop === before ? stable + 1 : 0;
    } else {
      stable += 1;
    }
    if (stable >= STABLE_FRAMES || Date.now() >= deadline) return finish();
    nextFrame(step);
  };
  function hold(): void {
    if (done || holding) return;
    holding = true;
    viewport.removeEventListener("scrollend", hold);
    if (timer !== undefined) clearTimeout(timer);
    deadline = Date.now() + HOLD_MS;
    step();
  }

  for (const type of USER_INPUT) viewport.addEventListener(type, finish, { passive: true });
  if (waitForScrollEnd) {
    viewport.addEventListener("scrollend", hold);
    timer = setTimeout(hold, SCROLLEND_TIMEOUT_MS);
  } else {
    nextFrame(hold);
  }
}

/** 把一格刻度指的那一轮滚到视口顶（上游 select 的本体），然后按住它直到落稳（holdOnTarget）。
    不用 scrollIntoView：它会把**每一层**可滚动的祖先都对齐一遍，嵌在页面里的时间线会连页面
    一起拖走。减动效时要显式 `instant`：本地视口挂着 `scroll-smooth`，`behavior: "auto"` 会被
    那条 CSS 接管成平滑（同 thread.tsx 窗口补偿那处的坑）。
    `instant: true` 给 reveal 桥那条路：刚补挂的那一大段还在排版，平滑滚过去是在追一个移动的目标。
    贴底跟随不归这里管：本地视口的 autoScroll 由 OttoThread 在跳走的那一刻关掉（改动 ⑤）——
    不关的话，内容一长高它就把人拽回底部，按住也按不住 */
export function scrollToTurn(
  viewport: HTMLElement,
  element: HTMLElement,
  { instant = false, onSettled }: { instant?: boolean; onSettled?: (() => void) | undefined } = {}
): void {
  const top = element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const smooth = !instant && !reduce;
  viewport.scrollTo({ top, behavior: smooth ? "smooth" : "instant" });
  holdOnTarget(viewport, element, smooth, onSettled);
}
