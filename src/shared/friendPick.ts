// friendPick —— 智能体打电话认不准是哪位好友时的选人卡（#1520，spec 2026-10-04-friend-pick-card-design）：
// 判定（直接拨 / 出卡 / 回文字）、名字相近、卡的折叠与状态。纯逻辑零 IO，runtime 与手机共用——
// 「这张卡此刻还能不能点」的判据只能有一处（同 outreach.ts / callRing.ts 的纪律）。
import type { FriendPickCandidate, FriendPickEvent, SessionEvent } from "../session/events.js";
import { outreachTierProblem, type FriendTier } from "./friendTier.js";
import type { OutreachFold } from "./outreach.js";

export const FRIEND_PICK_TTL_MS = 10 * 60_000;
export const FRIEND_PICK_MAX = 4;

export interface PickFriendInput {
  friends: readonly { uid: string; name: string; tier?: FriendTier }[];
  /** 模型照用户原话写的称呼 */
  wanted: string;
  /** 模型自己拿不准时列的 2–4 个名字 */
  candidates?: readonly string[];
  /** 这条聊天里打过的好友，新的在前（recentPeerUids） */
  recentUids: readonly string[];
}
export type PickDecision =
  | { kind: "dial"; uid: string; name: string }
  | { kind: "card"; question: string; candidates: FriendPickCandidate[] }
  | { kind: "text"; message: string };

const ASK = "你要打给哪位？点一下我就拨。";

/** NFKC、小写、去掉空白与标点 */
function squash(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}
function words(s: string): string[] {
  return s.normalize("NFKC").toLowerCase().split(/[\s\p{P}]+/u).filter((w) => [...w].length >= 2);
}
function editDistance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length]!;
}

/** 名字相近（spec §3）：包含（短的至少 2 字）/ 有一个相同的词（至少 2 字）/ 编辑距离 ≤ ⌊较长 / 3⌋（较长至少 3 字） */
export function namesSimilar(a: string, b: string): boolean {
  const sa = squash(a);
  const sb = squash(b);
  if (sa === "" || sb === "") return false;
  const [short, long] = [...sa].length <= [...sb].length ? [sa, sb] : [sb, sa];
  if ([...short].length >= 2 && long.includes(short)) return true;
  const wb = new Set(words(b));
  if (words(a).some((w) => wb.has(w))) return true;
  const longLen = [...long].length;
  return longLen >= 3 && editDistance(sa, sb) <= Math.floor(longLen / 3);
}

const callable = (f: { name: string; tier?: FriendTier }): boolean =>
  f.tier === undefined || outreachTierProblem(f.tier, f.name) === null;

