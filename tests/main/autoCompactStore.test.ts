import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAutoCompact, saveAutoCompact } from "../../src/main/autoCompactStore.js";

describe("autoCompactStore", () => {
  it("没文件 = 默认开；坏 JSON = 默认；round-trip；threshold 非数字丢弃", () => {
    const p = join(mkdtempSync(join(tmpdir(), "otto-ac-")), "auto-compact.json");
    expect(loadAutoCompact(p)).toEqual({ enabled: true });
    saveAutoCompact(p, { enabled: false, threshold: 0.6 });
    expect(loadAutoCompact(p)).toEqual({ enabled: false, threshold: 0.6 });
    saveAutoCompact(p, { enabled: true, threshold: "x" as unknown as number });
    expect(loadAutoCompact(p)).toEqual({ enabled: true });
  });
});
