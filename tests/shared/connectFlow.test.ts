// src/shared/connectFlow.ts 的请求核心与清单状态机（#1430 Task 11 fix round 1）。
// 手机代码进不了 vitest，所以这两块住在 shared、依赖全注入；手机端文件只剩接线。
import { describe, expect, it } from "vitest";
import {
  createCloudClient, createConnectorsState, INITIAL_CONNECTORS,
  type CloudFetchInit, type CloudFetchResponse, type ConnectorsState,
} from "../../src/shared/connectFlow.js";
import type { CloudViewItem } from "../../src/shared/remote/pxCloud.js";

const app = (serverId: string): CloudViewItem => ({ serverId, catalogId: "x", status: "ok", tools: [], grants: [], connectedTs: 1 });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("createConnectorsState", () => {
  function setup() {
    let state: ConnectorsState = INITIAL_CONNECTORS;
    const fetches: ReturnType<typeof deferred<CloudViewItem[]>>[] = [];
    const s = createConnectorsState({
      fetchApps: () => { const d = deferred<CloudViewItem[]>(); fetches.push(d); return d.promise; },
      set: (patch) => { state = { ...state, ...patch }; },
    });
    return { s, fetches, get: () => state };
  }

  it("同时来的两次刷新合成一次拉取", async () => {
    const { s, fetches, get } = setup();
    const a = s.refresh();
    const b = s.refresh();
    expect(fetches).toHaveLength(1);
    expect(b).toBe(a);
    fetches[0]!.resolve([app("cloud-a")]);
    await a;
    expect(get()).toEqual({ apps: [app("cloud-a")], loadError: null });
    // 收口之后再刷新是新的一次
    void s.refresh();
    expect(fetches).toHaveLength(2);
  });

  it("失败：留上一份清单，只挂错误；下一次成功清掉错误", async () => {
    const { s, fetches, get } = setup();
    const first = s.refresh();
    fetches[0]!.resolve([app("cloud-a")]);
    await first;
    const second = s.refresh();
    fetches[1]!.reject(new Error("edge 挂了"));
    await second;
    expect(get()).toEqual({ apps: [app("cloud-a")], loadError: "edge 挂了" });
    const third = s.refresh();
    fetches[2]!.resolve([app("cloud-b")]);
    await third;
    expect(get()).toEqual({ apps: [app("cloud-b")], loadError: null });
  });

  it("非 Error 的抛出也变成一句话", async () => {
    const { s, fetches, get } = setup();
    const p = s.refresh();
    fetches[0]!.reject("字符串错误");
    await p;
    expect(get().loadError).toBe("字符串错误");
  });

  it("reset 清回初始态", async () => {
    const { s, fetches, get } = setup();
    const p = s.refresh();
    fetches[0]!.resolve([app("cloud-a")]);
    await p;
    s.reset();
    expect(get()).toEqual(INITIAL_CONNECTORS);
  });

  it("换号：reset 之前开跑的拉取，成功回来也不写进下一个人的清单", async () => {
    const { s, fetches, get } = setup();
    const old = s.refresh();
    s.reset();
    fetches[0]!.resolve([app("cloud-上一个人的")]);
    await old;
    expect(get()).toEqual(INITIAL_CONNECTORS);
  });

  it("换号：reset 之前开跑的拉取，失败回来也不把错误写进去", async () => {
    const { s, fetches, get } = setup();
    const old = s.refresh();
    s.reset();
    fetches[0]!.reject(new Error("上一个人的错误"));
    await old;
    expect(get()).toEqual(INITIAL_CONNECTORS);
  });

  it("换号后刷新是新的一次拉取；上一次迟到的收口也不会清掉新的在途标记", async () => {
    const { s, fetches, get } = setup();
    const old = s.refresh();
    s.reset();
    const fresh = s.refresh();
    expect(fetches).toHaveLength(2);
    // 旧的先收口：不许把新的 inflight 摘掉（否则下面这次会多开一次拉取）
    fetches[0]!.resolve([app("cloud-旧")]);
    await old;
    expect(s.refresh()).toBe(fresh);
    expect(fetches).toHaveLength(2);
    fetches[1]!.resolve([app("cloud-新")]);
    await fresh;
    expect(get()).toEqual({ apps: [app("cloud-新")], loadError: null });
  });

  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

  it("force：路上那一趟是接入前发的，排在它后面再拉一趟；不并发，最终以后一趟为准", async () => {
    const { s, fetches, get } = setup();
    const stale = s.refresh();
    const forced = s.refresh({ force: true });
    expect(forced).not.toBe(stale);
    // 前一趟没收口之前不开第二趟
    expect(fetches).toHaveLength(1);
    fetches[0]!.resolve([app("cloud-旧")]);
    await stale;
    await flush();
    expect(fetches).toHaveLength(2);
    fetches[1]!.resolve([app("cloud-旧"), app("cloud-新")]);
    await forced;
    expect(get()).toEqual({ apps: [app("cloud-旧"), app("cloud-新")], loadError: null });
  });

  it("force：没有在路上的就直接拉；已经排了一趟的，后来的 force 搭那一趟", async () => {
    const { s, fetches } = setup();
    const a = s.refresh({ force: true });
    expect(fetches).toHaveLength(1);
    const b = s.refresh({ force: true });
    const c = s.refresh({ force: true });
    expect(c).toBe(b);
    fetches[0]!.resolve([]);
    await a;
    await flush();
    expect(fetches).toHaveLength(2);
    fetches[1]!.resolve([]);
    await b;
    expect(fetches).toHaveLength(2);
  });

  it("force 排着的时候换号：旧那趟不写，排着的那趟也不替上一个人拉", async () => {
    const { s, fetches, get } = setup();
    const stale = s.refresh();
    const forced = s.refresh({ force: true });
    s.reset();
    fetches[0]!.resolve([app("cloud-上一个人")]);
    await stale;
    await forced;
    await flush();
    expect(fetches).toHaveLength(1);
    expect(get()).toEqual(INITIAL_CONNECTORS);
  });
});

