import { describe, it, expect } from "vitest";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAlwaysAllow, addAlwaysAllow, removeAlwaysAllow } from "../../src/main/permissionStore.js";
import { tempDir } from "../helpers/tempDir.js";

function storePath() {
  return join(tempDir("otter-perm-"), "permissions.json");
}

describe("permissionStore", () => {
  it("没有文件 = 什么都没授过", () => {
    expect(loadAlwaysAllow(storePath())).toEqual(new Set());
  });

  it("roundtrip;文件权限 0600 —— 别人可写 = 别人可以替你点头", () => {
    const path = storePath();
    addAlwaysAllow(path, "write_file");
    expect(loadAlwaysAllow(path)).toEqual(new Set(["write_file"]));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("幂等:授过的再授一次不变形状", () => {
    const path = storePath();
    addAlwaysAllow(path, "bash");
    addAlwaysAllow(path, "bash");
    expect([...loadAlwaysAllow(path)]).toEqual(["bash"]);
  });

  it("多条并存", () => {
    const path = storePath();
    addAlwaysAllow(path, "write_file");
    addAlwaysAllow(path, "bash");
    expect(loadAlwaysAllow(path)).toEqual(new Set(["write_file", "bash"]));
  });

  it("坏 JSON = 当没授过,不是崩 —— 这个文件被手改过是常态", () => {
    const path = storePath();
    writeFileSync(path, "{ 这不是 json");
    expect(loadAlwaysAllow(path)).toEqual(new Set());
  });

  it("形状不对(不是数组)也当没授过 —— 宁可多问一次,不能凭一个坏文件开门", () => {
    const path = storePath();
    writeFileSync(path, JSON.stringify({ alwaysAllow: "write_file" }));
    expect(loadAlwaysAllow(path)).toEqual(new Set());
  });

  it("数组里的非字符串成员被滤掉", () => {
    const path = storePath();
    writeFileSync(path, JSON.stringify({ alwaysAllow: ["bash", 42, null] }));
    expect(loadAlwaysAllow(path)).toEqual(new Set(["bash"]));
  });

  // issue #370：设置页的撤销入口。删除 = 下一次 loadAlwaysAllow 就没有它（热生效）
  it("removeAlwaysAllow：删掉一条，其余保留，文件权限仍 0600", () => {
    const path = storePath();
    addAlwaysAllow(path, "bash");
    addAlwaysAllow(path, "write_file");
    const left = removeAlwaysAllow(path, "bash");
    expect(left).toEqual(new Set(["write_file"]));
    expect(loadAlwaysAllow(path)).toEqual(new Set(["write_file"]));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("removeAlwaysAllow：删不存在的 key 是无害空操作", () => {
    const path = storePath();
    addAlwaysAllow(path, "bash");
    expect(removeAlwaysAllow(path, "没这条")).toEqual(new Set(["bash"]));
  });
});
