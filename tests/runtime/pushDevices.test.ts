// pushDevices —— 令牌表的 runtime 那一侧（#1411）。假的 Supabase 客户端只实现用到的那一截查询链。
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabasePushDevices } from "../../services/runtime/src/pushDevices.js";

type Call = [string, ...unknown[]];
function fakeClient(result: { data?: unknown; error: { message: string } | null } | Error) {
  const calls: Call[] = [];
  const chain = () => {
    const q = {
      eq: (k: string, v: unknown) => {
        calls.push(["eq", k, v]);
        return q;
      },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)).then(res, rej),
    };
    return q;
  };
  const client = {
    from: (table: string) => ({
      select: (cols: string) => {
        calls.push(["select", table, cols]);
        return chain();
      },
      update: (patch: Record<string, unknown>) => {
        calls.push(["update", table, Object.keys(patch).sort()]);
        return chain();
      },
      delete: () => {
        calls.push(["delete", table]);
        return chain();
      },
    }),
  };
  return { client: client as unknown as SupabaseClient, calls };
}

describe("createSupabasePushDevices", () => {
  it("list：只取这个人、这个 bundle 的令牌；认不出的环境当没记过", async () => {
    const f = fakeClient({ data: [{ token: "aa", apns_env: "sandbox" }, { token: "bb", apns_env: null }, { token: "cc", apns_env: "weird" }], error: null });
    const store = createSupabasePushDevices(f.client, "com.stanyan.mrotto.mobile", () => {});
    expect(await store.list("u1")).toEqual([
      { token: "aa", env: "sandbox" },
      { token: "bb", env: null },
      { token: "cc", env: null },
    ]);
    expect(f.calls).toEqual([
      ["select", "push_devices", "token, apns_env"],
      ["eq", "user_id", "u1"],
      ["eq", "bundle_id", "com.stanyan.mrotto.mobile"],
    ]);
  });
  it("list 查询失败：往上抛（「查不到」不许说成「他没有设备」）", async () => {
    const f = fakeClient({ error: { message: "boom" } });
    await expect(createSupabasePushDevices(f.client, "b", () => {}).list("u1")).rejects.toThrow("boom");
  });
  it("setEnv / remove：失败只记日志不抛", async () => {
    const logs: string[] = [];
    const f = fakeClient(new Error("offline"));
    const store = createSupabasePushDevices(f.client, "b", (m) => logs.push(m));
    await store.setEnv("aa", "production");
    await store.remove("aa");
    expect(logs).toHaveLength(2);
  });
});
