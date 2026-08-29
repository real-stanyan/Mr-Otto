// 目录页的纯逻辑。名字里那个 Logic 是碰撞的解药——叫回 mcpDirectory.test.ts 的话，
// 它和同目录的 McpDirectory.test.tsx 在 macOS 上会被 tsc 当成同一个，那份 .tsx 被
// 静默丢出类型检查（issue #687，ADR-0173）。
import { describe, it, expect } from "vitest";
import {
  buildDirectory,
  configFromEntry,
  directoryTint,
  installPackageName,
  installSlot,
  installSourceLabel,
  needsInstallConfirm,
  uniqueServerId,
  type DirectoryItem,
} from "../../src/renderer/src/lib/mcpDirectory.js";
import type { McpDisplayStatus } from "../../src/renderer/src/lib/mcpForm.js";
import type { CatalogEntry } from "../../src/shared/mcpCatalog.js";
import { mapRegistryServer } from "../../src/shared/mcpRegistry.js";

const http = (id: string): CatalogEntry => ({
  id,
  name: id,
  description: `${id} 的说明`,
  transport: "http",
  url: `https://${id}.test/mcp`,
  params: [],
  auth: "none",
  authNote: "",
});

const stdio = (id: string): CatalogEntry => ({
  id,
  name: id,
  description: `${id} 的说明`,
  transport: "stdio",
  command: "npx",
  args: ["-y", id],
  params: [],
  auth: "none",
  authNote: "",
});

describe("buildDirectory", () => {
  it("空查询：精选全出，长尾为空", () => {
    const out = buildDirectory({
      query: "",
      curated: [http("a"), http("b")],
      registry: [http("z")],
      installed: [],
    });
    expect(out.curated.map((i) => i.entry.id)).toEqual(["a", "b"]);
    expect(out.longTail).toEqual([]);
  });

  it("精选项一律 verified，长尾项一律不 verified", () => {
    const out = buildDirectory({
      query: "a",
      curated: [http("a")],
      registry: [http("z")],
      installed: [],
    });
    expect(out.curated[0]!.verified).toBe(true);
    expect(out.longTail[0]!.verified).toBe(false);
  });

  it("已装的带着**状态**出来 —— 光有 id 会让「连上了」和「还没授权」长得一样", () => {
    const out = buildDirectory({
      query: "",
      curated: [http("a"), http("b"), http("c")],
      registry: [],
      installed: [
        { id: "b", status: "connected" },
        { id: "c", status: "needs-auth" },
      ],
    });
    expect(out.curated.map((i) => i.installed)).toEqual([null, "connected", "needs-auth"]);
  });

  it("长尾里跟精选撞 id 的剔掉 —— 同一台 server 不该出现两次", () => {
    const out = buildDirectory({
      query: "a",
      curated: [http("notion")],
      registry: [http("notion"), http("other")],
      installed: [],
    });
    expect(out.longTail.map((i) => i.entry.id)).toEqual(["other"]);
  });
});

describe("needsInstallConfirm", () => {
  it("长尾的 stdio 要确认 —— 会在本机跑陌生人发布的包", () => {
    expect(needsInstallConfirm({ entry: stdio("x"), verified: false, installed: null })).toBe(true);
  });

  it("精选的 stdio 不要 —— 已人工核过", () => {
    expect(needsInstallConfirm({ entry: stdio("x"), verified: true, installed: null })).toBe(false);
  });

  it("长尾的 http 不要 —— 代码跑在对方机器上，不在用户机器上", () => {
    expect(needsInstallConfirm({ entry: http("x"), verified: false, installed: null })).toBe(false);
  });
});

describe("uniqueServerId", () => {
  it("不撞名就用原名", () => {
    expect(uniqueServerId("notion", ["github"])).toBe("notion");
  });

  it("撞了补数字，一直补到不撞为止", () => {
    expect(uniqueServerId("notion", ["notion"])).toBe("notion-2");
    expect(uniqueServerId("notion", ["notion", "notion-2"])).toBe("notion-3");
  });

  it("空名字不返回空 —— 落盘的对象键不能是空串", () => {
    expect(uniqueServerId("   ", [])).not.toBe("");
  });
});

