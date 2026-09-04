import { describe, expect, it } from "vitest";

import { UNTITLED_SESSION_TITLE, displaySessionTitle } from "../../src/shared/sessionTitle.js";

describe("displaySessionTitle", () => {
  it("有标题就用标题", () => {
    expect(displaySessionTitle("看看我 Square 店铺里今天的单")).toBe("看看我 Square 店铺里今天的单");
  });

  it("null / undefined 用兜底", () => {
    expect(displaySessionTitle(null)).toBe(UNTITLED_SESSION_TITLE);
    expect(displaySessionTitle(undefined)).toBe(UNTITLED_SESSION_TITLE);
  });

  // 云会话那张表的 title 是 string 不是 string | null：落库时没有标题就是空串，
  // 只挡 null 的话它照旧在侧栏画出一格空白（#925 截图里那条灰条）
  it("空串和纯空白都算没有标题", () => {
    expect(displaySessionTitle("")).toBe(UNTITLED_SESSION_TITLE);
    expect(displaySessionTitle("   ")).toBe(UNTITLED_SESSION_TITLE);
    expect(displaySessionTitle("\n\t ")).toBe(UNTITLED_SESSION_TITLE);
  });

  it("两头的空白削掉，中间的留着", () => {
    expect(displaySessionTitle("  帮我看看  订单  ")).toBe("帮我看看  订单");
  });
});
