// daemon.ts 进不了 vitest（import 即连 docker / Supabase）。回电（#1411）在它身上的接线，漏了都是安静的：
// 推送永远关着（工具不出现、没人发现）、isWatching 恒假（人正看着聊天也响铃）或恒真（永远不打）。
// 所以判据落在源码上（同 daemonActivityWiring.test.ts）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../services/runtime/src/daemon.ts", import.meta.url), "utf8");

describe("daemon.ts：回电的接线（#1411）", () => {
  it("配了 APNS_* 才造推送：.p8 启动时读一次，令牌表按 bundle 读", () => {
    expect(src).toMatch(/createApnsPusher\(/);
    expect(src).toMatch(/readFileSync\(apnsCfg\.keyFile, "utf8"\)/);
    expect(src).toMatch(/createSupabasePushDevices\(supabase, apnsCfg\.bundleId/);
  });
  it("每条会话的 callback：推送关着给 null；isWatching 读这个房间的在场名单 + frameHandler.uidOf", () => {
    expect(src).toMatch(/callback:\s*apns === null\s*\?\s*null/);
    expect(src).toMatch(/isWatching:\s*\(uid\)\s*=>\s*\[\.\.\.roster\]\.some\(\(cid\)\s*=>\s*frameHandler\.uidOf\(cid\)\s*===\s*uid\)/);
    expect(src).toMatch(/deviceCount:\s*\(uid\)\s*=>\s*apns\.deviceCount\(uid\)/);
    expect(src).toMatch(/push:\s*\(uid, ring\)\s*=>\s*apns\.pushRing\(uid, ring\)/);
    expect(src).not.toMatch(/callback: null, \/\/ 推送的接线在下一步/);
  });
  it("启动日志说清推送开没开", () => {
    expect(src).toMatch(/推送开着/);
    expect(src).toMatch(/推送关着/);
  });
});