describe("createCloudClient", () => {
  const BASE = "https://edge.test";
  function setup(opts: { token?: string | null; res?: { ok: boolean; status: number; body: unknown | "bad-json" } } = {}) {
    const requests: { url: string; init: CloudFetchInit }[] = [];
    let tokenCalls = 0;
    const res = opts.res ?? { ok: true, status: 200, body: { apps: [] } };
    const client = createCloudClient({
      base: BASE,
      token: async () => { tokenCalls += 1; return opts.token === undefined ? "jwt-1" : opts.token; },
      fetch: async (url, init): Promise<CloudFetchResponse> => {
        requests.push({ url, init });
        return {
          ok: res.ok,
          status: res.status,
          json: () => (res.body === "bad-json" ? Promise.reject(new SyntaxError("x")) : Promise.resolve(res.body)),
        };
      },
    });
    return { client, requests, tokenCalls: () => tokenCalls };
  }

  it("fetchCloudApps：GET /px/v1/cloud，只带 authorization，不带 content-type / body", async () => {
    const { client, requests } = setup({ res: { ok: true, status: 200, body: { apps: [app("cloud-a")] } } });
    expect(await client.fetchCloudApps()).toEqual([app("cloud-a")]);
    expect(requests).toEqual([{ url: `${BASE}/px/v1/cloud`, init: { headers: { authorization: "Bearer jwt-1" } } }]);
  });

  it("fetchCloudApps：形状不对 → 说人话", async () => {
    const { client } = setup({ res: { ok: true, status: 200, body: { nope: 1 } } });
    await expect(client.fetchCloudApps()).rejects.toThrow("应用清单的形状不对。");
  });

  it("startConnect：POST /connect，JSON 体带 catalogId + params", async () => {
    const { client, requests } = setup({ res: { ok: true, status: 200, body: { kind: "connected", serverId: "cloud-x" } } });
    expect(await client.startConnect("x", { k: "v" })).toEqual({ kind: "connected", serverId: "cloud-x" });
    expect(requests[0]).toEqual({
      url: `${BASE}/px/v1/cloud/connect`,
      init: { method: "POST", headers: { authorization: "Bearer jwt-1", "content-type": "application/json" }, body: JSON.stringify({ catalogId: "x", params: { k: "v" } }) },
    });
  });

  it("startConnect：回包形状不对 → 说人话", async () => {
    const { client } = setup({ res: { ok: true, status: 200, body: { kind: "wat" } } });
    await expect(client.startConnect("x", {})).rejects.toThrow("服务端回的形状不对。");
  });

  it("setGrant：POST /grant，体是 {serverId, workspaceId, on}", async () => {
    const { client, requests } = setup({ res: { ok: true, status: 200, body: { ok: true } } });
    await client.setGrant("cloud-x", "w1", false);
    expect(requests[0]!.url).toBe(`${BASE}/px/v1/cloud/grant`);
    expect(requests[0]!.init.method).toBe("POST");
    expect(JSON.parse(requests[0]!.init.body!)).toEqual({ serverId: "cloud-x", workspaceId: "w1", on: false });
  });

  it("removeApp：DELETE，serverId 进路径且被编码，无 body", async () => {
    const { client, requests } = setup({ res: { ok: true, status: 200, body: { ok: true } } });
    await client.removeApp("cloud/x y");
    expect(requests[0]).toEqual({
      url: `${BASE}/px/v1/cloud/cloud%2Fx%20y`,
      init: { method: "DELETE", headers: { authorization: "Bearer jwt-1" } },
    });
  });

  it("没登录：说「还没登录。」，一个请求都不发", async () => {
    const { client, requests } = setup({ token: null });
    await expect(client.fetchCloudApps()).rejects.toThrow("还没登录。");
    expect(requests).toHaveLength(0);
  });

  it("非 2xx：edge 的错误信封里那句话原样抛出", async () => {
    const { client } = setup({ res: { ok: false, status: 400, body: { error: { message: "这个 token 用不了", type: "otto_edge", code: "bad" } } } });
    await expect(client.startConnect("github", {})).rejects.toThrow("这个 token 用不了");
  });

  it("非 2xx 且认不出信封 / 回包不是 JSON：退回 HTTP 状态码", async () => {
    const a = setup({ res: { ok: false, status: 502, body: { error: { message: "别家的" } } } });
    await expect(a.client.fetchCloudApps()).rejects.toThrow("HTTP 502");
    const b = setup({ res: { ok: false, status: 500, body: "bad-json" } });
    await expect(b.client.removeApp("cloud-x")).rejects.toThrow("HTTP 500");
  });

  it("token 每次请求现取，不缓存", async () => {
    const { client, tokenCalls } = setup();
    await client.fetchCloudApps();
    await client.fetchCloudApps();
    await client.setGrant("cloud-x", "w1", true);
    expect(tokenCalls()).toBe(3);
  });
});
