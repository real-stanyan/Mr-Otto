import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { parseSkillMd, scanSkills, type SkillDirReader } from "../../src/main/skills.js";

/** 假文件系统：dirs = root → 子目录名；files = 绝对路径 → 内容 */
function fakeReader(dirs: Record<string, string[]>, files: Record<string, string>): SkillDirReader {
  return {
    listDirs: (root) => dirs[root] ?? [],
    readFile: (path) => files[path] ?? null,
  };
}

const md = (name: string, desc: string) =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n\n# 正文\n照做。`;

describe("parseSkillMd", () => {
  it("提取 name / description，忽略其它键", () => {
    expect(parseSkillMd("---\nname: tdd\ndescription: 先写测试\nlicense: MIT\n---\n正文")).toEqual({
      name: "tdd",
      description: "先写测试",
    });
  });

  it("没有 frontmatter = 空对象（body 照样是合法 skill）", () => {
    expect(parseSkillMd("# 只有正文")).toEqual({});
  });

  it("CRLF 换行也认", () => {
    expect(parseSkillMd("---\r\nname: x\r\n---\r\n正文")).toEqual({ name: "x" });
  });

  it("argument-hint：提取并剥外层引号（Claude Code 同名约定，常写成带引号的档位表）", () => {
    expect(
      parseSkillMd('---\nname: ponytail\nargument-hint: "[lite|full|ultra]"\n---\n正文')
    ).toEqual({ name: "ponytail", argumentHint: "[lite|full|ultra]" });
    // 不带引号原样收
    expect(parseSkillMd("---\nargument-hint: [a|b]\n---\n正文")).toEqual({
      argumentHint: "[a|b]",
    });
  });
});

describe("scanSkills", () => {
  const rootA = "/roots/a";
  const rootB = "/roots/b";

  it("根目录不存在 = 空列表，不炸", () => {
    expect(scanSkills(["/nowhere"], fakeReader({}, {}))).toEqual([]);
  });

  it("argument-hint 随 SkillInfo 带出；没有就没有这个键", () => {
    const r = fakeReader({ [rootA]: ["p", "q"] }, {
      [join(rootA, "p", "SKILL.md")]: '---\nname: p\nargument-hint: "[lite|ultra]"\n---\n正文',
      [join(rootA, "q", "SKILL.md")]: md("q", "无参数"),
    });
    const out = scanSkills([rootA], r);
    expect(out.find((s) => s.name === "p")?.argumentHint).toBe("[lite|ultra]");
    expect("argumentHint" in out.find((s) => s.name === "q")!).toBe(false);
  });

  it("没有 SKILL.md 的目录不是 skill，跳过", () => {
    const r = fakeReader({ [rootA]: ["real", "junk"] }, {
      [join(rootA, "real", "SKILL.md")]: md("real", "真的"),
    });
    expect(scanSkills([rootA], r).map((s) => s.name)).toEqual(["real"]);
  });

  it("frontmatter name 优先于目录名；缺 description 退回空串", () => {
    const r = fakeReader({ [rootA]: ["dir-name"] }, {
      [join(rootA, "dir-name", "SKILL.md")]: "---\nname: fancy\n---\n正文",
    });
    const [s] = scanSkills([rootA], r);
    expect(s).toMatchObject({ name: "fancy", description: "", source: rootA });
    expect(s!.content).toContain("正文");
  });

  it("同名 skill 先到的根目录胜出（otter 原生覆盖兼容目录）", () => {
    const r = fakeReader(
      { [rootA]: ["tdd"], [rootB]: ["tdd"] },
      {
        [join(rootA, "tdd", "SKILL.md")]: md("tdd", "原生版"),
        [join(rootB, "tdd", "SKILL.md")]: md("tdd", "兼容版"),
      }
    );
    const out = scanSkills([rootA, rootB], r);
    expect(out).toHaveLength(1);
    expect(out[0]!.description).toBe("原生版");
  });

  it("跨根目录合并并按 name 排序", () => {
    const r = fakeReader(
      { [rootA]: ["zeta"], [rootB]: ["alpha"] },
      {
        [join(rootA, "zeta", "SKILL.md")]: md("zeta", "z"),
        [join(rootB, "alpha", "SKILL.md")]: md("alpha", "a"),
      }
    );
    expect(scanSkills([rootA, rootB], r).map((s) => s.name)).toEqual(["alpha", "zeta"]);
  });
});
