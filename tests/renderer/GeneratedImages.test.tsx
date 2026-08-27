// @vitest-environment jsdom
//
// 「图真的画出来了吗」（#594 / ADR-0144）。
//
// 上游那张卡从头到尾没有 <img>（完成态画的是一坨写死的渐变），本仓改动 ② 的
// 全部意义就是把真图放进去——而"有没有 <img>、src 对不对"恰恰是纯函数测不到的
// 那一半：generatedImagesOf 全绿只证明 ref 抠对了，证明不了它变成了一张图。
//
// 三档各盯一条：还没读回来 / 读回来了 / 附件库那份文件丢了。第三档尤其要盯——
// 它的错误表现是"界面上凭空少一块"，而日志里明明记着这次产出过一张图。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { GeneratedImages } from "../../src/renderer/src/components/GeneratedImages.js";

afterEach(() => cleanup());

const DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

/** 只钉这一条：GeneratedImages 经 useAttachmentUrls 只用得到它 */
function stubAttachmentDataUrl(impl: (id: string) => Promise<string>) {
  (window as unknown as { otter: unknown }).otter = { attachmentDataUrl: vi.fn(impl) };
}

describe("GeneratedImages", () => {
  it("data URL 回来之后，页面上是一张真的 <img>，src 就是那份 data URL", async () => {
    stubAttachmentDataUrl(async () => DATA_URL);
    render(<GeneratedImages images={[{ id: "sha256:a", caption: "一只水獭" }]} />);

    const img = await screen.findByAltText("一只水獭");
    expect(img).toHaveAttribute("src", DATA_URL);
    // 说明文字也要在：那行字是这张图的出处
    expect(screen.getByText("一只水獭")).toBeInTheDocument();
  });

  it("还没读回来时不给 src —— 占位守住位置，不出半张破图", () => {
    stubAttachmentDataUrl(() => new Promise(() => {}));
    render(<GeneratedImages images={[{ id: "sha256:b", caption: "等着" }]} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("等着")).toBeInTheDocument();
  });

  it("附件库那份文件丢了：画一张空框 + 一行说明，不是凭空少一块", async () => {
    stubAttachmentDataUrl(async () => {
      throw new Error("ENOENT");
    });
    render(<GeneratedImages images={[{ id: "sha256:c", caption: "丢了的那张" }]} />);

    await waitFor(() => expect(screen.getByText("图片文件已丢失")).toBeInTheDocument());
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("丢了的那张")).toBeInTheDocument();
  });

  it("一张图都没有时整个不渲染", () => {
    stubAttachmentDataUrl(async () => DATA_URL);
    const { container } = render(<GeneratedImages images={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
