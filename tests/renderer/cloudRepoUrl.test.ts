// cloudRepoUrl 的纯逻辑单测（issue #821 slice 2）：钉住"URL 里嵌了凭据"的
// 判定——runtime 侧 redactPat() 认不出这种形态，这道闸得在渲染层提交前挡住。
//
// 复审 Critical round 1（fix round）：上一版对解析失败（`new URL()` 抛异常）
// 的字符串一律回 false，即"解析不出=安全"，方向反了——缺 scheme / scp 语法 /
// 端口非法这些畸形输入恰恰是最像"把 token 当用户名手写"的形态。
//
// 复审 Critical round 2（同一个兜底自己又漏两类）：round 1 的兜底在原始
// （未解码）字符串上找 @，且只剥"真 scheme://"前缀——percent-encode 过的
// %40 和没有 scheme 标签的协议相对形式（//host/path）都能绕过去。归一化
// 流水线（trim → decode 到不动点 → 剥 scheme → 剥前导 /）补上这两类。
//
// 下面每条用例的注释都写清它具体防的是哪一种绕过形态，不写"同上"。

import { describe, expect, it } from "vitest";
import { repoUrlHasEmbeddedCredential } from "../../src/renderer/src/lib/cloudRepoUrl.js";

describe("repoUrlHasEmbeddedCredential", () => {
  describe("标准 https URL——new URL() 能直接解析，走 username/password 判定", () => {
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
  });

  describe("不能误伤：@ 出现在 authority 之外的合法位置", () => {
    it("@ 出现在 path 里、不是 userinfo——不命中", () => {
      expect(repoUrlHasEmbeddedCredential("https://github.com/x/y@z.git")).toBe(false);
    });

    it("@ 出现在 query 里、不是 userinfo——不命中", () => {
      expect(repoUrlHasEmbeddedCredential("https://github.com/x/y.git?a=b@c")).toBe(false);
    });

    it("空字符串——不命中", () => {
      expect(repoUrlHasEmbeddedCredential("")).toBe(false);
    });
  });

  describe("scp 语法——sandbox 没有 SSH key，clone 必然失败，一律拦（不是放宽，是这个系统不支持 SSH）", () => {
    it("scp 语法（git@host:path，不带 token，只是 git 这个固定 SSH 用户名）——命中", () => {
      // 这条期望从 false 改成 true，不是"放宽判据去多抓一类无害输入"：
      // runtime 侧 clone 走 https + git credential approve（sandbox.ts），
      // 沙箱里压根没配 SSH key，这种 URL 在这个系统里本来就永远 clone 不
      // 成功——与其放它提交、跑一趟、失败、再把原串广播出去，不如在输入框
      // 就拦下来。判定改了，是因为"这个系统根本不支持 SSH"这个事实没变过。
      expect(repoUrlHasEmbeddedCredential("git@github.com:x/y.git")).toBe(true);
    });

    it("scp 语法夹带真实 token（用真实 token 冒充 SSH 用户名）——命中", () => {
      expect(repoUrlHasEmbeddedCredential("ghp_realtoken123@github.com:x/y.git")).toBe(true);
    });
  });

  describe("复审 Critical round 1：new URL() 解析失败不能退到「安全」", () => {
    it("无 scheme 夹带 token（漏写 https:// 前缀）——曾经因 new URL() 抛异常被判 false，现在命中", () => {
      expect(repoUrlHasEmbeddedCredential("ghp_leaked123@github.com/x/y.git")).toBe(true);
    });

    it("端口非法致 new URL() 整体抛异常——命中，不能因为跳过 scheme 的 // 而漏判", () => {
      expect(repoUrlHasEmbeddedCredential("http://git@github.com:x/y.git")).toBe(true);
    });
  });

  describe("复审 Critical round 2：round 1 的兜底本身又漏了两类绕过", () => {
    it("%40 编码的 @、无 scheme——曾经因兜底只在原始字符串上 indexOf(\"@\") 而漏判，现在先解码再判", () => {
      expect(repoUrlHasEmbeddedCredential("token%40github.com/x/y.git")).toBe(true);
    });

    it("%40 编码的 @、带 https scheme——这个字符串本身也让 new URL() 抛异常（host 校验挂），落进同一个兜底", () => {
      expect(repoUrlHasEmbeddedCredential("https://token%40github.com/x/y.git")).toBe(true);
    });

    it("协议相对形式（//host/path，没有 scheme 标签）——曾经因剥不掉开头的 // 导致\"第一个 /\"落在位置 0 而漏判", () => {
      expect(repoUrlHasEmbeddedCredential("//ghp_xxx@github.com/x/y.git")).toBe(true);
    });

    it("协议相对形式的变体（///host/path，三条前导斜杠）——同根因，剥所有前导 / 而不是只剥两条", () => {
      expect(repoUrlHasEmbeddedCredential("///ghp_xxx@github.com/x/y.git")).toBe(true);
    });

    it("双重编码 %2540（→ %40 → @）——验证解码是循环到不动点，不是只解一层", () => {
      expect(repoUrlHasEmbeddedCredential("token%2540github.com/x/y.git")).toBe(true);
    });
  });
});
