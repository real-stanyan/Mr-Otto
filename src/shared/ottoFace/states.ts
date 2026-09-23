// ottoFace/states —— 一张脸此刻是哪个表情（#1345，ADR-0316）。
//
// 16 档：15 个真状态（#1307 的那张表，与仓里现有枚举一一对上）+ 一个 `plain`。
//
// **`plain` 是「我们不知道」不是「空闲」**：名册那一栏今天查不到谁在跑（那张表里没有
// 这一格，#1282），画一个恒灰的「空闲」角标等于宣称一件我们查不到的事 —— 那正是 #722
// 那颗撒谎的勾。所以 plain 不画角标、也不动。顺带还掉第二笔账：一墙脸同时呼吸本身就是
// 噪音，而名册是每天要扫几十遍的东西。
//
// 三条硬规矩（都不是配色细节）：
//
// · `waiting`（等你处理）是**唯一**做水平摆动的。`sessionOrb.ts` 早就定死「等你」必须
//   压过「在跑」，否则人会以为不用管它、而它其实一步都走不了；一墙静止头像里，横向
//   运动是最强的钩子。
// · `queued`（排队中）是**唯一完全不动的**。ADR-0250 规定 queued 连打字指示器都不画
//   （「它一个 token 都还没跑，画上去就是撒谎的勾」），头像必须守同一条 —— 不能看
//   起来像在干活。
// · `frozen` 是**唯一降饱和的**。冻住那一档要看起来「这张脸不在了」，不是「它在歇」。
//
// 第四条是角标：**状态要在 40px 下可分**。光靠眼形分不出「眯眼」和「平视」，所以每个
// 状态配一枚带语义色的角标，脸负责近看、角标负责扫一眼 —— 与现有 orb 同一个思路。
// 角标画成 canvas 上的一个圆点而不是网格里的像素块：24px 下像素块只剩三个像素，认不出。

import type { EyeShape, MouthShape } from "./character.js";

export type FaceState =
  | "plain"
  | "alive"
  | "idle"
  | "queued"
  | "composing"
  | "searching"
  | "working"
  | "solving"
  | "weaving"
  | "waiting"
  | "listening"
  | "speaking"
  | "done"
  | "failed"
  | "limited"
  | "frozen"
  | "offline";

/** 角标的语义色：蓝=在干活 / 琥珀=要你 / 绿=成了 / 红=崩了 / 青=语音 / 灰=静默 */
export type FaceBadge = "work" | "need" | "ok" | "bad" | "voice" | "mute";

export const BADGE_COLORS: Readonly<Record<FaceBadge, string>> = {
  work: "#0a84ff",
  need: "#ff9f0a",
  ok: "#30d158",
  bad: "#ff453a",
  voice: "#5ac8fa",
  mute: "#8e8e93",
};

/**
 * 视线怎么动。**静态的「往上看」读起来只是个姿势**；「在思考」的本质是在搜索，
 * 视线不游走就不成立 —— 所以思考那一档走 `scan`（一条时间线），不是 `fixed`。
 *
 * · `pointer` 跟鼠标（只有「此刻正在看的那只」值得订阅 pointermove）
 * · `scan`    左上 → 正上 → 右上 → 回正
 * · `dart`    左右急跳（检索）
 * · `fixed`   盯住一个固定方向
 * · `still`   不动
 */
export type LookDriver = "pointer" | "scan" | "dart" | "fixed" | "still";

export interface FaceStateSpec {
  /** 这一档中文怎么念（读屏与陈列馆用） */
  readonly zh: string;
  readonly eye: EyeShape;
  /** `"talk"` = 按时刻在几个嘴形之间循环 */
  readonly mouth: MouthShape | "talk";
  readonly look: LookDriver;
  readonly fixedLook?: readonly [number, number];
  /** 嘴整体左右挪几格（歪嘴） */
  readonly mouthDx?: number;
  /** 两条眉一起上下挪几格。负 = 抬眉 */
  readonly browDy?: number;
  /** 左眉再单独挪几格 —— **不对称才有表情**，两条一起动只是「眉毛位置变了」 */
  readonly browAsym?: number;
  /** 呼吸周期（毫秒）。0 = 不呼吸 */
  readonly bobMs: number;
  /** 呼吸幅度（格）。**整格，不做补间** */
  readonly bobAmp: number;
  readonly sway?: "lean" | "urgent";
  readonly badge: FaceBadge | null;
  /** 整张脸降饱和（冻结那一档） */
  readonly desaturate?: boolean;
  /** 整张脸压淡（离线那一档） */
  readonly dim?: boolean;
  /** 会不会自动眨眼 */
  readonly blinks: boolean;
}

