import { describe, expect, it } from "vitest";
import {
  decodeProxyFrame,
  encodeProxyFrame,
  grantAllows,
  grantDenyReason,
  PROXY_FRAME_VERSION,
  type ProxyGrant,
  type ProxyRequest,
} from "../../../src/shared/remote/proxyProtocol.js";

const GRANT: ProxyGrant = {
  friendUid: "uid-b",
  allow: [
    { serverId: "shopify", tools: [] },                 // 整个 shopify 放行
    { serverId: "google-ads", tools: ["get_campaigns"] } // google-ads 只放行读
  ],
};

function req(over: Partial<ProxyRequest> = {}): ProxyRequest {
  return {
    kind: "proxy_req", v: PROXY_FRAME_VERSION, reqId: "r1",
    fromUid: "uid-b", serverId: "shopify", tool: "update_product", args: { id: 1 },
    ...over,
  };
}

describe("代理帧编解码", () => {
  it("三帧 encode→decode 往返", () => {
    const r = req();
    expect(decodeProxyFrame(encodeProxyFrame(r))).toEqual(r);
    const res = { kind: "proxy_res", v: PROXY_FRAME_VERSION, reqId: "r1", ok: true, content: [] as unknown[] } as const;
    expect(decodeProxyFrame(encodeProxyFrame(res))).toEqual(res);
    const cancel = { kind: "proxy_cancel", v: PROXY_FRAME_VERSION, reqId: "r1" } as const;
    expect(decodeProxyFrame(encodeProxyFrame(cancel))).toEqual(cancel);
  });

  it("坏帧回 null 不抛（盲管道可能被截断）", () => {
    expect(decodeProxyFrame("not json")).toBeNull();
    expect(decodeProxyFrame("{}")).toBeNull();
    expect(decodeProxyFrame(JSON.stringify({ kind: "proxy_req", v: 999, reqId: "x" }))).toBeNull(); // 版本不对
    expect(decodeProxyFrame(JSON.stringify({ kind: "proxy_req", v: 1, reqId: "x" }))).toBeNull(); // 缺 fromUid/serverId/tool
    expect(decodeProxyFrame(JSON.stringify({ kind: "nope", v: 1, reqId: "x" }))).toBeNull();
  });
});

describe("白名单策略 grantAllows", () => {
  it("整个服务放行（tools 空）", () => {
    expect(grantAllows(GRANT, req({ tool: "update_product" }))).toBe(true);
    expect(grantAllows(GRANT, req({ tool: "delete_product" }))).toBe(true);
  });

  it("点名工具才放行（读/写由粒度决定）", () => {
    expect(grantAllows(GRANT, req({ serverId: "google-ads", tool: "get_campaigns" }))).toBe(true);
    expect(grantAllows(GRANT, req({ serverId: "google-ads", tool: "update_campaign" }))).toBe(false);
  });

  it("圈外一律拒：非授权好友 / 未授权服务", () => {
    expect(grantAllows(GRANT, req({ fromUid: "uid-stranger" }))).toBe(false);
    expect(grantAllows(GRANT, req({ serverId: "stripe" }))).toBe(false);
    expect(grantAllows(null, req())).toBe(false);
  });

  it("拒绝原因是人话", () => {
    expect(grantDenyReason(null, req())).toContain("没有为你开通");
    expect(grantDenyReason(GRANT, req({ serverId: "stripe" }))).toContain("stripe");
    expect(grantDenyReason(GRANT, req({ serverId: "google-ads", tool: "update_campaign" }))).toContain("update_campaign");
  });
});
