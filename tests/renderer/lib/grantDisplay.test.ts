import { describe, expect, it } from "vitest";
import { describeGrantKey, describeExecPattern } from "../../../src/renderer/src/lib/grantDisplay.js";
import { grantKeysFor } from "../../../src/shared/grantKey.js";

const SEP = "";

describe("describeGrantKey", () => {
  it("旧条目（裸工具名）= 整个工具放行，legacy 标出来", () => {
    expect(describeGrantKey("bash")).toEqual({ tool: "bash", legacy: true });
  });

  it("bash 的 cmd key：argv 拼回可读命令", () => {
    // 用真的 grantKeysFor 产出——展示层和产出层对同一形状，别各自手搓
    const [key] = grantKeysFor({ name: "bash", args: { cmd: "npm test" } }, "/proj/a");
    expect(describeGrantKey(key!)).toEqual({
      tool: "bash",
      cwd: "/proj/a",
      detail: "npm test",
      legacy: false,
    });
  });

  it("bash 的 raw key（复杂脚本原文精确匹配）", () => {
    const [key] = grantKeysFor({ name: "bash", args: { cmd: "a | b" } }, "/proj/a");
    expect(describeGrantKey(key!)).toMatchObject({ tool: "bash", detail: "a | b" });
  });

  it("write_file 的 path key", () => {
    const [key] = grantKeysFor({ name: "write_file", args: { path: "/proj/a/x.ts" } }, "/proj/a");
    expect(describeGrantKey(key!)).toMatchObject({ tool: "write_file", detail: "/proj/a/x.ts" });
  });

  it("工具粒度 key（MCP 等）：只有工具名 + cwd，没有 detail", () => {
    const [key] = grantKeysFor({ name: "mcp__gh__create_pr", args: {} }, "/proj/a");
    expect(describeGrantKey(key!)).toEqual({
      tool: "mcp__gh__create_pr",
      cwd: "/proj/a",
      legacy: false,
    });
  });

  it("cmd= 后面不是合法 JSON：按原样展示，不崩", () => {
    expect(
      describeGrantKey(`bash${SEP}cwd=/p${SEP}cmd={坏的`).detail
    ).toBe("{坏的");
  });
});

describe("describeExecPattern", () => {
  it("纯 token 拼空格", () => {
    expect(describeExecPattern(["npm", "test"])).toBe("npm test");
  });

  it("候选集段用 | 连", () => {
    expect(describeExecPattern(["git", ["status", "log"]])).toBe("git status|log");
  });
});
