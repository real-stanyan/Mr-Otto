// @vitest-environment jsdom
//
// 分享前那次确认（issue #694，ADR-0177）。这个弹窗的全部意义是知情同意，
// 所以钉的就是那两件事：**默认全勾**（省事那一半还在），
// 以及**按钮上写清这一次到底借出了几项**（知情那一半补上了）。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { ShareGrantDialog } from "../../src/renderer/src/components/ShareGrantDialog.js";

const target = {
  uid: "b-uid",
  name: "小明",
  message: "帮我把这批订单退了",
  servers: ["shopify", "google-ads"],
};

afterEach(cleanup);

describe("ShareGrantDialog", () => {
  it("默认全勾，确认时把整份清单交出去", async () => {
    const onConfirm = vi.fn(async () => true);
    render(<ShareGrantDialog target={target} online onCancel={() => {}} onConfirm={onConfirm} />);

    expect(screen.getByLabelText("shopify")).toBeChecked();
    expect(screen.getByLabelText("google-ads")).toBeChecked();

    await userEvent.click(screen.getByText("分享并借出 2 项服务"));
    expect(onConfirm).toHaveBeenCalledWith(["shopify", "google-ads"]);
  });

  it("减掉一项，按钮上的数跟着变", async () => {
    const onConfirm = vi.fn(async () => true);
    render(<ShareGrantDialog target={target} online onCancel={() => {}} onConfirm={onConfirm} />);

    await userEvent.click(screen.getByLabelText("google-ads"));
    await userEvent.click(screen.getByText("分享并借出 1 项服务"));
    expect(onConfirm).toHaveBeenCalledWith(["shopify"]);
  });

  it("全部取消 = 只分享对话，按钮当场改口", async () => {
    const onConfirm = vi.fn(async () => true);
    render(<ShareGrantDialog target={target} online onCancel={() => {}} onConfirm={onConfirm} />);

    await userEvent.click(screen.getByLabelText("shopify"));
    await userEvent.click(screen.getByLabelText("google-ads"));
    await userEvent.click(screen.getByText("只分享对话"));
    expect(onConfirm).toHaveBeenCalledWith([]);
  });

  it("说清「不会再逐次问你」—— 这句话是这个弹窗存在的理由", () => {
    render(<ShareGrantDialog target={target} online onCancel={() => {}} onConfirm={async () => true} />);
    expect(screen.getByText(/不会再逐次问你/)).toBeInTheDocument();
    expect(screen.getByText(/你退出 app 它就作废/)).toBeInTheDocument();
  });

  it("对方不在线时把话说成「等 TA 上线」，而不是假装现在就能用", () => {
    render(<ShareGrantDialog target={target} online={false} onCancel={() => {}} onConfirm={async () => true} />);
    expect(screen.getByText(/小明 现在不在线，等 TA 上线才用得上。/)).toBeInTheDocument();
  });

  it("分享失败留在框里 —— 让人能改，而不是把输入连同弹窗一起吞掉", async () => {
    const onCancel = vi.fn();
    render(
      <ShareGrantDialog target={target} online onCancel={onCancel} onConfirm={async () => false} />
    );
    await userEvent.click(screen.getByText("分享并借出 2 项服务"));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("target 为 null 时什么都不画（没在问）", () => {
    const { container } = render(
      <ShareGrantDialog target={null} online onCancel={() => {}} onConfirm={async () => true} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
