import { describe, expect, it } from "vitest";
import { validateReleaseSkillRequest } from "../../src/shared/releaseSkillRequest.js";

// 形状把关先于 append（坏请求零痕迹）——这条规则本身就是 main/index.ts
// releaseSkill handler 的不变量,抽成纯函数才测得到(main/index.ts 顶层有
// app.whenReady 副作用,vitest 直接 import 会炸,见 task-6-report.md)。
// 断言的文案跟 handler 里原来 inline 的一致,不改用户可见话术。
describe("validateReleaseSkillRequest", () => {
  it("name 非字符串 → 拒(形状把关，不管会话存不存在)", () => {
    expect(() => validateReleaseSkillRequest(undefined, true)).toThrow(
      "skill 名字形状非法(应为字符串)"
    );
    expect(() => validateReleaseSkillRequest(123, true)).toThrow(
      "skill 名字形状非法(应为字符串)"
    );
    // 形状把关先于会话检查:非字符串这条,哪怕会话也不存在,报的还是形状错
    expect(() => validateReleaseSkillRequest(null, false)).toThrow(
      "skill 名字形状非法(应为字符串)"
    );
  });

  it("name 是空串 → 照现有 handler 行为:类型对就放行,不额外拒空串", () => {
    expect(() => validateReleaseSkillRequest("", true)).not.toThrow();
  });

  it("会话不存在 → 拒", () => {
    expect(() => validateReleaseSkillRequest("tdd", false)).toThrow("会话不存在");
  });

  it("合法输入 → 放行", () => {
    expect(() => validateReleaseSkillRequest("tdd", true)).not.toThrow();
  });
});
