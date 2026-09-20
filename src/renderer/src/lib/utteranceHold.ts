// utteranceHold —— 语音通话里「这句话说完了吗」的扣住 / 合并状态机（#1281，spec §5.4 ⑤）。
//
// 病：helper 的 `utteranceLooksFinished` 是标点启发式（句末标点 = 说完），而识别器在人
// 换气时就补句号——于是 700ms 收口，一句「我想让你。帮我看一下构建。」切成两条发出去，
// 前半条还会先起一轮 turn（#1196 的同一族）。
//
// 治法：人一停嘴（能量门从真变假）就**投机**问一次决策模型「这句说完了吗」；700ms 之后
// helper 的 `final` 到时答案通常已经回来——判「没说完」就把这句扣住，等下一句来了合并成
// 一条再发。全程不动 Swift：重编 helper 要维护者重新点一次 TCC 授权（ADR-0273 / 0277）。
// 所以**只治切碎，不治另一半**（没标点的整句白等 2.5s——那要给 helper 加 `commit` 命令）。
//
// 纯函数：时间与副作用全部从外面来（同 Swift 那个 `Endpointer` 的写法，测试不用等）。
// 调用方（store.ts）把 `judge` 变成一次 IPC、把 `wake` 变成一个 setTimeout、把 `send`
// 变成 cloudSay。
//
// 三条保命线：
//   ① **判不出来 = 说完了**：答案没到 / 问失败 / 从没问过，一律照今天的发。
//   ② 两道封顶：最多连扣 HOLD_MAX_MERGES 次；从第一次扣住起 HOLD_MAX_AGE_MS 无论如何发。
//      决策模型判错的最坏后果因此是「这句话晚 1.8 秒出门」，不是「这句话没了」。
//   ③ `hold: false`（影子期）：照问不误（主进程那侧据此记对照日志），但**一拍都不耽误**
//      ——连「等答案那 200ms」都不等。

import { HOLD_MS } from "../../../shared/utteranceTiming.js";

/** P(说完了) 低于它才扣。**初值**，由影子期的真值数据改：那一处的真值是观测得到的
    （final 之后 1.8 秒内人有没有接着说），主进程的 endpointJudge 在记 */
export const HOLD_BELOW = 0.35;

/* ── 扣住之后等人接着说的时长搬去了 `src/shared/utteranceTiming.ts`（#1281：主进程
      endpointJudge.ts 的真值窗口要量同一扇窗，而主进程不该 import 渲染层）。这里
      原样再导出，既有 import 点一个都不用改，「同一个数只有一份」也仍然看得见。 ── */
export { HOLD_MS } from "../../../shared/utteranceTiming.js";
/** final 到了、答案还在路上：最多再等这么久。投机问是在 ≥700ms 之前发出的，
    正常情况下答案早到了；这一格只兜「这一次特别慢」 */
export const VERDICT_WAIT_MS = 200;
export const HOLD_MAX_MERGES = 3;
export const HOLD_MAX_AGE_MS = 8000;
const VERDICTS_KEPT = 8;
/** 「嗯」「好」不值得问：一个字的应声怎么判都是说完了 */
const MIN_JUDGE_CHARS = 2;

export interface HoldState {
  /** 扣着的文字；空串 = 没扣着 */
  buffer: string;
  merges: number;
  /** 第一次扣住的时刻（总封顶从它起算） */
  heldSince: number | null;
  /** 哪一刻该把 buffer 发出去；null = 没有表在走 */
  flushAt: number | null;
  /** 最近几段的答案，按「新那一段」的文字记（不按合起来的那句——final 到时手里只有新那一段） */
  verdicts: readonly { key: string; p: number }[];
  /** 在途那一问的 key。同一时刻最多一个：网关按人限 4 个并发，语音不该挤掉聊天那条流 */
  asked: string | null;
  /** final 到了、答案没到 */
  waiting: { text: string; until: number } | null;
}

export const HOLD_IDLE: HoldState = { buffer: "", merges: 0, heldSince: null, flushAt: null, verdicts: [], asked: null, waiting: null };

export type HoldEvent =
  | { type: "quiet"; text: string }
  | { type: "verdict"; key: string; p: number | null }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "tick" }
  | { type: "reset" };

export type HoldEffect =
  | { type: "judge"; key: string; text: string }
  | { type: "send"; text: string }
  | { type: "wake"; at: number };

type Step = { state: HoldState; effects: HoldEffect[] };

