// @vitest-environment jsdom
//
// 好友代理弹窗（issue #657）的核心往返：圈工具 → 生成邀请码 → 码摆在眼前能复制。
// 纯逻辑（勾选表 ↔ 线上白名单）在 tests/renderer/proxyShare.test.ts 里钉死；
// 这里钉的是「界面确实把那份白名单送了出去」，以及撤销那条路走得通。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { ProxyDialog } from "../../src/renderer/src/components/ProxyDialog.js";
import { useChat } from "../../src/renderer/src/store.js";
import type { McpServersSnapshot } from "../../src/shared/mcp.js";

const servers: McpServersSnapshot = {
  servers: [
    {
      id: "shopify",
      status: "connected",
      config: { kind: "http", url: "https://x", headers: {}, enabled: true },
      tools: [
        { name: "get_orders", description: "", inputSchema: {} },
        { name: "refund", description: "", inputSchema: {} },
      ],
      resources: [],
      prompts: [],
    },
    {
      id: "offline-one",
      status: "failed",
      config: { kind: "http", url: "https://y", headers: {}, enabled: true },
      tools: [],
      resources: [],
      prompts: [],
    },
  ],
  errors: [],
};

function seed(otter: Record<string, unknown>) {
  vi.stubGlobal("window", Object.assign(window, { otter }));
  useChat.setState({
    mcpServers: servers,
    friendsSnapshot: {
      friends: [{
        friendshipId: "f1", status: "accepted", direction: "outgoing",
        profile: { id: "b-uid", email: "b@x.com", name: "小明", avatarUrl: "" },
      }],
      incoming: [], outgoing: [],
    },
    proxyGrants: [],
    proxyAudits: [],
    friendError: null,
  });
}

afterEach(cleanup);

describe("ProxyDialog（好友代理弹窗，issue #657）", () => {
  it("勾一个工具 → 生成邀请码 → 码显示出来；送出去的白名单是明确的那一项", async () => {
    const proxyCreateInvite = vi.fn(async () => ({ ok: true as const, value: { invite: "otto-proxy:1:c:AA:BB:1" } }));
    seed({
      proxyListGrants: vi.fn(async () => ({ ok: true as const, value: { grants: [] } })),
      proxyCreateInvite,
    });
    render(<ProxyDialog open onOpenChange={() => {}} friend={{ id: "b-uid", label: "小明" }} />);

    // 没连上的那台不出现在可圈范围里
    expect(await screen.findByLabelText("shopify")).toBeInTheDocument();
    expect(screen.queryByLabelText("offline-one")).not.toBeInTheDocument();

    await userEvent.click(screen.getByLabelText("展开工具"));
    await userEvent.click(screen.getByLabelText("get_orders"));
    await userEvent.click(screen.getByText("生成邀请码"));

    await waitFor(() => expect(proxyCreateInvite).toHaveBeenCalledWith("b-uid", [
      { serverId: "shopify", tools: ["get_orders"] },
    ]));
    expect(await screen.findByDisplayValue("otto-proxy:1:c:AA:BB:1")).toBeInTheDocument();
  });

  it("已授权页：列出好友名 + 授权摘要，撤销按钮打到桥上", async () => {
    const proxyRevoke = vi.fn(async () => ({ ok: true as const, value: null }));
    seed({
      proxyListGrants: vi.fn(async () => ({
        ok: true as const,
        value: { grants: [{ friendUid: "b-uid", allow: [{ serverId: "shopify", tools: [] }] }] },
      })),
      proxyRevoke,
    });
    render(<ProxyDialog open onOpenChange={() => {}} friend={null} />);

    expect(await screen.findByText("小明")).toBeInTheDocument();
    expect(screen.getByText("shopify（全部工具）")).toBeInTheDocument();
    await userEvent.click(screen.getByText("撤销"));
    await waitFor(() => expect(proxyRevoke).toHaveBeenCalledWith("b-uid"));
  });

  it("接受邀请页：粘码 → 接受 → 说清「等对方推授权」", async () => {
    const proxyAcceptInvite = vi.fn(async () => ({ ok: true as const, value: { grantedCount: 0 } }));
    seed({
      proxyListGrants: vi.fn(async () => ({ ok: true as const, value: { grants: [] } })),
      proxyAcceptInvite,
    });
    render(<ProxyDialog open onOpenChange={() => {}} friend={null} />);

    await userEvent.click(screen.getByText("接受邀请"));
    await userEvent.type(screen.getByPlaceholderText(/otto-proxy/), "otto-proxy:1:c:AA:BB:1");
    await userEvent.click(screen.getByText("接受"));

    await waitFor(() => expect(proxyAcceptInvite).toHaveBeenCalledWith("otto-proxy:1:c:AA:BB:1"));
    expect(await screen.findByText(/等对方推来授权清单/)).toBeInTheDocument();
  });
});
