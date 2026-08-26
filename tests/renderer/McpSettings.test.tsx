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
    ...over,
  } as unknown as ShellBridge;
  window.otter = bridge;
  return bridge;
}

describe("McpSettings 的授权按钮", () => {
  it("needs-auth 的 server 显示「授权」按钮", async () => {
    stubBridge();
    renderMcpSettings();
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
    await screen.findByText("s");
    expect(screen.queryByRole("button", { name: "授权" })).not.toBeInTheDocument();
  });

  it("点授权调桥，期间按钮禁用", async () => {
    const bridge = stubBridge();
    renderMcpSettings();
    const btn = await screen.findByRole("button", { name: "授权" });
    await userEvent.click(btn);
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
    await userEvent.click(await screen.findByRole("button", { name: "授权" }));
    expect(await screen.findByText(/等授权超时/)).toBeInTheDocument();
  });
});
