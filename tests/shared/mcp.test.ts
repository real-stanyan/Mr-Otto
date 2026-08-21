import { describe, it, expect } from "vitest";
import {
  mcpToolName,
  renderMcpContent,
  maskMcpConfig,
  type McpServerConfig,
} from "../../src/shared/mcp.js";

describe("mcpToolName", () => {
  it("拼成 mcp__<server>__<tool>", () => {
    expect(mcpToolName("github", "create_pr")).toBe("mcp__github__create_pr");
  });

  it("非法字符换成下划线 —— 模型的工具名只认 [A-Za-z0-9_-]", () => {
    expect(mcpToolName("my server!", "do.thing")).toBe("mcp__my_server___do_thing");
  });

  it("超长时截断，且截断后仍然唯一（尾部挂 4 位哈希）", () => {
    const long = "x".repeat(80);
    const a = mcpToolName("s", long + "a");
    const b = mcpToolName("s", long + "b");
    expect(a.length).toBeLessThanOrEqual(64);
    expect(b.length).toBeLessThanOrEqual(64);
    expect(a).not.toBe(b);
  });
});

describe("renderMcpContent", () => {
  it("多段 text 用空行接起来", () => {
    expect(renderMcpContent([
      { kind: "text", text: "第一段" },
      { kind: "text", text: "第二段" },
    ])).toBe("第一段\n\n第二段");
  });

  it("image 折成一行说明 —— 本版不进视觉桥，但要让模型知道有这么个东西", () => {
    const out = renderMcpContent([{ kind: "image", data: "AAAA", mimeType: "image/png" }]);
    expect(out).toContain("image/png");
    expect(out).not.toContain("AAAA");
  });

  it("resource 有正文就给正文，并标出 uri", () => {
    const out = renderMcpContent([
      { kind: "resource", uri: "file:///a.txt", text: "内容", mimeType: "text/plain" },
    ]);
    expect(out).toContain("file:///a.txt");
    expect(out).toContain("内容");
  });

  it("空数组 = 一句人话，不是空串（空串会让模型以为工具坏了）", () => {
    expect(renderMcpContent([])).toBe("(工具没有返回任何内容)");
  });
});

describe("maskMcpConfig", () => {
  it("stdio 的 env 值遮罩，键名原样留着", () => {
    const cfg: McpServerConfig = {
      kind: "stdio",
      command: "npx",
      args: ["-y", "server"],
      env: { GITHUB_TOKEN: "ghp_abcdefghijklmnop" },
      enabled: true,
    };
    const masked = maskMcpConfig(cfg);
    expect(masked.kind).toBe("stdio");
    if (masked.kind !== "stdio") throw new Error("窄化失败");
    expect(Object.keys(masked.env)).toEqual(["GITHUB_TOKEN"]);
    expect(masked.env["GITHUB_TOKEN"]).not.toContain("abcdefgh".slice(4));
    expect(masked.env["GITHUB_TOKEN"]).toContain("*****");
    expect(masked.command).toBe("npx");
  });

  it("http 的 headers 值遮罩", () => {
    const cfg: McpServerConfig = {
      kind: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer sk-1234567890abcdef" },
      enabled: true,
    };
    const masked = maskMcpConfig(cfg);
    if (masked.kind !== "http") throw new Error("窄化失败");
    expect(masked.headers["Authorization"]).toContain("*****");
    expect(masked.url).toBe("https://mcp.linear.app/mcp");
  });
});
