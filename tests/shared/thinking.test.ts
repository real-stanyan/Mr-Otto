import { describe, expect, it } from "vitest";

import {
  clampThinking,
  thinkingSwitchable,
  THINKING_EFFORT,
  THINKING_EFFORT_ALWAYS,
  THINKING_EFFORT_MAX,
  THINKING_FLAG,
  THINKING_NONE,
  type ThinkingMode,
  type ThinkingSpec,
} from "../../src/shared/thinking.js";
import { describeModel, MODEL_CATALOG } from "../../src/shared/modelCatalog.js";

describe("clampThinking —— 换型号时手上那一档落到哪", () => {
  it("新型号有这一档就原样留着 —— 用户刚调好的别替他改", () => {
    expect(clampThinking("high", THINKING_EFFORT)).toBe("high");
    expect(clampThinking("off", THINKING_FLAG)).toBe("off");
  });

  it("二选一的开 → 有档位的中档（强度就近，不是一律回默认）", () => {
    expect(clampThinking("on", THINKING_EFFORT)).toBe("medium");
  });

  it("高 → 二选一的型号只有开", () => {
    expect(clampThinking("high", THINKING_FLAG)).toBe("on");
  });

  it("关不掉思考的型号：想关也只能给最省的一档", () => {
    expect(clampThinking("off", THINKING_EFFORT_ALWAYS)).toBe("low");
  });

  it("想思考的人不该拿到「关」—— 就近算出来是关也不行", () => {
    // {关, 高} 里按纯距离，"低"离"关"更近；但用户要的是思考
    const sparse: ThinkingSpec = { wire: "effort", modes: ["off", "high"], default: "high" };
    expect(clampThinking("low", sparse)).toBe("high");
  });

  it("没有挡位表的型号一律 off —— 这个值不会参与请求", () => {
    expect(clampThinking("high", THINKING_NONE)).toBe("off");
  });

  it("Ollama 的 max 换到别家 → 落到那家最强的一档,而不是回默认", () => {
    // max 只有 Ollama 有(docs.ollama.com/capabilities/thinking),
    // 换去 OpenAI 这类只有三档的型号时,"顶"最近的是"高"
    expect(clampThinking("max", THINKING_EFFORT)).toBe("high");
    expect(clampThinking("max", THINKING_FLAG)).toBe("on");
  });

  it("别家的高换到 Ollama 仍是高 —— 不会被 max 抢走(有原档就不动)", () => {
    expect(clampThinking("high", THINKING_EFFORT_MAX)).toBe("high");
  });
});

describe("thinkingSwitchable", () => {
  it("一档 = 型号自己说了算，零档 = 没有这回事，两种都不给点", () => {
    expect(thinkingSwitchable(THINKING_NONE)).toBe(false);
    expect(thinkingSwitchable({ wire: "none", modes: ["on"], default: "on" })).toBe(false);
    expect(thinkingSwitchable(THINKING_FLAG)).toBe(true);
  });
});

describe("认不出的档位", () => {
  // 回归：dev 下渲染进程先热更、主进程还跑旧代码，主进程就会收到一个自己
  // 不认识的档。旧实现拿它算距离得到 NaN，NaN 比较恒为 false，"就近"
  // 一路落到候选里的第一个 —— 用户点「顶」，界面跳「低」
  it("落默认档，不落最弱的那一档", () => {
    const unknown = "ultra" as ThinkingMode;
    expect(clampThinking(unknown, THINKING_EFFORT)).toBe("medium");
    expect(clampThinking(unknown, THINKING_FLAG)).toBe("on");
  });

  it("默认档也不在表里时才退回第一档", () => {
    const spec: ThinkingSpec = { wire: "effort", modes: ["low", "high"], default: "medium" };
    expect(clampThinking("ultra" as ThinkingMode, spec)).toBe("low");
  });
});

describe("目录里的挡位表自洽", () => {
  it("默认档必须在自己的挡位表里 —— 否则开局就是个表外值", () => {
    for (const m of MODEL_CATALOG) {
      if (m.thinking.modes.length === 0) continue;
      expect(m.thinking.modes, m.model).toContain(m.thinking.default);
    }
  });

  it("没有挡位的型号方言必须是 none —— 不然会发一个对方不认的字段", () => {
    for (const m of MODEL_CATALOG) {
      if (m.thinking.modes.length === 0) expect(m.thinking.wire, m.model).toBe("none");
    }
  });

  it("effort 方言里不出现 on —— on 是二选一那派的说法", () => {
    for (const m of MODEL_CATALOG) {
      if (m.thinking.wire === "effort") expect(m.thinking.modes, m.model).not.toContain("on");
    }
  });

  it("目录外的 id 认不出挡位 = 一个字段都不发", () => {
    expect(describeModel("某个没见过的型号")).toBeUndefined();
  });
});
