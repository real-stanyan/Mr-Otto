// Git 凭据的「主机」那一格（#1103）。两端共用一份判据，所以它必须自己站得住。

import { describe, it, expect } from "vitest";
import { hostOfRepoUrl, normalizeGitHost, validateGitHost } from "../../../src/shared/remote/gitHost.js";

describe("normalizeGitHost", () => {
  it("小写 + 去空白 + 去结尾的点", () => {
    expect(normalizeGitHost("  GitHub.COM. ")).toBe("github.com");
  });

  it("端口不动 —— 带端口的是另一台机器，合并它等于让一把 token 用到别处去", () => {
    expect(normalizeGitHost("Git.Example.com:8443")).toBe("git.example.com:8443");
    expect(normalizeGitHost("git.example.com")).not.toBe(normalizeGitHost("git.example.com:8443"));
  });
});

describe("validateGitHost", () => {
  it("光主机名照收", () => {
    expect(validateGitHost("github.com")).toEqual({ ok: true, host: "github.com" });
    expect(validateGitHost("  GitLab.COM  ")).toEqual({ ok: true, host: "gitlab.com" });
  });

  it("整条 https URL 也收，归一化成主机名 —— 那是人从地址栏复制过来的常见形态", () => {
    expect(validateGitHost("https://github.com/")).toEqual({ ok: true, host: "github.com" });
    expect(validateGitHost("https://git.example.com:8443/acme/x.git")).toEqual({ ok: true, host: "git.example.com:8443" });
  });

  it("URL 里带 userinfo → 拒绝，且明说 token 该填哪一栏", () => {
    // 这一格会被存进「主机」列并显示给所有在籍成员看，token 贴进来就等于泄漏
    const r = validateGitHost("https://x-access-token:ghp_secret@github.com/");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("token 填下面那一栏");
    expect(JSON.stringify(r)).not.toContain("ghp_secret");
  });

  it("非 https 的整条地址 → 拒绝并说清收到的是什么", () => {
    const r = validateGitHost("ssh://git@github.com/");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("ssh:");
  });

  it("带路径的裸写法 → 拒绝（只填主机名）", () => {
    expect(validateGitHost("github.com/acme").ok).toBe(false);
  });

  it("空 / 超长 → 拒绝", () => {
    expect(validateGitHost("   ").ok).toBe(false);
    expect(validateGitHost("a".repeat(254)).ok).toBe(false);
  });
});

describe("hostOfRepoUrl", () => {
  it("从仓库地址反查主机 —— clone_repo 拿它去凭据表取 token", () => {
    expect(hostOfRepoUrl("https://github.com/acme/widgets.git")).toBe("github.com");
    expect(hostOfRepoUrl("https://Git.Example.com:8443/a/b.git")).toBe("git.example.com:8443");
  });

  it("解析不出来 → null，不猜一个 —— 调用方据此当「没有凭据」处理", () => {
    expect(hostOfRepoUrl("git@github.com:a/b.git")).toBeNull();
    expect(hostOfRepoUrl("")).toBeNull();
  });
});
