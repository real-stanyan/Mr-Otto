// @vitest-environment jsdom
//
// 组件渲染测试(本仓第一份——之前 tests/renderer/ 下的 mcpForm.test.ts /
// mcpPromptMenu.test.ts / mcpPromptSubmit.test.ts 都只测纯函数,没有真的
// render 过一个组件)。McpSettings 不接受 `bridge` prop——它跟 SubagentSettings
// 一样,只认 `useChat` 这个 Zustand store,而 store 的每个方法内部直接读
// `window.otter`(见 src/renderer/src/store.ts 的 saveMcpServer/reconnectMcpServer
// 等实现)。所以这里的"造一份最小桥"就是往 window.otter 上钉一份最小实现——
// 这是全局注入,不是发明一个组件本来没有的 prop。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { McpSettings } from "../../src/renderer/src/components/McpSettings.js";
import { SidebarProvider } from "../../src/renderer/src/components/ui/sidebar.js";
import type { ShellBridge } from "../../src/shared/shellBridge.js";
import type { McpServersSnapshot } from "../../src/shared/mcp.js";

// McpSettings 顶部挂了 <SidebarNub />,它读 useSidebar() 的 context——同真实
// app 里所有设置页一样(App.tsx 用 <SidebarProvider> 包着挂载),不是这个
// 组件测试该关心的东西,只是渲染的必要前提
function renderMcpSettings() {
  return render(
    <SidebarProvider>
      <McpSettings />
    </SidebarProvider>
  );
}

afterEach(() => {
  cleanup();
});

function stubBridge(over: Partial<ShellBridge> = {}) {
  const bridge = {
    listMcpServers: (): Promise<McpServersSnapshot> =>
      Promise.resolve({
        servers: [
          {
            id: "supabase",
            status: "needs-auth" as const,
            error: "supabase 需要授权：401",
            config: { kind: "http" as const, url: "https://mcp.supabase.com/mcp", headers: {}, enabled: true },
            tools: [],
            resources: [],
            prompts: [],
          },
        ],
        errors: [],
      }),
    authorizeMcpServer: vi.fn(
      (): Promise<McpServersSnapshot> => Promise.resolve({ servers: [], errors: [] })
    ),
    // 栏目顶部现在挂着 <McpDirectory>（连接器目录），它会调这个方法。
    // 下面这几条用例都不往搜索框里打字，而空查询这一路压根不过桥（McpDirectory
    // 的 effect 直接返回），所以此刻没有一条会走到这儿——钉在这里是因为组件
    // 的桥面确实多了这一项：哪天有用例往搜索框里打字，缺了它就是一个
    // "window.otter.searchMcpRegistry is not a function"，而错误会指向目录，
    // 跟这份文件测的授权按钮毫无关系
    searchMcpRegistry: vi.fn((): Promise<never[]> => Promise.resolve([])),
    ...over,
  } as unknown as ShellBridge;
  window.otter = bridge;
  return bridge;
}

