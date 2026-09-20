import { describe, expect, it } from "vitest";
import { createDecisionClient } from "../../src/main/decisionClient.js";
import { noul } from "../../src/shared/decision.js";
import type { BillingMe } from "../../src/shared/billing.js";

const ME = (uses: Record<string, "shadow" | "on">, models = ["jev-1.13"]): BillingMe => ({
  plan: "pro", status: "active", plans: [], windows: null, addon: { remainingMicro: 0, expiresAt: null }, periodEnd: null,
  models: ["cheap", "strong"], imageModels: [], ttsModels: [], modelPlatforms: {}, decision: { models, uses },
});
function rig(o: { me: BillingMe | null; subscribed?: boolean; exhausted?: boolean; token?: string | null; res?: () => Response }) {
  const noted: { headers: number; exhausted: unknown[] } = { headers: 0, exhausted: [] };
  const seen: Request[] = [];
  const client = createDecisionClient({
    quota: {
      snapshot: () => ({ me: o.me, fetchedAt: 0, exhausted: null }),
      routeInput: () => ({ subscribed: o.subscribed ?? true, exhausted: o.exhausted ?? false, supportsModel: false }),
      noteHeaders: () => { noted.headers++; },
      noteExhausted: (i) => { noted.exhausted.push(i); },
    },
    edgeBaseUrl: () => "https://edge",
    accessToken: async () => (o.token === undefined ? "jwt" : o.token),
    fetchImpl: (async (i: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(i, init));
      return (o.res ?? (() => Response.json({ model: "jev-1.13.0", answers: { q: { type: "noul", noul: 0.4 } } })))();
    }) as typeof fetch,
  });
  return { client, seen, noted };
}
const Q = { q: noul("问", "是", "否") };

describe("decisionClient.mode：任何一格不过都是 off", () => {
  it("没快照 / 没订阅 / 额度用完 / 网关不供 / 这一处没列", () => {
    expect(rig({ me: null }).client.mode("auto")).toBe("off");
    expect(rig({ me: ME({ auto: "on" }), subscribed: false }).client.mode("auto")).toBe("off");
    expect(rig({ me: ME({ auto: "on" }), exhausted: true }).client.mode("auto")).toBe("off");
    expect(rig({ me: ME({ auto: "on" }, []) }).client.mode("auto")).toBe("off");
    expect(rig({ me: ME({ dispatch: "on" }) }).client.mode("auto")).toBe("off");
  });
  it("都过了：回那一档", () => {
    expect(rig({ me: ME({ auto: "shadow" }) }).client.mode("auto")).toBe("shadow");
  });
});

describe("decisionClient.decide", () => {
  it("off：一个字节都不发", async () => {
    const r = rig({ me: ME({}) });
    expect(await r.client.decide("auto", "x", Q, 100)).toBeNull();
    expect(r.seen).toHaveLength(0);
  });
  it("拿不到 JWT：不发空 Bearer", async () => {
    const r = rig({ me: ME({ auto: "on" }), token: null });
    expect(await r.client.decide("auto", "x", Q, 100)).toBeNull();
    expect(r.seen).toHaveLength(0);
  });
  it("成功：带用户 JWT 打 /llm/v1/decision，型号取快照里那一款，记额度头", async () => {
    const r = rig({ me: ME({ auto: "on" }) });
    const reply = await r.client.decide("auto", { request: "你好" }, Q, 100);
    expect(reply?.answers.q).toEqual({ type: "noul", noul: 0.4 });
    expect(r.seen[0]!.url).toBe("https://edge/llm/v1/decision");
    expect(r.seen[0]!.headers.get("authorization")).toBe("Bearer jwt");
    expect(await r.seen[0]!.json()).toMatchObject({ model: "jev-1.13", use: "auto" });
    expect(r.noted.headers).toBe(1);
  });
  it("429 quota_exhausted：记 noteExhausted（界面上那枚环跟着动），回 null", async () => {
    const r = rig({
      me: ME({ auto: "on" }),
      res: () => new Response(JSON.stringify({ error: { message: "5 小时额度已用完", type: "otto_edge", code: "quota_exhausted", window: "5h", resetAt: 123 } }), { status: 429 }),
    });
    expect(await r.client.decide("auto", "x", Q, 100)).toBeNull();
    expect(r.noted.exhausted).toEqual([{ window: "5h", resetAt: 123 }]);
  });
});
