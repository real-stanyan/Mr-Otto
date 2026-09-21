// 十五个状态的数据表。纯数据零逻辑——加一个状态就是加一行。
//
// 这张表是对着仓里已有的枚举一一对上的，不是另起一套：`agentPhase()` 的 7 个 orb、
// `turnLedger` 的 queued、`sessionOrb` 的 waiting、通话的 speaking/listening、
// `backgroundRuns` 的 ready/failed。映射在 adapter.ts，这里只管长什么样。
//
// ## 三条不是配色细节的取舍
//
// 1. **`waiting` 是唯一做水平摆动的**（`sway: "urgent"`）。`sessionOrb.ts` 已经把法理写死：
//    「等你」必须压过「在跑」，否则人会以为不用管它、而它其实一步都走不了。一墙静止
//    头像里，横向运动是最强的注意力钩子——这一格的抢眼是功能，不是活泼。
// 2. **`queued` 是唯一完全不动的**（`bobAmp: 0` + `blinks: false`）。ADR-0250 规定 queued
//    连打字指示器都不画（「它一个 token 都还没跑，画上去就是撒谎的勾」）。头像守同一条：
//    它必须看起来**不在干活**，否则就是换个地方撒同一个谎。
// 3. **`frozen` 是唯一改调色板的**（`desaturate`）。frozen 是持久记号、不会自动重试
//    （CONTEXT.md「任务会话云端日志」那条），所以它得看起来「这个不会自己好」——
//    加个角标不够，整张脸都要灰下去。
//
// 强调色分五类：蓝=在干活 / 琥珀=要你 / 绿=成了 / 红=崩了 / 青=语音 / 灰=静默。
// 分类的用处是扫一墙头像时先按色收敛，再看是哪一格。

import type { BadgeName } from "./badges.js";
import type { EyeShape, MouthShape } from "./character.js";

export const ACCENT = {
  busy: "#6C5CD4",
  attention: "#DE8A2E",
  ok: "#3E9A62",
  bad: "#CF4A42",
  voice: "#2F94A6",
  mute: "#8A8F98",
  dormant: "#636974",
} as const;

export type FaceState =
  | "idle" | "sleep" | "queued"
  | "thinking" | "searching" | "working" | "answering" | "weaving"
  | "waiting"
  | "listening" | "speaking"
  | "done" | "failed" | "ratelimit" | "frozen";

/** 视线驱动。`pointer` 跟指针、`scan` 走扫视时间线、`dart` 左右快速横扫、
 *  `fixed` 钉在 `fixedLook`、`still` 不动 */
export type LookDriver = "pointer" | "scan" | "dart" | "fixed" | "still";

export interface FaceStateDef {
  /** 界面上的说法，与 `agentPhase()` / `orbLabel()` 的文案对齐 */
  readonly zh: string;
  /** 这一格对应仓里哪个枚举，写给读代码的人 */
  readonly origin: string;
  readonly eye: EyeShape;
  /** `"talk"` = 按 `TALK_CYCLE` 循环 */
  readonly mouth: MouthShape | "talk";
  readonly look: LookDriver;
  readonly fixedLook?: readonly [number, number];
  readonly mouthDx?: number;
  readonly browDy?: number;
  /** 左眉相对右眉的额外升降。负值 = 左眉更高 = 疑问脸，一格就够 */
  readonly browAsym?: number;
  /** 呼吸周期；0 = 不呼吸 */
  readonly bobMs: number;
  readonly bobAmp: number;
  readonly sway?: "lean" | "urgent";
  readonly badge?: BadgeName;
  readonly accent?: string;
  readonly desaturate?: boolean;
  readonly blinks: boolean;
}

