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
import { describe, it, expect } from "vitest";
import { isAuthError } from "../../src/main/mcpClient.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

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
