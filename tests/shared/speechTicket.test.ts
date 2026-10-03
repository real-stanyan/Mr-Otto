// tests/shared/speechTicket.test.ts
import { describe, expect, it } from "vitest";
import { signSpeechTicket, verifySpeechTicket } from "../../src/shared/speechTicket.js";

const t = { ownerUid: "11111111-1111-4111-8111-111111111111", peerUid: "22222222-2222-4222-8222-222222222222", workspaceId: "w", sessionId: "s", exp: 2000 };

describe("speechTicket.js", () => {
  it("签了能验回原样", async () => {
    expect(await verifySpeechTicket(await signSpeechTicket(t, "k"), "k", t.peerUid, 1000)).toEqual(t);
  });
  it("口令不对 / 过期 / 不是那个人 / 被改过 / 形状不对 → null", async () => {
    const raw = await signSpeechTicket(t, "k");
    expect(await verifySpeechTicket(raw, "other", t.peerUid, 1000)).toBeNull();
    expect(await verifySpeechTicket(raw, "k", t.peerUid, 2000)).toBeNull();
    expect(await verifySpeechTicket(raw, "k", t.ownerUid, 1000)).toBeNull();
    const [p, sig] = raw.split(".");
    expect(await verifySpeechTicket(`${p}x.${sig}`, "k", t.peerUid, 1000)).toBeNull();
    expect(await verifySpeechTicket("garbage", "k", t.peerUid, 1000)).toBeNull();
    expect(await verifySpeechTicket("", "k", t.peerUid, 1000)).toBeNull();
  });
});
