import { describe, it, expect } from "vitest";
import {
  isAllowedPopupTarget,
  isAllowedTopLevelNavigation,
  shouldReportLoadFailure,
} from "../../src/main/browserNavigationPolicy.js";

describe("window.open 目标白名单", () => {
  it("http(s) 放行", () => {
    expect(isAllowedPopupTarget("https://example.com/x")).toBe(true);
    expect(isAllowedPopupTarget("http://localhost:5173")).toBe(true);
  });

  it("file:// 拒绝 —— 不可信页面不能从这条后门把本机文件塞进'读当前页'", () => {
    expect(isAllowedPopupTarget("file:///etc/passwd")).toBe(false);
  });

  it("自定义协议一律拒绝", () => {
    expect(isAllowedPopupTarget("mrotto://auth-callback?code=stolen")).toBe(false);
    expect(isAllowedPopupTarget("javascript:alert(1)")).toBe(false);
    expect(isAllowedPopupTarget("data:text/html,<h1>x")).toBe(false);
  });

  it("畸形 url 按拒绝处理,不让异常逃出去", () => {
    expect(isAllowedPopupTarget("not a url")).toBe(false);
    expect(isAllowedPopupTarget("")).toBe(false);
  });
});

describe("顶层导航白名单", () => {
  it("普通网页照常浏览(含重定向落点)", () => {
    expect(isAllowedTopLevelNavigation("https://example.com")).toBe(true);
    expect(isAllowedTopLevelNavigation("https://www.example.com/en-US/")).toBe(true);
    expect(isAllowedTopLevelNavigation("http://127.0.0.1:3000/a?b=c#d")).toBe(true);
  });

  it("about:blank 放行 —— 新建 view 的初始地址,拦了会连正常状态一起拦掉", () => {
    expect(isAllowedTopLevelNavigation("about:blank")).toBe(true);
  });

  it("mrotto:// 拦下 —— 这才是这道守门存在的理由(app 注册了这个协议处理器,"
     + "回调里的 code 直接进登录流程)", () => {
    expect(isAllowedTopLevelNavigation("mrotto://auth-callback?code=stolen")).toBe(false);
  });

  it("其它非 http(s) 一律拦下", () => {
    expect(isAllowedTopLevelNavigation("file:///etc/passwd")).toBe(false);
    expect(isAllowedTopLevelNavigation("about:config")).toBe(false);
    expect(isAllowedTopLevelNavigation("javascript:alert(1)")).toBe(false);
    expect(isAllowedTopLevelNavigation("畸形")).toBe(false);
  });
});

describe("did-fail-load 过滤", () => {
  it("主框架的真失败要报", () => {
    expect(shouldReportLoadFailure(-105, true)).toBe(true);
  });

  it("子框架失败不报 —— 广告 iframe 挂了不是这一页挂了", () => {
    expect(shouldReportLoadFailure(-105, false)).toBe(false);
  });

  it("-3(ABORTED)不报 —— 中途换页是预期行为,不是错", () => {
    expect(shouldReportLoadFailure(-3, true)).toBe(false);
    expect(shouldReportLoadFailure(-3, false)).toBe(false);
  });
});
