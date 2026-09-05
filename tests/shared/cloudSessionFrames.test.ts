import { describe, it, expect } from "vitest";
import { encodeCs, decodeCsUp } from "../../src/shared/remote/cloudSession.js";

/** 帧走 base64（encodeCs 的格式），不是裸 JSON。畸形用例编不出来，手工造一条 */
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");

describe("cs_say 的 mentions（#928 切片 1a）", () => {
  it("带 mentions 解得出来", () => {
    const frame = encodeCs({ t: "say", text: "@运营 看下销量", mention: true, mentions: ["ops"] });
    expect(decodeCsUp(frame)).toEqual({ t: "say", text: "@运营 看下销量", mention: true, mentions: ["ops"] });
  });

  it("不带 mentions 照常解 —— 手机端和旧桌面还在发布尔那一版", () => {
    expect(decodeCsUp(encodeCs({ t: "say", text: "在吗", mention: true })))
      .toEqual({ t: "say", text: "在吗", mention: true });
  });

  it("mentions 不是字符串数组就整帧拒掉,不是悄悄丢字段", () => {
    expect(decodeCsUp(b64({ t: "say", text: "x", mention: true, mentions: [1, 2] }))).toBeNull();
    expect(decodeCsUp(b64({ t: "say", text: "x", mention: true, mentions: "ops" }))).toBeNull();
  });
});
