import { describe, expect, it } from "vitest";
import { buildWorkReadScript, buildWorkSearchScript } from "../../services/runtime/src/workFiles.js";

/** 脚本里除了分隔命令的换行，不许有任何裸控制字符 */
function strayControlChars(script: string): string[] {
  const out: string[] = [];
  for (const ch of script) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\n") continue;
    if (code < 0x20 || code === 0x7f) out.push(`U+${code.toString(16).padStart(4, "0")}`);
  }
  return [...new Set(out)];
}

// #1066 抓到的真 bug（#1056 合进去时就带着，只是还没部署）：脚本是拼在普通模板串
// 里的，`\0` 于是变成一个**真的 NUL 字节**——而 execve 的参数在 NUL 处截断，
// `find -printf '…%f\0'` 丢掉分隔符（每个目录都解析成空的）、`tr -d '\0'` 变成
// `tr -d ''`（二进制永远判不出来）。两处都不报错，只是安静地给出错误答案，
// 而单测因为压根不看脚本字节照样全绿。
//
// 所以判据是**脚本的字节**，不是「有没有调那个函数」：转义写错一次就在这里红。
describe("脚本里不许有裸控制字符（#1066）", () => {
  it("读脚本：`\\0` `\\t` `\\n` 必须是两个字符的转义序列", () => {
    for (const path of ["", "src", "a'b"]) {
      const script = buildWorkReadScript(path);
      expect(strayControlChars(script)).toEqual([]);
      // 反过来钉一次：转义序列本身要在
      expect(script).toContain(String.raw`%y\t%s\t%T@\t%f\0`);
      expect(script).toContain(String.raw`tr -d '\0'`);
      expect(script).toContain(String.raw`printf 'dir\n'`);
    }
  });

  it("搜脚本：同一条", () => {
    for (const content of [true, false]) {
      const script = buildWorkSearchScript("查询", content);
      expect(strayControlChars(script)).toEqual([]);
      expect(script).toMatch(/printf '(hits|files)\\t%s\\n' "\$rc"/);
    }
  });
});
