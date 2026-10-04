// launchUpdate —— 手机端热更新什么时候挡开屏、什么时候重启（#1463）。判据照 Mandy App 的 lib/launch-update.ts。
import { describe, expect, it } from "vitest";
import {
  AUTO_RETRIES, CHECK_CAP_MS, INITIAL_LAUNCH_UPDATE_LOCAL, MIN_BACKGROUND_MS, RELOAD_COOLDOWN_MS,
  canRestartOnResume, launchUpdateHold, launchUpdatePhase, updateKey, type UpdatesSnapshot,
} from "../../src/shared/launchUpdate.js";

const base: UpdatesSnapshot = {
  restartCount: 0, isUpdatePending: false, isUpdateAvailable: false, isDownloading: false, isChecking: false,
  isStartupProcedureRunning: false, lastCheckForUpdateTimeSinceRestart: new Date(1), currentlyRunning: { updateId: "old" },
};
const u = (id: string) => ({ updateId: id, createdAt: new Date(5) });
const phase = (o: Partial<UpdatesSnapshot>, lastApplied: string | null | undefined = null, attemptsLeft = AUTO_RETRIES) =>
  launchUpdatePhase({ updates: { ...base, ...o }, enabled: true, lastApplied, local: { attemptsLeft } });

describe("launchUpdatePhase", () => {
  it("没开 / 已经重启过一次：off", () => {
    expect(launchUpdatePhase({ updates: base, enabled: false, lastApplied: null, local: INITIAL_LAUNCH_UPDATE_LOCAL }).kind).toBe("off");
    expect(phase({ restartCount: 1, isUpdatePending: true, downloadedUpdate: u("new") }).kind).toBe("off");
  });
  it("还在查：checking（挡，有上限）", () => {
    expect(phase({ isChecking: true }).kind).toBe("checking");
    expect(phase({ isStartupProcedureRunning: true, lastCheckForUpdateTimeSinceRestart: null }).kind).toBe("checking");
  });
  it("有更新、启动流程在下：downloading（挡，没上限）", () => {
    expect(phase({ isUpdateAvailable: true, availableUpdate: u("new"), isStartupProcedureRunning: true }).kind).toBe("downloading");
    expect(phase({ isUpdateAvailable: true, availableUpdate: u("new"), isDownloading: true }).kind).toBe("downloading");
  });
  it("原生那次下载失败：App 自己下；次数用完就照常打开", () => {
    expect(phase({ isUpdateAvailable: true, availableUpdate: u("new"), downloadError: new Error("x") }).kind).toBe("fetch");
    expect(phase({ isUpdateAvailable: true, availableUpdate: u("new") }, null, 0).kind).toBe("off");
  });
  it("下完了：ready；上次已经重启进过它还在等：off（不连着重启）", () => {
    expect(phase({ isUpdatePending: true, downloadedUpdate: u("new") }).kind).toBe("ready");
    expect(phase({ isUpdatePending: true, downloadedUpdate: u("new") }, "new").kind).toBe("off");
  });
  it("lastApplied 还没从盘上读出来：先挡着等它", () => {
    // 直接调：辅助函数的默认参数会把显式的 undefined 吞成 null
    expect(launchUpdatePhase({ updates: { ...base, isUpdatePending: true, downloadedUpdate: u("new") }, enabled: true, lastApplied: undefined, local: INITIAL_LAUNCH_UPDATE_LOCAL }).kind).toBe("checking");
  });
  it("没有更新：none", () => {
    expect(phase({}).kind).toBe("none");
  });
  it("updateKey：回滚没有 id，用发布时刻区分", () => {
    expect(updateKey(u("a"))).toBe("a");
    expect(updateKey({ updateId: null, createdAt: new Date(42) })).toBe("rollback@42");
  });
});

describe("launchUpdateHold", () => {
  it("查 = 有上限；下 / 要自己下 / 下完 = 没上限；其余不挡", () => {
    expect(launchUpdateHold({ kind: "checking" })).toBe("capped");
    expect(launchUpdateHold({ kind: "downloading" })).toBe("uncapped");
    expect(launchUpdateHold({ kind: "fetch", inMs: 0 })).toBe("uncapped");
    expect(launchUpdateHold({ kind: "ready" })).toBe("uncapped");
    expect(launchUpdateHold({ kind: "none" })).toBe("none");
    expect(launchUpdateHold({ kind: "off" })).toBe("none");
    expect(CHECK_CAP_MS).toBeLessThanOrEqual(10_000);
  });
});

describe("canRestartOnResume", () => {
  const ok = { enabled: true, backgroundedMs: MIN_BACKGROUND_MS, inCall: false, lastReloadAt: null, now: 10 * RELOAD_COOLDOWN_MS };
  it("后台够久、没在打电话、不在冷却期：可以", () => {
    expect(canRestartOnResume(ok)).toEqual({ ok: true });
  });
  it("刚切出去一会儿 / 在打电话 / 刚重启过：不行", () => {
    expect(canRestartOnResume({ ...ok, backgroundedMs: MIN_BACKGROUND_MS - 1 }).ok).toBe(false);
    expect(canRestartOnResume({ ...ok, backgroundedMs: null }).ok).toBe(false);
    expect(canRestartOnResume({ ...ok, inCall: true })).toEqual({ ok: false, reason: "busy" });
    expect(canRestartOnResume({ ...ok, lastReloadAt: ok.now - 1 })).toEqual({ ok: false, reason: "cooling-down" });
    expect(canRestartOnResume({ ...ok, enabled: false }).ok).toBe(false);
  });
});
