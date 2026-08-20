import { describe, expect, it } from "vitest";
import { maskKey } from "../../src/shared/keyMask.js";

describe("maskKey", () => {
  it("长 key 露前 8 后 4", () => {
    expect(maskKey("sk-31cf5abcdefghijklmnopqrstuv828c")).toBe("sk-31cf5*****828c");
  });

  it("短一点的少露:一把 10 位的 key 露前 8 等于没遮", () => {
    expect(maskKey("sk-1234567")).toBe("sk-*****67");
  });

  it("太短的一点都不露", () => {
    expect(maskKey("sk-123")).toBe("*****");
  });

  it("空 = 没配,不是一串星", () => {
    expect(maskKey("")).toBe("");
    expect(maskKey("   ")).toBe("");
  });

  it("星星个数固定 —— 不按长度伸缩,免得把长度也送出去", () => {
    const short = maskKey("sk-aaaaaaaaaaaaaaaa");
    const long = maskKey(`sk-${"a".repeat(200)}zzzz`);
    expect(short.match(/\*/g)).toHaveLength(5);
    expect(long.match(/\*/g)).toHaveLength(5);
  });
});
