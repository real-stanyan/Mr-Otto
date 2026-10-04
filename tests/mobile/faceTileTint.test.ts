// 智能体头像底色（#1513）：手机端 FaceTile 用淡绿 FACE_TILE_BG（与浅色模式 bubbleAgent 同值），不再用纸白 DISC_COLOR；
// 桌面 paint.ts 不动。读源码钉住，避免下次有人把 DISC_COLOR 又接回来。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("FaceTile 底色", () => {
  it("用 FACE_TILE_BG = #d9e6dc，外框与脸后面那块方底同一个值；不再 import DISC_COLOR", () => {
    const src = read("mobile/src/wx/Avatar.tsx");
    expect(src).toMatch(/const FACE_TILE_BG = "#d9e6dc";/);
    expect(src).toMatch(/backgroundColor: FACE_TILE_BG/);
    expect(src).toMatch(/fill=\{FACE_TILE_BG\}/);
    expect(src).not.toMatch(/DISC_COLOR,/);
    expect(read("mobile/src/theme.ts")).toMatch(/bubbleAgent: "#d9e6dc"/);
  });
});
