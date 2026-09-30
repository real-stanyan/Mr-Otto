// tests/shared/mcpCatalogFill.test.ts
import { describe, expect, it } from "vitest";
import { MCP_CATALOG } from "../../src/shared/mcpCatalog.js";
import { fillHttpEntry, missingParams } from "../../src/shared/mcpCatalogFill.js";
import { configFromEntry } from "../../src/renderer/src/lib/mcpDirectory.js";

const github = MCP_CATALOG.find((e) => e.id === "github")!;

describe("fillHttpEntry", () => {
  it("代进请求头模板，键是真实请求头名", () => {
    expect(fillHttpEntry(github, { github_token: "ghp_x" })).toEqual({
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer ghp_x" },
    });
  });
  it("没填的不落请求头（不写装着 {hole} 的键）", () => {
    expect(fillHttpEntry(github, {}).headers).toEqual({});
  });
  it("missingParams 只报必填且空的", () => {
    expect(missingParams(github, {})).toEqual(["github_token"]);
    expect(missingParams(github, { github_token: " " })).toEqual(["github_token"]);
    expect(missingParams(github, { github_token: "x" })).toEqual([]);
  });
  it("桌面 configFromEntry 的 http 结果与它逐字一致", () => {
    for (const e of MCP_CATALOG.filter((x) => x.transport === "http")) {
      const values = Object.fromEntries(e.params.map((p) => [p.name, `v-${p.name}`]));
      const cfg = configFromEntry(e, values);
      expect(cfg).toEqual({ kind: "http", ...fillHttpEntry(e, values), enabled: true });
    }
  });
});
