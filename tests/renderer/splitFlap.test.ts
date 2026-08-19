import { describe, expect, it } from "vitest";
import { FLAP_FRAMES, FLAP_STAGGER, splitFlapFrame, splitFlapTotalTicks } from "../../src/renderer/src/lib/splitFlap.js";

const CS = "0123456789,";

describe("splitFlapFrame", () => {
  it("tick 0 显示旧值(不足位补空格),翻满显示新值", () => {
    expect(splitFlapFrame("300", "1,200", 0, CS)).toBe("300  ");
    expect(splitFlapFrame("300", "1,200", splitFlapTotalTicks("1,200"), CS)).toBe("1,200");
  });

  it("没变的位原地不动,不参与翻动", () => {
    // "1,300" -> "1,500":只有第 3 位(3->5)变
    for (let t = 0; t <= splitFlapTotalTicks("1,500"); t++) {
      const frame = splitFlapFrame("1,300", "1,500", t, CS);
      expect(frame.slice(0, 2)).toBe("1,");
      expect(frame.slice(3)).toBe("00");
    }
  });

  it("从左到右一列列落定:靠前的位先停", () => {
    const from = "000";
    const to = "999";
    // 第 0 位翻满时,最后一位还没翻满
    const t = FLAP_FRAMES;
    const frame = splitFlapFrame(from, to, t, CS);
    expect(frame[0]).toBe("9");
    expect(frame[2]).not.toBe("9");
    expect(splitFlapTotalTicks(to)).toBe(2 * FLAP_STAGGER + FLAP_FRAMES);
  });

  it("翻动中的字符全部来自字符集,不会蹦出乱码", () => {
    for (let t = 1; t < splitFlapTotalTicks("88,888"); t++) {
      for (const ch of splitFlapFrame("1,234", "88,888", t, CS)) {
        expect(CS.includes(ch) || ch === " ").toBe(true);
      }
    }
  });
});
