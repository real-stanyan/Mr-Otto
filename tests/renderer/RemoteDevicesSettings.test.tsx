// @vitest-environment jsdom
//
// 「手机」栏目上那条"刚才有人来敲门却进不来"的提示(issue #485)。
//
// 这一页的组件不吃 prop,只认 window.otter(同 McpSettings.test.tsx 的做法)。
// 用例盯的是**文案本身**:两种 reason 的紧急程度不一样,合并成一条就等于把
// "有人在中间换了公钥"这句话从用户眼前拿掉了。

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { RemoteDevicesSettings } from "../../src/renderer/src/components/RemoteDevicesSettings.js";
import { SidebarProvider } from "../../src/renderer/src/components/ui/sidebar.js";
import type { RemoteStatus, ShellBridge } from "../../src/shared/shellBridge.js";

const PEER = {
  deviceId: "m1",
  label: "iPhone",
  lastSeen: "2026-08-26T00:00:00Z",
  code: "097162",
  pinned: false,
};

function stubBridge(status: RemoteStatus, over: Partial<ShellBridge> = {}) {
  window.otter = {
    remoteStatus: () => Promise.resolve(status),
    remotePairDevice: () => Promise.resolve(true),
    // 扫码配对那两条(#583):这一页挂载/卸载就会碰 cancel,缺了它整页渲染不出来
    remoteStartPairing: () => Promise.resolve({ qr: "otto-pair:1:d1:x:y", expiresAt: Date.now() + 60_000 }),
    remoteCancelPairing: () => Promise.resolve(),
    ...over,
  } as unknown as ShellBridge;
}

function renderPage() {
  return render(
    <SidebarProvider>
      <RemoteDevicesSettings />
    </SidebarProvider>
  );
}

afterEach(() => {
  cleanup();
});

// 多设备配对(#511)：两台都能是"已配对",而"已配对"那个标记同时是解除的入口。
// 盯的是**两台并存**这件事本身 —— 单值 pin 的年代,配第二台是静默顶掉第一台
describe("RemoteDevicesSettings 的设备列表", () => {
  it("配了两台就两台都标已配对，各自带解除入口", async () => {
    stubBridge({
      on: true,
      rejected: null,
      peers: [
        { ...PEER, deviceId: "m1", label: "iPhone 16 Pro Max", pinned: true },
        { ...PEER, deviceId: "m2", label: "iPhone 17（模拟器）", code: "068332", pinned: true },
      ],
    });
    renderPage();
    expect(await screen.findAllByRole("button", { name: "已配对" })).toHaveLength(2);
    // 两台都配上了就不该再有"配对"按钮怂恿人再配一次
    expect(screen.queryByRole("button", { name: /安全码一致/ })).not.toBeInTheDocument();
  });

  it("没配对的那台给的是配对按钮，不是解除", async () => {
    stubBridge({ on: true, rejected: null, peers: [{ ...PEER, pinned: false }] });
    renderPage();
    expect(await screen.findByRole("button", { name: /安全码一致/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "已配对" })).not.toBeInTheDocument();
  });
});

