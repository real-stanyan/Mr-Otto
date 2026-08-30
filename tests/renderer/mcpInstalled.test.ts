// 已装的那几台 → 卡片形状（issue #753）。
import { describe, it, expect } from "vitest";
import {
  entryFromInstalled,
  humanizeMcpError,
  filterInstalled,
  installedItems,
  installedSummary,
  splitInstalled,
} from "../../src/renderer/src/lib/mcpInstalled.js";
import type { McpServerStatus } from "../../src/shared/mcp.js";
import type { CuratedEntry } from "../../src/shared/mcpCatalog.js";

const catalog: CuratedEntry[] = [
  {
    id: "supabase",
    name: "Supabase",
    description: "查数据库结构、跑只读 SQL",
    category: "数据与分析",
    transport: "http",
    url: "https://mcp.supabase.com/mcp",
    params: [],
    auth: "oauth",
    authNote: "点一次授权",
    icon: "supabase",
  },
];

const server = (
  id: string,
  status: McpServerStatus["status"],
  cfg: McpServerStatus["config"]
): McpServerStatus => ({ id, config: cfg, status, tools: [], resources: [], prompts: [] });

const http = (url: string) => ({ kind: "http" as const, url, headers: {}, enabled: true });
const stdio = (command: string, args: string[]) => ({
  kind: "stdio" as const,
  command,
  args,
  env: {},
  enabled: true,
});

describe("installedSummary", () => {
  it("stdio 拼回一整行命令，http 给地址", () => {
    expect(installedSummary(stdio("npx", ["-y", "@a/b"]))).toBe("npx -y @a/b");
    expect(installedSummary(http("https://x/mcp"))).toBe("https://x/mcp");
  });

  it("空的也要说出来 —— 一张什么都没有的卡不告诉用户该去修什么", () => {
    expect(installedSummary(stdio("", []))).toBe("（没填命令）");
    expect(installedSummary(http(""))).toBe("（没填地址）");
  });
});

describe("entryFromInstalled", () => {
  it("目录里有的：保住 logo 和人话名字，但描述换成它自己的地址", () => {
    // 这一组回答的是"我装的是哪一台"，不是"这个产品是什么"
    const e = entryFromInstalled(server("supabase", "connected", http("https://x/mcp")), catalog);
    expect(e.name).toBe("Supabase");
    expect(e.icon).toBe("supabase");
    expect(e.description).toBe("https://x/mcp");
  });

  it("目录里没有的：现造一条，名字用 id，图标缺席（退成首字母色块）", () => {
    // 手填的、注册表装的都走这条。把它们藏起来比画得糙糟糕得多——
    // 那台就再也点不到了，用户连改配置的入口都找不到
    const e = entryFromInstalled(server("my-thing", "failed", stdio("uvx", ["x"])), catalog);
    expect(e.name).toBe("my-thing");
    expect(e.icon).toBeUndefined();
    expect(e.description).toBe("uvx x");
    expect(e.transport).toBe("stdio");
    expect(e.command).toBe("uvx");
  });
});

describe("installedItems / splitInstalled", () => {
  it("verified 仍然是「来路」的性质：目录里有的才算核过", () => {
    const items = installedItems(
      [
        server("supabase", "connected", http("https://x/mcp")),
        server("my-thing", "connected", http("https://y/mcp")),
      ],
      catalog
    );
    expect(items.map((i) => i.verified)).toEqual([true, false]);
  });

  it("连上的进「已接通」，其余一律进「待接通」", () => {
    // 一张写着「连不上」的卡挂在「已接通」标题下面是自相矛盾；
    // 而把它藏起来更糟——那台就再也点不到了
    const items = installedItems(
      [
        server("a", "connected", http("https://a/mcp")),
        server("b", "needs-auth", http("https://b/mcp")),
        server("c", "failed", http("https://c/mcp")),
      ],
      catalog
    );
    const { connected, pending } = splitInstalled(items);
    expect(connected.map((i) => i.entry.id)).toEqual(["a"]);
    expect(pending.map((i) => i.entry.id)).toEqual(["b", "c"]);
  });

  it("关掉的那台也在「待接通」里 —— 不是消失", () => {
    const items = installedItems(
      [server("z", "connected", { ...http("https://z/mcp"), enabled: false })],
      catalog
    );
    expect(splitInstalled(items).pending.map((i) => i.entry.id)).toEqual(["z"]);
  });
});

describe("filterInstalled", () => {
  it("跟着搜索框走 —— 搜 supabase 的时候已装的那台不能被搜掉", () => {
    const items = installedItems([server("supabase", "connected", http("https://x/mcp"))], catalog);
    expect(filterInstalled(items, "supa")).toHaveLength(1);
    expect(filterInstalled(items, "notion")).toHaveLength(0);
    expect(filterInstalled(items, "")).toHaveLength(1);
  });
});

describe("entryFromInstalled 说的是这一台此刻的样子", () => {
  it("地址取盘上那份，不取目录里的模板（#764）", () => {
    // 目录里 github 的 url 是 https://api.githubcopilot.com/mcp/；用户改过之后
    // 事实表还画着模板，等于给他看一台跟他的配置对不上的机器
    const e = entryFromInstalled({
      id: "github",
      config: { kind: "http", url: "https://ghe.corp.test/mcp", headers: {}, enabled: true },
    });
    expect(e.url).toBe("https://ghe.corp.test/mcp");
    expect(e.name).toBe("GitHub"); // 目录那份的 logo / 名字仍然留着
  });

  it("盘上改成了本地命令，就不该再挂着目录那条地址", () => {
    const e = entryFromInstalled({
      id: "github",
      config: { kind: "stdio", command: "npx", args: ["-y", "x"], env: {}, enabled: true },
    });
    expect(e.transport).toBe("stdio");
    expect(e.command).toBe("npx");
    expect(e.url, "两边字段并存的话事实表上会同时出现地址和命令").toBeUndefined();
  });
});

describe("humanizeMcpError", () => {
  it("认得出的翻成人话，并且说清该去改什么", () => {
    // SDK 抛的是 `MCP error -32000: Connection closed`——它把 MCP 这三个字母
    // 漏回了产品层（ADR-0178），而且没告诉用户该改什么：对着一条
    // `uvx nonexistent-thing` 的配置，真正的意思是"这个包不存在"
    const out = humanizeMcpError("MCP error -32000: Connection closed");
    expect(out).not.toContain("MCP");
    expect(out).toContain("命令");
    expect(humanizeMcpError("fetch failed")).toContain("连不上这个地址");
    expect(humanizeMcpError("spawn uvx ENOENT")).toContain("找不到这个命令");
  });

  it("授权那条路上的 DCR 那句也翻 —— 目录外的 server 也会撞（#760）", () => {
    // 目录里已知的三条走 catalog 的 blocked（那句更具体，还带 issue 号），
    // 这里覆盖的是手填的 / 注册表来的那些
    const out = humanizeMcpError(
      "Incompatible auth server: does not support dynamic client registration"
    );
    expect(out).toContain("client_id");
    expect(out).not.toContain("Incompatible");
    // 同族的另外两句（response type / code challenge method）也得有话说，
    // 不能只认死那一句
    expect(
      humanizeMcpError("Incompatible auth server: does not support response type code")
    ).toContain("授权方式");
  });

  it("认不出的原样保留 —— 一句看不懂的英文比一句自信的错误翻译有用", () => {
    expect(humanizeMcpError("weird upstream thing 12x")).toBe("weird upstream thing 12x");
  });
});
