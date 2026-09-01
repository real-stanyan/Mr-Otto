// cloudRepoUrl 的纯逻辑单测（issue #821 slice 2）：钉住"URL 里嵌了凭据"的
// 判定——runtime 侧 redactPat() 认不出这种形态，这道闸得在渲染层提交前挡住。
//
// 复审 Critical（fix round）：上一版对解析失败（`new URL()` 抛异常）的字符串
// 一律回 false，即"解析不出=安全"，方向反了——缺 scheme / scp 语法 / 端口
// 非法这些畸形输入恰恰是最像"把 token 当用户名手写"的形态。下面标了
// "复审 Critical" 的用例是当时实测出来的真绕过，现在钉成回归；其余不变。

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

  it("scp 语法（git@host:path，不带 token，只是 git 这个固定 SSH 用户名）——命中，一律拦", () => {
    // 这条期望从 false 改成 true，不是"放宽判据去多抓一类无害输入"：
    // runtime 侧 clone 走 https + git credential approve（sandbox.ts），
    // 沙箱里压根没配 SSH key，这种 URL 在这个系统里本来就永远 clone 不
    // 成功——与其放它提交、跑一趟、失败、再把原串广播出去，不如在输入框
    // 就拦下来。判定改了，是因为"这个系统根本不支持 SSH"这个事实没变过。
    expect(repoUrlHasEmbeddedCredential("git@github.com:x/y.git")).toBe(true);
  });

  it("复审 Critical：无 scheme 夹带 token——曾经因 new URL() 抛异常被判 false，现在命中", () => {
    expect(repoUrlHasEmbeddedCredential("ghp_leaked123@github.com/x/y.git")).toBe(true);
  });

  it("复审 Critical：scp 语法夹带真实 token（用真实 token 冒充 SSH 用户名）——命中", () => {
    expect(repoUrlHasEmbeddedCredential("ghp_realtoken123@github.com:x/y.git")).toBe(true);
  });

  it("复审 Critical：端口非法致 new URL() 整体抛异常——命中，不能因为跳过 scheme 的 // 而漏判", () => {
    expect(repoUrlHasEmbeddedCredential("http://git@github.com:x/y.git")).toBe(true);
  });

  it("空字符串——不命中", () => {
    expect(repoUrlHasEmbeddedCredential("")).toBe(false);
  });
});
