// daemon.ts 进不了 vitest（import 即连 docker / Supabase）。健康通道（#1656）在它身上的接线漏了是安静的：
// frameHandler 与 sessionService 的 health 都是可选的，漏接 = read_health 永远不亮、caps 照收照丢。判据落在源码上。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../services/runtime/src/daemon.ts", import.meta.url), "utf8");

describe("daemon.ts：Apple 健康的接线（#1656）", () => {
  it("建一个 broker，发帧走 globalSend", () => {
    expect(src).toMatch(/const healthBroker = createHealthBroker\(\{ send: globalSend \}\);/);
  });
  it("frameHandler 与每条会话都接上同一个 broker", () => {
    expect(src.match(/health: healthBroker,/g)?.length).toBe(2);
  });
});