const isAscii = (ch: string | undefined): boolean => ch !== undefined && ch.charCodeAt(0) < 128;
/** 两段接成一句：中文直接接，两头都是 ASCII 才补一个空格 */
export function joinSpoken(a: string, b: string): string {
  if (a === "") return b;
  if (b === "") return a;
  return isAscii(a.at(-1)) && isAscii(b[0]) ? `${a} ${b}` : `${a}${b}`;
}

const released = (s: HoldState): HoldState => ({ ...s, buffer: "", merges: 0, heldSince: null, flushAt: null, waiting: null });

/** 这一段的去向定下来了：扣住，还是（连同之前扣着的）发出去 */
function settle(s: HoldState, text: string, p: number | null, now: number, hold: boolean): Step {
  const full = joinSpoken(s.buffer, text);
  const canHold =
    hold && p !== null && p < HOLD_BELOW && s.merges < HOLD_MAX_MERGES &&
    (s.heldSince === null || now - s.heldSince < HOLD_MAX_AGE_MS);
  if (!canHold) return { state: released(s), effects: [{ type: "send", text: full }] };
  const flushAt = now + HOLD_MS;
  return {
    state: { ...s, buffer: full, merges: s.merges + 1, heldSince: s.heldSince ?? now, flushAt, waiting: null },
    effects: [{ type: "wake", at: flushAt }],
  };
}

export function holdStep(s: HoldState, ev: HoldEvent, now: number, opts: { hold: boolean }): Step {
  const same: Step = { state: s, effects: [] };
  switch (ev.type) {
    case "quiet": {
      const key = ev.text.trim();
      if (key.length < MIN_JUDGE_CHARS || s.asked === key || s.verdicts.some((v) => v.key === key)) return same;
      // 问的是**合起来**的那句：后半句单独看往往是完整的，合起来才看得出它是不是一整句
      return { state: { ...s, asked: key }, effects: [{ type: "judge", key, text: joinSpoken(s.buffer, key) }] };
    }
    case "verdict": {
      const verdicts = ev.p === null ? s.verdicts : [...s.verdicts.filter((v) => v.key !== ev.key), { key: ev.key, p: ev.p }].slice(-VERDICTS_KEPT);
      const next: HoldState = { ...s, verdicts, asked: s.asked === ev.key ? null : s.asked };
      if (next.waiting !== null && next.waiting.text === ev.key) return settle({ ...next, waiting: null }, ev.key, ev.p, now, opts.hold);
      return { state: next, effects: [] };
    }
    case "partial": {
      if (s.buffer === "" || ev.text.trim() === "") return same;
      // 人接着说了：1.8s 那只表停掉（等下一个 final 来合并），只留总封顶
      const flushAt = (s.heldSince ?? now) + HOLD_MAX_AGE_MS;
      return flushAt === s.flushAt ? same : { state: { ...s, flushAt }, effects: [{ type: "wake", at: flushAt }] };
    }
    case "final": {
      const text = ev.text.trim();
      if (text === "") return same;
      if (s.waiting !== null) {
        // 上一句还在等答案、下一句已经到了：上一句按说完了算，再处理这一句
        const first = settle({ ...s, waiting: null }, s.waiting.text, null, now, opts.hold);
        const second = holdStep(first.state, ev, now, opts);
        return { state: second.state, effects: [...first.effects, ...second.effects] };
      }
      const known = s.verdicts.find((v) => v.key === text);
      if (known !== undefined) return settle(s, text, known.p, now, opts.hold);
      if (opts.hold && s.asked === text) {
        const until = now + VERDICT_WAIT_MS;
        return { state: { ...s, waiting: { text, until } }, effects: [{ type: "wake", at: until }] };
      }
      return settle(s, text, null, now, opts.hold);
    }
    case "tick": {
      let cur = s;
      const effects: HoldEffect[] = [];
      if (cur.waiting !== null && now >= cur.waiting.until) {
        const r = settle({ ...cur, waiting: null }, cur.waiting.text, null, now, opts.hold);
        cur = r.state;
        effects.push(...r.effects);
      }
      if (cur.buffer !== "" && cur.flushAt !== null && now >= cur.flushAt) {
        effects.push({ type: "send", text: cur.buffer });
        cur = released(cur);
      }
      return { state: cur, effects };
    }
    case "reset": {
      // 关麦 / 换会话：扣着的、等着的都照样发出去——人确实说了
      const pending = joinSpoken(s.buffer, s.waiting?.text ?? "");
      return { state: HOLD_IDLE, effects: pending === "" ? [] : [{ type: "send", text: pending }] };
    }
  }
}
