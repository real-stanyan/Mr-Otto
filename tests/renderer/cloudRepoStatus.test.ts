import { describe, it, expect } from "vitest";
import { repoStatusText } from "../../src/renderer/src/lib/cloudRepoStatus.js";

describe("repoStatusText（#991：仓库那一格的状态文字）", () => {
  it("没配仓库：不是错误——文案说清「不是每个工作区都需要仓库」", () => {
    const r = repoStatusText(null);
    expect(r.short).toBe("未配仓库");
    expect(r.full).toContain("不是每个工作区都需要仓库");
  });
  it("配了没克隆：host/path 去 .git + 待克隆", () => {
    const r = repoStatusText({ url: "https://github.com/acme/x.git", hasPat: false, clone: null });
    expect(r.short).toBe("github.com/acme/x · 待克隆");
    expect(r.full).toContain("https://github.com/acme/x.git");
  });
  it("克隆结局：failed/refused 说「未拉下来」，其余说「已克隆」，全文带结局原文", () => {
    const ok = repoStatusText({ url: "https://github.com/acme/x.git", hasPat: true, clone: { kind: "cloned", text: "拉下来了", at: 1 } });
    expect(ok.short).toBe("github.com/acme/x · 已克隆");
    const bad = repoStatusText({ url: "https://github.com/acme/x.git", hasPat: true, clone: { kind: "failed", text: "鉴权失败", at: 1 } });
    expect(bad.short).toBe("github.com/acme/x · 未拉下来");
    expect(bad.full).toContain("鉴权失败");
  });
});
