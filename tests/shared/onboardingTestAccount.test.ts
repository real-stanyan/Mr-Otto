// QA 测试账号：每次登录强制重放新用户引导（issue #332）。

import { describe, expect, it } from "vitest";
import { isOnboardingTestAccount } from "../../src/shared/onboardingTestAccount.js";

describe("isOnboardingTestAccount", () => {
  it("命中测试邮箱（大小写/首尾空白不敏感——邮箱本来就不区分大小写）", () => {
    expect(isOnboardingTestAccount("otto.test.onboarding@gmail.com")).toBe(true);
    expect(isOnboardingTestAccount("  Otto.Test.Onboarding@Gmail.com ")).toBe(true);
  });

  it("普通账号不命中；空串（未登录）不命中", () => {
    expect(isOnboardingTestAccount("stanhavenoidea@gmail.com")).toBe(false);
    expect(isOnboardingTestAccount("")).toBe(false);
  });
});
