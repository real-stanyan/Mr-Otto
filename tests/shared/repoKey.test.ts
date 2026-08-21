import { describe, it, expect } from "vitest";
import { normalizeRemoteUrl } from "../../src/shared/repoKey.js";

describe("normalizeRemoteUrl", () => {
  const want = "github.com/real-stanyan/mr-otto";

  it.each([
    "git@github.com:real-stanyan/Mr-Otto.git",
    "ssh://git@github.com/real-stanyan/Mr-Otto.git",
    "https://github.com/real-stanyan/Mr-Otto.git",
    "https://github.com/real-stanyan/Mr-Otto",
    "https://github.com/Real-Stanyan/Mr-Otto/",
    "https://stan:ghp_token@github.com/real-stanyan/Mr-Otto.git",
    "github.com/real-stanyan/Mr-Otto",
    "  https://GitHub.com/real-stanyan/Mr-Otto.git\n",
  ])("%s → 同一把 key", (url) => {
    expect(normalizeRemoteUrl(url)).toBe(want);
  });

  it("ssh 带端口:端口不算身份", () => {
    expect(normalizeRemoteUrl("ssh://git@github.com:2222/a/b.git")).toBe("github.com/a/b");
  });

  it("自托管 gitea 子路径保留", () => {
    expect(normalizeRemoteUrl("https://git.example.com/team/sub/repo.git")).toBe("git.example.com/team/sub/repo");
  });

  it("空串 / 只有主机名 / 本地路径 → null", () => {
    expect(normalizeRemoteUrl("")).toBeNull();
    expect(normalizeRemoteUrl("github.com")).toBeNull();
    expect(normalizeRemoteUrl("/Users/me/repo")).toBeNull();
  });

  it("不同仓库不同 key", () => {
    expect(normalizeRemoteUrl("git@github.com:a/x.git")).not.toBe(normalizeRemoteUrl("git@github.com:a/y.git"));
  });
});
