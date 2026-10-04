// launchUpdate —— 手机端热更新（OTA）什么时候挡、什么时候重启（#1463，ADR-0340）。照 Mandy App 的做法
// （mandys_bubble_tea_app 的 lib/launch-update.ts / lib/ota-restart.ts，ADR 0003），判据写成纯函数进 vitest。
//
// 要治的病：expo-updates 每次冷启动都去查（checkAutomatically ON_LOAD），但不等它（fallbackToCacheTimeout 0），
// 于是这次下载的包下一次冷启动才跑——要退出两次才看得到。所以开屏页在「知道有更新正在下」时一直挡着，下完当场
// reloadAsync 进新包：人打开一次就在新包上。查更新本身还是原生那一侧在做（每次冷启动都查，不管 JS 坏没坏——
// 这是「一个修复总能送到一个坏掉的包」的唯一保证）。
//
// 不知道有没有更新时（还在查）最多挡 CHECK_CAP_MS：一个永远不回话的检查不该把每次启动都扣住。知道有更新之后不设
// 上限，卡住的下载 60 秒没动静会自己报错（expo-updates 的请求超时），App 自己再下两次，还不行就照常打开
// （Mandy 那里是让人选「再试 / 先打开」；这里直接打开，更新下次冷启动照样会再查）。
//
// 只依赖 expo-updates 的 useUpdates() 返回值里用得到的那几格（结构类型），所以这个文件不 import expo-updates，
// 根门禁跑得了它的测试。

/** useUpdates() 里这里读的那几格 */
export interface UpdateInfoLike {
  updateId?: string | null;
  createdAt: Date;
}
export interface UpdatesSnapshot {
  restartCount: number;
  isUpdatePending: boolean;
  isUpdateAvailable: boolean;
  isDownloading: boolean;
  isChecking: boolean;
  isStartupProcedureRunning: boolean;
  downloadError?: unknown;
  lastCheckForUpdateTimeSinceRestart?: Date | null;
  currentlyRunning: { updateId?: string | null };
  downloadedUpdate?: UpdateInfoLike | null;
  availableUpdate?: UpdateInfoLike | null;
}

/** 还在查的时候开屏最多多挡多久（开屏自己的进度条走完之后再算） */
export const CHECK_CAP_MS = 5_000;
/** 下载失败后 App 自己再下几次 */
export const AUTO_RETRIES = 2;
export const AUTO_RETRY_DELAY_MS = 1_500;

export type LaunchUpdatePhase =
  /** 这次不管更新：没开 / 已经重启过一次 / 放弃了 / 上次重启进去没成功的那个 */
  | { kind: "off" }
  /** 没有要管的：没有更新，或者查失败了 */
  | { kind: "none" }
  /** 还没查完（挡，有上限） */
  | { kind: "checking" }
  /** 正在下（挡，没上限） */
  | { kind: "downloading" }
  /** 有更新但没人在下（原生那次下载失败了）：inMs 之后 App 自己下（挡，没上限） */
  | { kind: "fetch"; inMs: number }
  /** 下完了：重启进去 */
  | { kind: "ready" };

export interface LaunchUpdateLocal {
  attemptsLeft: number;
}
export const INITIAL_LAUNCH_UPDATE_LOCAL: LaunchUpdateLocal = { attemptsLeft: AUTO_RETRIES };

/** 重启进一个更新之前记下它；下次启动拿来比，分得出「重启没成功（或被回滚）」和「新来的一个」 */
export function updateKey(u: UpdateInfoLike): string {
  return u.updateId ?? `rollback@${u.createdAt.getTime()}`;
}

export function launchUpdatePhase(a: {
  updates: UpdatesSnapshot;
  /** expo-updates 开着且不是开发构建 */
  enabled: boolean;
  /** 上次自己重启进去的那个（updateKey）；null = 没有；undefined = 还没从盘上读出来 */
  lastApplied: string | null | undefined;
  local: LaunchUpdateLocal;
}): LaunchUpdatePhase {
  const u = a.updates;
  // 重启之后跑的已经是新包：之后又冒出来的留给下一次冷启动，不连着重启两次
  if (!a.enabled || u.restartCount > 0) return { kind: "off" };
  const downloaded = u.isUpdatePending ? u.downloadedUpdate ?? undefined : undefined;
  if (downloaded !== undefined && downloaded.updateId !== u.currentlyRunning.updateId) {
    if (a.lastApplied === undefined) return { kind: "checking" };
    // 上次已经重启进过它、它还在等着：重启没成功，或者新包崩了被回滚。一次就够，留给下次冷启动
    return updateKey(downloaded) === a.lastApplied ? { kind: "off" } : { kind: "ready" };
  }
  if (u.isUpdatePending) return { kind: "none" };
  if (u.isUpdateAvailable) {
    if (u.availableUpdate && updateKey(u.availableUpdate) === a.lastApplied) return { kind: "off" };
    if (u.isDownloading) return { kind: "downloading" };
    // 启动流程还在跑且没报错：它会自己把查到的那个下下来
    if (u.isStartupProcedureRunning && !u.downloadError) return { kind: "downloading" };
    return a.local.attemptsLeft > 0 ? { kind: "fetch", inMs: AUTO_RETRY_DELAY_MS } : { kind: "off" };
  }
  if (u.isChecking) return { kind: "checking" };
  if (u.isStartupProcedureRunning && !u.lastCheckForUpdateTimeSinceRestart) return { kind: "checking" };
  return { kind: "none" };
}

/** 开屏为这一档挡不挡：不挡 / 挡到上限 / 挡到它有结果 */
export function launchUpdateHold(p: LaunchUpdatePhase): "none" | "capped" | "uncapped" {
  if (p.kind === "checking") return "capped";
  if (p.kind === "downloading" || p.kind === "fetch" || p.kind === "ready") return "uncapped";
  return "none";
}

// ── 从后台回来时 ─────────────────────────────────────────────────────

/** 在后台待了多久之后回来，重启才读得像「我打开了 App」而不是「App 在我眼前重启了」 */
export const MIN_BACKGROUND_MS = 30 * 60_000;
/** 两次自己重启之间至少隔这么久：一个坏到一打开就退回后台的包，靠它不会变成出不去的循环 */
export const RELOAD_COOLDOWN_MS = 30 * 60_000;

export type ResumeVerdict = { ok: true } | { ok: false; reason: "disabled" | "too-soon" | "busy" | "cooling-down" };

export function canRestartOnResume(a: {
  enabled: boolean;
  /** 在后台待了多久；没进过后台为 null */
  backgroundedMs: number | null;
  /** 正在打电话（语音通话 / 系统来电）：重启会把电话挂掉 */
  inCall: boolean;
  lastReloadAt: number | null;
  now: number;
}): ResumeVerdict {
  if (!a.enabled) return { ok: false, reason: "disabled" };
  if (a.backgroundedMs === null || a.backgroundedMs < MIN_BACKGROUND_MS) return { ok: false, reason: "too-soon" };
  if (a.inCall) return { ok: false, reason: "busy" };
  if (a.lastReloadAt !== null && a.now - a.lastReloadAt < RELOAD_COOLDOWN_MS) return { ok: false, reason: "cooling-down" };
  return { ok: true };
}
