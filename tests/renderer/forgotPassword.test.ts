// 忘记密码弹窗的三条纯规则。

import { describe, expect, it } from "vitest";
import {
  OTP_LENGTH,
  canSubmitOtp,
  normalizeOtp,
  resendLabel,
} from "../../src/renderer/src/lib/forgotPassword.js";

describe("normalizeOtp", () => {
  it("从邮件里整句粘进来也认 —— 只留数字", () => {
    expect(normalizeOtp("验证码：12345678")).toBe("12345678");
    expect(normalizeOtp(" 1234 5678 \n")).toBe("12345678");
  });

  it(`砍到 ${OTP_LENGTH} 位：多打的不该悄悄跟着提交上去`, () => {
    expect(normalizeOtp("1234567890")).toBe("12345678");
    expect(normalizeOtp("12345678").length).toBe(OTP_LENGTH);
  });

  it("一个数字都没有就是空", () => {
    expect(normalizeOtp("abc")).toBe("");
    expect(normalizeOtp("")).toBe("");
  });
});

describe("canSubmitOtp", () => {
  it(`够 ${OTP_LENGTH} 位才亮`, () => {
    expect(canSubmitOtp("1234567", false)).toBe(false);
    expect(canSubmitOtp("12345678", false)).toBe(true);
  });

  it("带噪音的也算数 —— 判据走 normalize 之后的那一份", () => {
    expect(canSubmitOtp("1234 5678", false)).toBe(true);
  });

  it("在飞的时候一律按不动", () => {
    expect(canSubmitOtp("12345678", true)).toBe(false);
  });
});

describe("resendLabel", () => {
  it("冷却期内把秒数写出来 —— 灰着不给理由,人只会反复点", () => {
    expect(resendLabel(42)).toContain("42");
  });

  it("解冻了就只剩四个字", () => {
    expect(resendLabel(0)).toBe("重新发送");
  });
});
