import { describe, expect, it } from "vitest";
import { createPxCloudGrant } from "../../src/main/pxCloudGrant.js";

describe("createPxCloudGrant", () => {
  it("带 JWT POST；非 2xx 抛 edge 的原话", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const ok = createPxCloudGrant({
      baseUrl: () => "https://e", accessToken: async () => "jwt",
      fetchImpl: (async (url: string, init: RequestInit) => { seen.push({ url, init }); return new Response('{"ok":true}', { status: 200 }); }) as typeof fetch,
    });
    await ok("ws", "cloud-x", false);
    expect(seen[0]!.url).toBe("https://e/px/v1/cloud/grant");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ serverId: "cloud-x", workspaceId: "ws", on: false });
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer jwt");
    const bad = createPxCloudGrant({
      baseUrl: () => "https://e", accessToken: async () => "jwt",
      fetchImpl: (async () => new Response(JSON.stringify({ error: { message: "你不在这个团队里", type: "otto_edge", code: "not_member" } }), { status: 403 })) as typeof fetch,
    });
    await expect(bad("ws", "cloud-x", true)).rejects.toThrow("你不在这个团队里");
    const noAuth = createPxCloudGrant({ baseUrl: () => "https://e", accessToken: async () => null });
    await expect(noAuth("ws", "cloud-x", false)).rejects.toThrow("还没登录");
  });
});