describe("RemoteDevicesSettings 的「被挡下的握手」提示", () => {
  it("没被挡过就不出提示", async () => {
    stubBridge({ on: true, peers: [PEER], rejected: null });
    renderPage();
    await screen.findByText("用手机扫一下就配好");
    expect(screen.queryByText(/连过来/)).not.toBeInTheDocument();
    expect(screen.queryByText(/身份对不上/)).not.toBeInTheDocument();
  });

  it("unpaired：说清楚它在下面的列表里，该做的事是核对安全码", async () => {
    stubBridge({
      on: true,
      peers: [PEER],
      rejected: { deviceId: "m1", reason: "unpaired", at: Date.parse("2026-08-26T01:00:00Z") },
    });
    renderPage();
    // 在这条提示**自己那张卡**里找:「核对 6 位安全码」在下面那张降级路径卡上也有
    const banner = (await screen.findByText("有一台手机连过来,但还没配对")).closest("div")!;
    expect(banner).toHaveTextContent("二维码");
    expect(banner).toHaveTextContent("核对 6 位安全码");
  });

  it("identity-mismatch：把「有人在中间换掉了公钥」这半边说出来", async () => {
    stubBridge({
      on: true,
      peers: [PEER],
      rejected: {
        deviceId: "m1",
        reason: "identity-mismatch",
        at: Date.parse("2026-08-26T01:00:00Z"),
      },
    });
    renderPage();
    // 在这条提示**自己那张卡**里找 —— 「中间有人换掉了公钥」在下面那张降级路径
    // 说明卡上也有一句,不圈定范围的话这条用例等于没断言
    const banner = (await screen.findByText("有一台手机连不上来:身份对不上")).closest("div")!;
    // 重装手机 / 中间人,两种可能都要在,不能替用户下结论
    expect(banner).toHaveTextContent("重装或重新登录过");
    expect(banner).toHaveTextContent("中间有人换掉了公钥");
  });

  it("提示带上是哪台设备 —— 目录里不止一台时,不说清楚等于没说", async () => {
    stubBridge({
      on: true,
      peers: [PEER, { ...PEER, deviceId: "m2", label: "iPad" }],
      rejected: { deviceId: "m2", reason: "unpaired", at: Date.parse("2026-08-26T01:00:00Z") },
    });
    renderPage();
    await screen.findByText("有一台手机连过来,但还没配对");
    expect(screen.getByText("m2")).toBeInTheDocument();
  });

  it("远程开不起来时不显示这条提示（那一屏只该说开不起来的原因）", async () => {
    stubBridge({ on: false, reason: "no-secure-storage" });
    renderPage();
    expect(await screen.findByText("这台机器没有可用的系统安全存储")).toBeInTheDocument();
    expect(screen.queryByText(/连过来/)).not.toBeInTheDocument();
  });
});

// 扫码配对(issue #583)。盯的是**这一屏的主动作换人了**:主路径是开一张码让手机扫,
// 而码的一次性/短寿命在界面上要看得见 —— 否则用户会以为它一直有效。
describe("RemoteDevicesSettings 的扫码配对", () => {
  const PINNED = { ...PEER, deviceId: "m2", label: "另一台", pinned: true };

  it("默认不开码 —— 点了才开(码不该在没人看着的时候活着)", async () => {
    const start = vi.fn(() => Promise.resolve({ qr: "otto-pair:1:d1:x:y", expiresAt: Date.now() + 180_000 }));
    stubBridge({ on: true, peers: [PEER], rejected: null }, { remoteStartPairing: start } as Partial<ShellBridge>);
    renderPage();
    await screen.findByText("用手机扫一下就配好");
    expect(start).not.toHaveBeenCalled();
    expect(screen.queryByRole("img", { name: "配对二维码" })).not.toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /显示二维码/ })); });
    expect(start).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("img", { name: "配对二维码" })).toBeInTheDocument();
  });

  it("收起 → 主进程那张码当场作废,不是等它自己过期", async () => {
    const cancel = vi.fn(() => Promise.resolve());
    stubBridge({ on: true, peers: [PEER], rejected: null }, { remoteCancelPairing: cancel } as Partial<ShellBridge>);
    renderPage();
    await screen.findByText("用手机扫一下就配好");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /显示二维码/ })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "收起" })); });
    expect(cancel).toHaveBeenCalled();
    expect(screen.queryByRole("img", { name: "配对二维码" })).not.toBeInTheDocument();
  });

  it("有人扫成功 → 码收起来,并且说出配好的是哪台(不让它默默消失)", async () => {
    vi.useFakeTimers();
    try {
      let peers = [PEER];
      stubBridge(
        { on: true, peers: [PEER], rejected: null },
        { remoteStatus: () => Promise.resolve({ on: true, peers, rejected: null }) } as Partial<ShellBridge>
      );
      renderPage();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: /显示二维码/ })); });
      expect(screen.getByRole("img", { name: "配对二维码" })).toBeInTheDocument();

      peers = [PEER, PINNED]; // 手机扫完了,主进程那边已经 pin 上
      await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
      expect(screen.getByText("配好了：另一台")).toBeInTheDocument();
      expect(screen.queryByRole("img", { name: "配对二维码" })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("码过期 → 自己收掉(屏幕上不留一张已经不作数的码)", async () => {
    vi.useFakeTimers();
    try {
      stubBridge(
        { on: true, peers: [PEER], rejected: null },
        {
          remoteStartPairing: () => Promise.resolve({ qr: "otto-pair:1:d1:x:y", expiresAt: Date.now() + 3_000 }),
        } as Partial<ShellBridge>
      );
      renderPage();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: /显示二维码/ })); });
      expect(screen.getByRole("img", { name: "配对二维码" })).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(3_500); });
      expect(screen.queryByRole("img", { name: "配对二维码" })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
