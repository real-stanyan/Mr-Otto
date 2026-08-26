// 打包为项目(#559 后续):把 Default 工作区里的产出搬进 文档区/Mr Otto/<名字>。
// 这是唯一一把故意越出围栏的能力,安全边界全部钉在这里:
// 名字不得含路径分隔符、files 必须解析在 workspace 内、目标已存在即拒。
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packageProject } from "../../src/main/projectPackager.js";
import { tempDir } from "../helpers/tempDir.js";

/** 一次性搭出 documents + workspace 两个屋子 */
function setup() {
  const root = tempDir("package-project-");
  const documentsDir = join(root, "Documents");
  const workspace = join(root, "Documents", "Mr Otto", "Default");
  mkdirSync(workspace, { recursive: true });
  return { documentsDir, workspace };
}

describe("packageProject", () => {
  it("搬指定文件进新项目文件夹,返回落点", async () => {
    const { documentsDir, workspace } = setup();
    writeFileSync(join(workspace, "a.md"), "甲", "utf8");
    writeFileSync(join(workspace, "b.md"), "乙", "utf8");
    writeFileSync(join(workspace, "unrelated.txt"), "无关", "utf8");
    const r = await packageProject({ documentsDir, workspace, name: "我的项目", files: ["a.md", "b.md"] });
    expect(r.dir).toBe(join(documentsDir, "Mr Otto", "我的项目"));
    expect(r.moved).toEqual(["a.md", "b.md"]);
    expect(readFileSync(join(r.dir, "a.md"), "utf8")).toBe("甲");
    expect(existsSync(join(workspace, "a.md"))).toBe(false);
    expect(existsSync(join(workspace, "unrelated.txt"))).toBe(true); // 没点名的不动
  });

  it("整个子目录也能搬", async () => {
    const { documentsDir, workspace } = setup();
    mkdirSync(join(workspace, "site"), { recursive: true });
    writeFileSync(join(workspace, "site", "index.html"), "<p>hi</p>", "utf8");
    const r = await packageProject({ documentsDir, workspace, name: "站点", files: ["site"] });
    expect(readFileSync(join(r.dir, "site", "index.html"), "utf8")).toBe("<p>hi</p>");
    expect(existsSync(join(workspace, "site"))).toBe(false);
  });

  it("名字含路径分隔符/点点 = 拒", async () => {
    const { documentsDir, workspace } = setup();
    for (const bad of ["a/b", "a\\b", "..", ".", "", "  "]) {
      await expect(packageProject({ documentsDir, workspace, name: bad, files: [] })).rejects.toThrow();
    }
  });

  it("files 越出 workspace = 拒,一个文件都不搬", async () => {
    const { documentsDir, workspace } = setup();
    writeFileSync(join(workspace, "ok.md"), "好", "utf8");
    await expect(
      packageProject({ documentsDir, workspace, name: "越界", files: ["ok.md", "../../secret.txt"] })
    ).rejects.toThrow(/工作区/);
    // 原子性:名单里有一个越界,连合法的那个也不动
    expect(existsSync(join(workspace, "ok.md"))).toBe(true);
    expect(existsSync(join(documentsDir, "Mr Otto", "越界"))).toBe(false);
  });

  it("目标项目已存在 = 拒(别把两个项目搅在一起)", async () => {
    const { documentsDir, workspace } = setup();
    mkdirSync(join(documentsDir, "Mr Otto", "重名"), { recursive: true });
    writeFileSync(join(workspace, "a.md"), "甲", "utf8");
    await expect(
      packageProject({ documentsDir, workspace, name: "重名", files: ["a.md"] })
    ).rejects.toThrow(/已存在/);
  });

  it("点名的文件不存在 = 拒,报哪一个", async () => {
    const { documentsDir, workspace } = setup();
    await expect(
      packageProject({ documentsDir, workspace, name: "空欢喜", files: ["ghost.md"] })
    ).rejects.toThrow(/ghost\.md/);
  });

  it("files 空 = 拒(打包一个空项目没有意义)", async () => {
    const { documentsDir, workspace } = setup();
    await expect(
      packageProject({ documentsDir, workspace, name: "空的", files: [] })
    ).rejects.toThrow();
  });
});
