import { describe, expect, it } from "vitest";

import {
  blankRow,
  mcpConfigsEqual,
  mcpDisplayStatus,
  mcpServerIdError,
  recordFromRows,
  rowsFromRecord,
  splitArgs,
  type KeyValueRow,
} from "../../src/renderer/src/lib/mcpForm.js";
import type { McpHttpConfig, McpStdioConfig } from "../../src/shared/mcp.js";

function stdio(overrides: Partial<McpStdioConfig> = {}): McpStdioConfig {
  return {
    kind: "stdio",
    command: "npx",
    args: [],
    env: {},
    enabled: true,
    ...overrides,
  };
}

function http(overrides: Partial<McpHttpConfig> = {}): McpHttpConfig {
  return {
    kind: "http",
    url: "https://example.com/mcp",
    headers: {},
    enabled: true,
    ...overrides,
  };
}

describe("mcpDisplayStatus", () => {
  it("关掉的 server 永远显示 disabled,不管后端记的是哪一档 status", () => {
    expect(mcpDisplayStatus(stdio({ enabled: false }), "connecting")).toBe("disabled");
    expect(mcpDisplayStatus(stdio({ enabled: false }), "failed")).toBe("disabled");
    expect(mcpDisplayStatus(http({ enabled: false }), "connected")).toBe("disabled");
  });

  it("开着的 server 原样透传后端的 status", () => {
    expect(mcpDisplayStatus(stdio(), "connecting")).toBe("connecting");
    expect(mcpDisplayStatus(stdio(), "connected")).toBe("connected");
    expect(mcpDisplayStatus(stdio(), "needs-auth")).toBe("needs-auth");
    expect(mcpDisplayStatus(stdio(), "failed")).toBe("failed");
  });
});

describe("rowsFromRecord / recordFromRows", () => {
  it("往返：Record 转行再转回去，内容不变", () => {
    const record = { DEEPSEEK_API_KEY: "sk-31cf5*****828c", DEBUG: "true" };
    const rows = rowsFromRecord(record);
    expect(rows).toHaveLength(2);
    expect(recordFromRows(rows)).toEqual(record);
  });

  it("每一行的 rowId 互不相同——改键名不该让这一行被当成新行", () => {
    const rows = rowsFromRecord({ A: "1", B: "2" });
    const ids = new Set(rows.map((r) => r.rowId));
    expect(ids.size).toBe(rows.length);
  });

  it("键名为空的行提交时整行丢弃", () => {
    const rows: KeyValueRow[] = [
      { rowId: "1", key: "REAL_KEY", value: "v" },
      { rowId: "2", key: "", value: "还没打完键名" },
      { rowId: "3", key: "   ", value: "只有空白也算空" },
    ];
    expect(recordFromRows(rows)).toEqual({ REAL_KEY: "v" });
  });

  it("键名两端空白被裁掉", () => {
    const rows: KeyValueRow[] = [{ rowId: "1", key: "  SPACED  ", value: "v" }];
    expect(recordFromRows(rows)).toEqual({ SPACED: "v" });
  });

  it("同名键撞了，后写的赢", () => {
    const rows: KeyValueRow[] = [
      { rowId: "1", key: "DUP", value: "old" },
      { rowId: "2", key: "DUP", value: "new" },
    ];
    expect(recordFromRows(rows)).toEqual({ DUP: "new" });
  });

  it("blankRow 起手是空键空值，且每次调用 id 不同", () => {
    const a = blankRow();
    const b = blankRow();
    expect(a.key).toBe("");
    expect(a.value).toBe("");
    expect(a.rowId).not.toBe(b.rowId);
  });
});

describe("mcpServerIdError", () => {
  it("空名字被拒", () => {
    expect(mcpServerIdError("", [])).toMatch(/起个名字/);
    expect(mcpServerIdError("   ", [])).toMatch(/起个名字/);
  });

  it("撞了已有的 id 被拒", () => {
    expect(mcpServerIdError("github", ["github", "fs"])).toMatch(/已经有一台/);
  });

  it("合法的新名字通过", () => {
    expect(mcpServerIdError("github", ["fs"])).toBeNull();
  });
});

describe("mcpConfigsEqual", () => {
  it("同一份 stdio 配置视为相等,即便 env 键序不同", () => {
    const a = stdio({ env: { A: "1", B: "2" } });
    const b = stdio({ env: { B: "2", A: "1" } });
    expect(mcpConfigsEqual(a, b)).toBe(true);
  });

  it("kind 不同直接判不等", () => {
    expect(mcpConfigsEqual(stdio(), http())).toBe(false);
  });

  it("command / args / enabled / env 任一项不同就判不等", () => {
    expect(mcpConfigsEqual(stdio(), stdio({ command: "other" }))).toBe(false);
    expect(mcpConfigsEqual(stdio({ args: ["a"] }), stdio({ args: ["b"] }))).toBe(false);
    expect(mcpConfigsEqual(stdio(), stdio({ enabled: false }))).toBe(false);
    expect(mcpConfigsEqual(stdio({ env: { A: "1" } }), stdio({ env: { A: "2" } }))).toBe(false);
  });

  it("http 配置比较 url / headers / enabled", () => {
    expect(mcpConfigsEqual(http(), http({ url: "https://other" }))).toBe(false);
    expect(mcpConfigsEqual(http({ headers: { X: "1" } }), http({ headers: { X: "1" } }))).toBe(true);
  });
});

describe("splitArgs", () => {
  it("按空白切分，过滤空段", () => {
    expect(splitArgs("-y  @modelcontextprotocol/server-filesystem  /Users/x")).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "/Users/x",
    ]);
  });

  it("空字符串给出空数组", () => {
    expect(splitArgs("")).toEqual([]);
    expect(splitArgs("   ")).toEqual([]);
  });
});
