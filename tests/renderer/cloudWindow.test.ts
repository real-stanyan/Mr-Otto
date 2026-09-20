// 聊天页窗口化的纯逻辑（#1280）。DOM 那半边（哨兵命中、滚动补偿、跟底让路）
// 在 jsdom 里钉不住（没有布局、没有 IntersectionObserver），保鲜期在紧挨代码
// 的注释里——同 ADR-0236 第 1 条 / ADR-0285 的取舍。

import { describe, expect, it } from "vitest";
import { GROW_STEP, INITIAL_WINDOW, initialHidden, nextOlderAction, visibleCloudRows } from "../../src/renderer/src/lib/cloudWindow.js";

describe("nextOlderAction（#1280）", () => {
  it("内存里还有没挂的：先补挂，不打网络", () => {
    expect(nextOlderAction({ hidden: 40, hasOlder: true, older: "idle" })).toBe("grow");
    // 正在拉、或者已经到头，都不影响「先把手上的画完」
    expect(nextOlderAction({ hidden: 40, hasOlder: false, older: "loading" })).toBe("grow");
  });

  it("挂完了、云端还有：拉上一页", () => {
    expect(nextOlderAction({ hidden: 0, hasOlder: true, older: "idle" })).toBe("fetch");
  });

  it("正在拉 / 到头了：不动", () => {
    expect(nextOlderAction({ hidden: 0, hasOlder: true, older: "loading" })).toBe("none");
    expect(nextOlderAction({ hidden: 0, hasOlder: false, older: "idle" })).toBe("none");
  });

  it("上一次失败了：哨兵不自己重试（那是一颗要人点的钮）", () => {
    expect(nextOlderAction({ hidden: 0, hasOlder: true, older: "failed" })).toBe("none");
  });
});

describe("窗口与本机同一把尺子（#1280）", () => {
  it("短列表完全不开窗；长列表只留后缀 INITIAL_WINDOW 条", () => {
    expect(initialHidden(10)).toBe(0);
    expect(initialHidden(300)).toBe(300 - INITIAL_WINDOW);
  });

  it("visibleCloudRows 就是那个后缀；hidden ≤ 0 时原样返回（调用方按引用判重）", () => {
    const rows = Array.from({ length: 10 }, (_, i) => i);
    expect(visibleCloudRows(rows, 0)).toBe(rows);
    expect(visibleCloudRows(rows, 7)).toEqual([7, 8, 9]);
  });

  it("步进是本机那一份，不另拍一个数", () => {
    expect(GROW_STEP).toBe(INITIAL_WINDOW);
  });
});