export const FACE_STATES: Readonly<Record<FaceState, FaceStateDef>> = {
  idle: {
    zh: "空闲", origin: "sessionOrb.orbState → idle（也承接 OrbState.breathing）",
    eye: "open", mouth: "smile", look: "pointer", bobMs: 2600, bobAmp: 1, blinks: true,
  },
  sleep: {
    zh: "休眠", origin: "长时 idle",
    eye: "sleep", mouth: "small", look: "still", bobMs: 7000, bobAmp: 1,
    badge: "zzz", accent: ACCENT.mute, blinks: false,
  },
  queued: {
    zh: "排队中", origin: 'turnLedger.OpenTurn.state === "queued"',
    eye: "open", mouth: "flat", look: "fixed", fixedLook: [2, 1], bobMs: 0, bobAmp: 0,
    badge: "dots3", accent: ACCENT.mute, blinks: false,
  },
  thinking: {
    zh: "思考中", origin: "agentPhase() → composing",
    eye: "open", mouth: "purse", mouthDx: -1, look: "scan", browDy: -1, browAsym: -1,
    bobMs: 4600, bobAmp: 1, sway: "lean", badge: "bubble", accent: ACCENT.busy, blinks: true,
  },
  searching: {
    zh: "检索中", origin: "agentPhase() → searching（read_file）",
    eye: "open", mouth: "flat", look: "dart", bobMs: 2400, bobAmp: 1,
    badge: "glass", accent: ACCENT.busy, blinks: true,
  },
  working: {
    zh: "执行中", origin: "agentPhase() → working（bash / write_file）",
    eye: "open", mouth: "purse", look: "fixed", fixedLook: [0, 1], browDy: 1,
    bobMs: 1700, bobAmp: 1, badge: "gear", accent: ACCENT.busy, blinks: true,
  },
  answering: {
    zh: "作答中", origin: "agentPhase() → solving（正文在流）",
    eye: "open", mouth: "talk", look: "pointer", bobMs: 1500, bobAmp: 1,
    badge: "bars", accent: ACCENT.busy, blinks: true,
  },
  weaving: {
    zh: "压缩中", origin: "agentPhase() → weaving",
    eye: "squint", mouth: "flat", look: "still", bobMs: 5200, bobAmp: 1,
    badge: "coil", accent: ACCENT.busy, blinks: false,
  },
  waiting: {
    zh: "等你处理", origin: "agentPhase() → listening；sessionOrb → waiting（最高优先级）",
    eye: "wide", mouth: "small", look: "pointer", browDy: -2, bobMs: 1300, bobAmp: 1,
    sway: "urgent", badge: "bang", accent: ACCENT.attention, blinks: true,
  },
  listening: {
    zh: "在听", origin: "VoiceCallOverlay → listening",
    eye: "open", mouth: "flat", look: "fixed", fixedLook: [-2, 0], bobMs: 3400, bobAmp: 1,
    badge: "wave", accent: ACCENT.voice, blinks: true,
  },
  speaking: {
    zh: "在说话", origin: "VoiceCallOverlay → speaking",
    eye: "open", mouth: "talk", look: "still", bobMs: 1200, bobAmp: 1,
    badge: "bars", accent: ACCENT.voice, blinks: true,
  },
  done: {
    zh: "完成", origin: "turn_ended；backgroundRuns → ready",
    eye: "happy", mouth: "grin", look: "still", browDy: -1, bobMs: 900, bobAmp: 2,
    badge: "check", accent: ACCENT.ok, blinks: false,
  },
  failed: {
    zh: "出错", origin: 'errorClass === "fatal"；backgroundRuns → failed',
    eye: "squint", mouth: "wavy", look: "still", browDy: 1, bobMs: 2200, bobAmp: 1,
    badge: "cross", accent: ACCENT.bad, blinks: false,
  },
  ratelimit: {
    zh: "限流等待", origin: 'errorClass === "rate-limit"',
    eye: "open", mouth: "flat", look: "fixed", fixedLook: [2, 1], bobMs: 6000, bobAmp: 1,
    badge: "hourglass", accent: ACCENT.attention, blinks: true,
  },
  frozen: {
    zh: "冻结 / 离线", origin: 'taskSyncState.frozen；McpStatus === "failed"',
    eye: "dizzy", mouth: "flat", look: "still", bobMs: 0, bobAmp: 0,
    badge: "snow", accent: ACCENT.dormant, desaturate: true, blinks: false,
  },
};

/** 稳定顺序：按「静默 → 在干活 → 要你 → 语音 → 终态」排，陈列馆与测试都读这一份 */
export const FACE_STATE_LIST: readonly FaceState[] = [
  "idle", "sleep", "queued",
  "thinking", "searching", "working", "answering", "weaving",
  "waiting",
  "listening", "speaking",
  "done", "failed", "ratelimit", "frozen",
];

export function isFaceState(v: string): v is FaceState {
  return Object.prototype.hasOwnProperty.call(FACE_STATES, v);
}
