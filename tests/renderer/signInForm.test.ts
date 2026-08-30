// 登录/注册表单的两条规则：提交键亮不亮、「再输一遍」那格底下念不念。

import { describe, expect, it } from "vitest";
import {
  MIN_PASSWORD,
  canSubmitSignIn,
  confirmHint,
  type SignInFormState,
} from "../../src/renderer/src/lib/signInForm.js";

const base: SignInFormState = {
  mode: "sign-in",
  name: "",
  email: "a@b.com",
  password: "123456",
  confirm: "",
  busy: false,
};

describe("canSubmitSignIn", () => {
  it("登录：邮箱有 @、密码够长就行，第二格不参与", () => {
    expect(canSubmitSignIn(base)).toBe(true);
    expect(canSubmitSignIn({ ...base, confirm: "对不上也无所谓" })).toBe(true);
  });

  it("提交中一律按不动", () => {
    expect(canSubmitSignIn({ ...base, busy: true })).toBe(false);
  });

  it(`密码短于 ${MIN_PASSWORD} 位按不动`, () => {
    expect(canSubmitSignIn({ ...base, password: "12345" })).toBe(false);
  });

  it("注册：两次不一致就按不动 —— 密码看不见，让他按下去才知道等于没提醒", () => {
    const signUp: SignInFormState = { ...base, mode: "sign-up", name: "小獭", confirm: "" };
    expect(canSubmitSignIn(signUp)).toBe(false);
    expect(canSubmitSignIn({ ...signUp, confirm: "12345x" })).toBe(false);
    expect(canSubmitSignIn({ ...signUp, confirm: "123456" })).toBe(true);
  });

  it("注册：用户名必填 —— 留着一个可以空着的格子，人会以为填不填都行", () => {
    const signUp: SignInFormState = { ...base, mode: "sign-up", confirm: "123456" };
    expect(canSubmitSignIn(signUp)).toBe(false);
    expect(canSubmitSignIn({ ...signUp, name: "   " }), "全空格不算填了").toBe(false);
    expect(canSubmitSignIn({ ...signUp, name: "小獭" })).toBe(true);
  });

  it("登录不问用户名 —— 那是注册那一次的事", () => {
    expect(canSubmitSignIn({ ...base, name: "" })).toBe(true);
  });

  it("邮箱形状只作最粗的判断：`a@qq` 照样可提交 —— 说得清原因的错，让它提交然后说话", () => {
    expect(canSubmitSignIn({ ...base, email: "a@qq" })).toBe(true);
    expect(canSubmitSignIn({ ...base, email: "没有那个符号" })).toBe(false);
  });
});

describe("confirmHint", () => {
  it("登录态没有这一格，不念", () => {
    expect(confirmHint({ ...base, confirm: "x" })).toBeNull();
  });

  it("一格还空着不念 —— 那不是提示，是催促", () => {
    expect(confirmHint({ ...base, mode: "sign-up", confirm: "" })).toBeNull();
  });

  it("打了字又对不上才念", () => {
    expect(confirmHint({ ...base, mode: "sign-up", confirm: "1234" })).toBe("两次输入不一样");
  });

  it("对上了就闭嘴", () => {
    expect(confirmHint({ ...base, mode: "sign-up", confirm: "123456" })).toBeNull();
  });
});
