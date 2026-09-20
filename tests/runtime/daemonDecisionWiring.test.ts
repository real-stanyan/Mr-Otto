// daemon.ts 进不了 vitest（import 即连 docker / Supabase），而三处决策前置的接线全在它
// 身上：漏接一处的失败模式是**安静的**——那一处永远走原来那条路，没有任何一条测试会红。
// 所以判据落在源码上（同 tests/runtime/sandbox.test.ts 对 freeKib 的处置）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../services/runtime/src/daemon.ts", import.meta.url), "utf8");

describe("daemon.ts：三处决策前置都接上了（#1281）", () => {
  it.each(["dispatch", "auto", "title"])("读了「%s」这一处的开关", (use) => {
    expect(src).toContain(`modeOf(me, "${use}")`);
  });
  it("型号从同一份 /me 快照里取，不写死", () => {
    expect(src).toContain("decisionModelOf(me)");
    expect(src).not.toMatch(/["']jev-/);
  });
  it("派活走 dispatchVia，且 LLM 那条路仍然是 requestDispatchAsOwner", () => {
    expect(src).toMatch(/dispatchVia\(\{[\s\S]*?llm:\s*\(\)\s*=>\s*requestDispatchAsOwner\(/);
  });
});

it("sessionService.ts 不认识决策模型（只在 daemon 的注入点包一层，#1280 的约定）", () => {
  const svc = readFileSync(new URL("../../services/runtime/src/sessionService.ts", import.meta.url), "utf8");
  expect(svc).not.toMatch(/shared\/decision\.js|dispatchDecision|decisionOwner/);
});
