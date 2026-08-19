import { describe, it, expect } from "vitest";
import { createProtocolService, type ProtocolDeps } from "../../src/main/protocolService.js";

/** 假文件系统:路径 → 内容;假 gh:按 args 决定吐 stdout 还是炸 */
function fakeDeps(init: {
  files?: Record<string, string>;
  gh?: (args: string[]) => { stdout: string } | { err: { code?: string; stderr?: string; message?: string; killed?: boolean; signal?: string } };
  dirExists?: boolean;
} = {}): ProtocolDeps {
  const files = init.files ?? {};
  return {
    listFiles(dir) {
      const prefix = dir.endsWith("/") ? dir : dir + "/";
      const names = Object.keys(files)
        .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
        .map((p) => p.slice(prefix.length));
      return names;
    },
    readFile(path) {
      return files[path] ?? null;
    },
    // 默认存在——大多数用例不关心这条,只有"目录被删/改名"的用例显式传 false
    dirExists() {
      return init.dirExists ?? true;
    },
    async execGh(args) {
      const r = init.gh?.(args);
      if (!r) throw new Error("unexpected gh call");
      if ("err" in r) throw Object.assign(new Error(r.err.message ?? "gh failed"), r.err);
      return r;
    },
  };
}

describe("目录不存在与非仓库分开报", () => {
  it("目录不存在 = no-dir,不是 no-repo——「不是 git 仓库」对一个已经没了的目录是错的", async () => {
    const deps = fakeDeps({ dirExists: false });
    const svc = createProtocolService(deps);
    await expect(svc.listIssues("/gone")).resolves.toMatchObject({ ok: false, kind: "no-dir" });
    await expect(svc.getIssue("/gone", 1)).resolves.toMatchObject({ ok: false, kind: "no-dir" });
  });

  it("目录在但不是仓库,仍按 gh 的 stderr 判成 no-repo", async () => {
    const svc = createProtocolService(fakeDeps({
      gh: () => ({ err: { stderr: "fatal: not a git repository" } }),
    }));
    await expect(svc.listIssues("/repo")).resolves.toMatchObject({ ok: false, kind: "no-repo" });
  });
});

describe("gh 超时", () => {
  it("execGh 被 timeout 打死 → gh-timeout(不混进「网络/限流?点刷新重试」)", async () => {
    const svc = createProtocolService(fakeDeps({
      gh: () => ({ err: { killed: true, signal: "SIGTERM", stderr: "" } }),
    }));
    await expect(svc.listIssues("/repo")).resolves.toMatchObject({ ok: false, kind: "gh-timeout" });
  });
});

describe("listAdrs", () => {
  it("双目录合并,各自排序,project adr 在前;非 ADR 命名跳过", () => {
    const svc = createProtocolService(fakeDeps({
      files: {
        "/repo/docs/adr/0002-b.md": "# ADR-0002: B",
        "/repo/docs/adr/0001-a.md": "# ADR-0001: A",
        "/repo/docs/adr/README.md": "# 目录说明",
        "/repo/docs/gearbox-adr/0001-x.md": "# GX-0001",
      },
    }));
    expect(svc.listAdrs("/repo")).toEqual([
      { source: "adr", id: "0001", title: "ADR-0001: A", path: "docs/adr/0001-a.md" },
      { source: "adr", id: "0002", title: "ADR-0002: B", path: "docs/adr/0002-b.md" },
      { source: "gearbox-adr", id: "0001", title: "GX-0001", path: "docs/gearbox-adr/0001-x.md" },
    ]);
  });
  it("目录不存在 = 空数组(ADR 面板空态,不炸)", () => {
    expect(createProtocolService(fakeDeps()).listAdrs("/repo")).toEqual([]);
  });
});

