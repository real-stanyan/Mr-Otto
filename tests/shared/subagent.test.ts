import { describe, expect, it } from "vitest";
import { subagentNameError } from "../../src/shared/subagent.js";

// 名字校验（review I6）：以前它只活在渲染层，而主进程的 createSubagent 那侧
// 把非法字符 replace 成 "-" —— "搜索员" 塌成 "---"，非空、通过、建出一个
// 名叫 --- 的 .md。规则收进 shared，两侧同一条，而且是拒绝不是改写
describe("subagentNameError", () => {
  it("合法名字放行", () => {
    for (const ok of ["code-reviewer", "a", "A_1", "x-y_z"]) {
      expect(subagentNameError(ok)).toBeNull();
    }
  });

  it("中文/空格/点/斜杠一律拒绝——名字要变成文件名，也是模型要打出来的词", () => {
    for (const bad of ["搜索员", "code reviewer", "a.b", "../etc/passwd", "a/b"]) {
      expect(subagentNameError(bad)).toMatch(/只能用英文字母/);
    }
  });

  it("空名字有自己的说法", () => {
    expect(subagentNameError("")).toBe("名字不能为空");
  });
});
