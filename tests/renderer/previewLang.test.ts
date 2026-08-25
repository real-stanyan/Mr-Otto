// 后缀 → highlight.js 语言名。为什么不复用 fileIconName:图标名和语言名
// 语义不同(react_ts 是图标名,语言是 tsx;json_schema 是图标名,不是语言),
// 混用会喂给 rehype-highlight 一个它不认识的语言,整段掉回无高亮。

import { describe, expect, it } from "vitest";
import { previewLang } from "../../src/renderer/src/lib/previewLang.js";

describe("previewLang", () => {
  it("常见后缀认得出", () => {
    expect(previewLang("src/App.tsx")).toBe("tsx");
    expect(previewLang("a/b/store.ts")).toBe("typescript");
    expect(previewLang("x.py")).toBe("python");
    expect(previewLang("conf.yml")).toBe("yaml");
  });

  it("认不出就回空串——空 lang 让 rehype-highlight 自己猜,好过喂个假语言", () => {
    expect(previewLang("weird.zzz")).toBe("");
  });

  it("无后缀文件也不炸", () => {
    expect(previewLang("Makefile")).toBe("makefile");
    expect(previewLang("LICENSE")).toBe("");
  });

  it("认的是整名而不是后缀那一类(Dockerfile 没有后缀)", () => {
    expect(previewLang("build/Dockerfile")).toBe("dockerfile");
  });
});
