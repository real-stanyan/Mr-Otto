// 回电推送的手机配置（#1411，spec §1.2 / §3.4）：配置插件、时效性通知的 entitlement、铃声文件。
// 这几格错了不会有任何报错——包照样打得出来，只是锁屏上的来电不响、或者专注模式里被挡掉。
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../mobile/", import.meta.url);
const app = JSON.parse(readFileSync(new URL("app.json", root), "utf8")) as {
  expo: { ios: { entitlements?: Record<string, unknown> }; plugins: unknown[] };
};
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as { dependencies: Record<string, string> };

describe("手机端推送配置（#1411）", () => {
  it("装了 expo-notifications（SDK 57 那一版）", () => {
    expect(pkg.dependencies["expo-notifications"]).toMatch(/^~57\.0\./);
  });
  it("插件带上铃声；时效性通知的 entitlement 开着；UIScene 插件还在", () => {
    const plugin = app.expo.plugins.find((p) => Array.isArray(p) && p[0] === "expo-notifications") as [string, { sounds?: string[] }] | undefined;
    expect(plugin?.[1].sounds).toEqual(["./assets/sounds/ringtone.caf"]);
    expect(app.expo.plugins).not.toContain("expo-notifications");
    expect(app.expo.ios.entitlements?.["com.apple.developer.usernotifications.time-sensitive"]).toBe(true);
    expect(app.expo.plugins).toContain("./plugins/withSceneLifecycle");
  });
  it("铃声文件在，是 CAF", () => {
    const f = new URL("assets/sounds/ringtone.caf", root);
    expect(existsSync(f)).toBe(true);
    expect(readFileSync(f).subarray(0, 4).toString("latin1")).toBe("caff");
  });
});
