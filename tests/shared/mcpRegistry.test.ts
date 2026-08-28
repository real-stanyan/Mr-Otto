import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  mapRegistryResponse,
  mapRegistryServer,
  registrySearchUrl,
} from "../../src/shared/mcpRegistry.js";

/** 一条 remote 形态的条目：带一把必填的 secret header */
const REMOTE_WITH_TOKEN = {
  server: {
    name: "ai.smithery/smithery-notion",
    title: "Notion",
    description: "A Notion workspace is a collaborative environment",
    version: "1.0.0",
    repository: { url: "https://github.com/smithery-ai/mcp-servers", source: "github" },
    remotes: [
      {
        type: "streamable-http",
        url: "https://server.smithery.ai/@smithery/notion/mcp",
        headers: [
          {
            name: "Authorization",
            value: "Bearer {smithery_api_key}",
            description: "Bearer token for Smithery authentication",
            isRequired: true,
            isSecret: true,
          },
        ],
      },
    ],
  },
  _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
};

/** 一条 remote 形态、无 header 的条目 */
const REMOTE_NO_AUTH = {
  server: {
    name: "com.example/plain",
    title: "Plain",
    description: "没有任何凭据要求",
    version: "2.0.0",
    remotes: [{ type: "streamable-http", url: "https://plain.example/mcp" }],
  },
  _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true } },
};

/** 一条 stdio 形态的条目 */
const STDIO_PKG = {
  server: {
    name: "com.mcparmory/notion",
    description: "Create, update, and manage pages",
    version: "1.0.1",
    packages: [
      {
        registryType: "pypi",
        identifier: "mcparmory-notion",
        version: "1.0.1",
        runtimeHint: "uvx",
        transport: { type: "stdio" },
        environmentVariables: [
          { name: "NOTION_TOKEN", description: "Notion integration token", isRequired: true, isSecret: true },
          { name: "NOTION_LOCALE", description: "可选语言", isRequired: false },
        ],
      },
    ],
  },
  _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true } },
};

/** 同一个 name 的旧版本 —— isLatest: false，必须被丢掉 */
const STALE_VERSION = {
  server: {
    name: "com.example/plain",
    title: "Plain（旧版）",
    description: "旧版本",
    version: "1.0.0",
    remotes: [{ type: "streamable-http", url: "https://plain.example/old" }],
  },
  _meta: { "io.modelcontextprotocol.registry/official": { isLatest: false } },
};

/** 既没有 remotes 也没有 packages —— 装不了，必须被丢掉 */
const UNINSTALLABLE = {
  server: { name: "com.example/nothing", description: "空条目", version: "1.0.0" },
  _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true } },
};

function wrap(...records: unknown[]) {
  return { servers: records, metadata: { count: records.length } };
}

describe("registrySearchUrl", () => {
  it("查询词做 URL 编码，带上 limit", () => {
    const url = registrySearchUrl("hello world", 50);
    expect(url).toBe(
      "https://registry.modelcontextprotocol.io/v0/servers?search=hello+world&limit=50"
    );
  });

  it("limit 缺省是 50", () => {
    expect(registrySearchUrl("x")).toContain("limit=50");
  });
});

describe("mapRegistryServer —— remote 形态", () => {
  it("streamable-http 映成 http 传输，url 原样带过来", () => {
    const e = mapRegistryServer(REMOTE_WITH_TOKEN)!;
    expect(e.transport).toBe("http");
    expect(e.url).toBe("https://server.smithery.ai/@smithery/notion/mcp");
  });

  it("id 取 name 的末段做 slug —— 点和斜杠都不是合法 server id", () => {
    expect(mapRegistryServer(REMOTE_WITH_TOKEN)!.id).toBe("smithery-notion");
  });

  it("没有 title 就退回 name 的末段当显示名", () => {
    expect(mapRegistryServer(STDIO_PKG)!.name).toBe("notion");
  });

  it("必填的 header 变成 param，取模板占位符的名字", () => {
    const e = mapRegistryServer(REMOTE_WITH_TOKEN)!;
    expect(e.params).toEqual([
      {
        name: "smithery_api_key",
        description: "Bearer token for Smithery authentication",
        required: true,
      },
    ]);
  });

  it("有 secret 凭据 = auth token", () => {
    expect(mapRegistryServer(REMOTE_WITH_TOKEN)!.auth).toBe("token");
  });

  it("没有任何凭据要求 = auth none，不猜 oauth", () => {
    const e = mapRegistryServer(REMOTE_NO_AUTH)!;
    expect(e.auth).toBe("none");
    expect(e.params).toEqual([]);
  });

  it("authNote 兜底说清楚来路", () => {
    expect(mapRegistryServer(REMOTE_NO_AUTH)!.authNote).toBe(
      "这台 server 来自公开注册表，配置未经核验"
    );
  });
});