describe("readAdr", () => {
  const svc = createProtocolService(fakeDeps({
    files: { "/repo/docs/adr/0001-a.md": "# ADR-0001: A\n正文" },
  }));
  it("合法路径读全文", () => {
    expect(svc.readAdr("/repo", "docs/adr/0001-a.md")).toEqual({ markdown: "# ADR-0001: A\n正文" });
  });
  it("越界路径拒绝(目录外 / .. 逃逸)", () => {
    expect(() => svc.readAdr("/repo", "src/main/index.ts")).toThrow(/越界/);
    expect(() => svc.readAdr("/repo", "docs/adr/../../secrets.md")).toThrow(/越界/);
  });
  it("不存在 = throw", () => {
    expect(() => svc.readAdr("/repo", "docs/adr/0099-nope.md")).toThrow(/不存在/);
  });
});

describe("listIssues", () => {
  it("gh 正常输出 = ok + 映射", async () => {
    const svc = createProtocolService(fakeDeps({
      gh: () => ({ stdout: JSON.stringify([{ number: 1, title: "t", state: "OPEN", updatedAt: "" }]) }),
    }));
    const r = await svc.listIssues("/repo");
    expect(r).toEqual({ ok: true, issues: [{ number: 1, title: "t", state: "open", role: "task", updatedAt: "" }] });
  });
  it("gh 不在 = gh-missing", async () => {
    const svc = createProtocolService(fakeDeps({ gh: () => ({ err: { code: "ENOENT", message: "spawn gh ENOENT" } }) }));
    expect(await svc.listIssues("/repo")).toMatchObject({ ok: false, kind: "gh-missing" });
  });
  it("未登录 = gh-auth", async () => {
    const svc = createProtocolService(fakeDeps({ gh: () => ({ err: { stderr: "please run gh auth login" } }) }));
    expect(await svc.listIssues("/repo")).toMatchObject({ ok: false, kind: "gh-auth" });
  });
  it("非法 JSON = gh-error", async () => {
    const svc = createProtocolService(fakeDeps({ gh: () => ({ stdout: "not json" }) }));
    expect(await svc.listIssues("/repo")).toMatchObject({ ok: false, kind: "gh-error" });
  });
  // repoDir 记在 localStorage,目录删了/改名了再打开仪表盘会重现:execFile 对不存在的 cwd
  // 抛 ENOENT,和"没装 gh"是同一个错误码——不能靠 classifyGhError 分辨,得在 exec 前挡住
  it("目录不存在(remembered repoDir 被删/改名) = no-dir,不是 gh-missing", async () => {
    const svc = createProtocolService(fakeDeps({ dirExists: false, gh: () => ({ err: { message: "should not be called" } }) }));
    expect(await svc.listIssues("/repo/gone")).toMatchObject({ ok: false, kind: "no-dir", detail: "目录不存在: /repo/gone" });
  });
});

describe("getIssue", () => {
  it("正常输出 = ok + 详情映射", async () => {
    const svc = createProtocolService(fakeDeps({
      gh: (args) => {
        expect(args).toContain("view");
        return { stdout: JSON.stringify({ number: 5, title: "交接:x", state: "OPEN", body: "b", comments: [] }) };
      },
    }));
    const r = await svc.getIssue("/repo", 5);
    expect(r).toMatchObject({ ok: true, issue: { number: 5, role: "memory" } });
  });
  it("gh 炸 = 结构化错误", async () => {
    const svc = createProtocolService(fakeDeps({ gh: () => ({ err: { stderr: "HTTP 500" } }) }));
    expect(await svc.getIssue("/repo", 5)).toMatchObject({ ok: false, kind: "gh-error" });
  });
  it("目录不存在(remembered repoDir 被删/改名) = no-dir,不是 gh-missing", async () => {
    const svc = createProtocolService(fakeDeps({ dirExists: false, gh: () => ({ err: { message: "should not be called" } }) }));
    expect(await svc.getIssue("/repo/gone", 5)).toMatchObject({ ok: false, kind: "no-dir", detail: "目录不存在: /repo/gone" });
  });
});
