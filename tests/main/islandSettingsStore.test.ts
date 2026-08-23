// 灵动岛设置落盘(#199):userData/island.json,autoCompactStore 同款模式。
// 文件是外部输入(用户手改过/旧版本写的/截断过),不赌形状。
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadIslandSettings,
  normaliseIslandSettings,
  saveIslandSettings,
} from "../../src/main/islandSettingsStore.js";

const dir = () => mkdtempSync(join(tmpdir(), "island-settings-"));

describe("normaliseIslandSettings", () => {
  it("合法值原样通过", () => {
    expect(normaliseIslandSettings({ display: "usage" })).toEqual({ display: "usage" });
    expect(normaliseIslandSettings({ display: "sessions" })).toEqual({ display: "sessions" });
  });

  it("非法形状兜底成默认(sessions)", () => {
    expect(normaliseIslandSettings(null)).toEqual({ display: "sessions" });
    expect(normaliseIslandSettings({ display: "banana" })).toEqual({ display: "sessions" });
    expect(normaliseIslandSettings("usage")).toEqual({ display: "sessions" });
  });
});

describe("load/save", () => {
  it("没有文件 = 默认", () => {
    expect(loadIslandSettings(join(dir(), "island.json"))).toEqual({ display: "sessions" });
  });

  it("save 后 load 读回同值", () => {
    const p = join(dir(), "island.json");
    saveIslandSettings(p, { display: "usage" });
    expect(loadIslandSettings(p)).toEqual({ display: "usage" });
  });

  it("坏 JSON = 默认,不抛", () => {
    const p = join(dir(), "island.json");
    writeFileSync(p, "{oops", "utf8");
    expect(loadIslandSettings(p)).toEqual({ display: "sessions" });
  });
});
