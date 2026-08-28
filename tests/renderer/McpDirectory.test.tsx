// @vitest-environment jsdom
//
// 目录页组件的行为测试。纯逻辑（两层怎么分、要不要弹确认卡）在
// mcpDirectory.test.ts 里；这里测的是只有真渲染才成立的那几条：
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
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

/** 桥停在半路：每个 query 一个手动 resolve 的 promise，
    好在测试里决定"哪一次先回来" */
function deferredBridge() {
  const pending = new Map<string, (v: CatalogEntry[]) => void>();
  const searchMcpRegistry = vi.fn(
    (q: string) => new Promise<CatalogEntry[]>((resolve) => pending.set(q, resolve))
  );
  window.otter = { searchMcpRegistry } as unknown as ShellBridge;
  return { pending, searchMcpRegistry };
}

describe("McpDirectory", () => {
  it("不搜也能看见精选网格，而且一个字节都不打网", async () => {
    const { searchMcpRegistry } = deferredBridge();
    render(<McpDirectory installedIds={[]} />);

    expect(await screen.findByText("精选")).toBeInTheDocument();
    // MCP_CATALOG 里的字面量，随目录增删而变的是数量，不是这两条在不在
    expect(screen.getByText("Supabase")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getAllByText("已核验").length).toBeGreaterThan(0);
    // 长尾那条分隔线只在搜过之后出现
    expect(screen.queryByText("以下来自公开注册表，未经核验")).not.toBeInTheDocument();
    expect(searchMcpRegistry).not.toHaveBeenCalled();
  });

  it("已装的画 ✓，没装的画一个可点的加号", async () => {
    deferredBridge();
    render(<McpDirectory installedIds={["github"]} />);

    await screen.findByText("精选");
    expect(screen.getByText("GitHub 已经装上了")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "添加 GitHub" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加 Supabase" })).toBeInTheDocument();
  });

  it("搜到的注册表结果压在「未经核验」分隔线下面", async () => {
    const { pending } = deferredBridge();
    const user = userEvent.setup();
    render(<McpDirectory installedIds={[]} />);

    await user.type(screen.getByLabelText("搜索连接器"), "notion");
    await waitFor(() => expect(pending.has("notion")).toBe(true));
    pending.get("notion")!([remote("notion-wrap", "Notion 中间商")]);

    expect(await screen.findByText("Notion 中间商")).toBeInTheDocument();
    expect(screen.getByText("以下来自公开注册表，未经核验")).toBeInTheDocument();
  });

  // 这条钉的是 IPC 那头没有取消这回事：打了 notion 又改成 linear，notion 的
  // 响应后到也进不来。把组件里的编号判断删掉，这条立刻红
  it("慢的旧响应回来，不许盖掉新查询的结果", async () => {
    const { pending } = deferredBridge();
    const user = userEvent.setup();
    render(<McpDirectory installedIds={[]} />);

    const box = screen.getByLabelText("搜索连接器");
    await user.type(box, "notion");
    await waitFor(() => expect(pending.has("notion")).toBe(true));

    await user.clear(box);
    await user.type(box, "linear");
    await waitFor(() => expect(pending.has("linear")).toBe(true));

    // 新的先回来
    pending.get("linear")!([remote("linear-wrap", "Linear 中间商")]);
    expect(await screen.findByText("Linear 中间商")).toBeInTheDocument();

    // 旧的姗姗来迟
    pending.get("notion")!([remote("notion-wrap", "Notion 中间商")]);
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
    render(<McpDirectory installedIds={[]} />);

    await user.type(screen.getByLabelText("搜索连接器"), "notion");
    expect(await screen.findByText(/注册表搜不动：.*503/)).toBeInTheDocument();
  });

  it("长尾的 stdio 点加号先弹确认卡，说清会下载什么、在哪儿跑", async () => {
    const { pending } = deferredBridge();
    const user = userEvent.setup();
    render(<McpDirectory installedIds={[]} />);

    await user.type(screen.getByLabelText("搜索连接器"), "weather");
    await waitFor(() => expect(pending.has("weather")).toBe(true));
    pending.get("weather")!([local("weather", "Weather")]);

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
    render(<McpDirectory installedIds={[]} />);

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
    render(<McpDirectory installedIds={[]} />);

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
});
