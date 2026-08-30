// 看图模型的落盘（issue #258）：套路同 helperModelStore，多一条"必须原生看图"。

import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/tempDir.js";
import { loadVisionModel, saveVisionModel } from "../../src/main/visionModelStore.js";
import { DEFAULT_VISION_MODEL, normaliseVisionModel } from "../../src/shared/visionModel.js";

const path = () => join(tempDir("otto-vision-"), "vision-model.json");

describe("normaliseVisionModel", () => {
  it("目录里原生看图的款原样放行", () => {
    expect(normaliseVisionModel("gemini-3.7-flash")).toBe("gemini-3.7-flash");
  });

  it("目录里有但没眼睛的退回默认 —— 没眼睛的代读员会让所有带图消息集体失败", () => {
    expect(normaliseVisionModel("glm-4.7-flash")).toBe(DEFAULT_VISION_MODEL);
  });

  it("目录里没有的退回默认", () => {
    expect(normaliseVisionModel("gpt-不存在")).toBe(DEFAULT_VISION_MODEL);
  });

  it("不是字符串也退回默认", () => {
    for (const bad of [null, undefined, 42, {}, ["gemini-3.7-flash"]]) {
      expect(normaliseVisionModel(bad)).toBe(DEFAULT_VISION_MODEL);
    }
  });
});

describe("loadVisionModel / saveVisionModel", () => {
  it("没有文件 = 出厂默认", () => {
    expect(loadVisionModel(path())).toBe(DEFAULT_VISION_MODEL);
  });

  it("坏 JSON = 出厂默认，不抛", () => {
    const p = path();
    writeFileSync(p, "{ 这不是 JSON");
    expect(loadVisionModel(p)).toBe(DEFAULT_VISION_MODEL);
  });

  it("存了再读是同一个", () => {
    const p = path();
    expect(saveVisionModel(p, "gemini-3.7-flash")).toBe("gemini-3.7-flash");
    expect(loadVisionModel(p)).toBe("gemini-3.7-flash");
  });

  it("存之前先整形：没眼睛的落盘成默认，返回值就是真正存下去的那个", () => {
    const p = path();
    expect(saveVisionModel(p, "glm-4.7-flash")).toBe(DEFAULT_VISION_MODEL);
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ model: DEFAULT_VISION_MODEL });
  });

  it("手改进文件里的越界值读出来也被整形", () => {
    const p = path();
    writeFileSync(p, JSON.stringify({ model: "手写的野型号" }));
    expect(loadVisionModel(p)).toBe(DEFAULT_VISION_MODEL);
  });
});
