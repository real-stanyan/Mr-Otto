// spring —— 手势与转场共用的一层物理（#1120）。**纯的**：没有 DOM、没有 rAF，
// 时间由调用方一帧一帧喂进来，所以整层能单测。驱动那半在 `useSpring.ts`。
//
// ## 为什么是弹簧不是 CSS transition
//
// 定时曲线抓不住半路反向：动画跑到一半用户又把它拖回去时，transition 只能从
// 当前值起一条**新的**曲线，速度在那一刻断掉（读起来像撞了一下墙）。弹簧每帧从
// 当前的 (位置, 速度) 积分，改 target 不打断任何东西——「可打断」是这套东西的
// 全部意义。这也是不引一个动画库的原因：要的就是这三十行，而加依赖是 Tech stack
// 改动（AGENTS.md 的 L1 档）。
//
// ## 两个参数是 Apple 的口径，不是 mass/stiffness/damping
//
// - `response`：值走到目标大概要多久（秒）。**不是 duration**——弹簧没有固定时长，
//   收敛时间是参数的结果。
// - `damping`：阻尼比。`1` = 临界阻尼，不来回振（界面默认档）；`< 1` 会过冲，
//   只在手势自己带着动量的时候才用（甩、抛、拖完松手）。
//
// 换算：ω = 2π / response，加速度 = −ω²·(x − target) − 2ζω·v。

export interface SpringConfig {
  /** 秒。越小越急 */
  response: number;
  /** 阻尼比。1 = 不过冲 */
  damping: number;
}

/** 静止判据：位置与目标的差、速度都小到肉眼无法分辨时收工。阈值按「归一化到
    0..1 的进度量」定——本仓的消费方（转场进度、行偏移的比例）都在这个量级 */
const REST_DISTANCE = 0.0016;
const REST_VELOCITY = 0.014;

/** 一次积分最多推进多久。掉帧（切标签页回来 dt = 2s）时不做一大步，
    否则显式欧拉会直接发散——弹簧会「炸」出屏幕 */
const MAX_STEP = 0.004;

export class Spring {
  x: number;
  v = 0;
  target: number;
  response: number;
  damping: number;

  constructor(x0: number, config: SpringConfig) {
    this.x = x0;
    this.target = x0;
    this.response = config.response;
    this.damping = config.damping;
  }

  /** 换目标。**不重置位置也不重置速度**——那正是可打断的实现方式。
      `velocity` 传进来 = 手势松手那一刻的速度直接交棒（拖与动画之间没有接缝） */
  set(target: number, opts?: { velocity?: number; response?: number; damping?: number }): void {
    this.target = target;
    if (opts?.velocity !== undefined) this.v = opts.velocity;
    if (opts?.response !== undefined) this.response = opts.response;
    if (opts?.damping !== undefined) this.damping = opts.damping;
  }

  /** 手指按住时用：位置钉死、速度清零。跟 `set` 的分别是「谁在开车」 */
  jump(x: number): void {
    this.x = x;
    this.v = 0;
    this.target = x;
  }

  /** 推进 dt 秒。回 true = 已经静止（调用方可以停掉 rAF） */
  step(dt: number): boolean {
    const w = (2 * Math.PI) / this.response;
    const z = this.damping;
    const steps = Math.max(1, Math.ceil(dt / MAX_STEP));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = -w * w * (this.x - this.target) - 2 * z * w * this.v;
      this.v += a * h;
      this.x += this.v * h;
    }
    if (Math.abs(this.x - this.target) < REST_DISTANCE && Math.abs(this.v) < REST_VELOCITY) {
      this.x = this.target;
      this.v = 0;
      return true;
    }
    return false;
  }
}

/** 动量投影：以这个速度松手，滚到停下来还会再走多远。
    用的是 Apple 在 *Designing Fluid Interfaces* 示例里那条**指数衰减**式，不是
    课本上的 v²/(2a)——落点要跟系统滚动的手感一致，这两条给出的距离差得远。
    `decelerationRate` 0.998 = 常规滚动，0.99 = 更快停下。

    为什么要它：甩一下之后该去哪，判据是「速度衰减完落在哪」，不是「松手那一刻
    离谁近」。少了这一步，轻轻一甩会原地弹回去，手感立刻变成「它没听见」。 */
export function projectMomentum(velocity: number, decelerationRate = 0.998): number {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/** 越界阻尼：拉过头之后越拉越跟不动。硬停读作「卡住了」，渐进阻力读作
    「还在听你的，只是到头了」。`dimension` 是这一维的尺寸（把阻力标定到控件大小）*/
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/** 速度上限（每秒）。两个 pointermove 挤在同一毫秒里能算出一个荒唐的速度，
    交棒给弹簧就是一次飞出屏幕。真手指到不了这个量级，所以封顶只砍掉噪声 */
export const MAX_VELOCITY = 6000;

export interface Sample {
  /** 毫秒 */
  t: number;
  v: number;
}

/** 最近这一小段的平均速度。**只看尾巴**（默认 90ms）：拿整段拖拽平均会把
    「先慢慢挪、最后甩一下」算成一个很小的速度，而甩的那一下才是用户的意图。
    样本不足两个时回 0——「不知道」按没有动量算，比猜一个方向安全 */
export function velocityFrom(samples: readonly Sample[], windowMs = 90): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1]!;
  const first = samples.find((s) => last.t - s.t <= windowMs) ?? samples[0]!;
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0) return 0;
  const v = (last.v - first.v) / dt;
  return Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, v));
}

export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
