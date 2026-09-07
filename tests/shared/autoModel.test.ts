// Auto 那一档的**共用**那一半（#1042）。runtime 侧的接线在 tests/runtime/autoModel.test.ts
// ——那边钉的是 `x-runtime-secret` + on-behalf 那组头；这边钉的是两条路真正共用的东西：
// 身份头由调用方注入（所以桌面能带自己的 JWT 走同一条判据），以及「Auto 开着没有」
// 这个日志投影。

import { describe, expect, it } from "vitest";
import { AUTO_MODEL, autoModelOf, pickAutoModel } from "../../src/shared/autoModel.js";

const okRes = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

describe("pickAutoModel：身份头由调用方注入", () => {
  it("原样把给的头发出去，且拿**最便宜那款**判 —— 桌面带 JWT、runtime 带 runtime-secret，判据同一份", async () => {
    let seen: { url: string; headers: Record<string, string>; body: unknown } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = {
        url,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(init.body as string),
      };
      return okRes("simple");
    }) as unknown as typeof fetch;

    const picked = await pickAutoModel(
      { llmBase: "https://edge.example/llm/v1", headers: { authorization: "Bearer jwt-x" }, fetchImpl },
      "帮我看看这段",
      ["cheap", "mid", "dear"]
    );

    expect(picked).toBe("cheap");
    expect(seen!.url).toBe("https://edge.example/llm/v1/chat/completions");
    expect(seen!.headers["authorization"]).toBe("Bearer jwt-x");
    expect(seen!.headers["content-type"]).toBe("application/json");
    // 判一手用最便宜那款：这一次调用照样落 usage_event、照样扣窗口，不做暗扣
    expect((seen!.body as { model: string }).model).toBe("cheap");
  });

  it("网关挂了 / 答案认不出 / 清单不足两款 —— 一律 null，调用方据此不改型号", async () => {
    const bad = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const weird = (async () => okRes("大概是难的吧")) as unknown as typeof fetch;
    const boom = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const deps = (f: typeof fetch) => ({ llmBase: "https://e/llm/v1", headers: {}, fetchImpl: f });

    expect(await pickAutoModel(deps(bad), "x", ["a", "b"])).toBeNull();
    expect(await pickAutoModel(deps(weird), "x", ["a", "b"])).toBeNull();
    expect(await pickAutoModel(deps(boom), "x", ["a", "b"])).toBeNull();

    // 不足两款时连网络都不打
    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return okRes("hard");
    }) as unknown as typeof fetch;
    expect(await pickAutoModel(deps(counting), "x", ["only"])).toBeNull();
    expect(calls).toBe(0);
  });
});

describe("autoModelOf：Auto 开着没有 = 日志投影", () => {
  const changed = (model: string, auto?: true) => ({ type: "model_changed", model, ...(auto ? { auto } : {}) });

  it("最后一条 model_changed 说了算", () => {
    expect(autoModelOf([changed("a"), changed("b", true)])).toBe(true);
    // 手动挑一款的那一条**不带** auto —— 那一条本身就是关掉 Auto 的动作
    expect(autoModelOf([changed("a", true), changed("b")])).toBe(false);
  });

  it("Auto 自己挑出来的那几条照旧带 auto，所以它不会因为挑了一款而关掉", () => {
    expect(autoModelOf([changed("a", true), changed("cheap", true), changed("dear", true)])).toBe(true);
  });

  it("旧日志（一条 model_changed 都没有 / 有但没这个字段）= 关着", () => {
    expect(autoModelOf([])).toBe(false);
    expect(autoModelOf([{ type: "session_created" }, changed("a")])).toBe(false);
  });

  it("别的事件类型不参与判断 —— 只看 model_changed 那一条", () => {
    expect(autoModelOf([changed("a", true), { type: "user_message" }])).toBe(true);
  });
});

describe("AUTO_MODEL 这个口令", () => {
  it("不是空串（Radix 的 SelectItem 禁止空 value），也不可能与真型号 id 撞车", () => {
    expect(AUTO_MODEL).not.toBe("");
    expect(AUTO_MODEL.startsWith("__")).toBe(true);
  });
});
