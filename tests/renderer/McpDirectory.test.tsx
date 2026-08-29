// @vitest-environment jsdom
//
// 目录页组件的行为测试。纯逻辑（两层怎么分、要不要弹确认卡）在
// mcpDirectoryLogic.test.ts 里——名字里那个 Logic 不是修饰语，是碰撞的解药：
// 叫回 mcpDirectory.test.ts 的话，它和本文件在 macOS 上会被 tsc 当成同一个，
// 本文件被静默丢出类型检查（issue #687，ADR-0173）。这里测的是只有真渲染才
// 成立的那几条：
//
// ① 不搜也能看见精选网格，且**不打网**——首屏零网络是这个功能的设计前提
// ② 慢的旧响应不许盖掉新结果。这条不是想象出来的边角：searchMcpRegistry 走
//    ipcRenderer.invoke，AbortSignal 过不了 IPC，所以"取消上一次查询"根本不
//    存在——组件端的编号判断是唯一一道闸，删掉它这条用例就红
// ③ 搜不动显示原因，不吞成"没有结果"
//
// 同 McpSettings.test.tsx：McpDirectory 只认 useChat，而 store 的方法直接读
// window.otter，所以"造一份最小桥"就是往 window.otter 上钉一份最小实现。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { McpDirectory } from "../../src/renderer/src/components/McpDirectory.js";
import type { ShellBridge } from "../../src/shared/shellBridge.js";
import type { CatalogEntry } from "../../src/shared/mcpCatalog.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const remote = (id: string, name: string): CatalogEntry => ({
  id,
  name,
  description: `${name} 的说明`,
  transport: "http",
  url: `https://${id}.test/mcp`,
  params: [],
  auth: "none",
  authNote: "",
});

const local = (id: string, name: string): CatalogEntry => ({
  id,
  name,
  description: `${name} 的说明`,
  transport: "stdio",
  command: "npx",
  args: ["-y", `@someone/${id}`],
  params: [],
  auth: "none",
  authNote: "",
});

/** 桥停在半路：每个 query 一个手动 resolve / reject 的 promise，
    好在测试里决定"哪一次先回来、哪一次是失败的"。
    写操作给的是真 spy 而不是留空——留空的话组件调它会抛 TypeError，被
    installError 吞掉，于是"该不该落盘"这件事在测试里完全不可观测 */
function deferredBridge() {
  const pending = new Map<
    string,
    { resolve: (v: CatalogEntry[]) => void; reject: (e: Error) => void }
  >();
  const searchMcpRegistry = vi.fn(
    (q: string) =>
      new Promise<CatalogEntry[]>((resolve, reject) => pending.set(q, { resolve, reject }))
  );
  // 参数照 ShellBridge 的真签名写出来（值用不上，名字前缀下划线）：vi.fn(() => …) 的
  // mock.calls 是 [][]，下面那条按下标取实参的断言在 tuple 上就没有第 0 位可取。
  const saveMcpServer = vi.fn((_id: string, _cfg: unknown) =>
    Promise.resolve({ servers: [], errors: [] })
  );
  const authorizeMcpServer = vi.fn((_id: string) => Promise.resolve({ servers: [], errors: [] }));
  window.otter = { searchMcpRegistry, saveMcpServer, authorizeMcpServer } as unknown as ShellBridge;
  return { pending, searchMcpRegistry, saveMcpServer, authorizeMcpServer };
}

