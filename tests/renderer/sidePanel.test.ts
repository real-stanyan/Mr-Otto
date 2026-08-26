import { describe, expect, it } from "vitest";

import { PANEL_KEYS, panelFlags, panelKeyOf } from "../../src/renderer/src/lib/sidePanel.js";

describe("右侧槽位那一族面板的开关(issue #578)", () => {
  it("panelFlags 一次只点亮一块——互斥不再靠每个 action 手抄一遍", () => {
    for (const key of PANEL_KEYS) {
      const flags = panelFlags(key);
      const on = Object.entries(flags).filter(([, v]) => v === true);
      expect(on).toHaveLength(1);
    }
  });

  it("panelFlags(null) = 槽位空着,一块都不开", () => {
    const flags = panelFlags(null);
    expect(Object.values(flags).some((v) => v === true)).toBe(false);
  });

  it("panelFlags 顺带把同槽位的邻居(设置页 / DM)让开", () => {
    expect(panelFlags("files").settingsSection).toBeNull();
    expect(panelFlags("files").friendChat).toBeNull();
  });

  it("panelKeyOf 是 panelFlags 的逆:开哪块 → 认出哪块", () => {
    for (const key of PANEL_KEYS) expect(panelKeyOf(panelFlags(key))).toBe(key);
    expect(panelKeyOf(panelFlags(null))).toBeNull();
  });

  it("万一有两块同时为 true,认出来的那块 = 渲染端会画的那块(同序,不各说各话)", () => {
    // 渲染端那串三元把 browser 排在 files 前面,这里也必须给 browser
    const both = { ...panelFlags("files"), browserPanelOpen: true };
    expect(panelKeyOf(both)).toBe("browser");
  });
});
