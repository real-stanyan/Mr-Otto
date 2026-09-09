// @vitest-environment jsdom
//
// DialogContent / AlertDialogContent 的溢出兜底(#998,ADR-0279)。
// 这个失败模式是静默的:超高不报错、只是画到卡片外且滑不动,jsdom 量不出布局,
// 所以这里钉的是**契约的字面量**——兜底类必须在,且消费方自己的 max-h 必须能赢
// (twMerge 后写胜出,TrajectoryView 的 85vh / MemorySettings 的 4rem 都靠这一条)。

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { Dialog, DialogContent, DialogTitle } from "../../src/renderer/src/components/ui/dialog.js";
import { AlertDialog, AlertDialogContent, AlertDialogTitle } from "../../src/renderer/src/components/ui/alert-dialog.js";

afterEach(cleanup);

function dialogContent(): HTMLElement {
  const el = document.querySelector('[data-slot="dialog-content"]');
  expect(el, "DialogContent 没渲染出来").not.toBeNull();
  return el as HTMLElement;
}

function alertDialogContent(): HTMLElement {
  const el = document.querySelector('[data-slot="alert-dialog-content"]');
  expect(el, "AlertDialogContent 没渲染出来").not.toBeNull();
  return el as HTMLElement;
}

describe("DialogContent 溢出兜底(#998)", () => {
  it("默认带 flex-col + max-h + overflow-y-auto——什么都不写的消费方整张卡可滚", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>标题</DialogTitle>
          <p>内容</p>
        </DialogContent>
      </Dialog>
    );
    const el = dialogContent();
    expect(el).toHaveClass("flex", "flex-col");
    expect(el).toHaveClass("max-h-[calc(100dvh-2rem)]", "overflow-y-auto");
    expect(el).not.toHaveClass("grid");
    // 宽度那条老兜底不许被这次改动挤掉(#563 修的是它)
    expect(el.className).toContain("[&>*]:min-w-0");
  });

  it("消费方自己的 max-h 赢过兜底——固定头尾那批弹窗靠这条活", () => {
    render(
      <Dialog open>
        <DialogContent className="max-h-[85vh]">
          <DialogTitle>标题</DialogTitle>
          <p>内容</p>
        </DialogContent>
      </Dialog>
    );
    const el = dialogContent();
    expect(el).toHaveClass("max-h-[85vh]");
    expect(el.className).not.toContain("100dvh-2rem");
  });
});

describe("AlertDialogContent 溢出兜底(#998)", () => {
  it("与 DialogContent 同一条兜底", () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>标题</AlertDialogTitle>
          <p>内容</p>
        </AlertDialogContent>
      </AlertDialog>
    );
    const el = alertDialogContent();
    expect(el).toHaveClass("flex", "flex-col");
    expect(el).toHaveClass("max-h-[calc(100dvh-2rem)]", "overflow-y-auto");
    expect(el).not.toHaveClass("grid");
  });
});