function spec(o: Partial<FaceStateSpec>): FaceStateSpec {
  return {
    zh: "", eye: "open", mouth: "smile", look: "still",
    bobMs: 0, bobAmp: 0, badge: null, blinks: true, ...o,
  };
}

export const FACE_STATES: Readonly<Record<FaceState, FaceStateSpec>> = {
  // 不画角标、不动、不眨眼。见文件头
  plain: spec({ zh: "形象", blinks: false }),
  // 名册那一墙（手机端，#1356）：眨眼 + 呼吸 = 活着，**不画角标、不跟指针**。它不回答
  // 「此刻在干嘛」——名册查不到谁在跑（#722 / #1282），角标在这套东西里是「声称」。
  // 这是「会动的那几档都画了角标」唯一的例外，理由在 ADR（#1356 A0）
  alive: spec({ zh: "活着", bobMs: 2600, bobAmp: 1 }),
  idle: spec({ zh: "空闲", look: "pointer", bobMs: 2600, bobAmp: 1, badge: "mute" }),
  // 唯一完全不动的那一档
  queued: spec({ zh: "排队中", mouth: "flat", badge: "mute", blinks: false }),
  composing: spec({ zh: "思考中", mouth: "small", look: "scan", browDy: -1, bobMs: 2100, bobAmp: 1, badge: "work" }),
  searching: spec({ zh: "检索中", mouth: "flat", look: "dart", bobMs: 1500, bobAmp: 1, badge: "work" }),
  working: spec({
    zh: "执行中", eye: "squint", mouth: "flat", look: "fixed", fixedLook: [0, 1],
    browDy: 1, bobMs: 900, bobAmp: 1, badge: "work",
  }),
  solving: spec({ zh: "作答中", mouth: "talk", bobMs: 1200, bobAmp: 1, badge: "work" }),
  weaving: spec({ zh: "压缩中", eye: "squint", mouth: "purse", bobMs: 3000, bobAmp: 1, badge: "work" }),
  // 唯一做水平摆动的那一档
  waiting: spec({
    zh: "等你处理", eye: "wide", mouth: "o", look: "pointer",
    browDy: -2, bobMs: 700, bobAmp: 1, sway: "urgent", badge: "need",
  }),
  listening: spec({ zh: "在听", mouth: "small", look: "pointer", bobMs: 1800, bobAmp: 1, badge: "voice" }),
  speaking: spec({ zh: "在说话", eye: "happy", mouth: "talk", bobMs: 1000, bobAmp: 1, badge: "voice" }),
  done: spec({ zh: "完成", eye: "happy", mouth: "grin", bobMs: 2600, bobAmp: 1, badge: "ok" }),
  failed: spec({ zh: "出错", eye: "dizzy", mouth: "wavy", browAsym: 1, badge: "bad", blinks: false }),
  limited: spec({ zh: "限流等待", eye: "squint", mouth: "flat", bobMs: 3400, bobAmp: 1, badge: "need" }),
  // 唯一降饱和的那一档
  frozen: spec({ zh: "冻结", eye: "sleep", mouth: "flat", badge: "mute", desaturate: true, blinks: false }),
  offline: spec({ zh: "离线", eye: "sleep", mouth: "flat", badge: "mute", dim: true, blinks: false }),
};

export const FACE_STATE_LIST: readonly FaceState[] = Object.keys(FACE_STATES) as FaceState[];

export function isFaceState(v: string): v is FaceState {
  return Object.hasOwn(FACE_STATES, v);
}

/**
 * 这一档会不会动。**从状态表推导，不另立一份名单** —— 两份判据迟早分家，而分家的
 * 形态是安静的：要么一张该动的脸僵着，要么一墙本该静止的脸开始呼吸。
 *
 * 跟指针也算动：眼睛要跟着鼠标走，那一格就得重绘。
 */
export function faceAnimates(state: FaceState): boolean {
  const s = FACE_STATES[state];
  return (
    s.blinks ||
    (s.bobMs > 0 && s.bobAmp > 0) ||
    s.sway !== undefined ||
    s.mouth === "talk" ||
    s.look === "scan" ||
    s.look === "dart" ||
    s.look === "pointer"
  );
}
