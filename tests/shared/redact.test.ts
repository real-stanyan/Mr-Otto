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
    ["Authorization: Bearer dGVzdDp0ZXN0dGVzdA==", /dGVzdD/],
    ["sk-abc12345defgh", /sk-/],
  ])("遮掉 %s", (text, leak) => {
    const out = redactSensitiveText(text);
    expect(out).not.toMatch(leak);
    expect(out).toContain("[REDACTED]");
  });
  it("普通文本原样", () => {
    expect(redactSensitiveText("用户偏好简短回复，项目用 pnpm")).toBe("用户偏好简短回复，项目用 pnpm");
  });
  it("密码/密钥中文：保留键名，遮值", () => {
    const out1 = redactSensitiveText("密码：hunter2");
    expect(out1).toContain("密码：");
    expect(out1).not.toMatch(/hunter2/);
    expect(out1).toContain("[REDACTED]");

    const out2 = redactSensitiveText("我的密钥：sk-test");
    expect(out2).toContain("密钥：");
    expect(out2).not.toMatch(/sk-/);
    expect(out2).toContain("[REDACTED]");

    const out3 = redactSensitiveText("用户 密码：hunter2 是重要信息");
    expect(out3).toContain("密码：");
    expect(out3).not.toMatch(/hunter2/);
    expect(out3).toContain("是重要信息");
  });
  it('设计文本（负面）原样：prose "secret sauce = patience"，"design token: spacing-4"', () => {
    expect(redactSensitiveText("secret sauce = patience")).toBe("secret sauce = patience");
    expect(redactSensitiveText("design token: spacing-4")).toBe("design token: spacing-4");
  });

  // issue #193：GitHub 三种新式 token、Google API key、PEM 私钥块
  it("github_pat_ / gho_ / ghs_ 打码", () => {
    expect(redactSensitiveText(`推送用 github_pat_${"A1".repeat(41)} 这个`)).not.toContain("github_pat_A1");
    expect(redactSensitiveText(`OAuth 令牌 gho_${"a".repeat(36)}`)).not.toMatch(/gho_a/);
    expect(redactSensitiveText(`装置令牌 ghs_${"b".repeat(36)}`)).not.toMatch(/ghs_b/);
  });
  it("Google API key（AIza 开头 39 位）打码", () => {
    const key = "AIza" + "SyD-abcdefghijklmnopqrstuvwxyz0123456".slice(0, 35);
    const out = redactSensitiveText(`地图用 ${key} 调`);
    expect(out).not.toContain(key);
    expect(out).toContain("[REDACTED]");
  });
  it("PEM 私钥块整块打码，围栏外文本保留", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nqqqq\n-----END RSA PRIVATE KEY-----";
    const out = redactSensitiveText(`部署脚本里有\n${pem}\n注意收好`);
    expect(out).not.toContain("MIIEpAIBAAKCAQEA");
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("注意收好");
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
