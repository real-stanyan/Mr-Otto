import { describe, expect, it } from "vitest";
import { catalogIcon, iconPaint, serverIcon } from "../../src/shared/appIcon.js";
import { connectCatalog, phoneAppRows } from "../../src/shared/mobileConnectors.js";

describe("appIcon", () => {
  it("目录条目按 id 给图标键；目录外的给 null", () => {
    expect(catalogIcon("github")).toBe("github");
    expect(catalogIcon("没有这一条")).toBeNull();
  });

  it("电脑上接的那一行：先按 serverId 认，再按显示名认（不分大小写），都对不上不猜", () => {
    expect(serverIcon("notion", "随便什么名字")).toBe("notion");
    expect(serverIcon("my-gh", "GitHub")).toBe("github");
    expect(serverIcon("my-own-server", "内部工具")).toBeNull();
    expect(serverIcon("my-own-server", "  ")).toBeNull();
  });

  it("上色档：纯黑的标走 mono，品牌色的照原样", () => {
    expect(iconPaint("github")).toBe("mono");
    expect(iconPaint("supabase")).toBe("color");
  });

  it("手机上的两份视图都带着图标键", () => {
    const items = connectCatalog(null, "").flatMap((g) => g.items);
    expect(items.find((i) => i.id === "github")?.icon).toBe("github");
    const [row] = phoneAppRows(
      [{ serverId: "cloud-notion", catalogId: "notion", status: "ok", tools: [], grants: [], connectedTs: 0 }],
      null
    );
    expect(row?.icon).toBe("notion");
  });
});
