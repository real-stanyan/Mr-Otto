import { describe, expect, it } from "vitest";
import { migrateProjectMemories } from "../../src/main/projectMemoryMigrate.js";
import { projectMemoryDir } from "../../src/main/projectRoot.js";

/** 假 memoryFiles：只要 projectDirs / read / write 三件。write 记账，
    因为「有没有多写一次」正是「每次开机白推一遍云端」的判据 */
function fakeFiles(seed: Record<string, string> = {}) {
  const disk = new Map(Object.entries(seed));
  const writes: string[] = [];
  return {
    disk,
    writes,
    files: {
      projectDirs: async () => [
        ...new Set(
          [...disk.keys()]
            .filter((k) => k.startsWith("memories/projects/"))
            .map((k) => k.split("/")[2]!)
        ),
      ],
      read: async (rel: string) => disk.get(rel) ?? "",
      write: async (rel: string, c: string) => {
        writes.push(rel);
        disk.set(rel, c);
      },
    },
  };
}

const LEGACY = projectMemoryDir("/Users/a/Mr_Otto");
const OTHER = projectMemoryDir("/Users/b/code/Mr_Otto");
const CANON = projectMemoryDir("github.com/o/mr-otto");
const scopeOf = (root: string) =>
  root === "/Users/a/Mr_Otto" ? "github.com/o/mr-otto" : root; // 别的机器的路径在本机解析不出 remote

describe("migrateProjectMemories（#886：旧目录并进新作用域键）", () => {
  it("本机那份旧目录搬进新键：内容合并、root.txt 换成键、旧目录留墓碑", async () => {
    const { disk, files } = fakeFiles({
      [`${LEGACY}/root.txt`]: "/Users/a/Mr_Otto",
      [`${LEGACY}/MEMORY.md`]: "门禁是 npm test",
    });
    const { merged } = await migrateProjectMemories({ files, scopeOf });
    expect(merged).toEqual([{ from: "/Users/a/Mr_Otto", to: "github.com/o/mr-otto" }]);
    expect(disk.get(`${CANON}/MEMORY.md`)).toBe("门禁是 npm test");
    expect(disk.get(`${CANON}/root.txt`)).toBe("github.com/o/mr-otto");
    expect(disk.get(`${LEGACY}/merged.txt`)).toBe("github.com/o/mr-otto");
    // 旧目录的正文**不删**：云同步没有墓碑机制，删除会被别的机器原样推回来
    expect(disk.get(`${LEGACY}/MEMORY.md`)).toBe("门禁是 npm test");
  });

  it("新键已有内容时是并集不是覆盖——两台机器先后迁移，后到的不该抹掉先到的", async () => {
    const { disk, files } = fakeFiles({
      [`${CANON}/root.txt`]: "github.com/o/mr-otto",
      [`${CANON}/MEMORY.md`]: "甲机写的",
      [`${LEGACY}/root.txt`]: "/Users/a/Mr_Otto",
      [`${LEGACY}/MEMORY.md`]: "甲机写的\n§\n乙机写的",
    });
    await migrateProjectMemories({ files, scopeOf });
    expect(disk.get(`${CANON}/MEMORY.md`)).toBe("甲机写的\n§\n乙机写的");
  });

  it("跑第二遍什么都不写：墓碑在，就不会把用户手删掉的条目重新合回来", async () => {
    const seeded = fakeFiles({
      [`${LEGACY}/root.txt`]: "/Users/a/Mr_Otto",
      [`${LEGACY}/MEMORY.md`]: "门禁是 npm test",
    });
    await migrateProjectMemories({ files: seeded.files, scopeOf });
    // 用户随后在设置页删掉了这一条
    seeded.disk.set(`${CANON}/MEMORY.md`, "");
    seeded.writes.length = 0;
    const { merged } = await migrateProjectMemories({ files: seeded.files, scopeOf });
    expect(merged).toEqual([]);
    expect(seeded.writes).toEqual([]);
    expect(seeded.disk.get(`${CANON}/MEMORY.md`)).toBe("");
  });

  it("别的机器的旧目录留在原地：它的归属只有那台机器说得清", async () => {
    const { disk, files } = fakeFiles({
      [`${OTHER}/root.txt`]: "/Users/b/code/Mr_Otto",
      [`${OTHER}/MEMORY.md`]: "乙机写的",
    });
    const { merged } = await migrateProjectMemories({ files, scopeOf });
    expect(merged).toEqual([]);
    expect(disk.get(`${OTHER}/merged.txt`)).toBeUndefined();
  });

  it("已经是 remote 键的目录、以及没有 root.txt 的孤儿目录，都不动", async () => {
    const { files, writes } = fakeFiles({
      [`${CANON}/root.txt`]: "github.com/o/mr-otto",
      [`${CANON}/MEMORY.md`]: "甲",
      "memories/projects/orphan/MEMORY.md": "孤儿",
    });
    await migrateProjectMemories({ files, scopeOf });
    expect(writes).toEqual([]);
  });
});