describe("configFromEntry", () => {
  it("http：值代进 url 的占位符", () => {
    const entry: CatalogEntry = {
      ...http("supabase"),
      url: "https://mcp.supabase.com/mcp?project_ref={project_ref}",
      params: [{ name: "project_ref", description: "", required: true }],
    };
    const cfg = configFromEntry(entry, { project_ref: "kpee" });
    expect(cfg).toEqual({
      kind: "http",
      url: "https://mcp.supabase.com/mcp?project_ref=kpee",
      headers: {},
      enabled: true,
    });
  });

  it("stdio：值代进 args 的占位符", () => {
    const entry: CatalogEntry = {
      ...stdio("filesystem"),
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "{root}"],
      params: [{ name: "root", description: "", required: true }],
    };
    const cfg = configFromEntry(entry, { root: "/Users/x" });
    expect(cfg).toEqual({
      kind: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/x"],
      env: {},
      enabled: true,
    });
  });

  // 注册表映射层（shared/mcpRegistry.ts）把 environmentVariables 折成 params，
  // 参数名就是环境变量名——这种 param 在 args 里没有占位符可代，值必须落到
  // env 里，不能因为"没找到占位符"就把用户刚填的凭据丢掉
  it("stdio：没有占位符可代的参数落进 env", () => {
    const entry: CatalogEntry = {
      ...stdio("weather"),
      params: [{ name: "API_KEY", description: "", required: true }],
    };
    const cfg = configFromEntry(entry, { API_KEY: "sk-1" });
    expect(cfg).toEqual({
      kind: "stdio",
      command: "npx",
      args: ["-y", "weather"],
      env: { API_KEY: "sk-1" },
      enabled: true,
    });
  });

  // 端到端钉住这一趟：注册表原始记录 → mapRegistryServer → configFromEntry。
  // 从前这里存的是 `smithery_api_key: <key>` —— 键名是问用户时用的**占位符**名，
  // 不是请求头名，`Bearer ` 前缀也没了。服务端 401，而用户看到的是一条指向
  // OAuth 的授权失败，凭据躺在 mcp.json 里一个毫无意义的键下面
  it("注册表的 secret header 走完一圈：键名是 Authorization，值带 Bearer 前缀", () => {
    const entry = mapRegistryServer({
      server: {
        name: "ai.smithery/smithery-notion",
        title: "Notion",
        remotes: [
          {
            type: "streamable-http",
            url: "https://server.smithery.ai/@smithery/notion/mcp",
            headers: [
              {
                name: "Authorization",
                value: "Bearer {smithery_api_key}",
                isRequired: true,
                isSecret: true,
              },
            ],
          },
        ],
      },
      _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true } },
    })!;
    // 表单上问的是占位符名（它才是有意义的标签）
    expect(entry.params.map((p) => p.name)).toEqual(["smithery_api_key"]);
    expect(configFromEntry(entry, { smithery_api_key: "sk-1" })).toEqual({
      kind: "http",
      url: "https://server.smithery.ai/@smithery/notion/mcp",
      headers: { Authorization: "Bearer sk-1" },
      enabled: true,
    });
  });

  it("http：没有模板可装的参数不落盘 —— 宁可缺一个头，也不写一个毫无意义的键", () => {
    const entry: CatalogEntry = {
      ...http("smithery"),
      params: [{ name: "smithery_api_key", description: "", required: true }],
    };
    const cfg = configFromEntry(entry, { smithery_api_key: "tok" });
    expect(cfg).toEqual({
      kind: "http",
      url: "https://smithery.test/mcp",
      headers: {},
      enabled: true,
    });
  });

  it("没填的参数不留一个装着 {占位符} 字面量的头", () => {
    const entry: CatalogEntry = {
      ...http("x"),
      params: [{ name: "tok", description: "", required: false }],
      headerTemplates: { Authorization: "Bearer {tok}" },
    };
    expect(configFromEntry(entry, {})).toEqual({
      kind: "http",
      url: "https://x.test/mcp",
      headers: {},
      enabled: true,
    });
  });

  it("空值不落盘 —— 没填的可选参数不该变成一个空环境变量", () => {
    const entry: CatalogEntry = {
      ...stdio("weather"),
      params: [{ name: "API_KEY", description: "", required: false }],
    };
    const cfg = configFromEntry(entry, { API_KEY: "" });
    expect(cfg.kind === "stdio" && cfg.env).toEqual({});
  });
});

describe("installSourceLabel / installPackageName", () => {
  it("npx 认成 npm，包名是 -y 后面那个", () => {
    const entry = stdio("weather");
    expect(installSourceLabel(entry)).toBe("npm");
    expect(installPackageName(entry)).toBe("weather");
  });

  it("uvx 认成 PyPI", () => {
    const entry: CatalogEntry = { ...stdio("git"), command: "uvx", args: ["mcp-server-git"] };
    expect(installSourceLabel(entry)).toBe("PyPI");
    expect(installPackageName(entry)).toBe("mcp-server-git");
  });

  it("认不出的运行时不冒充 npm", () => {
    const entry: CatalogEntry = { ...stdio("x"), command: "dnx", args: ["Some.Package"] };
    expect(installSourceLabel(entry)).toBe("包仓库");
    expect(installPackageName(entry)).toBe("Some.Package");
  });
});

describe("directoryTint", () => {
  it("同一个 id 每次都是同一个颜色 —— 卡片翻一屏回来不该换脸", () => {
    expect(directoryTint("notion")).toBe(directoryTint("notion"));
  });

  it("不同 id 落在同一个色板里", () => {
    const tints = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map(directoryTint));
    expect(tints.size).toBeGreaterThan(1);
  });
});

describe("installSlot", () => {
  const item = (installed: McpDisplayStatus | null): DirectoryItem => ({
    entry: http("x"),
    verified: true,
    installed,
  });

  it("没装画加号", () => {
    expect(installSlot(item(null), false)).toEqual({ kind: "add" });
  });

  it("装上且连上了才画勾", () => {
    expect(installSlot(item("connected"), false)).toEqual({ kind: "done" });
  });

  it("needs-auth 画的是「授权」不是勾 —— issue #722 的本体", () => {
    expect(installSlot(item("needs-auth"), false)).toEqual({ kind: "authorize" });
  });

  it("连不上 / 关掉的各说各的，不冒充完事", () => {
    expect(installSlot(item("failed"), false).kind).toBe("note");
    expect(installSlot(item("disabled"), false).kind).toBe("note");
  });

  it("busy 盖住一切 —— 授权在飞的那五分钟不能显示成已完成", () => {
    // saveMcpServer 一成功 installed 就有值了，而 authorizeMcpServer 还挂在
    // waitForCode 上（AUTH_TIMEOUT_MS = 5 分钟）。这段窗口必须是 busy
    expect(installSlot(item("connecting"), true)).toEqual({ kind: "busy" });
    expect(installSlot(item("connected"), true)).toEqual({ kind: "busy" });
  });
});
