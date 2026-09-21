// ottoFace/states —— 一张脸此刻是哪个表情（#1345，ADR-0311）。
//
// 16 档：15 个真状态（#1307 的那张表，与仓里现有枚举一一对上）+ 一个 `plain`。
//
// **`plain` 是「我们不知道」不是「空闲」**：名册那一栏今天查不到谁在跑（那张表里没有
// 这一格，#1282），画一个恒灰的「空闲」角标等于宣称一件我们查不到的事 —— 那正是 #722
// 那颗撒谎的勾。所以 plain 不画角标、也不动。顺带还掉第二笔账：一墙脸同时呼吸本身就是
// 噪音，而名册是每天要扫几十遍的东西。
//
// 两条硬规矩（#1307 的法理 ①②，都不是配色细节）：
//
// · `waiting`（等你处理）是**唯一**做水平摆动的。`sessionOrb.ts` 早就定死「等你」必须
//   压过「在跑」，否则人会以为不用管它、而它其实一步都走不了；一墙静止头像里，横向
//   运动是最强的钩子。
// · `queued`（排队中）是**唯一完全不动的**。ADR-0250 规定 queued 连打字指示器都不画
//   （「它一个 token 都还没跑，画上去就是撒谎的勾」），头像必须守同一条 —— 不能看
//   起来像在干活。
//
// 第三条是角标：**状态要在 40px 下可分**。光靠眼形分不出「眯眼」和「平视」，所以每个
// 状态配一枚带语义色的角标，脸负责近看、角标负责扫一眼 —— 与现有 orb 同一个思路。

/** 这一格在动没动，是**从这张表推出来的**不是另给一个开关：同一个判断有两份迟早分家。
    调用方只管传状态，`AgentFace` 据此决定挂不挂 rAF */
export type FaceState =
  | "plain"
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

/** 一格特征：定死的一个图案名，或一个按时刻挑的函数 */
export type Timed<T> = T | ((t: number) => T);

export interface FaceStateSpec {
  /** BROWS 的键 */
  brow: Timed<string>;
  /** EYES 的键 */
  eye: Timed<string>;
  /** MOUTHS 的键 */
  mouth: Timed<string>;
  badge: FaceBadge | null;
  /** 整张脸的整格位移。**只走整格**（sprites.ts 法理 ②） */
  move: ((t: number) => readonly [number, number]) | null;
  /** 整张脸压淡（离线那一档） */
  dim: boolean;
}

function spec(o: Partial<FaceStateSpec>): FaceStateSpec {
  return { brow: "flat", eye: "open", mouth: "flat", badge: null, move: null, dim: false, ...o };
}

/** 呼吸：每 `ms` 上下挪一格。整格，不做补间 */
function breathe(ms: number): (t: number) => readonly [number, number] {
  return (t) => [0, Math.floor(t / ms) % 2];
}

/** 循环挑一个：`cycle(["a","b"], 200)` 每 200ms 换一个 */
function cycle<T>(frames: readonly T[], ms: number): (t: number) => T {
  return (t) => frames[Math.floor(t / ms) % frames.length] as T;
}

export const FACE_STATES: Readonly<Record<FaceState, FaceStateSpec>> = {
  // 不画角标、不动。见文件头
  plain: spec({ mouth: "smile" }),
  idle: spec({ mouth: "smile", badge: "mute", move: breathe(1500) }),
  // 唯一完全不动的那一档
  queued: spec({ mouth: "flat", badge: "mute" }),
  composing: spec({ brow: "up", eye: "up", mouth: "small", badge: "work", move: breathe(620) }),
  searching: spec({ eye: cycle(["right", "left"], 420), badge: "work" }),
  working: spec({ brow: "knit", badge: "work", move: breathe(300) }),
  solving: spec({ mouth: cycle(["talk", "oh", "flat"], 220), badge: "work" }),
  weaving: spec({ eye: "half", mouth: "small", badge: "work", move: breathe(820) }),
  // 唯一做水平摆动的那一档
  waiting: spec({
    brow: "up",
    mouth: "oh",
    badge: "need",
    move: cycle([[-1, 0], [0, 0], [1, 0], [0, 0]] as readonly (readonly [number, number])[], 260),
  }),
  listening: spec({ brow: "up", mouth: "small", badge: "voice", move: breathe(950) }),
  speaking: spec({ mouth: cycle(["oh", "talk", "small", "talk"], 170), badge: "voice" }),
  done: spec({ eye: "half", mouth: "smile", badge: "ok", move: breathe(1500) }),
  failed: spec({ brow: "knit", eye: "cross", mouth: "zig", badge: "bad" }),
  limited: spec({ eye: "half", badge: "need", move: breathe(1700) }),
  frozen: spec({ eye: "shut", badge: "mute" }),
  offline: spec({ eye: "shut", badge: "mute", dim: true }),
};

/**
 * 这一档会不会动。**从状态表推导，不另立一份名单** —— 两份判据迟早分家，而分家的
 * 形态是安静的：要么一张该动的脸僵着，要么一墙本该静止的脸开始呼吸。
 */
export function faceAnimates(state: FaceState): boolean {
  const s = FACE_STATES[state];
  return (
    s.move !== null ||
    typeof s.brow === "function" ||
    typeof s.eye === "function" ||
    typeof s.mouth === "function"
  );
}
