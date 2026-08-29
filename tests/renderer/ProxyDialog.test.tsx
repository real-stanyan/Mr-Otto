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
  vi.stubGlobal("window", Object.assign(window, {
    // 代理全景是推送式更新的，弹窗打开时拉一次补齐——每个用例都会调到
    otter: {
      proxyStatus: vi.fn(async () => ({ ok: true as const, value: { borrows: [], hosts: [] } })),
      ...otter,
    },
  }));
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
    proxyBorrows: [],
    proxyHosts: [],
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

    // 第三个参数是有效期：这个弹窗发的码不传 = 默认 10 分钟。
    // 放宽到 24 小时只发生在「随会话分享」那条路上（ADR-0177）
    await waitFor(() => expect(proxyCreateInvite).toHaveBeenCalledWith("b-uid", [
      { serverId: "shopify", tools: ["get_orders"] },
    ], undefined));
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

  it("已授权页：调用记录带出参数摘要（ADR-0151 防线 1 点名要的那一段）", async () => {
    seed({
      proxyListGrants: vi.fn(async () => ({
        ok: true as const,
        value: { grants: [{ friendUid: "b-uid", allow: [{ serverId: "shopify", tools: [] }] }] },
      })),
      proxyAudit: vi.fn(async () => ({
        ok: true as const,
        value: {
          audits: [{
            ts: new Date(2026, 7, 28, 9, 5).getTime(), friendUid: "b-uid",
            serverId: "shopify", tool: "refund", argsSummary: '{"orderId":"1234"}',
            decision: "executed", outcome: "ok",
          }],
        },
      })),
    });
    render(<ProxyDialog open onOpenChange={() => {}} friend={null} />);

    await userEvent.click(await screen.findByText("查看记录"));
    expect(await screen.findByText("shopify / refund")).toBeInTheDocument();
    expect(screen.getByText("已执行")).toBeInTheDocument();
    expect(screen.getByText('{"orderId":"1234"}')).toBeInTheDocument();
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

    await waitFor(() => expect(proxyAcceptInvite).toHaveBeenCalledWith("otto-proxy:1:c:AA:BB:1", undefined));
    expect(await screen.findByText(/上面那行会显示接上没有/)).toBeInTheDocument();
  });

  it("借来的通道列表：连没连分得开，断开打到桥上", async () => {
    const proxyDisconnect = vi.fn(async () => ({ ok: true as const, value: null }));
    seed({
      proxyListGrants: vi.fn(async () => ({ ok: true as const, value: { grants: [] } })),
      proxyDisconnect,
      // 弹窗打开时会拉一次（推送之外的那扇查询窗口），所以数据从这儿来而不是 setState
      proxyStatus: vi.fn(async () => ({
        ok: true as const,
        value: {
          hosts: [],
          borrows: [
            { hostUid: "a-uid", label: "小明", connected: true, serverCount: 2 },
            { hostUid: "c-uid", label: "小红", connected: false, serverCount: 0 },
            { hostUid: "d-uid", label: "小刚", connected: false, serverCount: 0, revokedReason: "对方撤销了这条代理授权" },
          ],
        },
      })),
    });
    render(<ProxyDialog open onOpenChange={() => {}} friend={null} />);

    await userEvent.click(screen.getByText("接受邀请"));
    // 「配过但没连上」和「连上了但对方一个都没授」是两件事
    expect(await screen.findByText("2 个服务")).toBeInTheDocument();
    expect(screen.getByText("没连上")).toBeInTheDocument();
    // 被撤销的那条**留在列表里**，而且说的是另一句话——「没连上」是等一等，
    // 这一句是别等了（issue #680）
    expect(screen.getByText("对方撤销了这条代理授权")).toBeInTheDocument();
    expect(screen.getByText("移除")).toBeInTheDocument();

    await userEvent.click(screen.getAllByText("断开")[0]!);
    await waitFor(() => expect(proxyDisconnect).toHaveBeenCalledWith("a-uid"));
  });

  it("已授权页：A 看得见对方连没连、此刻在跑几笔（issue #680）", async () => {
    seed({
      proxyListGrants: vi.fn(async () => ({
        ok: true as const,
        value: { grants: [
          { friendUid: "b-uid", allow: [{ serverId: "shopify", tools: [] }] },
          { friendUid: "z-uid", allow: [{ serverId: "shopify", tools: ["refund"] }] },
        ] },
      })),
      proxyStatus: vi.fn(async () => ({
        ok: true as const,
        value: {
          borrows: [],
          hosts: [
            { friendUid: "b-uid", label: "小明", connected: true, inflight: 2, lastCallAt: 0, pairing: "paired" },
            { friendUid: "z-uid", label: "小强", connected: false, inflight: 0, lastCallAt: null, pairing: "paired" },
          ],
        },
      })),
    });
    render(<ProxyDialog open onOpenChange={() => {}} friend={null} />);

    // 白名单内是全自动的：「此刻正在用我的凭证」只有这一行说得出口
    expect(await screen.findByText("正在调用 · 2 笔")).toBeInTheDocument();
    expect(screen.getByText("没连上 · 还没用过")).toBeInTheDocument();
  });

  it("邀请失效那一档：说清是失效不是没连上，就地重发一张（issue #682）", async () => {
    const proxyCreateInvite = vi.fn(async () => ({
      ok: true as const, value: { invite: "otto-proxy:1:a:c:AA:BB:1" },
    }));
    seed({
      proxyCreateInvite,
      proxyListGrants: vi.fn(async () => ({
        ok: true as const,
        value: { grants: [{ friendUid: "b-uid", allow: [{ serverId: "shopify", tools: [] }] }] },
      })),
      proxyStatus: vi.fn(async () => ({
        ok: true as const,
        value: {
          borrows: [],
          hosts: [{
            friendUid: "b-uid", label: "小明", connected: false, inflight: 0,
            lastCallAt: null, pairing: "needsInvite" as const,
          }],
        },
      })),
    });
    render(<ProxyDialog open onOpenChange={() => {}} friend={null} />);

    // 「没连上」会让用户干等，而这一档等到天荒地老也不会连上
    expect(await screen.findByText("邀请已失效 · 重发一张")).toBeInTheDocument();

    // 出路就在这一行上：原样用已有白名单重发，不必再圈一遍
    await userEvent.click(screen.getByText("重发邀请码"));
    await waitFor(() => expect(proxyCreateInvite).toHaveBeenCalledWith("b-uid", [{ serverId: "shopify", tools: [] }], undefined));
    expect(await screen.findByDisplayValue("otto-proxy:1:a:c:AA:BB:1")).toBeInTheDocument();
  });

  it("分享页：已授过的好友预勾选 + 更新授权不重发邀请码（issue #680）", async () => {
    const proxyUpdateGrant = vi.fn(async () => ({ ok: true as const, value: null }));
    const proxyCreateInvite = vi.fn();
    seed({
      proxyUpdateGrant,
      proxyCreateInvite,
      proxyListGrants: vi.fn(async () => ({
        ok: true as const,
        value: { grants: [{ friendUid: "b-uid", allow: [{ serverId: "shopify", tools: ["get_orders"] }] }] },
      })),
    });
    render(<ProxyDialog open onOpenChange={() => {}} friend={{ id: "b-uid", label: "小明" }} />);

    // 已有的那份被预勾上了——不预填的话改授权要把原来的全部重勾一遍
    expect(await screen.findByText(/已按现有授权预勾选/)).toBeInTheDocument();

    // 展开、把剩下那个工具也勾上（两个都勾 = 收回成整服务放行 tools: []），
    // 然后「更新授权」——邀请码一张都不该发
    await userEvent.click(screen.getByLabelText("展开工具"));
    await userEvent.click(await screen.findByLabelText("refund"));
    await userEvent.click(screen.getByText("更新授权"));
    await waitFor(() => expect(proxyUpdateGrant).toHaveBeenCalledWith("b-uid", [{ serverId: "shopify", tools: [] }]));
    expect(proxyCreateInvite).not.toHaveBeenCalled();
  });
});
