import { describe, it, expect } from "vitest";
import { clipHeadTail, redactSensitiveText } from "../../src/shared/redact.js";

describe("redactSensitiveText", () => {
  it.each([
    ["OPENAI key sk-abcdefghijklmnopqrstuvwxyz123456", /sk-\w/],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def", /eyJ/],
    ["api_key = 123456789abcdef", /123456789/],
    ["password: hunter2", /hunter2/],
    ["https://alice:s3cret@example.com/x", /s3cret/],
    ["ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij", /ghp_A/],
    ["AKIAIOSFODNN7EXAMPLE", /AKIA/],
  ])("遮掉 %s", (text, leak) => {
    const out = redactSensitiveText(text);
    expect(out).not.toMatch(leak);
    expect(out).toContain("[REDACTED]");
  });
  it("普通文本原样", () => {
    expect(redactSensitiveText("用户偏好简短回复，项目用 pnpm")).toBe("用户偏好简短回复，项目用 pnpm");
  });
});

describe("clipHeadTail", () => {
  it("短文本原样；长文本头+标记+尾，按码点", () => {
    expect(clipHeadTail("短")).toBe("短");
    const long = "头".repeat(5000) + "尾".repeat(2000);
    const out = clipHeadTail(long);
    expect(out.startsWith("头".repeat(4000))).toBe(true);
    expect(out.endsWith("尾".repeat(1500))).toBe(true);
    expect(out).toContain("...[memory context truncated]...");
    expect([...out].length).toBe(4000 + 1500 + "...[memory context truncated]...".length);
  });
});
