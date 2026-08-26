// package_project 结果解析:形状不对一律 null(卡退回通用工具行,不出半张卡)
import { describe, expect, it } from "vitest";
import {
  packagedProjectName,
  parsePackageProjectResult,
} from "../../../src/renderer/src/lib/packagedProjectCard.js";

describe("parsePackageProjectResult", () => {
  it("合法结果解析出 dir + moved", () => {
    expect(parsePackageProjectResult('{"dir":"/u/Documents/Mr Otto/站点","moved":["a.md"]}')).toEqual({
      dir: "/u/Documents/Mr Otto/站点",
      moved: ["a.md"],
    });
  });

  it("坏 JSON / 缺字段 / 错类型 = null", () => {
    expect(parsePackageProjectResult("not json")).toBeNull();
    expect(parsePackageProjectResult("{}")).toBeNull();
    expect(parsePackageProjectResult('{"dir":""}')).toBeNull();
    expect(parsePackageProjectResult('{"dir":"/a","moved":"x"}')).toBeNull();
    expect(parsePackageProjectResult('{"dir":"/a","moved":[1]}')).toBeNull();
    expect(parsePackageProjectResult("null")).toBeNull();
  });
});

describe("packagedProjectName", () => {
  it("取路径最后一段,Windows 反斜杠也认", () => {
    expect(packagedProjectName("/u/Documents/Mr Otto/站点")).toBe("站点");
    expect(packagedProjectName("C:\\Users\\x\\Documents\\Mr Otto\\站点")).toBe("站点");
  });
});
