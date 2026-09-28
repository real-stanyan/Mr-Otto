// mobile/src/activity/ActivityFace.tsx 的可执行版（#1282）。RN 组件进不了 vitest（仓里没有 RN 渲染 harness），
// 而这一格错了不报错：没有状态行的智能体（没跑过、0044 与 runtime 部署之前）在资料页上那张大脸
// 从 alive 安静地退成静止。所以读源码钉住它（同 daemon.ts 那几条接线断言的做法）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../mobile/src/activity/ActivityFace.tsx", import.meta.url), "utf8");

describe("ActivityFace", () => {
  it("不知道的时候画法同闲着：列表里静止、资料页那张大脸 alive（alive 不声称任何状态，ADR-0317 第 3 条）", () => {
    expect(src).toContain('state={activityFace(activity ?? "idle", idle)}');
  });
});
