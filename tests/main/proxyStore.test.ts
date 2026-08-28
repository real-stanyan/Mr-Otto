import { describe, expect, it } from "vitest";
import {
  appendAudit,
  AUDIT_CAP,
  channelFor,
  emptyProxyStore,
  grantFor,
  parseProxyStore,
  pinnedIdentities,
  revokeGrant,
  serializeProxyStore,
  setChannel,
  setGrant,
  setPin,
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

// ─── pin 与频道（issue #657 / ADR-0161）────────────────────────────────
describe("proxyStore 的 pin 与频道（issue #657 / ADR-0161）", () => {
  it("setPin/pinnedIdentities 往返；同一好友整份替换", () => {
    const pubA = new Uint8Array(32).fill(7);
    const pubB = new Uint8Array(32).fill(9);
    let d = setPin(emptyProxyStore(), "b1", pubA);
    expect(pinnedIdentities(d, "b1").map((k) => Array.from(k))).toEqual([Array.from(pubA)]);
    d = setPin(d, "b1", pubB); // 换机器 = 换身份密钥，整份替换
    expect(pinnedIdentities(d, "b1").map((k) => Array.from(k))).toEqual([Array.from(pubB)]);
    expect(pinnedIdentities(d, "b2")).toEqual([]);
  });

  it("坏 base64 / 长度不对的 pin 读不出来（宁可拒握手，也不用坏钥匙）", () => {
    const d = parseProxyStore(JSON.stringify({
      pins: [
        { friendUid: "b1", identityPub: "!!!not-base64!!!" },
        { friendUid: "b1", identityPub: "AAAA" }, // 解得出，但不是 32 字节
      ],
    }));
    expect(pinnedIdentities(d, "b1")).toEqual([]);
  });

  it("setChannel/channelFor 往返", () => {
    let d = setChannel(emptyProxyStore(), "b1", "chan-1");
    expect(channelFor(d, "b1")).toBe("chan-1");
    d = setChannel(d, "b1", "chan-2");
    expect(channelFor(d, "b1")).toBe("chan-2");
    expect(channelFor(d, "b2")).toBeNull();
  });

  it("撤销把授权、pin、频道一起清掉——「这个好友什么都不剩」", () => {
    let d = setGrant(emptyProxyStore(), G1);
    d = setPin(d, "b1", new Uint8Array(32).fill(3));
    d = setChannel(d, "b1", "chan-1");
    d = setGrant(d, G2);
    d = setPin(d, "b2", new Uint8Array(32).fill(4));

    d = revokeGrant(d, "b1");
    expect(grantFor(d, "b1")).toBeNull();
    expect(pinnedIdentities(d, "b1")).toEqual([]);
    expect(channelFor(d, "b1")).toBeNull();
    // 别人的不动
    expect(grantFor(d, "b2")).not.toBeNull();
    expect(pinnedIdentities(d, "b2")).toHaveLength(1);
  });

  it("老台账（没有 pins/channels 字段）读得进来，按空组算", () => {
    const d = parseProxyStore(JSON.stringify({ grants: [G1], audits: [] }));
    expect(d.grants).toEqual([G1]);
    expect(d.pins).toEqual([]);
    expect(d.channels).toEqual([]);
  });
});
