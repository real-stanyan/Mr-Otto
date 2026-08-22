import { describe, expect, it } from "vitest";
import { configDir, type ConfigDirFs } from "../../src/main/configDir.js";

function fakeFs(existing: string[]): ConfigDirFs & { renames: [string, string][] } {
  const set = new Set(existing);
  const renames: [string, string][] = [];
  return {
    renames,
    exists: (p) => set.has(p),
    rename: (a, b) => {
      renames.push([a, b]);
      set.delete(a);
      set.add(b);
    },
  };
}

describe("configDir", () => {
  it("新目录在就直接用,不碰旧的", () => {
    const fs = fakeFs(["/h/.mr-otto", "/h/.otter"]);
    expect(configDir("/h", fs)).toBe("/h/.mr-otto");
    expect(fs.renames).toEqual([]);
  });
  it("只有旧目录时整目录改名搬过去", () => {
    const fs = fakeFs(["/h/.otter"]);
    expect(configDir("/h", fs)).toBe("/h/.mr-otto");
    expect(fs.renames).toEqual([["/h/.otter", "/h/.mr-otto"]]);
  });
  it("都没有就只返回路径", () => {
    const fs = fakeFs([]);
    expect(configDir("/h", fs)).toBe("/h/.mr-otto");
    expect(fs.renames).toEqual([]);
  });
  it("搬不动不抛", () => {
    const fs = fakeFs(["/h/.otter"]);
    fs.rename = () => { throw new Error("EACCES"); };
    expect(() => configDir("/h", fs)).not.toThrow();
  });
});
