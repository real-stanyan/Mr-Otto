// @vitest-environment jsdom
//
// 连接器 tab 那一组「代码仓库」真渲染一遍（#1104）。
//
// 纯逻辑那份（gitHostsView.test.ts）钉的是每一格的**值**，钉不到「有没有被
// 画出来」——同 #1099 给文件树补那一份时的理由。这一组特别值得钉，因为它有
// 一条**安全性质**：token 从不下行，所以这一页上任何地方都不该出现它。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { WorkspacePage } from "../../src/renderer/src/components/WorkspacePage.js";
import { useChat } from "../../src/renderer/src/store.js";
import type { CsGitHost } from "../../src/shared/remote/cloudSession.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const OWNER = "u-owner";
const MEMBER = "u-member";
const AT = new Date("2026-09-06T00:00:00Z").getTime();

const WS: WorkspaceSnapshot = {
  id: "ws-1",
  name: "mandy's bubble tea",
  ownerUid: OWNER,
  members: [
    { uid: OWNER, role: "owner", label: "小红", avatarUrl: "" },
    { uid: MEMBER, role: "member", label: "小明", avatarUrl: "" },
  ],
  connectors: [],
  sessions: [],
  agents: [],
  sandboxApproval: "ask",
};

// WorkspacePage 挂载时「会话」tab 会去 `window.otter.workspaceCloudList`——
// jsdom 里那个桥不存在，未处理的 rejection 会飘成 8 条 unhandled error，
// 而那种噪音正好是**下一个真失败**的藏身处。桩成空清单，这一组不看它
const OTTER_STUB = {
  workspaceCloudList: async () => ({ ok: true, value: [] }),
} as unknown as Window["otter"];

function seed(opts: {
  gitHosts?: readonly CsGitHost[] | null;
  save?: (workspaceId: string, host: string, token: string) => Promise<unknown>;
}) {
  (window as unknown as { otter: Window["otter"] }).otter = OTTER_STUB;
  useChat.setState({
    workspaceCloudState: (async () => ({
      ok: true,
      // **不用 `?? []`**：`null` 是「读不到」这个取值本身，被 ?? 吃掉就等于
      // 这个助手自己犯了本组用例要防的那个错（写这一份时真踩了一次）
      value: { modelRoute: null, gitHosts: "gitHosts" in opts ? opts.gitHosts : [] },
    })) as never,
    workspaceCloudGitCredential: (opts.save ?? (async () => ({ ok: true, value: [] }))) as never,
    mcpServers: { servers: [] } as never,
  });
}

const show = (selfUid = OWNER) =>
  render(<WorkspacePage ws={WS} selfUid={selfUid} onBack={() => {}} />);

/** 这一组住在「连接器」那一页里。#1120 之后目录是**推入式**不是 tab：
    根页点「连接器」那一行推一页出来（行是一层铺满的透明按钮，`aria-label` 就是标题） */
async function openConnectors() {
  await userEvent.click(await screen.findByRole("button", { name: "连接器" }));
}

afterEach(() => cleanup());

describe("连接器 tab 的「代码仓库」组", () => {
  it("每一台主机都进 DOM，带添加者与日期", async () => {
    seed({ gitHosts: [{ host: "github.com", addedBy: OWNER, addedAt: AT }] });
    show();
    await openConnectors();

    expect(await screen.findByText("github.com")).toBeInTheDocument();
    expect(screen.getByText(/由 小红 添加/)).toBeInTheDocument();
  });

  it("一台都没配 → 空态（不是错误）", async () => {
    seed({ gitHosts: [] });
    show();
    await openConnectors();
    expect(await screen.findByText(/还没有配过/)).toBeInTheDocument();
    expect(screen.queryByText(/读不到凭据清单/)).not.toBeInTheDocument();
  });

  it("读不到 → 红字，**不许画成「一台都没配」**", async () => {
    seed({ gitHosts: null });
    show();
    await openConnectors();
    expect(await screen.findByText(/读不到凭据清单/)).toBeInTheDocument();
    expect(screen.queryByText(/还没有配过/)).not.toBeInTheDocument();
  });

  it("非 owner 看得到清单、但没有 ＋ 与删除 —— 不是整组藏起来", async () => {
    seed({ gitHosts: [{ host: "github.com", addedBy: OWNER, addedAt: AT }] });
    show(MEMBER);
    await openConnectors();

    expect(await screen.findByText("github.com")).toBeInTheDocument(); // 清单照画
    expect(screen.queryByRole("button", { name: "添加主机" })).not.toBeInTheDocument();
    expect(screen.queryByText("删除")).not.toBeInTheDocument();
  });

  it("存一把：主机 + 令牌走同一条 RPC，且**令牌一个字都不留在页面上**", async () => {
    const calls: [string, string, string][] = [];
    seed({
      gitHosts: [],
      save: async (w, h, t) => {
        calls.push([w, h, t]);
        return { ok: true, value: [{ host: h, addedBy: OWNER, addedAt: AT }] };
      },
    });
    show();
    await openConnectors();
    await userEvent.click(await screen.findByRole("button", { name: "添加主机" }));

    const [hostBox, tokenBox] = screen.getAllByRole("textbox").concat(
      // password 型 input 不在 textbox role 里，单独取
      Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]'))
    );
    await userEvent.clear(hostBox!);
    await userEvent.type(hostBox!, "gitlab.com");
    await userEvent.type(tokenBox!, "glpat_secret");
    await userEvent.click(screen.getByText("保存"));

    await waitFor(() => expect(calls).toEqual([["ws-1", "gitlab.com", "glpat_secret"]]));
    // 存完弹窗关掉、清单换成服务端回的那份，而 token 不在 DOM 里的任何角落
    expect(await screen.findByText("gitlab.com")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("glpat_secret");
  });

  it("空令牌走「添加」这条路被本地拦下 —— 空串在协议里是「删掉这台」，南辕北辙", async () => {
    const calls: unknown[] = [];
    seed({ gitHosts: [], save: async (...a) => { calls.push(a); return { ok: true, value: [] }; } });
    show();
    await openConnectors();
    await userEvent.click(await screen.findByRole("button", { name: "添加主机" }));
    await userEvent.click(screen.getByText("保存"));

    expect(await screen.findByText(/令牌不能为空/)).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it("主机名本地先判一次，省掉一次明知会被拒的往返", async () => {
    const calls: unknown[] = [];
    seed({ gitHosts: [], save: async (...a) => { calls.push(a); return { ok: true, value: [] }; } });
    show();
    await openConnectors();
    await userEvent.click(await screen.findByRole("button", { name: "添加主机" }));

    const hostBox = screen.getAllByRole("textbox")[0]!;
    await userEvent.clear(hostBox);
    await userEvent.type(hostBox, "github.com/acme");
    await userEvent.click(screen.getByText("保存"));

    expect(await screen.findByText(/只填主机名/)).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it("删除发的是 token 空串（协议 15 的两态），清单换成服务端回的那份", async () => {
    const calls: [string, string, string][] = [];
    seed({
      gitHosts: [{ host: "github.com", addedBy: OWNER, addedAt: AT }],
      save: async (w, h, t) => { calls.push([w, h, t]); return { ok: true, value: [] }; },
    });
    show();
    await openConnectors();
    await userEvent.click(await screen.findByText("删除"));

    await waitFor(() => expect(calls).toEqual([["ws-1", "github.com", ""]]));
    await waitFor(() => expect(screen.queryByText("github.com")).not.toBeInTheDocument());
  });
});
