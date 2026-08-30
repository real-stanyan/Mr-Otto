import { describe, it, expect } from "vitest";
import { mcpCatalogTool, render } from "../../src/tools/mcpCatalog.js";
import type { CatalogEntry } from "../../src/shared/mcpCatalog.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

function worldWith(getJson?: (url: string) => Promise<unknown>): ExecutionWorld {
  return {
    fs: {} as never,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    http: {
      postJson: async () => ({}),
      ...(getJson ? { getJson: async (url: string) => getJson(url) } : {}),
    },
  } as unknown as ExecutionWorld;
}

const world = worldWith();

describe("mcp_catalog 工具", () => {
  it("免审批——只读一份仓内常量，没有副作用", () => {
    expect(mcpCatalogTool.requiresApproval).toBe(false);
  });

  // 这条曾经是 deferred（"十几条目录不该占初始工具表的位置"），终审 A 判定
  // 那是这条链路唯一的致命失败模式：三把刀全 deferred 时模型初始看不见任何
  // 一把，而 tool_search 是纯子串打分，搜"supabase"命中不了 mcp_catalog——
  // 代码全对、功能仍然为零。省下的那点工具表体积不值这个价
  it("direct——它是这条链路的入口，必须在初始工具表里", () => {
    expect(mcpCatalogTool.exposure).toBe("direct");
  });

  it("description 里点了常见服务名，tool_search 那条路也能命中", () => {
    const d = mcpCatalogTool.def.description;
    for (const name of ["supabase", "github", "notion", "linear", "sentry", "stripe"]) {
      expect(d).toContain(name);
    }
  });

  it("命中时把后半段链条点名，模型才知道 deferred 的那两把存在", async () => {
    const out = String(await mcpCatalogTool.run({ query: "supabase" }, world));
    expect(out).toContain("mcp_configure");
    expect(out).toContain("mcp_authorize");
  });

  it("已知接不上的要跟水獭说清楚 —— 界面知道不等于 agent 知道（#760）", () => {
    // 这句原来混在 authNote 里，#760 把它拆成独立字段。不在这儿也说一次的话，
    // 水獭照样 mcp_configure 落盘再 mcp_authorize，撞同一堵墙，还白留一台
    // 永远连不上的 server 在用户的 mcp.json 里。
    // 用合成条目：目录里此刻一条 blocked 都没有（#766），但这条行为得留着
    const out = render({
      id: "x",
      name: "X",
      description: "",
      transport: "http",
      url: "https://x.test/mcp",
      params: [],
      auth: "oauth",
      authNote: "配好后点一次授权",
      blocked: "对方的授权服务器不支持动态注册",
    });
    expect(out).toContain("现在接不上");
    expect(out).toContain("别装这台");
  });

  it("没标 blocked 的不会平白多出那句话", async () => {
    const out = String(await mcpCatalogTool.run({ query: "supabase" }, world));
    expect(out).not.toContain("现在接不上");
  });

  it("命中时返回可直接照着填的字段", async () => {
    const out = await mcpCatalogTool.run({ query: "supabase" }, world);
    expect(String(out)).toContain("mcp.supabase.com");
    expect(String(out)).toContain("project_ref");
  });

  it("查不到时明说去搜，而不是回一句空", async () => {
    const out = await mcpCatalogTool.run({ query: "绝无此物xyzzy" }, world);
    expect(String(out)).toMatch(/没有|web_search/);
  });

  it("参数不是对象也不炸——当空查询处理，返回的是真目录不是报错话术", async () => {
    // 只断 resolves.toBeTruthy() 是"只断不崩"的原型（#474）：哪怕 run 回一句
    // "出错了"它也绿。空查询 = 列全目录，断言目录里的条目真的在
    const out = String(await mcpCatalogTool.run(null, world));
    expect(out).toContain("supabase");
    expect(out).toContain("github");
  });
});

const REGISTRY_HIT = {
  servers: [
    {
      server: {
        name: "com.example/widgets",
        title: "Widgets",
        description: "管理 widget",
        version: "1.0.0",
        remotes: [{ type: "streamable-http", url: "https://widgets.example/mcp" }],
      },
      _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true } },
    },
  ],
};

describe("mcp_catalog", () => {
  it("精选命中就不打注册表", async () => {
    let called = false;
    const out = await mcpCatalogTool.run(
      { query: "supabase" },
      worldWith(async () => {
        called = true;
        return { servers: [] };
      })
    );
    expect(String(out)).toContain("Supabase");
    expect(called).toBe(false);
  });

  it("精选没命中就查注册表，结果里带上未核验的话", async () => {
    const out = String(await mcpCatalogTool.run({ query: "widgets" }, worldWith(async () => REGISTRY_HIT)));
    expect(out).toContain("Widgets");
    expect(out).toContain("https://widgets.example/mcp");
    expect(out).toContain("未经核验");
  });

  it("查询词进了 URL", async () => {
    let seen = "";
    await mcpCatalogTool.run(
      { query: "widgets" },
      worldWith(async (url) => {
        seen = url;
        return REGISTRY_HIT;
      })
    );
    expect(seen).toContain("search=widgets");
  });

  it("注册表也没有就退回 web_search 的话术", async () => {
    const out = String(
      await mcpCatalogTool.run({ query: "绝无此物xyzzy" }, worldWith(async () => ({ servers: [] })))
    );
    expect(out).toContain("web_search");
  });

  it("注册表打不通不抛，退回 web_search 的话术", async () => {
    const out = String(
      await mcpCatalogTool.run(
        { query: "绝无此物xyzzy" },
        worldWith(async () => {
          throw new Error("ENOTFOUND");
        })
      )
    );
    expect(out).toContain("web_search");
  });

  it("世界不提供 getJson 时不炸，退回 web_search 的话术", async () => {
    const out = String(await mcpCatalogTool.run({ query: "绝无此物xyzzy" }, worldWith()));
    expect(out).toContain("web_search");
  });

  // 注册表是开放投稿的第三方服务，返回什么形状不由本仓说了算：
  // 「打不通」那条只覆盖了抛异常，成功返回一个不认识的形状同样不许把工具打挂。
  it.each([
    ["null", null],
    ["裸数组", []],
    ["servers 不是数组", { servers: "not-an-array" }],
  ])("注册表回了不认识的形状（%s）也不炸，退回 web_search 的话术", async (_name, body) => {
    const out = String(
      await mcpCatalogTool.run({ query: "绝无此物xyzzy" }, worldWith(async () => body))
    );
    expect(out).toContain("web_search");
  });

  it("注册表超时被 abort 也不炸，退回 web_search 的话术", async () => {
    const out = String(
      await mcpCatalogTool.run(
        { query: "绝无此物xyzzy" },
        worldWith(async () => {
          throw new DOMException("The operation was aborted", "AbortError");
        })
      )
    );
    expect(out).toContain("web_search");
  });
});
