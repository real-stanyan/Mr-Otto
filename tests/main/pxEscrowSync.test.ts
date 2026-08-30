import { describe, expect, it, vi } from "vitest";
import { createEscrowSync, type EscrowSyncDeps } from "../../src/main/pxEscrowSync.js";
import type { EscrowDoc } from "../../src/shared/remote/pxEscrow.js";

// 上传编排（issue #797）：四个触发源汇成一次上传，内容没变不打网络，
// 零授权 DELETE（撤销级联的后半），失败排队重试。

function doc(token = "tok"): EscrowDoc {
  return {
    v: 1,
    hostUid: "a-uid",
    services: [{ serverId: "square", url: "https://x.example/mcp", oauth: { tokens: { access_token: token } }, toolDefs: [] }],
    grants: [{ friendUid: "b-uid", allow: [{ serverId: "square", tools: [] }] }],
    updatedTs: 1,
  };
}

function harness(over: Partial<EscrowSyncDeps> = {}) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  let respondOk = true;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      method: init.method ?? "GET",
      url,
      ...(typeof init.body === "string" ? { body: JSON.parse(init.body) } : {}),
    });
    return { ok: respondOk, status: respondOk ? 200 : 500 } as Response;
  }) as unknown as typeof fetch;
  const sync = createEscrowSync({
    baseUrl: () => "https://edge.test",
    accessToken: async () => "jwt",
    buildDoc: () => doc(),
    everHosted: () => true,
    fetchImpl,
    debounceMs: 1,
    retryMs: 5,
    ...over,
  });
  return { sync, calls, setOk: (v: boolean) => { respondOk = v; } };
}

describe("pxEscrowSync（issue #797 / ADR-0197 切片 2）", () => {
  it("有授权 = PUT 全量；内容没变的下一轮不打网络", async () => {
    const h = harness();
    expect(await h.sync.syncNow()).toBe("put");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.method).toBe("PUT");
    expect(h.calls[0]!.url).toBe("https://edge.test/px/v1/escrow");
    expect((h.calls[0]!.body as EscrowDoc).hostUid).toBe("a-uid");

    expect(await h.sync.syncNow()).toBe("unchanged");
    expect(h.calls).toHaveLength(1);
    h.sync.dispose();
  });

  it("token 刷新（内容指纹变了）= 重传——re-sync 那一刀", async () => {
    let tok = "old";
    const h = harness({ buildDoc: () => doc(tok) });
    await h.sync.syncNow();
    tok = "renewed";
    expect(await h.sync.syncNow()).toBe("put");
    expect(h.calls).toHaveLength(2);
    h.sync.dispose();
  });

  it("零授权 + 托管过 = DELETE（撤销级联）；从没托管过 = 连 DELETE 都不发", async () => {
    const h = harness({ buildDoc: () => null });
    expect(await h.sync.syncNow()).toBe("deleted");
    expect(h.calls[0]!.method).toBe("DELETE");

    const fresh = harness({ buildDoc: () => null, everHosted: () => false });
    expect(await fresh.sync.syncNow()).toBe("skipped");
    expect(fresh.calls).toHaveLength(0);
    h.sync.dispose(); fresh.sync.dispose();
  });

  it("没登录 = 跳过不重试（登录那一刻 resume 会再触发）", async () => {
    const h = harness({ accessToken: async () => null });
    expect(await h.sync.syncNow()).toBe("skipped");
    expect(h.calls).toHaveLength(0);
    h.sync.dispose();
  });

  it("失败排队重试，成功后指纹才算送达", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.setOk(false);
      expect(await h.sync.syncNow()).toBe("failed");
      expect(h.calls).toHaveLength(1);
      h.setOk(true);
      await vi.advanceTimersByTimeAsync(10); // retryMs=5，重试自己跑
      expect(h.calls).toHaveLength(2);
      expect(await h.sync.syncNow()).toBe("unchanged"); // 第二次成功已记账
      h.sync.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("schedule 防抖：连环触发合并成一次上传", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ debounceMs: 10 });
      h.sync.schedule();
      h.sync.schedule();
      h.sync.schedule();
      await vi.advanceTimersByTimeAsync(50);
      expect(h.calls).toHaveLength(1);
      h.sync.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("pxEscrowSync 的 hostedServerIds 与 purge（issue #799 / ADR-0197 切片 4）", () => {
  it("PUT 成功后 hostedServerIds 回箱内清单；DELETE 后回 null", async () => {
    let d: EscrowDoc | null = doc();
    const h = harness({ buildDoc: () => d });
    expect(h.sync.hostedServerIds()).toBeNull(); // 还没同步过：宁可少报不虚报
    await h.sync.syncNow();
    expect(h.sync.hostedServerIds()).toEqual(["square"]);
    d = null; // 撤到零授权
    await h.sync.syncNow();
    expect(h.sync.hostedServerIds()).toBeNull();
  });

  it("PUT 失败不改 hostedServerIds（上一箱还在云端，别把徽标扯下来）", async () => {
    let cur = doc();
    const h = harness({ buildDoc: () => cur });
    await h.sync.syncNow();
    expect(h.sync.hostedServerIds()).toEqual(["square"]);
    h.setOk(false);
    cur = { ...doc("tok2"), services: [...doc().services, { serverId: "extra", url: "https://y.example/mcp", toolDefs: [] }] };
    expect(await h.sync.syncNow()).toBe("failed");
    expect(h.sync.hostedServerIds()).toEqual(["square"]); // 云端那箱还是旧的
    h.sync.dispose(); // 收掉重试 timer，别泄进别的测试
  });

  it("purge：不看 digest 直接 DELETE，成功后 hostedServerIds 归 null", async () => {
    const h = harness();
    await h.sync.syncNow();
    expect(await h.sync.purge()).toBe(true);
    expect(h.calls.at(-1)?.method).toBe("DELETE");
    expect(h.sync.hostedServerIds()).toBeNull();
    // purge 清了 lastSent：下次 sync 会重新 PUT（重新登录后箱子能回来）
    await h.sync.syncNow();
    expect(h.calls.at(-1)?.method).toBe("PUT");
  });

  it("purge：HTTP 被拒回 false 不抛（登出不能被它卡住）", async () => {
    const h = harness();
    h.setOk(false);
    expect(await h.sync.purge()).toBe(false);
  });

  it("purge：没 token 回 false（没登录没得清）", async () => {
    const h = harness({ accessToken: async () => null });
    expect(await h.sync.purge()).toBe(false);
    expect(h.calls.length).toBe(0);
  });
});
