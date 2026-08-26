import { describe, expect, it } from "vitest";
import { buildApprovalPreview } from "../../src/main/approvalPreview.js";
import type { ExecutionWorld, McpServerHandle } from "../../src/world/executionWorld.js";
import { mcpToolName } from "../../src/shared/mcp.js";
import type { McpServerConfig } from "../../src/shared/mcp.js";

function worldWith(files: Record<string, string>): ExecutionWorld {
  return {
    fs: {
      async read(path) {
        const content = files[path];
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        return content;
      },
      async write() {},
    },
    async exec() {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    http: { postJson: async () => ({}) },
  };
}

describe("buildApprovalPreview", () => {
  it("write_file 覆盖已有文件 → 旧内容随预览出场", async () => {
    const preview = await buildApprovalPreview(
      { id: "c1", name: "write_file", args: { path: "a.txt", content: "新" } },
      worldWith({ "a.txt": "旧" })
    );
    expect(preview).toEqual({ kind: "write_file", path: "a.txt", oldText: "旧", newText: "新" });
  });

  it("目标不存在 → oldText 为 null（新文件），预览失败不挡审批", async () => {
    const preview = await buildApprovalPreview(
      { id: "c1", name: "write_file", args: { path: "new.txt", content: "内容" } },
      worldWith({})
    );
    expect(preview).toEqual({ kind: "write_file", path: "new.txt", oldText: null, newText: "内容" });
  });

  it("非 write_file（bash 等）→ 无预览，审批卡走 JSON 兜底", async () => {
    const preview = await buildApprovalPreview(
      { id: "c1", name: "bash", args: { cmd: "rm -rf /" } },
      worldWith({})
    );
    expect(preview).toBeUndefined();
  });

  it("参数出自模型，形状不对不赌：缺 path/content 就不预览", async () => {
    const preview = await buildApprovalPreview(
      { id: "c1", name: "write_file", args: { path: 42 } },
      worldWith({})
    );
    expect(preview).toBeUndefined();
  });

  it("超大内容 → 放弃预览（IPC 别扛巨物）", async () => {
    const preview = await buildApprovalPreview(
      { id: "c1", name: "write_file", args: { path: "big.txt", content: "x".repeat(300_000) } },
      worldWith({})
    );
    expect(preview).toBeUndefined();
  });
});

// issue #157：MCP 工具的审批卡从前是 `mcp__github__create_pr` + 一坨原始 JSON。
// 预览把它拆回"哪台 server 的哪把刀 + 参数表"——server/tool 只能由主进程在还
// 知道两截的时候拆好，工具名那一路是有损收口（净化 + 截断 + 指纹），反推不回去
describe("buildApprovalPreview：MCP 工具", () => {
  const mcpWorld = (over: Partial<McpServerHandle> = {}): ExecutionWorld => ({
    ...worldWith({}),
    mcp: {
      ready: async () => {},
      servers: () => [{
        id: "gh", name: "gh", status: "connected", live: true,
        tools: [{ name: "create_pr", description: "开 PR", inputSchema: {} }],
        resources: [], prompts: [],
        ...over,
      }],
      callTool: async () => [],
      readResource: async () => [],
      getPrompt: async () => "",
      configure: async () => {},
      authorize: async () => {},
      configOf: () => undefined,
    },
  });

  it("认出是哪台 server 的哪把刀，参数摊平成一格一项", async () => {
    const preview = await buildApprovalPreview(
      { id: "c1", name: "mcp__gh__create_pr", args: { title: "加个功能", draft: true } },
      mcpWorld()
    );
    expect(preview).toEqual({
      kind: "mcp_tool",
      server: "gh",
      tool: "create_pr",
      description: "开 PR",
      args: [
        { name: "title", value: "加个功能", truncated: false, fullLength: 4 },
        { name: "draft", value: "true", truncated: false, fullLength: 4 },
      ],
    });
  });

  it("字符串参数原样，其余 JSON 序列化（卡上不显示引号包着的中文）", async () => {
    const preview = await buildApprovalPreview(
      { id: "c1", name: "mcp__gh__create_pr", args: { s: "纯文本", n: 42, o: { a: 1 } } },
      mcpWorld()
    );
    expect(preview?.kind === "mcp_tool" && preview.args.map((a) => a.value)).toEqual([
      "纯文本", "42", '{"a":1}',
    ]);
  });

  it("超长参数在主进程就截断，并说出原长（IPC 别扛巨物）", async () => {
    const preview = await buildApprovalPreview(
      { id: "c1", name: "mcp__gh__create_pr", args: { body: "x".repeat(5_000) } },
      mcpWorld()
    );
    expect(preview?.kind === "mcp_tool" && preview.args[0]).toEqual({
      name: "body", value: "x".repeat(2_000), truncated: true, fullLength: 5_000,
    });
  });

  it("没有参数 = 空数组，不是 undefined（卡上要说得出「这次调用没有参数」）", async () => {
    const preview = await buildApprovalPreview(
      { id: "c1", name: "mcp__gh__create_pr", args: {} },
      mcpWorld()
    );
    expect(preview?.kind === "mcp_tool" && preview.args).toEqual([]);
  });

  it("参数根本不是对象时不硬拆，整体记成一项", async () => {
    const preview = await buildApprovalPreview(
      { id: "c1", name: "mcp__gh__create_pr", args: ["a", "b"] as unknown as Record<string, unknown> },
      mcpWorld()
    );
    expect(preview?.kind === "mcp_tool" && preview.args).toEqual([
      { name: "参数", value: '["a","b"]', truncated: false, fullLength: 9 },
    ]);
  });

  it("清单里找不到这把刀（server 刚掉线）→ 不预览，审批卡照常弹", async () => {
    const preview = await buildApprovalPreview(
      { id: "c1", name: "mcp__gh__gone", args: {} },
      mcpWorld()
    );
    expect(preview).toBeUndefined();
  });

  it("world 里压根没有 mcp 能力 → 不预览", async () => {
    const preview = await buildApprovalPreview(
      { id: "c1", name: "mcp__gh__create_pr", args: {} },
      worldWith({})
    );
    expect(preview).toBeUndefined();
  });

  it("server id 需要净化时也认得出来（工具名有损，靠正着算而不是反推）", async () => {
    const world: ExecutionWorld = {
      ...worldWith({}),
      mcp: {
        ready: async () => {},
        servers: () => [{
          id: "my.server", name: "my.server", status: "connected", live: true,
          tools: [{ name: "do.thing", description: "", inputSchema: {} }],
          resources: [], prompts: [],
        }],
        callTool: async () => [],
        readResource: async () => [],
        getPrompt: async () => "",
        configure: async () => {},
        authorize: async () => {},
        configOf: () => undefined,
      },
    };
    const preview = await buildApprovalPreview(
      { id: "c1", name: mcpToolName("my.server", "do.thing"), args: {} },
      world
    );
    expect(preview).toMatchObject({ kind: "mcp_tool", server: "my.server", tool: "do.thing" });
  });
});

// Task 9：mcp_configure 的审批预览。这张卡是"agent 自助配置 MCP server"这条路上
// 唯一的安全闸——worldWithMcp 造一个带假 mcp 能力的 world，configOf 从传入的
// map 里取（对照"改之前是什么"），servers() 按 map 造 handle（每台配一把工具，
// 用来算 before.toolCount）
function worldWithMcp(configs: Record<string, McpServerConfig> = {}): ExecutionWorld {
  return {
    ...worldWith({}),
    mcp: {
      ready: async () => {},
      servers: () =>
        Object.keys(configs).map((id) => ({
          id, name: id, status: "connected", live: true,
          tools: [{ name: "t", description: "", inputSchema: {} }],
          resources: [], prompts: [],
        })),
      callTool: async () => [],
      readResource: async () => [],
      getPrompt: async () => "",
      configure: async () => {},
      authorize: async () => {},
      configOf: (id: string) => configs[id],
    },
  };
}

describe("mcp_configure 的审批预览", () => {
  it("stdio：command / 每一条 arg / env 的键名都列出来，值不列", async () => {
    const preview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "fs", kind: "stdio", command: "npx", args: ["-y", "pkg"], env: { TOKEN: "sk-真的" } } },
      worldWithMcp()
    );
    expect(preview).toMatchObject({
      kind: "mcp_configure", server: "fs", action: "add",
      transport: "stdio", command: "npx", args: ["-y", "pkg"],
      credentialKeys: ["TOKEN"],
    });
    expect(JSON.stringify(preview)).not.toContain("sk-真的");
  });

  it("http：url 全文出现在卡片上——用户要看得到自己在授权给谁", async () => {
    const preview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "s", kind: "http", url: "https://mcp.supabase.com/mcp" } },
      worldWithMcp()
    );
    expect(preview).toMatchObject({ kind: "mcp_configure", url: "https://mcp.supabase.com/mcp" });
  });

  it("改已有的一台时带上「改之前是什么」", async () => {
    const preview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "s", kind: "http", url: "https://新的/mcp" } },
      worldWithMcp({ s: { kind: "http", url: "https://旧的/mcp", headers: {}, enabled: true } })
    );
    expect(preview).toMatchObject({ action: "update", before: { url: "https://旧的/mcp" } });
  });

  it("删除时说清删的是哪台、它现在有几把刀", async () => {
    const preview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "s", action: "remove" } },
      worldWithMcp({ s: { kind: "http", url: "https://旧的/mcp", headers: {}, enabled: true } })
    );
    expect(preview).toMatchObject({ action: "remove", server: "s" });
  });

  // 终审 B Important：enabled 是唯一一个"有执行后果却不在卡上"的字段。
  // stdio 的 enabled: true 就是"这条 command 会被 spawn"（mcpHub.ts），而
  // mcp_configure 的默认是 `a["enabled"] !== false` = 缺省 true。没有这两个
  // 字段的话有一条无声路径：用户手动关掉过一台 server，agent 用同样的
  // id/command/args 调一次 mcp_configure，卡片显示 update + command 逐字相同
  // = 一次"看起来什么都没变"的更新，用户点同意，命令当场被 spawn。
  it("enabled 缺省为 true，与 parseConfigureArgs 同一份默认", async () => {
    const preview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "fs", kind: "stdio", command: "npx" } },
      worldWithMcp()
    );
    expect(preview).toMatchObject({ kind: "mcp_configure", enabled: true });
  });

  it("显式 enabled: false 照实上卡", async () => {
    const preview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "fs", kind: "stdio", command: "npx", enabled: false } },
      worldWithMcp()
    );
    expect(preview).toMatchObject({ kind: "mcp_configure", enabled: false });
  });

  it("「看起来什么都没变的更新」也把 enabled 的翻转摊在卡上（false → true）", async () => {
    const preview = await buildApprovalPreview(
      // command/args 与磁盘上那台逐字相同，唯一的变化是 enabled 从 false 翻成 true
      { id: "1", name: "mcp_configure", args: { id: "fs", kind: "stdio", command: "rm", args: ["-rf", "/"] } },
      worldWithMcp({ fs: { kind: "stdio", command: "rm", args: ["-rf", "/"], env: {}, enabled: false } })
    );
    expect(preview).toMatchObject({
      kind: "mcp_configure",
      action: "update",
      enabled: true,
      before: { command: "rm", enabled: false },
    });
  });

  // #472：模型对已配好的一台调 mcp_configure 而没带 env/headers 时，旧的键
  // 会被整批丢掉（mergeMaskedCreds 只遍历 incoming 的键）——一台好端端的
  // server 在一次「更新」之后变成 401，而用户签的字里没有这一项。before
  // 必须带上旧凭据的键名，卡片才画得出「改之前 / 改之后」
  it("before 带上旧凭据的键名——不带 headers 的更新在卡上看得出正在丢掉哪几把（#472）", async () => {
    const preview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "s", kind: "http", url: "https://mcp.example.com/mcp" } },
      worldWithMcp({
        s: { kind: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer sk-旧的" }, enabled: true },
      })
    );
    expect(preview).toMatchObject({
      kind: "mcp_configure",
      credentialKeys: [],
      before: { credentialKeys: ["Authorization"] },
    });
    // 键名过桥，值仍然绝不过桥（ADR-0044 口径不变）
    expect(JSON.stringify(preview)).not.toContain("sk-旧的");
  });

  it("stdio 的 before.credentialKeys 来自旧 env 的键名（#472）", async () => {
    const preview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "fs", kind: "stdio", command: "npx", env: { NEW_KEY: "v" } } },
      worldWithMcp({ fs: { kind: "stdio", command: "npx", args: [], env: { OLD_TOKEN: "sk-旧的" }, enabled: true } })
    );
    expect(preview).toMatchObject({
      credentialKeys: ["NEW_KEY"],
      before: { credentialKeys: ["OLD_TOKEN"] },
    });
    expect(JSON.stringify(preview)).not.toContain("sk-旧的");
  });

  it("before 带上旧的启用状态——只有新值看不出这次是不是翻转", async () => {
    const preview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "s", kind: "http", url: "https://新的/mcp" } },
      worldWithMcp({ s: { kind: "http", url: "https://旧的/mcp", headers: {}, enabled: true } })
    );
    expect(preview?.kind === "mcp_configure" && preview.before?.enabled).toBe(true);
  });

  it("remove 不谈启用状态 —— enabled 为 null", async () => {
    const preview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "s", action: "remove" } },
      worldWithMcp({ s: { kind: "http", url: "https://旧的/mcp", headers: {}, enabled: true } })
    );
    expect(preview?.kind === "mcp_configure" && preview.enabled).toBeNull();
  });

  // Task 9 审查 Important 1：args 必须留在数组里、一格一项，不能在预览这一层
  // 就被 join 成一句话——`["-y", "some pkg"]` 和 `["-y", "some", "pkg"]` join
  // 之后长得一模一样，用户分不清是一个参数还是两个。渲染层（App.tsx 的
  // McpConfigureApproval）逐项建行，前提是这里给的就是逐项的数组。
  it("args 保持数组、逐项分开，不折成一个 join 后的字符串", async () => {
    const preview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "fs", kind: "stdio", command: "npx", args: ["-y", "some pkg"] } },
      worldWithMcp()
    );
    expect(preview?.kind === "mcp_configure" && preview.args).toEqual(["-y", "some pkg"]);
  });

  // Task 9 复审 Critical A：host 是独立算出来的字段（`URL.host`），不是从
  // url 字符串里现切的——即便 url 那一行以后被截断/变形，这一行必须永远
  // 是解析器实际会连接的主机。
  it("host 是从 url 独立解析出来的字段，不是从 url 串里现切", async () => {
    const preview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "s", kind: "http", url: "https://mcp.supabase.com/mcp" } },
      worldWithMcp()
    );
    expect(preview).toMatchObject({ kind: "mcp_configure", host: "mcp.supabase.com" });
  });

  // Task 9 复审 Critical A：换个填充字符（点号代替换行）的同一个漏洞——
  // 预览层不应该被这种输入骗到显示一个"看起来干净"的 url。host 字段必须
  // 露出真实主机 evil.com，且 url 字段（归一化后）也应该等于真实 href。
  it("userinfo 填充攻击：host 字段露出真实主机，不被点号填充骗过", async () => {
    const malicious = "https://mcp.supabase.com" + ".".repeat(1400) + "@evil.com/mcp";
    const preview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "s", kind: "http", url: malicious } },
      worldWithMcp()
    );
    expect(preview).toMatchObject({ kind: "mcp_configure", host: "evil.com" });
  });

  // Task 9 的截断修复（clipValue / truncated / fullLength）此前一条测试都没有
  // ——同一个文件里 mcp_tool 那条平行路径是有的（"超长参数在主进程就截断"），
  // mcp_configure 这条没有。渲染层那份把 truncated 全写死成 false，所以
  // "只显示前 N 字符，共 M" 那个 UI 分支从没被渲染过（终审 C 5）
  it("超长 command 在主进程就截断，并说出原长", async () => {
    const preview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "fs", kind: "stdio", command: "x".repeat(3_000) } },
      worldWithMcp()
    );
    expect(preview?.kind === "mcp_configure" && preview.command).toBe("x".repeat(2_000));
    expect(preview?.kind === "mcp_configure" && preview.truncated.command).toBe(true);
    expect(preview?.kind === "mcp_configure" && preview.fullLength.command).toBe(3_000);
  });

  it("超长 url / args 同样截断并说出原长", async () => {
    const long = "https://mcp.example.com/" + "p".repeat(3_000);
    const preview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "fs", kind: "stdio", command: "npx", args: ["-y", "z".repeat(2_500)] } },
      worldWithMcp()
    );
    expect(preview?.kind === "mcp_configure" && preview.args[1]?.length).toBe(2_000);
    expect(preview?.kind === "mcp_configure" && preview.truncated.args).toEqual([false, true]);
    expect(preview?.kind === "mcp_configure" && preview.fullLength.args).toEqual([2, 2_500]);

    const httpPreview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "s", kind: "http", url: long } },
      worldWithMcp()
    );
    expect(httpPreview?.kind === "mcp_configure" && httpPreview.truncated.url).toBe(true);
    expect(httpPreview?.kind === "mcp_configure" && httpPreview.url?.length).toBe(2_000);
  });

  // 终审 C 8+9：server 完全由模型控制，且渲染在 host 那一行之前——不设上限
  // 的话，一个几千字符的 id 会把卡上唯一那条永不截断的安全闸挤下折叠线
  it("超长 server id 也有上限（它排在 host 之前，会把安全闸挤下折叠线）", async () => {
    const preview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "S".repeat(5_000), kind: "http", url: "https://mcp.supabase.com/mcp" } },
      worldWithMcp()
    );
    expect(preview?.kind === "mcp_configure" && preview.server.length).toBe(200);
    expect(preview?.kind === "mcp_configure" && preview.truncated.server).toBe(true);
    expect(preview?.kind === "mcp_configure" && preview.fullLength.server).toBe(5_000);
    // 而 host 那一行照旧完整
    expect(preview?.kind === "mcp_configure" && preview.host).toBe("mcp.supabase.com");
  });

  it("before 的 url / command 同样有上限——不让一个几 MB 的旧值原样过 IPC", async () => {
    const preview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "fs", kind: "stdio", command: "npx" } },
      worldWithMcp({ fs: { kind: "stdio", command: "y".repeat(9_000), args: [], env: {}, enabled: true } })
    );
    expect(preview?.kind === "mcp_configure" && preview.before?.command?.length).toBe(2_000);
  });

  it("credentialKeys：键名数量与单个键名长度都有上限，超出的部分明说不静默丢", async () => {
    // 超长键名必须排在前 50 个之内，否则 slice(0, MAX_CRED_KEYS) 会把它连同
    // 「单个键名截断」这条断言一起切掉（终审 N-1：曾经排在第 60 位，前 50
    // 个键的最大长度只有 3，断言看着覆盖了截断、其实从未真正跑到那条分支）。
    const env: Record<string, string> = { ["超长键名" + "N".repeat(500)]: "v" };
    for (let i = 0; i < 60; i++) env[`K${i}`] = "v";
    const preview = await buildApprovalPreview(
      { id: "1", name: "mcp_configure", args: { id: "fs", kind: "stdio", command: "npx", env } },
      worldWithMcp()
    );
    const keys = preview?.kind === "mcp_configure" ? preview.credentialKeys : [];
    // 50 个键名 + 一句"还有 N 个未显示"
    expect(keys).toHaveLength(51);
    expect(keys.at(-1)).toMatch(/还有 11 个键名未显示/);
    // 超长键名排在第一个，必然落在保留的前 50 个里，真正验证到 120 字符截断
    expect(keys[0]).toHaveLength(120);
    expect(Math.max(...keys.slice(0, 50).map((k) => k.length))).toBeLessThanOrEqual(120);
  });
});
