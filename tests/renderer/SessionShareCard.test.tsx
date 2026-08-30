// @vitest-environment jsdom
//
// DM 里那张分享卡（issue #611）+ 随包借出服务后多长出来的那个按钮（#694，ADR-0177）。
// 最要紧的一条不是「按钮在不在」，而是**两个按钮各自承诺的事严格分开**：
// 服务接不上时不顺手把对话导进去再报错——那样人分不清哪一半成功了。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { SessionShareCard } from "../../src/renderer/src/components/SessionShareCard.js";
import { encodeEnvelope } from "../../src/shared/sessionPackageCodec.js";
import { PROXY_SHARE_INVITE_TTL_MS } from "../../src/shared/remote/proxyInvite.js";
import { useChat } from "../../src/renderer/src/store.js";

const INVITE = "otto-proxy:1:a-uid:chan:cHVi:c2Vj:1700000000000";

function envelope(extra: Record<string, unknown> = {}): string {
  return encodeEnvelope({
    bucket: "session-packages",
    prefix: "a-uid/pkg-1",
    message: "帮我把这批订单退了",
    title: "退款",
    eventCount: 12,
    ...extra,
  });
}

function seed(over: { importShared?: unknown; acceptProxyInvite?: unknown } = {}) {
  useChat.setState({
    workspace: "/w",
    importShared: (over.importShared ?? vi.fn(async () => true)) as never,
    acceptProxyInvite: (over.acceptProxyInvite ?? vi.fn(async () => true)) as never,
  });
}

afterEach(cleanup);

describe("SessionShareCard", () => {
  it("没带邀请码 = 老样子：一个「导入到当前工作区」", () => {
    seed();
    render(<SessionShareCard body={envelope()} mine={false} fromName="小明" />);
    expect(screen.getByText("导入到当前工作区")).toBeInTheDocument();
    expect(screen.queryByText("导入并接上 TA 的服务")).not.toBeInTheDocument();
  });

  it("带了邀请码：列出借来的服务，并多出「导入并接上」那个按钮", () => {
    seed();
    render(
      <SessionShareCard
        body={envelope({ invite: INVITE, grantServers: ["shopify"] })}
        mine={false}
        fromName="小明"
      />
    );
    expect(screen.getByText("导入并接上 TA 的服务")).toBeInTheDocument();
    expect(screen.getByText("只导入对话")).toBeInTheDocument();
    expect(screen.getByText("shopify")).toBeInTheDocument();
    expect(screen.getByText(/凭证在 TA 那台机器上/)).toBeInTheDocument();
  });

  it("点「导入并接上」：先握手再导入，且用的是 24 小时那档有效期", async () => {
    const order: string[] = [];
    const acceptProxyInvite = vi.fn(async () => { order.push("accept"); return true; });
    const importShared = vi.fn(async () => { order.push("import"); return true; });
    seed({ acceptProxyInvite, importShared });

    render(
      <SessionShareCard body={envelope({ invite: INVITE, grantServers: ["shopify"] })} mine={false} fromName="小明" />
    );
    await userEvent.click(screen.getByText("导入并接上 TA 的服务"));

    await waitFor(() => expect(importShared).toHaveBeenCalledWith("a-uid/pkg-1", "/w"));
    expect(acceptProxyInvite).toHaveBeenCalledWith(INVITE, PROXY_SHARE_INVITE_TTL_MS);
    expect(order).toEqual(["accept", "import"]);
  });

  it("握手失败就**不导入**，并告诉人还可以只导入对话", async () => {
    const importShared = vi.fn(async () => true);
    seed({ acceptProxyInvite: vi.fn(async () => false), importShared });

    render(
      <SessionShareCard body={envelope({ invite: INVITE, grantServers: ["shopify"] })} mine={false} fromName="小明" />
    );
    await userEvent.click(screen.getByText("导入并接上 TA 的服务"));

    expect(await screen.findByText(/接不上对方的服务/)).toBeInTheDocument();
    expect(importShared).not.toHaveBeenCalled();
  });

  it("「只导入对话」这条路一次握手都不做", async () => {
    const acceptProxyInvite = vi.fn(async () => true);
    const importShared = vi.fn(async () => true);
    seed({ acceptProxyInvite, importShared });

    render(
      <SessionShareCard body={envelope({ invite: INVITE, grantServers: ["shopify"] })} mine={false} fromName="小明" />
    );
    await userEvent.click(screen.getByText("只导入对话"));

    await waitFor(() => expect(importShared).toHaveBeenCalled());
    expect(acceptProxyInvite).not.toHaveBeenCalled();
  });

  it("自己发出去的那条只读：说「连带借出了」，不给按钮", () => {
    seed();
    render(
      <SessionShareCard body={envelope({ invite: INVITE, grantServers: ["shopify"] })} mine fromName="我" />
    );
    expect(screen.getByText("连带借出了：")).toBeInTheDocument();
    expect(screen.queryByText("导入并接上 TA 的服务")).not.toBeInTheDocument();
    expect(screen.queryByText("只导入对话")).not.toBeInTheDocument();
  });

  it("普通私信不认成卡片", () => {
    seed();
    const { container } = render(<SessionShareCard body="晚上吃啥" mine={false} fromName="小明" />);
    expect(container).toBeEmptyDOMElement();
  });

  // #783 的形态：桥那头抛异常（handler reject / 形状不对的 TypeError）时，
  // 按钮不许停在「接入中…」永远转圈——要回到可点状态并说一句人话。
  // store 层正常返回 false 的路已有上面几条测过，这两条测的是 **reject** 那条路
  it("importShared 抛异常：按钮回到可点状态并显示失败，而不是永远转圈", async () => {
    seed({ importShared: vi.fn(async () => { throw new TypeError("Cannot read properties of undefined"); }) });
    render(
      <SessionShareCard body={envelope({ invite: INVITE, grantServers: ["shopify"] })} mine={false} fromName="小明" />
    );
    await userEvent.click(screen.getByText("只导入对话"));

    expect(await screen.findByText(/导入失败/)).toBeInTheDocument();
    expect(screen.getByText("只导入对话")).toBeEnabled(); // busy 已复位
    expect(screen.queryByText("导入中…")).not.toBeInTheDocument();
  });

  it("acceptProxyInvite 抛异常：同样复位并报错，不进导入", async () => {
    const importShared = vi.fn(async () => true);
    seed({ importShared, acceptProxyInvite: vi.fn(async () => { throw new Error("ipc boom"); }) });
    render(
      <SessionShareCard body={envelope({ invite: INVITE, grantServers: ["shopify"] })} mine={false} fromName="小明" />
    );
    await userEvent.click(screen.getByText("导入并接上 TA 的服务"));

    expect(await screen.findByText(/导入失败|接不上对方的服务/)).toBeInTheDocument();
    expect(screen.getByText("导入并接上 TA 的服务")).toBeEnabled();
    expect(importShared).not.toHaveBeenCalled();
  });
});