describe("McpSettings 的授权按钮", () => {
  /** #753 起管理面住在连接器详情页里（卡片是索引，详情页是答案）。
      这几条用例测的是那面里的按钮，所以先点开那张卡。
      卡片自己右边也有一颗「授权」，但它的可读名是「授权 Supabase」——
      跟详情页里那颗纯「授权」不会撞 */
  const openCard = async (name: string) => {
    // pointerEventsCheck 关掉：这一屏被 <SidebarProvider> 包着（真实 app 里也是），
    // 它那个收起态的 Sheet 让 jsdom 里算出来的 pointer-events 变成 none，于是
    // userEvent 拒绝点这张 div[role=button]（同一份文件里点普通 <button> 不受
    // 影响，所以不是全局的）。真机上点得动——e2e 里量过（#753）
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    // 点开之后等它真的开了再往下走：第一条用例里 refreshMcp 的那次 resolve
    // 和这一下点击挨得太近，卡片刚出现就点，偶发点在一个还没接上处理器的
    // 节点上。等「返回」那颗按钮出现 = 详情页真的在了
    await waitFor(async () => {
      await user.click(await screen.findByRole("button", { name: `${name} 详情` }));
      expect(screen.getByRole("button", { name: "连接器" })).toBeInTheDocument();
    });
  };

  it("needs-auth 的 server 显示「授权」按钮", async () => {
    stubBridge();
    renderMcpSettings();
    await openCard("Supabase");
    expect(await screen.findByRole("button", { name: "授权" })).toBeInTheDocument();
  });

  it("connected 的 server 不显示授权按钮", async () => {
    stubBridge({
      listMcpServers: () =>
        Promise.resolve({
          servers: [
            {
              id: "s",
              status: "connected" as const,
              config: { kind: "http" as const, url: "https://x/mcp", headers: {}, enabled: true },
              tools: [],
              resources: [],
              prompts: [],
            },
          ],
          errors: [],
        }),
    });
    renderMcpSettings();
    // 目录里没有 id 为 "s" 的条目 —— 现造的那张卡名字就是 id
    await openCard("s");
    expect(screen.queryByRole("button", { name: "授权" })).not.toBeInTheDocument();
  });

  // 这条用例名承诺的是"期间按钮禁用"（防重复点击 = 防重复开浏览器/重复跑
  // 授权流程），但它此前只断言了桥被调用：把实现里的 disabled={authorizing}
  // 删掉，它照样绿（终审 C 6）。要真的钉住"期间"，桥必须停在半路——所以
  // stub 换成一个手动 resolve 的 deferred promise
  it("点授权调桥，期间按钮禁用", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const bridge = stubBridge({
      authorizeMcpServer: vi.fn(() => pending.then(() => ({ servers: [], errors: [] }))),
    });
    renderMcpSettings();
    await openCard("Supabase");
    const btn = await screen.findByRole("button", { name: "授权" });
    await userEvent.click(btn);

    // 桥还没回来：按钮禁用 + 文案改口，用户点不动第二次
    const waiting = await screen.findByRole("button", { name: "等浏览器…" });
    expect(waiting).toBeDisabled();
    expect(screen.queryByRole("button", { name: "授权" })).not.toBeInTheDocument();

    release();
    await waitFor(() => {
      expect(bridge.authorizeMcpServer).toHaveBeenCalledWith("supabase");
    });
  });

  it("授权失败时把原因显示出来，不静默吞掉", async () => {
    stubBridge({
      authorizeMcpServer: vi.fn(() =>
        Promise.reject(new Error("等授权超时（300 秒没等到浏览器回调）"))
      ),
    });
    renderMcpSettings();
    await openCard("Supabase");
    await userEvent.click(await screen.findByRole("button", { name: "授权" }));
    expect(await screen.findByText(/等授权超时/)).toBeInTheDocument();
  });

  // #474：authError 从前只有下一次点「授权」才会清——save/remove/reconnect
  // 把这台修好/删掉之后，旁边还挂着「授权失败」，两个信号打架。
  // 走 remove 这条路驱动（needs-auth 的卡上没有重连按钮）
  it("删除会清掉上一次的授权失败文案（#474）", async () => {
    stubBridge({
      authorizeMcpServer: vi.fn(() => Promise.reject(new Error("等授权超时（300 秒没等到浏览器回调）"))),
      removeMcpServer: vi.fn((): Promise<McpServersSnapshot> => Promise.resolve({ servers: [], errors: [] })),
    } as Partial<ShellBridge>);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderMcpSettings();
    await openCard("Supabase");
    await userEvent.click(await screen.findByRole("button", { name: "授权" }));
    expect(await screen.findByText(/等授权超时/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => {
      expect(screen.queryByText(/等授权超时/)).not.toBeInTheDocument();
    });
  });
});
