// profileEdit 的改密码那两句判据（#1386）。名字收敛 / 头像准入 / 列补丁的用例仍在
// tests/main/userProfile.test.ts（它们从主进程那边再导出的同一份函数）。
import { describe, expect, it } from "vitest";
import { centerSquare, passwordProblem, passwordReady } from "../../src/shared/profileEdit.js";
import { MIN_PASSWORD } from "../../src/shared/signInForm.js";

describe("passwordProblem", () => {
  it("还没输到那一格时不喊", () => {
    expect(passwordProblem("", "", "")).toBe("");
    expect(passwordProblem("old-pass", "", "")).toBe("");
  });
  it("顺序就是人填的顺序：够不够长 → 两次一不一样 → 和现在的是不是同一个", () => {
    expect(passwordProblem("old-pass", "abc", "")).toBe(`新密码至少 ${MIN_PASSWORD} 位`);
    expect(passwordProblem("old-pass", "longenough", "longenougx")).toBe("两次输的新密码不一样");
    expect(passwordProblem("same-pass", "same-pass", "same-pass")).toBe("新密码和现在的一样");
    expect(passwordProblem("old-pass", "new-pass-1", "new-pass-1")).toBe("");
  });
});

describe("passwordReady", () => {
  it("三格都填、够长、两次一样、和现在的不同才按得动", () => {
    expect(passwordReady("old-pass", "new-pass-1", "new-pass-1")).toBe(true);
    expect(passwordReady("", "new-pass-1", "new-pass-1")).toBe(false);
    expect(passwordReady("old-pass", "abc", "abc")).toBe(false);
    expect(passwordReady("old-pass", "new-pass-1", "new-pass-2")).toBe(false);
    expect(passwordReady("new-pass-1", "new-pass-1", "new-pass-1")).toBe(false);
  });
});

describe("centerSquare", () => {
  it("取正中那一块正方形；宽高不对回 null", () => {
    expect(centerSquare(400, 300)).toEqual({ originX: 50, originY: 0, width: 300, height: 300 });
    expect(centerSquare(300, 401)).toEqual({ originX: 0, originY: 50, width: 300, height: 300 });
    expect(centerSquare(0, 10)).toBeNull();
    expect(centerSquare(Number.NaN, 10)).toBeNull();
  });
});
