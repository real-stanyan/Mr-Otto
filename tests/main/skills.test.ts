import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  externalSkillSources,
  importExternalSkills,
  parseSkillMd,
  scanExternalSkills,
  scanSkills,
  type SkillCopier,
  type SkillDirReader,
} from "../../src/main/skills.js";

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

/** 假复制器：记录复制动作，existing 里的路径视为已占用 */
function fakeCopier(existing: string[] = []) {
  const copies: Array<{ src: string; dest: string }> = [];
  const copier: SkillCopier = {
    exists: (path) => existing.includes(path),
    copyDir: (src, dest) => {
      copies.push({ src, dest });
    },
  };
  return { copier, copies };
}

const claudeRoot = "/home/.claude/skills";
const codexRoot = "/home/.codex/skills";
const SOURCES = [
  { vendor: "Claude Code", root: claudeRoot },
  { vendor: "Codex", root: codexRoot },
];
const destRoot = "/home/.mr-otto/skills";

describe("externalSkillSources", () => {
  it("都在 home 下、且不含 Mr Otto 自己的根目录", () => {
    const roots = externalSkillSources("/home").map((s) => s.root);
    expect(roots.every((r) => r.startsWith("/home/"))).toBe(true);
    expect(roots).not.toContain(join("/home", ".mr-otto", "skills"));
  });
});

describe("scanExternalSkills", () => {
  it("带厂家名；与已装同名的标 installed", () => {
    const r = fakeReader(
      { [claudeRoot]: ["tdd"], [codexRoot]: ["fmt"] },
      {
        [join(claudeRoot, "tdd", "SKILL.md")]: md("tdd", "别家的"),
        [join(codexRoot, "fmt", "SKILL.md")]: md("fmt", "格式化"),
      }
    );
    const out = scanExternalSkills(SOURCES, new Set(["tdd"]), r);
    expect(out).toEqual([
      { name: "fmt", description: "格式化", vendor: "Codex", installed: false },
      { name: "tdd", description: "别家的", vendor: "Claude Code", installed: true },
    ]);
  });

  it("跨厂家同名先到先得（sources 顺序）", () => {
    const r = fakeReader(
      { [claudeRoot]: ["x"], [codexRoot]: ["x"] },
      {
        [join(claudeRoot, "x", "SKILL.md")]: md("x", "claude 版"),
        [join(codexRoot, "x", "SKILL.md")]: md("x", "codex 版"),
      }
    );
    const out = scanExternalSkills(SOURCES, new Set(), r);
    expect(out).toHaveLength(1);
    expect(out[0]!.vendor).toBe("Claude Code");
  });
});

describe("importExternalSkills", () => {
  const reader = fakeReader(
    { [claudeRoot]: ["tdd", "mine"], [codexRoot]: ["fmt"], [destRoot]: ["mine"] },
    {
      [join(claudeRoot, "tdd", "SKILL.md")]: md("tdd", "别家的"),
      [join(claudeRoot, "mine", "SKILL.md")]: md("mine", "别家同名版"),
      [join(codexRoot, "fmt", "SKILL.md")]: md("fmt", "格式化"),
      [join(destRoot, "mine", "SKILL.md")]: md("mine", "已装"),
    }
  );

  it("整目录复制进 destRoot，沿用来源目录名", () => {
    const { copier, copies } = fakeCopier();
    const out = importExternalSkills(["tdd", "fmt"], SOURCES, destRoot, reader, copier);
    expect(out).toEqual([
      { name: "tdd", ok: true },
      { name: "fmt", ok: true },
    ]);
    expect(copies).toEqual([
      { src: join(claudeRoot, "tdd"), dest: join(destRoot, "tdd") },
      { src: join(codexRoot, "fmt"), dest: join(destRoot, "fmt") },
    ]);
  });

  it("找不到 / 同名已装 / 目标目录被占 = 逐条失败带原因，不拖垮其余", () => {
    const { copier, copies } = fakeCopier([join(destRoot, "fmt")]);
    const out = importExternalSkills(["ghost", "mine", "fmt", "tdd"], SOURCES, destRoot, reader, copier);
    expect(out).toEqual([
      { name: "ghost", ok: false, reason: "来源里找不到该 skill" },
      { name: "mine", ok: false, reason: "同名 skill 已存在" },
      { name: "fmt", ok: false, reason: "目标目录已存在" },
      { name: "tdd", ok: true },
    ]);
    expect(copies).toEqual([{ src: join(claudeRoot, "tdd"), dest: join(destRoot, "tdd") }]);
  });

  it("同一批里勾了两次同名：第二条按已存在挡下（不重复复制）", () => {
    const { copier, copies } = fakeCopier();
    const out = importExternalSkills(["tdd", "tdd"], SOURCES, destRoot, reader, copier);
    expect(out).toEqual([
      { name: "tdd", ok: true },
      { name: "tdd", ok: false, reason: "同名 skill 已存在" },
    ]);
    expect(copies).toHaveLength(1);
  });

  it("复制抛异常 = 该条失败带信息，其余照常", () => {
    const copier: SkillCopier = {
      exists: () => false,
      copyDir: (src) => {
        if (src.includes("tdd")) throw new Error("磁盘满了");
      },
    };
    const out = importExternalSkills(["tdd", "fmt"], SOURCES, destRoot, reader, copier);
    expect(out).toEqual([
      { name: "tdd", ok: false, reason: "磁盘满了" },
      { name: "fmt", ok: true },
    ]);
  });
});
