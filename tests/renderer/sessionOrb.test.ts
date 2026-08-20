import { describe, expect, it } from "vitest";

import { orbLabel, orbState } from "../../src/renderer/src/lib/sessionOrb.js";

describe("侧栏小球 —— 这个会话此刻什么处境", () => {
  it("闲着就是闲着", () => {
    expect(orbState({ waiting: false, running: false })).toBe("idle");
  });

  it("turn 在跑", () => {
    expect(orbState({ waiting: false, running: true })).toBe("running");
  });

  it("等你点头压过在跑 —— 卡在审批上的会话一步都走不了，说「在忙」会让人不去管它", () => {
    expect(orbState({ waiting: true, running: true })).toBe("waiting");
  });

  it("没在跑也可能在等你（审批卡挂着、turn 已经停了）", () => {
    expect(orbState({ waiting: true, running: false })).toBe("waiting");
  });

  it("每种状态都有一句能读的话 —— 小球没有文字，这是它唯一的读法", () => {
    expect(orbLabel("waiting")).toBe("等你处理");
    expect(orbLabel("running")).toBe("运行中");
    expect(orbLabel("idle")).toBe("空闲");
  });
});
