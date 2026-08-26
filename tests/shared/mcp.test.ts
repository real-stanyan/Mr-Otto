import { describe, it, expect } from "vitest";
import {
  assignMcpToolNames,
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
    // 净化会丢信息，所以尾部挂指纹（issue #156）。这条断言从前是
    // "mcp__my_server___do_thing"——它钉住的正是那个 bug：两个不同的 server id
    // 净化成同一串之后没有任何东西再把它们分开
    expect(mcpToolName("my server!", "do.thing")).toMatch(/^mcp__my_server___do_thing_[0-9a-f]{4}$/);
  });

  it("超长时截断，且截断后仍然唯一（尾部挂 4 位哈希）", () => {
    const long = "x".repeat(80);
    const a = mcpToolName("s", long + "a");
    const b = mcpToolName("s", long + "b");
    expect(a.length).toBeLessThanOrEqual(64);
    expect(b.length).toBeLessThanOrEqual(64);
    expect(a).not.toBe(b);
  });

  // issue #156：指纹从前只挂在长度分支上，下面这几对全都不超长，
  // 于是它们各自塌成同一个名字——LoopEngine 的 toolsByName 静默保留最后一个，
  // 模型调 A 实际执行 B
  it.each([
    ["净化撞车", "foo.bar", "x", "foo_bar", "x"],
    ["净化撞车（空格 vs 下划线）", "a b", "x", "a_b", "x"],
    ["分隔符撞车（server 以 _ 结尾）", "a_", "b", "a", "_b"],
    ["分隔符撞车（server 里含 __）", "a__b", "c", "a", "b__c"],
  ])("%s 的两个 (server, tool) 不塌成同一个工具名", (_label, s1, t1, s2, t2) => {
    expect(mcpToolName(s1, t1)).not.toBe(mcpToolName(s2, t2));
  });

  it("干净的名字不加料（绝大多数 server 的日常形态）", () => {
    expect(mcpToolName("github", "create_pr")).toBe("mcp__github__create_pr");
    expect(mcpToolName("my-server", "a-b_c")).toBe("mcp__my-server__a-b_c");
  });

  it("加了指纹也不越过 64 字符上限", () => {
    const name = mcpToolName("x".repeat(30) + ".", "y".repeat(30));
    expect(name.length).toBeLessThanOrEqual(64);
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

describe("assignMcpToolNames（整桌统一分配，issue #349）", () => {
  it("两个 server 提供同名工具：都能拿到名字且互不覆盖", () => {
    const names = assignMcpToolNames([
      { server: "github", tool: "search" },
      { server: "slack", tool: "search" },
    ]);
    expect(names[0]).toBe("mcp__github__search");
    expect(names[1]).toBe("mcp__slack__search");
    expect(names[0]).not.toBe(names[1]);
  });

  it("完全相同的原始身份：去重跳过（null）", () => {
    const names = assignMcpToolNames([
      { server: "gh", tool: "search" },
      { server: "gh", tool: "search" },
    ]);
    expect(names[0]).toBe("mcp__gh__search");
    expect(names[1]).toBeNull();
  });

  it("净化塌名 + 指纹仍撞：换哈希输入重试直到唯一", () => {
    // foo.bar 与 foo_bar 净化后同串，指纹分开——先验证常规路
    const sanitized = assignMcpToolNames([
      { server: "foo.bar", tool: "x" },
      { server: "foo_bar", tool: "x" },
    ]);
    expect(new Set(sanitized).size).toBe(2);

    // 同一份输入跑两遍 = 同一份分配（approvalPreview 反查依赖这个确定性）
    const pairs = [
      { server: "含中文的服务", tool: "工具" },
      { server: "含中文的服务", tool: "另一把" },
      { server: "plain", tool: "tool" },
    ];
    expect(assignMcpToolNames(pairs)).toEqual(assignMcpToolNames(pairs));
    const out = assignMcpToolNames(pairs).filter((n): n is string => n !== null);
    expect(new Set(out).size).toBe(out.length); // 全体唯一
    for (const n of out) expect(n).toMatch(/^mcp__[A-Za-z0-9_-]+$/); // 全部合法
  });
});

// issue #473：known 名单的 MCP 半边。三件套的挂载条件是「装配有 mcp 能力」，
// 与有没有连上 server 无关——known 名单必须同样认得它们，否则子 agent 的
// frontmatter 点名会被 unknownTools 静默剔除（写得出、看着生效、实际被吞）
describe("knownMcpToolNames（issue #473）", () => {
  it("零 server 也认得自助配置三把刀 + mcp_read_resource——点名即有", async () => {
    const { knownMcpToolNames } = await import("../../src/shared/mcp.js");
    expect(knownMcpToolNames([])).toEqual([
      "mcp_catalog",
      "mcp_configure",
      "mcp_authorize",
      "mcp_read_resource",
    ]);
  });

  it("三个名字与工具真身的 def.name 逐字一致（防两边各改各的）", async () => {
    const { MCP_SELF_CONFIG_TOOL_NAMES } = await import("../../src/shared/mcp.js");
    const { mcpCatalogTool } = await import("../../src/tools/mcpCatalog.js");
    const { createMcpConfigureTool } = await import("../../src/tools/mcpConfigure.js");
    const { createMcpAuthorizeTool } = await import("../../src/tools/mcpAuthorize.js");
    const real = [
      mcpCatalogTool.def.name,
      createMcpConfigureTool().def.name,
      createMcpAuthorizeTool().def.name,
    ];
    expect([...MCP_SELF_CONFIG_TOOL_NAMES]).toEqual(real);
  });

  it("live server 的工具名进表、掉线的不进，但哈希分配按整桌算（issue #349 同款）", async () => {
    const { knownMcpToolNames } = await import("../../src/shared/mcp.js");
    const servers = [
      { name: "gh", live: true, tools: [{ name: "create_pr" }] },
      { name: "dead", live: false, tools: [{ name: "zombie" }] },
    ];
    const known = knownMcpToolNames(servers);
    expect(known).toContain("mcp__gh__create_pr");
    expect(known.some((n) => n.includes("zombie"))).toBe(false);
    // 分配确定性：与 assignMcpToolNames 在全体上的结果同源
    const assigned = assignMcpToolNames([
      { server: "gh", tool: "create_pr" },
      { server: "dead", tool: "zombie" },
    ]);
    expect(known).toContain(assigned[0]!);
  });
});
