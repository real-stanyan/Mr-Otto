// daemon.ts 进不了 vitest（import 即连 docker / Supabase）。消息推送（#1442）在它身上的接线漏了都是安静的：
// sessionService 的 alert 是可选的（缺席 = 一条都不推），朋友消息没人订就永远不响。判据落在源码上
// （同 daemonCallbackWiring.test.ts）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../services/runtime/src/daemon.ts", import.meta.url), "utf8");

describe("daemon.ts：消息推送的接线（#1442）", () => {
  it("notifier 读真库的开关，发 APNs 的普通通知", () => {
    expect(src).toMatch(/createNotifier\(\{\s*store: createSupabaseNotifyStore\(supabase\),\s*push: \(uid, p\) => apns\.pushAlert\(uid, p\)/);
  });
  it("朋友消息：订 messages、推给 notifier", () => {
    expect(src).toMatch(/createFriendPush\(\{\s*notifier,/);
    expect(src).toMatch(/subscribeFriendMessages\(supabase, \(raw\) => void friendPush\.onInsert\(raw\)/);
  });
  it("每条会话都接上 alert，且人正开着这条聊天就不推（同回电的在场判据）", () => {
    expect(src).toMatch(/alert: \(uid: string, kind: NotifyKind, p: AlertPush\) => \{\s*if \(\[\.\.\.roster\]\.some\(\(cid\) => frameHandler\.uidOf\(cid\) === uid\)\) return;\s*void withGroupTitle\(p, sessionTitles\)\.then\(\(q\) => notifier\.send\(uid, kind, q\)\);/);
  });
});
