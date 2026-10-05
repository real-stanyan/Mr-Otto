// 主页下拉应用抽屉（#1648）的纯逻辑：最近使用怎么记、怎么排、搜索。
import { describe, expect, it } from "vitest";
import { RECENT_APPS_MAX, parseRecent, recentApps, searchApps, touchRecent } from "../../src/shared/appsDrawer.js";
import type { AppRow } from "../../src/shared/apps.js";

const app = (id: string, name: string, description = ""): AppRow => ({ id, workspaceId: "w", ownerUid: "u", slug: id, name, icon: "📝", description, currentVersion: 1, createdByAgent: "a", updatedTs: 0 });

describe("appsDrawer", () => {
  it("touchRecent：放最前、去重、封顶", () => {
    expect(touchRecent(["a", "b"], "b")).toEqual(["b", "a"]);
    expect(touchRecent(Array.from({ length: RECENT_APPS_MAX }, (_, i) => `x${i}`), "new")).toHaveLength(RECENT_APPS_MAX);
  });
  it("recentApps：按记的顺序，删掉的不画", () => {
    expect(recentApps(["b", "gone", "a"], [app("a", "A"), app("b", "B")]).map((a) => a.id)).toEqual(["b", "a"]);
  });
  it("searchApps：名字或说明里含，不分大小写", () => {
    const all = [app("a", "日历记事本", "带月历"), app("b", "Budget", "记账")];
    expect(searchApps(all, "月历").map((a) => a.id)).toEqual(["a"]);
    expect(searchApps(all, "budget").map((a) => a.id)).toEqual(["b"]);
    expect(searchApps(all, " ")).toHaveLength(2);
  });
  it("parseRecent：形状不对当空", () => {
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent("{")).toEqual([]);
    expect(parseRecent(JSON.stringify(["a", 1, "b"]))).toEqual(["a", "b"]);
  });
});
