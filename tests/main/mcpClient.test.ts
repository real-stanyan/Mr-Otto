// mcpClient.ts 是本仓唯一 import SDK 的文件，所以它绝大部分逻辑离不开一个真进程 /
// 真 HTTP 连接，没法在这份门禁里单测。isAuthError() 是个例外——它是一个纯函数
// （error → boolean），不碰网络、不碰进程，只是把 SDK 抛出的错误分个类，
// 值得单独测：这是 needs-auth 还是 failed 这条用户可见的区分点全部的逻辑所在
// （同一个判断错了，用户看到的是"这台坏了"而不是"去点一下授权"）。
//
// 这里 import SDK 的两个错误类只是为了造出跟真实运行时形状一致的实例喂给
// isAuthError()——本身不发请求、不连网络，跟"mcpHub 的状态机测试不碰 SDK"
// 是两回事：那边测的是不依赖 SDK 就能测干净的状态机，这里测的正是
// mcpClient.ts 自己那一小块可以脱离进程单测的纯逻辑。
import { describe, it, expect, vi } from "vitest";
import { isAuthError, describeAuthError, authRequiredError, scrubOAuthError, needsFreshRegistration } from "../../src/main/mcpClient.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InvalidGrantError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

describe("isAuthError", () => {
  it("UnauthorizedError 总是要授权", () => {
    expect(isAuthError(new UnauthorizedError())).toBe(true);
    expect(isAuthError(new UnauthorizedError("custom message"))).toBe(true);
  });

  it("StreamableHTTPError 401/403 要授权 —— 状态码在 .code 上，不在 .message 里", () => {
    expect(isAuthError(new StreamableHTTPError(401, "Error POSTing to endpoint: nope"))).toBe(true);
    expect(isAuthError(new StreamableHTTPError(403, "Error POSTing to endpoint: nope"))).toBe(true);
  });

  it("StreamableHTTPError 非 401/403 不算要授权", () => {
    expect(isAuthError(new StreamableHTTPError(500, "Error POSTing to endpoint: boom"))).toBe(false);
    expect(isAuthError(new StreamableHTTPError(undefined, "network died"))).toBe(false);
  });

  it("兜底正则：普通 Error 但文本里明说了 unauthorized/401/403", () => {
    expect(isAuthError(new Error("401 Unauthorized"))).toBe(true);
    expect(isAuthError(new Error("Forbidden"))).toBe(true);
    expect(isAuthError(new Error("403 from upstream"))).toBe(true);
  });

  it("既不是已知类型也没有对应字样 —— 不算要授权", () => {
    expect(isAuthError(new Error("spawn npx ENOENT"))).toBe(false);
    expect(isAuthError(new Error("connection reset"))).toBe(false);
    expect(isAuthError("just a string")).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
  });
});

// #470：SDK 的错误 message 里可能带 token 端点的响应体原文（parseErrorResponse
// 的 "Raw body: ..." 兜底），而这段文本会沿 McpAuthRequiredError → hub 的
// e.error → tool_result 落进 append-only 事件日志。下面这串扮演"混进错误
// 文本里的凭据"——断言它在任何一个出口的措辞里都不出现。
const TAINT = "access_token-绝不能入日志-9d3ab7e1";

describe("describeAuthError —— 白名单式折叠，凭据文本进不来", () => {
  it("StreamableHTTPError 折成状态码，不带 message", () => {
    expect(describeAuthError(new StreamableHTTPError(401, `nope: ${TAINT}`))).toBe("HTTP 401");
    expect(describeAuthError(new StreamableHTTPError(undefined, TAINT))).toBe("HTTP 状态码未知");
  });

  it("OAuthError 子类折成 spec 的 error code（这正是诊断价值所在）", () => {
    expect(describeAuthError(new InvalidGrantError(`desc with ${TAINT}`))).toBe("invalid_grant");
    expect(describeAuthError(new ServerError(`Raw body: {"access_token":"${TAINT}"}`))).toBe("server_error");
  });

  it("普通 Error 只留类名；非 Error 只留 typeof —— message/原值一律不带", () => {
    expect(describeAuthError(new UnauthorizedError(TAINT))).toBe("Error");
    expect(describeAuthError(new Error(`401 ${TAINT}`))).toBe("Error");
    expect(describeAuthError(`raw string ${TAINT}`)).toBe("string");
    expect(describeAuthError(undefined)).toBe("undefined");
  });
});

