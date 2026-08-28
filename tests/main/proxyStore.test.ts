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

// ─── 文件落盘层（0600/userData）─────────────────────────────────
describe("proxyStore 文件落盘（issue #622 PR-D2）", () => {
  it("读不存在的文件回空台账", async () => {
    const { readProxyStore } = await import("../../src/main/proxyStore.js");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const d = readProxyStore(join(tmpdir(), `proxy-test-nonexist-${Date.now()}.json`));
    expect(d.grants).toEqual([]);
    expect(d.audits).toEqual([]);
  });

  it("写读往返一致 + 坏 JSON 回空", async () => {
    const { readProxyStore, writeProxyStore, setGrant } = await import("../../src/main/proxyStore.js");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { writeFileSync } = await import("node:fs");
    const p = join(tmpdir(), `proxy-test-${Date.now()}.json`);
    // 写一个带授权的台账
    writeProxyStore(p, setGrant(emptyProxyStore(), { friendUid: "b1", allow: [{ serverId: "shopify", tools: ["get_orders"] }] }));
    const back = readProxyStore(p);
    expect(back.grants).toHaveLength(1);
    expect(back.grants[0]?.friendUid).toBe("b1");
    expect(back.grants[0]?.allow[0]?.tools).toEqual(["get_orders"]);
    // 写成坏 JSON → 读回空
    writeFileSync(p, "not-json{{{");
    expect(readProxyStore(p).grants).toEqual([]);
  });
});
