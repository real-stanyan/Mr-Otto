import { describe, it, expect } from "vitest";
import { profileDirName } from "../../src/main/profile.js";

describe("profileDirName", () => {
  it("不设 OTTO_PROFILE 时是原来的目录（老用户数据不能凭空搬家）", () => {
    expect(profileDirName({})).toBe("mr-otto");
    expect(profileDirName({ OTTO_PROFILE: "" })).toBe("mr-otto");
  });

  it("设了就带后缀", () => {
    expect(profileDirName({ OTTO_PROFILE: "b" })).toBe("mr-otto-b");
    expect(profileDirName({ OTTO_PROFILE: "acct_2" })).toBe("mr-otto-acct_2");
  });

  // 它要拼进文件系统路径，路径穿越会写到数据目录外面去
  it("非法字符直接拒绝，不做静默清洗", () => {
    for (const bad of ["../evil", "a/b", "a b", "a.b", "~"]) {
      expect(() => profileDirName({ OTTO_PROFILE: bad })).toThrow(/OTTO_PROFILE/);
    }
  });
});
