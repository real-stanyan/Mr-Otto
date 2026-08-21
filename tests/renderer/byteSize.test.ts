import { describe, expect, it } from "vitest";
import { formatBytes } from "../../src/renderer/src/lib/byteSize.js";

describe("formatBytes", () => {
  it("1KB 以下显示 B —— 文档转出的 md 常常就这么小(ADR-0046)", () => {
    expect(formatBytes(105)).toBe("105 B");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("1KB 起进 KB 档,带一位小数", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(102400)).toBe("100.0 KB");
  });

  it("1MB 起进 MB 档", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10.0 MB");
  });

  it("不再把小文件说成 0 KB 或 1KB —— 这是修好的那个 bug(#137)", () => {
    // 旧 StagedChips:(105/1024).toFixed(0) = "0 KB"
    // 旧 UserAttachments:Math.max(1, round(105/1024)) = "1KB"
    expect(formatBytes(105)).not.toMatch(/^0 |^1 KB/);
  });
});
