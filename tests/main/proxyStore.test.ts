import { describe, expect, it } from "vitest";
import {
  appendAudit,
  AUDIT_CAP,
  emptyProxyStore,
  grantFor,
  parseProxyStore,
  revokeGrant,
  serializeProxyStore,
  setGrant,
  type ProxyAuditRecord,
} from "../../src/main/proxyStore.js";
import type { ProxyGrant } from "../../src/shared/remote/proxyProtocol.js";

const G1: ProxyGrant = { friendUid: "b1", allow: [{ serverId: "shopify", tools: ["get_orders"] }] };
const G2: ProxyGrant = { friendUid: "b2", allow: [{ serverId: "google-ads", tools: [] }] };

function audit(n: number): ProxyAuditRecord {
  return { ts: n, friendUid: "b1", serverId: "shopify", tool: "t", argsSummary: "{}", decision: "executed", outcome: "ok" };
}

describe("proxyStore（好友代理授权/审计落盘，issue #622 PR-D1）", () => {
  it("空店 / 序列化往返", () => {
    const d = setGrant(emptyProxyStore(), G1);
    const back = parseProxyStore(serializeProxyStore(d));
    expect(back.grants).toEqual([G1]);
  });

  it("parse 坏 JSON / 非对象 → 空店", () => {
    expect(parseProxyStore("not-json")).toEqual(emptyProxyStore());
    expect(parseProxyStore('"str"')).toEqual(emptyProxyStore());
    expect(parseProxyStore(null)).toEqual(emptyProxyStore());
    expect(parseProxyStore('{"grants":"x"}')).toEqual(emptyProxyStore());
  });

  it("setGrant 整份替换该好友的授权", () => {
    let d = setGrant(emptyProxyStore(), G1);
    d = setGrant(d, G2);
    // 同一好友再设 = 替换
    d = setGrant(d, { friendUid: "b1", allow: [{ serverId: "shopify", tools: [] }] });
    expect(d.grants).toHaveLength(2);
    expect(grantFor(d, "b1")?.allow[0]?.tools).toEqual([]); // 被替换成全放行
  });

  it("revokeGrant 一键撤销该好友", () => {
    let d = setGrant(emptyProxyStore(), G1);
    d = setGrant(d, G2);
    d = revokeGrant(d, "b1");
    expect(grantFor(d, "b1")).toBeNull();
    expect(grantFor(d, "b2")).not.toBeNull();
  });

  it("appendAudit 新→旧排前，超 AUDIT_CAP 丢最旧", () => {
    let d = emptyProxyStore();
    d = appendAudit(d, audit(1));
    d = appendAudit(d, audit(2));
    expect(d.audits.map((a) => a.ts)).toEqual([2, 1]); // 新的在前
    for (let i = 3; i <= AUDIT_CAP + 10; i++) d = appendAudit(d, audit(i));
    expect(d.audits).toHaveLength(AUDIT_CAP);
    expect(d.audits[0]?.ts).toBe(AUDIT_CAP + 10); // 最新保留
    expect(d.audits.some((a) => a.ts === 1)).toBe(false); // 最旧的丢了
  });
});
