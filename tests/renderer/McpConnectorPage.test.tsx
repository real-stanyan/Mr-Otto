// @vitest-environment jsdom
//
// 详情页那一屏（issue #745 / ADR-0185）。这份文件存在的直接理由是 #766：
// blocked 的 UI 覆盖原来挂在「目录里的 GitHub 是 blocked 的」这个事实上，
// 而 GitHub 一改走 token，四条用例一起红——测的东西没变，只是它借来的那个
// 支点被抽走了。拿**合成条目**直接渲染这一页，判据就不再随目录内容漂移。
//
// 覆盖的两件事都是今天各自漏过一次的接缝：
// ① 横幅（#760 —— 判据加了，但只接了 installSlot 一个渲染点）
// ② 管理面里那颗授权按钮和那条错误红字（#764 —— 同一个判据没接第二处）
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { McpConnectorPage } from "../../src/renderer/src/components/McpConnectorPage.js";
import type { DirectoryItem } from "../../src/renderer/src/lib/mcpDirectory.js";
import type { CatalogEntry } from "../../src/shared/mcpCatalog.js";
import type { McpServerStatus } from "../../src/shared/mcp.js";
import type { ShellBridge } from "../../src/shared/shellBridge.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id: "acme",
  name: "Acme",
  description: "干点什么",
  category: "开发与部署",
  transport: "http",
  url: "https://acme.test/mcp",
  params: [],
  auth: "oauth",
  authNote: "配好后点一次授权",
  ...over,
});

const item = (over: Partial<DirectoryItem> = {}): DirectoryItem => ({
  entry: entry(),
  verified: true,
  installed: null,
  ...over,
});

const installed = (status: McpServerStatus["status"], error?: string): McpServerStatus => ({
  id: "acme",
  config: { kind: "http", url: "https://acme.test/mcp", headers: {}, enabled: true },
  status,
  tools: [],
  resources: [],
  prompts: [],
  ...(error === undefined ? {} : { error }),
});

function draw(it: DirectoryItem, server?: McpServerStatus) {
  window.otter = {
    saveMcpServer: vi.fn(() => Promise.resolve({ servers: [], errors: [] })),
    removeMcpServer: vi.fn(() => Promise.resolve({ servers: [], errors: [] })),
    reconnectMcpServer: vi.fn(() => Promise.resolve({ servers: [], errors: [] })),
    authorizeMcpServer: vi.fn(() => Promise.resolve({ servers: [], errors: [] })),
  } as unknown as ShellBridge;
  return render(
    <McpConnectorPage
      item={it}
      server={server}
      busy={false}
      icon={<span />}
      onBack={vi.fn()}
      onAdd={vi.fn()}
      onAuthorize={vi.fn()}
    />
  );
}

describe("McpConnectorPage", () => {
  it("没标 blocked 的：该有的动作都在", () => {
    draw(item());
    expect(screen.getByRole("button", { name: "添加 Acme" })).toBeInTheDocument();
    expect(screen.getByText("配好后点一次授权")).toBeInTheDocument();
  });

  it("blocked：不发「添加」，原因画出来而不是挂 tooltip（#760）", () => {
    const why = "对方的授权服务器不支持动态注册——这台暂时接不上";
    draw(item({ entry: entry({ blocked: why }) }));

    expect(screen.queryByRole("button", { name: "添加 Acme" })).not.toBeInTheDocument();
    expect(screen.getByText(why)).toBeInTheDocument();
    // 「授权 · 配好后点一次授权」那一行不能跟横幅同屏——两句话在打架
    expect(screen.queryByText("配好后点一次授权")).not.toBeInTheDocument();
  });

  it("blocked 且已装：管理面里那颗「授权」和那条红字也得没（#764）", () => {
    const why = "对方的授权服务器不支持动态注册——这台暂时接不上";
    draw(
      item({ entry: entry({ blocked: why }), installed: "needs-auth" }),
      installed("needs-auth", "MCP error -32000: HTTP 401 Unauthorized")
    );

    // 一颗都不该有：#760 只挡住了头部那一格，管理面里那颗活了下来
    expect(screen.queryAllByRole("button", { name: /授权/ })).toHaveLength(0);
    // 「凭据不对」会把用户支去检查 token，而那不是问题所在
    expect(screen.queryByText(/对方拒绝了这次请求/)).not.toBeInTheDocument();
    // 证据不丢：原话挪进了横幅的 title
    expect(screen.getByText(why)).toHaveAttribute("title", expect.stringContaining("401"));
    // 管理面本身还在——删掉那台的入口不能跟着一起没
    expect(screen.getByRole("button", { name: /删除/ })).toBeInTheDocument();
  });

  it("真连上了以现实为准 —— blocked 是上次实测的结论，可能过期", () => {
    const why = "对方的授权服务器不支持动态注册——这台暂时接不上";
    draw(item({ entry: entry({ blocked: why }), installed: "connected" }), installed("connected"));
    expect(screen.queryByText(why)).not.toBeInTheDocument();
    expect(screen.getByText("已连接")).toBeInTheDocument();
  });
});