describe("mapRegistryServer —— stdio 形态", () => {
  it("runtimeHint + identifier 映成 command / args", () => {
    const e = mapRegistryServer(STDIO_PKG)!;
    expect(e.transport).toBe("stdio");
    expect(e.command).toBe("uvx");
    expect(e.args).toEqual(["mcparmory-notion"]);
  });

  it("必填的环境变量变成 param，可选的不进", () => {
    expect(mapRegistryServer(STDIO_PKG)!.params).toEqual([
      { name: "NOTION_TOKEN", description: "Notion integration token", required: true },
    ]);
  });

  it("npm 包的 runtimeHint 缺席时退回 npx -y", () => {
    const npmPkg = {
      server: {
        name: "com.example/thing",
        description: "npm 包",
        version: "1.0.0",
        packages: [
          { registryType: "npm", identifier: "@example/thing", version: "1.0.0", transport: { type: "stdio" } },
        ],
      },
      _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true } },
    };
    const e = mapRegistryServer(npmPkg)!;
    expect(e.command).toBe("npx");
    expect(e.args).toEqual(["-y", "@example/thing"]);
  });
});

describe("mapRegistryServer —— 丢弃的情况", () => {
  it("isLatest 不为 true 的丢掉", () => {
    expect(mapRegistryServer(STALE_VERSION)).toBeNull();
  });

  it("既无 remotes 也无 packages 的丢掉 —— 装不了", () => {
    expect(mapRegistryServer(UNINSTALLABLE)).toBeNull();
  });

  it("形状不对的丢掉，不抛", () => {
    expect(mapRegistryServer(null)).toBeNull();
    expect(mapRegistryServer({})).toBeNull();
    expect(mapRegistryServer({ server: "字符串" })).toBeNull();
  });
});

describe("mapRegistryResponse", () => {
  it("过滤 + 映射一整页", () => {
    const out = mapRegistryResponse(wrap(REMOTE_WITH_TOKEN, STALE_VERSION, UNINSTALLABLE, STDIO_PKG));
    expect(out.map((e) => e.id)).toEqual(["smithery-notion", "notion"]);
  });

  it("同一个 name 出现两次只留第一条", () => {
    const dup = { ...REMOTE_NO_AUTH };
    const out = mapRegistryResponse(wrap(REMOTE_NO_AUTH, dup));
    expect(out).toHaveLength(1);
  });

  it("id 撞了就补数字后缀 —— 不同 name 可能 slug 成同一个 id", () => {
    const a = { ...REMOTE_NO_AUTH, server: { ...REMOTE_NO_AUTH.server, name: "com.a/plain" } };
    const b = { ...REMOTE_NO_AUTH, server: { ...REMOTE_NO_AUTH.server, name: "com.b/plain" } };
    expect(mapRegistryResponse(wrap(a, b)).map((e) => e.id)).toEqual(["plain", "plain-2"]);
  });

  it("整体形状不对返回空数组，不抛", () => {
    expect(mapRegistryResponse(null)).toEqual([]);
    expect(mapRegistryResponse({ servers: "不是数组" })).toEqual([]);
  });
});

describe("真实响应样本", () => {
  // 只断言"不炸 + 映得出东西"。真数据会变，行为断言全在上面的内联 JSON 里
  it("喂一份真抓下来的响应不抛，且至少映出一条", () => {
    const raw = JSON.parse(
      readFileSync(join(__dirname, "..", "fixtures", "mcpRegistry.sample.json"), "utf8")
    );
    const out = mapRegistryResponse(raw);
    expect(out.length).toBeGreaterThan(0);
    for (const e of out) {
      expect(e.id).not.toBe("");
      if (e.transport === "http") expect(e.url).toBeTruthy();
      else expect(e.command).toBeTruthy();
    }
  });
});
