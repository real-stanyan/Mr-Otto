import { describe, expect, it, vi } from "vitest";
import { createHostedQuota } from "../../src/main/hostedQuota.js";
import { BILLING_HEADERS, type BillingMe } from "../../src/shared/billing.js";

const T0 = 1_800_000_000_000;
const me: BillingMe = {
  plan: "pro", status: "active",
  windows: { h5: { usedMicro: 0, limitMicro: 100, resetAt: T0 + 5000 }, week: { usedMicro: 0, limitMicro: 1000, resetAt: T0 + 9000 } },
  addon: { remainingMicro: 0, expiresAt: null }, periodEnd: T0 + 99_999, models: ["deepseek-v4-flash"],
};

function make(responses: Array<() => Response>, token: string | null = "jwt") {
  let now = T0;
  const fetchImpl = vi.fn(async () => (responses.shift() ?? (() => new Response("{}", { status: 500 })))()) as unknown as typeof fetch;
  const q = createHostedQuota({ baseUrl: () => "https://edge", accessToken: async () => token, fetchImpl, now: () => now });
  return { q, fetchImpl, tick: (ms: number) => { now += ms; } };
}

describe("hostedQuota", () => {
  it("refresh：带 JWT 打 /billing/v1/me，快照更新；routeInput 认订阅与型号", async () => {
    const { q, fetchImpl } = make([() => Response.json(me)]);
    expect(await q.refresh()).toEqual(me);
    const req = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(req[0]).toBe("https://edge/billing/v1/me");
    expect((req[1] as RequestInit).headers).toMatchObject({ authorization: "Bearer jwt" });
    expect(q.routeInput("deepseek-v4-flash")).toEqual({ subscribed: true, exhausted: false, supportsModel: true });
    expect(q.routeInput("gpt-9").supportsModel).toBe(false);
  });

  it("没登录 → me=null、subscribed=false，不打网络", async () => {
    const { q, fetchImpl } = make([], null);
    expect(await q.refresh()).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(q.routeInput("deepseek-v4-flash").subscribed).toBe(false);
  });

  it("refresh 失败保留旧快照（「拿不到」≠「没订阅」）", async () => {
    const { q } = make([() => Response.json(me), () => new Response("x", { status: 500 })]);
    await q.refresh();
    expect(await q.refresh()).toEqual(me);
    expect(q.routeInput("deepseek-v4-flash").subscribed).toBe(true);
  });

  it("noteExhausted → exhausted 直到 resetAt；过点自动恢复；refresh 成功也清掉", async () => {
    const { q, tick } = make([() => Response.json(me), () => Response.json(me)]);
    await q.refresh();
    q.noteExhausted({ window: "5h", resetAt: T0 + 5000 });
    expect(q.routeInput("deepseek-v4-flash")).toMatchObject({ exhausted: true, resetAt: T0 + 5000 });
    tick(5001);
    expect(q.routeInput("deepseek-v4-flash").exhausted).toBe(false);
    q.noteExhausted({ window: "week", resetAt: T0 + 9000 });
    await q.refresh();
    expect(q.routeInput("deepseek-v4-flash").exhausted).toBe(false);
  });

  it("noteHeaders：剩余为 0 视为耗尽（resetAt 取快照里那个窗），非 0 更新 used", async () => {
    const { q } = make([() => Response.json(me)]);
    await q.refresh();
    q.noteHeaders(new Headers({ [BILLING_HEADERS.h5]: "40" }));
    expect(q.snapshot().me?.windows?.h5.usedMicro).toBe(60);
    q.noteHeaders(new Headers({ [BILLING_HEADERS.week]: "0" }));
    expect(q.routeInput("deepseek-v4-flash")).toMatchObject({ exhausted: true, resetAt: T0 + 9000 });
  });

  it("checkout / portal 回 url；服务端报错抛 message", async () => {
    const { q, fetchImpl } = make([() => Response.json({ url: "https://s/1" }), () => Response.json({ error: { message: "没配", type: "otto_edge", code: "upstream" } }, { status: 502 })]);
    expect(await q.checkout({ planId: "pro" })).toBe("https://s/1");
    const body = JSON.parse(((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ planId: "pro" });
    await expect(q.portal()).rejects.toThrow("没配");
  });

  it("onChange 在 refresh / noteExhausted / noteHeaders 后各触发一次", async () => {
    const { q } = make([() => Response.json(me)]);
    const cb = vi.fn();
    q.onChange(cb);
    await q.refresh();
    q.noteExhausted({ window: "5h", resetAt: T0 + 1 });
    q.noteHeaders(new Headers({ [BILLING_HEADERS.h5]: "1" }));
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it("emit 隔离：一个订阅者抛错不挡住第二个，也不会让 refresh 误判成失败", async () => {
    const logs: string[] = [];
    const fetchImpl = vi.fn(async () => Response.json(me)) as unknown as typeof fetch;
    const q = createHostedQuota({
      baseUrl: () => "https://edge", accessToken: async () => "jwt", fetchImpl, now: () => T0,
      log: (m) => logs.push(m),
    });
    q.onChange(() => { throw new Error("boom"); });
    const second = vi.fn();
    q.onChange(second);
    const result = await q.refresh();
    expect(result).toEqual(me); // 快照确实更新了，不该被第一个订阅者的异常带偏
    expect(second).toHaveBeenCalledTimes(1); // 第一个抛错不挡住第二个
    expect(logs.some((m) => m.includes("保留旧快照"))).toBe(false); // 不能把"订阅者抛错"记成"refresh 失败"
  });

  it("并发 refresh：更早发起、更晚回来的响应不能覆盖更新的那份快照", async () => {
    const resolvers: Array<(r: Response) => void> = [];
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { resolvers.push(resolve); })) as unknown as typeof fetch;
    const q = createHostedQuota({ baseUrl: () => "https://edge", accessToken: async () => "jwt", fetchImpl, now: () => T0 });
    const older = q.refresh(); // seq 1，先发起
    const newer = q.refresh(); // seq 2，后发起
    await Promise.resolve(); // 让两次调用都各自跑到自己的 fetchImpl 调用并挂起
    const me2: BillingMe = { ...me, plan: "max" };
    resolvers[1]!(Response.json(me2)); // 更晚发起的那次先回
    resolvers[0]!(Response.json(me)); // 更早发起的那次后回——它才是过期响应
    const [olderResult, newerResult] = await Promise.all([older, newer]);
    expect(newerResult).toEqual(me2);
    expect(olderResult).toEqual(me2); // 过期响应落地时读到的已经是 newer 的快照，不是自己拿到的 me
    expect(q.snapshot().me).toEqual(me2); // 快照最终定格在更新的那份，没被旧响应覆盖回去
  });
});
