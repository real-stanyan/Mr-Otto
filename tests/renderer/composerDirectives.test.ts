import { describe, expect, it } from "vitest";
import { segmentComposerText } from "../../src/renderer/src/aui/composerDirectives.js";
import { ottoDirectiveFormatter, ottoSlashFormatter } from "../../src/renderer/src/aui/ottoDirectives.js";

const fs = [ottoDirectiveFormatter(["review"]), ottoSlashFormatter(["compact"])];

describe("segmentComposerText", () => {
  it("两套 formatter 串起来,各认各的", () => {
    expect(segmentComposerText("$review 再 /compact", fs)).toEqual([
      { kind: "mention", type: "skill", label: "$review", id: "review" },
      { kind: "text", text: " 再 " },
      { kind: "mention", type: "command", label: "/compact", id: "compact" },
    ]);
  });
  it("没命中就原样一段", () => {
    expect(segmentComposerText("hi", fs)).toEqual([{ kind: "text", text: "hi" }]);
  });
});