describe("McpDirectory", () => {
  it("不搜也能看见精选网格，而且一个字节都不打网", async () => {
    const { searchMcpRegistry } = deferredBridge();
    render(<McpDirectory installed={[]} />);

    // 不搜时按分类分段（#725 把目录扩到八十多条，平铺是一堵墙）
    expect(await screen.findByText("开发与部署")).toBeInTheDocument();
    expect(screen.getByText("国内平台")).toBeInTheDocument();
    // MCP_CATALOG 里的字面量，随目录增删而变的是数量，不是这两条在不在
    expect(screen.getByText("Supabase")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getAllByText("已核验").length).toBeGreaterThan(0);
    // 「精选」这个标题只在搜索时出现——它是跟长尾那块的对照，不搜时长尾
    // 根本不在，一个没有对照物的来路标记只是又一行字（来路由每张卡的
    // 「已核验」角标承担，上面刚断言过）
    expect(screen.queryByText("精选")).not.toBeInTheDocument();
    // 长尾那条分隔线只在搜过之后出现
    expect(screen.queryByText("以下来自公开注册表，未经核验")).not.toBeInTheDocument();
    expect(searchMcpRegistry).not.toHaveBeenCalled();
  });

  it("一搜就换回平铺，「精选」标题这时才出现——它是跟长尾那块的对照", async () => {
    deferredBridge();
    render(<McpDirectory installed={[]} />);
    await screen.findByText("开发与部署");

    await userEvent.setup().type(screen.getByLabelText("搜索连接器"), "supabase");

    expect(await screen.findByText("精选")).toBeInTheDocument();
    expect(screen.getByText("Supabase")).toBeInTheDocument();
    // 分组标题让位给平铺：结果本来就少，再切成七段反而更难扫
    expect(screen.queryByText("国内平台")).not.toBeInTheDocument();
  });

  it("装上且连上了才画 ✓，没装的画一个可点的加号", async () => {
    deferredBridge();
    render(<McpDirectory installed={[{ id: "github", status: "connected" }]} />);

    await screen.findByText("开发与部署");
    expect(screen.getByText("GitHub 已经装上了")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "添加 GitHub" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加 Supabase" })).toBeInTheDocument();
  });

  it("装上了但还没授权：不画 ✓，画一颗能点的「授权」", async () => {
    // issue #722：装 Canva 时把浏览器关了，配置落了盘、授权没成，卡片照样画勾。
    // "配置里有这个 id"和"这台能用了"不是一回事
    deferredBridge();
    render(<McpDirectory installed={[{ id: "canva", status: "needs-auth" }]} />);

    await screen.findByText("开发与部署");
    expect(screen.queryByText("Canva 已经装上了")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "授权 Canva" })).toBeInTheDocument();
  });

  it("点卡片上的「授权」直接跑授权，不用先找到下面那一行", async () => {
    const { authorizeMcpServer } = deferredBridge();
    render(<McpDirectory installed={[{ id: "canva", status: "needs-auth" }]} />);

    await screen.findByText("开发与部署");
    await userEvent.setup().click(screen.getByRole("button", { name: "授权 Canva" }));
    expect(authorizeMcpServer).toHaveBeenCalledWith("canva");
  });

  it("搜到的注册表结果压在「未经核验」分隔线下面", async () => {
    const { pending } = deferredBridge();
    const user = userEvent.setup();
    render(<McpDirectory installed={[]} />);

    await user.type(screen.getByLabelText("搜索连接器"), "notion");
    await waitFor(() => expect(pending.has("notion")).toBe(true));
    pending.get("notion")!.resolve([remote("notion-wrap", "Notion 中间商")]);

    expect(await screen.findByText("Notion 中间商")).toBeInTheDocument();
    expect(screen.getByText("以下来自公开注册表，未经核验")).toBeInTheDocument();
  });

  // 这条钉的是 IPC 那头没有取消这回事：打了 notion 又改成 linear，notion 的
  // 响应后到也进不来。把组件里的编号判断删掉，这条立刻红
  it("慢的旧响应回来，不许盖掉新查询的结果", async () => {
    const { pending } = deferredBridge();
    const user = userEvent.setup();
    render(<McpDirectory installed={[]} />);

    const box = screen.getByLabelText("搜索连接器");
    await user.type(box, "notion");
    await waitFor(() => expect(pending.has("notion")).toBe(true));

    await user.clear(box);
    await user.type(box, "linear");
    await waitFor(() => expect(pending.has("linear")).toBe(true));

    // 新的先回来
    pending.get("linear")!.resolve([remote("linear-wrap", "Linear 中间商")]);
    expect(await screen.findByText("Linear 中间商")).toBeInTheDocument();

    // 旧的姗姗来迟
    pending.get("notion")!.resolve([remote("notion-wrap", "Notion 中间商")]);
    await waitFor(() => {
      expect(screen.getByText("Linear 中间商")).toBeInTheDocument();
    });
    expect(screen.queryByText("Notion 中间商")).not.toBeInTheDocument();
  });

  it("搜不动就说搜不动，不吞成「没有结果」", async () => {
    window.otter = {
      searchMcpRegistry: vi.fn(() => Promise.reject(new Error("注册表返回 HTTP 503"))),
    } as unknown as ShellBridge;
    const user = userEvent.setup();
    render(<McpDirectory installed={[]} />);

    await user.type(screen.getByLabelText("搜索连接器"), "notion");
    expect(await screen.findByText(/注册表搜不动：.*503/)).toBeInTheDocument();
  });

  // 竞态的另一半：失败那条路上的编号判断。删掉它，一个迟到的**失败**会把
  // 已经显示出来的新结果换成「注册表搜不动」——用户看到的是"这台 server 不
  // 存在"，而它明明就在屏幕上待过
  it("慢的旧请求最后报错，不许把新结果换成「搜不动」", async () => {
    const { pending } = deferredBridge();
    const user = userEvent.setup();
    render(<McpDirectory installed={[]} />);

    const box = screen.getByLabelText("搜索连接器");
    await user.type(box, "notion");
    await waitFor(() => expect(pending.has("notion")).toBe(true));
    await user.clear(box);
    await user.type(box, "linear");
    await waitFor(() => expect(pending.has("linear")).toBe(true));

    pending.get("linear")!.resolve([remote("linear-wrap", "Linear 中间商")]);
    expect(await screen.findByText("Linear 中间商")).toBeInTheDocument();

    // 旧的那次失败姗姗来迟。act + 一次宏任务：让 catch 分支和它可能触发的
    // setState 都真的跑完，再断言——不然这条用例会在"什么都还没发生"时通过
    await act(async () => {
      pending.get("notion")!.reject(new Error("注册表返回 HTTP 503"));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByText("Linear 中间商")).toBeInTheDocument();
    expect(screen.queryByText(/注册表搜不动/)).not.toBeInTheDocument();
  });

  // finally 里那句 setSearching 也得判编号：旧的一次回来就把"搜索中…"关掉，
  // 界面会在新请求还在路上的时候说"没有匹配的 server"
  it("慢的旧请求先回来，不许把「搜索中…」提前关掉", async () => {
    const { pending } = deferredBridge();
    const user = userEvent.setup();
    render(<McpDirectory installed={[]} />);

    const box = screen.getByLabelText("搜索连接器");
    await user.type(box, "notion");
    await waitFor(() => expect(pending.has("notion")).toBe(true));
    await user.clear(box);
    await user.type(box, "linear");
    await waitFor(() => expect(pending.has("linear")).toBe(true));

    await act(async () => {
      pending.get("notion")!.resolve([]);
      await new Promise((r) => setTimeout(r, 0));
    });
    // linear 还在路上
    expect(screen.getByText("搜索中…")).toBeInTheDocument();
    expect(screen.queryByText("注册表里没有匹配的 server")).not.toBeInTheDocument();
  });

  it("长尾的 stdio 点加号先弹确认卡，说清会下载什么、在哪儿跑", async () => {
    const { pending } = deferredBridge();
    const user = userEvent.setup();
    render(<McpDirectory installed={[]} />);

    await user.type(screen.getByLabelText("搜索连接器"), "weather");
    await waitFor(() => expect(pending.has("weather")).toBe(true));
    pending.get("weather")!.resolve([local("weather", "Weather")]);

    await user.click(await screen.findByRole("button", { name: "添加 Weather" }));
    expect(
      await screen.findByText(
        "这会从 npm 下载 @someone/weather 并在你的电脑上运行它。这台 server 来自公开注册表，未经核验。"
      )
    ).toBeInTheDocument();
    // 命令全文摆出来，让用户看得见到底要跑什么
    expect(screen.getByText("npx -y @someone/weather")).toBeInTheDocument();
  });

  it("精选的 http 直接落盘，落盘之后拉一次授权", async () => {
    const saveMcpServer = vi.fn(() => Promise.resolve({ servers: [], errors: [] }));
    const authorizeMcpServer = vi.fn(() => Promise.resolve({ servers: [], errors: [] }));
    window.otter = {
      searchMcpRegistry: vi.fn(() => Promise.resolve([])),
      saveMcpServer,
      authorizeMcpServer,
    } as unknown as ShellBridge;
    const user = userEvent.setup();
    render(<McpDirectory installed={[]} />);

    await user.click(await screen.findByRole("button", { name: "添加 GitHub" }));
    await waitFor(() => {
      expect(saveMcpServer).toHaveBeenCalledWith("github", {
        kind: "http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: {},
        enabled: true,
      });
    });
    await waitFor(() => expect(authorizeMcpServer).toHaveBeenCalledWith("github"));
  });

  it("带参数的条目先问参数，值代进 URL 的占位符", async () => {
    const saveMcpServer = vi.fn(() => Promise.resolve({ servers: [], errors: [] }));
    window.otter = {
      searchMcpRegistry: vi.fn(() => Promise.resolve([])),
      saveMcpServer,
      authorizeMcpServer: vi.fn(() => Promise.resolve({ servers: [], errors: [] })),
    } as unknown as ShellBridge;
    const user = userEvent.setup();
    render(<McpDirectory installed={[]} />);

    await user.click(await screen.findByRole("button", { name: "添加 Supabase" }));
    await user.type(await screen.findByLabelText("project_ref"), "kpee");
    await user.click(screen.getByRole("button", { name: "装上" }));

    await waitFor(() => {
      expect(saveMcpServer).toHaveBeenCalledWith("supabase", {
        kind: "http",
        url: "https://mcp.supabase.com/mcp?project_ref=kpee&features=database%2Cdocs",
        headers: {},
        enabled: true,
      });
    });
  });

  // 确认卡存在的理由就是这一条：点加号那一下**什么都不该落盘**。
  // 只断言"弹出来了"是不够的——在 setConfirming 旁边补一句 install()，卡照弹、
  // 包照装，断言全绿
  it("长尾 stdio：确认卡点掉之前一个字节都不落盘，点了「知道了，装上」才落", async () => {
    const { pending, saveMcpServer } = deferredBridge();
    const user = userEvent.setup();
    render(<McpDirectory installed={[]} />);

    await user.type(screen.getByLabelText("搜索连接器"), "weather");
    await waitFor(() => expect(pending.has("weather")).toBe(true));
    pending.get("weather")!.resolve([local("weather", "Weather")]);

    await user.click(await screen.findByRole("button", { name: "添加 Weather" }));
    await screen.findByText(/并在你的电脑上运行它/);
    expect(saveMcpServer).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "知道了，装上" }));
    await waitFor(() => expect(saveMcpServer).toHaveBeenCalledTimes(1));
    expect(saveMcpServer.mock.calls[0]![0]).toBe("weather");
  });

  // 授权会按对方 server 自己给的 OAuth 元数据开系统浏览器。精选层是人工核过的
  // （自动拉授权正是精选层的价值），长尾层不是——在一个开放投稿的注册表里点
  // 一下卡片，浏览器不该就被带去一个陌生人指定的地址
  it("未核验的 http：装上但不自动拉授权，改成告诉用户自己点", async () => {
    const { pending, saveMcpServer, authorizeMcpServer } = deferredBridge();
    const user = userEvent.setup();
    render(<McpDirectory installed={[]} />);

    await user.type(screen.getByLabelText("搜索连接器"), "weather");
    await waitFor(() => expect(pending.has("weather")).toBe(true));
    pending.get("weather")!.resolve([remote("weather-remote", "Weather Remote")]);

    await user.click(await screen.findByRole("button", { name: "添加 Weather Remote" }));
    await waitFor(() => expect(saveMcpServer).toHaveBeenCalledTimes(1));
    expect(authorizeMcpServer).not.toHaveBeenCalled();
    expect(await screen.findByText(/没有自动拉授权/)).toBeInTheDocument();
  });

  // 分隔线滚出视口之后，"这张是不是核过的"只能靠卡片自己说
  it("长尾卡自己带「未核验」记号，不靠分隔线", async () => {
    const { pending } = deferredBridge();
    const user = userEvent.setup();
    render(<McpDirectory installed={[]} />);

    await user.type(screen.getByLabelText("搜索连接器"), "weather");
    await waitFor(() => expect(pending.has("weather")).toBe(true));
    pending.get("weather")!.resolve([remote("weather-remote", "Weather Remote")]);

    expect(await screen.findByText("未核验")).toBeInTheDocument();
  });

  // ── 详情页（issue #745）─────────────────────────────────────────────
  it("点卡片进详情页：卡片上截断的东西这儿要看得全", async () => {
    deferredBridge();
    render(<McpDirectory installed={[]} />);
    await screen.findByText("开发与部署");

    await userEvent.setup().click(screen.getByRole("button", { name: "Supabase 详情" }));

    // 地址是卡片上根本没有的那一项 —— 用户点进来主要就为了这个
    expect(await screen.findByText(/mcp\.supabase\.com/)).toBeInTheDocument();
    expect(screen.getByText(/代码跑在对方的机器上/)).toBeInTheDocument();
    expect(screen.getByText("project_ref")).toBeInTheDocument();
    // 换页而不是叠加：网格让位了
    expect(screen.queryByText("国内平台")).not.toBeInTheDocument();
  });

  it("详情页上点「添加」照样弹参数框 —— 对话框不能只挂在网格那一支", async () => {
    // 差点这样出门：filling 状态设了，而 ParamsDialog 只渲染在网格分支里，
    // 于是详情页上按钮点下去一声不响
    deferredBridge();
    render(<McpDirectory installed={[]} />);
    await screen.findByText("开发与部署");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Supabase 详情" }));
    await user.click(screen.getByRole("button", { name: "添加 Supabase" }));

    expect(await screen.findByText("配置「Supabase」")).toBeInTheDocument();
  });

  it("卡片右边那颗加号不把人带进详情页", async () => {
    // 一颗按钮套在一张可点的卡里：不拦冒泡的话，点「添加」会顺手换页，
    // 用户看着一个陌生的页面，不知道自己刚才装没装上
    const { saveMcpServer } = deferredBridge();
    render(<McpDirectory installed={[]} />);
    await screen.findByText("开发与部署");

    await userEvent.setup().click(screen.getByRole("button", { name: "添加 Sentry" }));

    expect(saveMcpServer).toHaveBeenCalled();
    // 还在网格上（分组标题还在），没被带进详情页
    expect(screen.getByText("开发与部署")).toBeInTheDocument();
  });

  it("返回回到网格", async () => {
    deferredBridge();
    render(<McpDirectory installed={[]} />);
    await screen.findByText("开发与部署");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Supabase 详情" }));
    await screen.findByText("来路");
    await user.click(screen.getByRole("button", { name: "连接器" }));

    expect(await screen.findByText("开发与部署")).toBeInTheDocument();
    expect(screen.queryByText("来路")).not.toBeInTheDocument();
  });

  it("已装的那台，详情页要说它给了哪些工具", async () => {
    deferredBridge();
    render(
      <McpDirectory
        installed={[{ id: "sentry", status: "connected", tools: ["find_issues", "get_trace"] }]}
      />
    );
    await screen.findByText("开发与部署");

    await userEvent.setup().click(screen.getByRole("button", { name: "Sentry 详情" }));

    expect(await screen.findByText(/2 个工具/)).toBeInTheDocument();
    expect(screen.getByText("find_issues")).toBeInTheDocument();
  });

  it("纯黑那批标自带 display —— 不能靠父级恰好是 flex（#747）", async () => {
    // 症状很刁：目录卡上好好的（卡片外层是 flex，span 被 blockify 了），
    // 详情页里包进一个普通 span 就整个消失——宽高对 inline 元素不生效，
    // 而这一档的尺寸只有宽高。不报错，就是没有标
    deferredBridge();
    render(<McpDirectory installed={[]} />);
    await screen.findByText("开发与部署");

    await userEvent.setup().click(screen.getByRole("button", { name: "Sentry 详情" }));

    const icon = await screen.findByTestId("mcp-icon-mono");
    expect(icon.className.split(/\s+/)).toContain("block");
    expect(icon).toHaveStyle({ width: "40px", height: "40px" });
  });

  it("装了但没连上：不说「这台没有暴露任何工具」，也不列空清单", async () => {
    deferredBridge();
    render(<McpDirectory installed={[{ id: "sentry", status: "needs-auth", tools: [] }]} />);
    await screen.findByText("开发与部署");

    await userEvent.setup().click(screen.getByRole("button", { name: "Sentry 详情" }));

    expect(await screen.findByText(/授权之后才知道/)).toBeInTheDocument();
    expect(screen.queryByText(/没有暴露任何工具/)).not.toBeInTheDocument();
  });
});
