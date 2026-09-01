// cloudRepoUrl 的纯逻辑单测（issue #821 slice 2）：钉住"URL 里像不像嵌了
// 凭据"的判定。注意（复审 round 3 架构判定）：这个函数现在只是提交前的
// 早期 UX 提示，不是安全边界——真正的防线是 runtime 侧的输出脱敏
// （safeRepoLabel），下面这些用例钉的是"这个函数的行为符合预期"，不是
// "少一条就等于凭据泄漏"。
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
// 复审 round 3（两类更进一步的绕过，收工前最后两条便宜的）：全角＠
// （U+FF20）/ 小型﹫（U+FE6B）没有被折成 ASCII @——这条值得修是因为它可能
// 是中文输入法全角标点模式下无意产生的，不只是攻击串；解码循环跑满
// MAX_DECODE_ITERATIONS 仍未收敛时静默返回当前状态，等于对 11 层以上
// 嵌套编码放行。修法：归一化流水线在 decode 之后加一步 NFKC，且到顶未
// 收敛时 fail-closed（判 true）而不是放行。
//
// 下面每条用例的注释都写清它具体防的是哪一种绕过形态，不写"同上"。

import { describe, expect, it } from "vitest";
import { repoUrlHasEmbeddedCredential } from "../../src/renderer/src/lib/cloudRepoUrl.js";

/** 构造"把 char 嵌套 encodeURIComponent layers 层"的字符串，给 round 3 的
    「解码到顶 fail-closed」用例造一个超过 MAX_DECODE_ITERATIONS 的输入——
    手写一串 %2525...40 字面量既难读又难改上限，不如现算 */
function nestedEncode(char: string, layers: number): string {
  let s = char;
  for (let i = 0; i < layers; i++) s = encodeURIComponent(s);
  return s;
}

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

  describe("不能误伤（round 3 新增）：NFKC 折叠不该把无关的全角/兼容字符判成凭据", () => {
    it("path 里有中文字符（不是全角标点）——NFKC 折叠不引入误报", () => {
      expect(repoUrlHasEmbeddedCredential("https://github.com/x/中文路径.git")).toBe(false);
    });

    it("path 里有全角连字符（－，不是@，NFKC 会把它折成 ASCII - 但那不是凭据分隔符）——不命中", () => {
      expect(repoUrlHasEmbeddedCredential("https://github.com/x/y－z.git")).toBe(false);
    });

    it("path 里有全角括号（（） ，NFKC 折成 ASCII () 但同样不是@）——不命中", () => {
      expect(repoUrlHasEmbeddedCredential("https://github.com/x/（y）.git")).toBe(false);
    });

    it("IDNA punycode 域名（正常 https，非 ASCII 域名的 ASCII 编码形式）——不受 NFKC 步骤影响", () => {
      expect(repoUrlHasEmbeddedCredential("https://xn--fiqs8s.example/x/y.git")).toBe(false);
    });

    it("fragment 里有全角井号——new URL() 能正常解析（走主路径），不受这个函数的兜底逻辑影响", () => {
      expect(repoUrlHasEmbeddedCredential("https://github.com/x/y.git#＃frag")).toBe(false);
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

  describe("复审 round 3：round 1/2 的归一化仍然漏了 Unicode 变体和解码上限两类", () => {
    it("全角＠（U+FF20，无 scheme）——曾经因兜底只认 ASCII @ 而漏判；中文输入法全角标点模式下可能无意产生，不只是攻击串", () => {
      expect(repoUrlHasEmbeddedCredential("ghp_realtoken＠github.com/x/y.git")).toBe(true);
    });

    it("全角＠（U+FF20，带 https scheme）——这个字符串本身也让 new URL() 抛异常，落进同一个兜底", () => {
      expect(repoUrlHasEmbeddedCredential("https://ghp_realtoken＠github.com/x/y.git")).toBe(true);
    });

    it("小型﹫（U+FE6B）——同一族 Unicode 兼容字符，NFKC 一并折成 ASCII @", () => {
      expect(repoUrlHasEmbeddedCredential("ghp_x﹫github.com/x/y.git")).toBe(true);
    });

    it("11 层嵌套 percent-encoding（超过 MAX_DECODE_ITERATIONS=10）——到顶仍未收敛，fail-closed 判 true，不是静默放行", () => {
      const deeplyEncodedAt = nestedEncode("@", 11);
      expect(repoUrlHasEmbeddedCredential(`ghp_deep${deeplyEncodedAt}github.com/x/y.git`)).toBe(true);
    });
  });
});
