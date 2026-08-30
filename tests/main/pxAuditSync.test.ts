import { describe, expect, it } from "vitest";
import { createAuditBackflow } from "../../src/main/pxAuditSync.js";
import { emptyProxyStore, setGrant, type ProxyStoreData } from "../../src/main/proxyStore.js";
import type { PxAudit } from "../../src/shared/remote/pxEscrow.js";

// 云端审计回流的编排（issue #799）：增量按游标拉、拉不到 ≠ 没有、
// 从没托管过的账号不打网络、并发共享同一轮。

const GRANT = { friendUid: "b-uid", allow: [{ serverId: "square", tools: [] }] };

function harness(opts: {
  store?: ProxyStoreData;
  respond?: (since: number) => readonly PxAudit[] | null;
} = {}) {
  let store = opts.store ?? setGrant(emptyProxyStore(), GRANT);
  const sinceSeen: number[] = [];
  const flow = createAuditBackflow({
    fetchAudit: async (since) => {
      sinceSeen.push(since);
      return opts.respond ? opts.respond(since) : [];
    },
    loadStore: () => store,
    saveStore: (d) => { store = d; },
  });
  return { flow, sinceSeen, store: () => store };
}

describe("pxAuditSync（issue #799 / ADR-0197 切片 4）", () => {
  it("增量并入台账，游标推进；下一轮从新游标起拉", async () => {
    const h = harness({
      respond: (since) => since === 0
        ? [{ ts: 10, fromUid: "b-uid", serverId: "square", tool: "pay", outcome: "ok" }]
        : [],
    });
    expect(await h.flow.pullNow()).toBe("merged");
    expect(h.store().audits).toMatchObject([{ ts: 10, friendUid: "b-uid", tool: "pay" }]);
    expect(h.store().cloudAuditCursor).toBe(10);
    expect(await h.flow.pullNow()).toBe("empty");
    expect(h.sinceSeen).toEqual([0, 10]);
  });

  it("拉不到（null）回 failed，台账与游标原封不动", async () => {
    const h = harness({ respond: () => null });
    expect(await h.flow.pullNow()).toBe("failed");
    expect(h.store().audits).toEqual([]);
    expect(h.store().cloudAuditCursor).toBeUndefined();
  });

  it("从没授过权也没拉到过账：skipped，不打网络", async () => {
    const h = harness({ store: emptyProxyStore() });
    expect(await h.flow.pullNow()).toBe("skipped");
    expect(h.sinceSeen).toEqual([]);
  });

  it("授权撤光但游标还在：照样拉（撤销后云端可能还有没回流的尾账）", async () => {
    const h = harness({ store: { ...emptyProxyStore(), cloudAuditCursor: 5 } });
    expect(await h.flow.pullNow()).toBe("empty");
    expect(h.sinceSeen).toEqual([5]);
  });

  it("并发调用共享同一轮：看账那格 UI 连点不叠加请求", async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.flow.pullNow(), h.flow.pullNow()]);
    expect(a).toBe(b);
    expect(h.sinceSeen.length).toBe(1);
  });
});
