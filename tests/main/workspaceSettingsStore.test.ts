// 默认工作文件夹落盘(#559):userData/workspace.json,islandSettingsStore 同款模式。
// 文件是外部输入(用户手改过/旧版本写的/截断过),不赌形状。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  builtinDefaultWorkspace,
  loadWorkspaceSettings,
  normaliseWorkspaceSettings,
  resolveDefaultWorkspace,
  saveWorkspaceSettings,
} from "../../src/main/workspaceSettingsStore.js";
import { tempDir } from "../helpers/tempDir.js";

const dir = () => tempDir("workspace-settings-");

describe("normaliseWorkspaceSettings", () => {
  it("合法路径原样通过", () => {
    expect(normaliseWorkspaceSettings({ defaultWorkspace: "/Users/x/proj" })).toEqual({
      defaultWorkspace: "/Users/x/proj",
    });
  });

  it("null / 缺字段 / 空串 / 非字符串都兜底成 null(用内置 Default)", () => {
    expect(normaliseWorkspaceSettings({ defaultWorkspace: null })).toEqual({ defaultWorkspace: null });
    expect(normaliseWorkspaceSettings({})).toEqual({ defaultWorkspace: null });
    expect(normaliseWorkspaceSettings({ defaultWorkspace: "  " })).toEqual({ defaultWorkspace: null });
    expect(normaliseWorkspaceSettings({ defaultWorkspace: 42 })).toEqual({ defaultWorkspace: null });
    expect(normaliseWorkspaceSettings(null)).toEqual({ defaultWorkspace: null });
    expect(normaliseWorkspaceSettings("banana")).toEqual({ defaultWorkspace: null });
  });
});

describe("load/save", () => {
  it("没有文件 = 默认(null)", () => {
    expect(loadWorkspaceSettings(join(dir(), "workspace.json"))).toEqual({ defaultWorkspace: null });
  });

  it("save 后 load 读回同值", () => {
    const p = join(dir(), "workspace.json");
    saveWorkspaceSettings(p, { defaultWorkspace: "/Users/x/proj" });
    expect(loadWorkspaceSettings(p)).toEqual({ defaultWorkspace: "/Users/x/proj" });
  });

  it("坏 JSON = 默认,不抛", () => {
    const p = join(dir(), "workspace.json");
    writeFileSync(p, "{oops", "utf8");
    expect(loadWorkspaceSettings(p)).toEqual({ defaultWorkspace: null });
  });
});

describe("默认工作区解析", () => {
  it("内置 Default 挂在文档区 Mr Otto/ 下(documentsDir 由 Electron 抹平平台差异)", () => {
    expect(builtinDefaultWorkspace("/Users/x/Documents")).toBe(
      join("/Users/x/Documents", "Mr Otto", "Default")
    );
  });

  it("设置过就用设置的,没设置用内置 Default", () => {
    expect(
      resolveDefaultWorkspace("/Users/x/Documents", { defaultWorkspace: "/Users/x/proj" })
    ).toBe("/Users/x/proj");
    expect(resolveDefaultWorkspace("/Users/x/Documents", { defaultWorkspace: null })).toBe(
      builtinDefaultWorkspace("/Users/x/Documents")
    );
  });
});
