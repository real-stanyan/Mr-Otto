// mrotto:// 深链 argv 通道（issue #310）：Windows/Linux 深链以命令行参数到达，
// 这里保证从混着可执行路径 / Chromium 开关的 argv 里能把 URL 挑出来。
import { describe, expect, it } from "vitest";
import { findMrottoDeepLink } from "../../src/main/deepLink.js";

describe("findMrottoDeepLink", () => {
  it("从打包 win 实例的 argv 里挑出深链", () => {
    expect(
      findMrottoDeepLink(["C:\\Program Files\\Mr Otto\\Mr Otto.exe", "mrotto://auth-callback?code=abc"]),
    ).toBe("mrotto://auth-callback?code=abc");
  });

  it("混着 Chromium 开关也不受影响", () => {
    expect(
      findMrottoDeepLink(["Mr Otto.exe", "--allow-file-access-from-files", "mrotto://auth-callback?code=x"]),
    ).toBe("mrotto://auth-callback?code=x");
  });

  it("没有深链返回 null（普通二次启动）", () => {
    expect(findMrottoDeepLink(["Mr Otto.exe"])).toBeNull();
    expect(findMrottoDeepLink([])).toBeNull();
  });

  it("只认 mrotto:// 前缀，别的 URL 不当深链", () => {
    expect(findMrottoDeepLink(["Mr Otto.exe", "https://example.com/mrotto://fake"])).toBeNull();
  });
});