describe("authRequiredError —— 两处 throw 共用的构造点", () => {
  it("消息含 server id 和折叠后的原因，不含原始错误文本", () => {
    const err = authRequiredError("supabase", new StreamableHTTPError(401, `denied: ${TAINT}`));
    expect(err.message).toContain("supabase");
    expect(err.message).toContain("HTTP 401");
    expect(err.message).not.toContain(TAINT);
  });
});

describe("scrubOAuthError —— 只重写带服务端文本的 OAuthError，其余原样放行", () => {
  it("OAuthError 的 message 被换掉，error code 保留", () => {
    const out = scrubOAuthError(new ServerError(`HTTP 400: Invalid OAuth error response. Raw body: ${TAINT}`));
    expect(out).toBeInstanceOf(Error);
    expect((out as Error).message).toContain("server_error");
    expect((out as Error).message).not.toContain(TAINT);
  });

  it("我们自己的人话错误原样放行（loopback 超时那类诊断不能丢）", () => {
    const own = new Error("授权超时：5 分钟内没等到浏览器回调");
    expect(scrubOAuthError(own)).toBe(own);
  });

  it("非 Error 原样放行", () => {
    expect(scrubOAuthError("boom")).toBe("boom");
  });
});

// #471：动态客户端注册只跑一次，注册进去的 redirect_uris 绑着第一次授权的
// 随机端口。二次授权换了端口，复用盘上那份注册会被精确匹配的授权服务器以
// invalid_redirect_uri 拒掉。这里判定"盘上的注册还能不能用这次的 redirect_uri"。
describe("needsFreshRegistration（#471：二次授权的 redirect_uri 不匹配）", () => {
  const uri = "http://127.0.0.1:2222/callback";

  it("盘上有注册且绑的是另一个端口 → 要丢掉重注册", () => {
    expect(
      needsFreshRegistration(
        { clientInformation: { client_id: "c" }, redirectUri: "http://127.0.0.1:1111/callback" },
        uri
      )
    ).toBe(true);
  });

  it("老记录没存过 redirectUri（#471 之前落的盘）→ 视为过期注册", () => {
    expect(needsFreshRegistration({ clientInformation: { client_id: "c" } }, uri)).toBe(true);
  });

  it("redirect_uri 一致 → 注册还能用", () => {
    expect(needsFreshRegistration({ clientInformation: { client_id: "c" }, redirectUri: uri }, uri)).toBe(false);
  });

  it("压根没注册过 → 没东西可重置", () => {
    expect(needsFreshRegistration({}, uri)).toBe(false);
    expect(needsFreshRegistration({ redirectUri: "http://127.0.0.1:1111/callback" }, uri)).toBe(false);
  });
});

describe("authorizeMcpServer 的中断（#504）", () => {
  it("signal 已中断：直接 reject，不起 loopback、不开浏览器", async () => {
    const { authorizeMcpServer } = await import("../../src/main/mcpClient.js");
    const openBrowser = vi.fn();
    const ac = new AbortController();
    ac.abort();
    await expect(
      authorizeMcpServer(
        "s",
        { kind: "http", url: "https://mcp.example.com/mcp", headers: {}, enabled: true },
        { read: () => ({}), write: () => {}, resetClientRegistration: () => {}, openBrowser },
        ac.signal
      )
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(openBrowser).not.toHaveBeenCalled();
  });
});
