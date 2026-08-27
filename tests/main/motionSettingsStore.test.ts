import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MOTION_SETTINGS,
  loadMotionSettings,
  normaliseMotionSettings,
  saveMotionSettings,
} from "../../src/main/motionSettingsStore.js";

const tmpFile = (name: string) => join(mkdtempSync(join(tmpdir(), "motion-")), name);

describe("normaliseMotionSettings", () => {
  it("认得 always", () => {
    expect(normaliseMotionSettings({ pref: "always" })).toEqual({ pref: "always" });
  });

  it("外部输入不赌形状:垃圾一律退回跟随系统", () => {
    expect(normaliseMotionSettings(null)).toEqual({ pref: "system" });
    expect(normaliseMotionSettings("always")).toEqual({ pref: "system" });
    expect(normaliseMotionSettings({ pref: "off" })).toEqual({ pref: "system" });
    // 没有"始终关闭"这一档:系统说减弱就减弱,不给反向覆盖
    expect(normaliseMotionSettings({ pref: "never" })).toEqual({ pref: "system" });
  });
});

describe("loadMotionSettings", () => {
  it("出厂默认 = 跟随系统", () => {
    expect(loadMotionSettings(tmpFile("missing.json"))).toEqual(DEFAULT_MOTION_SETTINGS);
    expect(DEFAULT_MOTION_SETTINGS.pref).toBe("system");
  });

  it("坏 JSON 不抛,退回默认", () => {
    const p = tmpFile("broken.json");
    writeFileSync(p, "{ 这不是 JSON", "utf8");
    expect(loadMotionSettings(p)).toEqual({ pref: "system" });
  });

  it("存了什么读回什么", () => {
    const p = tmpFile("motion.json");
    saveMotionSettings(p, { pref: "always" });
    expect(loadMotionSettings(p)).toEqual({ pref: "always" });
  });
});

describe("saveMotionSettings", () => {
  it("落盘的是整形后的值,不是原样透传", () => {
    const p = tmpFile("motion.json");
    saveMotionSettings(p, { pref: "垃圾" } as never);
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ pref: "system" });
  });
});
