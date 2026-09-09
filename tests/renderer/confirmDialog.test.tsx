// @vitest-environment jsdom
//
// 二次确认弹窗（#1127）。这一层的活是把「同步 boolean」翻译成「Promise + 一张卡」，
// 所以断言全都问同一件事：**那个 promise 最后拿到了什么**——按钮、ESC、卸载三条路
// 各自的答案，以及排着的第二个问题会不会被第一个吞掉。

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { ConfirmProvider, useConfirm } from "../../src/renderer/src/components/ui/confirm-dialog.js";
import type { ConfirmOptions } from "../../src/renderer/src/components/ui/confirm-dialog.js";

afterEach(cleanup);

/** 把 `confirm` 拎出来给用例直接调，免得每条都先造一颗按钮 */
function Harness({ onReady }: { onReady: (fn: (o: ConfirmOptions) => Promise<boolean>) => void }) {
  const confirm = useConfirm();
  onReady(confirm);
  return <p>内容</p>;
}

function setup(): { ask: (o: ConfirmOptions) => Promise<boolean>; unmount: () => void } {
  let fn!: (o: ConfirmOptions) => Promise<boolean>;
  const r = render(
    <ConfirmProvider>
      <Harness onReady={(f) => { fn = f; }} />
    </ConfirmProvider>
  );
  return { ask: (o) => fn(o), unmount: r.unmount };
}

const ask = (
  h: ReturnType<typeof setup>,
  o: ConfirmOptions
): Promise<boolean> => {
  let p!: Promise<boolean>;
  act(() => { p = h.ask(o); });
  return p;
};

describe("ConfirmProvider", () => {
  it("没有 provider 时 useConfirm 抛错——不回落到 window.confirm", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Harness onReady={() => {}} />)).toThrow(/ConfirmProvider/);
    spy.mockRestore();
  });

  it("点确认 = true，标题与说明分成两格画出来", async () => {
    const h = setup();
    const p = ask(h, { title: "解散工作区「奶茶店」？", description: "授权会立即失效。" });
    expect(screen.getByText("解散工作区「奶茶店」？")).toBeInTheDocument();
    expect(screen.getByText("授权会立即失效。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    await expect(p).resolves.toBe(true);
  });

  it("点取消 = false", async () => {
    const h = setup();
    const p = ask(h, { title: "删掉？" });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await expect(p).resolves.toBe(false);
  });

  it("按 ESC = false——关掉窗口和点取消是同一个答案", async () => {
    const h = setup();
    const p = ask(h, { title: "删掉？" });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await expect(p).resolves.toBe(false);
  });

  it("tone=danger 时确认钮画成 destructive；默认档不画", async () => {
    const h = setup();
    const p = ask(h, { title: "彻底删除？", confirmLabel: "删除", tone: "danger" });
    expect(screen.getByRole("button", { name: "删除" })).toHaveAttribute("data-variant", "destructive");
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await expect(p).resolves.toBe(true);

    const p2 = ask(h, { title: "丢弃草稿？" });
    expect(screen.getByRole("button", { name: "确定" })).toHaveAttribute("data-variant", "default");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await p2;
  });

  it("第二个问题排队等着，不被第一个吞掉——被吞的那个 promise 永远不 resolve", async () => {
    const h = setup();
    const first = ask(h, { title: "第一问？" });
    const second = ask(h, { title: "第二问？" });
    expect(screen.getByText("第一问？")).toBeInTheDocument();
    expect(screen.queryByText("第二问？")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    await expect(first).resolves.toBe(true);

    expect(screen.getByText("第二问？")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await expect(second).resolves.toBe(false);
  });

  it("卸载时没答的一律按取消收口——否则调用点停在一个再也不会来的答案上", async () => {
    const h = setup();
    const p = ask(h, { title: "删掉？" });
    act(() => { h.unmount(); });
    await expect(p).resolves.toBe(false);
  });
});
