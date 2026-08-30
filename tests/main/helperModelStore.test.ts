// 后台小模型的落盘（issue #112）：文件是外部输入，形状不赌。

import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/tempDir.js";
import { loadHelperModel, saveHelperModel } from "../../src/main/helperModelStore.js";
import { DEFAULT_HELPER_MODEL, normaliseHelperModel } from "../../src/shared/helperModel.js";

const path = () => join(tempDir("otto-helper-"), "helper-model.json");

describe("normaliseHelperModel", () => {
  it("目录里有的型号原样放行", () => {
    expect(normaliseHelperModel("gemini-3.7-flash")).toBe("gemini-3.7-flash");
  });

  it("目录里没有的退回默认 —— 不存在的 id 会让三个外挂集体静默失效", () => {
    expect(normaliseHelperModel("gpt-不存在")).toBe(DEFAULT_HELPER_MODEL);
  });

  it("不是字符串也退回默认", () => {
    for (const bad of [null, undefined, 42, {}, ["gemini-3.7-flash"]]) {
      expect(normaliseHelperModel(bad)).toBe(DEFAULT_HELPER_MODEL);
    }
  });
});

describe("loadHelperModel / saveHelperModel", () => {
  it("没有文件 = 出厂默认", () => {
    expect(loadHelperModel(path())).toBe(DEFAULT_HELPER_MODEL);
  });

  it("坏 JSON = 出厂默认，不抛", () => {
    const p = path();
    writeFileSync(p, "{ 这不是 JSON");
    expect(loadHelperModel(p)).toBe(DEFAULT_HELPER_MODEL);
  });

  it("存了再读是同一个", () => {
    const p = path();
    expect(saveHelperModel(p, "gemini-3.7-flash")).toBe("gemini-3.7-flash");
    expect(loadHelperModel(p)).toBe("gemini-3.7-flash");
  });

  it("存之前先整形：认不出来的落盘成默认，返回值就是真正存下去的那个", () => {
    const p = path();
    expect(saveHelperModel(p, { model: "偷渡的形状" })).toBe(DEFAULT_HELPER_MODEL);
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ model: DEFAULT_HELPER_MODEL });
  });

  it("手改进文件里的越界值读出来也被整形", () => {
    const p = path();
    writeFileSync(p, JSON.stringify({ model: "手写的野型号" }));
    expect(loadHelperModel(p)).toBe(DEFAULT_HELPER_MODEL);
  });
});
