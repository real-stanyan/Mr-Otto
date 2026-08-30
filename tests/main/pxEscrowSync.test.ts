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
