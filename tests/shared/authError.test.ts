// 登录报错翻译里两端共用的那一半（src/shared/authError.ts）。
// 桌面剥 IPC 壳的那层包装由 tests/renderer/authError.test.ts 守着；这里钉手机端直接用的那几条。

import { describe, expect, it } from "vitest";
import { authNoticeOf, localEmailProblem } from "../../src/shared/authError.js";

describe("authNoticeOf", () => {
  it("手机端直接交 supabase 原文：密码不对时两种可能都说出来", () => {
    const n = authNoticeOf("Invalid login credentials");
    expect(n.title).toBe("邮箱或密码不对");
    expect(n.hint).toContain("Google / GitHub");
  });

  it("空白原文不装成翻译过", () => {
    expect(authNoticeOf("   ").title).toBe("没成功，但没说原因");
  });

  it("本地预检那句与服务端同文，翻出来是同一条", () => {
    const bad = localEmailProblem("a@qq");
    expect(bad).not.toBeNull();
    expect(authNoticeOf(bad ?? "").title).toBe("这个邮箱地址填得不太对");
  });

  it("已经是中文的（我们自己写的话）原样当标题", () => {
    expect(authNoticeOf("主进程还是旧的一版").title).toBe("主进程还是旧的一版");
  });
});
