import { describe, it, expect, vi } from "vitest";
import { createOAuthProvider } from "../../src/main/mcpClient.js";
import type { McpAuthRecord } from "../../src/main/mcpAuthStore.js";

function harness(initial: McpAuthRecord = {}, over: { persistFlowState?: boolean } = {}) {
  let rec: McpAuthRecord = initial;
  const openBrowser = vi.fn();
  const provider = createOAuthProvider({
    redirectUri: "http://127.0.0.1:54321/callback",
    state: "state-abc",
    read: () => rec,
    write: (patch) => { rec = { ...rec, ...patch }; },
    openBrowser,
    ...over,
  });
  return { provider, openBrowser, current: () => rec };
}

describe("createOAuthProvider", () => {
  it("redirectUrl 跟着 loopback 走，clientMetadata 里也是同一个", () => {
    const { provider } = harness();
    expect(provider.redirectUrl).toBe("http://127.0.0.1:54321/callback");
    expect(provider.clientMetadata.redirect_uris).toEqual(["http://127.0.0.1:54321/callback"]);
  });

  it("公开客户端：token_endpoint_auth_method 是 none，靠 PKCE 而不是 secret", () => {
    const { provider } = harness();
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("none");
  });

  it("state() 返回 loopback 那一串——两端必须是同一个", () => {
    const { provider } = harness();
    expect(provider.state?.()).toBe("state-abc");
  });

  it("三个 save* 回调各存各的，互不擦除", async () => {
    const { provider, current } = harness();
    await provider.saveClientInformation?.({ client_id: "c1" });
    await provider.saveCodeVerifier("v1");
    await provider.saveTokens({ access_token: "a1", token_type: "Bearer" });
    expect(current()).toEqual({
      clientInformation: { client_id: "c1" },
      codeVerifier: "v1",
      tokens: { access_token: "a1", token_type: "Bearer" },
    });
  });

  it("读回来的就是存进去的", async () => {
    const { provider } = harness({
      clientInformation: { client_id: "c1" },
      tokens: { access_token: "a1", token_type: "Bearer" },
      codeVerifier: "v1",
    });
    expect(await provider.clientInformation()).toEqual({ client_id: "c1" });
    expect(await provider.tokens()).toEqual({ access_token: "a1", token_type: "Bearer" });
    expect(await provider.codeVerifier()).toBe("v1");
  });

  it("没存过的字段读出 undefined，不是空对象——SDK 靠 undefined 判断要不要注册", async () => {
    const { provider } = harness();
    expect(await provider.clientInformation()).toBeUndefined();
    expect(await provider.tokens()).toBeUndefined();
  });

  it("没有 code_verifier 时 codeVerifier() 抛人话，而不是把 undefined 喂给 SDK", async () => {
    const { provider } = harness();
    await expect(async () => provider.codeVerifier()).rejects.toThrow(/还没发起过授权/);
  });

  it("redirectToAuthorization 把浏览器打开到授权页", () => {
    const { provider, openBrowser } = harness();
    void provider.redirectToAuthorization(new URL("https://auth.example.com/authorize?x=1"));
    expect(openBrowser).toHaveBeenCalledWith("https://auth.example.com/authorize?x=1");
  });
});

// #471（相关问题那半）：`authed = tokens !== undefined` 时连接路径也带
// provider。token 过期且 refresh 失败时 SDK 会在连接路径上跑完整 auth()，
// 把盘上进行中授权的 codeVerifier 覆盖掉——用户点完同意，finishAuth 拿
// 新 verifier 去换旧 verifier 的 code，invalid_grant。连接路径的 provider
// 因此只许写 tokens（refresh 续期），flow-state 一律不落盘。
describe("createOAuthProvider：persistFlowState: false（连接路径，#471）", () => {
  it("saveCodeVerifier 是 no-op——不覆盖进行中授权的 verifier", async () => {
    const { provider, current } = harness({ codeVerifier: "授权中的-A" }, { persistFlowState: false });
    await provider.saveCodeVerifier("连接路径想写的-B");
    expect(current().codeVerifier).toBe("授权中的-A");
  });

  it("saveClientInformation 是 no-op——占位 redirect_uri 的注册不落盘", async () => {
    const { provider, current } = harness({ clientInformation: { client_id: "真的" } }, { persistFlowState: false });
    await provider.saveClientInformation?.({ client_id: "连接路径注册的" });
    expect(current().clientInformation).toEqual({ client_id: "真的" });
  });

  it("saveTokens 照常落盘——refresh 续上的 token 不能丢", async () => {
    const { provider, current } = harness({}, { persistFlowState: false });
    await provider.saveTokens({ access_token: "续上的", token_type: "Bearer" });
    expect(current().tokens).toEqual({ access_token: "续上的", token_type: "Bearer" });
  });

  it("缺省（不传）时 flow-state 照旧落盘——授权路径行为不变", async () => {
    const { provider, current } = harness();
    await provider.saveCodeVerifier("v1");
    expect(current().codeVerifier).toBe("v1");
  });
});