export function pickFriend(o: PickFriendInput): PickDecision {
  const w = o.wanted.trim();
  // ① 模型自己点了名：按名字换成好友（同名的全收），只留能打的
  if (o.candidates !== undefined && o.candidates.length > 0) {
    const seen = new Set<string>();
    const out: FriendPickCandidate[] = [];
    for (const n of o.candidates) {
      for (const f of o.friends) {
        if (f.name.trim() !== n.trim() || seen.has(f.uid) || !callable(f)) continue;
        seen.add(f.uid);
        out.push({ uid: f.uid, name: f.name, why: "" });
      }
    }
    if (out.length > 0) return { kind: "card", question: ASK, candidates: out.slice(0, FRIEND_PICK_MAX) };
  }
  // ② 精确命中一人：照现状
  const hits = o.friends.filter((f) => f.name.trim() === w);
  if (hits.length === 1) {
    const f = hits[0]!;
    const refused = f.tier === undefined ? null : outreachTierProblem(f.tier, f.name);
    return refused !== null ? { kind: "text", message: refused } : { kind: "dial", uid: f.uid, name: f.name };
  }
  // ③ 对不上或重名：最近打过 → 同名 → 名字相近
  const byUid = new Map(o.friends.map((f) => [f.uid, f]));
  const dup = new Set(hits.map((f) => f.uid));
  const ranked: { uid: string; why: string }[] = [];
  const taken = new Set<string>();
  o.recentUids.forEach((uid, i) => {
    if (taken.has(uid) || !byUid.has(uid)) return;
    taken.add(uid);
    ranked.push({ uid, why: dup.has(uid) ? "同名 · 最近打过" : i === 0 ? "上次打的就是他" : "最近打过" });
  });
  for (const f of hits) if (!taken.has(f.uid)) { taken.add(f.uid); ranked.push({ uid: f.uid, why: "同名" }); }
  for (const f of o.friends) if (!taken.has(f.uid) && namesSimilar(w, f.name)) { taken.add(f.uid); ranked.push({ uid: f.uid, why: "名字相近" }); }
  const cands = ranked
    .map((r) => ({ f: byUid.get(r.uid)!, why: r.why }))
    .filter((r) => callable(r.f))
    .slice(0, FRIEND_PICK_MAX)
    .map((r) => ({ uid: r.f.uid, name: r.f.name, why: r.why }));
  if (cands.length > 0) {
    const question = hits.length > 1 ? `好友里有 ${hits.length} 位叫「${w}」。${ASK}` : `好友里没有叫「${w}」的。${ASK}`;
    return { kind: "card", question, candidates: cands };
  }
  if (hits.length > 1) return { kind: "text", message: `好友里有 ${hits.length} 位叫「${w}」，分不出是哪一位，问问他。` };
  const names = [...new Set(o.friends.map((f) => f.name.trim()).filter((n) => n !== ""))];
  return names.length === 0
    ? { kind: "text", message: "他还没有好友，打不了。" }
    : { kind: "text", message: `好友里没有叫「${w}」的。他的好友有：${names.join("、")}。问问他指的是哪一位。` };
}

/** 这条聊天里打过的好友，按那一通开始的时间新的在前、去重（「上次打的就是他」按 uid 认，改名不影响） */
export function recentPeerUids(fold: OutreachFold): string[] {
  const out: string[] = [];
  for (const s of [...fold.values()].sort((a, b) => b.startedTs - a.startedTs)) if (!out.includes(s.peerUid)) out.push(s.peerUid);
  return out;
}

export function friendPickToolText(names: readonly string[]): string {
  return `没认准是哪位，已经弹了张卡让他点选（候选：${names.join("、")}）。卡片自己会问，你这一轮不用再说话；他点了电话会直接拨出去，不用你再调 call_friend。`;
}

export interface FriendPickState {
  pickId: string; fromAgentId: string; offeredTs: number; seq: number; question: string;
  candidates: FriendPickCandidate[]; brief: string; opening: string;
  phase: FriendPickEvent["phase"]; uid: string | null; message: string | null;
  /** 之后同一条聊天又出了一张卡（这张还开着时被顶掉） */
  superseded: boolean;
}
export type FriendPickFold = Map<string, FriendPickState>;

export function applyFriendPick(fold: FriendPickFold, e: SessionEvent): void {
  if (e.type !== "friend_pick") return;
  if (e.phase === "offered") {
    for (const s of fold.values()) if (s.phase === "offered") s.superseded = true;
    fold.set(e.pickId, {
      pickId: e.pickId, fromAgentId: e.fromAgentId, offeredTs: e.ts, seq: e.seq, question: e.question ?? "",
      candidates: e.candidates ?? [], brief: e.brief ?? "", opening: e.opening ?? "",
      phase: "offered", uid: null, message: null, superseded: false,
    });
    return;
  }
  const prev = fold.get(e.pickId);
  if (prev === undefined) return; // 窗口裁掉了开头：不知道卡上是谁
  fold.set(e.pickId, { ...prev, phase: e.phase, uid: e.uid ?? prev.uid, message: e.message ?? prev.message });
}
export function friendPickFoldOf(events: readonly SessionEvent[]): FriendPickFold {
  const fold: FriendPickFold = new Map();
  for (const e of events) applyFriendPick(fold, e);
  return fold;
}

export type FriendPickStatus = "open" | "picked" | "dismissed" | "failed" | "expired";
export function friendPickStatus(st: FriendPickState, now: number): FriendPickStatus {
  if (st.phase !== "offered") return st.phase;
  return st.superseded || now - st.offeredTs > FRIEND_PICK_TTL_MS ? "expired" : "open";
}
