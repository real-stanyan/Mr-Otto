import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAutoCompact, saveAutoCompact, normaliseAutoCompact } from "../../src/main/autoCompactStore.js";

describe("autoCompactStore", () => {
  it("没文件 = 默认开；坏 JSON = 默认；round-trip；threshold 非数字丢弃", () => {
    const p = join(mkdtempSync(join(tmpdir(), "otto-ac-")), "auto-compact.json");
    expect(loadAutoCompact(p)).toEqual({ enabled: true });
    saveAutoCompact(p, { enabled: false, threshold: 0.6 });
    expect(loadAutoCompact(p)).toEqual({ enabled: false, threshold: 0.6 });
    saveAutoCompact(p, { enabled: true, threshold: "x" as unknown as number });
    expect(loadAutoCompact(p)).toEqual({ enabled: true });
  });

  it("threshold 越界（有限数但超出 [THRESHOLD_MIN, THRESHOLD_MAX]）落盘前夹住", () => {
    const p = join(mkdtempSync(join(tmpdir(), "otto-ac-")), "auto-compact.json");
    saveAutoCompact(p, { enabled: true, threshold: 5 });
    expect(loadAutoCompact(p)).toEqual({ enabled: true, threshold: 0.9 });
    saveAutoCompact(p, { enabled: true, threshold: -1 });
    expect(loadAutoCompact(p)).toEqual({ enabled: true, threshold: 0.3 });
  });

  describe("micro 字段", () => {
    it("micro:true 才落盘；非 true 一律省略（缺省 = 关）", () => {
      expect(normaliseAutoCompact({ enabled: true, micro: true })).toEqual({ enabled: true, micro: true });
      expect(normaliseAutoCompact({ enabled: true, micro: false })).toEqual({ enabled: true });
      expect(normaliseAutoCompact({ enabled: true, micro: "yes" })).toEqual({ enabled: true });
      expect(normaliseAutoCompact({ enabled: false, threshold: 0.5, micro: true })).toEqual({
        enabled: false, threshold: 0.5, micro: true,
      });
    });
  });
});
