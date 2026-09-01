// cloudRepoUrl 的纯逻辑单测（issue #821 slice 2）：钉住"URL 里嵌了凭据"的
// 判定——runtime 侧 redactPat() 认不出这种形态，这道闸得在渲染层提交前挡住。

import { describe, expect, it } from "vitest";
import { repoUrlHasEmbeddedCredential } from "../../src/renderer/src/lib/cloudRepoUrl.js";

describe("repoUrlHasEmbeddedCredential", () => {
  it("<token>@ 形态——命中", () => {
    expect(repoUrlHasEmbeddedCredential("https://ghp_abc123@github.com/x/y.git")).toBe(true);
  });

  it("user:pass@ 形态——命中", () => {
    expect(repoUrlHasEmbeddedCredential("https://user:pass@github.com/x/y.git")).toBe(true);
  });

  it("只有密码没有用户名（:pass@）——命中", () => {
    expect(repoUrlHasEmbeddedCredential("https://:pass@github.com/x/y.git")).toBe(true);
  });

  it("干净的 https URL——不命中", () => {
    expect(repoUrlHasEmbeddedCredential("https://github.com/x/y.git")).toBe(false);
  });

  it("@ 出现在 path 里、不是 userinfo——不命中（不能误伤）", () => {
    expect(repoUrlHasEmbeddedCredential("https://github.com/x/y@z.git")).toBe(false);
  });

  it("scp 语法（git@host:path）解析不出 URL——不是这个函数管的，回 false", () => {
    expect(repoUrlHasEmbeddedCredential("git@github.com:x/y.git")).toBe(false);
  });

  it("空字符串——不命中", () => {
    expect(repoUrlHasEmbeddedCredential("")).toBe(false);
  });
});
