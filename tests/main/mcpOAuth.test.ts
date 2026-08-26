import { describe, it, expect } from "vitest";
import { startLoopback, AUTH_TIMEOUT_MS } from "../../src/main/mcpOAuth.js";

/** 拿真 http 打一次回调——loopback 的价值全在"真能被浏览器访问到" */
async function hit(uri: string, params: Record<string, string>): Promise<number> {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  await res.text();
  return res.status;
}

describe("startLoopback", () => {
  it("redirectUri 指向 127.0.0.1 的一个真端口，路径是 /callback", async () => {
    const cb = await startLoopback();
    try {
      const u = new URL(cb.redirectUri);
      expect(u.hostname).toBe("127.0.0.1");
      expect(u.pathname).toBe("/callback");
      expect(Number(u.port)).toBeGreaterThan(0);
    } finally { cb.close(); }
  });

  it("state 匹配 + 带 code = 拿到授权码", async () => {
    const cb = await startLoopback();
    const waiting = cb.waitForCode(AUTH_TIMEOUT_MS);
    await hit(cb.redirectUri, { state: cb.state, code: "abc123" });
    await expect(waiting).resolves.toBe("abc123");
  });

  it("回调早于 waitForCode 到达也不丢——connect() 开完浏览器才轮到我们等", async () => {
    const cb = await startLoopback();
    await hit(cb.redirectUri, { state: cb.state, code: "early" });
    await expect(cb.waitForCode(AUTH_TIMEOUT_MS)).resolves.toBe("early");
  });

  it("state 对不上必须拒绝——SDK 的 finishAuth 只收 code、不验 state", async () => {
    const cb = await startLoopback();
    const waiting = cb.waitForCode(AUTH_TIMEOUT_MS);
    // 先同步挂上 rejection 的断言处理器，再去发真实的网络请求——
    // 服务端在收到请求的同一个 tick 里就会 reject（早于 fetch() 在客户端
    // resolve 的时机），如果 await hit() 排在断言前面，reject 发生时
    // waiting 还没人接住，Node 会把它记成 unhandledRejection（即便随后
    // 真的被接住了，vitest 依然把这次运行判为不干净）
    const assertion = expect(waiting).rejects.toThrow(/state/);
    await hit(cb.redirectUri, { state: "别人的state", code: "abc123" });
    await assertion;
    // reject 之后端口也必须关掉（B-Minor 3-2）：只断 reject 的话，一个仍在
    // 监听的本地口子会活到进程退出，而 state 对不上正是"有人在打这个端口的
    // 主意"的场景。同该文件另外三条（收完一次立刻关 / 超时后关 / close() 后关）
    await expect(hit(cb.redirectUri, { state: cb.state, code: "abc" })).rejects.toThrow();
  });

  it("授权服务器回 error 时给人话，而不是干等到超时", async () => {
    const cb = await startLoopback();
    const waiting = cb.waitForCode(AUTH_TIMEOUT_MS);
    const assertion = expect(waiting).rejects.toThrow(/access_denied/);
    await hit(cb.redirectUri, { state: cb.state, error: "access_denied", error_description: "用户点了拒绝" });
    await assertion;
  });

  it("回调里没有 code 也不干等", async () => {
    const cb = await startLoopback();
    const waiting = cb.waitForCode(AUTH_TIMEOUT_MS);
    const assertion = expect(waiting).rejects.toThrow(/code/);
    await hit(cb.redirectUri, { state: cb.state });
    await assertion;
  });

  it("waitForCode 之前连来两次回调：第一次说了算，不被后到的覆盖（#474）", async () => {
    const cb = await startLoopback();
    await hit(cb.redirectUri, { state: cb.state, code: "第一次的" });
    await hit(cb.redirectUri, { state: cb.state, code: "后到想顶掉的" });
    await expect(cb.waitForCode(1000)).resolves.toBe("第一次的");
  });

  it("收完一次立刻关端口——不留长期监听的本地口子", async () => {
    const cb = await startLoopback();
    const waiting = cb.waitForCode(AUTH_TIMEOUT_MS);
    await hit(cb.redirectUri, { state: cb.state, code: "abc" });
    await waiting;
    await expect(hit(cb.redirectUri, { state: cb.state, code: "abc" })).rejects.toThrow();
  });

  it("超时后 reject 并关端口", async () => {
    const cb = await startLoopback();
    await expect(cb.waitForCode(50)).rejects.toThrow(/超时/);
    await expect(hit(cb.redirectUri, { state: cb.state, code: "abc" })).rejects.toThrow();
  });

  it("两次 startLoopback 拿到不同的 state", async () => {
    const a = await startLoopback();
    const b = await startLoopback();
    try { expect(a.state).not.toBe(b.state); } finally { a.close(); b.close(); }
  });

  it("close() 之后端口就不通了", async () => {
    const cb = await startLoopback();
    cb.close();
    await expect(hit(cb.redirectUri, { state: cb.state, code: "abc" })).rejects.toThrow();
  });
});
